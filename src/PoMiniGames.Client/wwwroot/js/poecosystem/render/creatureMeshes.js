// creatureMeshes.js — creatures as low-poly primitive assemblies, one InstancedMesh per
// (species × body part). Every creature is drawn from the frame's [x, y, z, yaw, scale,
// species, goal, lifeStage] record; legs swing cosmetically from the position delta, so
// walking reads as walking without the sim sending any animation state.
import * as THREE from 'three';
import { FRAME } from '../sim/frame.js';
import { SPECIES_ID } from '../sim/creatures/species.js';
import { enhanceLambert, materialLens } from './materials.js';

// Part = box or cone offset from the creature's origin (feet), forward = +Z.
// feet = [fore-aft, sideways] distance from the origin to where the legs meet the ground:
// a rig that has it is seated on the slope under those four points (draw). The human has
// none — two feet under the hips, and people stand upright on a hillside.
const RIGS = {
  [SPECIES_ID.RABBIT]: {
    colour: 0xd9c8a9, scale: 0.5, feet: [0.3, 0.18],
    parts: [
      { shape: 'box', size: [0.5, 0.3, 0.8], at: [0, 0.55, 0] },
      { shape: 'box', size: [0.3, 0.3, 0.3], at: [0, 0.75, 0.55] },
      { shape: 'cone', size: [0.07, 0.35], at: [-0.09, 1.0, 0.55] },
      { shape: 'cone', size: [0.07, 0.35], at: [0.09, 1.0, 0.55] },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [-0.18, 0.2, 0.3], leg: 1 },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [0.18, 0.2, 0.3], leg: -1 },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [-0.18, 0.2, -0.3], leg: -1 },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [0.18, 0.2, -0.3], leg: 1 },
    ],
  },
  [SPECIES_ID.DEER]: {
    colour: 0x9a6b3f, scale: 1.25, feet: [0.32, 0.2],
    parts: [
      { shape: 'box', size: [0.5, 0.35, 0.9], at: [0, 0.62, 0] },
      { shape: 'box', size: [0.28, 0.28, 0.32], at: [0, 0.95, 0.55] },
      { shape: 'box', size: [0.16, 0.35, 0.16], at: [0, 0.85, 0.4] },
      { shape: 'cone', size: [0.05, 0.4], at: [-0.1, 1.2, 0.5] },
      { shape: 'cone', size: [0.05, 0.4], at: [0.1, 1.2, 0.5] },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [-0.2, 0.25, 0.32], leg: 1 },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [0.2, 0.25, 0.32], leg: -1 },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [-0.2, 0.25, -0.32], leg: -1 },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [0.2, 0.25, -0.32], leg: 1 },
    ],
  },
  [SPECIES_ID.WOLF]: {
    colour: 0x6b7280, scale: 1.0, feet: [0.35, 0.18],
    parts: [
      { shape: 'box', size: [0.45, 0.35, 1.0], at: [0, 0.6, 0] },
      { shape: 'box', size: [0.3, 0.28, 0.4], at: [0, 0.68, 0.62] },
      { shape: 'cone', size: [0.06, 0.2], at: [-0.09, 0.86, 0.6] },
      { shape: 'cone', size: [0.06, 0.2], at: [0.09, 0.86, 0.6] },
      { shape: 'box', size: [0.12, 0.12, 0.5], at: [0, 0.62, -0.6] },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [-0.18, 0.25, 0.35], leg: 1 },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [0.18, 0.25, 0.35], leg: -1 },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [-0.18, 0.25, -0.35], leg: -1 },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [0.18, 0.25, -0.35], leg: 1 },
    ],
  },
  [SPECIES_ID.HUMAN]: {
    colour: 0xc7d2fe, scale: 1.0,
    parts: [
      { shape: 'box', size: [0.36, 0.24, 0.26], at: [0, 1.0, 0] },
      { shape: 'box', size: [0.4, 0.5, 0.28], at: [0, 1.4, 0] },
      { shape: 'box', size: [0.26, 0.26, 0.26], at: [0, 1.85, 0] },
      { shape: 'box', size: [0.12, 0.6, 0.12], at: [-0.3, 1.35, 0], leg: 1 },
      { shape: 'box', size: [0.12, 0.6, 0.12], at: [0.3, 1.35, 0], leg: -1 },
      { shape: 'box', size: [0.14, 0.9, 0.14], at: [-0.12, 0.45, 0], leg: -1 },
      { shape: 'box', size: [0.14, 0.9, 0.14], at: [0.12, 0.45, 0], leg: 1 },
    ],
  },
};

const JUVENILE_SCALE = 0.55;
// Seating. A foot sample that differs from the ground under the body by more than this
// slope is not ground the creature is standing on (the drop past a cliff's lip, the wall
// above a ledge): it is ignored and the body keeps the tilt of the side it stands on.
const SEAT_MAX_SLOPE = 1.2;

