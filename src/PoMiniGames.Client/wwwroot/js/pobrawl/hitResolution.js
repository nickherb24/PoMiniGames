// hitResolution.js — what happens between a striker touching a body and the round
// deciding what that touch meant: the clash, the hit test, the block / perfect-guard
// branch, the damage roll with every personality multiplier, the landed-hit
// reactions, dismemberment, and the KO hand-off.
//
// _tryHit is a short pipeline over named steps (_resolveBlock, _rollHitDamage,
// _landHit, _resolveCombatEvents, _heavyHitStagger). Mixed into BrawlGame's
// prototype like the other subsystems (see mixin.js), so `this` is the live game.
//
// ORDER IS LOAD-BEARING. The seeded RNG draws in this file (Obama's dodge, Nixon's
// dirty swing, the damage jitter, the blood roll, the KO shot, the celebration) must
// keep their order for a seeded match to reproduce. Reordering the steps reorders
// the draws.

import * as THREE from 'three';
import { setExpression } from './fighters.js';
import { COMBAT_EVENTS, REGIONS, regionEffect } from './combat.js';
import { PERSONALITIES } from './personalities.js';
import { testAttackHit, testAttackBlocked, testAttackClash, regionForHurtBone } from './hitboxes.js';
import { SIM_DT, MAX_HP, ATTACKS, HEAVY_HIT_DMG } from './constants.js';

// ── Dismemberment ─────────────────────────────────────────────────────────
// When the arms region reddens, an arm tears off and falls to the canvas with a
// silly blood squirt. The non-punching (LEFT) arm goes first (>= ARM_SEVER_L)
// so the fighter keeps its striking arm — with one arm you can only punch with
// that (right) arm. The right/striking arm only tears off once the left is
// already gone and damage is near-max (ARM_SEVER_R); after that the fighter has
// no arms and can only kick.
const ARM_SEVER_L = 50;
const ARM_SEVER_R = 78;

// How much harder a CHARGED "power" hit chews the struck limb vs a tap. Region
// (limb) damage is what reddens the body-diagram section and eventually tears an
// arm off; a full-charge blow adds this multiple of extra region damage on top
// of the base so a couple of power shots to one arm sever it before the KO. The
// bonus scales with charge (0 at a tap, full at max charge). Without it, region
// damage tracks HP too closely and the match ends before any limb reddens enough.
const REGION_CHARGE_BONUS = 1.8;
// A charged power blow that lands elsewhere still rattles the defender's
// guarding arms — this fraction of the hit bleeds into the arms region so a
// sustained power beating reddens and eventually tears an arm off even without
// clean arm hits (which are geometrically rare: a straight strike lands on the
// torso/head, not the arms hanging at the sides). Scales with charge; a tap
// does nothing.
const ARM_SPLASH_FRAC = 0.7;

// ── Hit-pause ceiling ────────────────────────────────────────────────────
// Hitstop freezes the entire fight sim (_tickFighting early-returns), so it is
// the one effect that can be mistaken for the game locking up. 8 frames at
// 60 Hz is 133 ms — enough to sell a heavy blow, short enough that input never
// feels dropped. Charge adds only HITSTOP_CHARGE_BONUS of the base per point of
// chargeMul rather than scaling it outright; see _hitFeedback.
const HITSTOP_MAX_FRAMES = 8;
const HITSTOP_CHARGE_BONUS = 0.35;

// Ceiling on a per-hit impact PointLight's peak intensity. These relight real
// geometry, and the pool holds 3, so an uncapped peak lets a flurry swing the
// whole arena's exposure. The one-off KO (22) and clash (12) flashes are
// deliberately exempt — they fire once, not several times a second.
const IMPACT_LIGHT_MAX = 9;

// Bonus banked by the DEFENDER when a block actually connects, multiplied by
// the attacker's chargeMul (1..CHARGE_MAX_MUL). A blocked jab pays 0.06; a
// blocked full-power haymaker pays 0.24 — over a third of the bar, taken
// straight out of the swing that was meant to end the round. Absorbing a big
// commitment is therefore the fastest refill in the game, and the attacker has
// paid their own energy for the privilege of donating it.
const BLOCK_ENERGY_REWARD = 0.06;

// How long ANY blocked swing — kicks included — freezes the attacker out of
// their own recovery. 0.5 s is roughly one attack's full cycle, so a block is unambiguously the
// defender's turn: enough for a jab plus its recovery, not enough for a free
// three-hit string. A PERFECT guard still buys more (PERFECT_GUARD_STUN) plus
// the energy, the plant and the counter window — the read is still worth more
// than the camp, which is the point of splitting the reward at all.
const BLOCK_STUN = 0.5;

// ── Perfect guard ────────────────────────────────────────────────────────
// A held guard is not a skill, so the block reward is split in two:
//
//   • an ORDINARY block (guard already up when the strike lands): absorb the
//     hit, bank BLOCK_ENERGY_REWARD × charge;
//   • a PERFECT guard — the guard went up inside PERFECT_GUARD_WINDOW of the
//     strike connecting, i.e. you reacted to the wind-up rather than camping —
//     banks several times the energy, freezes the attacker long enough for a
//     free answer, and arms a damage bonus on your next swing.
//
// The window is deliberately generous at 0.22 s. It is measured from the guard
// going up, not from the strike's active frames, so it is a reaction test, not
// a frame-perfect one: against a coil you can see coming, a player who guards
// on the tell gets it every time and a player who holds guard from three
// seconds out never does. That asymmetry is the whole mechanic — turtling
// still survives, but only reading the fight wins it.
const PERFECT_GUARD_WINDOW = 0.22;
// Multiplies BLOCK_ENERGY_REWARD. A perfectly guarded full-power haymaker hands
// back most of a bar, which is what pays for the counter the freeze opens up.
const PERFECT_GUARD_ENERGY_MUL = 3.5;
// How long the attacker is frozen out of their own recovery. Longer than the
// BLOCK_STUN an ordinary block already costs them — the point is that reading
// the swing is unambiguously worth more than standing behind the guard.
// Deliberately not much longer: blockStunT suppresses the victim's guard as
// well as their attacks, so this window is un-defendable, and anything past
// ~0.7 s stops being "your turn" and becomes a free three-hit string. It is
// sized for one counter plus whatever the hitstun off it chains into.
const PERFECT_GUARD_STUN = 0.65;
// The counter window a perfect guard arms, and what a swing inside it is worth.
// Without this the reward is purely defensive and the correct follow-up to a
// great block is still to back off; 1.5× for a second and a half makes the
// block an opening rather than a survival.
const COUNTER_WINDOW = 1.5;
const COUNTER_ATK_MUL = 1.5;

