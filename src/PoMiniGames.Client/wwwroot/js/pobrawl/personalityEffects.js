// personalityEffects.js — per-president behaviour: the personality tick, the
// super meter, the super cinematic and its effects, and the on-hit quirks.
//
// Split out of game.js 2026-08-11 (PoBrawl audit #9). Mixed into BrawlGame's
// prototype, so every method here runs with `this` bound to the live game exactly
// as it did when these bodies sat in the class — see mixin.js for why.

import * as THREE from 'three';
import { PERSONALITIES } from './personalities.js';
import { MAX_HP } from './constants.js';

class PersonalityEffectsMethods {
  // ── Personality helpers ────────────────────────────────────────────
  // On every fighter tick the engine checks trigger-once thresholds
  // (Reagan at <25% HP → Morning in America, W Bush at <40% → Decider,
  // Carter at <30% → Malaise Speech iframes, W Bush/Nixon once-per-round
  // flags), and clears expired modes.
  _tickPersonalities(f, dt) {
    if (!f.personality) return;
    const per = f.personality;
    const hpFrac = f.hpCur / MAX_HP;
    const now = this.t;

    // FDR "Four-Term Foundation" startup boost — armed on the first personality
    // tick of the round (once per fighter; gated by a flag). Fires for the
    // first `durationSecs` seconds of the match.
    if (f.charId === 'fdr' && PERSONALITIES.fdr?.startupBoost
        && !per._fdrStartupArmed) {
      per._fdrStartupArmed = true;
      per.fdrStartupUntil = now + (PERSONALITIES.fdr.startupBoost.durationSecs || 3.0);
      per.activeMode = 'fourTerm';
    }

    // Mode expiration.
    if (per.activeMode && per.modeExpiresAt && now >= per.modeExpiresAt) {
      per.activeMode = null;
      per.modeExpiresAt = 0;
    }

    // Trigger-once per round for character modes.
    const prof = per.profile;
    if (!per.triggerFired) {
      if (prof?.triggerOnce && prof.checkHpBelow != null && hpFrac <= prof.checkHpBelow) {
        per.triggerFired = true;
        if (prof.onTrigger === 'decider') {
          // W Bush: 1.5 s freeze window, then +40% dmg + 15% speed for rest
          // of round. We approximate the freeze by sticking him in 'idle'
          // for 1.5 s while his intent-to-attack dominates.
          per.activeMode = 'decider';
          // Use the timestep + 8 s so mode=decider is sticky for the match.
          per.modeExpiresAt = now + (prof.onTriggerParams?.durationSecs || 30);
          // The "freeze" portion is realized by delaying the first post-
          // decider attack: pause his controller for 1.5 s.
          if (f.controller && f.controller.__proto__?.constructor?.name === 'AiController') {
            f.controller.__freezeUntil = now + (prof.onTriggerParams?.freezeSecs || 1.5);
          } else if (f.controller) {
            f.controller.__freezeUntil = now + (prof.onTriggerParams?.freezeSecs || 1.5);
          }
          f.animator.play('salute'); // visual cue — decider "stops to think"
        } else if (prof.onTrigger === 'morningInAmerica') {
          per.activeMode = 'morningInAmerica';
          per.modeExpiresAt = now + (prof.onTriggerParams?.durationSecs || 6);
        } else if (prof.onTrigger === 'malaiseSpeech') {
          per.iframesUntil = now + (prof.onTriggerParams?.iframesSecs || 1.5);
          per.activeMode = 'malaiseSpeech';
          per.modeExpiresAt = now + (prof.onTriggerParams?.iframesSecs || 1.5);
        }
      }
    }

    // Slow effect clears.
    if (per.slowUntil && now >= per.slowUntil) {
      per.slowUntil = 0;
      f.slowMul = 1.0;
    }

    // ── FDR "Four-Term Foundation" startup boost ────────────────────
    // First 3 s of a match, FDR has +10% speed and +10% dmg. The engine
    // clears the boost when the timer expires.
    if (per.fdrStartupUntil) {
      if (now >= per.fdrStartupUntil) {
        per.fdrStartupUntil = 0;
        per.activeMode = null;
      } else if (!per.activeMode) {
        per.activeMode = 'fourTerm';
      }
    }
    // JFK "PT-109 Survivor" dash clear.
    if (per.jfkDashUntil && now >= per.jfkDashUntil) per.jfkDashUntil = 0;

    // Eisenhower "Atoms for Peace" iframes clear.
    if (per.eisenhowerIframesUntil && now >= per.eisenhowerIframesUntil) {
      per.eisenhowerIframesUntil = 0;
    }
    // JFK profile-iframes clear.
    if (per.jfkProfileIframesUntil && now >= per.jfkProfileIframesUntil) {
      per.jfkProfileIframesUntil = 0;
    }
    // FDR periodic iframes ("Fireside Chat") fire every ~6 s.
    if (per.fdrIframesUntil && now >= per.fdrIframesUntil) {
      per.fdrIframesUntil = 0;
    }
    // Periodic iframes schedule.
    if (PERSONALITIES.fdr?.periodicIframes && !per.fdrIframesUntil
        && per.fdrPeriodicReady === undefined) {
      per.fdrPeriodicReady = now + (PERSONALITIES.fdr.periodicIframes.everySecs || 6) - 1.5;
    }
    if (per.fdrPeriodicReady !== undefined && now >= per.fdrPeriodicReady
        && PERSONALITIES.fdr?.periodicIframes && f.charId === 'fdr') {
      per.fdrIframesUntil = now + (PERSONALITIES.fdr.periodicIframes.iframesSecs || 0.4);
      per.fdrNextSwingReachMul = PERSONALITIES.fdr.periodicIframes.nextSwingReachMul || 1.25;
      per.fdrPeriodicReady = now + (PERSONALITIES.fdr.periodicIframes.everySecs || 6);
    }

    // Truman "Buck Stops Here" stack decay (50% of a stack per sec without
    // being hit — represented as a half-life approximately every 1.4 s).
    if (PERSONALITIES.truman?.stacksOnHit && per.trumanBuckStacks > 0) {
      const cur = per.trumanBuckStacks;
      per.trumanBuckStacks = Math.max(0,
        cur - (PERSONALITIES.truman.stacksOnHit.decayPerSec || 0.5) * dt);
    }

    // ── Eisenhower & JFK HP-gated modes (PT-109 / Atoms for Peace / Day of Infamy)
    if (prof?.triggerHpGated && !per._hpTriggeredByKey) per._hpTriggeredByKey = {};
    if (prof?.triggerHpGated) {
      const tg = prof.triggerHpGated;
      const opp = this.fighters.find((o) => o !== f);
      const oppHp = opp?.hpCur ?? 100;
      const myHpFrac = f.hpCur / MAX_HP;
      if (!per._hpTriggeredByKey[tg.modeName]) {
        let fire = false;
        if (tg.checkHpBelow != null && myHpFrac <= tg.checkHpBelow) fire = true;
        if (tg.checkHpAboveOpp != null
            && (myHpFrac - oppHp / MAX_HP) >= tg.checkHpAboveOpp) fire = true;
        if (fire) {
          per._hpTriggeredByKey[tg.modeName] = true;
          if (tg.modeName === 'pt109Dash') {
            per.jfkDashUntil = now + (tg.durationSecs || 4.0);
            per.jfkDashCooldownUntil = now + (tg.cooldownSecs || 6.0);
          } else if (tg.modeName === 'atomsForPeace') {
            per.eisenhowerIframesUntil = now + (tg.iframesSecs || 1.0);
            per.eisenhowerNextSwingAtkMul = tg.nextSwingAtkMul || 1.20;
          } else if (tg.modeName === 'dayOfInfamy') {
            per.activeMode = tg.modeName;
            per.modeExpiresAt = now + (tg.durationSecs || 5.0);
          }
        }
      }
    }
    // JFK profile-iframes: time-gated, fires at triggerT seconds into the
    // match (single fire). Used for "Profiles in Courage".
    if (prof?.triggerT !== undefined && !per._timeTriggered
        && this.t >= prof.triggerT) {
      per._timeTriggered = true;
      if (prof.onTrigger === 'profilesInCourage') {
        const params = prof.onTriggerParams || {};
        per.jfkProfileIframesUntil = now + (params.iframesSecs || 0.45);
        per.jfkNextSwingAtkMul = params.nextSwingAtkMul || 1.25;
      }
    }
  }

