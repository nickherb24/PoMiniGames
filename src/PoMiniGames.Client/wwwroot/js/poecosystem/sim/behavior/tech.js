// tech.js — the tribe's ladder: Camp → Fire → Palisade → Farming → Watchtower. Each tier
// unlocks when its TECH conditions hold (checked once a second by world.js) and builds one
// thing in the village. Everything here is deterministic: candidate tiles are gathered in
// index order and the first fit is taken, so no RNG stream is touched and a world plays
// out identically with or without the ladder having been reached.
//
// What each tier changes elsewhere:
//   FIRE       a CAMPFIRE tile by the first hut. Wolves treat it as a threat inside
//              TECH.campfireScareRadius (world.perceive); humans within campfireWarmRadius
//              regain health at night (world.step).
//   PALISADE   a ring of FENCE tiles round the village with gates. Solid for every species,
//              the tribe included (behavior/steering.js): everyone goes by the gates, so
//              the herds' predators mostly stay out.
//   FARMING    FIELD tiles carrying cultivated bushes that ripen fieldRipenMultiplier×
//              faster (flora/bushes.js `fast`).
//   WATCHTOWER a TOWER tile (solid, like a hut). Humans see further and throw further
//              (world.perceive / act) while it stands.
import { TECH } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { TILE, TILE_STATE, isWalkable, tileX, tileZ } from '../terrain/tiles.js';
import { plantBush } from '../flora/bushes.js';

export const TECH_LEVEL = Object.freeze({ CAMP: 0, FIRE: 1, PALISADE: 2, FARMING: 3, WATCHTOWER: 4 });
export const TECH_NAMES = Object.freeze(['Camp', 'Fire', 'Palisade', 'Farming', 'Watchtower']);
const TECH_DEEDS = Object.freeze([
  'pitched camp',
  'learned to keep a fire burning',
  'raised a palisade around the village',
  'planted berry fields',
  'built a watchtower',
]);

// Derived from the seed rather than drawn from the names stream: a draw would shift every
// creature name after it, and a world saved before tribes had names must still resolve one.
const TRIBE_NAMES = Object.freeze(['Ash', 'Reed', 'Stone', 'Fern', 'Salt', 'Elm', 'Ember', 'Moss', 'Tide', 'Cinder', 'Heron', 'Thorn']);
export const tribeName = (seed) => TRIBE_NAMES[Math.abs(seed | 0) % TRIBE_NAMES.length];

/** Do the next tier's conditions hold right now? */
export function nextTierReady(settlement, { hutsBuilt, humans, year }) {
  switch (settlement.tech) {
    case TECH_LEVEL.CAMP: return hutsBuilt >= TECH.fire.hutsBuilt && humans >= TECH.fire.humans;
    case TECH_LEVEL.FIRE: return hutsBuilt >= TECH.palisade.hutsBuilt && humans >= TECH.palisade.humans;
    case TECH_LEVEL.PALISADE: return year >= TECH.farming.year && humans >= TECH.farming.humans;
    case TECH_LEVEL.FARMING: return year >= TECH.watchtower.year && hutsBuilt >= TECH.watchtower.hutsBuilt;
    default: return false;
  }
}

/** Free grass tiles within `radius` of the first hut, in index order. */
function freeTilesNear(world, radius, { keepClear = 1 } = {}) {
  const { terrain, tileState, settlement, trees, bushes } = world;
  const origin = settlement.huts[0];
  if (!origin) return [];
  const { size, type } = terrain;
  const ox = tileX(origin.tile, size); const oz = tileZ(origin.tile, size);
  const out = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const x = ox + dx; const z = oz + dz;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      const i = z * size + x;
      if (type[i] !== TILE.GRASS || tileState[i] !== TILE_STATE.NORMAL || world.ground?.closed[i]) continue;
      if (trees.byTile[i] >= 0 || bushes.byTile[i] >= 0) continue;
      let crowded = false;
      for (const h of settlement.huts) if (Math.abs(h.x - 0.5 - x) <= keepClear && Math.abs(h.z - 0.5 - z) <= keepClear) { crowded = true; break; }
      if (!crowded) out.push(i);
    }
  }
  return out;
}

function placeCampfire(world) {
  const tiles = freeTilesNear(world, 3);
  if (!tiles.length) return false;
  world.tileState[tiles[0]] = TILE_STATE.CAMPFIRE;
  world.settlement.campfireTile = tiles[0];
  return true;
}

