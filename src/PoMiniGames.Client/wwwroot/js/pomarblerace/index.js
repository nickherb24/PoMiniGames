// index.js — public interop surface for PoMarbleRace. The Blazor page calls these.
import { Game } from './game.js';
import { mapById, mapMenu, DEFAULT_MAP_ID } from './maps.js';
import { SKINS, WEIGHTS } from './marbles.js';
import { readBest, readTrackStats, readMarbleChoice } from './game.js';

let game = null;
// Monotonic token for the in-flight start(). The course model is fetched over the network, so
// two starts can overlap (navigate away and back, or the kiosk cycling a demo) and the slower
// one would otherwise install its Game over the newer one's. Only the latest token may install.
let startToken = 0;

window.PoMarbleRace = {
  /**
   * Everything the page's intro card offers, as one JSON string (the page deserializes it with a
   * source-generated context — trim-safe): maps, skins with their unlock score, weights, the best
   * run, per-track stats, and the last marble picked.
   */
  menu() {
    const choice = readMarbleChoice();
    return JSON.stringify({
      maps: mapMenu(), defaultMap: DEFAULT_MAP_ID,
      skins: SKINS, weights: WEIGHTS.map(({ id, name, hint }) => ({ id, name, hint })),
      best: readBest(), stats: readTrackStats(), skin: choice.skin, weight: choice.weight,
    });
  },

  // Async because a map may have to fetch an authored model before anything can be built. The
  // Blazor page calls this without awaiting; every other entry point below is a no-op until
  // `game` exists, which is the same guard they already had.
  // `online` is null for a local game, else { role: 'host'|'guest', seed, guestIndex } — see
  // the Online section of game.js.
  // `marble` is the player's { skin, weight } pick, or null for defaults (demo, online guest).
  async start(containerId, dotnetRef, demo, mapId, online, marble) {
    const token = ++startToken;
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoMarbleRace] container not found:', containerId); return; }
    const map = mapById(mapId === undefined || mapId === null ? DEFAULT_MAP_ID : mapId);
    let asset;
    try {
      asset = await map.load();
    } catch (err) {
      console.error(`[PoMarbleRace] failed to load map ${map.id} (${map.name}):`, err);
      return;
    }
    // A newer start() (or a stop()) landed while the map was in flight — stand down.
    if (token !== startToken) return;
    // No pick from the page (an auto-skipped intro can beat the menu load): race the saved one.
    game = new Game(containerId, dotnetRef, demo, map.id, asset, online || null, marble || (demo ? null : readMarbleChoice()));
    game.start();
  },
  // The host calls resume() after the intro OK is clicked. Until then the rAF
  // loop is gated and OnPhase('pick') is suppressed, so the 3s pick countdown
  // never runs while the intro is still on screen.
  resume() { if (game) game.resume(); },
  pick(index) { if (game) game.pick(index); },
  // dir: -1 steers left, +1 right (local track frame); active toggles the hold on/off. The
  // on-screen pads drive this on pointer down/up, mirroring the keyboard's keydown/keyup.
  setSteer(dir, active) { if (game) game.setSteer(dir, active); },
  // The pick countdown is owned by the Blazor component, so the pip that goes with it has
  // to be driven from there — JS never sees the tick.
  beep(final) { if (game) game.beep(final); },
  regenerate() { if (game) game.regenerate(); },
  setMuted(muted) { if (game) game.setMuted(muted); },
  // ── Online ──
  // Host: the guest's held steering direction, relayed by the hub.
  setGuestSteer(dir) { if (game) game.setGuestSteer(dir); },
  // Guest: one streamed snapshot from the host (see game.js applyFrame for the argument list).
  applyFrame(...args) { if (game) game.applyFrame(...args); },
  // Guest: the host resolved the race; `won` is the guest's own top-10 verdict.
  guestResult(won) { if (game) game.guestResult(won); },
  // Guest: the host started the next race on this seed.
  nextTrack(seed) { if (game) game.nextTrack(seed); },
  // Bumping the token here too, so a start() still waiting on the model fetch cannot install a
  // Game after the host has torn the page down.
  stop() { startToken++; if (game) { game.dispose(); game = null; } },
};

// Headless verification handle: SwiftShader runs at 1-2 fps, so browser checks drive the live
// instance directly rather than wait for the game to get anywhere on its own.
window.__game = () => game;
