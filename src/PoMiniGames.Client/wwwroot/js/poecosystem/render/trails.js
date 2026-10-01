// trails.js — desire paths and fresh tracks (GFX pass 2, idea 1).
//
// The sim already moves every creature across the ground; nothing on the ground ever
// remembered it. This module is that memory, and it is render-only: it reads the
// interpolated creature rows the renderer already has and never talks to the worker, so
// the sim's determinism cannot notice it exists.
//
// One RG texture at TEXELS_PER_METRE over the island:
//
//   R  WEAR   slow to build, slow to fade (minutes). Where many feet pass the grass gives
//             way to packed earth, so migration routes, the path from the huts to the
//             water and the wolves' patrol loop appear on their own over a session.
//   G  FRESH  fast to build, fast to fade (tens of seconds). The trample channel: grass
//             blades (grass.js) flatten where it is high, snow shows the ground through
//             it, wet sand darkens. A fleeing herd leaves a visible wake.
//
// CPU side is two Float32 grids; the per-frame work is one stamp per MOVING creature
// (<= 400), and the decay + byte pack runs at UPLOAD_HZ, not per frame, because a trail
// that fades on a 4 Hz step is indistinguishable from one that fades continuously.
//
// Nothing here is saved: a reload starts with clean ground, which is fine for a surface
// effect and keeps the snapshot format untouched.
import * as THREE from 'three';
import { FRAME } from '../sim/frame.js';

const TEXELS_PER_METRE = 2;
const UPLOAD_HZ = 4;
const MOVING = 0.25;                   // m/s; a grazing rabbit shuffling in place leaves nothing
// Per-species footprint weight — rabbit, deer, wolf, human. Humans walk the same routes
// every day, which is exactly what makes a desire path, so they wear hardest.
const FOOT = [0.25, 0.6, 0.5, 1.0];
const WEAR_RATE = 0.022;               // per second of a weight-1 creature on one texel
const WEAR_FADE = 1 / 540;             // e-folding ~9 minutes
const FRESH_RATE = 3.2;
const FRESH_FADE = 1 / 26;             // e-folding ~26 s — long enough to read a wake in snow

/** Shared uniforms: the terrain and grass shaders bind these objects directly. */
export const trailUniforms = {
  uTrail: { value: null },
  uTrailSpan: { value: 200 },
};

export function createTrails(size) {
  const W = size * TEXELS_PER_METRE;
  const wear = new Float32Array(W * W);
  const fresh = new Float32Array(W * W);
  const bytes = new Uint8Array(W * W * 2);
  const texture = new THREE.DataTexture(bytes, W, W, THREE.RGFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  trailUniforms.uTrail.value = texture;
  trailUniforms.uTrailSpan.value = size;

  let sinceUpload = 0;

  function stampAt(x, z, w, dt) {
    const fx = x * TEXELS_PER_METRE - 0.5; const fz = z * TEXELS_PER_METRE - 0.5;
    const ix = Math.floor(fx); const iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= W - 1 || iz >= W - 1) return;
    // Bilinear splat: a creature between texels feeds all four, so a path is a line
    // rather than a staircase of the texel grid.
    // Written out rather than looped over two small arrays: this runs for every moving
    // creature on every rendered frame, and the arrays would be garbage each time.
    const ax = fx - ix; const az = fz - iz; const s = w * dt;
    const c = iz * W + ix;
    add(c, (1 - ax) * (1 - az) * s); add(c + 1, ax * (1 - az) * s);
    add(c + W, (1 - ax) * az * s); add(c + W + 1, ax * az * s);
  }
  function add(c, s) {
    wear[c] = Math.min(1, wear[c] + s * WEAR_RATE);
    fresh[c] = Math.min(1, fresh[c] + s * FRESH_RATE);
  }

  return {
    texture,
    /** The WEAR grid (width × width floats, 0..1) — the minimap's traffic layer reads it. */
    get wear() { return wear; },
    get width() { return W; },
    /**
     * Per rendered frame. `rows` is the renderer's interpolated creature buffer; `speeds`
     * its per-row ground speed (m/s).
     */
    stamp(rows, count, speeds, dt) {
      if (dt <= 0) return;
      for (let k = 0; k < count; k++) {
        if (speeds[k] < MOVING) continue;
        const o = k * FRAME.CREATURE_STRIDE;
        const species = rows[o + 5] | 0;
        // A juvenile is lighter; scale is already in the row.
        const w = (FOOT[species] ?? 0.4) * Math.min(1.4, rows[o + 4]) * Math.min(1.6, speeds[k] / 2);
        stampAt(rows[o], rows[o + 2], w, dt);
      }
      sinceUpload += dt;
      if (sinceUpload < 1 / UPLOAD_HZ) return;
      const wearKeep = Math.exp(-sinceUpload * WEAR_FADE);
      const freshKeep = Math.exp(-sinceUpload * FRESH_FADE);
      sinceUpload = 0;
      for (let i = 0, b = 0; i < wear.length; i++, b += 2) {
        const wv = wear[i] *= wearKeep;
        const fv = fresh[i] *= freshKeep;
        bytes[b] = wv * 255;
        bytes[b + 1] = fv * 255;
      }
      texture.needsUpdate = true;
    },
    dispose() {
      if (trailUniforms.uTrail.value === texture) trailUniforms.uTrail.value = null;
      texture.dispose();
    },
  };
}
