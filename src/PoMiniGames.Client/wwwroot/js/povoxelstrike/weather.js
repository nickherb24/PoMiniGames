// weather.js — the arena's weather, chosen by the world seed.
//
// A seed already reproduces the fortress; now it reproduces the day it is stormed on too,
// so a Daily Siege (and an online squad, who share one seed) all fight in the same rain.
// Render and sound only: nothing here changes a single number the simulation reads.
//
//   clear — as before
//   rain  — falling streaks, wet stone (materials.setWetness), overcast sky, rain bed
//   fog   — the fog range pulled in from 150/520 to 28/170: you find the wall by walking
//   storm — rain, darker, plus lightning: a full-frame flash and thunder a beat later
//
// The rain is one LineSegments object and one draw call. The vertex shader wraps every
// drop inside a box that rides the camera, so the CPU never touches a drop after start-up.

import * as THREE from 'three';
import { setWetness } from './materials.js';

const KINDS = ['clear', 'clear', 'rain', 'fog', 'storm'];

/** Seed → weather. Mixed first, so neighbouring seeds do not walk the list in order. */
export function weatherFor(seed) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return KINDS[((h ^ (h >>> 15)) >>> 0) % KINDS.length];
}

const BOX = new THREE.Vector3(46, 34, 46);

export class Weather {
  /**
   * @param hooks { flash(amount), thunder(delaySeconds), overcast(amount) } — all optional;
   *   the kiosk demo passes no thunder because it has no audio.
   */
  constructor(scene, seed, quality, hooks = {}) {
    this.scene = scene;
    this.kind = weatherFor(seed);
    this.hooks = hooks;
    this.wet = this.kind === 'rain' || this.kind === 'storm';
    this.reducedMotion = !!quality.reducedMotion;
    this._boltT = 5 + Math.random() * 8;
    this.rain = null;

    if (this.kind === 'fog' && scene.fog) { scene.fog.near = 28; scene.fog.far = 170; }
    if (this.wet && scene.fog) { scene.fog.near = 80; scene.fog.far = 360; }
    hooks.overcast?.(this.kind === 'storm' ? 0.85 : this.wet ? 0.6 : this.kind === 'fog' ? 0.45 : 0);
    setWetness(this.wet ? 1 : 0);
    if (this.wet && quality.rainDrops > 0) this._buildRain(quality.rainDrops);
  }

  _buildRain(count) {
    // Two vertices per drop sharing one base point; aTail slides the second one back along
    // the fall direction, which is the whole streak.
    const base = new Float32Array(count * 6);
    const tail = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      base.set([x, y, z, x, y, z], i * 6);
      tail[i * 2 + 1] = 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geometry.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: BOX },
        uVel: { value: new THREE.Vector3(3.5, -30, 1.5) },
        uAlpha: { value: 0.3 },
      },
      vertexShader: /* glsl */`
        attribute float aTail;
        uniform float uTime;
        uniform vec3 uCam, uBox, uVel;
        void main() {
          // Fixed in the world, wrapped around the camera: walking does not drag the rain.
          vec3 p = mod(position * uBox + uVel * uTime - uCam, uBox) - 0.5 * uBox + uCam;
          p -= normalize(uVel) * aTail * 0.85;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uAlpha;
        void main() { gl_FragColor = vec4(0.74, 0.82, 0.95, uAlpha); }`,
    });
    this.rain = new THREE.LineSegments(geometry, material);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 5;
    this.scene.add(this.rain);
  }

  /** @param indoors 0..1 from the engine's roof probe: no rain falls through a vault. */
  update(dt, cameraPosition, indoors) {
    if (this.rain) {
      const u = this.rain.material.uniforms;
      u.uTime.value += dt;
      u.uCam.value.copy(cameraPosition);
      u.uAlpha.value += ((indoors > 0.5 ? 0.0 : 0.3) - u.uAlpha.value) * Math.min(1, dt * 5);
    }
    if (this.kind !== 'storm') return;
    this._boltT -= dt;
    if (this._boltT > 0) return;
    this._boltT = 7 + Math.random() * 14;
    // The flash strobes the whole frame, so reduced motion gets the thunder without it.
    if (!this.reducedMotion) this.hooks.flash?.(0.7 + Math.random() * 0.3);
    this.hooks.thunder?.(0.3 + Math.random() * 1.6);
  }

  dispose() {
    setWetness(0);
    if (!this.rain) return;
    this.scene.remove(this.rain);
    this.rain.geometry.dispose();
    this.rain.material.dispose();
  }
}
