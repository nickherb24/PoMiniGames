// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically.

import { PERSONALITIES } from './personalities.js';
//
// Three layers decide what the CPU does on a tick, in priority order:
//   1. the signature PHRASE (personalities.js `aiPatterns`) — a fixed script
//      that owns the fighter for a couple of seconds when it opens;
//   2. the frame-data reactions — block the wind-up, punish the whiff, coil at
//      a gassed or stunned opponent — gated by the rung's reaction time;
//   3. the signature FOOTWORK (personalities.js `footwork`) — a fixed cycle of
//      move/orbit beats that fills everything else.
// Layers 1 and 3 are never randomised, so they are learnable; layer 2 is the
// difficulty dial.
//
// In-match adaptation over a rolling ~8 s window, scaled by rung:
//   • turtles draw more kicks (the guard covers only the forearms) and baits;
//   • spammers get blocked and whiff-punished more often.

// Fifteen rungs for the 1-player presidents ladder. Difficulty is the PRODUCT of
// the columns, so keep each column strictly monotone and lift them together.
//   aggro     — scales how often the AI attacks at all.
//   comboP    — chance a punch is pre-planned as a punch→kick cancel string
//               (beats the guard, which does not cover the legs). Zero at rung 1.
//   chargeP   — how readily this rung commits to a HELD coil instead of a tap.
//   punishGas — chance per opening to load a full coil at a gassed opponent.
const LEVELS = [
  /*  1 */ { reactionMs: 560, blockP: 0.16, baitP: 0.02, punishP: 0.14, aggro: 0.72, comboP: 0.00, chargeP: 0.18, punishGas: 0.24 },
  /*  2 */ { reactionMs: 490, blockP: 0.26, baitP: 0.04, punishP: 0.24, aggro: 0.81, comboP: 0.06, chargeP: 0.23, punishGas: 0.33 },
  /*  3 */ { reactionMs: 428, blockP: 0.36, baitP: 0.06, punishP: 0.35, aggro: 0.89, comboP: 0.13, chargeP: 0.28, punishGas: 0.42 },
  /*  4 */ { reactionMs: 375, blockP: 0.46, baitP: 0.08, punishP: 0.46, aggro: 0.97, comboP: 0.20, chargeP: 0.33, punishGas: 0.50 },
  /*  5 */ { reactionMs: 328, blockP: 0.56, baitP: 0.10, punishP: 0.56, aggro: 1.04, comboP: 0.28, chargeP: 0.38, punishGas: 0.58 },
  /*  6 */ { reactionMs: 288, blockP: 0.65, baitP: 0.13, punishP: 0.65, aggro: 1.10, comboP: 0.36, chargeP: 0.42, punishGas: 0.66 },
  /*  7 */ { reactionMs: 252, blockP: 0.72, baitP: 0.16, punishP: 0.73, aggro: 1.16, comboP: 0.44, chargeP: 0.45, punishGas: 0.70 },
  /*  8 */ { reactionMs: 220, blockP: 0.78, baitP: 0.19, punishP: 0.79, aggro: 1.21, comboP: 0.52, chargeP: 0.48, punishGas: 0.75 },
  /*  9 */ { reactionMs: 192, blockP: 0.83, baitP: 0.22, punishP: 0.84, aggro: 1.26, comboP: 0.58, chargeP: 0.52, punishGas: 0.79 },
  /* 10 */ { reactionMs: 166, blockP: 0.87, baitP: 0.25, punishP: 0.88, aggro: 1.31, comboP: 0.64, chargeP: 0.55, punishGas: 0.83 },
  /* 11 */ { reactionMs: 143, blockP: 0.90, baitP: 0.28, punishP: 0.91, aggro: 1.35, comboP: 0.70, chargeP: 0.58, punishGas: 0.87 },
  /* 12 */ { reactionMs: 126, blockP: 0.92, baitP: 0.31, punishP: 0.94, aggro: 1.39, comboP: 0.75, chargeP: 0.61, punishGas: 0.90 },
  /* 13 */ { reactionMs: 113, blockP: 0.94, baitP: 0.34, punishP: 0.96, aggro: 1.43, comboP: 0.80, chargeP: 0.63, punishGas: 0.93 },
  /* 14 */ { reactionMs: 103, blockP: 0.96, baitP: 0.38, punishP: 0.98, aggro: 1.47, comboP: 0.85, chargeP: 0.66, punishGas: 0.96 },
  /* 15 */ { reactionMs:  95, blockP: 0.97, baitP: 0.42, punishP: 1.00, aggro: 1.50, comboP: 0.90, chargeP: 0.68, punishGas: 0.98 },
];