  // ── SUPER METER ────────────────────────────────────────────────────────
  // The comeback super meter is a per-fighter 0..1 pool that fills passively
  // by taking damage (see the damage roll in _tryHit). When ≥ 1.0 it fires:
  // for a HUMAN fighter automatically and immediately (game.js
  // `_autoSuperReady` — there is no super key any more, and no bar for it in
  // the HUD), and for the AI when its own rung-paced gating emits
  // `intent.super = true`. Firing calls `_fireSuper`, which:
  //   1. consumes the meter to zero (one-shot),
  //   2. routes through PERSONALITIES[id].onSuper to set the right runtime
  //      fields (mode, iframes, dirty count, swing bonus, etc.),
  //   3. emits a screen-wide flash + camera pulse + audio cue for impact.
  //
  // The meter is intentionally NOT fueled by dealing damage: the design is a
  // comeback mechanic — you earn the super by being on the wrong end of a
  // beatdown, so the burst is the response that turns the round around.
  //
  // Per-frame: the meter does not tick down. It stays at 1.0 until consumed by
  // a fire (or wiped on round reset).
  //
  // The `superUntil` write that used to live here is gone (2026-08-11). It
  // opened a 1.6 s "PRESS SUPER" flash window for the HUD — and the HUD no
  // longer has a super bar to flash. Nothing else ever read it.
  _tickSuperMeter(f, opp, dt) {
    const per = f.personality;
    if (!per) return;
    // Cap at 1.0 — the meter is binary "ready or not".
    if (per.superMeter > 1.0) per.superMeter = 1.0;
    // Defensive: a personality with no onSuper config must never accumulate a
    // meter. This is what keeps BOB — who has no signature move by design —
    // from auto-firing an undefined super the instant he takes a hit.
    if (!PERSONALITIES[f.charId]?.onSuper) per.superMeter = 0;
  }