// The evolution tint: a creature's chosen base trait mapped cool → warm. Applied through
// InstancedMesh.instanceColor, which multiplies the material colour, so the species
// material goes white while a tint is on and back to its own colour when it is off.
const TINT_LOW = new THREE.Color(0x2563eb);
const TINT_HIGH = new THREE.Color(0xfbbf24);

// The naturalist lenses (2026-09-30). 0–4 are the five traits (the evolution tint); the rest
// read what the frame now carries: hunger, health and the sick flag, how fast the creature
// is moving, and — given the kin of whoever the camera is on — who is family.
export const LENS = Object.freeze({ NONE: -1, HUNGER: 5, HEALTH: 6, THERMAL: 7, KIN: 8, COUNT: 9 });
// How far the lens colour replaces the lit colour (materials.js materialLens).
const LENS_GLOW = { [LENS.HUNGER]: 0.7, [LENS.HEALTH]: 0.7, [LENS.THERMAL]: 1, [LENS.KIN]: 0.85 };
const FED = new THREE.Color(0x22c55e); const STARVING = new THREE.Color(0xef4444);
const DYING = new THREE.Color(0xdc2626); const HEALTHY = new THREE.Color(0x34d399); const SICK = new THREE.Color(0xc026d3);
// Thermal ramp: cold violet → magenta → orange → near white.
const THERMAL = [new THREE.Color(0x22105e), new THREE.Color(0xc0206e), new THREE.Color(0xff8a1f), new THREE.Color(0xfff3b0)];
const BODY_HEAT = [0.3, 0.42, 0.5, 0.46];   // rabbit, deer, wolf, human at rest
const KIN_SELF = new THREE.Color(0xfde047);
const KIN_REL = [new THREE.Color(0x7dd3fc), new THREE.Color(0x86efac), new THREE.Color(0xfda4af)];   // elder, young, sibling
const KIN_OTHER = new THREE.Color(0x2c313c);

