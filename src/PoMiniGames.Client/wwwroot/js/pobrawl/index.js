// index.js — public interop surface for PoBrawl. The Blazor page calls these.
import { BrawlGame } from './game.js';
import { loadPortraitHead } from './portraitHead.js';

let game = null;
let initGeneration = 0;

window.PoBrawl = {
  /**
   * options: { mode: '1p'|'2p'|'demo'|'online', p1Character, p2Character, difficulty,
   *            training?: { dummy, hitboxes, infiniteEnergy } (1P only),
   *            localSide?: 1|2 (online; 0 or absent = spectating), seed? }
   */
  async init(containerId, dotnetRef, options) {
    const generation = ++initGeneration;
    if (game) { game.dispose(); game = null; }
    window.PoBrawl._game = null;
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoBrawl] container not found:', containerId); return; }
    const matchOptions = { ...options };
    if (matchOptions.mode === '1p') {
      try {
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1000));
        matchOptions.playerHead = await Promise.race([loadPortraitHead(), timeout]);
      } catch (error) {
        console.warn('[PoBrawl] Portrait unavailable; using the procedural head.', error);
      }
    }
    // Navigation or a second init may have superseded the pending model load.
    if (generation !== initGeneration || !el.isConnected) return;
    game = new BrawlGame(el, dotnetRef, matchOptions);
    game.start();
    // Debug/automation handle (read-only introspection; not part of the API).
    window.PoBrawl._game = game;
  },
  reset() { if (game) game.resetMatch(false); },
  /**
   * Roll straight into the next round without a full re-init, running the
   * splash → countdown path demo mode already uses between rounds, so no
   * end-of-game modal appears in between.
   *
   * Two callers, and the null-tolerance below is what lets them share it:
   *   • the 1P ladder passes the next president + difficulty (new opponent);
   *   • the 2P best-of-3 passes neither, keeping both players' picks, and
   *     passes `roundLabel` so the splash names the round.
   *
   * @param {string|null} p2Character  new opponent, or null to keep the current one
   * @param {number|string|null} difficulty  new CPU level, or null to keep it
   * @param {string|null} roundLabel  one-shot splash heading (e.g. "ROUND 2")
   * @param {string|null} introLine  the PA's ring introduction, read under the splash
   */
  next(p2Character, difficulty, roundLabel, introLine) {
    if (!game) return;
    if (p2Character) game.options.p2Character = p2Character;
    if (difficulty !== undefined && difficulty !== null) game.options.difficulty = difficulty;
    game._roundLabel = roundLabel || null;
    game._introLine = introLine || null;
    game.resetMatch(false);
  },
  setMuted(muted) { if (game) game.setMuted(muted); },
  /**
   * Current engine phase ('intro' | 'countdown' | 'fighting' | 'ko' | 'result'), or null with
   * no engine. Read-only. The 1P ladder's roll into the next president waits on this: the KO
   * cinematic runs on the RENDER clock, which freezes in a backgrounded tab, while the page's
   * hold delay is wall-clock — without the gate, returning to a hidden-then-restored tab could
   * skip the ragdoll/replay it was owed.
   */
  phase() { return game ? game.phase : null; },
  /** Online: one server snapshot (PoBrawlMatchState) for the puppet fight (netplay.js). */
  net(state) { if (game) game.applyNet(state); },
  /** Save or share the last KO clip (GFX/SOUND #10). Resolves false when there is none. */
  saveClip() { return game ? game.saveClip() : Promise.resolve(false); },
  /**
   * Training-room controls (training.js). No-op outside a training session.
   * key: 'dummy' ('stand'|'guard'|'punisher'|'cpu') · 'hitboxes' · 'infiniteEnergy' · 'reset'
   */
  training(key, value) { if (game) game.setTrainingOption(key, value); },
  /** Say a line through the PA announcer (the post-fight press conference). */
  say(text) { if (game && text) game.audio?.announce(String(text).slice(0, 280), { rate: 1.0, pitch: 0.9, duckSec: 0.5 }); },
  destroy() {
    ++initGeneration;
    if (game) { game.dispose(); game = null; }
    window.PoBrawl._game = null;
  },
};
