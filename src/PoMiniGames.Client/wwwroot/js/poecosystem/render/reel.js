// reel.js — the Island Reel: instant replay and photo mode (GFX pass 2, idea 9).
//
// PoEcosystem's best moments happen when nobody is ready for them. The reel keeps the
// last few seconds recorded at all times and, when a chronicle moment fires, saves them —
// with a little post-roll, so the clip holds the aftermath and not only the lead-up. The
// player opens the reel (🎞 on the HUD) to watch, save or share the clips, or to take a
// still: a plain one at up to twice the screen's resolution, or a tilt-shift "miniature".
//
// WHY TWO RECORDERS
// A WebM from MediaRecorder is only decodable from its first chunk (the header and the
// first keyframe live there), so a rolling buffer of timeslice chunks cannot simply be cut
// from the middle. Instead two recorders run staggered by half a segment and each restarts
// every SEGMENT seconds; at any instant one of them holds between SEGMENT/2 and SEGMENT
// seconds of complete, valid video. A capture stops that one, keeps its file, and
// restarts it.
//
// WHY A MIRROR CANVAS
// Encoding the full-resolution WebGL canvas twice would cost more than the game. The
// renderer calls mirror() right after each composed frame (the same moment pip.js copies
// it), which draws the frame into a small 2D canvas at ~30 fps; that is what is recorded.
//
// Clips live in memory only (blob URLs), never leave the machine unless the player saves
// or shares one, and are revoked when the engine stops. Low tier: no recording, stills only.
const SEGMENT_MS = 16000;
const POST_ROLL_MS = 2600;
const MIN_CLIP_MS = 3000;
const MAX_CLIPS = 6;
const EXPOSURE_MS = 4000;
const MIRROR_FPS = 30;
const MIME = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* keep looking */ } }
  return null;
}

/** Tilt-shift: blur top and bottom, keep a sharp band, push the saturation — a model village. */
export function tiltShift(src) {
  const w = src.width; const h = src.height;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const o = out.getContext('2d');
  const blur = Math.max(4, Math.round(h / 140));
  o.filter = `blur(${blur}px) saturate(1.45) contrast(1.06)`;
  o.drawImage(src, 0, 0);
  const band = document.createElement('canvas'); band.width = w; band.height = h;
  const b = band.getContext('2d');
  b.filter = 'saturate(1.45) contrast(1.06)';
  b.drawImage(src, 0, 0);
  b.filter = 'none';
  b.globalCompositeOperation = 'destination-in';
  const g = b.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.36, 'rgba(0,0,0,1)');
  g.addColorStop(0.62, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  b.fillStyle = g; b.fillRect(0, 0, w, h);
  o.filter = 'none';
  o.drawImage(band, 0, 0);
  return out;
}

