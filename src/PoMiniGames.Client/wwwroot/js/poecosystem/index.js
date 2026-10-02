// index.js — the engine global (engineLoader contract): window.PoEcosystem.* is what the
// Blazor page calls, window.__poeco() is the debug/E2E handle. This file owns the sim host
// and the routing of its messages; the renderer (render/) and the thought bridge attach to
// the engine object when present.
import { createSimHost } from './host/simHost.js';
import { CLOUD_MODEL_ID, LLM_STATE, MODELS, createThoughtBridge } from './host/thoughtBridge.js';
import { fetchSpeciesInfo } from './host/naturalist.js';
import { createRenderer } from './render/renderer.js';
import { BINDABLE, DEFAULT_BINDINGS, mergeBindings } from './render/input.js';
import { HOST } from './sim/core/config.js';
import { createAudio } from './render/audio.js';
import { createMusic } from './render/music.js';
import { createLeitmotif } from './render/leitmotif.js';
import { createChronicle, isChronicleEvent } from './render/chronicle.js';
import { createReel } from './render/reel.js';
import { openWorldStore, loadWorldMeta } from './sim/persistence/idb.js';
import { createPrefs } from './sim/persistence/prefs.js';
import { hashString } from './sim/core/prng.js';
import { NONE } from './sim/core/entities.js';
import { BIOME, MAP_LAYERS, rgb } from './render/minimap.js';
import { generateIsland } from './sim/terrain/island.js';
import { unpackSnapshot } from './sim/persistence/codec.js';

let engine = null;

// The HUD stylesheet is injected here rather than shipped as PoEcosystemViewer.razor.css:
// the HUD is built from several components and Blazor's scoped CSS does not cross
// component boundaries, so a scoped file would style the shell and nothing inside it.
// Loading it here keeps it off every other
// page — the game is route-gated through engineLoader.
const STYLE_ID = 'poecosystem-css';
// The HUD's mood hue per score mode (GFX pass 2, idea 8): thriving teal, stable blue,
// declining violet, collapse red. poecosystem.css turns it into the chip's glow.
const MOOD_HUE = { ionian: 150, dorian: 200, aeolian: 268, phrygian: 352 };
const BLOOM_BIRTHS = 3;   // births in one stats interval that make the HUD bloom
// The minimap layers the sim's heat book feeds (the other two are computed render-side).
const HEAT_LAYERS = ['deaths', 'predation', 'sickness'];
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('css/poecosystem.css', document.baseURI).href;
  document.head.appendChild(link);
}