// Scratch vectors.
const _sweatPos = new THREE.Vector3();
const _leverArm = new THREE.Vector3();
const _impLocal = new THREE.Vector3();

class HitResolutionMethods {
  // Both fighters threw at once and their striking limbs met mid-air: an
  // elastic clash — both rebound by mass ratio, neither strike lands, big spark
  // flash and double hitstop. Polled once per sim tick after both fighters move.
  _checkClash() {
    if (this._clashCooldown > 0) return;
    const [fa, fb] = this.fighters;
    const inActive = (f) => f.attack && (f.state === 'punch' || f.state === 'kick')
      && f.stateT <= f.attack.windup + f.attack.active + 0.04;
    if (!inActive(fa) || !inActive(fb)) return;
    const phase = (f) => f.stateT > f.attack.windup + f.attack.active ? 'recover' : 'active';
    const mid = testAttackClash(fa.rig, fa.state, phase(fa), fb.rig, fb.state, phase(fb));
    if (!mid) return;
    this._clashCooldown = 0.35;

    // Neither strike lands out of this swing — the clash IS the resolution.
    fa.hasHit = true;
    fb.hasHit = true;

    for (const [f, o] of [[fa, fb], [fb, fa]]) {
      const away = new THREE.Vector3()
        .subVectors(f.rig.root.position, o.rig.root.position);
      away.y = 0;
      if (away.lengthSq() > 1e-6) away.normalize(); else away.set(1, 0, 0);
      // Elastic rebound scaled by the OTHER fighter's mass.
      f.knockback.add(away.multiplyScalar(2.6 * (o.rig.config.mass / f.rig.config.mass)));
      f.animator.applyReaction('shoulderR', 5, 0, -4);
      f.animator.applyReaction('elbowR', -7, 0, 0);
      f.animator.applyReaction('torso', -2, 0, 0);
    }
    this._spawnSparks(new THREE.Vector3(mid.x, mid.y - 1.0, mid.z), 0xfff2c0, 14, 1.8);
    this._flashImpactLight(mid, 12, 0xfff2c0, 0.2);
    this.hitstopT = 6 * SIM_DT;
    this.shakeT = 0.16;
    this.shakeAmp = 0.1;
    this.audio.block(mid);
    this.excited = Math.max(this.excited, 0.5);
  }

  // Route a world-space impulse direction into the struck region's reaction
  // springs. The direction is converted to the defender's root-local frame:
  // local +Z = the blow came from the front (whip backward, −rot.x), local
  // ±X = lateral (roll/turn the region away).
  _applyImpulseReactions(defender, region, rSide, impulseDir, rPow) {
    const yaw = defender.rig.root.rotation.y;
    // World → defender-local (rotate by −yaw about Y). Defender faces +Z
    // locally, so a blow arriving along its facing has local z ≈ −1.
    _impLocal.set(
      impulseDir.x * Math.cos(-yaw) - impulseDir.z * Math.sin(-yaw),
      impulseDir.y,
      impulseDir.x * Math.sin(-yaw) + impulseDir.z * Math.cos(-yaw));
    const lx = _impLocal.x, lz = _impLocal.z;
    const anim = defender.animator;
    if (region === REGIONS.HEAD) {
      anim.applyReaction('head', 5 * rPow * lz, 4 * rPow * lx, -3 * rPow * lx);
      anim.applyReaction('torso', 1.2 * rPow * lz, 0, -1 * rPow * lx);
    } else if (region === REGIONS.TORSO) {
      anim.applyReaction('torso', 2 * rPow * lz, 0, -1.5 * rPow * lx);
      anim.applyReaction('head', 1.8 * rPow * lz, 0, 0);
      anim.applyReaction('shoulderL', 0, 0, 2.5 * rPow);
      anim.applyReaction('shoulderR', 0, 0, -2.5 * rPow);
    } else if (region === REGIONS.ARMS && rSide) {
      anim.applyReaction('shoulder' + rSide, 3 * rPow * lz, 0, 5 * rPow * lx);
      anim.applyReaction('elbow' + rSide, -5 * rPow, 0, 0);
    } else if (region === REGIONS.LEGS && rSide) {
      anim.applyReaction('hip' + rSide, 3 * rPow * lz, 0, 2 * rPow * lx);
      anim.applyReaction('knee' + rSide, 5 * rPow, 0, 0); // buckle
    }
  }

