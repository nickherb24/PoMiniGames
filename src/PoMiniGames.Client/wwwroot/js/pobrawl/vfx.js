// vfx.js — the transient visual layer: impact frames and impact lights, strike
// trails, the GPU particle pool, dismemberment and blood, sweat and confetti.
//
// Mixed into BrawlGame's prototype, so `this` is the live game — see mixin.js.

import * as THREE from 'three';
import { SeveredArm } from './ragdollPhysics.js';
import { stepWorld } from './physics.js';

// Scratch objects so the trail sampler and particle spawns allocate nothing.
const _trailPos = new THREE.Vector3();
const _pColor = new THREE.Color();

class VfxMethods {
  // Effects built mid-fight (blood droplets, stains, callout words) make their
  // materials on the spot and dispose them after. three frees a shader program when
  // its last material goes, so each fight re-linked them on the first hit: a
  // 50-400 ms freeze. One hidden keeper per program holds it alive; _warmupRender
  // compiles the keepers with everything else, and the per-effect materials reuse it.
  _initShaderKeepers() {
    const geo = new THREE.PlaneGeometry(0.01, 0.01);
    const tex = new THREE.CanvasTexture(document.createElement('canvas'));
    tex.colorSpace = THREE.SRGBColorSpace;
    this._keeperTex = tex;
    this._shaderKeepers = new THREE.Group();
    this._shaderKeepers.visible = false;
    this._shaderKeepers.add(
      // _spawnBlood / _bloodSquirt droplets and the _addBloodStain decal (same program).
      new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x7e120e, transparent: true, opacity: 0.95 })),
      // spectacle.js _spawnWord.
      new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
      })),
    );
    this.scene.add(this._shaderKeepers);
  }

  _initImpactFrames() {
    // Three rings is enough for a flurry — a fourth heavy hit inside 200 ms
    // recycles the oldest, which is invisible at that rate.
    const geo = new THREE.RingGeometry(0.42, 0.5, 40);
    this._shockRings = Array.from({ length: 3 }, () => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xfff4d8, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }));
      m.visible = false;
      m.renderOrder = 4;
      this.scene.add(m);
      return { mesh: m, life: 0, dur: 0.22, power: 1 };
    });
    this._shockCursor = 0;
    // Shared geometry — the per-ring material is what differs. Held so dispose
    // can release it once rather than three times through the traverse.
    this._shockGeo = geo;
    // Driven by the KO and the super cinematic only, never per hit.
    this._speedPulse = 0; // speedline intensity, decayed in _updateFx
    this._smearT = 0;     // seconds left on the afterimage smear
    this._smearAmt = 0;   // 0..1 target damp for the afterimage pass
  }

  /**
   * @param {THREE.Vector3} point world-space contact point
   * @param {number} power 0..1 how hard the hit was
   */
  _impactFrame(point, power = 1) {
    const p = Math.max(0, Math.min(1, power));
    // Per-hit feedback must stay local: heavy hits land several times a second,
    // so any whole-frame luminance change here strobes. The shock ring is
    // anchored to the contact POINT in world space instead.
    if (!this._shockRings) return;
    const slot = this._shockRings[this._shockCursor++ % this._shockRings.length];
    slot.mesh.position.copy(point);
    // Billboarded: the ring is a flat disc and the camera orbits, so without
    // this it edge-ons into an invisible line at exactly the wrong moment.
    slot.mesh.quaternion.copy(this.camera.quaternion);
    slot.mesh.scale.setScalar(0.25);
    // Additive and pooled ×3: higher peaks overlap past the bloom threshold in a flurry.
    slot.mesh.material.opacity = 0.5;
    slot.mesh.visible = true;
    slot.power = p;
    slot.dur = 0.2 + 0.08 * p;
    slot.life = slot.dur;
  }

  /** Arm the afterimage pass for `secs` at `amount` (0..1 feedback damp). */
  _smear(secs, amount) {
    if (this._calm()) return; // afterimage smear is full-frame motion — reduced motion drops it
    this._smearT = Math.max(this._smearT || 0, secs);
    this._smearAmt = Math.max(this._smearAmt || 0, Math.min(0.92, amount));
  }

  _updateImpactFrames(dt) {
    for (const s of this._shockRings || []) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = 1 - Math.max(0, s.life) / s.dur;       // 0 → 1 over the life
      // Ease-out expansion: fast off the contact, decelerating. A linear ring
      // reads as a growing circle; this reads as a shockwave.
      const ease = 1 - Math.pow(1 - k, 3);
      s.mesh.scale.setScalar(0.25 + (2.6 + 1.8 * s.power) * ease);
      s.mesh.material.opacity = 0.5 * (1 - ease);
      if (s.life <= 0) { s.mesh.visible = false; s.mesh.material.opacity = 0; }
    }
  }

  // Flash one pooled PointLight at a world position (hit sparks, KO).
  _flashImpactLight(point, peak, color = 0xffa050, dur = 0.15) {
    if (!this._impactLights) return;
    // Calm mode (app-wide reduced motion): a third of the peak. These relight real geometry, so
    // at full strength a flurry makes the whole arena pulse.
    if (this._calm()) peak *= 0.35;
    const slot = this._impactLights[this._impactCursor++ % this._impactLights.length];
    slot.light.color.setHex(color);
    slot.light.position.set(point.x, point.y + 0.2, point.z);
    slot.peak = peak;
    slot.dur = dur;
    slot.life = dur;
    slot.light.intensity = peak;
  }

  // ── Strike trails ────────────────────────────────────────────────────
  // A vertical additive ribbon that follows the striking fist/shoe through
  // the swing arc — brightness ramps toward the head of the trail, and the
  // color goes gold on charged releases. Rebuilt from ≤10 sampled points a
  // frame; the geometry is preallocated once per fighter.
  _makeTrail() {
    const MAX = 10;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, points: [], max: MAX, color: new THREE.Color(0xcfe0ff) };
  }

  _updateTrail(f, dt) {
    const t = f.trail;
    if (!t) return;
    const attack = f.attack;
    const swinging = attack && (f.state === 'punch' || f.state === 'kick')
      && f.stateT <= attack.windup + attack.active + 0.08;
    if (swinging) {
      // fistR is unregistered when the right arm is torn off (see _severArm),
      // which can happen mid-swing — there's nothing left to trail.
      const joint = f.rig.joints[f.state === 'kick' ? 'footR' : 'fistR'];
      if (!joint) { t.points.length = 0; t.mesh.visible = false; return; }
      joint.getWorldPosition(_trailPos);
      // Per-point limb speed widens and brightens the ribbon (see below).
      const prev = t.points[t.points.length - 1];
      let spd = 0;
      if (prev) {
        const dx = _trailPos.x - prev.x, dy = _trailPos.y - prev.y, dz = _trailPos.z - prev.z;
        spd = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(dt, 1e-3);
      }
      t.points.push({ x: _trailPos.x, y: _trailPos.y, z: _trailPos.z, spd });
      if (t.points.length > t.max) t.points.shift();
    } else if (t.points.length) {
      // Swing over: the tail burns off over a few frames.
      t.points.shift();
      if (t.points.length) t.points.shift();
    }
    const n = t.points.length;
    if (n < 2) {
      t.mesh.visible = false;
      t.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    const pos = t.mesh.geometry.attributes.position.array;
    const col = t.mesh.geometry.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const p = t.points[i];
      const a = i / (n - 1);          // 0 tail → 1 head
      // Velocity smear: ~9 m/s saturates the boost.
      const boost = Math.min(1, (p.spd || 0) / 9);
      const w = (0.012 + 0.05 * a) * (1 + boost * 1.7);  // half-width grows to head
      const o = i * 6;
      pos[o] = p.x; pos[o + 1] = p.y - w; pos[o + 2] = p.z;
      pos[o + 3] = p.x; pos[o + 4] = p.y + w; pos[o + 5] = p.z;
      const br = a * a * (0.85 + 0.9 * boost);  // quadratic ramp — hot head, faint tail
      col[o] = col[o + 3] = t.color.r * br;
      col[o + 1] = col[o + 4] = t.color.g * br;
      col[o + 2] = col[o + 5] = t.color.b * br;
    }
    t.mesh.geometry.attributes.position.needsUpdate = true;
    t.mesh.geometry.attributes.color.needsUpdate = true;
    t.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    t.mesh.visible = true;
  }

  // ── GPU particles ────────────────────────────────────────────────────
  // One Points draw call. A particle is written ONCE at spawn; the vertex
  // shader evaluates the closed-form trajectory at `uTime` —
  //     p(t) = p0 + v * (1 - e^(-k*t)) / k  +  0.5 * g * t^2      (k -> 0: p0 + v*t)
  // — fades it over its life, and parks it off-screen once dead. Per frame the
  // CPU only advances the uniform and uploads slots written since last frame.
  // Slots are a ring; the oldest recycles first.
  //
  // `uTime` runs on the RENDER clock (advanced in _updateEffects), so sparks
  // keep flying through hitstop.
  _initParticles() {
    const N = this._particleMax = 2048;
    this._pCursor = 0;
    this._pClock = 0;
    this._pLo = Infinity;
    this._pHi = -1;
    const geo = new THREE.BufferGeometry();
    const attr = (name, size) => {
      const a = new THREE.BufferAttribute(new Float32Array(N * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this._pPos = attr('position', 3);   // spawn point
    this._pVel = attr('aVel', 3);
    this._pCol = attr('aColor', 3);
    this._pMeta = attr('aMeta', 4);     // birth, life, gravity, drag
    this._pSize = attr('aSize', 1);
    // Every slot starts long dead.
    for (let i = 0; i < N; i++) this._pMeta.array[i * 4] = -1e6;
    // Soft round sprite so points don't render as squares.
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this._pSprite = new THREE.CanvasTexture(c);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        // Pixels per world unit at distance 1 — half the drawing-buffer height,
        // the same factor PointsMaterial's sizeAttenuation uses. Set per frame.
        uScale: { value: 300 },
        uMap: { value: this._pSprite },
      },
      vertexShader: /* glsl */`
        attribute vec3 aVel;
        attribute vec3 aColor;
        attribute vec4 aMeta;
        attribute float aSize;
        uniform float uTime;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          float age = uTime - aMeta.x;
          if (age < 0.0 || age > aMeta.y) {
            // Dead or not yet born: outside the clip volume, zero size.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vColor = vec3(0.0);
            return;
          }
          float k = aMeta.w;
          float travel = k > 0.001 ? (1.0 - exp(-k * age)) / k : age;
          vec3 p = position + aVel * travel;
          p.y += 0.5 * aMeta.z * age * age;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // Linear fade to black over the life: additive blending, so black is gone.
          vColor = aColor * (1.0 - age / aMeta.y);
          gl_PointSize = aSize * uScale / max(0.05, -mv.z);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this._particlePoints = new THREE.Points(geo, mat);
    this._particlePoints.frustumCulled = false;
    this._particlePoints.renderOrder = 3;
    this.scene.add(this._particlePoints);
  }

  /**
   * Write one particle. `size` is world metres; `drag` is an exponential
   * velocity damping rate, 0 = none.
   */
  _spawnParticle(x, y, z, vx, vy, vz, color, life, gravity = -8, size = 0.11, drag = 0) {
    if (!this._particlePoints) return;
    const i = this._pCursor;
    this._pCursor = (i + 1) % this._particleMax;
    const i3 = i * 3, i4 = i * 4;
    const pos = this._pPos.array, vel = this._pVel.array, col = this._pCol.array, meta = this._pMeta.array;
    pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
    vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
    _pColor.set(color);
    col[i3] = _pColor.r; col[i3 + 1] = _pColor.g; col[i3 + 2] = _pColor.b;
    meta[i4] = this._pClock; meta[i4 + 1] = life; meta[i4 + 2] = gravity; meta[i4 + 3] = drag;
    this._pSize.array[i] = size;
    if (i < this._pLo) this._pLo = i;
    if (i > this._pHi) this._pHi = i;
  }

  _updateParticles(dt) {
    if (!this._particlePoints) return;
    this._pClock += dt;
    const u = this._particlePoints.material.uniforms;
    u.uTime.value = this._pClock;
    // Composer targets match the drawing buffer, so its height is the right scale.
    u.uScale.value = this.renderer.domElement.height * 0.5;
    if (this._pHi < 0) return;
    // Upload only the slots written since last frame. A ring wrap inside one
    // frame makes the span the whole buffer, which is still just one upload.
    const lo = this._pLo, count = this._pHi - lo + 1;
    for (const a of [this._pPos, this._pVel, this._pCol, this._pMeta, this._pSize]) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this._pLo = Infinity;
    this._pHi = -1;
  }

  // Canvas dust kicked up where a body hits the mat, or feet skid under a heavy
  // shove: fat, dim, slow particles with heavy drag, so they bloom outward and
  // hang in the spotlights instead of flying. Additive like everything else in
  // the pool, so "dim warm grey" reads as lit haze rather than as a grey cloud.
  _spawnDust(x, z, power = 1) {
    const n = Math.round(10 + 14 * Math.min(1.5, power));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.9 + Math.random() * 1.6) * (0.6 + 0.4 * power);
      this._spawnParticle(
        x + Math.cos(a) * 0.15, 0.06 + Math.random() * 0.12, z + Math.sin(a) * 0.15,
        Math.cos(a) * sp, 0.35 + Math.random() * 0.7, Math.sin(a) * sp,
        0x3a342e, 0.9 + Math.random() * 0.8, -0.25,
        0.28 + Math.random() * 0.34, 2.6);
    }
  }

  _spawnSparks(pos, color, count = 6, power = 1.0) {
    const spread = 0.35 * power;
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(
        (Math.random() - 0.5),
        Math.random() * 0.8 + 0.2,
        (Math.random() - 0.5)
      ).normalize().multiplyScalar(2.5 + Math.random() * 2.0 * power);
      this._spawnParticle(
        pos.x + (Math.random() - 0.5) * spread,
        pos.y + 1.0 + (Math.random() - 0.5) * 0.3,
        pos.z + (Math.random() - 0.5) * spread,
        dir.x, dir.y, dir.z,
        color, 0.35 + Math.random() * 0.15, -8, 0.08 + Math.random() * 0.06);
    }
    // Embers: slow, tiny, long-lived motes drifting down after the sparks.
    const embers = Math.round(count * 0.6);
    for (let i = 0; i < embers; i++) {
      this._spawnParticle(
        pos.x + (Math.random() - 0.5) * spread,
        pos.y + 1.0 + (Math.random() - 0.5) * 0.3,
        pos.z + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 2.2, Math.random() * 1.6, (Math.random() - 0.5) * 2.2,
        color, 0.9 + Math.random() * 0.7, -1.2, 0.035 + Math.random() * 0.03, 2.2);
    }
  }

  // Occasional blood on clean face hits: small matte dark-red droplets that
  // arc with the blow and fall under gravity. Deliberately mesh-based with
  // normal blending — additive particles glow, and blood must NOT glow.
  _spawnBlood(pos, dir, power = 1) {
    const count = 4 + Math.round(this.rng.random() * 3 * power);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.014 + this.rng.random() * 0.02, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0x7e120e, transparent: true, opacity: 0.95 })
      );
      m.position.set(
        pos.x + (this.rng.random() - 0.5) * 0.08,
        pos.y + (this.rng.random() - 0.5) * 0.08,
        pos.z + (this.rng.random() - 0.5) * 0.08);
      const vel = new THREE.Vector3(
        dir.x * (1.2 + this.rng.random() * 1.2) + (this.rng.random() - 0.5) * 1.4,
        0.6 + this.rng.random() * 1.2,
        dir.z * (1.2 + this.rng.random() * 1.2) + (this.rng.random() - 0.5) * 1.4);
      this.scene.add(m);
      // Long life — droplets don't fade in the air; they end by SPLATTING
      // on the canvas (see the blood branch in _updateEffects).
      this.effects.push({ mesh: m, life: 2.5, vel, gravity: -11, blood: true });
    }
  }

  // Tear an arm off the fighter: detach the shoulder→fist group from the torso,
  // reparent the upper arm and forearm into the scene as two independent
  // objects, and hand them to a two-bone rigid-body ragdoll so the limb flops
  // limply to the canvas with a silly blood squirt from stump and limb.
  //
  // Unregistering the arm's joints from `rig.joints` is load-bearing: the
  // animator, KO ragdoll and hitbox capsules all iterate that map and skip a
  // missing joint; otherwise they keep posing the severed limb.
  //
  // Must not touch the world — body creation is queued for _buildPendingSevers,
  // which runs outside world.step.
  _severArm(fighter, side, dir) {
    if (!fighter.armsLost) fighter.armsLost = new Set();
    if (fighter.armsLost.has(side)) return;
    const joints = fighter.rig.joints;
    const shoulder = joints['shoulder' + side];
    if (!shoulder || !shoulder.parent) return;
    const elbow = joints['elbow' + side];
    fighter.armsLost.add(side);

    // Snapshot each piece's world transform and re-anchor it in the scene so
    // the arm keeps its on-screen pose the instant it comes off. Order
    // matters: detaching the shoulder first leaves the elbow's world
    // transform unchanged, so its snapshot is still correct.
    const wp = new THREE.Vector3();
    const detach = (obj) => {
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      obj.getWorldPosition(wp);
      obj.getWorldQuaternion(q);
      obj.getWorldScale(s);
      obj.parent.remove(obj);
      obj.position.copy(wp);
      obj.quaternion.copy(q);
      obj.scale.copy(s);
      this.scene.add(obj);
    };
    // Collision boxes are sized off heightScale, exactly like the KO ragdoll's
    // upperArm/forearm parts — not off the sampled world scale, which briefly
    // carries the hips' cartoon-squash factor.
    const scale = (fighter.rig.config && fighter.rig.config.heightScale) || 1;
    detach(shoulder);
    if (elbow && elbow.parent) detach(elbow);
    shoulder.getWorldPosition(wp); // stump position for the blood + audio

    // The limb is no longer part of the fighter: drop its joints so nothing
    // poses it any more.
    delete joints['shoulder' + side];
    delete joints['elbow' + side];
    delete joints['fist' + side];

    // Launch outward (away from the body) + up, with a fast tumble.
    const outward = dir ? dir.clone() : new THREE.Vector3(side === 'L' ? -1 : 1, 0, 0);
    outward.y = 0;
    if (outward.lengthSq() < 1e-4) outward.set(side === 'L' ? -1 : 1, 0, 0);
    outward.normalize();
    const vel = new THREE.Vector3(
      outward.x * (1.6 + this.rng.random() * 1.6) + (side === 'L' ? -1 : 1) * 1.3,
      3.2 + this.rng.random() * 1.6,
      outward.z * (1.6 + this.rng.random() * 1.6));
    const angVel = new THREE.Vector3(
      (this.rng.random() - 0.5) * 11, (this.rng.random() - 0.5) * 11, (this.rng.random() - 0.5) * 13);

    const limb = { shoulder, elbow: elbow || null, scale, vel, angVel, arm: null, restT: 0, settled: false };
    this._severedLimbs = this._severedLimbs || [];
    this._severedLimbs.push(limb);
    this._pendingSevers = this._pendingSevers || [];
    this._pendingSevers.push({ fighter, side, limb });

    // Silly geyser: a big squirt off the stump + a burst trailing the limb.
    this._bloodSquirt(wp, outward, 2.4);
    this._bloodSquirt(wp, new THREE.Vector3(outward.x, 1, outward.z).normalize(), 1.8);
    // Keep the stump bleeding for a beat (see the stump loop in _tick).
    fighter.stumps.push({ side, t: 1.4, emit: 0 });
    this.audio.impact({ power: 1.8, worldPos: wp });
    this.hudDirty = true;
  }

  // Deferred half of _severArm: build the limb's rigid bodies. Called right after
  // every stepWorld, so we're always outside cannon's step when bodies are added.
  _buildPendingSevers() {
    if (!this._pendingSevers || !this._pendingSevers.length) return;
    if (!this._physics) { this._pendingSevers.length = 0; return; }
    const world = this._physics.world;
    for (const p of this._pendingSevers) {
      p.limb.arm = new SeveredArm(world, this._physics.materials.ragdoll, {
        shoulder: p.limb.shoulder,
        elbow: p.limb.elbow,
        scale: p.limb.scale,
        velocity: p.limb.vel,
        angularVelocity: p.limb.angVel,
      });
    }
    this._pendingSevers.length = 0;
  }

  // A beefier, sillier version of _spawnBlood for a dismemberment geyser: more
  // droplets, launched harder. Reuses the blood/stain pipeline so it splats.
  _bloodSquirt(pos, dir, power = 1) {
    const count = 10 + Math.round(this.rng.random() * 10 * power);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.02 + this.rng.random() * 0.03, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0x9e120e, transparent: true, opacity: 0.95 })
      );
      m.position.set(
        pos.x + (this.rng.random() - 0.5) * 0.1,
        pos.y + (this.rng.random() - 0.5) * 0.1,
        pos.z + (this.rng.random() - 0.5) * 0.1);
      const vel = new THREE.Vector3(
        dir.x * (2.2 + this.rng.random() * 2.6) + (this.rng.random() - 0.5) * 2.2,
        1.6 + this.rng.random() * 2.6 * power,
        dir.z * (2.2 + this.rng.random() * 2.6) + (this.rng.random() - 0.5) * 2.2);
      this.scene.add(m);
      this.effects.push({ mesh: m, life: 2.5, vel, gravity: -11, blood: true });
    }
  }

  // Drive each severed arm from its rigid bodies; once at rest, retire the
  // bodies and leave the meshes where they landed (the world has
  // allowSleep = false, so a settled limb would jitter forever). Limbs linger
  // until _spawnFighters clears them.
  _updateSeveredLimbs(dt) {
    if (!this._severedLimbs || !this._severedLimbs.length) return;
    for (const l of this._severedLimbs) {
      if (l.settled || !l.arm || !l.arm.active) continue;
      l.arm.drive();
      l.restT = l.arm.speed < 0.4 ? l.restT + dt : 0;
      if (l.restT > 0.4) {
        l.settled = true;
        const p = l.shoulder.position;
        l.arm.dispose();
        if (Math.abs(p.x) < 5.7 && Math.abs(p.z) < 5.7) {
          this._addBloodStain(p.x, p.z);
        }
      }
    }
  }

  // A landed droplet becomes a permanent stain on the canvas — the ring
  // visibly accumulates the fight's damage until the next match clears it.
  _addBloodStain(x, z) {
    if (!this._stainGeo) {
      this._stainGeo = new THREE.CircleGeometry(1, 8);
      this._stainMat = new THREE.MeshBasicMaterial({
        color: 0x5e0d0a, transparent: true, opacity: 0.8, depthWrite: false,
      });
    }
    this._bloodStains = this._bloodStains || [];
    // Cap the pool: the oldest stain recycles once the canvas is saturated.
    if (this._bloodStains.length >= 160) {
      const old = this._bloodStains.shift();
      this.scene.remove(old);
      this._bloodStains.push(old);
      old.position.set(x, 0.048, z);
      old.rotation.z = this.rng.random() * Math.PI;
      this.scene.add(old);
      return;
    }
    const s = new THREE.Mesh(this._stainGeo, this._stainMat);
    s.rotation.x = -Math.PI / 2;
    s.rotation.z = this.rng.random() * Math.PI;
    const r = 0.03 + this.rng.random() * 0.055;
    s.scale.set(r * (1 + this.rng.random() * 0.6), r, 1);
    s.position.set(x, 0.048, z);
    s.renderOrder = 2; // above the canvas top
    this.scene.add(s);
    this._bloodStains.push(s);
  }

  // Sweat spray off a rocked fighter's head on the heavy-hit stagger.
  _spawnSweat(headPos, count = 7) {
    for (let i = 0; i < count; i++) {
      this._spawnParticle(
        headPos.x + (Math.random() - 0.5) * 0.2,
        headPos.y + 0.1 + Math.random() * 0.15,
        headPos.z + (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 3.2, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 3.2,
        0xbfd8ff, 0.4 + Math.random() * 0.2, -9);
    }
    // The droplets darken the vinyl and dry off (matWear.js).
    this.matWear?.sweat(headPos.x, headPos.z, 0.55, count);
  }

  // Celebration confetti glitter over the ring at the K.O.
  _spawnConfetti() {
    const colors = [0xff4a3c, 0x4a7dff, 0xffd257, 0xf5f2ec];
    for (let i = 0; i < 80; i++) {
      this._spawnParticle(
        (Math.random() - 0.5) * 7, 5.5 + Math.random() * 2.5, (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 0.8, -0.4 - Math.random() * 0.5, (Math.random() - 0.5) * 0.8,
        colors[(Math.random() * colors.length) | 0],
        2.2 + Math.random() * 1.4, -0.35, 0.09 + Math.random() * 0.07);
    }
  }
}

export const Vfx = VfxMethods.prototype;