function createEngine(container, dotnetRef, opts) {
  const state = {
    container, dotnetRef, opts, host: null, mode: 'starting', ready: false, seed: null,
    creatureCount: 0, simLag: 0, stats: null, llm: null, lastDetail: null, terrain: null, lastTiles: null,
    renderer: null, thoughts: null, selected: NONE, directorSubject: NONE, frames: 0, errors: [], msgCounts: {},
    audio: createAudio(), sound: true, wakeAudio: null,
    music: null,
    // Music inputs. The sim reports CUMULATIVE births/deaths, so the score is driven from
    // the difference between consecutive stats messages; `eventPressure` is a decaying
    // reservoir bumped by each natural event, which is what lets the soundtrack stay tense
    // for a few seconds after an eruption rather than only during it.
    lastBorn: -1, lastDied: 0, eventPressure: 0,
    // GFX pass 2: the chronicle card, the reel, the genome synth.
    chronicle: null, reel: null, leitmotif: null, subjectTimer: 0, bloomTimer: 0,
    // The finder's request counter, the minimap's data layer, the kin of
    // whoever the camera is on (asked for every two seconds), and ambient mode.
    findId: 0, layer: 'none', kinOf: NONE, kinAt: 0, heatAt: 0, ambient: false, wakeLock: null, past: -1,
  };
  state.music = createMusic(state.audio);
  state.leitmotif = createLeitmotif(state.audio, state.music);
  const rootEl = () => container?.closest?.('.poeco-root') ?? null;
  // Palette and motion are the app's settings (<html data-colorsafe> / <html data-motion>,
  // the settings sheet), so the island has no switch of its own for either.
  const paletteInUse = () =>
    (typeof document !== 'undefined' && document.documentElement.dataset.colorsafe === '1') ? 'cb' : 'default';
  const motionReduced = () =>
    typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce';

  const invoke = async (method, ...args) => {
    if (!dotnetRef) return;
    try { await dotnetRef.invokeMethodAsync(method, ...args); } catch (err) { state.errors.push(`${method}: ${err?.message ?? err}`); }
  };

  function onMessage(msg) {
    // Per-type counters: the cheapest way to tell "the worker is silent" from "a handler
    // threw", both from the console and from the E2E smoke.
    state.msgCounts[msg.type] = (state.msgCounts[msg.type] ?? 0) + 1;
    switch (msg.type) {
      case 'ready':
        // The living count rides on ready: the first stats message follows the terrain,
        // whose mesh build can take a while, and until then the engine reported 0.
        state.ready = true; state.seed = msg.seed; state.creatureCount = msg.alive ?? state.creatureCount;
        state.past = msg.past ?? -1; state.kinOf = NONE;
        state.renderer?.setKin(NONE, []);
        invoke('OnReady', msg.seed, msg.tick, msg.resumed, msg.physics, state.past);
        return;
      case 'found':
        // An answer to an older query than the one on screen is dropped.
        if (msg.id === state.findId) invoke('OnFound', JSON.stringify(msg.results ?? []));
        return;
      case 'kin':
        if (msg.handle === state.kinOf) state.renderer?.setKin(msg.handle, msg.kin ?? []);
        return;
      case 'heat':
        state.renderer?.setHeat(msg);
        return;
      case 'keyframes':
        invoke('OnKeyframes', JSON.stringify({ frames: msg.frames ?? [], past: msg.past ?? -1 }));
        return;
      case 'terrain':
        state.terrain = msg;
        state.renderer?.setTerrain(msg);
        return;
      case 'history':
        // The timeline: every landmark and the per-year rows, sent only when they grew.
        invoke('OnHistory', JSON.stringify({ landmarks: msg.landmarks, years: msg.years, sagas: msg.sagas ?? [] }));
        return;
      case 'thoughtBatchRequest': {
        // Cloud thoughts, eight creatures per server call. Always answered — an empty result
        // is what releases the runtime's one batch in flight.
        const done = (results) => state.host?.send({ type: 'thoughtBatchResult', results });
        if (!dotnetRef || !state.thoughts?.cloudReady) { done([]); return; }
        const items = (msg.items ?? []).map(it => ({ id: it.handle, species: it.species, name: it.name, hunger: it.hunger, thirst: it.thirst, health: it.health, goal: it.goal, nearby: it.nearby }));
        dotnetRef.invokeMethodAsync('OnCloudThoughtBatch', JSON.stringify(items))
          .then((json) => {
            const reply = json ? JSON.parse(json) : null;
            done((reply?.results ?? []).map(r => ({ handle: r.id, text: JSON.stringify({ thought: r.thought, trait: r.trait, delta: r.delta }) })));
          })
          .catch(() => done([]));
        return;
      }
      case 'frame':
        state.frames++;
        if (state.renderer) state.renderer.acceptFrame(msg.buffer, (buf) => state.host.send({ type: 'recycle', buffer: buf }, [buf]));
        else state.host.send({ type: 'recycle', buffer: msg.buffer }, [msg.buffer]);
        return;
      case 'tiles':
        state.lastTiles = msg;
        state.renderer?.setTiles(msg);
        return;
      case 'stats':
        state.stats = msg.stats; state.creatureCount = msg.stats.alive; state.simLag = msg.stats.simLag; state.llm = msg.stats.llm;
        state.audio.setDay(msg.stats.dayFraction, msg.stats.season ?? 0);
        feedMusic(msg.stats);
        state.renderer?.setStats(msg.stats);
        invoke('OnStats', JSON.stringify({ ...msg.stats, popHistory: Array.from(msg.stats.popHistory), traitHistory: Array.from(msg.stats.traitHistory ?? []) }));
        return;
      case 'lineage':
        invoke('OnLineage', msg.handle, msg.tree ? JSON.stringify(msg.tree) : null);
        return;
      case 'snapshotBytes':
        // A Uint8Array crosses to .NET as byte[] (no base64 detour), so a megabyte world
        // costs one copy rather than a string a third bigger.
        invoke('OnSnapshotBytes', msg.slot, new Uint8Array(msg.bytes));
        return;
      case 'events':
        for (const ev of msg.events) {
          // A landmark gets its moment: the card, the camera, the score and the reel all
          // land on it together (chronicle.js throttles the card; the rest are cheap).
          if (isChronicleEvent(ev) && state.ready) {
            const year = state.stats?.year ?? 0;
            state.chronicle?.show(ev, year);
            state.renderer?.moment(ev);
            state.music?.flourish(ev.kind === 'diplomacy' ? ev.action : ev.kind);
            state.reel?.capture(`Year ${year} — ${ev.text ?? ev.kind}`);
          }
          // A birth in a watched family gets its ring (the death mark needs no event: the
          // renderer sees a watched creature leave the frame).
          if (ev.kind === 'birth' && state.renderer) {
            const watched = state.stats?.watched ?? [];
            const parent = [ev.mother, ev.father].find(h => h !== undefined && h !== null && watched.some(w => w.handle === h));
            if (parent !== undefined) state.renderer.birthMark(parent);
          }
          // A tech unlock or an outbreak is a cut for the director, not a stinger or a shake.
          if (ev.kind === 'tech' || ev.kind === 'outbreak') { state.renderer?.onEvent(ev); continue; }
          // Diplomacy logs as kind 'diplomacy' with an action; the old checks here looked
          // for 'war_declared' / 'peace_treaty', which no log entry ever carried.
          if (ev.kind === 'diplomacy' && ev.action === 'war') { state.audio?.warHorn(); }
          else if ((ev.kind === 'diplomacy' && ev.action === 'peace') || ev.kind === 'treaty') { state.audio?.tribalDrum(null, false); }
          if (ev.kind !== 'lightning' && ev.kind !== 'rockslide' && ev.kind !== 'eruption') continue;
          state.eventPressure = Math.min(1, state.eventPressure + (ev.kind === 'eruption' ? 0.8 : 0.45));
          // The renderer owns the whole reaction — particles, camera trauma, and the
          // POSITIONED stinger. Only a headless engine falls back to a centred one.
          if (state.renderer) state.renderer.onEvent(ev);
          else state.audio.stinger(ev.kind);
        }
        invoke('OnEvents', JSON.stringify(msg.events));
        return;
      case 'thoughts':
        invoke('OnThoughts', JSON.stringify(msg.thoughts));
        return;
      case 'telemetry':
        try {
          const blob = new Blob([JSON.stringify(msg.payload)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `poecosystem-telemetry-y${msg.payload?.world?.year ?? 0}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err) { state.errors.push(`telemetry: ${err?.message ?? err}`); }
        return;
      case 'detail':
        state.lastDetail = msg.detail;
        invoke('OnDetail', msg.detail ? JSON.stringify(msg.detail) : null);
        return;
      case 'thoughtRequest':
        // The bridge answers asynchronously; a refusal (busy / not ready) cancels the
        // sim's in-flight slot so the round-robin can offer another creature.
        if (!state.thoughts || !state.thoughts.request(msg)) state.host.send({ type: 'thoughtCancel' });
        return;
      case 'saved':
        invoke('OnSaved', msg.tick, msg.reason);
        return;
      case 'error':
        state.errors.push(`${msg.where}: ${msg.message}`);
        invoke('OnEngineError', msg.where, msg.message);
        return;
      case 'debugResult': case 'probeResult':
        return;
      default:
        return;
    }
  }

  /**
   * Turn one stats message into the four numbers music.js actually wants. Cumulative
   * counters are differenced here rather than in the score, so the music module never has
   * to know that a resumed world starts with a full almanac behind it.
   */
  function feedMusic(stats) {
    const born = (stats.almanac?.born ?? []).reduce((a, b) => a + b, 0);
    const died = (stats.almanac?.died ?? []).reduce((a, b) => a + b, 0);
    // The first message after a load establishes the baseline: without this, resuming a
    // hundred-year-old world would open on a birth rate of four hundred.
    const first = state.lastBorn < 0;
    const births = first ? 0 : Math.max(0, born - state.lastBorn);
    const deaths = first ? 0 : Math.max(0, died - state.lastDied);
    state.lastBorn = born; state.lastDied = died;
    state.eventPressure = Math.max(0, state.eventPressure - 0.06);   // ~8 s to fall from a full eruption
    state.music?.setWorld({
      alive: stats.alive, births, deaths,
      extinct: (stats.extinct ?? []).filter(Boolean).length,
      eventPressure: state.eventPressure,
      dayFraction: stats.dayFraction,
    });
    applyMood(births);
  }

  /**
   * The HUD follows the island's mood (idea 8): the score's mode picks a hue, its tempo
   * sets the breathing rate, and a burst of births makes the chip bloom. Written as custom
   * properties and data attributes on .poeco-root, which Blazor never renders, so a
   * component re-render cannot clobber them (same trick as the HUD's data-idle).
   */
  function applyMood(births) {
    const el = rootEl();
    const music = state.music?.state;
    if (!el || !music) return;
    el.style.setProperty('--poeco-mood-hue', String(MOOD_HUE[music.mode] ?? 200));
    el.style.setProperty('--poeco-beat', `${(60 / Math.max(30, music.bpm || 54)).toFixed(2)}s`);
    el.dataset.poecoMood = music.mode;
    if (births >= BLOOM_BIRTHS && !motionReduced()) {
      el.removeAttribute('data-poeco-bloom');
      void el.offsetWidth;          // restart the animation if it is already running
      el.setAttribute('data-poeco-bloom', '');
      clearTimeout(state.bloomTimer);
      state.bloomTimer = setTimeout(() => el.removeAttribute('data-poeco-bloom'), 1800);
    }
  }

  /**
   * The genome synth's subject (idea 5): whatever the camera is on — the director's
   * subject, else the followed creature, else the inspected one. Polled at 4 Hz so the
   * motif follows the creature across the island.
   */
  function updateSubject() {
    const r = state.renderer;
    if (!r || !state.sound) { state.leitmotif?.setSubject(null); return; }
    const handle = r.director ? state.directorSubject
      : r.followHandle >= 0 ? r.followHandle : state.selected;
    state.leitmotif?.setSubject(handle !== NONE && handle >= 0 ? r.creatureInfo(handle) : null);
  }

  /**
   * The slow poll (4 Hz timer, each item on its own two-second clock): the kin of whoever
   * the camera is on, for the threads and the kin lens, and the sim's heat book while one
   * of the three layers it feeds is on the minimap. Both are read-only questions.
   */
  function slowPoll() {
    const r = state.renderer;
    if (!r || !state.host || !state.ready) return;
    const now = performance.now();
    const subject = r.director ? state.directorSubject : r.followHandle >= 0 ? r.followHandle : state.selected;
    const handle = subject !== NONE && subject >= 0 ? subject : NONE;
    if (handle !== state.kinOf) {
      state.kinOf = handle; state.kinAt = 0;
      if (handle === NONE) r.setKin(NONE, []);
    }
    if (handle !== NONE && now - state.kinAt > 2000) { state.kinAt = now; state.host.send({ type: 'kin', handle }); }
    if (HEAT_LAYERS.includes(state.layer) && now - state.heatAt > 2000) { state.heatAt = now; state.host.send({ type: 'heat' }); }
  }

  /** The screen wake lock ambient mode holds; the browser drops it whenever the tab hides. */
  async function holdWake(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock?.request) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener?.('release', () => { state.wakeLock = null; });
      } else if (!on && state.wakeLock) { const lock = state.wakeLock; state.wakeLock = null; await lock.release(); }
    } catch { state.wakeLock = null; }   // denied, or not a secure context: ambient still works
  }

  /**
   * Ambient mode: the island as a picture on a second screen — the director
   * films, the HUD goes away, the screen is kept awake and the root goes fullscreen where
   * the browser allows it. Any camera input, or Esc, ends it.
   */
  async function setAmbient(on) {
    on = !!on;
    if (state.ambient === on) return;
    state.ambient = on;
    const root = rootEl();
    if (on) {
      root?.setAttribute('data-poeco-ambient', '');
      state.renderer?.setDirector(true);
      holdWake(true);
      try { await root?.requestFullscreen?.(); state.ambientFullscreen = !!document.fullscreenElement; } catch { state.ambientFullscreen = false; }
    } else {
      state.ambientFullscreen = false;
      root?.removeAttribute('data-poeco-ambient');
      holdWake(false);
      try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* already out */ }
    }
    invoke('OnAction', 'ambient', String(on));
  }

  const api = {
    state,
    async start() {
      const prefs = createPrefs(globalThis.localStorage);
      state.prefs = prefs;
      state.sound = prefs.get('sound') !== false;
      state.audio.setEnabled(state.sound);
      // Browsers only allow audio after a user gesture; the canvas handlers below are
      // gestures, so the ambience wakes on the first click/keypress and stays idle before.
      state.wakeAudio = () => { state.audio.ensure(); if (state.sound) state.music?.start(); };
      if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', state.wakeAudio);
        document.addEventListener('keydown', state.wakeAudio);
      }
      // HUD idle fade: after 5 s without player input the HUD chrome drops to a whisper;
      // any input restores it. Toggled through a data attribute Blazor never renders, so
      // component re-renders cannot clobber it (poecosystem.css styles [data-idle]).
      state.hudIdle = {
        timer: 0,
        events: ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'],
        wake: () => {
          const hud = document.querySelector('.poeco-hud');
          if (hud) hud.removeAttribute('data-idle');
          clearTimeout(state.hudIdle.timer);
          state.hudIdle.timer = setTimeout(() => hud?.setAttribute('data-idle', ''), 5000);
        },
      };
      for (const t of state.hudIdle.events) window.addEventListener(t, state.hudIdle.wake, { passive: true });
      state.hudIdle.wake();
      if (container) {
        state.renderer = buildRenderer();
        state.renderer.setPose(prefs.get('player'));
        state.poseTimer = setInterval(() => { if (state.renderer) prefs.set('player', state.renderer.player); }, 5000);
        state.chronicle = createChronicle(container, { reducedMotion: motionReduced });
        state.reel = createReel(container, { tier: state.renderer.tier, photo: () => state.renderer?.photo() });
        state.reel.setSource(state.renderer.canvas);
        state.subjectTimer = setInterval(() => { updateSubject(); slowPoll(); }, 250);
        if (motionReduced()) rootEl()?.setAttribute('data-poeco-still', '');
      }
      if (typeof document !== 'undefined') applyPalette();
      await startHost();
    },
  };

  // Add members to the api object. Object.assign would copy each getter's value once and
  // leave a frozen data property behind (creatureCount stuck at 0, mode at 'starting'), so
  // the descriptors are copied instead.
  function extend(target, members) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(members)); return target; }

  /**
   * The renderer is built here (and rebuilt by setQuality / a lost GL context)
   * from the prefs the Settings panel writes. A rebuild replays the cached terrain, tiles and
   * stats, so the island reappears exactly as it was without asking the worker for anything.
   */
  function buildRenderer() {
    const prefs = state.prefs;
    const quality = prefs.get('quality');
    return createRenderer(container, {
          minimapCanvas: opts.minimapId ? document.getElementById(opts.minimapId) : null,
          quality: { lowEnd: !!opts.lowEnd, tier: quality === 'auto' ? null : quality },
          palette: paletteInUse(),
          reducedMotion: motionReduced(),
          bindings: prefs.get('bindings'),
          audio: state.audio,
          onPick: (handle) => { api.select(handle); invoke('OnPick', handle); },
          onAction: (action, value) => {
            if (action === 'contextRestored') { rebuildRenderer(); invoke('OnAction', 'contextRestored', null); return; }
            if (action === 'speed') { api.setSpeed(value); invoke('OnSpeed', value); return; }
            // Follow whatever the camera is actually on: the director's subject while it
            // holds the camera, otherwise the creature the player inspected.
            if (action === 'follow') { state.renderer.follow(state.selected !== NONE ? state.selected : state.directorSubject); return; }
            // The director's subject is NOT selected. Selecting it opened the inspector
            // popover over the shot and outlined the creature in wireframe, turning a
            // cinematic camera into a stats readout; the shot is the point.
            // The handle is still remembered so T can follow what is on screen.
            if (action === 'directorSubject') { state.directorSubject = value ?? NONE; return; }
            if (action === 'director') {
              // Ambient mode is the director's shot with the chrome off: taking the camera
              // back ends both.
              if (!value && state.ambient) setAmbient(false);
              invoke('OnDirector', !!value, state.renderer?.directorCaption ?? '');
              return;
            }
            if (action === 'escape' && state.ambient) { setAmbient(false); return; }
            // The finder is a text box: the pointer has to come back before it can be typed in.
            // Whether it was locked is remembered, so closing the finder puts a free-look
            // player back in free-look and leaves a drag-look player's cursor alone.
            if (action === 'find') {
              state.relock = !!state.renderer?.locked;
              try { document.exitPointerLock?.(); } catch { /* not locked */ }
            }
            if (action === 'directorCaption') { invoke('OnDirector', true, value ?? ''); return; }
            if (action === 'pip') { invoke('OnPip', !!value); return; }
            invoke('OnAction', action, value === undefined ? null : String(value));
          },
          directorIdleSeconds: opts.demo ? 4 : 150,
          tempo: () => state.music?.state?.bpm ?? 54,
          onAfterRender: () => state.reel?.mirror(),
        });
  }

  function rebuildRenderer() {
    if (!container || !state.renderer) return;
    const pose = state.renderer.player;
    const tint = state.renderer.tint ?? -1;
    const held = state.directorHeld;
    state.renderer.dispose();
    state.renderer = buildRenderer();
    if (state.terrain) state.renderer.setTerrain(state.terrain);
    if (state.lastTiles) state.renderer.setTiles(state.lastTiles);
    if (state.stats) state.renderer.setStats(state.stats);
    if (pose) state.renderer.setPose(pose);
    if (tint >= 0) state.renderer.setTint(tint);
    if (held) state.renderer.holdDirector(true);
    if (state.layer !== 'none') { state.renderer.setLayer(state.layer); state.heatAt = 0; }
    state.kinOf = NONE;      // the next slow poll asks again and re-seats the threads
    state.reel?.setSource(state.renderer.canvas);
  }

  /** Chart and chip colours follow a data attribute (poecosystem.css defines both palettes). */
  function applyPalette() {
    if (typeof document === 'undefined') return;
    if (paletteInUse() === 'cb') document.documentElement.setAttribute('data-poeco-palette', 'cb');
    else document.documentElement.removeAttribute('data-poeco-palette');
  }

  const settingsSnapshot = () => ({
    quality: state.prefs?.get('quality') ?? 'auto',
    palette: paletteInUse(),
    reducedMotion: motionReduced(),
    bindings: mergeBindings(state.prefs?.get('bindings')),
    defaults: DEFAULT_BINDINGS,
    bindable: BINDABLE,
    gamepad: typeof navigator !== 'undefined' && !!navigator.getGamepads && [...(navigator.getGamepads() ?? [])].some(p => p?.connected),
  });

  extend(api, {
    applyTreaty(treaty) {
      const t = typeof treaty === 'string' ? JSON.parse(treaty) : treaty;
      state.host?.send({ type: 'applyTreaty', treaty: t });
    },
    note: (kind, text, tile) => state.host?.send({ type: 'note', kind, text, tile: Number.isInteger(tile) ? tile : -1 }),
    flyTo: (x, z) => state.renderer?.flyTo(x, z),
    holdDirector(on) { state.directorHeld = !!on; state.renderer?.holdDirector(!!on); },
    settings: () => settingsSnapshot(),
    setQuality(tier) {
      const t = ['auto', 'high', 'medium', 'low'].includes(tier) ? tier : 'auto';
      state.prefs?.set('quality', t);
      rebuildRenderer();
    },
    /** Open or close the Island Reel drawer; returns whether it is now open. */
    toggleReel: () => state.reel?.toggle() ?? false,
    setBinding(action, code) {
      if (!BINDABLE.includes(action) || typeof code !== 'string' || !code) return settingsSnapshot();
      const current = mergeBindings(state.prefs?.get('bindings'));
      // The new key becomes the primary; any other action that used it loses it, so one key
      // never drives two things.
      for (const a of BINDABLE) current[a] = current[a].filter(c => c !== code);
      current[action] = [code, ...current[action].slice(1)].slice(0, 3);
      for (const a of BINDABLE) if (!current[a].length) current[a] = DEFAULT_BINDINGS[a].filter(c => !Object.values(current).flat().includes(c)).slice(0, 1);
      state.prefs?.set('bindings', current);
      state.renderer?.setBindings(current);
      return settingsSnapshot();
    },
    resetBindings() { state.prefs?.set('bindings', null); state.renderer?.setBindings(null); return settingsSnapshot(); },
    /** The next key pressed (its KeyboardEvent.code), or null on Escape / after 8 s. Swallowed. */
    captureKey() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; window.removeEventListener('keydown', onKey, true); resolve(v); };
        const onKey = (e) => { e.preventDefault(); e.stopImmediatePropagation(); finish(e.code === 'Escape' ? null : e.code); };
        window.addEventListener('keydown', onKey, true);
        setTimeout(() => finish(null), 8000);
      });
    },
    speciesInfo: () => fetchSpeciesInfo(),

    // ── finder · lenses · map layers · ticker · ambient · time machine ──
    /** Ask the sim for living creatures matching `text`, ordered by `sort`; answered on OnFound. */
    find(text, sort) {
      state.findId++;
      state.host?.send({ type: 'find', id: state.findId, text: String(text ?? ''), sort: String(sort ?? ''), limit: 12 });
    },
    /** The minimap's data layer ('none' or one of MAP_LAYERS). */
    setLayer(name) {
      state.layer = MAP_LAYERS.includes(name) ? name : 'none';
      state.heatAt = 0;     // the next slow poll fetches the heat book at once
      state.renderer?.setLayer(state.layer);
      return state.layer;
    },
    ticker: (text) => state.chronicle?.ticker(text),
    setAmbient: (on) => setAmbient(on),
    get ambient() { return state.ambient; },
    longExposure: () => state.reel?.longExposure?.(),
    /** Chords for a run of [rabbits, deer, wolves, humans] rows (the timeline, heard). */
    sonify(rows, peak) {
      state.audio.ensure();
      return state.sound ? state.audio.sonify(rows, peak) : 0;
    },
    keyframes: () => state.host?.send({ type: 'keyframes' }),
    openKeyframe: (year) => state.host?.send({ type: 'openKeyframe', year: year | 0 }),
    returnHome: () => state.host?.send({ type: 'returnHome' }),
  });

  async function startHost() {
      state.thoughts = createThoughtBridge({
        onResult: (handle, text) => state.host?.send({ type: 'thoughtResult', handle, text }),
        onState: (s) => { state.llmState = s; invoke('OnLlmState', JSON.stringify(s)); },
        // The cloud model: the Blazor side owns the API client, so each request round-trips
        // through .NET and resolves with the server's text (null when refused or capped).
        cloud: dotnetRef ? (handle, system, prompt) => dotnetRef.invokeMethodAsync('OnCloudThought', handle, system, prompt) : null,
      });
      if (opts.llmEnabled) state.thoughts.start(opts.modelId ?? MODELS[0].id);
      state.host = await createSimHost({
        onMessage,
        importCannon: () => import('cannon-es'),
        log: (m) => { state.errors.push(m); console.warn('[poecosystem]', m); },
      });
      state.mode = state.host.mode;
      state.host.send({
        type: 'init', seed: hashString(opts.seed ?? ''), resume: !!opts.resume, llmEnabled: !!opts.llmEnabled,
        lowEnd: !!opts.lowEnd,
        // A demo, or a boot that is about to load a shared island: nothing it does is saved,
        // so the island this browser already holds is left exactly as it was.
        ephemeral: !!opts.ephemeral,
      });
      if (typeof document !== 'undefined') {
        state.onVisibility = () => {
          if (document.hidden) {
            state.host.send({ type: 'saveNow', reason: 'hidden' });
            // Popped out, the island is still being watched: keep it running.
            if (!state.renderer?.pipActive) state.host.send({ type: 'pause' });
          } else {
            state.host.send({ type: 'resume' });
            if (state.ambient) holdWake(true);   // the browser released it when the tab hid
          }
        };
        document.addEventListener('visibilitychange', state.onVisibility);
        // Esc in fullscreen is the browser's, not ours: leaving it by any road ends ambient mode.
        state.onFullscreen = () => { if (state.ambient && state.ambientFullscreen && !document.fullscreenElement) setAmbient(false); };
        document.addEventListener('fullscreenchange', state.onFullscreen);
      }
  }

  extend(api, {
    send: (msg, transfer) => state.host?.send(msg, transfer),
    setSpeed: (speed) => state.host?.send({ type: 'setSpeed', speed }),
    select(handle) {
      state.selected = handle ?? NONE;
      state.host?.send({ type: 'select', handle: state.selected });
      state.renderer?.select(state.selected);
      if (state.selected === NONE) state.renderer?.follow(NONE);
    },
    follow: (handle) => state.renderer?.follow(handle ?? state.selected),
    newWorld: (seed) => state.host?.send({ type: 'newWorld', seed: hashString(seed ?? '') }),
    async setLlm(enabled, modelId) {
      // The cloud model answers eight creatures per call (the runtime batches and paces them);
      // an in-browser model answers one at a time as fast as the GPU allows.
      const target = modelId ?? state.thoughts?.modelId;
      state.host?.send({ type: 'setLlmEnabled', enabled: !!enabled, batch: enabled && target === CLOUD_MODEL_ID ? HOST.thoughtBatchSize : 0 });
      // Always release the sim's in-flight slot: start() tears the worker down, so any
      // request already handed to the model will never be answered, and the sim would
      // otherwise wait for that creature forever.
      state.thoughts?.cancel();
      state.host?.send({ type: 'thoughtCancel' });
      if (enabled) await state.thoughts?.start(modelId ?? state.thoughts.modelId);
      else state.thoughts?.dispose();
    },
    saveNow: () => state.host?.send({ type: 'saveNow', reason: 'manual' }),
    exportSnapshot: (slot) => state.host?.send({ type: 'exportSnapshot', slot }),
    importSnapshot(bytes, ephemeral) {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
      // Copy into a fresh buffer: the .NET-provided array may be a view the runtime reuses.
      const copy = u8.slice();
      state.host?.send({ type: 'importSnapshot', bytes: copy.buffer, ephemeral: !!ephemeral }, [copy.buffer]);
    },
    lineage: (handle) => state.host?.send({ type: 'lineage', handle }),
    rename: (handle, name) => state.host?.send({ type: 'rename', handle, name }),
    watch: (handle, on) => state.host?.send({ type: 'watch', handle, on: !!on }),
    setTint: (traitIndex) => state.renderer?.setTint(traitIndex),
    setDirector: (on) => state.renderer?.setDirector(!!on),
    togglePip: () => state.renderer?.togglePip(),
    debug: (op, arg) => state.host?.send({ type: 'debug', op, arg }),
    exportTelemetry: () => state.host?.send({ type: 'exportTelemetry' }),
    setSound(on) {
      state.sound = !!on;
      state.prefs?.set('sound', state.sound);
      state.audio.ensure();
      state.audio.setEnabled(state.sound);
      if (state.sound) state.music?.start();
      state.music?.setEnabled(state.sound);
    },
    stop() {
      if (state.poseTimer) clearInterval(state.poseTimer);
      if (state.renderer && state.prefs) state.prefs.set('player', state.renderer.player);
      if (state.onVisibility) document.removeEventListener('visibilitychange', state.onVisibility);
      if (state.onFullscreen) document.removeEventListener('fullscreenchange', state.onFullscreen);
      holdWake(false);
      state.ambient = false;
      if (state.wakeAudio) {
        document.removeEventListener('pointerdown', state.wakeAudio);
        document.removeEventListener('keydown', state.wakeAudio);
        state.wakeAudio = null;
      }
      if (state.hudIdle) {
        clearTimeout(state.hudIdle.timer);
        for (const t of state.hudIdle.events) window.removeEventListener(t, state.hudIdle.wake);
        document.querySelector('.poeco-hud')?.removeAttribute('data-idle');
        state.hudIdle = null;
      }
      clearInterval(state.subjectTimer);
      clearTimeout(state.bloomTimer);
      state.chronicle?.dispose(); state.chronicle = null;
      state.reel?.dispose(); state.reel = null;
      state.leitmotif?.dispose();
      const root = rootEl();
      if (root) {
        for (const a of ['data-poeco-mood', 'data-poeco-bloom', 'data-poeco-still', 'data-poeco-ambient']) root.removeAttribute(a);
        root.style.removeProperty('--poeco-mood-hue'); root.style.removeProperty('--poeco-beat');
      }
      state.music?.dispose();
      state.audio.dispose();
      state.host?.send({ type: 'saveNow', reason: 'stop' });
      state.thoughts?.dispose?.();
      state.renderer?.dispose?.();
      state.host?.dispose();
      state.host = null;
    },
    get mode() { return state.mode; },
    get creatureCount() { return state.creatureCount; },
    get fps() { return state.renderer?.fps ?? 0; },
    get simLag() { return state.simLag; },
    get soundEnabled() { return state.sound; },
    get llm() { return { sim: state.llm, bridge: state.llmState ?? { state: LLM_STATE.OFF }, models: MODELS }; },
    get player() { return state.renderer?.player ?? null; },
  });
  return api;
}

// ── page helpers that need no running engine ─────────────────────────────

// Island thumbnails for the cloud slots and the gallery. A world is deterministic from its
// seed, so its map can be drawn from the seed alone: nothing is uploaded, nothing is
// fetched, and a shared island's picture cannot be anything but that island. ~30 ms each,
// cached for the session.
const THUMB_SIZE = 72;
const thumbs = new Map();
function islandThumb(seed) {
  const key = seed | 0;
  if (thumbs.has(key)) return thumbs.get(key);
  let url = '';
  try {
    const terrain = generateIsland(key);
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE; canvas.height = THUMB_SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(THUMB_SIZE, THUMB_SIZE);
    const palette = []; for (let t = 0; t < 8; t++) palette.push(rgb(BIOME[t] ?? '#555555'));
    const step = terrain.size / THUMB_SIZE;
    for (let y = 0; y < THUMB_SIZE; y++) {
      for (let x = 0; x < THUMB_SIZE; x++) {
        const c = palette[terrain.type[Math.floor(y * step) * terrain.size + Math.floor(x * step)]] ?? palette[0];
        const o = (y * THUMB_SIZE + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    url = canvas.toDataURL('image/png');
  } catch { url = ''; }
  thumbs.set(key, url);
  return url;
}

/** The per-year rows inside a gzip'd snapshot — the gallery's compare view reads these. */
async function peekHistory(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
    const snap = await unpackSnapshot(u8.slice());
    return JSON.stringify({ seed: snap?.seed ?? 0, year: snap?.year ?? 0, years: (snap?.state?.yearHistory ?? []).map(r => Array.from(r)) });
  } catch { return ''; }
}

/** Hand a link to the platform's share sheet, or to the clipboard: 'shared' | 'copied' | 'failed'. */
async function shareLink(title, text, url) {
  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare({ title, text, url }))) { await navigator.share({ title, text, url }); return 'shared'; }
  } catch (err) { if (err?.name === 'AbortError') return 'shared'; }   // the sheet was opened and dismissed
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return 'failed'; }
}

/**
 * Print the field journal. The page hands over plain data (JSON); the document is built
 * here, node by node with textContent, inside a throwaway iframe — so the HUD, the canvas
 * and the app shell are never in the print, and nothing a model wrote can be markup.
 */
function printJournal(json) {
  let data;
  try { data = JSON.parse(json); } catch { return false; }
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) { frame.remove(); return false; }
  const el = (tag, text, parent, cls) => { const n = doc.createElement(tag); if (text !== undefined && text !== null) n.textContent = text; if (cls) n.className = cls; parent.appendChild(n); return n; };
  const style = doc.createElement('style');
  style.textContent = `
    @page { margin: 18mm; }
    body { font: 11pt/1.5 Georgia, 'Iowan Old Style', serif; color: #111; margin: 0; }
    h1 { font-size: 22pt; margin: 0 0 2pt; } h2 { font-size: 14pt; margin: 18pt 0 6pt; border-bottom: 1px solid #999; padding-bottom: 2pt; }
    h3 { font-size: 12pt; margin: 12pt 0 2pt; } p { margin: 0 0 6pt; } .sub { color: #555; font-size: 10pt; }
    .epigraph { font-style: italic; color: #444; } ul { margin: 0; padding-left: 14pt; } li { margin-bottom: 2pt; }
    article { break-inside: avoid; } .counts { font-variant-numeric: tabular-nums; }`;
  doc.head.appendChild(style);
  doc.title = data.title ?? 'Field journal';
  const body = doc.body;
  el('h1', data.title ?? 'Field journal', body);
  el('p', data.subtitle ?? '', body, 'sub');
  if (data.counts) el('p', data.counts, body, 'counts');
  const section = (heading, items, render) => {
    if (!Array.isArray(items) || items.length === 0) return;
    el('h2', heading, body);
    for (const it of items) render(it);
  };
  section('Chronicle', data.sagas, (s) => {
    const a = el('article', null, body);
    el('h3', s.title, a);
    for (const para of String(s.saga ?? '').split(/\n+/)) if (para.trim()) el('p', para.trim(), a);
    if (s.epigraph) el('p', '— ' + s.epigraph, a, 'epigraph');
  });
  section('Legends', data.legends, (l) => { const a = el('article', null, body); el('h3', l.title, a); el('p', l.text, a); });
  if (Array.isArray(data.landmarks) && data.landmarks.length) {
    el('h2', 'Timeline', body);
    const ul = el('ul', null, body);
    for (const l of data.landmarks) el('li', l, ul);
  }
  if (Array.isArray(data.notes) && data.notes.length) {
    el('h2', 'Field notes', body);
    const ul = el('ul', null, body);
    for (const n of data.notes) el('li', n, ul);
  }
  const done = () => setTimeout(() => frame.remove(), 500);
  frame.contentWindow.addEventListener('afterprint', done);
  // A print dialog the browser never raises (headless, kiosk) must not leave the frame behind.
  setTimeout(() => frame.remove(), 120000);
  try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { frame.remove(); return false; }
  return true;
}

const PoEcosystem = {
  /** Is there a saved world? → { exists, seed, tick, year } */
  async probeSave() {
    try { const meta = await loadWorldMeta(await openWorldStore()); return meta ? { exists: true, ...meta } : { exists: false }; } catch { return { exists: false }; }
  },
  async start(containerId, dotnetRef, opts = {}) {
    ensureStyles();
    if (engine) engine.stop();
    const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
    engine = createEngine(container, dotnetRef, opts);
    await engine.start();
    return true;
  },
  stop() { if (engine) { engine.stop(); engine = null; } },
  setSpeed: (s) => engine?.setSpeed(s),
  select: (h) => engine?.select(h),
  newWorld: (seed) => engine?.newWorld(seed),
  setLlm: (enabled, modelId) => engine?.setLlm(enabled, modelId),
  saveNow: () => engine?.saveNow(),
  debug: (op, arg) => engine?.debug(op, arg),
  exportTelemetry: () => engine?.exportTelemetry(),
  setSound: (on) => engine?.setSound(on),
  soundEnabled: () => (engine ? engine.soundEnabled : true),
  follow: (handle) => engine?.follow(handle),
  lineage: (handle) => engine?.lineage(handle),
  exportSnapshot: (slot) => engine?.exportSnapshot(slot),
  importSnapshot: (bytes, ephemeral) => engine?.importSnapshot(bytes, ephemeral),
  cloudModelId: () => CLOUD_MODEL_ID,
  applyTreaty: (json) => engine?.applyTreaty(json),
  note: (kind, text, tile) => engine?.note(kind, text, tile),
  flyTo: (x, z) => engine?.flyTo(x, z),
  holdDirector: (on) => engine?.holdDirector(on),
  settings: () => engine?.settings() ?? null,
  setQuality: (tier) => engine?.setQuality(tier),
  setBinding: (action, code) => engine?.setBinding(action, code) ?? null,
  resetBindings: () => engine?.resetBindings() ?? null,
  captureKey: () => engine?.captureKey() ?? Promise.resolve(null),
  async speciesInfo() { try { return JSON.stringify(await (engine ? engine.speciesInfo() : fetchSpeciesInfo())); } catch { return '[]'; } },
  find: (text, sort) => engine?.find(text, sort),
  setLayer: (name) => engine?.setLayer(name) ?? 'none',
  ticker: (text) => engine?.ticker(text),
  setAmbient: (on) => engine?.setAmbient(on),
  longExposure: () => engine?.longExposure(),
  sonify(json, peak) { try { return engine?.sonify(JSON.parse(json), peak) ?? 0; } catch { return 0; } },
  keyframes: () => engine?.keyframes(),
  openKeyframe: (year) => engine?.openKeyframe(year),
  returnHome: () => engine?.returnHome(),
  islandThumb,
  peekHistory,
  share: shareLink,
  printJournal,
  rename: (handle, name) => engine?.rename(handle, name),
  watch: (handle, on) => engine?.watch(handle, on),
  setTint: (traitIndex) => engine?.setTint(traitIndex),
  setDirector: (on) => engine?.setDirector(on),
  togglePip: () => engine?.togglePip(),
  toggleReel: () => engine?.toggleReel() ?? false,
  toggleFly: () => engine?.state.renderer?.toggleFly(),
  setPose: (pose) => engine?.state.renderer?.setPose(pose),
  requestLock: () => engine?.state.renderer?.requestLock(),
  /** Re-lock the pointer only if it was locked when the finder took it (see the 'find' action). */
  restoreLock() { if (engine?.state.relock) { engine.state.relock = false; engine.state.renderer?.requestLock(); } },
  touchMove: (x, z) => engine?.state.renderer?.touchMove(x, z),
  touchRelease: () => engine?.state.renderer?.touchRelease(),
  // The cloud entry is listed last: it needs no download and no WebGPU, but it spends the
  // caller's daily allowance, so the settings panel presents it as its own switch.
  models: () => [...MODELS.map(m => ({ ...m })), { id: CLOUD_MODEL_ID, label: 'Cloud model', vramMb: 0, note: 'Runs on the server; uses your daily AI allowance.' }],
  async webGpuAvailable() { const { hasWebGpuSupport } = await import('./host/thoughtBridge.js'); return hasWebGpuSupport(); },
};

if (typeof window !== 'undefined') {
  window.PoEcosystem = PoEcosystem;
  window.__poeco = () => engine;
}

export { PoEcosystem, createEngine };