export function createCreatureMeshes(scene, cap) {
  const groups = [];
  let tint = -1;               // lens id: a trait index, a LENS value, or -1 for none
  let repaint = false;         // one pass back to white after the tint is switched off
  let kinSelf = -1; let kin = new Map();   // handle → relation (0 elder, 1 young, 2 sibling)
  const tintColour = new THREE.Color();
  function thermal(t) {
    const x = Math.max(0, Math.min(0.9999, t)) * 3; const k = x | 0;
    return tintColour.copy(THERMAL[k]).lerp(THERMAL[k + 1], x - k);
  }
  // Two reusable transforms: at 400 creatures × ~8 parts × 60 fps, allocating an
  // Object3D per part per frame would be ~200k allocations a second.
  const dummy = new THREE.Object3D();
  const local = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';   // yaw outermost, so pitch and roll are about the body's own axes
  for (const [id, rig] of Object.entries(RIGS)) {
    // Fur/skin grain at a body scale, and a sky-tinted rim so a creature separates from the
    // ground it stands on at a distance (materials.js).
    const material = enhanceLambert(new THREE.MeshLambertMaterial({ color: rig.colour, flatShading: true }), { rim: 0.42, mottle: 0.16, mottleScale: 0.9, lens: true });
    const parts = rig.parts.map((p) => {
      const geo = p.shape === 'cone'
        ? new THREE.ConeGeometry(p.size[0], p.size[1], 5)
        : new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
      const mesh = new THREE.InstancedMesh(geo, material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `creature-${id}-${p.shape}`;
      scene.add(mesh);
      return { def: p, mesh, geo };
    });
    groups[Number(id)] = { rig, parts, material, count: 0 };
  }

  // There is no selection outline. A cyan wireframe box used to track the inspected
  // creature — and, because the auto-director inspected whatever it was filming, it sat
  // around the subject of every cinematic shot. Removed 2026-09-16 at the user's request:
  // the shot itself says what is being watched, and the popover names it.

  return {
    /** Colour every creature through a lens: a base trait (0–4), a LENS value, or -1 for species colours. */
    setTint(lens) {
      const next = Number.isInteger(lens) && lens >= 0 && lens < LENS.COUNT ? lens : -1;
      if (next === tint) return;
      tint = next;
      repaint = true;
      materialLens.value = LENS_GLOW[tint] ?? 0;
      for (const g of groups) if (g) g.material.color.setHex(tint >= 0 ? 0xffffff : g.rig.colour);
    },
    get tint() { return tint; },
    /** The kin lens's subject and its living relatives ([{ handle, rel }], sim/world.js kinOf). */
    setKin(self, list) {
      kinSelf = self ?? -1;
      kin = new Map((list ?? []).map(k => [k.handle, k.rel]));
    },
    /**
     * Draw one frame. `view` is the interpolated creature array, `count` how many are live,
     * `time` seconds for the leg swing, `handles` the frame's handle per row, `heightAt`
     * the terrain (four-legged bodies are pitched and rolled to the ground under their
     * feet; the frame only carries the height under the centre, which on a slope left one
     * end of the body in the hill and the other in the air).
     */
    draw(view, count, time, speeds, handles, heightAt = null) {
      for (const g of groups) if (g) g.count = 0;
      const paint = tint >= 0 || repaint;
      for (let k = 0; k < count; k++) {
        const o = k * FRAME.CREATURE_STRIDE;
        const species = view[o + 5] | 0;
        const g = groups[species];
        if (!g) continue;
        const scale = g.rig.scale * (view[o + 7] === 0 ? JUVENILE_SCALE : 1) * (view[o + 4] || 1);
        const swing = Math.sin(time * 9 + k) * Math.min(0.5, (speeds?.[k] ?? 0) * 0.12);
        const i = g.count++;
        if (paint) {
          if (tint < 0) tintColour.setRGB(1, 1, 1);
          else if (tint < 5) tintColour.copy(TINT_LOW).lerp(TINT_HIGH, Math.max(0, Math.min(1, view[o + FRAME.TRAIT_OFFSET + tint])));
          else if (tint === LENS.HUNGER) tintColour.copy(FED).lerp(STARVING, Math.max(0, Math.min(1, view[o + FRAME.HUNGER])));
          else if (tint === LENS.HEALTH) {
            if ((view[o + FRAME.STATE] | 0) & FRAME.C_SICK) tintColour.copy(SICK);
            else tintColour.copy(DYING).lerp(HEALTHY, Math.max(0, Math.min(1, view[o + FRAME.HEALTH])));
          } else if (tint === LENS.THERMAL) thermal((BODY_HEAT[species] ?? 0.4) + Math.min(0.55, (speeds?.[k] ?? 0) * 0.11));
          else {
            const h = handles ? handles[k] : -1;
            const rel = kin.get(h);
            tintColour.copy(h === kinSelf ? KIN_SELF : rel === undefined ? KIN_OTHER : KIN_REL[rel] ?? KIN_OTHER);
          }
          for (const part of g.parts) part.mesh.setColorAt(i, tintColour);
        }
        let pitch = 0; let roll = 0;
        const feet = g.rig.feet;
        if (feet && heightAt) {
          const x = view[o]; const y = view[o + 1]; const z = view[o + 2];
          const sin = Math.sin(view[o + 3]); const cos = Math.cos(view[o + 3]);
          const fl = feet[0] * scale; const fw = feet[1] * scale;
          // Height of each foot line relative to the centre; a sample over an edge mirrors the other.
          let front = heightAt(x + sin * fl, z + cos * fl) - y; let back = heightAt(x - sin * fl, z - cos * fl) - y;
          if (Math.abs(front) > fl * SEAT_MAX_SLOPE) front = Math.abs(back) > fl * SEAT_MAX_SLOPE ? 0 : -back;
          if (Math.abs(back) > fl * SEAT_MAX_SLOPE) back = -front;
          let right = heightAt(x + cos * fw, z - sin * fw) - y; let left = heightAt(x - cos * fw, z + sin * fw) - y;
          if (Math.abs(right) > fw * SEAT_MAX_SLOPE) right = Math.abs(left) > fw * SEAT_MAX_SLOPE ? 0 : -left;
          if (Math.abs(left) > fw * SEAT_MAX_SLOPE) left = -right;
          pitch = Math.atan2(back - front, 2 * fl);
          roll = Math.atan2(right - left, 2 * fw);
        }
        dummy.position.set(view[o], view[o + 1], view[o + 2]);
        dummy.rotation.set(pitch, view[o + 3], roll);
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrix();
        for (const part of g.parts) {
          const { at, leg } = part.def;
          local.position.set(at[0], at[1], at[2] + (leg ? Math.sin(swing) * leg * 0.25 : 0));
          local.rotation.x = leg ? swing * leg : 0;
          local.updateMatrix();
          local.matrix.premultiply(dummy.matrix);
          part.mesh.setMatrixAt(i, local.matrix);
        }
      }
      for (const g of groups) {
        if (!g) continue;
        for (const part of g.parts) {
          part.mesh.count = g.count; part.mesh.instanceMatrix.needsUpdate = true;
          if (paint && part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
        }
      }
      if (tint < 0) repaint = false;
    },
    dispose() {
      materialLens.value = 0;
      for (const g of groups) {
        if (!g) continue;
        for (const part of g.parts) { scene.remove(part.mesh); part.geo.dispose(); part.mesh.dispose(); }
        g.material.dispose();
      }
    },
  };
}
