// ground.js — where a creature's centre may be: not on a cliff, not inside something solid.
//
// Two per-tile grids, both DERIVED (terrain + flora + settlement + tribe buildings), so
// nothing here is snapshotted and no RNG is touched: a restored world rebuilds the same
// grids from the state it was given. The tile grid is the spatial index — every solid
// thing the sim knows sits on a tile centre, so a lookup is one read for the small
// footprints and a 5 × 5 scan only beside a building (`near`).
//
//   rad[t]     footprint radius (metres) of what stands on tile t's centre, 0 for nothing.
//              It is the distance a creature's CENTRE keeps, i.e. the drawn half-extent
//              plus body room (render/floraMeshes.js, render/settlementMesh.js).
//   closed[t]  STEEP    the tile rises more than STEEP_RISE across its four corners
//              CUTOFF   standable, but walled off from the main land by STEEP tiles
//              COVERED  the tile's centre is inside a building's footprint
//              A closed tile is never entered, routed through or chosen as a target; a
//              creature found on one (an old save) is walked off it by steering.js.
import { NONE } from '../core/entities.js';
import { TILE_STATE, isSolidState, isWalkable } from './tiles.js';

// Rise across one 1 m tile. Measured over eight seeds the land is bimodal: ordinary relief
// tops out near 1.6 m (p99), lake walls and the crater's shoulders start near 5 m, and
// almost nothing lies between 2 and 3 — so 2 m takes the cliffs and leaves every hill.
export const STEEP_RISE = 2.0;

// Flora must stay under 0.5: trees stand on neighbouring tile centres 1 m apart, and at
// 0.5 two of them close the gap between their trunks. At 0.45 a forest of any density
// still has a way through between every pair (trunk 0.24 m, stump 0.30 m, bush 0.55 m:
// a body brushes a bush's outer leaves, never a trunk).
export const FOOTPRINT = Object.freeze({
  flora: 0.45,       // tree, stump, berry bush — one tile centre, one disc
  campfire: 1.0,     // hearth ring r 0.8
  tower: 1.0,        // 1.1 m square shaft
  hut: 1.5,          // 2.2 m square walls, turned up to 52°
  // Tribe buildings by BUILDING_KIND (tribe/contracts.js): hut r 1.7, granary 2 m square,
  // watchtower legs at ±0.6, war totem 0.8 m square.
  building: Object.freeze([2.0, 1.6, 1.2, 0.9]),
});
const BIG = 0.5;      // a footprint this wide reaches past its own tile
const REACH = 3;      // tiles a big footprint can matter from (largest radius 2.0, plus a step)

export const CLOSED = Object.freeze({ STEEP: 1, CUTOFF: 2, COVERED: 4 });

