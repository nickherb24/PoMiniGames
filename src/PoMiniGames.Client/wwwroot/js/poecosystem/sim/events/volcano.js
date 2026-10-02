// volcano.js — the eruption: a blast at the crater, ballistic projectiles that
// reuse the rockslide's analytic impact/corridor rule (cause: eruption), lava that creeps
// downhill for EVENTS.volcano.lavaSeconds then cools to rock, and a wide fear radius.
import { EVENTS, TICK_SECONDS } from '../core/config.js';
import { DEATH_CAUSE } from '../creatures/lifecycle.js';
import { downhillNeighbour } from '../terrain/pathing.js';
import { NEIGHBOURS4, NEIGHBOURS8, TILE_STATE, isWalkable, isWater, tileX, tileZ } from '../terrain/tiles.js';
import { paintFear } from './lightning.js';
import { planRockslide } from './rockslide.js';

const secs = (s) => Math.round(s / TICK_SECONDS);

export function erupt(world, cfg = EVENTS.volcano) {
  const { terrain, entities: e, clock, log, streams } = world;
  const v = terrain.volcanoTile;
  const cx = tileX(v, terrain.size) + 0.5; const cz = tileZ(v, terrain.size) + 0.5;
  const cy = terrain.tileHeight(v);
  const tick = clock.tick;

  const victims = [];
  e.forEachAlive(i => { if (Math.hypot(e.x[i] - cx, e.z[i] - cz) <= cfg.blastRadius) victims.push(i); });
  for (const i of victims) world.kill(i, DEATH_CAUSE.ERUPTION);
  world.physics.explode({ x: cx, y: cy, z: cz, radius: cfg.blastRadius, strength: cfg.strength });

  // Projectiles: planned exactly like a rockslide but ANCHORED TO THE CRATER, so the
  // analytic impact points and corridors match the arcs the player watches.
  const plan = planRockslide(terrain, streams.events, tick, {
    ...EVENTS.rockslide, count: cfg.projectiles, speed: cfg.speed, up: cfg.up,
  }, v);
  for (const r of plan.rocks) { r.cause = DEATH_CAUSE.ERUPTION; world.corridors.push(r); }
  world.physics.spawnRocks({ projectile: true, rocks: plan.rocks.map(r => ({ x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz, big: r.big })) }, streams.cosmetic);

  // Lava starts in the crater and creeps downhill from there.
  world.lava = { front: [v], tiles: [], endTick: tick + secs(cfg.lavaSeconds), nextCreep: tick };
  placeLava(world, v);

  paintFear(world, cx, cz, cfg.fearRadius);
  log.push({ tick, kind: 'eruption', tile: v, text: `The volcano erupted${victims.length ? ` — ${victims.length} killed` : ''}` });
  return { victims: victims.length, projectiles: plan.rocks.length };
}

function placeLava(world, tile) {
  const { tileState, grass, trees, bushes, lava } = world;
  if (tileState[tile] === TILE_STATE.LAVA) return false;
  tileState[tile] = TILE_STATE.LAVA;
  grass.biomass[tile] = 0;
  const k = trees.byTile[tile];
  if (k >= 0) { trees.state[k] = 1; trees.regrow[k] = 1e9; } // a tree under lava never regrows
  const b = bushes.byTile[tile];
  if (b >= 0) bushes.ripeness[b] = 0;
  lava.tiles.push(tile);
  lava.front.push(tile);
  return true;
}

/** Advance the lava: creep once per creepSeconds, cool everything at endTick. Returns true when tiles changed. */
export function stepLava(world, cfg = EVENTS.volcano) {
  const lava = world.lava;
  if (!lava) return false;
  const { terrain, tileState, clock, streams } = world;
  const { size, type } = terrain;
  const tick = clock.tick;
  let changed = false;

  if (tick >= lava.endTick) {
    for (const t of lava.tiles) if (tileState[t] === TILE_STATE.LAVA) tileState[t] = TILE_STATE.COOLED;
    world.lava = null;
    return true;
  }
  if (tick < lava.nextCreep) return false;
  lava.nextCreep = tick + secs(cfg.creepSeconds);

  const front = lava.front.slice();
  lava.front.length = 0;
  for (const cur of front) {
    if (lava.tiles.length >= cfg.maxLavaTiles) break;
    const nxt = downhillNeighbour(terrain, cur);
    const x = tileX(cur, size); const z = tileZ(cur, size);
    const ok = (t) => t !== cur && !isWater(type[t]) && tileState[t] !== TILE_STATE.LAVA && tileState[t] !== TILE_STATE.COOLED;
    if (ok(nxt)) { placeLava(world, nxt); changed = true; }
    if (streams.events.next() < cfg.branchChance) {
      // A second, lower neighbour in fixed order: the first one below the current tile.
      const h = terrain.tileHeight(cur);
      for (const [dx, dz] of NEIGHBOURS8) {
        const nx = x + dx; const nz = z + dz;
        if (nx < 1 || nz < 1 || nx >= size - 1 || nz >= size - 1) continue;
        const t = nz * size + nx;
        if (t === nxt || !ok(t) || terrain.tileHeight(t) >= h) continue;
        placeLava(world, t); changed = true; break;
      }
    }
    // Neighbouring flammable tiles catch fire from the heat.
    for (const [dx, dz] of NEIGHBOURS4) {
      const nx = x + dx; const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const t = nz * size + nx;
      if (isWalkable(type[t]) && tileState[t] === TILE_STATE.NORMAL && streams.events.next() < 0.5) world.ignite(t);
    }
  }
  if (lava.front.length === 0) lava.front.push(...lava.tiles.slice(-1));
  return changed;
}