function raisePalisade(world) {
  const { terrain, tileState, settlement, trees, bushes } = world;
  const origin = settlement.huts[0];
  if (!origin) return false;
  const { size, type } = terrain;
  const ox = tileX(origin.tile, size); const oz = tileZ(origin.tile, size);
  const r = TECH.fenceRadius;
  let placed = 0; let n = 0;
  for (let dz = -r - 1; dz <= r + 1; dz++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = Math.hypot(dx, dz);
      if (Math.abs(d - r) >= 0.5) continue;
      const x = ox + dx; const z = oz + dz;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      const i = z * size + x;
      n++;
      if (n % TECH.fenceGateEvery === 0) continue;                       // a gate
      if (!isWalkable(type[i]) || tileState[i] !== TILE_STATE.NORMAL) continue;
      if (trees.byTile[i] >= 0 || bushes.byTile[i] >= 0) continue;
      tileState[i] = TILE_STATE.FENCE;
      placed++;
    }
  }
  return placed > 0;
}

function plantFields(world) {
  const tiles = freeTilesNear(world, TECH.fenceRadius - 1, { keepClear: 2 });
  let planted = 0;
  // Every other candidate, so the plots read as a field rather than one solid block.
  for (let k = 0; k < tiles.length && planted < TECH.fieldCount; k += 2) {
    const t = tiles[k];
    if (plantBush(world.bushes, t, { fast: true }) < 0) continue;
    world.tileState[t] = TILE_STATE.FIELD;
    world.settlement.fieldTiles.push(t);
    planted++;
  }
  return planted > 0;
}

function buildTower(world) {
  const tiles = freeTilesNear(world, 4, { keepClear: 1 });
  if (!tiles.length) return false;
  // The farthest candidate from the first hut: a tower on the village edge watches the
  // approach rather than the hearth.
  const origin = world.settlement.huts[0];
  let best = tiles[0]; let bestD = -1;
  for (const t of tiles) {
    const d = Math.hypot(tileX(t, world.terrain.size) + 0.5 - origin.x, tileZ(t, world.terrain.size) + 0.5 - origin.z);
    if (d > bestD) { bestD = d; best = t; }
  }
  world.tileState[best] = TILE_STATE.TOWER;
  world.settlement.towerTile = best;
  return true;
}

/**
 * Keep the works standing: a rockslide or lava that buried the campfire or tower leaves a
 * dangling pointer, and a tribe that has the tier rebuilds. Returns true when a solid tile
 * changed (the caller rebuilds the shore field).
 */
export function maintainWorks(world) {
  const { settlement, tileState } = world;
  let solidChanged = false;
  if (settlement.tech >= TECH_LEVEL.FIRE) {
    if (settlement.campfireTile !== NONE && tileState[settlement.campfireTile] !== TILE_STATE.CAMPFIRE) settlement.campfireTile = NONE;
    if (settlement.campfireTile === NONE) placeCampfire(world);
  }
  if (settlement.tech >= TECH_LEVEL.WATCHTOWER) {
    if (settlement.towerTile !== NONE && tileState[settlement.towerTile] !== TILE_STATE.TOWER) settlement.towerTile = NONE;
    if (settlement.towerTile === NONE && buildTower(world)) solidChanged = true;
  }
  return solidChanged;
}

/**
 * Try to climb one tier. Returns { level, text, tile, solidChanged } when a tier was
 * reached, else null. `text` is the log line; `tile` positions the HUD reaction.
 */
export function advanceTech(world, ctx, tribe) {
  const { settlement } = world;
  if (!nextTierReady(settlement, ctx)) return null;
  const level = settlement.tech + 1;
  let built = false; let solidChanged = false;
  switch (level) {
    case TECH_LEVEL.FIRE: built = placeCampfire(world); break;
    case TECH_LEVEL.PALISADE: built = raisePalisade(world); solidChanged = built; break;
    case TECH_LEVEL.FARMING: built = plantFields(world); break;
    case TECH_LEVEL.WATCHTOWER: built = buildTower(world); solidChanged = built; break;
    default: return null;
  }
  if (!built) return null;   // nowhere to build yet — try again next second
  settlement.tech = level;
  const tile = level === TECH_LEVEL.FIRE ? settlement.campfireTile : level === TECH_LEVEL.WATCHTOWER ? settlement.towerTile : settlement.huts[0]?.tile ?? NONE;
  return { level, text: `The ${tribe} tribe ${TECH_DEEDS[level]}`, tile, solidChanged };
}

/** Metres from (x, z) to the campfire, Infinity when there is none. */
export function campfireDistance(world, x, z) {
  const t = world.settlement.campfireTile;
  if (t === NONE) return Infinity;
  const size = world.terrain.size;
  return Math.hypot(tileX(t, size) + 0.5 - x, tileZ(t, size) + 0.5 - z);
}

export const hasTower = (settlement) => settlement.tech >= TECH_LEVEL.WATCHTOWER && settlement.towerTile !== NONE;