  _tryHit(attacker, defender, attack) {
    // Capsule-vs-capsule polygon hit detection. We test the attacker's
    // striker capsules (punch = right arm + fist, kick = right leg + foot)
    // against the defender's full body hurt set. A hit is registered only
    // when at least one striker/hurt capsule pair intersects; the deepest
    // intersection wins for both location and region.
    // A KO'd body is invulnerable — wailing on a ragdoll would read as
    // unfair and looks broken.
    if (defender.state === 'ko') return;
    // Online the server already decided this swing (netplay.js): land its verdict instead.
    if (this.online) return this._tryHitNet(attacker, defender, attack);

    // Phase detection honors per-fighter swing timing multipliers (Eisenhower
    // "Overlord" stretches windup and compresses active). windup and active
    // boundaries scale with the fighter's swingWindupMul / swingActiveMul.
    const wMul = attacker.swingWindupMul ?? 1.0;
    const aMul = attacker.swingActiveMul ?? 1.0;
    const phase = (attacker.stateT > attack.windup * wMul + attack.active * aMul)
      ? 'recover' : 'active';
    let hit = testAttackHit(attacker.rig, attack.name, phase, defender.rig);
    // ── Obama "no-drama open" passive dodge ──────────────────────────
    // ~22% of incoming attacks simply miss against Obama — a casual lean
    // that the engine realizes as a hit-test miss returning false.
    if (hit && defender.personality?.id === 'obama'
        && PERSONALITIES.obama?.passiveDodgeChance
        && this.rng.random() < PERSONALITIES.obama.passiveDodgeChance) {
      hit = null;
    }
    if (!hit) {
      // ── LBJ "The Johnson Treatment" — opponent missed in range ─────
      // Whenever the swinging fighter MISSES in range and the OPPONENT is
      // LBJ, arm LBJ's "Treatment" knockback bonus for the next 3.5 s.
      if (defender?.personality?.id === 'lbj'
          && PERSONALITIES.lbj?.onOpponentMissCharge) {
        const lpos = defender.rig.root.position;
        const apos = attacker.rig.root.position;
        const d = Math.hypot(lpos.x - apos.x, lpos.z - apos.z);
        if (d < 2.4) {
          defender.personality.lbjMissKBUntil = this.t
            + (PERSONALITIES.lbj.onOpponentMissCharge.expiresSecs || 3.5);
        }
      }
      return;
    }

    attacker.hasHit = true;
    const dpos = defender.rig.root.position;
    const apos = attacker.rig.root.position;
    const knockDir = new THREE.Vector3(dpos.x - apos.x, 0, dpos.z - apos.z);
    if (knockDir.lengthSq() > 1e-6) knockDir.normalize(); else knockDir.set(1, 0, 0);

    // Direction the reaction springs whip and the spin torque acts along.
    // Offline it is root-to-root; netplay.js can supply its own.
    const impulseDir = knockDir.clone();

    // ── Mass-scaled knockback & visual lean ──────────────────────────
    const atkMass = attacker.rig.config.mass;
    const defMass = defender.rig.config.mass;
    const powerScale = attacker.rig.config.attackPower * (atkMass / defMass);
    const effect = regionEffect(defender.regionDmg);

    // Region classifier — driven by which hurt capsule was actually
    // touched, not a Y-band heuristic. This is the whole point of the
    // polygon hitbox: a fist on the forearm hits "arms", not "torso".
    const region = regionForHurtBone(hit.capsule);
    const regionMod = region === REGIONS.HEAD ? 1.25
                    : region === REGIONS.LEGS ? 0.85
                    : 1.0;
    const chargeMul = attacker.chargeMul || 1;

    // Everything the steps below share about this one strike. `baseDmg` is filled
    // by _rollHitDamage and `torqueY` by _landHit; the KO hand-off reads both.
    const s = {
      attacker, defender, attack, hit, phase, region, regionMod, effect,
      knockDir, impulseDir, chargeMul, atkMass, defMass, powerScale, dpos,
      baseDmg: 0, torqueY: 0,
    };

    // The pipeline. See the file header for why the order is fixed.
    if (this._resolveBlock(s)) return;
    s.baseDmg = this._rollHitDamage(s);
    if (s.baseDmg === null) return;   // iframes graze: sparks, no damage
    this._landHit(s);
    this._resolveCombatEvents(s);
    this._heavyHitStagger(s);
  }

