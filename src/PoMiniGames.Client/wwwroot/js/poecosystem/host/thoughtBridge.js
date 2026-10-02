// thoughtBridge.js — main-thread side of the in-browser LLM (plan decision 1: the sim
// worker and the model worker never talk directly, so WebGPU gating, model download UI and
// the inline fallback all stay here).
//
// One request in flight at a time; a request is dropped (not queued) while busy, because
// the sim's round-robin will offer another creature on the next tick anyway.

export const LLM_STATE = Object.freeze({ OFF: 'off', UNSUPPORTED: 'unsupported', LOADING: 'loading', READY: 'ready', ERROR: 'error' });

// Ids match @mlc-ai/web-llm 0.2.84 prebuiltAppConfig.
export const MODELS = Object.freeze([
  { id: 'SmolLM2-135M-Instruct-q4f16_1-MLC', label: 'SmolLM2 135M', vramMb: 180, note: 'Instant edge download — starts fastest.' },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 360M', vramMb: 376, note: 'Fast & responsive balanced model.' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', vramMb: 879, note: 'Better sentences, bigger download.' },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen3 0.6B', vramMb: 1403, note: 'High multilingual precision.' },
]);

// The cloud "model": no worker, no WebGPU — each request is handed to the host (which
// posts it to /api/ecosystem/thought) and the answer comes back through cloudResult().
// Throttled hard because every call spends the caller's daily AI allowance: the browser
// models answer as fast as the GPU allows, the cloud answers at most once per interval.
export const CLOUD_MODEL_ID = 'cloud';
export const CLOUD_MIN_INTERVAL_MS = 20_000;

/**
 * WebGPU probe. Reporting a software adapter as available would start a several-hundred-MB
 * model download that then crawls on the CPU, so an adapter alone is not enough — it has to
 * be a hardware one.
 *
 * powerPreference quirk: passing 'high-performance' on Windows can hand back a discrete
 * adapter the browser then fails to initialise, so the option is only set off Windows.
 */
export const hasWebGpuSupport = async () => {
  try {
    if (!globalThis.navigator?.gpu) return false;
    const isWindows = (navigator.userAgent ?? '').toLowerCase().includes('windows');
    const adapter = await navigator.gpu.requestAdapter(
      isWindows ? undefined : { powerPreference: 'high-performance' });
    if (!adapter) return false;
    const info = adapter.info ?? {};
    const isSoftware = ['architecture', 'description', 'vendor']
      .some(k => (info[k] ?? '').toLowerCase().includes('software'));
    return !isSoftware;
  } catch { return false; }
};

export function createThoughtBridge({
  WorkerCtor = globalThis.Worker, workerUrl = null, hasWebGpu = hasWebGpuSupport,
  onResult = () => {}, onState = () => {}, cloud = null, now = () => Date.now(),
} = {}) {
  let worker = null;
  let cloudMode = false;
  let lastCloudAt = -Infinity;
  let state = LLM_STATE.OFF;
  let modelId = MODELS[0].id;
  let progress = 0;
  let message = '';
  let nextId = 1;
  let inFlight = null;   // { requestId, handle }
  const stats = { requested: 0, answered: 0, failed: 0 };

  const emit = () => onState({ state, modelId, progress, message, stats: { ...stats } });
  const setState = (s, msg = '') => { state = s; message = msg; emit(); };

  function onWorkerMessage(data) {
    switch (data?.type) {
      case 'progress': progress = data.loaded ?? 0; message = data.text ?? ''; emit(); return;
      case 'ready': progress = 1; setState(LLM_STATE.READY); return;
      case 'initError': setState(LLM_STATE.ERROR, `Model failed to load: ${data.message}`); return;
      case 'result':
        if (!inFlight || data.requestId !== inFlight.requestId) return;   // stale (cancelled or superseded)
        stats.answered++;
        { const { handle } = inFlight; inFlight = null; onResult(handle, data.text ?? ''); }
        emit();
        return;
      case 'inferError':
        if (!inFlight || data.requestId !== inFlight.requestId) return;
        stats.failed++;
        { const { handle } = inFlight; inFlight = null; onResult(handle, ''); }   // empty text ⇒ the sim uses a template
        emit();
        return;
      default:
    }
  }

  const bridge = {
    get state() { return state; },
    get modelId() { return modelId; },
    get progress() { return progress; },
    get stats() { return { ...stats }; },
    get busy() { return inFlight !== null; },

    async start(id) {
      modelId = id ?? modelId;
      if (modelId === CLOUD_MODEL_ID) {
        bridge.dispose(false);
        if (!cloud) { setState(LLM_STATE.ERROR, 'No cloud thought service is attached.'); return false; }
        cloudMode = true;
        progress = 1;
        setState(LLM_STATE.READY, 'Thoughts come from the server model, one every twenty seconds.');
        return true;
      }
      cloudMode = false;
      if (!(await hasWebGpu())) { setState(LLM_STATE.UNSUPPORTED, 'This browser has no WebGPU, so creature thoughts come from templates.'); return false; }
      bridge.dispose(false);
      try {
        worker = new WorkerCtor(workerUrl ?? new URL('../thoughtWorker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        setState(LLM_STATE.ERROR, `Could not start the model worker: ${err?.message ?? err}`);
        return false;
      }
      worker.onmessage = (e) => onWorkerMessage(e.data);
      worker.onerror = (err) => setState(LLM_STATE.ERROR, `Model worker error: ${err?.message ?? err}`);
      progress = 0;
      setState(LLM_STATE.LOADING, 'Downloading the model…');
      worker.postMessage({ type: 'init', modelId });
      return true;
    },

    /** Send one prompt; false when unsupported, still loading, throttled, or one is already in flight. */
    request({ handle, prompt, system }) {
      if (state !== LLM_STATE.READY || inFlight) return false;
      if (cloudMode) {
        const t = now();
        if (t - lastCloudAt < CLOUD_MIN_INTERVAL_MS) return false;
        lastCloudAt = t;
        const requestId = nextId++;
        inFlight = { requestId, handle };
        stats.requested++;
        Promise.resolve(cloud(handle, system, prompt))
          .then((text) => onWorkerMessage({ type: 'result', requestId, text: text ?? '' }))
          .catch(() => onWorkerMessage({ type: 'inferError', requestId }));
        return true;
      }
      if (!worker) return false;
      const requestId = nextId++;
      inFlight = { requestId, handle };
      stats.requested++;
      worker.postMessage({ type: 'infer', requestId, prompt, system });
      return true;
    },

    /** True while the cloud "model" is the active one (batched thoughts go through it). */
    get cloudReady() { return cloudMode && state === LLM_STATE.READY; },

    cancel() { inFlight = null; },

    dispose(reset = true) {
      if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
      inFlight = null;
      cloudMode = false;
      if (reset) setState(LLM_STATE.OFF);
    },
  };
  return bridge;
}
