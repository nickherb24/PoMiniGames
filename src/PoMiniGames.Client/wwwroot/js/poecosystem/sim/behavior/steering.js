// steering.js — velocity intents (seek / flee / wander) and the one integrator that
// moves a creature over the heightmap. Creatures are kinematic: no rigid body, just a
// probe of the next step — tile, cliff and footprint (terrain/ground.js) — with a walk
// round a footprint's rim and fallback headings, so they slide along coasts, cliffs and
// trunks instead of stopping dead or walking through.
import { BEHAVIOR } from '../core/config.js';
import { TILE_STATE, isSolidState, isWalkable, tileIndex } from '../terrain/tiles.js';
import { SPECIES } from '../creatures/species.js';

export function seekTo(e, i, tx, tz, speed) {
  const dx = tx - e.x[i]; const dz = tz - e.z[i];
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { e.vx[i] = 0; e.vz[i] = 0; return; }
  e.vx[i] = dx / d * speed; e.vz[i] = dz / d * speed;
}

export function fleeFrom(e, i, fx, fz, speed) {
  const dx = e.x[i] - fx; const dz = e.z[i] - fz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { e.vx[i] = speed; e.vz[i] = 0; return; }
  e.vx[i] = dx / d * speed; e.vz[i] = dz / d * speed;
}

/** Persistent heading with jitter, from the behaviour RNG stream. */
export function wander(e, i, rng, speed) {
  e.yaw[i] += (rng.next() - 0.5) * BEHAVIOR.wanderTurn;
  e.vx[i] = Math.sin(e.yaw[i]) * speed;
  e.vz[i] = Math.cos(e.yaw[i]) * speed;
}

export function stop(e, i) { e.vx[i] = 0; e.vz[i] = 0; }

// A palisade (behavior/tech.js) is solid for everyone, its builders included: until
// 2026-10-01 humans walked through their own fence. The gates are the way in and out.
const blocked = (s) => isSolidState(s) || s === TILE_STATE.FENCE;

export function isPassable(terrain, tileState, x, z) {
  if (x < 0.5 || z < 0.5 || x >= terrain.size - 0.5 || z >= terrain.size - 0.5) return false;
  const t = tileIndex(x, z, terrain.size);
  return isWalkable(terrain.type[t]) && !blocked(tileState[t]);
}

// Fallback headings tried when the straight line is blocked (radians; ± pairs).
const TURNS = [0.7854, -0.7854, 1.5708, -1.5708, 2.3562, -2.3562];
// Those six, then the rest of the compass in 11.25° steps, reached only when all six are
// blocked: the way out of a wedge (a hut's rim meeting the waterline, a cliff's lip
// meeting a trunk) can be narrower than 45° and point almost straight back.
const SWEEP = TURNS.slice();
for (let k = 1; k <= 16; k++) if (k % 4 !== 0 || k === 16) SWEEP.push(k * Math.PI / 16, ...(k < 16 ? [-k * Math.PI / 16] : []));

// How far a body keeps its centre back from a cliff tile (ground.standable), by species.
const LIP = SPECIES.map(sp => Math.min(sp.radius, 0.45));
export const lipOf = (speciesId) => LIP[speciesId];
// The long-bodied species also want this much standable ground AHEAD of a step: a deer's
// or a wolf's forelegs swing 0.7 m in front of its centre, and with the lip margin alone a
// walk straight at a cliff ended with them out over the drop.
const FORE = SPECIES.map(sp => (sp.radius >= 0.5 ? 0.75 : 0));

/** May a creature's centre be at (x, z): passable tile, standable ground, outside every footprint. */
export function canStand(terrain, tileState, ground, x, z, lip) {
  return isPassable(terrain, tileState, x, z) && (!ground || (ground.standable(x, z, lip) && ground.hit(x, z) < 0));
}

// Rings searched for the nearest place to stand: 16 fixed headings, every 0.25 m out to
// REFUGE_RADIUS. Fixed order, no RNG — the same position always finds the same refuge.
const REFUGE_RADIUS = 4;
const RING = Array.from({ length: 16 }, (_, k) => [Math.sin(k * Math.PI / 8), Math.cos(k * Math.PI / 8)]);
const SPOT = { x: 0, z: 0 };

/**
 * The nearest point to (x, z) where a creature may stand, written to the returned scratch
 * object; null when (x, z) is already fine or nothing lies within REFUGE_RADIUS. Used for
 * newborns (a litter lands a metre from its mother, wherever that is) and for easing out
 * a creature that is somewhere it may no longer be.
 */
export function refuge(terrain, tileState, ground, x, z, lip) {
  for (let r = 0.25; r <= REFUGE_RADIUS; r += 0.25) {
    for (const [sx, cz] of RING) {
      const px = x + sx * r; const pz = z + cz * r;
      if (canStand(terrain, tileState, ground, px, pz, lip)) { SPOT.x = px; SPOT.z = pz; return SPOT; }
    }
  }
  return null;
}

/**
 * Integrate one step; returns true when the creature moved. `ground` (terrain/ground.js)
 * adds cliffs and footprints to the tile test. Everything here is a pure function of the
 * creature's position, velocity and yaw: the yaw it already carries is the only memory the
 * detour needs, so nothing new is snapshotted and no stream is drawn from.
 */
