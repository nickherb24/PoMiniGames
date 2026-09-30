// personalities.js — Punch-Out!!-style fighting patterns, one per president.
// Pure data; personalityEffects.js and ai.js read it.
//
// Trigger rules (HP thresholds are fractions 0..1):
//   triggerOnce      — checked once per ROUND, fires if HP threshold met
//   checkHpBelow(p)  — true while fighter HP% <= p
//   checkHpAbove(p)  — true while fighter HP% >= p
//   onSwingP         — (0..1) chance to throw a "haymaker"/"dirty"/"stumble"
//   onKoReceived     — increments a counter (per charId, e.g. koStacks for trump)
//   activeFor(t)     — effect auto-clears after t seconds
//   onSuper          — signature move. Fires once the comeback meter (filled by
//                      TAKING damage) reaches 1.0: instantly for a human, when
//                      its rung-paced gate opens for the AI. See `_fireSuper`.
//
// ── footwork: the neutral-game dance ───────────────────────────────────────
// A looping cycle of beats, replayed on the engine clock forever:
//   [{ secs, move, side }, …]
//     secs — how long this beat is held
//     move — +1 close, 0 hold, −1 give ground   (toward/away from the opponent)
//     side — −1 / +1 orbit, omitted for none    (lateral, camera-relative)
// Rules:
//   • FIXED, never randomised, on one uninterrupted clock (ai.js `_footBeat` is
//     `this.t % cycleLength`) — a countable rhythm is one you can time a swing into.
//   • Keep the cycle in 0.9–3.0 s: shorter reads as jitter, longer never repeats.
//   • Out of range a retreat beat is clamped to a hold (ai.js `_footIntent`); the
//     orbit half still shows.
//   • Do NOT scale by rung — the read learned on rung 3 must hold on rung 12.
//
// ── aiPatterns: the scripted repertoire ────────────────────────────────────
// Shape — an ordered array of phrases, hardest last:
//   [{ everySecs, range, steps: [{ act, secs, attack?, dir? }, …] }, …]
//     everySecs — seconds between OPENINGS (opening-to-opening)
//     range     — multiple of kickRange the phrase may open from
//     act       — 'punch' | 'kick'    press edge
//                 'charge'            press and hold `attack`; the strike is
//                                     thrown when the step ends, so `secs` IS
//                                     the visible coil the player blocks on
//                 'block'             stand guarding
//                 'advance'|'retreat' walk toward / away
//                 'sidestep'          one lateral step (`dir`)
//                 'wait'              stand still
//
// ai.js `_unlockedPatterns` unlocks entries by rung: 1-3 run phrase 0, 4-9
// alternate 0 and 1, 10-15 cycle all three. So index 1 answers having learned
// index 0, and index 2 answers both. Rotation is a fixed cycle, never random.
//
// Rules:
//   • Never randomise a phrase or its order — the random weight layer beneath
//     already supplies noise.
//   • Open on a TELL (wait / retreat / sidestep / advance / guard), a `charge`
//     coil, or a deliberate bait jab — never on a plain real hit.
//   • Give every phrase an interruptible moment; landing a hit cancels it
//     (ai.js notifyHit).
//   • Keep everySecs in 4–7 s. ai.js scales it down by rung, so write the
//     LOW-rung cadence here.
//   • Echo the president's mechanic so the tell and payoff teach one lesson.
//   • Prefer a `charge` somewhere (Obama and Carter are deliberate exceptions).