  // The guard branch. True when the swing was stopped (ordinary or perfect guard)
  // and the strike is fully resolved; false when it goes on to the damage roll.
  _resolveBlock(s) {
    const { attacker, defender, attack, hit, phase, knockDir, chargeMul, defMass } = s;
    // A guard taking a blow is felt as a short high buzz, never the big motor.
    this._rumble(defender, 0, 0.35, 45);
    // If the defender is blocking, only the guard capsules count — the hurt
    // capsules still register the "near-miss" but the striker must explicitly
    // touch the guard surface to count as blocked.
    let blocked = defender.state === 'block' &&
                  testAttackBlocked(attacker.rig, attack.name, phase, defender.rig);
    // ── Nixon "Tricky Dick": 25% of attacks carry a dirty tag ────────
    // When dirty is set on the swing commit, ~40% of the time the block
    // simply slips — the swing connects through as if no guard were up.
    if (attacker._dirtySwing) {
      const dirtyCfg = PERSONALITIES.nixon?.onSwingP;
      if (dirtyCfg && this.rng.random() < dirtyCfg.dirtyBlockFraction) blocked = false;
      attacker._dirtySwing = false;
    }
    if (blocked) {
      // ── Block reward ──────────────────────────────────────────────
      // Holding guard already regenerates energy fastest of any state; landing
      // an actual block pays a bonus on top, scaled by how hard the swing was.
      // Absorbing a fully charged haymaker is the single best way to fill the
      // bar in the game, which is the point: it makes reading an attack and
      // eating it on the guard strictly better than trading, and it hands the
      // defender the power for the counter out of the attacker's own commitment.
      //
      // A PERFECT guard is that same absorb, paid at several times the rate,
      // when the guard went up inside PERFECT_GUARD_WINDOW of the strike
      // landing. See the constants block for why the reward is split this way:
      // holding block all round must stay survivable but must not be the best
      // play, or the block button is a toggle rather than a skill.
      const perfect = (this.t - defender.guardAt) <= PERFECT_GUARD_WINDOW;
      const reward = BLOCK_ENERGY_REWARD * chargeMul
        * (perfect ? PERFECT_GUARD_ENERGY_MUL : 1);
      defender.energy = Math.min(1, defender.energy + reward);
      this.hudDirty = true;
      // A perfect guard plants the defender: no shove at all, so a read is also
      // the only block that does not cost you your spacing.
      if (!perfect) {
        const blockDamp = 1 / defMass;
        defender.knockback.add(knockDir.clone().multiplyScalar(2.0 * blockDamp * chargeMul));
      }
      // EVERY blocked swing freezes the attacker (see BLOCK_STUN); a perfect
      // guard freezes them longer still, so the read stays the better outcome.
      attacker.blockStunT = perfect ? PERFECT_GUARD_STUN : BLOCK_STUN;
      attacker.state = 'idle';
      attacker.stateT = 0;
      attacker.attack = null;
      attacker.animator.setCharge(null, 0);
      attacker.animator.play('idle');
      if (perfect) {
        // Arm the counter. Read in the damage roll below, so the answer the
        // freeze just handed the defender also hits harder than a normal swing.
        defender.counterUntil = this.t + COUNTER_WINDOW;
        this._spawnSparks(hit.point, 0xffd257, 14, 1.8);
        this._flashImpactLight(hit.point, 6, 0xffd257, 0.16);
        this._spawnCallout(hit.point, 'PERFECT!');
        this._commentate('perfect', defender, attacker);
        if (this.audio) {
          this.audio.block(hit.point);
          this.audio.whoosh();
        }
      } else {
        this._spawnSparks(hit.point, 0x9ad0ff, 6, 1.0);
        this._flashImpactLight(hit.point, 3, 0x9ad0ff, 0.1);
        this.audio.block(hit.point);
      }
      // Visible absorb: the attacker's arm bounces off the guard; the
      // defender's guard compresses under the impact.
      attacker.animator.applyReaction('shoulderR', 4, 0, -3);
      attacker.animator.applyReaction('elbowR', -6, 0, 0);
      defender.animator.applyReaction('elbowL', -3.5, 0, 0);
      defender.animator.applyReaction('elbowR', -3.5, 0, 0);
      defender.animator.applyReaction('torso', -1.5, 0, 0);
      // Scorecard: a block is credited to the fighter who put the guard up, not
      // to the fighter whose swing it stopped.
      defender.stats.blocks += 1;
      this._hitFeedback(attack, false);
      return true;
    }
    return false;
  }

  // The damage number, with every personality multiplier folded in. Returns null
  // when the defender is inside an iframe window (the hit grazes: sparks, no
  // damage, no reaction). Side effects that must happen before the number is
  // final — super-meter fill, consumed next-swing bonuses, the counter — live here.
  _rollHitDamage(s) {
    const { attacker, defender, attack, hit, region, regionMod, effect, chargeMul, powerScale } = s;
    // Damage rolls: ±2 variance, scaled by charge, mass ratio, attack power,
    // region and the defender's existing region damage modifiers.
    let baseDmg = (attack.dmg * chargeMul + this.rng.randint(-1, 1))
      * effect.atkMul * regionMod * powerScale;

    // ── Per-hit personality modifiers ─────────────────────────────────
    // 1) The attacker may be carrying a temporary atkMul (Reagan's "Morning
    //    in America" / Bush's "Decider Mode"). Multiply baseDmg by it.
    // 2) The attacker may be in a retaliate window (Ford after being hit
    //    during his stumble). Multiply baseDmg by retaliateMul.
    // 3) The attacker may have a koStacks ramp (Trump: +5% per KO).
    // 4) Trump haymaker (1.5×), tagged on swing commit in _enterAttack.
    // 5) Eisenhower / JFK next-swing bonuses.
    // LBJ pump, JFK Glint, Truman stacks and FDR come from
    // _applyOnHitPersonalities below.
    const attPer = attacker.personality;

    // Quick dmg mul: reset on the swing commit so we accumulate fresh.
    attacker._personalityDmgMul = 1.0;
    // ── SUPER METER damage hook ──────────────────────────────────
    // Each super that boosts the NEXT swing (obama drone strike, clinton sax
    // solo, jfk profile manual, eisenhower overlord, eisenhower atoms-for-
    // peace, nixon pre-bonus, truman buck stops here) folds into the same
    // base multiplier the personality layer already manages. Multiplicative
    // stacking — a super during decider stacks with the decider atkMul.
    if (attPer && attPer.superSwingAtkMul && attPer.superSwingAtkMul > 1.0) {
      attacker._personalityDmgMul *= attPer.superSwingAtkMul;
      // Per-super one-shot supers consume their bonus here. Multi-swing
      // supers (nixon, bushsr) clear via their own counter in _enterAttack.
      const oneShot = ['droneStrike', 'saxSolo', 'profilesInCourage', 'overlord'];
      // Cheap ID-by-effect heuristic: if the personality id matches a super
      // that uses superSwingAtkMul as a one-shot, consume. Eisenhower's
      // passive Atoms-for-Peace path uses its own slot, not superSwingAtkMul.
      if (attPer && oneShot.includes(attPer.superActiveMode)) attPer.superSwingAtkMul = 1.0;
    }
    if (attPer?.activeMode && this.t < attPer.modeExpiresAt) {
      const trg = PERSONALITIES[attPer.id]?.onTriggerParams;
      if (attPer.activeMode === 'decider' && trg?.atkMul) attacker._personalityDmgMul *= trg.atkMul;
      if (attPer.activeMode === 'morningInAmerica' && trg?.atkMul) attacker._personalityDmgMul *= trg.atkMul;
    }
    if (attPer && this.t < attPer.retaliateUntil && PERSONALITIES.ford?.onStumbleHit) {
      attacker._personalityDmgMul *= PERSONALITIES.ford.onStumbleHit.retaliateDmgMul;
    }
    if (attPer && PERSONALITIES.trump?.perStackDmg && attPer.koStacks > 0) {
      attacker._personalityDmgMul *= 1 + attPer.koStacks * PERSONALITIES.trump.perStackDmg;
    }
    if (attacker._trumpHaymaker) {
      const cfg = PERSONALITIES.trump?.onSwingP;
      if (cfg) {
        attacker._personalityDmgMul *= cfg.haymakerDmgMul;
        attacker._trumpHaymaker = false;
      }
    }
    // Eisenhower next-swing bonus (cleared at hit landing).
    if (attPer?.id === 'eisenhower' && attPer.eisenhowerNextSwingAtkMul > 1.0) {
      attacker._personalityDmgMul *= attPer.eisenhowerNextSwingAtkMul;
      attPer.eisenhowerNextSwingAtkMul = 1.0;
    }
    // JFK "Profiles in Courage" next-swing bonus.
    if (attPer?.id === 'jfk' && attPer.jfkNextSwingAtkMul > 1.0) {
      attacker._personalityDmgMul *= attPer.jfkNextSwingAtkMul;
      attPer.jfkNextSwingAtkMul = 1.0;
    }

    let personalityDmgMul = attacker._personalityDmgMul;
    baseDmg *= personalityDmgMul;

    // Iframes window from Carter "Malaise Speech" — drop the hit if the
    // defender has active iframes. Achieved by skipping damage entirely.
    // Also covers JFK Profiles-in-Courage iframes, Eisenhower Atoms-for-Peace,
    // and FDR Fireside Chat.
    const defPer = defender.personality;
    if (defPer && (
      (defPer.iframesUntil && this.t < defPer.iframesUntil)
      || (defPer.jfkProfileIframesUntil && this.t < defPer.jfkProfileIframesUntil)
      || (defPer.eisenhowerIframesUntil && this.t < defPer.eisenhowerIframesUntil)
      || (defPer.fdrIframesUntil && this.t < defPer.fdrIframesUntil))) {
      // Spark + audio but no damage, no hitstun, no knockback: it's a graze.
      this._spawnSparks(hit.point, 0xfff5b0, 4, 0.7);
      this._flashImpactLight(hit.point, 4, 0xfff5b0, 0.05);
      this.audio.block(hit.point);
      attacker.hasHit = true;        // still marks "did something"
      attacker._trumpHaymaker = false; // clean up
      return null;
    }

    // Compute the on-hit personality mul BEFORE the damage roll (so the
    // rolled damage reflects LBJ pump / JFK Glint / Truman stacks / FDR day,
    // and side-effect counter increments like Truman's defense stacks fire
    // synchronously). The helper returns the residual personality dmg mul.
    const extraMul = this._applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack);
    baseDmg *= extraMul;

