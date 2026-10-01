// index.js — public interop surface for PoSports. The Blazor page calls these.
import { SportsGame } from './game.js';
import { FieldGame } from './events.js';
import * as records from './records.js';

let game = null;

window.PoSports = {
  /**
   * options: { mode: '1p'|'2p'|'demo'|'online', players: [{character, name, human, layout}],
   *            difficulty, seed, daily, ghost, keymaps, lane, watch,
   *            event: 'longjump'|'javelin'|'relay' (a solo field event instead of the meet) }
   * In 'online' mode the game renders server snapshots (applySnapshot) instead of
   * simulating locally.
   */
  init(containerId, dotnetRef, options) {
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoSports] container not found:', containerId); return; }
    if (options?.event) {
      game = new FieldGame(el, dotnetRef, options);
    } else {
      const online = options?.mode === 'online';
      game = new SportsGame(el, dotnetRef, online ? { ...options, mode: '1p' } : (options || {}));
      if (online) game.enterRemoteMode(options?.layout ?? 1);
    }
    game.start();
    // Debug/automation handle (read-only introspection; not part of the API).
    window.PoSports._game = game;
  },

  /** Online mode: feed a server snapshot. */
  applySnapshot(snapshot) { if (game?.applySnapshot) game.applySnapshot(snapshot); },

  /** Restart with the same lanes (the results card's "Again"). */
  restart() { if (game) game.restartMeet(); },

  /**
   * This browser's bests as a JSON string: leg and meet times, field events, the
   * daily meet and streak, and saved key bindings. A string, so the page reads it
   * with JsonDocument and no type has to survive trimming.
   */
  records() { return JSON.stringify({ ...records.all(), ghost: !!records.ghost(), today: records.today() }); },

  /** Persist the player's key bindings: {1: {sequence: [code x4], jump: code}, 2: {...}}. */
  saveKeys(maps) { records.saveKeymaps(maps); },

  destroy() { if (game) { game.dispose(); game = null; } },
};