  // Fire the fighter's signature super. Called from _tickFighter on a
  // super-intent edge in the idle state, OR from the AI controller's
  // super-activation block via the same intent. Always called with meter
  // ≥ 1.0 — if not, this is a no-op.
  _fireSuper(f) {
    const per = f.personality;
    const cfg = PERSONALITIES[f.charId]?.onSuper;
    if (!per || !cfg || per.superMeter < 1.0) return;
    // Consume the meter regardless of fill level — one-shot, intentionally
    // not "spend only what you need". This rewards timing over hoarding.
    per.superMeter = 0;
    per.superActiveMode = cfg.mode;
    per.superFiredAt = this.t;
    // Apply the per-mode effects via a small switch. Each block writes the
    // runtime fields the existing damage / hit / tick code paths already
    // consult (activeMode, modeExpiresAt, iframesUntil, superSwingAtkMul,
    // superDirtySwingsLeft, superPumpSwingsLeft, lbjMissKBUntil, etc.).
    this._applySuperEffect(f, cfg);
    // ── Feedback ────────────────────────────────────────────────────────
    // Was: an exposure bump, a DOM flash, and audio.whoosh() — the same sound a
    // MISSED JAB makes. For the roster's marquee mechanic that was far too
    // thin, so the whole moment is now a directed cinematic. See
    // _startSuperCinematic; everything below it is the one-frame kick that
    // opens it.
    this.exposurePulse = Math.max(this.exposurePulse || 0, 0.55);
    this.hitstopT = Math.max(this.hitstopT || 0, 0.18);
    if (this.flash) {
      this.flash.style.transition = 'opacity 0.05s linear';
      this.flash.style.background = 'rgba(255, 240, 200, 0.55)';
      this.flash.style.opacity = '1';
      setTimeout(() => {
        if (this.flash) {
          this.flash.style.transition = 'opacity 0.45s ease-out';
          this.flash.style.opacity = '0';
        }
      }, 60);
    }
    this._startSuperCinematic(f);
  }