    // ── Perfect-guard counter ─────────────────────────────────────────
    // Cashed here, after every personality mul, so it stacks with whatever the
    // president was already carrying rather than being swallowed by it. One
    // swing only: the window is consumed on the first hit that lands inside it,
    // which is what makes a perfect guard an OPENING — throw the counter, not a
    // flurry — instead of a second and a half of free damage.
    if (attacker.counterUntil > this.t) {
      attacker.counterUntil = -99;
      baseDmg *= COUNTER_ATK_MUL;
      this._spawnCallout(hit.point, 'COUNTER!');
      this._commentate('counter', attacker, defender);
    }

    // Super meter fill on damage taken. Pure damage ratio: a hit that costs
    // 20% of HP fills ~ 1/5 of the meter — capped so a single massive hit
    // can't overflow. Reading baseDmg / MAX_HP keeps the meter stable across
    // character mass differences without per-president tuning.
    if (defender?.personality) {
      const fill = Math.min(0.5, baseDmg / MAX_HP);
      defender.personality.superMeter = Math.min(1.0,
        (defender.personality.superMeter || 0) + fill);
    }
    return baseDmg;
  }

  // The landed hit: HP, scorecard, hitstun, knockback and spin, region wear and
  // dismemberment, and every piece of feedback the contact point earns.
  _landHit(s) {
    const { attacker, defender, attack, hit, region, knockDir, impulseDir, chargeMul,
            atkMass, defMass, dpos, baseDmg } = s;
    const attPer = attacker.personality;
    // The training room never lets a hit kill (training.js): it tops the bar back up first.
    if (this.training) this._trainingCushion(defender, baseDmg);
    this.combat.damage({ playerId: defender.playerId, amount: baseDmg, sourceId: attacker.playerId });
    // Scorecard + combo run + the floating damage number. Placed here rather
    // than further down because `baseDmg` is final at this point — everything
    // below is knockback, reactions and region wear, none of which feed back
    // into the number the player is shown.
    this._registerLandedHit(attacker, defender, baseDmg, hit.point, region);
    if (this.training) this._onTrainingHit(attacker, defender, baseDmg, region, chargeMul, attack);
    // A hit interrupts a wind-up (state → hitstun below) but does not drain
    // the energy bar — only winding up or attacking moves it.
    defender.state = 'hitstun';
    defender.stateT = 0;
    defender.chargeName = null;
    defender.chargeAmt = 0;
    defender.animator.setCharge(null, 0);
    defender.animator.setBlocking(false);
    defender.animator.play('hitstun');
    // ── LBJ "The Johnson Treatment" — KB mul if armed ────────────────
    // If LBJ swung within the miss-charge window, multiply knockback 1.5×
    // and consume the window.
    const lbjKBMul = (attPer?.lbjMissKBUntil && this.t < attPer.lbjMissKBUntil)
      ? (PERSONALITIES.lbj?.onOpponentMissCharge?.kbMul || 1.5)
      : 1.0;
    defender.knockback.add(knockDir.clone().multiplyScalar(4.5 * chargeMul * (atkMass / defMass) * lbjKBMul));
    if (lbjKBMul > 1) attPer.lbjMissKBUntil = 0;
    defender.animator.applyLean(knockDir.z * 0.15, -knockDir.x * 0.15);
    // Impact frame: cartoon squash on the defender (no color flash — per user
    // request the model's materials never change on hits).
    defender.squashT = 0.14;

    // The struck region whips along the blow's direction, scaled by damage.
    const rSide = hit.capsule.endsWith('L') ? 'L' : hit.capsule.endsWith('R') ? 'R' : null;
    const rPow = Math.min(2.2, baseDmg / 8.75);
    this._applyImpulseReactions(defender, region, rSide, impulseDir, rPow);

    // Rotational knockback: torque about the vertical axis from the contact
    // point's lever arm off the center of mass — hooks to the head spin the
    // defender off-facing, straight body shots push without spin.
    _leverArm.set(hit.point.x - dpos.x, 0, hit.point.z - dpos.z);
    const torqueY = _leverArm.x * impulseDir.z - _leverArm.z * impulseDir.x;
    s.torqueY = torqueY; // the KO launch carries this spin into the ragdoll
    defender.spinVel += THREE.MathUtils.clamp(
      torqueY * 5 * chargeMul * (atkMass / defMass), -4, 4);


    // Per-region damage at the actual contact point (drives the HUD body
    // diagram and the sweat/swell wear — never the model's colors). Charged
    // "power" hits front-load limb damage far more than they drain HP, so a
    // full-charge flurry to one section reddens it on the body diagram and can
    // tear the limb off before the KO (chargeMul 1 → CHARGE_MAX_MUL).
    const limbChargeMul = 1 + REGION_CHARGE_BONUS * (chargeMul - 1);
    defender.regionDmg[region] = Math.min(100,
      defender.regionDmg[region] + Math.max(2, baseDmg) * limbChargeMul);
    // Blows that land elsewhere still rattle the defender's guarding arms: a
    // small bleed on every hit plus a heavy charge-scaled bleed on power hits,
    // so the arms redden and eventually tear off over a fight even though clean
    // arm hits are geometrically rare and the KO would otherwise land first.
    if (region !== REGIONS.ARMS) {
      const bleed = Math.max(2, baseDmg) * (0.3 + ARM_SPLASH_FRAC * (chargeMul - 1));
      defender.regionDmg.arms = Math.min(100, defender.regionDmg.arms + bleed);
    }
    this._applyDamageWear(defender);

    // Dismemberment: once the arms region reddens, an arm tears off. Left first
    // (keeps the striking arm), right only at near-max once the left is gone.
    // Never in the training room — a one-armed dummy would stop being a useful
    // dummy for the rest of the session.
    if (region === REGIONS.ARMS && !this.training) {
      const armDmg = defender.regionDmg.arms;
      if (armDmg >= ARM_SEVER_R && defender.armsLost.has('L') && !defender.armsLost.has('R')) {
        this._severArm(defender, 'R', impulseDir);
      } else if (armDmg >= ARM_SEVER_L && !defender.armsLost.has('L')) {
        this._severArm(defender, 'L', impulseDir);
      }
    }

    // Facial reaction: a grimace held briefly, then back to the resting face.
    setExpression(defender.rig, 'hurt');
    defender.expressionT = 0.7;

    // ── On-hit personality effects ─────────────────────────────────────
    this._applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack);

    if (defender.controller.notifyHit) defender.controller.notifyHit();
    // Sparks + a real light flash at the contact point, not at the defender's root.
    this._spawnSparks(hit.point, region === REGIONS.HEAD ? 0xff5530 : 0xffc857,
      Math.round(8 * chargeMul), 1.4 * chargeMul);
    // Roughly 1-in-4 face hits draw blood; charged shots more often.
    if (region === REGIONS.HEAD && this.rng.random() < 0.22 + 0.3 * (chargeMul - 1)) {
      this._spawnBlood(hit.point, impulseDir, chargeMul);
    }
    // Per-region hit-light color: head=hot red, arms=orange, torso=warm
    // white, legs=cool yellow. Lets the player read WHERE they got hit
    // by the kick-out color, not just the spark tone.
    const regionHitColors = {
      [REGIONS.HEAD]: 0xff3030,
      [REGIONS.ARMS]: 0xffb050,
      [REGIONS.TORSO]: 0xffe1a0,
      [REGIONS.LEGS]: 0xfff060,
    };
    const hitColor = regionHitColors[region] || 0xffa050;
    const flashDur = region === REGIONS.HEAD ? 0.25 : 0.18;
    // Charge adds a fraction of the base rather than multiplying it, capped at
    // IMPACT_LIGHT_MAX: these relight real geometry, so a multiplied peak makes
    // the whole arena flicker through an exchange.
    this._flashImpactLight(hit.point,
      Math.min(IMPACT_LIGHT_MAX,
        (attack.name === 'kick' ? 6 : 4) * (1 + 0.4 * (chargeMul - 1))),
      hitColor, flashDur);
    this._hitFeedback(attack, true, chargeMul);
    // A (near) fully charged connect bends the frame. chargeMul runs 1..4.
    if (chargeMul >= 3.4) this._shockwave(hit.point, 0.8);
    // Directional camera kick: the boom takes the hit's impulse and the
    // spring settles it — the camera is knocked the way the fighter is.
    // Not in calm mode (app-wide reduced motion) — it swings the whole frame.
    if (!this._calm()) {
      this._camVel.addScaledVector(impulseDir,
        (attack.name === 'kick' ? 1.5 : 0.9) * chargeMul);
      this._camVel.y += 0.35 * chargeMul;
    }
    this.audio.impact({ power: Math.min(2, baseDmg / 3), worldPos: hit.point, kind: attack.name });
    this.audio.grunt({ power: Math.min(2, baseDmg / 3), charId: defender.charId });
    this.hudDirty = true;
  }

  // Drain the combat event queue the landed hit may have filled: a PLAYER_KILLED
  // queues the ragdoll launch shaped by the killing blow, COMBAT_FINISHED starts
  // the KO presentation.
  _resolveCombatEvents(s) {
    const { attack, hit, region, knockDir, torqueY, dpos } = s;
    for (const ev of this.combat.step()) {
      if (ev.type === COMBAT_EVENTS.PLAYER_KILLED) {
        const downed = this.fighters.find((x) => x.playerId === ev.playerId);
        if (downed) {
          downed.state = 'ko';
          downed.animator.frozen = true;
          downed.animator.play(null);
          // Trump personality: KO-stack increment on the WINNER. Each stack
          // adds +5% damage on every swing for the rest of the match.
          const winner = this.fighters.find((x) => x !== downed);
          if (winner?.personality?.id === 'trump'
              && PERSONALITIES.trump?.onKoReceived === 'stack'
              && winner.personality.koStacks
                  < (PERSONALITIES.trump.maxStacks || 5)) {
            winner.personality.koStacks += 1;
          }
          // Queue the rigid-body ragdoll. Built next tick in _buildPendingKO,
          // outside world.step. Momentum carries into the launch so a KO
          // mid-dash tumbles with the motion.
          downed.pendingKO = {
            knockDir: knockDir.clone(),
            velocity: downed.vel.clone().add(downed.knockback),
            // Shape of the killing blow — _buildPendingKO turns this into
            // launch loft / flip / spin on the rigid-body ragdoll.
            region,
            attackName: attack.name,
            hitY: hit.point.y,
            spin: torqueY,
          };
        }
      } else if (ev.type === COMBAT_EVENTS.COMBAT_FINISHED) {
        this.phase = 'ko';
        this.phaseT = 0;
        this.timeScale = 0.35;
        this.cameraMode = 'ko';
        this.cameraModeT = 0;
        // Shot selection: ~40% of KOs get the overhead face close-up (the
        // dazed expression as the body drops); the rest keep the low side
        // push-in.
        this.koShot = this.rng.random() < 0.4 ? 'overhead' : 'side';
        this.winner = ev.winnerTeamId ? Number(ev.winnerTeamId) : 0;
        // ── KO presentation ──────────────────────────────────────────
        // The one moment in the match where every layer fires at once, and
        // the only place the full-strength concussion is allowed.
        const loser = this.fighters.find((f) => f !== (this.winner ? this.fighters[this.winner - 1] : null));
        if (this.audio) {
          this.audio.concussion(1.0);
          this.audio.crowdSwell(1.0);
          this.audio.announce('K O!', { rate: 0.85, pitch: 0.45, duckSec: 1.5 });
        }
        this._jumboCaption('K.O.', 2.4);
        this._speedPulse = Math.max(this._speedPulse || 0, 0.6);
        this._smear(0.5, 0.78);
        if (loser) this._ringRipple(loser.rig.root.position.x, loser.rig.root.position.z, 1.2);
        // Winner flashes the grin; the KO'd fighter keeps the dazed face
        // (expressionT stays 0 so nothing resets either one).
        const wf = this.winner ? this.fighters[this.winner - 1] : null;
        if (wf) { setExpression(wf.rig, 'grin'); wf.expressionT = 0; }
        // Sometimes the victor celebrates — decided here, but the hopping
        // starts at the 'result' transition so the slow-mo KO fall keeps its drama.
        this.pendingCelebration = (wf && this.rng.random() < 0.55) ? wf : null;
        this._setBanner('K.O.!');
        this.audio.ko();
        this._triggerFlash();
        // Keep the KO frame crisp: cancel the radial-blur streak, chromatic
        // aberration and bloom spike the killing blow's _hitFeedback would
        // otherwise leave smeared across the screen. Per-hit feedback during
        // the fight is untouched; the exposure spike + lights-down color
        // drain (uDesat) stay — those aren't blur.
        this.radialPulse = 0;
        this.caPulse = 0;
        this.bloomPulse = 0;
        this.exposurePulse = 0.35;
        // Rack onto the fallen fighter. Focus distance is measured to
        // the actual body rather than assumed, because the KO camera has two
        // shots (low side push-in and overhead) at very different ranges, and a
        // fixed distance would put the subject out of focus on one of them.
        if (this.rackFocus) {
          this.rackFocus.trigger(this.camera.position.distanceTo(dpos), 1.4, 1.2);
        }
        // The shared feel layer: this is the heaviest event the app produces.
        // Skipped in calm mode (app-wide reduced motion): it shakes the DOM chrome too.
        if (!this._calm()) window.PoImpact?.impact('heavy', 1.6);
        // Big warm flash over the fallen fighter as the house lights dim.
        this._flashImpactLight(
          new THREE.Vector3(dpos.x, dpos.y + 1.0, dpos.z), 22, 0xfff0d0, 0.4);
        this.excited = 1;
        this._spawnConfetti();
        // The comic-book panel (freeze, halftone, a word), a shockwave out of
        // the contact point and every camera at ringside.
        this._comicKO(hit.point, attack.name);
        this._shockwave(hit.point, 1.1);
        this._pressBurst(10);
        // The body reaches the mat ~0.55 s into the slow-mo fall (game.js
        // _updateMatWear: dust and a scrape); every human's pad gets the long
        // KO rumble; the clip recorder stops recycling so the lead-up to the
        // finishing blow is kept.
        this._koDust = loser ? { t: 0.55, fighter: loser } : null;
        for (const f of this.fighters) this._rumble(f, 1, 0.8, 650);
        this.clip?.freeze();

        // The KO limelight stays disarmed: with the house lights up it is
        // just a blown-out hotspot.
        this._limelightActive = 0;
      }
    }
  }

  _heavyHitStagger(s) {
    const { defender, baseDmg, knockDir, atkMass, defMass } = s;
    // ── Heavy-hit stagger ─────────────────────────────────────────────
    // Fighters stay on their feet until the killing blow: a heavy hit
    // (most kicks, clean head punches) that doesn't kill gets an amplified
    // stagger — extra knockback and a deep lean — but never a knockdown.
    if (defender.state !== 'ko' && baseDmg >= HEAVY_HIT_DMG) {
      defender.knockback.add(knockDir.clone().multiplyScalar(3.0 * (atkMass / defMass)));
      defender.animator.applyLean(knockDir.z * 0.2, -knockDir.x * 0.2);
      // A near-drop dishevels the hair for the rest of the match.
      if (defender.rig.refs) defender.rig.refs.hairPivot.rotation.y = 0.3;
      this.excited = Math.max(this.excited, 0.6);
      // The press row catches it.
      this._pressBurst(3);
      // Sweat spray whips off the rocked head.
      defender.rig.joints.head.getWorldPosition(_sweatPos);
      this._spawnSweat(_sweatPos);
      // Stagger ragdoll: the heaviest non-lethal hits throw a brief
      // whole-body flail — arms fling, elbows whip, torso pitches, the head
      // snaps — driven through the reaction-spring system so it recovers on
      // its own. Reads as a momentary loss of control without a knockdown.
      if (baseDmg >= HEAVY_HIT_DMG * 1.35) {
        this._staggerFlail(defender, knockDir);
      }
    }
  }

  // A short, recoverable "partial ragdoll": a burst of reaction-spring impulses
  // across the upper body so a rocked fighter flails before the springs settle
  // them back to guard. Cheaper and far safer than swapping the live rig to a
  // physics ragdoll mid-fight, and it reads as the same beat.
  _staggerFlail(f, knockDir) {
    const a = f.animator;
    if (!a) return;
    const s = knockDir.x >= 0 ? 1 : -1;
    const back = -knockDir.z; // pitch magnitude away from the blow
    a.applyReaction('shoulderR', 7 * back, 0, -7 * s);
    a.applyReaction('shoulderL', 7 * back, 0, 7 * s);
    a.applyReaction('elbowR', -10, 0, 0);
    a.applyReaction('elbowL', -10, 0, 0);
    a.applyReaction('torso', -5, 0, -2.5 * s);
    a.applyLean(knockDir.z * 0.34, -knockDir.x * 0.34);
    f.spinVel += 2.2 * s;        // a little uncontrolled yaw whip
    setExpression(f.rig, 'hurt');
    f.expressionT = Math.max(f.expressionT, 0.55);
  }

  // Accumulating damage wear — SHAPE AND SHINE ONLY. Per user request the
  // model's colors never change when a fighter is hit or knocked out: no
  // bruise tints, no emissive hit-flash, no cut decal. Damage is read from
  // the HUD body diagram instead. What remains here is sweat glisten
  // (roughness drops — the fighter gets shinier as the fight wears on) and
  // cheek/brow swelling, both frozen once the fighter is down/KO'd so the
  // fallen silhouette stays consistent under the result modal.
  _applyDamageWear(f) {
    if (f.state === 'ko') return;
    const total = (f.regionDmg.head + f.regionDmg.torso
      + f.regionDmg.arms + f.regionDmg.legs) / 400;
    const sweat = Math.min(1, total * 1.6);
    const skin = f.rig.materials.skinMat;
    skin.roughness = 0.55 - 0.3 * sweat;
    f.rig.materials.suitMat.roughness = 0.95 - 0.3 * sweat;
    // Wet-sheen ramp: a rising clearcoat lobe + a hotter skin sheen
    // is what actually reads as SWEAT — a lowered roughness alone just makes
    // the skin a flatter matte. The clearcoat gives the glistening second
    // specular highlight of a sweat film; sheen widens the grazing-angle
    // glow. Both ride the same sweat value the roughness drop uses.
    skin.clearcoat = 0.55 * sweat;
    skin.sheen = 0.32 + 0.25 * sweat;
    // The face has its own materials (tinted skin + painted detail
    // plate) — they glisten with the rest of the skin.
    if (f.rig.materials.faceMat) {
      const fm = f.rig.materials.faceMat;
      fm.roughness = 0.55 - 0.3 * sweat;
      fm.clearcoat = 0.55 * sweat;
      fm.sheen = 0.32 + 0.25 * sweat;
    }
    if (f.rig.materials.plateMat) f.rig.materials.plateMat.roughness = 0.6 - 0.3 * sweat;
    if (f.rig.refs) {
      const hd = Math.min(1, f.regionDmg.head / 100);
      f.rig.refs.skull.scale.set(1 + hd * 0.07, 1, 1 + hd * 0.05);
    }
  }

  _hitFeedback(attack, connected, chargeMul = 1) {
    if (!connected) {
      this.shakeT = 0.08; this.shakeAmp = 0.05;
      return;
    }
    // Hit-pause scales with attack weight and stored charge — a fully charged
    // release lands with a heavier stop, shake and lens kick. Charge adds a
    // fraction of the base, hard-capped at HITSTOP_MAX_FRAMES (see there).
    const base = attack.name === 'kick' ? 5 : 3;
    const frames = Math.min(
      HITSTOP_MAX_FRAMES,
      Math.round(base * (1 + HITSTOP_CHARGE_BONUS * (chargeMul - 1)))
    );
    this.hitstopT = frames * SIM_DT;
    // Random jitter stays small — the directional spring impulse (in
    // _landHit) carries most of the camera reaction.
    this.shakeT = 0.14;
    this.shakeAmp = (attack.name === 'kick' ? 0.09 : 0.06) * chargeMul;
    this.fovPunch = (attack.name === 'kick' ? 5.0 : 3.0) * chargeMul;
    // No full-frame post-FX pulses per hit: several hits a second overlap
    // into a continuous flicker.
  }
}

export const HitResolution = HitResolutionMethods.prototype;