// Kept in sync with Roster.Length in PoBrawlPage.razor.
const MAX_RUNG = 15;

// Habit tracker: exponential decay so recent behavior dominates.
const HABIT_TAU = 8;          // seconds of memory
const TURTLE_THRESHOLD = 0.35; // fraction of in-range time spent blocking
const SPAM_THRESHOLD = 0.5;    // opponent attacks per second

// Longest a footwork signature may keep a fighter out of range before the AI
// closes anyway, so a dance can never stall a round out.
const FOOT_STALL_MAX = 1.0;

// Legacy string difficulties (used by demo / 2p fallbacks) map onto rungs.
const NAMED_LEVELS = { easy: 2, medium: 5, hard: 8 };

export class AiController {
  /** difficulty: 1-15 rung number, or 'easy' | 'medium' | 'hard'.
   *  charId: optional president id used to apply personality modifiers. */
  constructor(difficulty, rng = null, charId = null) {
    const level = typeof difficulty === 'number'
      ? Math.max(1, Math.min(MAX_RUNG, Math.round(difficulty)))
      : (NAMED_LEVELS[difficulty] || NAMED_LEVELS.medium);
    const p = LEVELS[level - 1];
    this.level = level;
    this.reactionMs = p.reactionMs;
    this.blockP = p.blockP;
    this.baitP = p.baitP;
    this.punishP = p.punishP;
    this.aggro = p.aggro;
    this.comboP = p.comboP;
    this.punishGasP = p.punishGas;
    // How hard the habit reads bend the weights: level 1 ≈ 0.07, level 15 = 1.
    this.adapt = level / MAX_RUNG;

    // Phrases are written at low-rung tempo; the rung scales execution speed.
    // Dwell 1.02 → 0.76; below ~0.7 the tell itself becomes unreadable.
    this.patTempo = 1.02 - 0.26 * ((level - 1) / (MAX_RUNG - 1));
    // Cadence 1.00 → 0.68: a phrase opens every ~5.4 s at the bottom, ~3.5 s at the top.
    this.patCadence = 1.00 - 0.32 * ((level - 1) / (MAX_RUNG - 1));

    // Reactive-block reaction floor: how long an opponent's wind-up must be
    // visible before the guard may answer it (the AI reads state, not animation,
    // and a frame-0 guard is always "perfect" under game.js PERFECT_GUARD_WINDOW).
    // 0.24 s → 0.09 s against punch 0.06 s / kick 0.12 s wind-ups, so:
    //   • nobody can react to a bare jab;
    //   • only rungs 13-15 get under a kick's wind-up;
    //   • a held coil is answerable by anyone, so blockP alone decides it.
    this.reactFloor = 0.24 - 0.15 * ((level - 1) / (MAX_RUNG - 1));
    // Engine time the opponent's current wind-up began, or -1 between swings,
    // and whether this rung has already taken its single block roll on it.
    this._oppWindupSince = -1;
    this._windupRolled = false;

    // Optional additive AI knobs from personalities.js `passiveAiBoost`.
    this.charId = charId;
    this._personalityMods = { blockP: 0, baitP: 0, punishP: 0 };
    if (this.charId && PERSONALITIES[this.charId]?.passiveAiBoost) {
      const b = PERSONALITIES[this.charId].passiveAiBoost;
      this._personalityMods = { ...b };
      this.blockP = Math.min(0.98, this.blockP + (b.blockP || 0));
      this.baitP = Math.min(0.6, this.baitP + (b.baitP || 0));
      this.punishP = Math.min(0.98, this.punishP + (b.punishP || 0));
    }

    this.rng = rng || { random: Math.random };
    this.sinceDecision = 1e9;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    this.retreatUntil = 0;
    this.recentHits = [];
    this.t = 0;
    // Used to occasionally start a swing then cancel to block on the next decision.
    this.baitArmed = false;
    this.baitStartedAt = 0;
    // Hold-to-charge plan: while holdName is set the AI keeps the button
    // held (the engine charges the attack), releasing at holdUntil.
    this.holdName = null;
    this.holdUntil = 0;
    this.chargeP = p.chargeP;

    // Footwork is deliberately NOT scaled by rung: the dance is who he is, and
    // a tempo that moved with the ladder would invalidate an earlier read.
    this.footwork = (this.charId && PERSONALITIES[this.charId]?.footwork) || null;
    this._footCycle = this.footwork
      ? this.footwork.reduce((s, b) => s + (b.secs || 0.3), 0) : 0;
    // True while in neutral rather than committed to a swing, guard or charge.
    // Only then are the feet refreshed every tick — see `update`.
    this._footLive = true;
    // Engine time we last closed ground; see FOOT_STALL_MAX.
    this._closedAt = 0;
    // `_pat` is the phrase currently playing, `_patReadyAt` when the next may open.
    this._pat = null;
    // Repertoire cursor: walks _unlockedPatterns in a fixed cycle, never random.
    this._patIdx = 0;
    // Stagger the first opening (and desync demo pairings). Seeded RNG, so
    // replays stay deterministic.
    this._patReadyAt = 1.2 + this.rng.random() * 1.5;
    // Pre-planned punch→kick cancel string: fire the kick edge when
    // t reaches comboAt, drop the plan if the window is missed.
    this.comboAt = 0;
    this.comboUntil = 0;
    // Rolling habit counters (exponentially decayed, HABIT_TAU memory).
    this.obsT = 0;       // decayed in-range observation time
    this.oppBlockT = 0;  // decayed in-range time the opponent spent blocking
    this.oppAtkN = 0;    // decayed count of opponent attack starts
    this.clockT = 0;     // decayed total time (normalizer for the attack rate)
    this.prevOppWindup = false;
  }