export function moveCreature(e, i, terrain, tileState, dt, ground = null) {
  const species = e.species[i];
  const lip = LIP[species];
  const x0 = e.x[i]; const z0 = e.z[i];

  // Somewhere it may not be — an old save, a hut raised where it stood, a fence closed on
  // it. Walk it to the nearest standing room at its own pace, through whatever is in
  // between. With no refuge in reach it moves by the tile rules alone, as it always did,
  // rather than being held where it is.
  if (ground && !canStand(terrain, tileState, ground, x0, z0, lip)) {
    const to = refuge(terrain, tileState, ground, x0, z0, lip);
    if (to) {
      const dx = to.x - x0; const dz = to.z - z0;
      const d = Math.hypot(dx, dz);
      const f = Math.min(1, SPECIES[species].walkSpeed * dt / d);
      e.x[i] = x0 + dx * f; e.z[i] = z0 + dz * f;
      e.y[i] = terrain.heightAt(e.x[i], e.z[i]);
      e.yaw[i] = Math.atan2(dx, dz);
      return true;
    }
    ground = null;
  }

  const vx = e.vx[i]; const vz = e.vz[i];
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-6) return false;
  const step = speed * dt;
  const heading = Math.atan2(vx, vz);
  let nx = x0; let nz = z0;
  let found = false;
  const turns = ground ? SWEEP : TURNS;
  // Each ± pair is tried on the side the creature is already turned to first (its yaw
  // against where it wants to go). Always-left-first sent a cornered animal one step left,
  // then one step right, for as long as it stayed cornered: a herd held against the sea
  // by a villager standing two metres off never slipped away along the beach.
  const side = ground && Math.sin(e.yaw[i] - heading) < 0 ? -1 : 1;
  // The straight step, then the fallback headings. A heading that only a footprint blocks
  // is answered by walking that footprint's rim instead (once per footprint). All of it
  // first under the ground-ahead rule (FORE); if that leaves nowhere at all to go — a nook
  // an old save or a newly raised wall left it in — once more without.
  for (let fore = ground ? FORE[species] : 0; ; fore = 0) {
    let rim = -1;
    for (let k = -1; k < turns.length && !found; k++) {
      const h = k < 0 ? heading : heading + side * turns[k];
      const px = k < 0 ? x0 + vx * dt : x0 + Math.sin(h) * step;
      const pz = k < 0 ? z0 + vz * dt : z0 + Math.cos(h) * step;
      if (fore > 0 && !ground.standable(px + Math.sin(h) * fore, pz + Math.cos(h) * fore, 0)) continue;
      if (canStand(terrain, tileState, ground, px, pz, lip)) { nx = px; nz = pz; e.yaw[i] = h; found = true; break; }
      if (!ground || !isPassable(terrain, tileState, px, pz) || !ground.standable(px, pz, lip)) continue;
      const c = ground.hit(px, pz);
      if (c === rim) continue;
      rim = c;
      // Round the rim. The side is the one the creature is already heading along — its
      // yaw is last tick's actual heading — so a detour keeps its direction until the way
      // is clear. Where the rim runs into another footprint the walk carries on round that
      // one (up to three: the outline of a row of huts, not a bounce between two of
      // them); where it runs into water or a cliff, or after three, it turns back the
      // other way round the first. Head-on with no lean, odd and even indices part to
      // either side.
      const size = terrain.size;
      let first = 0;
      for (let pass = 0; pass < 2 && !found; pass++) {
        let d = c;
        for (let hop = 0; hop < (pass === 0 ? 3 : 1); hop++) {
          const cx = d % size + 0.5; const cz = ((d / size) | 0) + 0.5;
          const r = ground.rad[d] + 0.02;
          const ox = x0 - cx; const oz = z0 - cz;
          const od = Math.hypot(ox, oz);
          const tx = -oz / od; const tz = ox / od;
          let lean = tx * Math.sin(e.yaw[i]) + tz * Math.cos(e.yaw[i]);
          if (Math.abs(lean) < 1e-3) lean = (tx * vx + tz * vz) / speed;
          if (Math.abs(lean) < 1e-3) lean = (i & 1) ? 1 : -1;
          if (pass === 1) lean = -first; else if (hop === 0) first = lean;
          const s = lean > 0 ? step : -step;
          const ax = ox + tx * s; const az = oz + tz * s;
          const f = r / Math.hypot(ax, az);
          const qx = cx + ax * f; const qz = cz + az * f;
          if (Math.hypot(qx - x0, qz - z0) > 2 * step) break;   // not standing at this rim
          const qh = Math.atan2(qx - x0, qz - z0);
          if (fore > 0 && !ground.standable(qx + Math.sin(qh) * fore, qz + Math.cos(qh) * fore, 0)) break;
          if (canStand(terrain, tileState, ground, qx, qz, lip)) { nx = qx; nz = qz; e.yaw[i] = qh; found = true; break; }
          if (!isPassable(terrain, tileState, qx, qz) || !ground.standable(qx, qz, lip)) break;
          const next = ground.hit(qx, qz);
          if (next === d) break;
          d = next;
        }
      }
    }
    if (found || fore === 0) break;
  }
  if (!found) { stop(e, i); return false; }
  e.x[i] = nx; e.z[i] = nz;
  e.y[i] = terrain.heightAt(nx, nz);
  return true;
}
