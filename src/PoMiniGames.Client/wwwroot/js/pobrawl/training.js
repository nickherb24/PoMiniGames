// training.js — the training room (2026-09-23).
//
// 1-player only: the page's 🥋 Training button re-inits the engine with
// options.training. BOB (you) against a dummy wearing the current rung's
// president — same body, same size, same reach as the fight you are about to
// take — with no clock, no KO and no ladder consequence. (Demo used to swap 30%
// of its matches for a CPU drill; removed 2026-09-29 by user call — demo only fights.)
//
// Nothing here changes combat. The room only (a) swaps who drives fighter 2,
// (b) refuses the KO and tops health back up once a combo is over, (c) draws the
// capsules the hit test is actually using, and (d) prints what just happened in
// the numbers the player cannot otherwise see — the perfect-guard window above
// all, which nothing on the normal HUD counts.

import * as THREE from 'three';
import { FIGHTER_CAPSULES, ATTACK_CAPSULES, sampleCapsule } from './hitboxes.js';
import { AiController } from './ai.js';
import { ATTACKS, MAX_HP } from './constants.js';

/** Dummy behaviours, in the order the page's segmented control lists them. */
export const DUMMY_MODES = Object.freeze(['stand', 'guard', 'punisher', 'cpu']);

/** Health comes back this long after the last hit on a fighter: "the combo is over". */
const REFILL_AFTER_SECS = 1.0;

// Guard window mirrored from hitResolution.js PERFECT_GUARD_WINDOW, for the
// readout's "≤ 220 ms" hint only. The engine's copy decides the actual verdict and
// hands it to _onTrainingBlock, so this can never mis-score a guard — at worst the
// hint text goes stale if the window is retuned.
const PERFECT_WINDOW_MS = 220;

const DUMMY_LABELS = { stand: 'STAND', guard: 'GUARD', punisher: 'PUNISHER', cpu: 'SPAR' };

const IDLE_INTENT = Object.freeze({
  move: 0, side: 0, punch: false, kick: false,
  punchHeld: false, kickHeld: false, block: false, super: false,
});

/**
 * Drives the training dummy. Same intent contract as KeyboardController / ai.js.
 *   stand    — does nothing. Free hits, to learn ranges and the hitboxes.
 *   guard    — holds guard permanently. What beats a turtle (the kick) and what
 *              a blocked swing costs you.
 *   punisher — guards on your wind-up and answers every swing it stops, or every
 *              one you whiff, with a jab. Teaches you not to swing into a guard.
 * ('cpu' is not this class — the room hands that slot a real AiController.)
 */
export class DummyController {
  isHuman = false;

  constructor(mode = 'stand') {
    this.mode = mode;
  }

  update(ctx) {
    if (this.mode === 'guard') return { ...IDLE_INTENT, block: true };
    if (this.mode === 'punisher') {
      const close = ctx.distance < 1.9;
      if (ctx.opponentWindup || ctx.opponentActive) return { ...IDLE_INTENT, block: close };
      // The answer: a tap jab (press edge, no hold) into the recovery of a whiffed
      // swing or the freeze a blocked one just cost the attacker.
      if (close && !ctx.selfExhausted && (ctx.opponentRecover || ctx.opponentBlockStunned)) {
        return { ...IDLE_INTENT, punch: true };
      }
    }
    return IDLE_INTENT;
  }

  dispose() {}
}

// Shared overlay geometry: one open cylinder and one sphere, scaled per capsule.
const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();

const frames = (secs) => Math.round(secs * 60);

class TrainingMethods {
  /** Build the training state object from the page's options. */
  _makeTraining(raw) {
    return {
      dummy: DUMMY_MODES.includes(raw?.dummy) ? raw.dummy : 'stand',
      // Off unless the player ticks the training bar's Hitboxes box (2026-09-23,
      // user call): the green capsule wireframe is a debugging view.
      hitboxes: raw?.hitboxes === true,
      infiniteEnergy: !!raw?.infiniteEnergy,
      lastHitOn: new Map(),   // fighter → sim time of the last hit it took
      note: { hit: '', guard: '', combo: '' },
    };
  }

  /** Controller for a fighter slot while the room is open, or null for the default. */
  _trainingController(index, charId) {
    const tr = this.training;
    if (!tr) return null;
    if (index !== 2) return null;
    if (tr.dummy === 'cpu') return new AiController(this.options.difficulty || 'medium', this.rng, charId);
    return new DummyController(tr.dummy);
  }