  notifyHit() {
    this.recentHits.push(this.t);
    this.recentHits = this.recentHits.filter((h) => this.t - h < 1.5);
    if (this.recentHits.length >= 2) this.retreatUntil = this.t + 0.7;
    // Taking a hit dumps any charge the engine was holding for us.
    this.holdName = null;
    // ...and breaks the signature phrase: interrupting it is the reward for reading it.
    this._pat = null;
  }

  /**
   * ctx shape (extended by the engine):
   *   { dt, distance, kickRange,
   *     opponentState, opponentStateT,           // 'punch'|'kick'|'hitstun'|...
   *     opponentWindup, opponentActive, opponentRecover, // booleans this tick
   *     selfExhausted, opponentExhausted,        // energy gate, both sides
   *     ownAttacks: { punch: {...}, kick: {...} } // with windup/active/recover
   *   }
   */
  // Decayed counters: multiply by exp(-dt/tau) each tick, then add this tick's
  // observation, so the read always reflects roughly the last HABIT_TAU seconds.
  _observe(ctx) {
    const decay = Math.exp(-ctx.dt / HABIT_TAU);
    const inRange = ctx.distance < ctx.kickRange * 1.25;
    this.obsT = this.obsT * decay + (inRange ? ctx.dt : 0);
    this.oppBlockT = this.oppBlockT * decay
      + (inRange && ctx.opponentState === 'block' ? ctx.dt : 0);
    this.clockT = this.clockT * decay + ctx.dt;
    this.oppAtkN *= decay;
    if (ctx.opponentWindup && !this.prevOppWindup) {
      this.oppAtkN += 1;
      // The reactive block measures its reaction floor from here.
      this._oppWindupSince = this.t;
      this._windupRolled = false;
    }
    if (!ctx.opponentWindup) this._oppWindupSince = -1;
    this.prevOppWindup = ctx.opponentWindup;
  }

