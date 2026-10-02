// lightning.js — a strike on one tile: creatures within killRadius die and are
// launched as ragdolls, trees within treeRadius burn, the tile ignites, the area is
// frightened, and the physics world gets a radial impulse. Deaths are decided on sim
// positions, never on physics contacts.
import { EVENTS } from '../core/config.js';
import { DEATH_CAUSE } from '../creatures/lifecycle.js';
import { burnTree, TREE_STATE } from '../flora/trees.js';
import { TILE, tileIndex, tileX, tileZ } from '../terrain/tiles.js';

const BIOME_NAME = ['the sea', 'the beach', 'the grassland', 'the forest', 'the hills', 'the mountain', 'the lake', 'the volcano'];

/** Paint fear = max(fear, 1 − d/radius) on tiles around a centre. */
export function paintFear(world, cx, cz, radius) {
  const { size } = world.terrain;
  const r = Math.ceil(radius);
  const tx = Math.floor(cx); const tz = Math.floor(cz);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = tx + dx; const z = tz + dz;
      if (x < 0 || z < 0 || x >= size || z >= size) continue;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const i = z * size + x;
      const f = 1 - d / radius;
      if (f > world.fear[i]) world.fear[i] = f;
    }
  }
}

export function strikeLightning(world, tile, _rng, cfg = EVENTS.lightning) {
  const { terrain, entities: e, trees, tileState, log, clock } = world;
  const { size } = terrain;
  const cx = tileX(tile, size) + 0.5; const cz = tileZ(tile, size) + 0.5;
  const cy = terrain.heightAt(cx, cz);

  const victims = [];
  e.forEachAlive(i => { if (Math.hypot(e.x[i] - cx, e.z[i] - cz) <= cfg.killRadius) victims.push(i); });
  for (const i of victims) world.kill(i, DEATH_CAUSE.LIGHTNING);

  const r = Math.ceil(cfg.treeRadius);
  let felled = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.hypot(dx, dz) > cfg.treeRadius) continue;
      const t = tileIndex(tileX(tile, size) + dx, tileZ(tile, size) + dz, size);
      const k = trees.byTile[t];
      if (k >= 0 && trees.state[k] === TREE_STATE.STANDING) {
        burnTree(trees, k, tileState);
        world.physics.fellTree({ x: tileX(t, size) + 0.5, y: terrain.tileHeight(t), z: tileZ(t, size) + 0.5, dirX: tileX(t, size) + 0.5 - cx, dirZ: tileZ(t, size) + 0.5 - cz }, world.streams.cosmetic);
        felled++;
      }
    }
  }
  world.ignite(tile, true);
  paintFear(world, cx, cz, cfg.fearRadius);
  world.physics.explode({ x: cx, y: cy, z: cz, radius: cfg.killRadius, strength: cfg.strength });
  log.push({
    tick: clock.tick, kind: 'lightning', tile,
    text: `Lightning struck ${BIOME_NAME[terrain.type[tile]] ?? 'the island'}${victims.length ? ` — ${victims.length} killed` : ''}${felled ? `, ${felled} tree${felled > 1 ? 's' : ''} felled` : ''}`,
  });
  return { victims: victims.length, felled };
}

/** A land tile to strike, favouring forest and grassland (events stream). */
export function pickStrikeTile(terrain, rng) {
  const { type } = terrain;
  const candidates = [];
  for (let i = 0; i < type.length; i++) if (type[i] === TILE.FOREST || type[i] === TILE.GRASS || type[i] === TILE.HILL) candidates.push(i);
  return candidates.length ? candidates[rng.int(candidates.length)] : -1;
}