export function createGround(terrain) {
  const { size, height, type } = terrain;
  const cs = size + 1;
  const n = size * size;
  const rad = new Float32Array(n);
  const closed = new Uint8Array(n);
  const near = new Uint8Array(n);
  const big = [];
  let stamp = NaN;   // checksum of the last rebuild; NaN so the first one always reports a change
  let states = null; // the world's tileState, held from the first rebuild (same array for life)

  // Static part: cliffs, then the land they cut off (4-connected flood from every standable
  // tile; all but the largest component is CUTOFF).
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = z * size + x;
      if (!isWalkable(type[i])) continue;
      const o = z * cs + x;
      const a = height[o]; const b = height[o + 1]; const c = height[o + cs]; const d = height[o + cs + 1];
      if (Math.max(a, b, c, d) - Math.min(a, b, c, d) > STEEP_RISE) closed[i] = CLOSED.STEEP;
    }
  }
  {
    const comp = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let best = -1; let bestSize = 0; let ids = 0; let top = 0;
    const push = (j) => { if (comp[j] < 0 && !closed[j] && isWalkable(type[j])) { comp[j] = ids; stack[top++] = j; } };
    for (let i = 0; i < n; i++) {
      if (comp[i] >= 0 || closed[i] || !isWalkable(type[i])) continue;
      let count = 0;
      push(i);
      while (top > 0) {
        const k = stack[--top]; count++;
        const x = k % size; const z = (k / size) | 0;
        if (x > 0) push(k - 1);
        if (x < size - 1) push(k + 1);
        if (z > 0) push(k - size);
        if (z < size - 1) push(k + size);
      }
      if (count > bestSize) { bestSize = count; best = ids; }
      ids++;
    }
    for (let i = 0; i < n; i++) if (comp[i] >= 0 && comp[i] !== best) closed[i] = CLOSED.CUTOFF;
  }

  const ground = {
    rad, closed,

    /**
     * Recompute the footprints; returns true when they differ from the last rebuild.
     * Called wherever a solid thing can appear or go: world creation, restore, a hut
     * built, a boulder or lava settling, and the once-a-second block (tech tiers, tribe
     * construction, planted fields). Trees never change it — a stump keeps its tree's
     * tile and its disc.
     */
    rebuild({ tileState, trees, bushes, settlement, buildings }) {
      let sum = trees.count;
      states = tileState;
      for (const t of big) {
        const x0 = t % size; const z0 = (t / size) | 0;
        for (let z = Math.max(0, z0 - REACH); z <= Math.min(size - 1, z0 + REACH); z++) {
          for (let x = Math.max(0, x0 - REACH); x <= Math.min(size - 1, x0 + REACH); x++) { const j = z * size + x; near[j] = 0; closed[j] &= ~CLOSED.COVERED; }
        }
      }
      big.length = 0;
      rad.fill(0);
      for (let k = 0; k < trees.count; k++) rad[trees.tile[k]] = FOOTPRINT.flora;
      for (let k = 0; k < bushes.count; k++) { rad[bushes.tile[k]] = FOOTPRINT.flora; sum = (Math.imul(sum, 31) + bushes.tile[k]) | 0; }
      const put = (t, r) => {
        if (t === NONE || t < 0 || t >= n || r <= rad[t]) return;
        if (rad[t] < BIG) big.push(t);
        rad[t] = r;
        sum = (Math.imul(sum, 31) + t * 256 + Math.round(r * 100)) | 0;
      };
      for (const h of settlement.huts) put(h.tile, FOOTPRINT.hut);
      // The works are drawn from the tile state, so a buried campfire or tower stops
      // being solid the tick it stops being drawn (maintainWorks re-places it later).
      if (settlement.campfireTile !== NONE && tileState[settlement.campfireTile] === TILE_STATE.CAMPFIRE) put(settlement.campfireTile, FOOTPRINT.campfire);
      if (settlement.towerTile !== NONE && tileState[settlement.towerTile] === TILE_STATE.TOWER) put(settlement.towerTile, FOOTPRINT.tower);
      for (const b of buildings) put(b.tile, FOOTPRINT.building[b.kind] ?? FOOTPRINT.building[0]);
      for (const t of big) {
        const r = rad[t]; const x0 = t % size; const z0 = (t / size) | 0;
        for (let z = Math.max(0, z0 - REACH); z <= Math.min(size - 1, z0 + REACH); z++) {
          for (let x = Math.max(0, x0 - REACH); x <= Math.min(size - 1, x0 + REACH); x++) {
            const j = z * size + x;
            near[j] = 1;
            // Covered when the tile's CENTRE is inside. Routing walks centre to centre,
            // and two centres that are both outside a disc have a clear line between
            // them (the disc sits on the same lattice); a tile judged by its far corner
            // let the shore field thread the gap between two huts whose discs overlap.
            if ((x - x0) * (x - x0) + (z - z0) * (z - z0) < r * r) closed[j] |= CLOSED.COVERED;
          }
        }
      }
      const changed = sum !== stamp;
      stamp = sum;
      return changed;
    },

    /** Tile whose footprint contains (x, z), or -1. */
    hit(x, z) {
      const ix = x | 0; const iz = z | 0;
      if (ix < 0 || iz < 0 || ix >= size || iz >= size) return -1;
      const t = iz * size + ix;
      const r = rad[t];
      if (r > 0) { const dx = x - ix - 0.5; const dz = z - iz - 0.5; if (dx * dx + dz * dz < r * r) return t; }
      if (!near[t]) return -1;
      for (let zz = Math.max(0, iz - 2); zz <= Math.min(size - 1, iz + 2); zz++) {
        for (let xx = Math.max(0, ix - 2); xx <= Math.min(size - 1, ix + 2); xx++) {
          const j = zz * size + xx;
          const rj = rad[j];
          if (rj < BIG || j === t) continue;
          const dx = x - xx - 0.5; const dz = z - zz - 0.5;
          if (dx * dx + dz * dz < rj * rj) return j;
        }
      }
      return -1;
    },

    /**
     * True when (x, z) is on standable ground and at least `m` metres back from every
     * cliff tile — the margin is what keeps a body from hanging over the lip. m < 0.5, so
     * the line between two neighbouring open tile centres is always clear.
     */
    standable(x, z, m) {
      const ix = x | 0; const iz = z | 0;
      if (ix < 0 || iz < 0 || ix >= size || iz >= size) return false;
      const t = iz * size + ix;
      if (closed[t] & (CLOSED.STEEP | CLOSED.CUTOFF)) return false;
      const fx = x - ix; const fz = z - iz;
      const w = fx < m && ix > 0; const e = fx > 1 - m && ix < size - 1;
      const u = fz < m && iz > 0; const d = fz > 1 - m && iz < size - 1;
      if (w && (closed[t - 1] & CLOSED.STEEP)) return false;
      if (e && (closed[t + 1] & CLOSED.STEEP)) return false;
      if (u && (closed[t - size] & CLOSED.STEEP)) return false;
      if (d && (closed[t + size] & CLOSED.STEEP)) return false;
      const m2 = m * m;
      if (w && u && (closed[t - size - 1] & CLOSED.STEEP) && fx * fx + fz * fz < m2) return false;
      if (e && u && (closed[t - size + 1] & CLOSED.STEEP) && (1 - fx) * (1 - fx) + fz * fz < m2) return false;
      if (w && d && (closed[t + size - 1] & CLOSED.STEEP) && fx * fx + (1 - fz) * (1 - fz) < m2) return false;
      if (e && d && (closed[t + size + 1] & CLOSED.STEEP) && (1 - fx) * (1 - fx) + (1 - fz) * (1 - fz) < m2) return false;
      return true;
    },

    /**
     * Is the straight line from (x0, z0) to within `short` metres of (x1, z1) walkable —
     * no water, rock, cliff, cut-off pocket, building, boulder, lava or palisade on it?
     * Half-tile steps. Perception asks this before a creature sets its heart on
     * something: steering is straight-line with a slide, so food, prey or a mate across
     * a lake, under a cliff or behind a row of huts is a target it would press against
     * until it starved.
     */
    clearLine(x0, z0, x1, z1, short = 0) {
      const dx = x1 - x0; const dz = z1 - z0;
      const d = Math.hypot(dx, dz);
      const steps = Math.floor((d - short) * 2);
      for (let k = 1; k <= steps; k++) {
        const f = k * 0.5 / d;
        const t = ((z0 + dz * f) | 0) * size + ((x0 + dx * f) | 0);
        if (closed[t] || !isWalkable(type[t])) return false;
        const st = states[t];
        if (st !== TILE_STATE.NORMAL && (isSolidState(st) || st === TILE_STATE.FENCE)) return false;
      }
      return true;
    },
  };
  return ground;
}