  // ══ Signature-super cinematic (GFX/SOUND #2) ═════════════════════════
  // A directed ~1.3 s beat, on wall-clock rather than sim time so the time
  // dilation it applies cannot slow down its own timeline.
  //
  //   TIME     the sim drops to ~0.22× and eases back to 1×
  //   CAMERA   cuts to a low hero angle on the firing fighter and pushes in
  //   EDGE     the ink line spikes to the character's accent colour
  //   SMEAR    the afterimage pass is held on for the whole beat
  //   LINES    speedlines are re-armed every frame so they stay up
  //   SOUND    a dedicated stinger, and the PA calls the move
  _startSuperCinematic(f) {
    this._superDur = 1.3;
    this._superT = this._superDur;
    this._superFighter = f;
    this.cameraMode = 'super';
    this.cameraModeT = 0;
    // Cleared so the orbit re-seeds from wherever the boom actually is on the
    // first frame of THIS super, rather than reusing the previous one's arc.
    this._superAngle = undefined;
    this._camVel.set(0, 0, 0);
    // 2026-09-29: a shockwave off the chest and a burst from the press row.
    const rp = f.rig.root.position;
    this._shockwave(new THREE.Vector3(rp.x, rp.y + 1.2, rp.z), 0.9);
    this._pressBurst(5);
    if (this.audio) {
      this.audio.superStinger();
      // Suit the announcement to the fighter rather than a generic call.
      this.audio.announce(`${f.rig.config.name}! ${this._superMoveName(f)}!`,
        { rate: 1.0, pitch: 0.55, duckSec: 0.8 });
    }
    // Accent the ink edge with the fighter's own suit/tie colour so the
    // silhouette reads as "charged" rather than just outlined.
    const accent = f.rig.baseColors?.tie || f.rig.baseColors?.suit;
    for (const u of f.inkUniforms || []) {
      if (accent) u.uInkColor.value.copy(accent).lerp(new THREE.Color(0xffffff), 0.35);
    }
  }

