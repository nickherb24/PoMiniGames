// rockslide.js — the deterministic form: rocks launch from a ridge tile. Kills are
// decided by an ANALYTIC plan — each rock's impact point comes from marching its parabola
// against the heightmap, then a downhill corridor from the impact tile — so the outcome
// depends only on sim state and the events stream. The cannon-es rocks get the same launch
// velocities and so land near the same spots; the settled boulder that blocks the corridor
// end is placed by the plan, not by where a body happens to rest.
import { EVENTS, PHYSICS, TICK_SECONDS } from '../core/config.js';
import { downhillNeighbour } from '../terrain/pathing.js';
import { TILE, TILE_STATE, isWalkable, tileIndex, tileX, tileZ } from '../terrain/tiles.js';
import { paintFear } from './lightning.js';

const secs = (s) => Math.round(s / TICK_SECONDS);

/** A hill/mountain tile with somewhere to roll to. */
export function pickRidgeTile(terrain, rng) {
  const { type } = terrain;
  const candidates = [];
  for (let i = 0; i < type.length; i++) {
    if ((type[i] === TILE.HILL || type[i] === TILE.MOUNTAIN) && downhillNeighbour(terrain, i) !== i) candidates.push(i);
  }
  return candidates.length ? candidates[rng.int(candidates.length)] : -1;
}

/**
 * Plan a launch. `originTile` fixes where the rocks come from (the volcano crater passes
 * its own tile); by default a random ridge is chosen. The impact points and corridors are
 * derived FROM that origin, so they always match what the player sees flying.
 */
export function planRockslide(terrain, rng, tick, cfg = EVENTS.rockslide, originTile = -1) {
  const { size } = terrain;
  const ridgeTile = originTile >= 0 ? originTile : pickRidgeTile(terrain, rng);
  if (ridgeTile < 0) return { ridgeTile, rocks: [] };
  const rx = tileX(ridgeTile, size) + 0.5; const rz = tileZ(ridgeTile, size) + 0.5;
  const ry = terrain.tileHeight(ridgeTile) + 1;
  const count = cfg.count[0] + rng.int(cfg.count[1] - cfg.count[0] + 1);
  const rocks = [];
  for (let k = 0; k < count; k++) {
    const a = rng.range(0, Math.PI * 2);
    const speed = rng.range(cfg.speed[0], cfg.speed[1]);
    const vy = rng.range(cfg.up[0], cfg.up[1]);
    const vx = Math.cos(a) * speed; const vz = Math.sin(a) * speed;
    const big = rng.next() < 0.3;
    // March the parabola until it meets the ground (same gravity as the physics world).
    let x = rx; let y = ry; let z = rz; let v = vy; let ticks = 0;
    const dt = TICK_SECONDS;
    while (ticks < secs(10)) {
      ticks++;
      x += vx * dt; z += vz * dt; v -= PHYSICS.gravity * dt; y += v * dt;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) break;
      if (y <= terrain.heightAt(x, z)) break;
    }
    const impactTile = tileIndex(x, z, size);
    const corridor = [impactTile];   // a Set of the same tiles is built below for the per-creature test
    let cur = impactTile;
    for (let s = 0; s < cfg.rollTiles; s++) {
      const nxt = downhillNeighbour(terrain, cur);
      if (nxt === cur) break;
      corridor.push(nxt);
      cur = nxt;
    }
    const impactTick = tick + ticks;
    rocks.push({ x: rx, y: ry, z: rz, vx, vy, vz, big, impactX: x, impactZ: z, impactTick, corridor, corridorSet: new Set(corridor), endTick: impactTick + secs(cfg.rollSeconds) });
  }
  return { ridgeTile, rocks };
}

/** Plan a rockslide, register its corridors with the world, launch the visual rocks, log it. */
export function triggerRockslide(world, rng, cfg = EVENTS.rockslide) {
  const plan = planRockslide(world.terrain, rng, world.clock.tick, cfg);
  if (plan.ridgeTile < 0) return plan;
  for (const r of plan.rocks) world.corridors.push(r);
  world.physics.spawnRocks({ rocks: plan.rocks.map(r => ({ x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz, big: r.big })) }, world.streams.cosmetic);
  paintFear(world, plan.rocks[0].x, plan.rocks[0].z, cfg.fearRadius);
  world.log.push({ tick: world.clock.tick, kind: 'rockslide', tile: plan.ridgeTile, text: `Rockslide on the ${world.terrain.type[plan.ridgeTile] === TILE.MOUNTAIN ? 'mountain' : 'hills'} — ${plan.rocks.length} rocks` });
  return plan;
}

/**
 * Advance every active corridor by one tick: kill at the impact point on the impact tick,
 * kill on corridor tiles during the roll window, and drop a boulder at the end. Returns
 * true when a tile state changed (the caller rebuilds its distance fields).
 */
export function stepCorridors(world, cfg = EVENTS.rockslide) {
  const { entities: e, corridors, terrain, tileState, boulders, clock } = world;
  const tick = clock.tick;
  let changed = false;
  for (let k = corridors.length - 1; k >= 0; k--) {
    const r = corridors[k];
    if (tick < r.impactTick) continue;
    const victims = [];
    if (tick === r.impactTick) {
      e.forEachAlive(i => { if (Math.hypot(e.x[i] - r.impactX, e.z[i] - r.impactZ) <= cfg.impactRadius) victims.push(i); });
    }
    if (tick <= r.endTick) {
      const tiles = r.corridorSet ?? (r.corridorSet = new Set(r.corridor));
      e.forEachAlive(i => {
        if (victims.includes(i)) return;
        if (tiles.has(tileIndex(e.x[i], e.z[i], terrain.size))) victims.push(i);
      });
    }
    victims.sort((a, b) => a - b);
    for (const i of victims) if (e.alive[i]) world.kill(i, r.cause ?? 'rockfall');
    if (tick >= r.endTick) {
      const end = r.corridor[r.corridor.length - 1];
      if (isWalkable(terrain.type[end]) && tileState[end] === TILE_STATE.NORMAL) {
        tileState[end] = TILE_STATE.BOULDER;
        boulders.push({ tile: end, clearTick: tick + secs(cfg.boulderSeconds) });
        changed = true;
      }
      corridors.splice(k, 1);
    }
  }
  for (let k = boulders.length - 1; k >= 0; k--) {
    if (tick >= boulders[k].clearTick) {
      if (tileState[boulders[k].tile] === TILE_STATE.BOULDER) tileState[boulders[k].tile] = TILE_STATE.NORMAL;
      boulders.splice(k, 1);
      changed = true;
    }
  }
  return changed;
}