  // 0..1 — how much of recent in-range time the opponent spent blocking.
  _turtleRead() {
    if (this.obsT < 1.5) return 0; // not enough evidence yet
    return Math.max(0, this.oppBlockT / this.obsT - TURTLE_THRESHOLD);
  }

  // Attacks/sec above the spam threshold (0 when calm).
  _spamRead() {
    if (this.clockT < 1.5) return 0;
    return Math.max(0, this.oppAtkN / this.clockT - SPAM_THRESHOLD);
  }

  // Footwork is keyed off `this.t` alone, so the cycle never resets (not on a
  // hit, phrase or knockdown) — a dance that restarted would be unlearnable.

  /** The beat this president is on right now, or null when it has no dance. */
  _footBeat() {
    if (!this.footwork || this._footCycle <= 0) return null;
    let u = this.t % this._footCycle;
    for (const b of this.footwork) {
      const s = b.secs || 0.3;
      if (u < s) return b;
      u -= s;
    }
    return this.footwork[this.footwork.length - 1];
  }

  /**
   * The beat as a movement intent.
   * @param close true when we are out of range. A retreat beat is clamped to a
   *   hold, and if the dance has kept us out of range past FOOT_STALL_MAX we
   *   close regardless of what the beat says. The orbit component is never
   *   clamped, so the signature still reads at every distance.
   */
  _footIntent(close) {
    const beat = this._footBeat();
    // No signature (BOB, or no charId): walk in with an occasional random arc,
    // give ground in neutral.
    if (!beat) {
      const side = this.rng.random() < 0.18 ? (this.rng.random() < 0.5 ? 1 : -1) : 0;
      return { move: close ? 1 : -1, side: close ? side : 0 };
    }
    let move = beat.move ?? 0;
    if (close) {
      move = Math.max(0, move);
      if (move > 0) this._closedAt = this.t;
      else if (this.t - this._closedAt > FOOT_STALL_MAX) move = 1;
    } else {
      this._closedAt = this.t;
    }
    return { move, side: beat.side || 0 };
  }

  // ── Signature pattern runner ──────────────────────────────────────────
  // Neither a phrase nor the order phrases play in is randomised — learnability
  // is the design constraint. It stays fair because it only opens in range and
  // off cooldown, a landed hit cancels it (notifyHit), and it is a phrase, not
  // a loop, so there is always recovery after.

  /**
   * How much of this president's repertoire this rung may use. `aiPatterns` is
   * ordered: index 1 is written as the answer to having learned index 0.
   */
  _unlockedPatterns() {
    const all = PERSONALITIES[this.charId]?.aiPatterns;
    if (!all || !all.length) return null;
    // 1..3 → 1 phrase, 4..9 → 2, 10..15 → 3 (clamped to what exists).
    const depth = Math.min(all.length, this.level >= 10 ? 3 : this.level >= 4 ? 2 : 1);
    return all.slice(0, depth);
  }

  _patternDue(ctx) {
    const set = this._unlockedPatterns();
    if (!set || this.holdName || this.t < this.retreatUntil) return false;
    if (this.t < this._patReadyAt) return false;
    // Range gate uses the NEXT phrase's own reach.
    const pat = set[this._patIdx % set.length];
    return ctx.distance < ctx.kickRange * (pat.range || 1.2);
  }

