// cinematics.js — the end-of-match sequence and the cinematic camera: KO ragdoll
// hand-off, the slow-mo fall, the celebration, the result report, and
// every camera framing mode. Mixed into BrawlGame's prototype (`this` is the live
// game) — see mixin.js.

import * as THREE from 'three';
import { RING_HALF } from './arena.js';
import { setExpression } from './fighters.js';
import { REGIONS } from './combat.js';

const _koHead = new THREE.Vector3();

// The lens the landscape framing was shot for, and the widest vertical FOV a
// portrait frame may open to before the fish-eye stretch at the edges reads as a bug.
export const BASE_FOV = 55;
const PORTRAIT_FOV_MAX = 78;
// Below this aspect the camera holds the horizontal view it has AT this aspect; 1.25
// keeps both fighters whole on their countdown marks and still fills a phone mid-fight.
const HOLD_ASPECT = 1.25;
// Camera-mode priority. Escalating to a higher priority (normal→super→ko) is
// always allowed; stepping DOWN waits CAMERA_MIN_DWELL so a fast super→normal→super
// loop can't strobe the camera every other frame. The super branch in
// _updateCamera also gates on `_superFighter`, which is cleared when the beat
// finishes, so a delayed step-down still shows the normal view (the camera just
// keeps reporting mode='super' until the dwell elapses).
const CAMERA_PRIORITY = { normal: 0, super: 1, ko: 2 };
const CAMERA_MIN_DWELL = 1.2;

class CinematicsMethods {
  // Single chokepoint for cameraMode writes. Escalations (priority up) and
  // equal-priority re-sets always land; de-escalations (priority down) are
  // deferred by CAMERA_MIN_DWELL so a busy fight can't ping-pong the camera
  // between normal and the cinematic modes. Pass { force: true } for paths
  // that must reset unconditionally — round start, match result, init.
  _setCameraMode(mode, opts = {}) {
    const t = this._t;
    if (opts.force || t === undefined) {
      this.cameraMode = mode;
      this.cameraModeT = 0;
      this._camModeSwitchAt = t || 0;
      return;
    }
    const cur = CAMERA_PRIORITY[this.cameraMode] ?? 0;
    const next = CAMERA_PRIORITY[mode] ?? 0;
    if (next >= cur || t - (this._camModeSwitchAt ?? 0) >= CAMERA_MIN_DWELL) {
      this.cameraMode = mode;
      this.cameraModeT = 0;
      this._camModeSwitchAt = t;
    }
  }

  // Deferred KO ragdoll: the KO event only queues pendingKO; the body swap
  // happens here, outside world.step.
  _buildPendingKO() {
    for (const f of this.fighters) {
      if (!f.pendingKO || f.state !== 'ko') continue;
      this._removeFighterPhysics(f);
      // Shape the launch from the killing blow; the final hit's spin carries into the tumble.
      const ko = f.pendingKO;
      const knockDir = ko.knockDir.clone();
      let velocity = ko.velocity;
      let launch = { upMul: 1, flip: 1.2, spin: THREE.MathUtils.clamp((ko.spin || 0) * 0.8, -4, 4) };
      // Punch KOs: ~22% crumple in place; ~23% slump forward against the winner's collider.
      const punchRoll = ko.attackName === 'punch' ? this.rng.random() : 1;
      if (punchRoll < 0.22) {
        launch = { upMul: 0.35, flip: 0.5, spin: launch.spin * 0.4, knockMul: 0.06, velMul: 0.1 };
        velocity = { x: 0, z: 0 };
      } else if (punchRoll < 0.45) {
        knockDir.negate(); // fall INTO the attacker
        launch = { upMul: 0.45, flip: -2.2, spin: launch.spin * 0.5, knockMul: 0.35, velMul: 0.1 };
        velocity = { x: 0, z: 0 };
      } else if (ko.region === REGIONS.HEAD && ko.attackName === 'punch' && (ko.hitY ?? 0) > 1.45) {
        launch = { ...launch, upMul: 1.9, flip: -5 };          // uppercut loft + backflip
      } else if (ko.region === REGIONS.LEGS) {
        launch = { ...launch, upMul: 1.35, flip: 6.5 };        // swept — forward flip
      } else if (ko.region === REGIONS.TORSO && ko.attackName === 'kick') {
        launch = { ...launch, upMul: 0.85, flip: 2.5 };        // driven flat and fast
      }
      f.koRagdoll.activate(knockDir, {
        velocity,
        rng: this.rng,
        launch,
      });
      f.pendingKO = null;
    }
  }