export const PERSONALITIES = {
  // ── Trump — "THE WALL" → after every KO, +5% damage per stack (5 max) ──
  // Volume-spammer: ~18% of swings commit to a heavy haymaker (1.5× dmg, 1.3× kb).
  trump: {
    onSwingP: { haymakerDmgMul: 1.5, haymakerKBMul: 1.3, haymakerChance: 0.18 },
    onKoReceived: 'stack',
    stackKey: 'koStacks',
    perStackDmg: 0.05,
    maxStacks: 5,
    onStackHit: 'voiceWall',
    // SUPER: 3 s window of (1 + koStacks × 0.05) damage on every swing.
    onSuper: { mode: 'theWall', durationSecs: 3.0 },
    // FOOTWORK "the stalk": no retreat beat at all.
    footwork: [{ secs: 0.70, move: 1 }, { secs: 0.35, move: 0 }],
    // PATTERNS: every phrase ends on a coil — guard the last beat.
    aiPatterns: [
      // "the volley": two jabs, then the haymaker.
      { everySecs: 4.8, range: 1.15,
        steps: [
          { act: 'punch', secs: 0.26 },
          { act: 'punch', secs: 0.28 },
          { act: 'charge', attack: 'punch', secs: 0.75 },
        ] },
      // "the double down": a jab BETWEEN two coils.
      { everySecs: 5.4, range: 1.1,
        steps: [
          { act: 'wait', secs: 0.35 },
          { act: 'charge', attack: 'punch', secs: 0.55 },
          { act: 'punch', secs: 0.24 },
          { act: 'charge', attack: 'punch', secs: 0.60 },
        ] },
      // "the rally": walks in behind three jabs onto his longest coil.
      { everySecs: 6.2, range: 1.45,
        steps: [
          { act: 'advance', secs: 0.30 },
          { act: 'punch', secs: 0.22 },
          { act: 'punch', secs: 0.22 },
          { act: 'punch', secs: 0.22 },
          { act: 'charge', attack: 'punch', secs: 0.70 },
        ] },
    ],
  },

  // ── Biden — "The Big Guy" charge ─────────────────────────────────────
  // Periodic 1.0 s charge; if it lands the defender's moveMul is halved for 1.0 s.
  biden: {
    chargeEverySecs: 5.5,
    chargeWindupMul: 2.0,
    chargeHoldSecs: 1.0,
    onChargeHitEffect: 'slow',
    onHitEffectParams: { slowMul: 0.5, slowSecs: 1.0 },
    // SUPER: fills energy to max and arms the next punch/kick for 1.5 s.
    onSuper: { mode: 'bigGuy', lockSecs: 1.5 },
    // FOOTWORK "the shuffle": the settle matches his phrase's opening beat.
    footwork: [{ secs: 0.40, move: 1 }, { secs: 0.70, move: 0 }, { secs: 0.35, move: -1 }],
    // PATTERNS: the charge, with three different approaches.
    aiPatterns: [
      // "the wind-up": a beat of stillness, then the longest coil in the roster.
      { everySecs: 5.5, range: 1.2,
        steps: [
          { act: 'wait', secs: 0.30 },
          { act: 'charge', attack: 'kick', secs: 1.0 },
        ] },
      // "the aviator shuffle": off-angle, close, then coil.
      { everySecs: 5.0, range: 1.3,
        steps: [
          { act: 'sidestep', dir: -1, secs: 0.22 },
          { act: 'advance', secs: 0.18 },
          { act: 'charge', attack: 'punch', secs: 0.70 },
        ] },
      // "the double tap": two coils back to back, low then high.
      { everySecs: 6.2, range: 1.2,
        steps: [
          { act: 'wait', secs: 0.25 },
          { act: 'charge', attack: 'kick', secs: 0.55 },
          { act: 'charge', attack: 'punch', secs: 0.55 },
        ] },
    ],
  },

  // ── Obama — "No-Drama Open" / "Drone Strike" combo ─────────────────
  // Counter-puncher: periodic pre-planned jab→kick string; passive dodge chance.
  obama: {
    comboEverySecs: 4,
    comboIsPunchKick: true,
    passiveDodgeChance: 0.22,
    // SUPER: 1.5 s iframes + next swing 2.5× damage.
    onSuper: { mode: 'droneStrike', iframesSecs: 1.5, nextSwingAtkMul: 2.5 },
    // FOOTWORK "the perimeter": always orbits the same way.
    footwork: [{ secs: 0.60, move: 1, side: -1 }, { secs: 0.50, move: 0, side: -1 }, { secs: 0.40, move: -1, side: -1 }],
    // PATTERNS: every phrase moves before it commits.
    aiPatterns: [
      // "no drama": circle out, then punch→kick.
      { everySecs: 4.4, range: 1.2,
        steps: [
          { act: 'sidestep', dir: -1, secs: 0.24 },
          { act: 'punch', secs: 0.30 },
          { act: 'kick', secs: 0.34 },
        ] },
      // "the pivot": two steps the same way, leading with the kick.
      { everySecs: 4.8, range: 1.3,
        steps: [
          { act: 'sidestep', dir: 1, secs: 0.26 },
          { act: 'sidestep', dir: 1, secs: 0.20 },
          { act: 'kick', secs: 0.32 },
          { act: 'punch', secs: 0.26 },
        ] },
      // "the long game": retreat as chase-bait, then re-enter.
      { everySecs: 5.6, range: 1.5,
        steps: [
          { act: 'retreat', secs: 0.30 },
          { act: 'wait', secs: 0.25 },
          { act: 'advance', secs: 0.20 },
          { act: 'punch', secs: 0.24 },
          { act: 'kick', secs: 0.32 },
        ] },
    ],
  },

  // ── Bush (W.) — "Decider Mode" ─────────────────────────────────────
  // Below 40% HP: freezes 1.5 s, then +40% damage and +15% speed for the round.
  bush: {
    triggerOnce: true,
    checkHpBelow: 0.40,
    onTrigger: 'decider',
    onTriggerParams: { freezeSecs: 1.5, atkMul: 1.4, speedMul: 1.15 },
    // SUPER: the decider buff on demand, without the freeze.
    onSuper: { mode: 'deciderManual', durationSecs: 30 },
    // FOOTWORK "the two-step": in, stop dead, in, longer stop.
    footwork: [{ secs: 0.35, move: 1 }, { secs: 0.60, move: 0 }, { secs: 0.35, move: 1 }, { secs: 0.80, move: 0 }],
    // PATTERN "the decider": longest dead stop, then a fast two-hit answer —
    // the mirror of Biden (short pause, long coil).
    aiPatterns: [
      { everySecs: 5.0, range: 1.15,
        steps: [
          { act: 'wait', secs: 0.70 },
          { act: 'punch', secs: 0.26 },
          { act: 'kick', secs: 0.32 },
        ] },
      // "the resolve": the stop becomes a guard.
      { everySecs: 5.2, range: 1.15,
        steps: [
          { act: 'block', secs: 0.50 },
          { act: 'punch', secs: 0.24 },
          { act: 'punch', secs: 0.24 },
          { act: 'kick', secs: 0.30 },
        ] },
      // "the surge": short pause, close the gap, coil point-blank.
      { everySecs: 6.0, range: 1.4,
        steps: [
          { act: 'wait', secs: 0.40 },
          { act: 'advance', secs: 0.25 },
          { act: 'charge', attack: 'kick', secs: 0.70 },
        ] },
    ],
  },

  // ── Clinton — "Sax Solo" + "I Feel Your Pain" elbow flurry ─────────
  // 1.5× windup. Every landed hit chains into an elbow flurry whose count grows
  // with the opponent's recent misses.
  clinton: {
    onSwingP: { saxSoloWindupMul: 1.5 },
    onHitChain: { name: 'feelYourPain', hits: 4, growthPerOppMiss: 1, growthCap: 6 },
    // SUPER: 1.6× next swing with auto-flurry chain and doubled windup.
    onSuper: { mode: 'saxSolo', nextSwingAtkMul: 1.6, chainHits: 4, saxSoloWindupMul: 2.0 },
    // FOOTWORK "the sway": rocks both directions, barely closing.
    footwork: [{ secs: 0.45, move: 1, side: -1 }, { secs: 0.45, move: 0, side: 1 }, { secs: 0.45, move: 1, side: 1 }, { secs: 0.45, move: 0, side: -1 }],
    // PATTERN "the sax sway": sidestep both ways, then coil.
    aiPatterns: [
      { everySecs: 5.2, range: 1.2,
        steps: [
          { act: 'sidestep', dir: -1, secs: 0.22 },
          { act: 'sidestep', dir: 1, secs: 0.22 },
          { act: 'charge', attack: 'punch', secs: 0.60 },
        ] },
      // "the encore": one sway, then four strikes on a shortening beat.
      { everySecs: 5.6, range: 1.25,
        steps: [
          { act: 'sidestep', dir: 1, secs: 0.20 },
          { act: 'punch', secs: 0.26 },
          { act: 'punch', secs: 0.24 },
          { act: 'punch', secs: 0.22 },
          { act: 'kick', secs: 0.30 },
        ] },
      // "the slow jam": stop, one lazy step, long coil.
      { everySecs: 6.2, range: 1.3,
        steps: [
          { act: 'wait', secs: 0.40 },
          { act: 'sidestep', dir: -1, secs: 0.26 },
          { act: 'charge', attack: 'kick', secs: 0.80 },
        ] },
    ],
  },

  // ── Bush Sr. — "Read My Lips" + "Voodoo Economics" feints ──────────
  // Counter-fighter: additive boosts to the AI table.
  bushsr: {
    passiveAiBoost: { blockP: +0.12, punishP: +0.10, baitP: +0.30 },
    onFeintTrigger: 'counter',
    onCounterHitKBMul: 1.45,
    // SUPER: next 3 swings carry 1.4× damage.
    onSuper: { mode: 'voodoo', feintSecs: 1.2, swingCount: 3, swingAtkMul: 1.4 },
    // FOOTWORK "the measure": to the edge of range and straight back out.
    footwork: [{ secs: 0.40, move: 1 }, { secs: 0.35, move: -1 }, { secs: 0.50, move: 0 }, { secs: 0.30, move: 1 }],
    // PATTERN "read my lips": bait jab, guard, counter — do NOT swing at the opening.
    aiPatterns: [
      { everySecs: 4.6, range: 1.1,
        steps: [
          { act: 'punch', secs: 0.20 },
          { act: 'block', secs: 0.55 },
          { act: 'punch', secs: 0.30 },
        ] },
      // "the second look": guard, give a step, counter off the retreat.
      { everySecs: 5.0, range: 1.2,
        steps: [
          { act: 'block', secs: 0.40 },
          { act: 'retreat', secs: 0.24 },
          { act: 'punch', secs: 0.26 },
          { act: 'kick', secs: 0.30 },
        ] },
      // "no new taxes": two feints into guard, then the real coil.
      { everySecs: 6.4, range: 1.1,
        steps: [
          { act: 'punch', secs: 0.18 },
          { act: 'block', secs: 0.40 },
          { act: 'punch', secs: 0.18 },
          { act: 'block', secs: 0.40 },
          { act: 'charge', attack: 'punch', secs: 0.60 },
        ] },
    ],
  },

  // ── Reagan — "Morning in America" + "Tear Down This Wall" ──────────
  // Below 25% HP: +40% dmg, +20% speed for 6 s. Once per round, a 1.5 s guard
  // that reflects 30% of damage back.
  reagan: {
    triggerOnce: true,
    checkHpBelow: 0.25,
    onTrigger: 'morningInAmerica',
    onTriggerParams: { atkMul: 1.4, speedMul: 1.2, durationSecs: 6 },
    oncePerRound: {
      name: 'tearDownThisWall',
      guardSecs: 1.5,
      reflectFraction: 0.30,
      selfStaggerSecs: 0.6,
    },
    // SUPER: the Morning in America buff on demand, no HP gate.
    onSuper: { mode: 'morningInAmerica', atkMul: 1.4, speedMul: 1.2, durationSecs: 6 },
    // FOOTWORK "the plant": long stands broken by single strides.
    footwork: [{ secs: 0.90, move: 0 }, { secs: 0.50, move: 1 }, { secs: 0.50, move: 0 }, { secs: 0.30, move: 1 }],
    // PATTERN "the plant": hold guard inviting the swing, then answer it.
    aiPatterns: [
      { everySecs: 5.6, range: 1.15,
        steps: [
          { act: 'block', secs: 0.95 },
          { act: 'kick', secs: 0.34 },
        ] },
      // "the gipper": no guard — walks on and coils.
      { everySecs: 5.4, range: 1.35,
        steps: [
          { act: 'wait', secs: 0.35 },
          { act: 'advance', secs: 0.22 },
          { act: 'punch', secs: 0.24 },
          { act: 'charge', attack: 'kick', secs: 0.60 },
        ] },
      // "tear down this wall": guard, swing, guard, answer.
      { everySecs: 6.0, range: 1.15,
        steps: [
          { act: 'block', secs: 0.60 },
          { act: 'punch', secs: 0.22 },
          { act: 'block', secs: 0.50 },
          { act: 'kick', secs: 0.32 },
        ] },
    ],
  },

  // ── Carter — "Malaise Speech" + "Habitat for Humanity" ──────────────
  // Malaise Speech: first drop below 30% HP each round gives 1.5 s iframes.
  // Habitat for Humanity: each landed hit bumps a 1→4 combo ladder; resets
  // after 3 s without landing.
  carter: {
    triggerOnce: true,
    checkHpBelow: 0.30,
    onTrigger: 'malaiseSpeech',
    onTriggerParams: { iframesSecs: 1.5 },
    passive: {
      name: 'habitatForHumanity',
      comboLadderMax: 4,
      comboResetsAfterSecs: 3,
    },
    // SUPER: 1.5 s iframes + the next landed hit slows the defender.
    onSuper: { mode: 'malaiseSpeech', iframesSecs: 1.5, slowSecs: 0.5, slowMul: 0.55 },
    // FOOTWORK "the metronome": flat half-second in/out; his jab ladders ride it.
    footwork: [{ secs: 0.50, move: 1 }, { secs: 0.50, move: -1 }],
    // PATTERN "the finger wag": a tell beat, then four accelerating jabs.
    aiPatterns: [
      { everySecs: 5.0, range: 1.1,
        steps: [
          { act: 'wait', secs: 0.30 },
          { act: 'punch', secs: 0.30 },
          { act: 'punch', secs: 0.26 },
          { act: 'punch', secs: 0.22 },
          { act: 'punch', secs: 0.20 },
        ] },
      // "the habitat frame": the ladder with alternating punches and kicks.
      { everySecs: 5.6, range: 1.3,
        steps: [
          { act: 'advance', secs: 0.28 },
          { act: 'punch', secs: 0.26 },
          { act: 'kick', secs: 0.30 },
          { act: 'punch', secs: 0.24 },
          { act: 'kick', secs: 0.30 },
        ] },
      // "the peace talk": guard, pause, then the ladder.
      { everySecs: 6.0, range: 1.1,
        steps: [
          { act: 'block', secs: 0.45 },
          { act: 'wait', secs: 0.30 },
          { act: 'punch', secs: 0.22 },
          { act: 'punch', secs: 0.20 },
          { act: 'punch', secs: 0.20 },
        ] },
    ],
  },

  // ── Ford — "Ford Stumble" + "Pardoning Nixon" ──────────────────────
  // 15% of swings he trips and self-stuns 0.6 s. Hit him during the stumble and
  // he gets a 2× damage window for 1.5 s.
  ford: {
    onSwingP: { stumbleChance: 0.15, stumbleSelfStunSecs: 0.6 },
    onStumbleHit: { retaliateDmgMul: 2.0, retaliateSecs: 1.5 },
    // SUPER: 1.0 s input-blind on the opponent (60% of inputs drop).
    onSuper: { mode: 'pardonMe', blindSecs: 1.0, blindMissRate: 0.60 },
    // FOOTWORK "the lurch": overshooting stride in, drift back out.
    footwork: [{ secs: 0.75, move: 1 }, { secs: 0.20, move: 0 }, { secs: 0.55, move: -1 }, { secs: 0.25, move: 0, side: 1 }],
    // PATTERN "the lurch": barge in, wild kick from too close.
    aiPatterns: [
      { everySecs: 4.5, range: 1.35,
        steps: [
          { act: 'advance', secs: 0.40 },
          { act: 'kick', secs: 0.32 },
          { act: 'punch', secs: 0.28 },
        ] },
      // "the trip": overshoot, catch himself, two kicks from inside your reach.
      { everySecs: 4.8, range: 1.4,
        steps: [
          { act: 'advance', secs: 0.30 },
          { act: 'wait', secs: 0.22 },
          { act: 'kick', secs: 0.30 },
          { act: 'kick', secs: 0.32 },
        ] },
      // "the pardon": back off, then cross the arena into a coil.
      { everySecs: 5.8, range: 1.5,
        steps: [
          { act: 'retreat', secs: 0.30 },
          { act: 'advance', secs: 0.35 },
          { act: 'charge', attack: 'kick', secs: 0.65 },
        ] },
    ],
  },

  // ── Nixon — "Tricky Dick" + "I Am Not a Crook" ────────────────────
  // 25% of attacks are "dirty" (ignore 40% of block absorption). Once per round,
  // a landed dirty hit may eye-gouge: brief input-blind on the defender.
  nixon: {
    onSwingP: { dirtyChance: 0.25, dirtyBlockFraction: 0.40 },
    oncePerRound: {
      name: 'eyeGouge',
      procChance: 0.30,
      blindSecs: 0.30,
      blindMissRate: 0.30,
    },
    // SUPER: next 3 swings are dirty; the first blinds 0.5 s on landing.
    onSuper: { mode: 'notACrook', dirtySwings: 3, dirtyBlockFraction: 0.40, blindSecs: 0.5 },
    // FOOTWORK "the sidle": creep in sideways, break off, reset on the other side.
    footwork: [{ secs: 0.50, move: 0, side: -1 }, { secs: 0.40, move: 1, side: -1 }, { secs: 0.45, move: -1 }, { secs: 0.35, move: 0, side: 1 }],
    // PATTERN "the sneak": fake disengage, then straight back in.
    aiPatterns: [
      { everySecs: 4.7, range: 1.25,
        steps: [
          { act: 'retreat', secs: 0.42 },
          { act: 'advance', secs: 0.22 },
          { act: 'punch', secs: 0.30 },
        ] },
      // "the tapes": slip sideways, pause, three strikes.
      { everySecs: 5.2, range: 1.25,
        steps: [
          { act: 'sidestep', dir: -1, secs: 0.24 },
          { act: 'wait', secs: 0.22 },
          { act: 'punch', secs: 0.24 },
          { act: 'punch', secs: 0.22 },
          { act: 'kick', secs: 0.30 },
        ] },
      // "the cover-up": guard, break off, come back, coil.
      { everySecs: 6.0, range: 1.35,
        steps: [
          { act: 'block', secs: 0.40 },
          { act: 'retreat', secs: 0.26 },
          { act: 'advance', secs: 0.24 },
          { act: 'charge', attack: 'punch', secs: 0.60 },
        ] },
    ],
  },

  // ── LBJ — "The Johnson Treatment" + "All the Way with LBJ" ──────────
  // Treatment: an opponent miss in range gives LBJ's next swing +50% knockback
  // (one at a time, expires 3.5 s). All the Way: once per round on first hit,
  // his next 3 swings carry +20% damage.
  lbj: {
    onOpponentMissCharge: { kbMul: 1.5, expiresSecs: 3.5 },
    oncePerRound: {
      name: 'allTheWay',
      procOnFirstHit: true,
      pumpSwingCount: 3,
      pumpAtkMul: 1.20,
    },
    // SUPER: arms an 8 s miss-charge window.
    onSuper: { mode: 'treatmentManual', kbMul: 1.5, windowSecs: 8.0 },
    // FOOTWORK "the walk-down": forward pressure, no retreat beat.
    footwork: [{ secs: 0.90, move: 1 }, { secs: 0.25, move: 0 }, { secs: 0.90, move: 1 }, { secs: 0.20, move: 0, side: -1 }],
    // PATTERN "the treatment": two advances, then a heavy. Backing out beats it;
    // swinging feeds his miss-charge.
    aiPatterns: [
      { everySecs: 6.0, range: 1.6,
        steps: [
          { act: 'advance', secs: 0.35 },
          { act: 'advance', secs: 0.35 },
          { act: 'charge', attack: 'kick', secs: 0.55 },
        ] },
      // "the corner": walk-down into three fast strikes.
      { everySecs: 5.2, range: 1.5,
        steps: [
          { act: 'advance', secs: 0.30 },
          { act: 'punch', secs: 0.24 },
          { act: 'punch', secs: 0.22 },
          { act: 'kick', secs: 0.32 },
        ] },
      // "the gavel": stillness, one step, the heaviest coil on the ladder.
      { everySecs: 6.6, range: 1.6,
        steps: [
          { act: 'wait', secs: 0.40 },
          { act: 'advance', secs: 0.30 },
          { act: 'charge', attack: 'punch', secs: 0.85 },
        ] },
    ],
  },

  // ── JFK — "PT-109 Survivor" + "Profiles in Courage" + "Camelot Glint"
  // PT-109: below 50% HP, +30% speed for 4 s (6 s cooldown).
  // Profiles in Courage: 2.5 s into the round, 0.45 s iframes then +25% on the
  // next swing. Camelot Glint: every 4th landed swing deals 1.4×.
  jfk: {
    triggerOnce: true,
    triggerT: 2.5,
    onTrigger: 'profilesInCourage',
    onTriggerParams: { iframesSecs: 0.45, nextSwingAtkMul: 1.25 },
    triggerHpGated: {
      checkHpBelow: 0.50,
      modeName: 'pt109Dash',
      durationSecs: 4.0,
      cooldownSecs: 6.0,
      speedMul: 1.30,
      maxFires: Infinity,
    },
    everyNthHit: { n: 4, mul: 1.4, name: 'camelotGlint' },
    // SUPER: a larger Profiles in Courage on demand.
    onSuper: { mode: 'profilesInCourage', iframesSecs: 0.6, nextSwingAtkMul: 1.5 },
    // FOOTWORK "the dart": quickest cycle on the roster (0.9 s).
    footwork: [{ secs: 0.25, move: 1, side: -1 }, { secs: 0.22, move: 0 }, { secs: 0.25, move: 1, side: 1 }, { secs: 0.22, move: 0 }],
    // PATTERN "the dash": circle out, back in from the other angle, strike.
    aiPatterns: [
      { everySecs: 4.2, range: 1.25,
        steps: [
          { act: 'sidestep', dir: 1, secs: 0.20 },
          { act: 'advance', secs: 0.18 },
          { act: 'punch', secs: 0.24 },
          { act: 'kick', secs: 0.28 },
        ] },
      // "the new frontier": changes side mid-string.
      { everySecs: 4.6, range: 1.3,
        steps: [
          { act: 'sidestep', dir: -1, secs: 0.18 },
          { act: 'punch', secs: 0.22 },
          { act: 'sidestep', dir: 1, secs: 0.18 },
          { act: 'kick', secs: 0.28 },
        ] },
      // "the riptide": give ground, then four beats straight through into a coil.
      { everySecs: 5.6, range: 1.45,
        steps: [
          { act: 'retreat', secs: 0.24 },
          { act: 'advance', secs: 0.20 },
          { act: 'punch', secs: 0.20 },
          { act: 'punch', secs: 0.20 },
          { act: 'charge', attack: 'kick', secs: 0.50 },
        ] },
    ],
  },

  // ── Eisenhower — "Operation Overlord" + "Atoms for Peace" ─────────
  // Overlord: 1.5× windup, half-length active frames. Atoms for Peace: once per
  // round when leading by >10% HP, 1.0 s iframes.
  eisenhower: {
    onSwingP: {
      overWindupMul: 1.5,
      overActiveMul: 0.5,
    },
    passiveAiBoost: { blockP: +0.15 },
    triggerOnce: true,
    triggerHpGated: {
      checkHpAboveOpp: 0.10,
      modeName: 'atomsForPeace',
      durationSecs: 1.0,
      iframesSecs: 1.0,
      nextSwingAtkMul: 1.20,
      maxFires: 1,
    },
    // SUPER: next swing 2.2× damage + 1.0 s iframes.
    onSuper: { mode: 'overlord', nextSwingAtkMul: 2.2, iframesSecs: 1.0 },
    // FOOTWORK "the advance": slow, and every yard he takes he keeps.
    footwork: [{ secs: 1.10, move: 1 }, { secs: 0.70, move: 0 }, { secs: 0.60, move: 1 }, { secs: 0.50, move: 0 }],
    // PATTERN "Overlord": guard, then a 1.3 s coil — block it, he is left open.
    aiPatterns: [
      { everySecs: 6.5, range: 1.15,
        steps: [
          { act: 'block', secs: 0.45 },
          { act: 'charge', attack: 'punch', secs: 1.30 },
        ] },
      // "the beachhead": close first, guard, coil point-blank.
      { everySecs: 6.2, range: 1.4,
        steps: [
          { act: 'advance', secs: 0.30 },
          { act: 'block', secs: 0.35 },
          { act: 'charge', attack: 'kick', secs: 0.90 },
        ] },
      // "two fronts": coil, guard, coil.
      { everySecs: 7.0, range: 1.2,
        steps: [
          { act: 'charge', attack: 'punch', secs: 0.70 },
          { act: 'block', secs: 0.40 },
          { act: 'charge', attack: 'kick', secs: 0.70 },
        ] },
    ],
  },

  // ── Truman — "The Buck Stops Here" + "Give 'em Hell" ──────────────
  // Buck Stops Here: every hit TAKEN adds +2% to his swings (cap 30 stacks),
  // decaying 0.5 stack/s. Give 'em Hell: 50% of his KO blows add a camera pulse.
  truman: {
    stacksOnHit: {
      stacksKey: 'buckStacks',
      dmgPerStack: 0.02,
      cap: 30,
      decayPerSec: 0.5,
    },
    onKOSwing: {
      procChance: 0.50,
      extraCamPulse: 0.55,
    },
    // SUPER: next swing gets triple the stack bonus, then stacks reset.
    onSuper: { mode: 'buckStopsHere', stackMul: 3.0 },
    // FOOTWORK "the plain walk": straight in, no angle, no retreat.
    footwork: [{ secs: 1.20, move: 1 }, { secs: 0.40, move: 0 }],
    // PATTERN "the buck stops here": walk in hands down, eat hits, answer heavy.
    aiPatterns: [
      { everySecs: 5.4, range: 1.4,
        steps: [
          { act: 'advance', secs: 0.35 },
          { act: 'wait', secs: 0.45 },
          { act: 'charge', attack: 'punch', secs: 0.65 },
        ] },
      // "give them hell": opens up, coil paid for by the current stack.
      { everySecs: 5.4, range: 1.2,
        steps: [
          { act: 'wait', secs: 0.30 },
          { act: 'punch', secs: 0.24 },
          { act: 'punch', secs: 0.22 },
          { act: 'charge', attack: 'punch', secs: 0.60 },
        ] },
      // "the whistle stop": doubled walk-in, longer stand, from long range.
      { everySecs: 6.4, range: 1.6,
        steps: [
          { act: 'advance', secs: 0.30 },
          { act: 'advance', secs: 0.30 },
          { act: 'wait', secs: 0.35 },
          { act: 'charge', attack: 'kick', secs: 0.75 },
        ] },
    ],
  },

  // ── FDR — "Four-Term Foundation" + "Fireside Chat" + "Day of Infamy" ──
  // Four-Term: +10% speed and damage for the first 3 s. Fireside Chat: every
  // ~6 s a 0.4 s iframe window, then +25% reach on the next swing. Day of
  // Infamy: below 30% HP, +35% damage for 5 s.
  fdr: {
    startupBoost: { durationSecs: 3.0, speedMul: 1.10, atkMul: 1.10 },
    triggerOnce: true,
    triggerHpGated: {
      checkHpBelow: 0.30,
      modeName: 'dayOfInfamy',
      durationSecs: 5.0,
      atkMul: 1.35,
      maxFires: 1,
    },
    periodicIframes: {
      everySecs: 6.0,
      iframesSecs: 0.4,
      nextSwingReachMul: 1.25,
    },
    // SUPER: Day of Infamy on demand, 8 s, no HP gate.
    onSuper: { mode: 'dayOfInfamy', atkMul: 1.35, durationSecs: 8.0 },
    // FOOTWORK "the pivot": holds centre and turns you around it.
    footwork: [{ secs: 0.70, move: 0, side: -1 }, { secs: 0.50, move: 1 }, { secs: 0.70, move: 0, side: 1 }, { secs: 0.40, move: 1 }],
    // PATTERN "the fireside chat": the pause lines up with his iframe window;
    // the kick after carries the +25% reach.
    aiPatterns: [
      { everySecs: 6.0, range: 1.45,
        steps: [
          { act: 'block', secs: 0.30 },
          { act: 'wait', secs: 0.50 },
          { act: 'advance', secs: 0.20 },
          { act: 'kick', secs: 0.34 },
        ] },
      // "the new deal": one pause, three strikes, no approach.
      { everySecs: 5.6, range: 1.4,
        steps: [
          { act: 'wait', secs: 0.40 },
          { act: 'punch', secs: 0.24 },
          { act: 'kick', secs: 0.32 },
          { act: 'punch', secs: 0.24 },
        ] },
      // "day of infamy": short tell, one step, biggest coil.
      { everySecs: 6.8, range: 1.45,
        steps: [
          { act: 'block', secs: 0.35 },
          { act: 'advance', secs: 0.25 },
          { act: 'charge', attack: 'punch', secs: 0.90 },
        ] },
    ],
  },
};