  _startPattern(ctx) {
    const set = this._unlockedPatterns();
    const pat = set[this._patIdx % set.length];
    // Advance on OPEN, not finish: an interrupted phrase still counts as played.
    this._patIdx = (this._patIdx + 1) % set.length;
    this._pat = {
      steps: pat.steps, i: 0, until: 0, fired: false, tempo: this.patTempo,
    };
    // Cadence runs start-to-start, so the gap a player counts is between openings.
    this._patReadyAt = this.t + (pat.everySecs || 5) * this.patCadence;
    // A phrase supersedes any half-formed plan and owns the feet outright.
    this._footLive = false;
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
  }

  // Returns an intent while the phrase is mid-flight, or null once it ends
  // (letting the normal decision loop resume on the same tick).
  _runPattern(ctx) {
    const p = this._pat;
    const step = p.steps[p.i];
    if (!step) { this._pat = null; return null; }

    // Entering a step: stamp its dwell and let this tick carry the press edge.
    if (p.until === 0) {
      p.until = this.t + (step.secs || 0.2) * p.tempo;
      p.fired = false;
    }

    const done = this.t >= p.until;
    const out = this._stepIntent(step, p.fired);
    p.fired = true;

    if (done) {
      p.i += 1;
      p.until = 0;
      // Dropping the held flag when a `charge` step ends releases the strike.
      if (p.i >= p.steps.length) {
        this._pat = null;
        this.sinceDecision = 0;
      }
    }
    return out;
  }