  _tickKoFall(dt) {
    for (const f of this.fighters) {
      if (f.state !== 'ko') continue;
      if (f.koRagdoll && f.koRagdoll.active) {
        f.koRagdoll.drive();
        continue;
      }
      // No ragdoll: rigid root tilt.
      const root = f.rig.root;
      root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, -1.35, Math.min(1, dt * 5));
      root.position.y = THREE.MathUtils.lerp(root.position.y, 0.15, Math.min(1, dt * 5));
    }
  }

  _endMatch(winner, bannerText) {
    this.winner = winner;
    this.phase = 'result';
    this.phaseT = 0;
    const wf = winner ? this.fighters[winner - 1] : null;
    if (wf) { setExpression(wf.rig, 'grin'); wf.expressionT = 0; }
    this._startCelebration(wf && this.rng.random() < 0.55 ? wf : null);
    this._setBanner(bannerText);
    this._reportResult();
  }

  // Victory hops + entrance gesture replay. Cleared in _startCountdown.
  _startCelebration(f) {
    this.celebrant = f || null;
    this.celebrationT = 0;
    if (f && f.animator && f.entranceKey && f.state !== 'ko') {
      f.animator.play(f.entranceKey);
    }
  }

  _tickCelebration(dt) {
    const f = this.celebrant;
    if (!f || f.state === 'ko') return;
    this.celebrationT += dt;
    // 4·h·t·(1−t) is a gravity parabola, so the hops read as jumps, not a sine bob.
    const HOP_PERIOD = 0.55, HOP_HEIGHT = 0.38;
    const ph = (this.celebrationT % HOP_PERIOD) / HOP_PERIOD;
    f.rig.root.position.y = 4 * HOP_HEIGHT * ph * (1 - ph);
  }

  _reportResult() {
    const name = this.winner === 0
      ? 'DRAW'
      : `${this.fighters[this.winner - 1].rig.config.name.toUpperCase()} WINS!`;
    this._setBanner(name);
    // Result holds the normal framing so the player can read it without the view moving.
    this._setCameraMode('normal', { force: true });
    if (this.dotnet) {
      // Recap is ONE object, not more positional args: invokeMethodAsync fails silently
      // on an arity mismatch (see OnHud), while an object grows by adding properties.
      // camelCase here binds to PascalCase on the C# record.
      this.dotnet.invokeMethodAsync('OnMatchEnd', this.winner, Math.round(this.clock * 100) / 100, {
        p1Hits: this.fighters[0].stats.hits,
        p2Hits: this.fighters[1].stats.hits,
        p1Blocks: this.fighters[0].stats.blocks,
        p2Blocks: this.fighters[1].stats.blocks,
        p1BestCombo: this.fighters[0].stats.bestCombo,
        p2BestCombo: this.fighters[1].stats.bestCombo,
        p1BiggestHit: Math.round(this.fighters[0].stats.biggestHit),
        p2BiggestHit: Math.round(this.fighters[1].stats.biggestHit),
      }).catch(() => {});
    }
    // Breaking News lower third and the KO clip.
    this._presentResult();
  }

  // Portrait-aware framing. FOV is VERTICAL, so a narrow frame loses width. Below
  // HOLD_ASPECT the horizontal view is held: FOV widens up to PORTRAIT_FOV_MAX, then
  // the boom pulls out (`reach`) for the rest. No-op at HOLD_ASPECT and above.
  // _snapCameraToFraming and the spring's normal branch must both read these helpers.
  _portraitFraming() {
    const aspect = this._hostH ? this._hostW / this._hostH : 16 / 9;
    if (aspect >= HOLD_ASPECT) return { fov: BASE_FOV, reach: 1 };
    const wantHalfTan = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2)) * HOLD_ASPECT; // horizontal
    const fov = Math.min(PORTRAIT_FOV_MAX, THREE.MathUtils.radToDeg(2 * Math.atan(wantHalfTan / aspect)));
    const gotHalfTan = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect;
    return { fov, reach: wantHalfTan / gotHalfTan };
  }

  /** Container resized (or first sized): re-derive the base FOV from its aspect. */
  _fitFov() {
    this.fovBase = this._portraitFraming().fov;
    this.camera.fov = this.fovBase;
    this.camera.updateProjectionMatrix();
  }

  _framingDistance(sep) {
    return THREE.MathUtils.clamp(2.2 + sep * 0.31, 2.5, 5) * this._portraitFraming().reach;
  }

  _framingHeightBias() {
    if (!this._hostH) return 1;
    const aspect = this._hostW / this._hostH;
    if (aspect >= 1.1) return 1;
    return THREE.MathUtils.clamp(0.72 + (aspect / 1.1) * 0.28, 0.72, 1);
  }

  // Place the boom exactly where the spring would settle (+Z side, zero velocity) at
  // countdown, so the round doesn't open with a spring lurch on top of shader compile.
  _snapCameraToFraming() {
    if (!this.fighters || this.fighters.length !== 2) return;
    const p1 = this.fighters[0].rig.root.position;
    const p2 = this.fighters[1].rig.root.position;
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    const axis = p2.clone().sub(p1);
    axis.y = 0;
    const sep = Math.max(axis.length(), 0.5);
    if (axis.lengthSq() > 1e-6) axis.normalize(); else axis.set(1, 0, 0);
    // Same perpendicular the spring boom uses, forced onto the +Z side.
    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.z < 0) perp.negate();
    // Must match the framing maths in _updateCamera's normal branch.
    const distance = this._framingDistance(sep);
    this.camera.position.copy(mid).addScaledVector(perp, distance);
    this.camera.position.y = 1.55 + sep * 0.06;
    this.camera.lookAt(mid.x, mid.y + 1 * this._framingHeightBias(), mid.z);
    this._camVel.set(0, 0, 0);
    this.fovPunch = 0;
    this.shakeT = 0;
    this._fitFov();
  }

  _updateCamera(dt) {
    const [f1, f2] = this.fighters;
    const p1 = f1.rig.root.position, p2 = f2.rig.root.position;
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    const axis = p2.clone().sub(p1);
    axis.y = 0;
    const sep = Math.max(axis.length(), 0.5);
    if (axis.lengthSq() > 1e-6) axis.normalize(); else axis.set(1, 0, 0);

    // Audience side (+Z) only. _snapCameraToFraming enforces the same rule and the
    // spring boom has to match it: choosing perp from camera.position each frame flips
    // sign as the camera crosses mid, sending the view through 180° on every step.
    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.z < 0) perp.negate();

    let distance = this._framingDistance(sep);
    let height = 1.55 + sep * 0.06;
    let lookAt = mid.clone();
    lookAt.y += 1 * this._framingHeightBias();

    if (this.cameraMode === 'ko') {
      this._camVel.set(0, 0, 0); // hand off cleanly from the spring boom
      const loser = this.fighters.find((f) => f.state === 'ko') || f2;
      const lp = loser.rig.root.position;
      this.cameraModeT += dt;
      const k = 1 - Math.exp(-dt * 2.4);
      if (this.koShot === 'overhead') {
        // Overhead face shot tracking the falling head, descending slowly.
        loser.rig.joints.head.getWorldPosition(_koHead);
        const target = new THREE.Vector3(
          _koHead.x + 0.55,
          Math.max(_koHead.y + 1.1, 2.5 - Math.min(0.9, this.cameraModeT * 0.45)),
          // Stay on the audience side even for an off-ring ragdoll.
          Math.max(_koHead.z + 0.4, RING_HALF + 0.6));
        this.camera.position.lerp(target, k);
        this.camera.lookAt(_koHead.x, _koHead.y, _koHead.z);
        this.camera.fov = this.fovBase - 8 + Math.max(0, 4 - this.cameraModeT * 1.4);
      } else {
        // Cinematic KO shot: low, tight on the loser, slow push-in.
        const axis2 = p1.clone().sub(p2).normalize();
        const camSide = new THREE.Vector3(-axis2.z, 0, axis2.x);
        const target = lp.clone().add(camSide.multiplyScalar(3.0));
        target.y = 1.2;
        // Keep the camera inside the ring footprint.
        target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 0.5), RING_HALF + 0.5);
        target.z = THREE.MathUtils.clamp(target.z, -(RING_HALF + 0.5), RING_HALF + 0.5);
        this.camera.position.lerp(target, k);
        this.camera.lookAt(lp.x, 0.3, lp.z);
        this.camera.fov = this.fovBase + Math.max(0, 4 - this.cameraModeT * 1.4);
      }
      this.camera.updateProjectionMatrix();
    } else if (this.cameraMode === 'super' && this._superFighter) {
      // Super hero shot: low orbit around the firing fighter (a static close-up reads as stuck).
      this._camVel.set(0, 0, 0);
      this.cameraModeT += dt;
      const sf = this._superFighter;
      const sp = sf.rig.root.position;
      const k2 = 1 - this._superT / this._superDur;    // 0 → 1 across the beat
      // Start from the current framing side, arc ~50° while pushing in 3.1 → 1.9.
      const base = Math.atan2(this.camera.position.z - sp.z, this.camera.position.x - sp.x);
      const ang = (this._superAngle ??= base) + k2 * 0.9;
      const dist = 3.1 - 1.2 * k2;
      const target = new THREE.Vector3(
        sp.x + Math.cos(ang) * dist,
        1.05 + 0.35 * k2,
        sp.z + Math.sin(ang) * dist);
      // Audience-side and ring-envelope clamps, as in the other modes.
      target.z = Math.max(target.z, 0.6);
      target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      // Hard lerp, not the spring: its overshoot is tuned for hit reactions.
      this.camera.position.lerp(target, 1 - Math.exp(-dt * 9));
      this.camera.lookAt(sp.x, sp.y + 1.05, sp.z);
      // Long lens: narrowing FOV while pushing in compresses the background.
      this.camera.fov = this.fovBase - 12 * k2;
      this.camera.updateProjectionMatrix();
    } else {
      // Slightly underdamped spring boom; hit impulses go straight into _camVel (_camImpulse).
      const target = mid.clone().add(perp.multiplyScalar(distance));
      target.y = height;
      target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      const sdt = Math.min(dt, 1 / 20);
      const K = 26, C = 8.5;
      this._camVel.x += ((target.x - this.camera.position.x) * K - this._camVel.x * C) * sdt;
      this._camVel.y += ((target.y - this.camera.position.y) * K - this._camVel.y * C) * sdt;
      this._camVel.z += ((target.z - this.camera.position.z) * K - this._camVel.z * C) * sdt;
      this.camera.position.addScaledVector(this._camVel, sdt);
      // Hard-clamp too, in case the spring overshoots.
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      this.camera.position.z = Math.max(this.camera.position.z, 0.2);
      this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    }

    // FOV punch decays per frame; 'super' drives its own FOV so skips both branches.
    // Calm mode (reduced motion) drops punch and shake outright.
    if (this._calm()) { this.fovPunch = 0; this.shakeT = 0; }
    if (this.fovPunch > 0.01 && this.cameraMode !== 'super') {
      this.camera.fov = this.fovBase + this.fovPunch;
      this.camera.updateProjectionMatrix();
      this.fovPunch *= Math.max(0, 1 - dt * 9);
    } else if (this.cameraMode !== 'ko' && this.cameraMode !== 'super') {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.fovBase, Math.min(1, dt * 6));
      this.camera.updateProjectionMatrix();
    }

    if (this.shakeT > 0) {
      const amp = this.shakeAmp * (this.shakeT / 0.18);
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp;
      this.shakeT = Math.max(0, this.shakeT - dt);
    }
  }
}

export const Cinematics = CinematicsMethods.prototype;
