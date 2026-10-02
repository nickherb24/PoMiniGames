// index.js — public interop surface for PoVoxelStrike. The Blazor page calls these
// through window.PoVoxelStrike after awaiting loadEngine('povoxelstrike').

import { Engine } from './game.js';
import { loadAssets } from './assets.js';
import { loadSettings, saveSettings } from './settings.js';

let engine = null;
// Monotonic token for the in-flight start(): assets are fetched over the network, so two
// starts can overlap (navigate away and back) and the slower one must not install its
// Engine over the newer one's. Same pattern as PoMarbleRace's map fetch.
let startToken = 0;
// Decoded voxel volumes, kept for the life of the page visit. Every start() after the
// first — "Play again", a different seed, the squad's arena — costs one world build, not a
// manifest fetch and a decode. stop() drops it, so a later visit sees late-ingested assets.
let volumesPromise = null;

function volumes() {
  volumesPromise ??= loadAssets().catch((err) => {
    // Manifest unreachable (offline, cold server). The procedural fallback world in
    // world.js still needs no assets — play on with an empty list rather than dying, and
    // forget the failure so the next start() tries the network again.
    console.warn('[PoVoxelStrike] asset load failed, using procedural world:', err);
    volumesPromise = null;
    return [];
  });
  return volumesPromise;
}

async function boot(host, dotnetRef, demo, loaded, online, opts) {
  // Engine.start() is async: the renderer factory awaits WebGPU adapter init before it
  // can fall back. The await has to be INSIDE the try or a rejected start would surface
  // as an unhandled rejection instead of OnFatalError.
  try {
    engine = new Engine(host, dotnetRef, demo, loaded, online ? 'multi' : 'solo', online || null, opts || {});
    if (online) {
      const send = (method, ...args) => {
        try {
          const p = dotnetRef.invokeMethodAsync(method, ...args);
          if (p && p.catch) p.catch(() => { });
        } catch { }
      };
      // Each lockstep batch goes to the page, which ships it through the lockstep hub.
      engine.multiplayerSink = (batch) => send('OnLockstepBatch', batch);
      // Carves and the win ride their own messages: neither may be dropped the way a
      // stale position batch is.
      engine.carveSink = (kind, structure, x, y, z) => send('OnCarve', kind, structure, x, y, z);
      engine.winSink = () => send('OnChaliceClaimed');
    }
    await engine.start();
  } catch (err) {
    console.error('[PoVoxelStrike] engine boot failed:', err);
    try { dotnetRef.invokeMethodAsync('OnFatalError', String(err?.message ?? err)); } catch { }
  }
}

window.PoVoxelStrike = {
  /**
   * Build a run. It comes up in 'ready' (rendered, frozen) behind the page's start card;
   * enter() is what starts it. Calling start() again replaces the run — that is "Play
   * again", a change of seed, and the squad's arena, all the same call.
   *
   * Flat primitives, like the rest of this surface — no DTO for the page to keep in step.
   * @param seed the arena to build; 0 lets the engine roll one. Online, the session's seed.
   * @param survival solo only: the roaming horde is on
   * @param playerNumber this player's seat in an online run; 0 for solo and demo
   * @param names online: display names, indexed by player number − 1
   */
  async start(containerId, dotnetRef, demo, seed, survival, playerNumber, names) {
    const token = ++startToken;
    if (engine) { engine.dispose(); engine = null; }

    const host = document.getElementById(containerId);
    if (!host) { console.error('[PoVoxelStrike] container not found:', containerId); return; }

    const loaded = await volumes();
    if (token !== startToken) return; // a newer start() or stop() landed mid-fetch
    const online = playerNumber > 0
      ? { playerNumber, seed, names: Object.fromEntries((names || []).map((n, i) => [i + 1, n])) }
      : null;
    boot(host, dotnetRef, demo, loaded, online, { seed, survival: !!survival });
  },

  /** The start card's button (a click, so the Pointer Lock request is legal). */
  enter() { engine?.enter(); },

  /** Online: a relayed lockstep frame (every peer's latest batch) for the engine to apply. */
  applyFrame(frame) { engine?.applyLockstepFrame(frame); },

  /** Online: a squadmate's carve. Flat primitives, like every other hot-ish interop call. */
  applyCarve(playerNumber, kind, structure, x, y, z) {
    engine?.applyCarve(playerNumber, kind, structure, x, y, z);
  },

  /** Online: a squadmate took the chalice. */
  squadWon() { engine?.squadWin(); },

  resume() { engine?.resume(); },

  /** Settings as "sens|invertY|fov|gfx" — a string, so the page needs no DTO to read it. */
  getSettings() {
    const s = loadSettings();
    return `${s.sens}|${s.invertY ? 1 : 0}|${s.fov}|${s.gfx}`;
  },

  /** Persist, and apply to the live run. The graphics tier takes effect on the next start(). */
  setSettings(sens, invertY, fov, gfx) {
    const s = saveSettings({ sens, invertY, fov, gfx });
    engine?.applySettings(s);
  },

  /** Download the run's biggest-collapse clip. False when there is none to save. */
  saveClip() { return !!engine?.clip?.save(); },

  /**
   * Fullscreen the canvas host (the engine's ResizeObserver handles the resize).
   * Fires from a Blazor button click, so the gesture requirement is satisfied.
   */
  toggleFullscreen() {
    const host = engine?.host || document.getElementById('povoxelstrike-container');
    if (!host) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => { });
    else host.requestFullscreen?.().catch?.(() => { });
  },

  /** Interop surface: cancel the current run immediately (no game-over
   *  event fires). Same teardown as stop(); the distinct name keeps call sites
   *  honest about intent — abort mid-run vs stop on page dispose. */
  abort() { this.stop(); },

  stop() {
    startToken++;
    volumesPromise = null;
    if (engine) { engine.dispose(); engine = null; }
  },

  /** Tear the run down but keep the decoded assets: the page is switching mode, not leaving. */
  unload() { startToken++; if (engine) { engine.dispose(); engine = null; } },
};

// TEMP DEBUG — headless verification hook (same convention as PoMarbleRace's __game):
// lets a scripted browser carve/inspect without pointer lock, which headless runs
// cannot acquire.
window.__pvs = () => engine;