  // One step → one intent. `edgeSpent` suppresses the press edge on every frame
  // after the first: punch/kick are edge-triggered, and re-pressing each frame
  // would restart the swing the moment the engine returned to idle.
  _stepIntent(step, edgeSpent) {
    const base = { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
    const atk = step.attack || 'punch';
    switch (step.act) {
      case 'punch':
      case 'kick':
        return edgeSpent ? base : { ...base, [step.act]: true };
      case 'charge': {
        // Press once, then hold; the engine throws when *Held drops
        // (_tickFighter), so the visible coil IS this step's duration.
        const out = { ...base, [atk + 'Held']: true };
        if (!edgeSpent) out[atk] = true;
        return out;
      }
      case 'block':    return { ...base, block: true };
      case 'advance':  return { ...base, move: 1 };
      case 'retreat':  return { ...base, move: -1 };
      // Held for the whole step: `side` is a sustained orbit, not an edge.
      case 'sidestep': return { ...base, side: step.dir || -1 };
      case 'wait':
      default:         return base;
    }
  }

  /**
   * Commit to a held coil and return the intent that starts it. The engine
   * throws the strike when `<name>Held` drops, so the hold IS the visible wind-up.
   *
   * @param kickBias 0..1 chance the coil is a kick rather than a punch.
   * @param spread   seconds of extra hold on top of the 0.45 s base.
   */
  _loadCharge(kickBias, spread) {
    const name = this.rng.random() < kickBias ? 'kick' : 'punch';
    this.holdName = name;
    this.holdUntil = this.t + 0.45 + this.rng.random() * spread;
    this._footLive = false;   // a loaded coil roots the feet
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    const out = { ...this.current };
    out[name] = true;            // press edge starts the charge
    out[name + 'Held'] = true;   // and the hold keeps it winding
    return out;
  }

  update(ctx) {
    this.t += ctx.dt;
    this.sinceDecision += ctx.dt * 1000;
    this._observe(ctx);

    // Habit-adjusted probabilities for this tick; capped so low rungs stay beatable.
    const spam = this._spamRead();
    const turtle = this._turtleRead();
    const effBlockP = Math.min(0.95, this.blockP + spam * 0.5 * this.adapt);
    const effPunishP = Math.min(0.95, this.punishP + spam * 0.4 * this.adapt);
    const effBaitP = Math.min(0.5, this.baitP + turtle * 0.4 * this.adapt);

    // Edge-triggered flags are consumed each read; holds (move/block) persist.
    const intent = { ...this.current, punch: false, kick: false, side: 0 };

    // ── Gassed out ──────────────────────────────────────────────────────
    // The engine refuses attacks until the bar recovers (game.js _canAttack),
    // and blocking refills fastest. Ahead of the pattern runner and charge hold
    // so neither keeps feeding attacks into a closed gate.
    if (ctx.selfExhausted) {
      this._pat = null;
      this.holdName = null;
      this.sinceDecision = 0;
      this._footLive = false;   // the dance is off while catching a breath
      const backoff = ctx.distance < ctx.kickRange * 0.9 ? -1 : 0;
      this.current = { move: backoff, side: 0, punch: false, kick: false, block: true };
      return { ...this.current, super: false };
    }

    // ── Signature pattern ───────────────────────────────────────────
    // A running script owns the fighter until it finishes or is interrupted.
    if (this._pat) {
      const out = this._runPattern(ctx);
      if (out) return out;
    } else if (this._patternDue(ctx)) {
      this._startPattern(ctx);
      const out = this._runPattern(ctx);
      if (out) return out;
    }

    // ── Active charge hold ──────────────────────────────────────────────
    // Keep the button held until holdUntil, then drop it so the engine throws.
    if (this.holdName) {
      if (this.t < this.holdUntil) {
        const out = { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
        out[this.holdName + 'Held'] = true;
        return out;
      }
      this.holdName = null;
      this.sinceDecision = 0;
      return { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
    }

    // ── Signature super activation ────────────────────────────────────
    // Per-tick chance scales with rung; 4 s cooldown after firing. The engine
    // consumes intent.super once (_fireSuper), so it is one-shot per meter fill.
    if (ctx.superMeterFull && this.t >= (this.superCooldownUntil || 0)) {
      const superP = Math.min(0.85, 0.15 + (this.level - 1) * 0.05);
      const oppVulnerable = ctx.opponentState === 'hitstun'
        || ctx.opponentState === 'block'
        || (ctx.opponentWindup && ctx.distance < ctx.kickRange * 1.1)
        || ctx.opponentState === 'idle';
      if (oppVulnerable && this.rng.random() < superP) {
        this.superCooldownUntil = this.t + 4.0;
        return { move: 0, side: 0, punch: false, kick: false, block: false, super: true };
      }
    }

    // ── Pre-planned cancel string ───────────────────────────────────────
    // Fires outside the reaction gate — it was decided when the punch started.
    if (this.comboAt > 0 && this.t >= this.comboAt) {
      const missed = this.t > this.comboUntil
        || ctx.distance > ctx.kickRange * 1.1;
      this.comboAt = 0;
      this.comboUntil = 0;
      if (!missed) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        this.sinceDecision = 0;
        return { ...this.current, kick: true };
      }
    }

    // ── Reactive defense ────────────────────────────────────────────────
    // Block once the wind-up has been visible for reactFloor. ONE roll per
    // swing, not per tick: per-tick rolls compound over a long coil and make
    // blockP meaningless.
    const windupSeen = this._oppWindupSince >= 0
      && (this.t - this._oppWindupSince) >= this.reactFloor;
    if (windupSeen && !this._windupRolled && ctx.distance < ctx.kickRange * 1.25) {
      this._windupRolled = true;
      if (!this.current.block && this.rng.random() < effBlockP) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
        this.sinceDecision = 0;
        this._footLive = false;
        this.baitArmed = false;
        this.comboAt = 0;
        this.comboUntil = 0;
        return { ...this.current };
      }
    }

    // ── Footwork between decisions ──────────────────────────────────────
    // The feet run on the engine clock, not the reactionMs decision clock, or
    // short beats would be dropped at low rungs. `_footLive` keeps this from
    // overriding a commitment (swing, guard, bait, charge).
    if (this._footLive && this.footwork) {
      const foot = this._footIntent(ctx.distance > ctx.kickRange);
      this.current.move = foot.move;
      this.current.side = foot.side;
      intent.move = foot.move;
      intent.side = foot.side;
    }

    if (this.sinceDecision < this.reactionMs) return intent;
    this.sinceDecision = 0;

    // ── Anti-stunlock retreat ───────────────────────────────────────────
    if (this.t < this.retreatUntil) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
      this._footLive = false;
      return { ...this.current };
    }

    // ── Gas punish ──────────────────────────────────────────────────────
    // A gassed opponent can only guard, so a coil is right either way. Ahead of
    // the hitstun coil: hitstun lasts 0.35 s, the gas window lasts seconds.
    if (ctx.opponentExhausted && ctx.distance < ctx.kickRange * 1.15
        && this.rng.random() < this.punishGasP) {
      return this._loadCharge(0.55, 0.55);
    }

    // ── Charged attack while the opponent is in hitstun ────────────────
    if (ctx.opponentState === 'hitstun' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP) {
      return this._loadCharge(0.45, 0.5);
    }

    // ── Open-guard coil: punish a player who never blocks ──────────────
    // Damped by the turtle read — against a guarder, kicks are the better answer.
    if (ctx.opponentState === 'idle' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP * 0.5 * (1 - Math.min(1, turtle * 2))) {
      return this._loadCharge(0.4, 0.45);
    }

    // ── Out of range: close on this president's own footwork ────────────
    // `side` is a held orbit, so it is stored ON this.current, not the returned copy.
    if (ctx.distance > ctx.kickRange) {
      const foot = this._footIntent(true);
      this.current = {
        move: foot.move, side: foot.side, punch: false, kick: false, block: false,
      };
      this._footLive = true;
      this.baitArmed = false;
      return { ...this.current };
    }

    // ── In range: frame-data aware choices ──────────────────────────────
    if (this.baitArmed && (this.t - this.baitStartedAt) > (ctx.ownAttacks.punch.windup + 0.02)) {
      // Cancel the bait into block — looks like the AI feinted.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current };
    }

    if ((ctx.opponentActive || ctx.opponentRecover) && this.rng.random() < effPunishP) {
      // Punch is the fastest move — best for punishing recovery.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current, punch: true };
    }

    // Attack shares scale with aggro; the leftover goes to guard/bait/footwork.
    // Vs a turtle, punch share shifts into kick (the guard covers only the forearms).
    const r = this.rng.random();
    let pPunch = 0.35 * this.aggro;
    let pKick = 0.25 * this.aggro;
    const kickShift = Math.min(pPunch * 0.6, turtle * 0.8 * this.adapt);
    pPunch -= kickShift;
    pKick += kickShift;
    if (r < pPunch) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      this._footLive = false;
      if (this.comboP > 0 && this.rng.random() < this.comboP) {
        this.comboAt = this.t + ctx.ownAttacks.punch.cancelInto.kick + 0.04;
        this.comboUntil = this.comboAt + 0.15;
      }
      return { ...this.current, punch: true };
    } else if (r < pPunch + pKick) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current, kick: true };
    } else if (r < pPunch + pKick + 0.15) {
      // Optionally arm a bait: start a punch, then cancel into block next tick.
      this._footLive = false;
      if (this.rng.random() < effBaitP) {
        this.baitArmed = true;
        this.baitStartedAt = this.t;
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        return { ...this.current, punch: true };
      }
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
    } else {
      // Neutral share walks the signature. Without one, the first 0.15 of this
      // share backpedals and the rest stands still.
      const foot = this.footwork
        ? this._footIntent(false)
        : { move: r < pPunch + pKick + 0.30 ? -1 : 0, side: 0 };
      this.current = {
        move: foot.move, side: foot.side, punch: false, kick: false, block: false,
      };
      this._footLive = true;
    }
    this.baitArmed = false;
    return { ...this.current };
  }

  dispose() {}
}
