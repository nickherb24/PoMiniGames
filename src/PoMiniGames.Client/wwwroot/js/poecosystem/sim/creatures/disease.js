// disease.js — contagion. Predators and famine alone do not answer
// overcrowding, so a rabbit boom would only end when the grass did.
// A species over its DISEASE.outbreakDensity can catch a sickness; it spreads by contact
// to the same species, drains health while it lasts, and survivors are immune for a while.
//
// Stepped once a second. Draws come from the `ecology` stream only, and iteration is in
// ascending index order, so a world stays deterministic per seed with disease on.
import { DISEASE, TICK_SECONDS } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { SPECIES } from './species.js';

const secs = (s) => Math.round(s / TICK_SECONDS);

export const isSick = (e, i, tick) => e.sickUntil[i] !== NONE && tick < e.sickUntil[i];
const isImmune = (e, i, tick) => e.immuneUntil[i] !== NONE && tick < e.immuneUntil[i];

export function infect(e, i, tick) {
  if (!e.alive[i] || isSick(e, i, tick) || isImmune(e, i, tick)) return false;
  e.sickUntil[i] = tick + secs(DISEASE.sickSeconds);
  return true;
}

/**
 * One second of disease. Returns the per-species sick counts (for stats) — computed here
 * because this pass already walks every creature.
 */
export function stepDisease(world, counts) {
  const { entities: e, clock, streams, spatial, log } = world;
  const tick = clock.tick;
  const rng = streams.ecology;
  const sick = [0, 0, 0, 0];
  const spreadP = DISEASE.spreadChancePerSecond;

  // Recover or suffer, then pass it on. Collect the newly infected first so a creature
  // that caught it this second does not infect its neighbours in the same pass.
  const caught = [];
  for (let i = 0; i < e.high; i++) {
    if (!e.alive[i] || e.sickUntil[i] === NONE) continue;
    if (tick >= e.sickUntil[i]) {
      e.sickUntil[i] = NONE;
      e.immuneUntil[i] = tick + secs(DISEASE.immuneSeconds);
      continue;
    }
    sick[e.species[i]]++;
    e.health[i] -= DISEASE.damagePerSecond;
    const s = e.species[i];
    spatial.forEachInRadius(e.x[i], e.z[i], DISEASE.spreadRadius, (j) => {
      if (j === i || e.species[j] !== s || isSick(e, j, tick) || isImmune(e, j, tick)) return;
      if (rng.next() < spreadP) caught.push(j);
    });
  }
  for (const j of caught) if (infect(e, j, tick)) sick[e.species[j]]++;

  // Outbreaks: only a crowded species with no sickness already running can start one.
  if (tick % secs(DISEASE.checkEverySeconds) < secs(1)) {
    for (let s = 0; s < SPECIES.length; s++) {
      if (sick[s] > 0 || counts[s] <= DISEASE.outbreakDensity[s]) continue;
      if (rng.next() >= DISEASE.outbreakChance) continue;
      // Patient zero: the n-th living member, n drawn from the stream.
      let n = rng.int(counts[s]);
      let zero = NONE;
      for (let i = 0; i < e.high && zero === NONE; i++) {
        if (!e.alive[i] || e.species[i] !== s) continue;
        if (n-- === 0) zero = i;
      }
      if (zero === NONE || !infect(e, zero, tick)) continue;
      sick[s]++;
      const tile = Math.floor(e.z[zero]) * world.terrain.size + Math.floor(e.x[zero]);
      log.push({ tick, kind: 'outbreak', species: s, tile, text: `A sickness is spreading among the ${SPECIES[s].plural.toLowerCase()}` });
    }
  }
  return sick;
}
