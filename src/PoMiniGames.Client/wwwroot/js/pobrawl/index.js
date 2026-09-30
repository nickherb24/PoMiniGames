// index.js — public interop surface for PoBrawl. The Blazor page calls these.
import { BrawlGame } from './game.js';

let game = null;

window.PoBrawl = {
  /**
   * options: { mode: '1p'|'2p'|'demo'|'online', p1Character, p2Character, difficulty,
   *            training?: boolean (1P only),
   *            localSide?: 1|2 (online; 0 or absent = spectating), seed? }
   */
  init(containerId, dotnetRef, options) {
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoBrawl] container not found:', containerId); return; }
    game = new BrawlGame(el, dotnetRef, { ...options });
    game.start();
  },
  /**
   * 1P ladder: roll into the next round without a re-init (splash → countdown,
   * no end-of-game modal).
   * @param {string|null} p2Character  new opponent, or null to keep the current one
   * @param {number|string|null} difficulty  new CPU level, or null to keep it
   * @param {string|null} introLine  the PA's ring introduction, read under the splash
   */
  next(p2Character, difficulty, introLine) {
    if (!game) return;
    if (p2Character) game.options.p2Character = p2Character;
    if (difficulty !== undefined && difficulty !== null) game.options.difficulty = difficulty;
    game._introLine = introLine || null;
    game.resetMatch(false);
  },
  setMuted(muted) { if (game) game.setMuted(muted); },
  /**
   * Engine phase ('intro' | 'countdown' | 'fighting' | 'ko' | 'result') or null. The ladder
   * waits on this because the KO cinematic runs on the render clock, which freezes in a
   * hidden tab, while the page's hold delay is wall-clock.
   */
  phase() { return game ? game.phase : null; },
  /** Online: one server snapshot (PoBrawlMatchState) for the puppet fight (netplay.js). */
  net(state) { if (game) game.applyNet(state); },
  /** Save or share the last KO clip. Resolves false when there is none. */
  saveClip() { return game ? game.saveClip() : Promise.resolve(false); },
  /** Training-room controls (training.js). key: 'reset'. No-op outside a training session. */
  training(key) { if (game && key === 'reset') game.resetTraining(); },
  /** Say a line through the PA announcer (the post-fight press conference). */
  say(text) { if (game && text) game.audio?.announce(String(text).slice(0, 280), { rate: 1.0, pitch: 0.9, duckSec: 0.5 }); },
  destroy() {
    if (game) { game.dispose(); game = null; }
  },
};