  _initTraining() {
    if (!this.training || this._trainHud) return;
    const hud = document.createElement('div');
    hud.className = 'pb-train';
    // No aria-live: this readout rewrites on every landed hit, which made a screen reader
    // talk over the whole session. Toggles and mode changes go through the page's shell.
    hud.innerHTML = `
      <div class="pb-train__title"></div>
      <div class="pb-train__row pb-train__hit"></div>
      <div class="pb-train__row pb-train__guard"></div>
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
    hud.querySelector('.pb-train__title').textContent =
      `TRAINING · DUMMY: ${DUMMY_LABELS[tr.dummy] || tr.dummy.toUpperCase()}`;
    hud.querySelector('.pb-train__hit').textContent = tr.note.hit || 'Land a hit to see its numbers.';
    hud.querySelector('.pb-train__guard').textContent = tr.note.guard
      || `Guard on their wind-up: within ${PERFECT_WINDOW_MS} ms of impact is PERFECT.`;
    hud.querySelector('.pb-train__combo').textContent = tr.note.combo;
  }

  /** Per sim tick while fighting: refill and infinite energy. */
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
      if (tr.infiniteEnergy) {
        f.energy = 1;
        f.gassed = false;
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
    const who = attacker.index === 1 ? '' : 'Dummy: ';
    tr.note.hit = `${who}${attack.name} ${Math.round(dmg)} dmg · ${region}`
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

  _onTrainingBlock(defender, attacker, perfect, leadSecs) {
    const tr = this.training;
    const ms = Math.max(0, Math.round(leadSecs * 1000));
    const who = defender.index === 1 ? 'Your guard' : 'Dummy guard';
    tr.note.guard = perfect
      ? `${who}: PERFECT — up ${ms} ms before impact`
      : `${who}: blocked — up ${ms > 5000 ? 'long' : ms + ' ms'} early (perfect ≤ ${PERFECT_WINDOW_MS} ms)`;
    this._renderTrainingHud();
  }

  _setTrainingDummy(mode) {
    const tr = this.training;
    if (!tr || !DUMMY_MODES.includes(mode) || !this.fighters) return;
    tr.dummy = mode;
    const f = this.fighters[1];
    const next = this._trainingController(2, f.charId);
    f.controller.dispose();
    f.controller = next;
    if (f.state === 'block' && mode !== 'guard') {
      f.state = 'idle';
      f.animator.setBlocking(false);
    }
    this._renderTrainingHud();
  }

  /** Page / keyboard: put both fighters back on their marks, fresh. */
  _resetTrainingPositions() {
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

  setTrainingOption(key, value) {
    const tr = this.training;
    if (!tr) return;
    if (key === 'dummy') this._setTrainingDummy(String(value));
    else if (key === 'hitboxes') tr.hitboxes = !!value;
    else if (key === 'infiniteEnergy') tr.infiniteEnergy = !!value;
    else if (key === 'reset') this._resetTrainingPositions();
  }

  // ── Hitbox overlay ─────────────────────────────────────────────────────
  // Draws the capsules hitboxes.js is testing, sampled through the same function:
  // green = hurt (where you can be hit), blue = guard (only while blocking), red =
  // the striker (only during the active frames, which is the only time it counts).
  // X-ray on purpose (depthTest off), since the capsules sit inside the meshes.
  _buildHitboxOverlay() {
    const group = new THREE.Group();
    group.renderOrder = 999;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    const sph = new THREE.SphereGeometry(1, 10, 6);
    const mat = (color) => new THREE.MeshBasicMaterial({
      color, wireframe: true, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false,
    });
    const mats = { hurt: mat(0x4ade80), guard: mat(0x60a5fa), strike: mat(0xf87171) };
    const entries = [];
    const add = (fighterIndex, kind, cap, attack) => {
      const parts = [new THREE.Mesh(cyl, mats[kind]), new THREE.Mesh(sph, mats[kind]), new THREE.Mesh(sph, mats[kind])];
      for (const p of parts) { p.renderOrder = 999; p.frustumCulled = false; group.add(p); }
      entries.push({ fighterIndex, kind, cap, attack, parts });
    };
    for (const i of [0, 1]) {
      for (const cap of Object.values(FIGHTER_CAPSULES.hurt)) add(i, 'hurt', cap);
      for (const cap of Object.values(FIGHTER_CAPSULES.guard)) add(i, 'guard', cap);
      for (const [name, set] of Object.entries(ATTACK_CAPSULES)) {
        for (const cap of Object.values(set.active)) add(i, 'strike', cap, name);
      }
    }
    this.scene.add(group);
    this._hitboxOverlay = { group, entries, cyl, sph, mats };
  }

  /** Render-rate: move the overlay onto the live rigs. */
  _updateTrainingOverlay() {
    const tr = this.training;
    const want = !!(tr && tr.hitboxes && this.fighters);
    if (want && !this._hitboxOverlay) this._buildHitboxOverlay();
    const ov = this._hitboxOverlay;
    if (!ov) return;
    ov.group.visible = want;
    if (!want) return;
    for (const e of ov.entries) {
      const f = this.fighters[e.fighterIndex];
      let show = !!f && f.state !== 'ko';
      if (show && e.kind === 'guard') show = f.state === 'block';
      if (show && e.kind === 'strike') {
        const a = f.attack;
        show = f.state === e.attack && !!a
          && f.stateT >= a.windup && f.stateT <= a.windup + a.active;
      }
      for (const p of e.parts) p.visible = show;
      if (!show || !sampleCapsule(f.rig, e.cap, _a, _b)) {
        for (const p of e.parts) p.visible = false;
        continue;
      }
      const r = e.cap.radius;
      const [c, s1, s2] = e.parts;
      _dir.subVectors(_b, _a);
      const len = _dir.length();
      c.visible = len > 1e-4;
      if (c.visible) {
        c.position.addVectors(_a, _b).multiplyScalar(0.5);
        c.quaternion.setFromUnitVectors(_up, _dir.multiplyScalar(1 / len));
        c.scale.set(r, len, r);
      }
      s1.position.copy(_a); s1.scale.setScalar(r);
      s2.position.copy(_b); s2.scale.setScalar(r);
      s2.visible = len > 1e-4;
    }
  }

  _disposeTraining() {
    const ov = this._hitboxOverlay;
    if (ov) {
      this.scene?.remove(ov.group);
      ov.cyl.dispose();
      ov.sph.dispose();
      for (const m of Object.values(ov.mats)) m.dispose();
      this._hitboxOverlay = null;
    }
    if (this._trainHud) { this._trainHud.remove(); this._trainHud = null; }
  }
}

export const Training = TrainingMethods.prototype;
