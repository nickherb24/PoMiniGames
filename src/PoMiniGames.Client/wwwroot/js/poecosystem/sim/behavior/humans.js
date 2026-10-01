// humans.js — the tribe's settlement: huts (beds), hut sites, carried logs, building,
// and the night test that sends humans home. Chopping itself is flora/trees.js.
import { BEHAVIOR, FLORA } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { SPECIES } from '../creatures/species.js';
import { TILE, TILE_STATE, isWater, tileIndex, tileX, tileZ } from '../terrain/tiles.js';

export function createSettlement(cap) {
  // tech / campfireTile / towerTile / fieldTiles are the tribe's works (tech.js); they are
  // NONE / empty until the matching tier unlocks and snapshot as part of the settlement.
  return { huts: [], carried: new Uint8Array(cap), tech: 0, campfireTile: NONE, towerTile: NONE, fieldTiles: [] };
}

export function addHut(settlement, terrain, tileState, tile) {
  const hut = { tile, x: tileX(tile, terrain.size) + 0.5, z: tileZ(tile, terrain.size) + 0.5, beds: BEHAVIOR.bedsPerHut };
  settlement.huts.push(hut);
  tileState[tile] = TILE_STATE.HUT;
  return hut;
}

export const bedsTotal = (settlement) => settlement.huts.length * BEHAVIOR.bedsPerHut;
export const needsHut = (settlement, humanCount) => humanCount > bedsTotal(settlement);

export function nearestHut(settlement, x, z) {
  let best = null; let bestD = Infinity;
  for (const h of settlement.huts) {
    const d = (h.x - x) ** 2 + (h.z - z) ** 2;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/**
 * A free grass tile for a new hut: within hutSiteRadius of the first hut, or (for the
 * first hut) on grass within firstHutWaterRadius of water. Candidates are gathered in
 * index order and one is drawn from the behaviour stream. NONE when nothing fits.
 * `closed` (terrain/ground.js) keeps huts off cliffs and out from under other buildings;
 * `water` is the world's shore field, which only the first hut reads.
 */
export function chooseHutSite(settlement, terrain, tileState, rng, closed = null, water = null) {
  const { size, type } = terrain;
  const candidates = [];
  if (settlement.huts.length === 0) {
    const r = BEHAVIOR.firstHutWaterRadius;
    for (let i = 0; i < type.length && candidates.length < 4000; i++) {
      if (type[i] !== TILE.GRASS || tileState[i] !== TILE_STATE.NORMAL || closed?.[i]) continue;
      // With the shore field: within r tiles' WALK of somewhere to drink. A lake behind a
      // cliff is water on the map and a death sentence for a village (90 s to dehydrate).
      if (water) { if (water[i] >= 0 && water[i] <= r) candidates.push(i); continue; }
      const x = tileX(i, size); const z = tileZ(i, size);
      let nearWater = false;
      for (let dz = -r; dz <= r && !nearWater; dz++) for (let dx = -r; dx <= r; dx++) {
        if (isWater(type[tileIndex(x + dx, z + dz, size)])) { nearWater = true; break; }
      }
      if (nearWater) candidates.push(i);
    }
  } else {
    const origin = settlement.huts[0];
    const ox = tileX(origin.tile, size); const oz = tileZ(origin.tile, size);
    const r = BEHAVIOR.hutSiteRadius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const x = ox + dx; const z = oz + dz;
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        const i = z * size + x;
        if (type[i] !== TILE.GRASS || tileState[i] !== TILE_STATE.NORMAL || closed?.[i]) continue;
        // Leave a one-tile gap around existing huts so the village stays walkable.
        let crowded = false;
        for (const h of settlement.huts) if (Math.abs(h.x - 0.5 - x) <= 1 && Math.abs(h.z - 0.5 - z) <= 1) { crowded = true; break; }
        if (!crowded) candidates.push(i);
      }
    }
  }
  return candidates.length === 0 ? NONE : candidates[rng.int(candidates.length)];
}

export function giveLogs(settlement, i, n) { settlement.carried[i] = Math.min(255, settlement.carried[i] + n); }

/** Spend FLORA.logsPerTree carried logs on a new hut. */
export function buildHut(e, i, settlement, terrain, tileState, rng, log, tick, closed = null) {
  if (settlement.carried[i] < FLORA.logsPerTree) return false;
  const site = chooseHutSite(settlement, terrain, tileState, rng, closed);
  if (site === NONE) return false;
  const hut = addHut(settlement, terrain, tileState, site);
  settlement.carried[i] -= FLORA.logsPerTree;
  const name = e.names[i] || `${SPECIES[e.species[i]].name} #${i}`;
  log.push({ tick, kind: 'hut', text: `${name} built a hut (${hut.beds} beds)`, tile: site });
  return true;
}

/** Night covers the last 28 % and first 6 % of the light cycle. */
export const isNight = (dayFraction) => dayFraction >= 0.72 || dayFraction < 0.06;