  // Spoken name of a fighter's signature move, for the PA call.
  //
  // Derived from the personality's `mode` rather than read from a new `label`
  // field, deliberately: the fifteen onSuper blocks in personalities.js are
  // gameplay config, and adding a display string to each one is fifteen places
  // for the announcer to fall out of sync with the mechanic. 'droneStrike'
  // → "Drone Strike". An explicit `label` still wins if one is ever added.
  _superMoveName(f) {
    const cfg = PERSONALITIES[f.charId]?.onSuper;
    if (!cfg) return 'Super';
    if (cfg.label) return cfg.label;
    return String(cfg.mode || 'super')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (ch) => ch.toUpperCase())
      .trim();
  }

  _tickSuperCinematic(dt) {
    if (!this._superT) return;
    // A KO always outranks a super — the KO path owns timeScale and the camera
    // from the moment it fires, and two directors fighting over both is how you
    // get a camera stuck between two targets at 0.35× forever.
    if (this.phase === 'ko' || this.phase === 'result') { this._endSuperCinematic(); return; }

    this._superT = Math.max(0, this._superT - dt);
    const k = 1 - this._superT / this._superDur;    // 0 → 1 across the beat

    // Time dilation: slam down, ease back. Cubic on the way out so most of the
    // recovery happens in the last third and the hit lands at full speed.
    this.timeScale = 0.22 + 0.78 * (k * k * k);
    // Held effects. Both are Math.max-style arming, so an impact landing during
    // the super can still push them higher without this stomping it.
    this._speedPulse = Math.max(this._speedPulse || 0, 0.22 + 0.34 * (1 - k));
    this._smear(0.1, 0.70);
    this.exposurePulse = Math.max(this.exposurePulse || 0, 0.22 * (1 - k));

    if (this._superT <= 0) this._endSuperCinematic();
  }

  _endSuperCinematic() {
    if (!this._superT && !this._superFighter) return;
    this._superT = 0;
    // Only hand time and the camera back if nothing else has claimed them —
    // the KO branch sets both, and this runs after it on the same frame.
    if (this.phase !== 'ko' && this.phase !== 'result') {
      this.timeScale = 1;
      if (this.cameraMode === 'super') { this.cameraMode = 'normal'; this.cameraModeT = 0; }
    } else if (this.cameraMode === 'super') {
      this.cameraMode = 'normal';
    }
    for (const u of this._superFighter?.inkUniforms || []) {
      u.uInkColor.value.setHex(0x05070f);
    }
    this._superFighter = null;
  }

  // Per-mode super effect applier. Reads PERSONALITIES[id].onSuper and writes
  // the corresponding runtime fields consumed by the existing engine paths.
  // Each block is a single switch arm so adding a new personality's super is
  // a one-arm change here + one onSuper config block in personalities.js.
  _applySuperEffect(f, cfg) {
    const per = f.personality;
    const opp = this.fighters.find((o) => o !== f);
    if (!per) return;
    switch (cfg.mode) {
      case 'theWall': {
        // Trump: stack ramp for 3 s.
        per.activeMode = 'theWallSuper';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 3.0);
        // Inline ramp: superSwingAtkMul gets set on every swing commit while
        // active, so we only need a flag here. The damage roll multiplies by
        // (1 + koStacks × 0.05) via the existing per-stack path.
        break;
      }
      case 'bigGuy': {
        // Biden: auto-fill energy to max + auto-arm next swing for lockSecs.
        f.energy = 1.0;
        f.chargeAmt = 1.0;
        // Clear the existing _enterCharge cooldown by entering charge state
        // directly if the player presses punch/kick within the lock window.
        per._bigGuyLockUntil = this.t + (cfg.lockSecs || 1.5);
        break;
      }
      case 'droneStrike': {
        // Obama: iframes + next swing atkMul.
        per.iframesUntil = this.t + (cfg.iframesSecs || 1.5);
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 2.5;
        break;
      }
      case 'deciderManual': {
        // Bush: same as the passive HP-gated mode but no freeze window.
        per.activeMode = 'decider';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 30);
        // Note: the freeze window is what the AI controller's __freezeUntil
        // would normally trigger; we deliberately skip it on the manual path
        // so the human player gets the buff the instant they press the key.
        break;
      }
      case 'saxSolo': {
        // Clinton: arms a one-shot 1.6× next-swing + auto chain. The chain
        // arms via the existing clinton onHitChain handler — we only need to
        // raise the atkMul here and bias the next swing's windup longer.
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 1.6;
        per._saxSoloUntil = this.t + 1.2;
        break;
      }
      case 'voodoo': {
        // Bush Sr.: 3 voodoo-tax swings. The flag is decremented per swing
        // in _enterAttack.
        per.superPumpSwingsLeft = cfg.swingCount || 3;
        break;
      }
      case 'morningInAmerica': {
        // Reagan: +40% dmg + 20% speed for the configured duration.
        per.activeMode = 'morningInAmerica';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 6);
        break;
      }
      case 'malaiseSpeech': {
        // Carter: iframes + next-hit slow (the slow is applied in
        // _applyOnHitPersonalities when this mode is the superActiveMode).
        per.iframesUntil = this.t + (cfg.iframesSecs || 1.5);
        break;
      }
      case 'pardonMe': {
        // Ford: opponent input-blind. Applied directly on the opponent's
        // fighter object (mirrors Nixon's existing eye-gouge path).
        if (opp) {
          opp._inputBlindUntil = this.t + (cfg.blindSecs || 1.0);
          opp._inputBlindMissRate = cfg.blindMissRate || 0.60;
        }
        break;
      }
      case 'notACrook': {
        // Nixon: N dirty swings + first one blinds on hit.
        per.superDirtySwingsLeft = cfg.dirtySwings || 3;
        per._notACrookFirst = true;
        break;
      }
      case 'treatmentManual': {
        // LBJ: arm a long miss-charge window the player picks the moment of.
        per.lbjMissKBUntil = this.t + (cfg.windowSecs || 8.0);
        break;
      }
      case 'profilesInCourage': {
        // JFK: iframes + next-swing bonus. The manual super is larger than
        // the time-gated passive (0.6 s / 1.5× vs 0.45 s / 1.25×).
        per.jfkProfileIframesUntil = this.t + (cfg.iframesSecs || 0.6);
        per.jfkNextSwingAtkMul = cfg.nextSwingAtkMul || 1.5;
        break;
      }
      case 'overlord': {
        // Eisenhower: 2.2× next swing + 1 s iframes.
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 2.2;
        per.eisenhowerIframesUntil = this.t + (cfg.iframesSecs || 1.0);
        break;
      }
      case 'buckStopsHere': {
        // Truman: triple the current buckStacks for the next swing. Clear
        // stacks after so the player doesn't double-dip.
        const mul = cfg.stackMul || 3.0;
        per.superSwingAtkMul = 1.0 + (per.trumanBuckStacks || 0) * 0.02 * mul;
        per.trumanBuckStacks = 0;
        break;
      }
      case 'dayOfInfamy': {
        // FDR: longer-than-passive +35% dmg buff, no HP gate.
        per.activeMode = 'dayOfInfamy';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 8.0);
        break;
      }
      default:
        // Unknown mode: silently ignore (shouldn't happen — PERSONALITIES
        // controls the dispatch).
        break;
    }
  }

  // Resolve per-hit personality effects: Biden slow-on-charge, Clinton elbow
  // flourish scheduling, Reagan/Bush damage multipliers (already applied in
  // the baseDmg block above), Ford retaliate rollover when Ford is hit during
  // his stumble, Nixon eye-gouge proc.
  _applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack) {
    const att = attacker.personality;
    const def = defender.personality;
    const now = this.t;
    // Accumulated damage multiplier for the new president layer (LBJ pump,
    // JFK Camelot Glint, Truman Buck Stops Here, FDR day/speed). Returned
    // so the caller can multiply baseDmg just before the damage roll.
    let personalityDmgMul = 1.0;

    // Biden "The Big Guy": when his charged attack lands, apply a 1.0 s moveMul
    // drop on the defender. The biden config sets chargeMul heavily on the
    // tag-detection side; we just check chargeMul > 1 as a proxy.
    if (att?.id === 'biden' && PERSONALITIES.biden?.onChargeHitEffect
        && attacker.chargeMul > 1.0) {
      const params = PERSONALITIES.biden.onHitEffectParams;
      defender.slowUntil = now + (params?.slowSecs || 1.0);
      defender.slowMul = params?.slowMul || 0.5;
    }

    // Bush Sr. "VOODOO ECONOMICS" super: the swing carried a voodoo-tax tag
    // — multiply this hit's damage by the voodoo mul. The swing counter was
    // decremented at swing commit, so we just consult the flag here.
    if (attacker._bushsrSuperPump && att?.id === 'bushsr') {
      const cfg = PERSONALITIES.bushsr?.onSuper;
      personalityDmgMul *= (cfg?.swingAtkMul || 1.4);
      attacker._bushsrSuperPump = false;
    }
    // Trump "THE WALL" super: koStacks ramp is folded into the personality
    // dmgMul above for the next 3 s. (No additional action needed here —
    // superSwingAtkMul = (1 + koStacks × 0.05) was set in _fireSuper.)
    // Carter "MALAISE SPEECH" super: on a landed hit during the window, apply
    // a brief slow on the defender. The iframes are consumed at hit-resolution
    // time via the existing perPer?.iframesUntil check.
    if (att?.superActiveMode === 'malaiseSpeech' && att?.superFiredAt
        && now - att.superFiredAt < (PERSONALITIES.carter.onSuper.slowSecs || 0.5)) {
      defender.slowUntil = now + (PERSONALITIES.carter.onSuper.slowSecs || 0.5);
      defender.slowMul = PERSONALITIES.carter.onSuper.slowMul || 0.55;
    }

    // Clinton "I Feel Your Pain": on a Clinton landed hit, queue follow-up
    // elbow jabs (1 + chained hits scaled by sax-solo counter). The simplest
    // realization is rapid extra damage ticks on a short timer. For the first
    // pass, we add a single extra damage tick to keep the budget down.
    if (att?.id === 'clinton') {
      const flourish = PERSONALITIES.clinton?.onHitChain;
      if (flourish && attack.name === 'punch') {
        const extra = Math.min(flourish.growthCap, flourish.hits + att.saxSinceMiss);
        // Schedule staggered extra damage ticks: 2 more ~50 damage hits over
        // the next 0.45 s.
        this._scheduleClintonFlourish(attacker, defender, extra, hit);
      }
    }

    // Carter "Habitat for Humanity": each landed personal hit bumps the combo
    // ladder; resets after 3 s of no-hit time.
    if (att?.id === 'carter' && PERSONALITIES.carter?.passive
        && PERSONALITIES.carter.passive.name === 'habitatForHumanity') {
      att.habitatComboN = Math.min(
        PERSONALITIES.carter.passive.comboLadderMax,
        att.habitatComboN + 1);
      att.habitatComboT = now;
    }

    // Ford retaliate window opens if defender hits Ford during his stumble.
    if (def?.id === 'ford' && now < def.stumbleUntil) {
      def.retaliateUntil = now + (PERSONALITIES.ford?.onStumbleHit?.retaliateSecs || 1.5);
    }

    // Nixon "I Am Not a Crook": once-per-round eye-gouge on a landed dirty
    // hit. The dirty tag may already have been cleared above, so we use the
    // base "dirty swing" RNG pool instead of a flag.
    if (att?.id === 'nixon' && PERSONALITIES.nixon?.oncePerRound
        && !att.usedThisRound
        && baseDmg > 0) {
      att.usedThisRound = true;
      const cfg = PERSONALITIES.nixon.oncePerRound;
      if (this.rng.random() < cfg.procChance) {
        this._scheduleNixonBlind(defender);
      }
    }

    // ── LBJ "The Johnson Treatment" — armed on swing commit (see _enterAttack)
    // The swing tag we set there is consumed below in the baseDmg block; here
    // we just clean up the timer if it has expired.
    if (att?.lbjMissKBUntil && now >= att.lbjMissKBUntil) att.lbjMissKBUntil = 0;

    // ── LBJ "All the Way with LBJ": on first landed hit per round, arm 3
    // swings with +20% dmg.
    if (att?.id === 'lbj' && PERSONALITIES.lbj?.oncePerRound
        && !att.usedThisRound && baseDmg > 0) {
      att.usedThisRound = true;
      const cfg = PERSONALITIES.lbj.oncePerRound;
      att.lbjPumpSwingsLeft = cfg.pumpSwingCount || 3;
    }
    if (att?.id === 'lbj' && att.lbjPumpSwingsLeft > 0 && baseDmg > 0) {
      att.lbjPumpSwingsLeft -= 1;
      personalityDmgMul *= PERSONALITIES.lbj.oncePerRound.pumpAtkMul || 1.20;
    }

    // ── JFK "Camelot Glint": every Nth landed swing gets a 1.4× mul.
    if (att?.id === 'jfk' && PERSONALITIES.jfk?.everyNthHit && baseDmg > 0) {
      att.jfkDashboardCount = (att.jfkDashboardCount || 0) + 1;
      if (att.jfkDashboardCount
          >= (PERSONALITIES.jfk.everyNthHit.n || 4)) {
        att.jfkDashboardCount = 0;
        personalityDmgMul *= PERSONALITIES.jfk.everyNthHit.mul || 1.4;
      }
    }
    // JFK "Profiles in Courage" next-swing bonus cleared on first hit.
    if (att?.id === 'jfk' && att.jfkNextSwingAtkMul > 1.0 && baseDmg > 0) {
      personalityDmgMul *= att.jfkNextSwingAtkMul;
      att.jfkNextSwingAtkMul = 1.0;
    }
    // Eisenhower next-swing bonus cleared on first hit.
    if (att?.id === 'eisenhower' && att.eisenhowerNextSwingAtkMul > 1.0
        && baseDmg > 0) {
      personalityDmgMul *= att.eisenhowerNextSwingAtkMul;
      att.eisenhowerNextSwingAtkMul = 1.0;
    }

    // ── Truman "Buck Stops Here" accumulator — applied to the ATTACKER
    // when he lands (each swing longer-sustains the bonus), OR to him when
    // he's hit and racks it. Simplest realization: the swing-time dmg scales
    // with the stack count.
    if (att?.id === 'truman' && PERSONALITIES.truman?.stacksOnHit
        && baseDmg > 0) {
      const cfg = PERSONALITIES.truman.stacksOnHit;
      const stacks = att.trumanBuckStacks || 0;
      const incMul = 1 + stacks * (cfg.dmgPerStack || 0.02);
      personalityDmgMul *= incMul;
    }
    // Award Truman a stack ON DEFENSE: every successful hit taken bumps
    // his stack counter (until capped).
    if (def?.id === 'truman' && PERSONALITIES.truman?.stacksOnHit
        && baseDmg > 0) {
      def.trumanBuckStacks = Math.min(
        PERSONALITIES.truman.stacksOnHit.cap || 30,
        (def.trumanBuckStacks || 0) + 1);
    }

    // ── FDR "Four-Term Foundation" startup boost → damage mul.
    if (att?.id === 'fdr' && att.fdrStartupUntil && now < att.fdrStartupUntil
        && PERSONALITIES.fdr?.startupBoost) {
      personalityDmgMul *= PERSONALITIES.fdr.startupBoost.atkMul || 1.10;
    }
    // ── FDR "Day of Infamy" (already in activeMode 'dayOfInfamy'). ──
    if (att?.activeMode === 'dayOfInfamy'
        && PERSONALITIES.fdr?.triggerHpGated?.atkMul) {
      personalityDmgMul *= PERSONALITIES.fdr.triggerHpGated.atkMul;
    }

    return personalityDmgMul;
  }

  // Schedule Clinton's "I Feel Your Pain" elbow flurry: 2 extra damage ticks
  // over ~0.45 s. Tracks the pending follow-ups on the fighter.
  _scheduleClintonFlourish(attacker, defender, extraCount, refHit) {
    if (!attacker._clintonFlourish) attacker._clintonFlourish = [];
    // Cap pending to avoid runaway stacks.
    if (attacker._clintonFlourish.length >= 6) return;
    attacker._clintonFlourish.push({
      target: defender.playerId,
      damage: 3,                 // 3 dmg per elbow follow-up
      at: this.t + 0.18 * (attacker._clintonFlourish.length + 1),
      leashed: true,
    });
  }

  // Nixon eye-gouge: 0.3 s blind window where the player block presses drop
  // 30% of the time. Realized as a per-frame flag on the defender that's read
  // by the KeyboardController.
  _scheduleNixonBlind(target) {
    const fighter = this.fighters.find((f) => f.playerId === target);
    if (!fighter) return;
    fighter._inputBlindUntil = this.t + 0.30;
  }

  // Clinton follow-up ticks: process each one when due.
  _tickClintonFlourish(f, dt) {
    if (!f._clintonFlourish || !f._clintonFlourish.length) return;
    const now = this.t;
    const opp = this.fighters.find((o) => o !== f);
    for (let i = f._clintonFlourish.length - 1; i >= 0; i--) {
      const p = f._clintonFlourish[i];
      if (now < p.at) continue;
      // Landed: apply minor damage + brief pause frame. Only applies while
      // both fighters are still upright in range.
      if (opp && opp.state !== 'ko' && f.state !== 'ko') {
        const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
        if (dist < 2.5) this.combat.damage({ playerId: p.target, amount: p.damage, sourceId: f.playerId });
      }
      f._clintonFlourish.splice(i, 1);
    }
  }
}

export const PersonalityEffects = PersonalityEffectsMethods.prototype;
