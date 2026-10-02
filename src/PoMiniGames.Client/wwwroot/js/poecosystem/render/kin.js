// kin.js — kin threads.
//
// While the camera is on one creature — inspected, followed, or the director's subject —
// a faint arc runs from it to each of its LIVING relatives: elders in blue, young in green,
// siblings in rose. A family that has scattered across the island becomes something you can
// see at a glance, and a herd turns out to be three households.
//
// Render-only, like everything in this folder: the relatives come from the sim's lineage
// book (world.kinOf, asked for by index.js every couple of seconds), and the positions from
// the creature rows the renderer already interpolates. Nothing is written back.
//
// One LineSegments mesh, rebuilt in place each frame: an arc is ARC_SEGMENTS short segments
// lifted in the middle, so a thread clears the ground between two animals on a slope.
import * as THREE from 'three';
import { FRAME } from '../sim/frame.js';

const MAX_KIN = 48;
const ARC_SEGMENTS = 10;
const REL_COLOUR = [new THREE.Color(0x7dd3fc), new THREE.Color(0x86efac), new THREE.Color(0xfda4af)];   // elder, young, sibling

export function createKinThreads(scene) {
  const vertices = MAX_KIN * ARC_SEGMENTS * 2;
  const positions = new Float32Array(vertices * 3);
  const colours = new Float32Array(vertices * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;      // rewritten every frame; a stale bounding sphere would cull it
  lines.renderOrder = 11;
  lines.name = 'kin-threads';
  scene.add(lines);

  let self = -1;
  let kin = [];
  const rowOf = new Map();

  return {
    /** The subject and its living relatives: [{ handle, rel }] (0 elder, 1 young, 2 sibling). */
    set(handle, list) { self = handle ?? -1; kin = (list ?? []).slice(0, MAX_KIN); },
    get count() { return geometry.drawRange.count / (ARC_SEGMENTS * 2); },
    /** Per frame, from the renderer's interpolated rows. */
    update(rows, handles, count, time) {
      if (self < 0 || kin.length === 0) { geometry.setDrawRange(0, 0); return; }
      rowOf.clear();
      for (let k = 0; k < count; k++) rowOf.set(handles[k], k);
      const s = rowOf.get(self);
      if (s === undefined) { geometry.setDrawRange(0, 0); return; }
      const so = s * FRAME.CREATURE_STRIDE;
      const ax = rows[so]; const ay = rows[so + 1] + 0.9; const az = rows[so + 2];
      let v = 0;
      for (const k of kin) {
        const r = rowOf.get(k.handle);
        if (r === undefined) continue;
        const o = r * FRAME.CREATURE_STRIDE;
        const bx = rows[o]; const by = rows[o + 1] + 0.9; const bz = rows[o + 2];
        const lift = Math.min(9, 1.2 + Math.hypot(bx - ax, bz - az) * 0.14);
        const colour = REL_COLOUR[k.rel] ?? REL_COLOUR[2];
        // A pulse travels from the subject to the relative, so the direction reads.
        const phase = (time * 0.6 + (k.handle & 15) / 16) % 1;
        for (let i = 0; i < ARC_SEGMENTS; i++) {
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / ARC_SEGMENTS;
            const p = v * 3;
            positions[p] = ax + (bx - ax) * t;
            positions[p + 1] = ay + (by - ay) * t + Math.sin(t * Math.PI) * lift;
            positions[p + 2] = az + (bz - az) * t;
            const glow = 0.3 + 0.7 * Math.max(0, 1 - Math.abs(t - phase) * 5);
            colours[p] = colour.r * glow; colours[p + 1] = colour.g * glow; colours[p + 2] = colour.b * glow;
            v++;
          }
        }
      }
      geometry.setDrawRange(0, v);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    },
    dispose() { scene.remove(lines); geometry.dispose(); material.dispose(); },
  };
}
