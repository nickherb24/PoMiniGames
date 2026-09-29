// cinematics.js — the end-of-match sequence and the cinematic camera: KO ragdoll
// hand-off, the slow-mo fall, the replay, the celebration, the result report, and
// every camera framing mode.
//
// Split out of game.js 2026-08-11 (PoBrawl audit #9). Mixed into BrawlGame's
// prototype, so every method here runs with `this` bound to the live game exactly
// as it did when these bodies sat in the class — see mixin.js for why.

import * as THREE from 'three';
import { RING_HALF } from './arena.js';
import { setExpression } from './fighters.js';
import { REGIONS } from './combat.js';

// Scratch vector for the KO camera's head tracking. Module-local.
const _koHead = new THREE.Vector3();

// The lens the landscape framing was shot for, and the widest vertical FOV a
// portrait frame may open to before the fish-eye stretch at the edges reads as a bug.
export const BASE_FOV = 55;
const PORTRAIT_FOV_MAX = 78;
// Below this aspect the camera holds the horizontal view it has AT this aspect. 1.1 was
// too tight: at the countdown the fighters stand on their wide marks and were cut in half
// at the frame edges; 1.25 keeps both whole there and still fills a phone mid-fight.
const HOLD_ASPECT = 1.25;

class CinematicsMethods {
  // Deferred KO-ragdoll construction. The KO event only queues pendingKO;
  // here — safely outside world.step — we swap the fighter's live-fight
  // bodies for the jointed rigid-body skeleton and launch it.
  _buildPendingKO() {
    for (const f of this.fighters) {
      if (!f.pendingKO || f.state !== 'ko') continue;
      this._destroySwingPhysics(f);
      this._removeFighterPhysics(f);
      // Shape the launch from the killing blow: high head punches loft the
      // body with a backward whip (uppercut), leg hits sweep it into a
      // forward flip, body kicks drive it flat and fast. The lateral spin
      // of the final hit's torque carries into the tumble.
      const ko = f.pendingKO;
      const knockDir = ko.knockDir.clone();
      let velocity = ko.velocity;
      let launch = { upMul: 1, flip: 1.2, spin: THREE.MathUtils.clamp((ko.spin || 0) * 0.8, -4, 4) };
      // Punch KOs: sometimes the victim doesn't fly at all. ~22% crumple
      // straight down where they stand (lights out, legs give way); ~23%
      // slump FORWARD onto the opponent — the reversed knock direction
      // drops the body against the winner's root collider, so it visibly
      // leans on him and slides down.
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
      // Rigid-body KO: cannon owns the pose; mirror it onto the rig.
      if (f.koRagdoll && f.koRagdoll.active) {
        f.koRagdoll.drive();
        continue;
      }
      // Fallback (no ragdoll): rigid root tilt. Kept as a safety net.
      const root = f.rig.root;
      root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, -1.35, Math.min(1, dt * 5));
      root.position.y = THREE.MathUtils.lerp(root.position.y, 0.15, Math.min(1, dt * 5));
    }
  }

  _tickReplay(dt) {
    if (this.cameraMode === 'replay') {
      this.replayT += dt;
      const frames = this.replay.snapshot(60);
      if (frames.length > 0) {
        const idx = Math.min(frames.length - 1, Math.floor((this.replayT / 3.0) * frames.length));
        const snap = frames[idx];
        if (snap) {
          for (const fSnap of snap.fighters) {
            const f = this.fighters.find((x) => x.playerId === fSnap.id);
            if (!f) continue;
            f.rig.root.position.set(fSnap.x, fSnap.y, fSnap.z);
            f.rig.root.rotation.y = fSnap.ry;
            f.rig.root.rotation.x = fSnap.rx;
          }
        }
      }
      if (this.replayT >= 3.2) {
        this.cameraMode = 'ko';
        this.cameraModeT = 0;
      }
    }
  }

  _endMatch(winner, bannerText) {
    this.winner = winner;
    this.phase = 'result';
    this.phaseT = 0;
    // Time-out victory: the winner grins for the result frame.
    const wf = winner ? this.fighters[winner - 1] : null;
    if (wf) { setExpression(wf.rig, 'grin'); wf.expressionT = 0; }
    // Sometimes the decision winner celebrates too.
    this._startCelebration(wf && this.rng.random() < 0.55 ? wf : null);
    this._setBanner(bannerText);
    this._reportResult();
  }

  // ── Victory celebration ───────────────────────────────────────────────
  // Sometimes (~55% of wins) the victor bounces on the spot under the
  // result banner — parabolic hops on the rig root, plus a replay of the
  // personality entrance gesture for flavor. The loser's ragdoll and the
  // frozen camera are untouched. Cleared in _startCountdown.
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
    // Ballistic hop arc: period 0.55 s, peak 0.38 m — 4·h·t·(1−t) is the
    // real gravity parabola, so the jumps read as jumps, not a sine bob.
    const HOP_PERIOD = 0.55, HOP_HEIGHT = 0.38;
    const ph = (this.celebrationT % HOP_PERIOD) / HOP_PERIOD;
    f.rig.root.position.y = 4 * HOP_HEIGHT * ph * (1 - ph);
  }

  _reportResult() {
    const name = this.winner === 0
      ? 'DRAW'
      : `${this.fighters[this.winner - 1].rig.config.name.toUpperCase()} WINS!`;
    this._setBanner(name);
    // Per user request: on KO we freeze the camera in 'normal' mode. No
    // replay scrub, no cinematic KO zoom — the fight frame stays exactly
    // where it landed so the player can read the result without their view
    // moving. The mid/perp framing in _updateCamera keeps the same shot.
    this.cameraMode = 'normal';
    this.cameraModeT = 0;
    if (this.dotnet) {
      // The recap rides as ONE object rather than eight more positional
      // arguments. `invokeMethodAsync` fails outright on an argument-count
      // mismatch and the call is swallowed by `.catch`, so every widening of a
      // positional interop signature is a silent-breakage risk — exactly the
      // failure documented on OnHud, where four appended super arguments froze
      // the entire HUD for months. An object grows by adding a property, which
      // a C# record simply ignores if it doesn't know it yet.
      //
      // Blazor's interop serializer is camelCase (JsonSerializerDefaults.Web),
      // so these names bind to PascalCase properties on the C# side.
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
    // GFX/SOUND #9 / #10 — the Breaking News lower third and the KO clip.
    this._presentResult();
  }

  // ── presentation ────────────────────────────────────────────────────────

  // Portrait-aware framing (2026-09-29 UI review #1). The camera's FOV is
  // VERTICAL, so a narrow container keeps the landscape height and loses width:
  // at a phone's ~0.47 aspect the horizontal view fell to ~27° and both fighters
  // sat half outside the frame. (The earlier fix pulled the boom IN as the frame
  // narrowed, which narrows the shot further — the fighters were off-screen at
  // the countdown.) Below HOLD_ASPECT the camera now holds the horizontal view
  // it has at HOLD_ASPECT: _fitFov widens the vertical FOV up to PORTRAIT_FOV_MAX,
  // and _framingDistance pulls the boom OUT for whatever the cap could not cover.
  // Both are no-ops at HOLD_ASPECT and above (landscape keeps its tuning).
  // _framingHeightBias still drops the look point, trading backdrop void for
  // ring floor in the tall frame.
  // _snapCameraToFraming and the spring's normal branch must stay in lockstep
  // (see the note there), so both read these helpers.
  _portraitFraming() {
    const el = this.container;
    const aspect = el && el.clientHeight ? el.clientWidth / el.clientHeight : 16 / 9;
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
    const el = this.container;
    if (!el || !el.clientHeight) return 1;
    const aspect = el.clientWidth / el.clientHeight;
    if (aspect >= 1.1) return 1;
    return THREE.MathUtils.clamp(0.72 + (aspect / 1.1) * 0.28, 0.72, 1);
  }

  // Place the boom exactly where the spring camera would settle, on the +Z
  // side of the ring, with zero velocity. Used at countdown time: the old
  // reset parked the camera at a fixed (0, 2.4, 7) and let the spring haul it
  // in over the first second of the round, which is a visible lurch — and it
  // lands in the same window as the round's first-frame shader compile, so
  // the two together read as the camera stuttering as the match opens.
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

    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.dot(this.camera.position.clone().sub(mid)) < 0) perp.negate();

    // Tight action framing (~80% zoom-in vs. the original 4.5-9 range): the
    // camera rides at a bit over half the old distance so the fighters fill
    // the frame, still pulling back with separation so both stay in shot.
    // Both the distance and the look-point bias are portrait-aware — see
    // _framingDistance / _framingHeightBias above.
    let distance = this._framingDistance(sep);
    let height = 1.55 + sep * 0.06;
    let lookAt = mid.clone();
    lookAt.y += 1 * this._framingHeightBias();

    // 2026-07-26 browser audit #3: keep the camera on the audience side of
    // the ring. Without this clamp a fighter ragdolled hard past the
    // ring's edge pushed mid.z to <-3, which made perp.z flip to the
    // -Z side — the spring then settled the camera at z≈-5 with the ring
    // + fighters behind it and the dark backdrop filling the frame. Now
    // perp is forced toward +Z (the audience / camera default), so the
    // camera always looks back across the ring at the action.
    if (perp.z < 0) perp.negate();

    if (this.cameraMode === 'ko') {
      this._camVel.set(0, 0, 0); // hand off cleanly from the spring boom
      const loser = this.fighters.find((f) => f.state === 'ko') || f2;
      const lp = loser.rig.root.position;
      this.cameraModeT += dt;
      const k = 1 - Math.exp(-dt * 2.4);
      if (this.koShot === 'overhead') {
        // Overhead face shot: hover above the falling body — tracking the
        // actual head as the ragdoll drops — descending slowly so the dazed
        // expression fills the frame by the time he lands on the canvas.
        loser.rig.joints.head.getWorldPosition(_koHead);
        const target = new THREE.Vector3(
          _koHead.x + 0.55,
          Math.max(_koHead.y + 1.1, 2.5 - Math.min(0.9, this.cameraModeT * 0.45)),
          // Clamp the Z so an off-the-ring ragdoll doesn't drag the camera
          // behind the action. We keep the camera in front of the loser
          // (audience side: +Z) so the dazed face stays in frame.
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
        // 2026-07-26 browser audit #3: keep the KO cinematic camera
        // inside the ring footprint. Previously a loser ragdolled past the
        // ring edge would pull the camera outside the ring with the loser
        // hidden behind the camera, leaving the dark backdrop on screen.
        target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 0.5), RING_HALF + 0.5);
        target.z = THREE.MathUtils.clamp(target.z, -(RING_HALF + 0.5), RING_HALF + 0.5);
        this.camera.position.lerp(target, k);
        this.camera.lookAt(lp.x, 0.3, lp.z);
        this.camera.fov = this.fovBase + Math.max(0, 4 - this.cameraModeT * 1.4);
      }
      this.camera.updateProjectionMatrix();
    } else if (this.cameraMode === 'super' && this._superFighter) {
      // ── Super hero shot (GFX/SOUND #2) ──────────────────────────────
      // Low, close, and swinging around the firing fighter. The orbit is what
      // does the work: a static close-up of a rig mid-animation just reads as
      // the camera having got stuck.
      this._camVel.set(0, 0, 0);
      this.cameraModeT += dt;
      const sf = this._superFighter;
      const sp = sf.rig.root.position;
      const k2 = 1 - this._superT / this._superDur;    // 0 → 1 across the beat
      // Start on the side the fight was already framed from so the cut is a
      // move, not a jump, then arc ~50° around while pushing in from 3.1 → 1.9.
      const base = Math.atan2(this.camera.position.z - sp.z, this.camera.position.x - sp.x);
      const ang = (this._superAngle ??= base) + k2 * 0.9;
      const dist = 3.1 - 1.2 * k2;
      const target = new THREE.Vector3(
        sp.x + Math.cos(ang) * dist,
        1.05 + 0.35 * k2,
        sp.z + Math.sin(ang) * dist);
      // Same audience-side and ring-envelope clamps the other two modes use —
      // an orbit that swings behind the backdrop shows the player the inside of
      // the hall's back wall at the loudest moment of the match.
      target.z = Math.max(target.z, 0.6);
      target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      // Hard lerp rather than the spring: the spring's overshoot is tuned for
      // reacting to hits, and here the camera is being *directed*.
      this.camera.position.lerp(target, 1 - Math.exp(-dt * 9));
      this.camera.lookAt(sp.x, sp.y + 1.05, sp.z);
      // Long lens: narrowing the FOV while pushing in compresses the fighter
      // against the background — the classic "this one matters" shot.
      this.camera.fov = this.fovBase - 12 * k2;
      this.camera.updateProjectionMatrix();
    } else {
      // Spring-damper camera boom: slightly underdamped, so hard cuts and
      // hit impulses overshoot and settle like a real operator. Directional
      // hit impulses are injected straight into _camVel (_camImpulse).
      const target = mid.clone().add(perp.multiplyScalar(distance));
      target.y = height;
      // 2026-07-26 browser audit #3: clamp the spring target so the
      // camera never settles outside the ring. Even with the perp-flip
      // guard above, mid can wander to ±RING_HALF on X; the camera should
      // still stay within a viewing envelope around the ring.
      target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      const sdt = Math.min(dt, 1 / 20);
      const K = 26, C = 8.5;
      this._camVel.x += ((target.x - this.camera.position.x) * K - this._camVel.x * C) * sdt;
      this._camVel.y += ((target.y - this.camera.position.y) * K - this._camVel.y * C) * sdt;
      this._camVel.z += ((target.z - this.camera.position.z) * K - this._camVel.z * C) * sdt;
      this.camera.position.addScaledVector(this._camVel, sdt);
      // Belt-and-braces: hard-clamp the camera position too in case the
      // spring overshoots. The ring is at ±RING_HALF on X; the audience
      // stays on the +Z side.
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      this.camera.position.z = Math.max(this.camera.position.z, 0.2);
      this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    }

    // FOV punch (decays each frame). The 'super' mode is excluded from both
    // branches: it drives the FOV itself as part of the push-in, and letting a
    // punch overwrite it — or the relax branch drag it back to base — would
    // undo the long-lens compression mid-shot.
    // Calm mode (app-wide reduced motion) drops the punch and the shake outright: both move
    // the whole frame, which is exactly what a photosensitive player asked us not to do.
    if (this._calm()) { this.fovPunch = 0; this.shakeT = 0; }
    if (this.fovPunch > 0.01 && this.cameraMode !== 'super') {
      this.camera.fov = this.fovBase + this.fovPunch;
      this.camera.updateProjectionMatrix();
      this.fovPunch *= Math.max(0, 1 - dt * 9);
    } else if (this.cameraMode !== 'ko' && this.cameraMode !== 'super') {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.fovBase, Math.min(1, dt * 6));
      this.camera.updateProjectionMatrix();
    }

    // Screen shake: apply random offset in camera space.
    if (this.shakeT > 0) {
      const amp = this.shakeAmp * (this.shakeT / 0.18);
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp;
      this.shakeT = Math.max(0, this.shakeT - dt);
    }
  }
}

export const Cinematics = CinematicsMethods.prototype;