export function createReel(host, { tier = 'high', photo = null } = {}) {
  if (!host || typeof document === 'undefined') return { mirror() {}, capture() {}, toggle() {}, setSource() {}, dispose() {}, get clips() { return []; } };

  const mime = tier === 'low' ? null : pickMime();
  const recordable = !!mime && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  let source = null;
  let mirrorCanvas = null; let mirrorCtx = null; let stream = null;
  let lastMirror = 0;
  const recorders = [];
  const clips = [];
  let pendingCapture = null;
  let disposed = false;
  let cycleTimer = 0;

  // ── the drawer ──────────────────────────────────────────────────────
  const drawer = document.createElement('aside');
  drawer.className = 'poeco-reel';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Island reel');
  drawer.innerHTML = `
    <header class="poeco-reel-head">
      <h2 class="poeco-reel-title">Island reel</h2>
      <button type="button" class="poeco-reel-close" aria-label="Close the reel">✕</button>
    </header>
    <div class="poeco-reel-actions">
      <button type="button" class="poeco-btn" data-act="photo">📷 Photo</button>
      <button type="button" class="poeco-btn" data-act="mini">🔍 Miniature</button>
      <button type="button" class="poeco-btn" data-act="long" title="Four seconds of light on one frame: star trails, firelight, lava">🌠 Long exposure</button>
    </div>
    <p class="poeco-reel-note"></p>
    <ol class="poeco-reel-list"></ol>`;
  host.appendChild(drawer);
  const list = drawer.querySelector('.poeco-reel-list');
  const note = drawer.querySelector('.poeco-reel-note');
  // The world host is a Blazor element with its own click handler and the canvas's input
  // listens on the window for keys; the drawer is a UI island inside it, so nothing it
  // receives may leak out to either.
  for (const t of ['click', 'pointerdown', 'keydown', 'wheel']) drawer.addEventListener(t, (e) => e.stopPropagation());
  drawer.querySelector('.poeco-reel-close').addEventListener('click', () => setOpen(false));
  drawer.querySelector('[data-act="photo"]').addEventListener('click', () => takePhoto(false));
  drawer.querySelector('[data-act="mini"]').addEventListener('click', () => takePhoto(true));
  drawer.querySelector('[data-act="long"]').addEventListener('click', () => startExposure());

  // ── long exposure (GFX pass 3, 2026-09-30) ──────────────────────────
  // Every composed frame for EXPOSURE_MS is laid onto one canvas with the `lighten`
  // operator, which keeps the brightest value each pixel ever had: the stars draw their
  // arcs, a campfire becomes a column, lava a river, and a still landscape stays as it was.
  // It rides the same after-render hook the mirror does, so the drawing buffer is valid.
  let exposure = null;
  function startExposure() {
    if (exposure || !source || !source.width || !source.height) return;
    const w = Math.min(1920, source.width); const h = Math.max(1, Math.round(w * source.height / source.width));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    exposure = { canvas, ctx: canvas.getContext('2d', { alpha: false }), until: performance.now() + EXPOSURE_MS, frames: 0 };
    note.textContent = 'Exposing — four seconds. Best after dark, with the camera still.';
  }
  function expose(now) {
    const e = exposure;
    try {
      e.ctx.globalCompositeOperation = e.frames === 0 ? 'source-over' : 'lighten';
      e.ctx.drawImage(source, 0, 0, e.canvas.width, e.canvas.height);
      e.frames++;
    } catch { /* context lost: the frames already laid still make a picture */ }
    if (now < e.until) return;
    exposure = null;
    e.canvas.toBlob((blob) => { if (!disposed) addClip(blob, 'Long exposure', 'photo'); }, 'image/png');
  }

  function setNote() {
    note.textContent = recordable
      ? (clips.length ? '' : 'Big moments are saved here on their own — an extinction, a new age, an eruption. Nothing leaves this device unless you save or share it.')
      : 'This browser cannot record the island, but photos still work.';
  }

  function renderList() {
    list.replaceChildren(...clips.map((c) => {
      const li = document.createElement('li');
      li.className = 'poeco-reel-item';
      const media = c.kind === 'photo' ? document.createElement('img') : document.createElement('video');
      media.src = c.url;
      if (c.kind === 'photo') media.alt = c.caption;
      else { media.muted = true; media.loop = true; media.playsInline = true; media.controls = true; media.preload = 'metadata'; }
      const cap = document.createElement('p'); cap.className = 'poeco-reel-caption'; cap.textContent = c.caption;
      const row = document.createElement('div'); row.className = 'poeco-reel-row';
      const save = document.createElement('a');
      save.className = 'poeco-btn'; save.href = c.url; save.download = c.filename; save.textContent = 'Save';
      row.append(save);
      if (navigator.canShare && navigator.share) {
        const share = document.createElement('button');
        share.type = 'button'; share.className = 'poeco-btn'; share.textContent = 'Share';
        share.addEventListener('click', async () => {
          try {
            const file = new File([c.blob], c.filename, { type: c.blob.type });
            if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: c.caption });
          } catch { /* dismissed or unsupported */ }
        });
        row.append(share);
      }
      li.append(media, cap, row);
      return li;
    }));
    setNote();
  }

  function addClip(blob, caption, kind) {
    if (!blob || blob.size === 0) return;
    const ext = kind === 'photo' ? 'png' : (blob.type.includes('mp4') ? 'mp4' : 'webm');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const slug = (caption || 'island').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'island';
    clips.unshift({ blob, url: URL.createObjectURL(blob), caption: caption || 'The island', kind, filename: `poecosystem-${slug}-${stamp}.${ext}` });
    while (clips.length > MAX_CLIPS) URL.revokeObjectURL(clips.pop().url);
    renderList();
    host.closest('.poeco-root')?.querySelector('.poeco-reel-btn')?.classList.add('poeco-pill--fresh');
  }

  // ── recording ───────────────────────────────────────────────────────
  function startRecorder(r) {
    if (!stream || disposed) return;
    try {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: tier === 'high' ? 3_000_000 : 1_800_000 });
      r.chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) r.chunks.push(e.data); };
      rec.start(1000);
      r.rec = rec; r.startedAt = performance.now();
    } catch { r.rec = null; }
  }

  /** Stop a recorder; resolves with its whole file. */
  function stopRecorder(r) {
    return new Promise((resolve) => {
      const rec = r.rec;
      if (!rec || rec.state === 'inactive') { resolve(null); return; }
      rec.onstop = () => resolve(new Blob(r.chunks, { type: mime }));
      try { rec.stop(); } catch { resolve(null); }
      r.rec = null;
    });
  }

  function ensureRecording() {
    if (!recordable || !source || stream) return;
    const w = tier === 'high' ? 854 : 640;
    mirrorCanvas = document.createElement('canvas');
    mirrorCanvas.width = w; mirrorCanvas.height = Math.round(w * 9 / 16);
    mirrorCtx = mirrorCanvas.getContext('2d', { alpha: false });
    try { stream = mirrorCanvas.captureStream(MIRROR_FPS); } catch { stream = null; return; }
    recorders.push({ rec: null, chunks: [], startedAt: 0 }, { rec: null, chunks: [], startedAt: 0 });
    startRecorder(recorders[0]);
    const second = setTimeout(() => startRecorder(recorders[1]), SEGMENT_MS / 2);
    // Recycle whichever recorder has run a full segment. A capture in flight owns its
    // recorder until it resolves, so the cycle leaves that one alone.
    cycleTimer = setInterval(() => {
      const now = performance.now();
      for (const r of recorders) {
        if (r.busy || !r.rec || now - r.startedAt < SEGMENT_MS) continue;
        const old = r.rec; r.rec = null;
        try { old.ondataavailable = null; old.stop(); } catch { /* already stopped */ }
        startRecorder(r);
      }
    }, 500);
    recorders.second = second;
  }

  async function capture(caption) {
    if (!recordable || !stream || pendingCapture) return;
    pendingCapture = setTimeout(async () => {
      pendingCapture = null;
      const now = performance.now();
      const r = recorders.filter(x => x.rec && now - x.startedAt >= MIN_CLIP_MS)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!r) return;
      r.busy = true;
      const blob = await stopRecorder(r);
      r.busy = false;
      startRecorder(r);
      addClip(blob, caption, 'clip');
    }, POST_ROLL_MS);
  }

  async function takePhoto(miniature) {
    if (!photo) return;
    try {
      const canvas = await photo();
      if (!canvas) return;
      const final = miniature ? tiltShift(canvas) : canvas;
      const blob = await new Promise((res) => final.toBlob(res, 'image/png'));
      addClip(blob, miniature ? 'Miniature island' : 'The island', 'photo');
    } catch { /* a failed still is not worth an error banner */ }
  }

  function setOpen(on) {
    drawer.hidden = !on;
    if (on) {
      renderList();
      host.closest('.poeco-root')?.querySelector('.poeco-reel-btn')?.classList.remove('poeco-pill--fresh');
    } else {
      for (const v of drawer.querySelectorAll('video')) { try { v.pause(); } catch { /* ignore */ } }
    }
  }

  return {
    /** The WebGL canvas to mirror (it changes when the renderer is rebuilt). */
    setSource(canvas) { source = canvas; ensureRecording(); },
    /** Called by the renderer right after each composed frame. */
    mirror() {
      if (!source) return;
      const now = performance.now();
      if (exposure) expose(now);
      if (!mirrorCtx) return;
      if (now - lastMirror < 1000 / MIRROR_FPS - 2) return;
      lastMirror = now;
      const sw = source.width; const sh = source.height;
      if (!sw || !sh) return;
      // Cover-fit the frame into 16:9 so a portrait phone still records a watchable clip.
      const tw = mirrorCanvas.width; const th = mirrorCanvas.height;
      const scale = Math.max(tw / sw, th / sh);
      const dw = sw * scale; const dh = sh * scale;
      try { mirrorCtx.drawImage(source, (tw - dw) / 2, (th - dh) / 2, dw, dh); } catch { /* context lost */ }
    },
    capture,
    toggle() { setOpen(drawer.hidden); return !drawer.hidden; },
    get open() { return !drawer.hidden; },
    get clips() { return clips.map(c => ({ caption: c.caption, kind: c.kind, bytes: c.blob.size })); },
    get recording() { return !!stream; },
    /** Begin a long exposure (also the drawer's button); the still lands in the reel. */
    longExposure: startExposure,
    get exposing() { return !!exposure; },
    dispose() {
      disposed = true;
      if (pendingCapture) clearTimeout(pendingCapture);
      clearTimeout(recorders.second);
      clearInterval(cycleTimer);
      for (const r of recorders) { try { if (r.rec && r.rec.state !== 'inactive') { r.rec.ondataavailable = null; r.rec.stop(); } } catch { /* ignore */ } }
      try { stream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
      for (const c of clips) URL.revokeObjectURL(c.url);
      clips.length = 0;
      drawer.remove();
    },
  };
}