// Per-fighter runtime counters, filled by the engine on spawn (kept off fighter.*).
export function makePersonalityState(id) {
  const p = PERSONALITIES[id];
  return {
    id,
    profile: p || null,
    koStacks: 0,           // trump +0.05 dmg per stack
    lastChargeAt: 0,       // biden charge cooldown timer (s)
    lastComboAt: 0,        // obama pre-planned combo cooldown timer (s)
    triggerFired: false,   // single-fire mid-fight mode (reagan / bush / carter)
    usedThisRound: false,  // oncePerRound flags (reagan / nixon wall + gouge)
    activeMode: null,      // current mode name
    modeExpiresAt: 0,      // wall-clock t when activeMode clears
    iframesUntil: 0,       // carter malaise: skip hitstun until this time
    stumbleUntil: 0,       // ford self-stun end
    retaliateUntil: 0,     // ford damage window end
    habitatComboN: 0,      // carter 1→2→3→4 ladder
    habitatComboT: 0,      // carter last personal-land time
    lastHitWasSax: false,  // clinton sax solo tag
    saxSinceMiss: 0,       // clinton counter count vs opp misses
    lbjMissKBUntil: 0,          // lbj "Treatment" miss-charge window
    lbjPumpSwingsLeft: 0,       // lbj "All the Way" remaining swing buffs
    jfkDashboardCount: 0,       // jfk "Camelot Glint" 4th-hit tracking
    jfkProfileIframesUntil: 0,  // jfk "Profiles in Courage" active i-frames
    jfkNextSwingAtkMul: 1.0,    // jfk post-profile next-swing bonus
    jfkDashUntil: 0,            // jfk PT-109 dash end
    jfkDashCooldownUntil: 0,    // jfk PT-109 cooldown
    eisenhowerMissHitMul: 1.0,  // eisenhower "Overlord" next-hit damage (1.0 = normal)
    eisenhowerActiveFrames: 0,  // eisenhower active-frames compression marker
    eisenhowerIframesUntil: 0,  // eisenhower "Atoms for Peace" shields
    eisenhowerNextSwingAtkMul: 1.0,
    trumanBuckStacks: 0,        // truman "Buck Stops Here" accumulator
    fdrStartupUntil: 0,         // fdr "Four-Term Foundation" active
    fdrIframesUntil: 0,         // fdr "Fireside Chat" chatting
    fdrNextSwingReachMul: 1.0,  // fdr next-swing reach bonus
    // Super meter 0..1, filled by taking damage (game.js _tickSuperMeter);
    // firing consumes it to zero.
    superMeter: 0,
    superActiveMode: null,      // mode name currently being delivered (for AI + UI)
    superFiredAt: 0,            // wall-clock t when last fired (preventing AI back-to-back spam)
    // Per-super scratch state slots — each president's on-super writes here.
    superSwingAtkMul: 1.0,      // obama drone strike, clinton sax solo, jfk profile, eisenhower overlord
    superDirtySwingsLeft: 0,    // nixon notACrook — swings remaining carrying dirty tag
    superPumpSwingsLeft: 0,     // bushsr voodoo — swings remaining with voodoo tax
    superSwingCnt: 0,           // generic swing counter for swing-counted supers (nixon/bushsr)
  };
}
