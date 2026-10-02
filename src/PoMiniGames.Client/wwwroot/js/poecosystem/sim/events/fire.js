// fire.js — cellular fire: a burning tile spreads to flammable 4-neighbours
// with a per-second chance (grass scaled by its biomass, so grazed ground is a firebreak),
// burns for EVENTS.fireSeconds, leaves a burnt tile that recovers later. Water, sand and
// rock never burn. Draws come from the events stream in tile order, so it is deterministic.
import { EVENTS, TICK_SECONDS } from '../core/config.js';
import { NEIGHBOURS4, TILE, TILE_STATE, isFlammable, tileX, tileZ } from '../terrain/tiles.js';

const secs = (s) => Math.round(s / TICK_SECONDS);

export function stepFire(world, cfg = EVENTS) {
  const { fires, burnt, tileState, terrain, grass, bushes, streams } = world;
  const { size, type } = terrain;
  const rng = streams.events;
  const dt = TICK_SECONDS;
  // Weather (events/weather.js): rain and snow douse, a drought spreads. Both are exactly
  // 1 under clear skies, so a world without weather burns as it always did.
  const spreadMul = world.weather?.effects.fireSpread ?? 1;
  const burnout = world.weather?.effects.fireBurnout ?? 1;

  // Spread from the tiles burning at the start of this tick only.
  const burning = fires.length;
  for (let k = 0; k < burning && fires.length < cfg.fire.maxBurning; k++) {
    const f = fires[k];
    const x = tileX(f.tile, size); const z = tileZ(f.tile, size);
    for (const [dx, dz] of NEIGHBOURS4) {
      const nx = x + dx; const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const n = nz * size + nx;
      if (!isFlammable(type[n])) continue;
      const s = tileState[n];
      if (s !== TILE_STATE.NORMAL && s !== TILE_STATE.STUMP) continue;
      const rate = type[n] === TILE.FOREST ? cfg.fire.spreadPerSecond.forest : cfg.fire.spreadPerSecond.grass * grass.biomass[n];
      if (rate > 0 && rng.next() < rate * spreadMul * dt) world.ignite(n);
    }
  }

  // Burn down, then recover.
  for (let k = fires.length - 1; k >= 0; k--) {
    const f = fires[k];
    f.ticksLeft -= burnout;
    if (f.ticksLeft > 0) continue;
    tileState[f.tile] = TILE_STATE.BURNT;
    grass.biomass[f.tile] = 0;
    const b = bushes.byTile[f.tile];
    if (b >= 0) bushes.ripeness[b] = 0;
    burnt.push({ tile: f.tile, ticksLeft: secs(cfg.burntSeconds) });
    fires.splice(k, 1);
  }
  for (let k = burnt.length - 1; k >= 0; k--) {
    const b = burnt[k];
    if (--b.ticksLeft > 0) continue;
    if (tileState[b.tile] === TILE_STATE.BURNT) tileState[b.tile] = TILE_STATE.NORMAL;
    burnt.splice(k, 1);
  }
}
