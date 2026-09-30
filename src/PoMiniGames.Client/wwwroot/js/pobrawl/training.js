// training.js — the training room.
//
// 1-player only: the page's 🥋 Training button re-inits the engine with
// options.training. BOB (you) against a dummy wearing the current rung's
// president — same body, same size, same reach as the fight you are about to
// take — with no clock, no KO and no ladder consequence.
//
// Nothing here changes combat. The room only (a) hands fighter 2 to a dummy that
// stands still, (b) refuses the KO and tops health back up once a combo is over,
// and (c) prints what just happened in the numbers the player cannot otherwise see.

import { ATTACKS, MAX_HP } from './constants.js';

/** Health comes back this long after the last hit on a fighter: "the combo is over". */
const REFILL_AFTER_SECS = 1.0;

const IDLE_INTENT = Object.freeze({
  move: 0, side: 0, punch: false, kick: false,
  punchHeld: false, kickHeld: false, block: false, super: false,
});

/**
 * The dummy: does nothing. Free hits, to learn ranges. Same intent contract as ai.js.
 * A fresh instance per spawn, not a shared object: personalityEffects.js writes
 * `__freezeUntil` onto whatever controller a fighter has.
 */
class DummyController {
  isHuman = false;
  update() { return IDLE_INTENT; }
  dispose() {}
}

const frames = (secs) => Math.round(secs * 60);

class TrainingMethods {
  _makeTraining() {
    return {
      lastHitOn: new Map(),   // fighter → sim time of the last hit it took
      note: { hit: '', combo: '' },
    };
  }

  /** Controller for a fighter slot while the room is open, or null for the default. */
  _trainingController(index) {
    return this.training && index === 2 ? new DummyController() : null;
  }

  _initTraining() {
    if (!this.training || this._trainHud) return;
    const hud = document.createElement('div');
    hud.className = 'pb-train';
    // No aria-live: this readout rewrites on every landed hit.
    hud.innerHTML = `
      <div class="pb-train__title">TRAINING</div>
      <div class="pb-train__row pb-train__hit"></div>
      <div class="pb-train__row pb-train__combo"></div>
      <div class="pb-train__frames"></div>`;
    this.container.appendChild(hud);
    this._trainHud = hud;
    const P = ATTACKS.punch, K = ATTACKS.kick;
    hud.querySelector('.pb-train__frames').textContent =
      `Frames (startup / active / recovery) · Punch ${frames(P.windup)}/${frames(P.active)}/${frames(P.recover)}`
      + ` · Kick ${frames(K.windup)}/${frames(K.active)}/${frames(K.recover)}`;
    this._renderTrainingHud();
  }

  _renderTrainingHud() {
    const tr = this.training;
    const hud = this._trainHud;
    if (!hud) return;
    hud.hidden = !tr;
    if (!tr) return;
    hud.querySelector('.pb-train__hit').textContent = tr.note.hit || 'Land a hit to see its numbers.';
    hud.querySelector('.pb-train__combo').textContent = tr.note.combo;
  }

  /** Per sim tick while fighting: refill once a combo is over. */
  _tickTraining() {
    const tr = this.training;
    if (!tr || !this.fighters) return;
    for (const f of this.fighters) {
      if (f.state === 'ko') continue;
      const last = tr.lastHitOn.get(f) ?? -99;
      const player = this.combat.getPlayer(f.playerId);
      if (player && this.t - last > REFILL_AFTER_SECS && player.health < MAX_HP) {
        player.health = MAX_HP;
        player.alive = true;
        f.regionDmg.head = f.regionDmg.torso = f.regionDmg.arms = f.regionDmg.legs = 0;
        this._applyDamageWear(f);
        this.hudDirty = true;
      }
    }
  }

  /** Called just before a landed hit applies its damage: the room never lets it kill. */
  _trainingCushion(defender, dmg) {
    const player = this.combat.getPlayer(defender.playerId);
    if (player && player.health - dmg <= 0) player.health = MAX_HP;
  }

  _onTrainingHit(attacker, defender, dmg, region, chargeMul, attack) {
    const tr = this.training;
    tr.lastHitOn.set(defender, this.t);
    const charge = Math.round(((chargeMul - 1) / 3) * 100);
    tr.note.hit = `${attack.name} ${Math.round(dmg)} dmg · ${region}`
      + (charge > 0 ? ` · charge ${charge}%` : ' · tap');
    const run = attacker.comboN;
    if (run >= 2) {
      tr._comboDmg = (tr._comboAttacker === attacker ? tr._comboDmg : 0) + dmg;
      tr._comboAttacker = attacker;
      tr.note.combo = `Combo ${run} hits · ${Math.round(tr._comboDmg)} damage`;
    } else {
      tr._comboDmg = dmg;
      tr._comboAttacker = attacker;
    }
    this._renderTrainingHud();
  }

  /** Page: put both fighters back on their marks, fresh. */
  resetTraining() {
    if (!this.training || !this.fighters) return;
    for (const f of this.fighters) {
      if (f.state === 'ko') continue;
      f.rig.root.position.set(f.side === 'left' ? -1.6 : 1.6, 0, 0);
      f.vel.set(0, 0, 0);
      f.knockback.set(0, 0, 0);
      f.spinVel = 0;
      f.spinYaw = 0;
      this.training.lastHitOn.set(f, -99);
    }
    this._snapCameraToFraming();
  }

  _disposeTraining() {
    if (this._trainHud) { this._trainHud.remove(); this._trainHud = null; }
  }
}

export const Training = TrainingMethods.prototype;
