// social.js — herd and pack behaviour: alarms propagate through a herd,
// rabbits scatter, wolves follow a pack leader and share kills, juveniles without
// living parents are orphans.
import { BEHAVIOR } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { LIFE_STAGE } from '../creatures/lifecycle.js';
import { feed } from '../creatures/drives.js';

export const STATE = Object.freeze({ NORMAL: 0, ALERT: 1 });

/**
 * Mark `i` and same-species neighbours within `radius` as alerted at `tick`, and record
 * WHERE the danger is (`threatX/threatZ`, defaulting to the spotter). Without that, an
 * alerted creature that cannot see the predator itself has nothing to run away from.
 */
export function raiseAlarm(e, hash, i, radius, tick, threatX = e.x[i], threatZ = e.z[i]) {
  const sp = e.species[i];
  hash.forEachInRadius(e.x[i], e.z[i], radius, (j) => {
    if (e.species[j] !== sp) return;
    e.state[j] = STATE.ALERT;
    e.alertTick[j] = tick;
    e.alertX[j] = threatX;
    e.alertZ[j] = threatZ;
  });
}

export function isAlerted(e, i, tick) {
  if (e.state[i] !== STATE.ALERT) return false;
  if (tick - e.alertTick[i] > BEHAVIOR.alertTicks) { e.state[i] = STATE.NORMAL; return false; }
  return true;
}

/** Centroid of same-species neighbours (excluding self). */
export function herdCohesion(e, hash, i, radius) {
  const sp = e.species[i];
  let sx = 0; let sz = 0; let n = 0;
  hash.forEachInRadius(e.x[i], e.z[i], radius, (j) => {
    if (j === i || e.species[j] !== sp) return;
    sx += e.x[j]; sz += e.z[j]; n++;
  });
  return n === 0 ? { cx: e.x[i], cz: e.z[i], n: 0 } : { cx: sx / n, cz: sz / n, n };
}

/** Unit vector away from a threat, rotated by up to ±60° so a group fans out. */
export function scatterDirection(e, i, tx, tz, rng) {
  let dx = e.x[i] - tx; let dz = e.z[i] - tz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
  const a = (rng.next() - 0.5) * (2 * Math.PI / 3);
  const c = Math.cos(a); const s = Math.sin(a);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** Lowest-index adult of the same species within `radius`, or self. */
export function packLeader(e, hash, i, radius) {
  const sp = e.species[i];
  let leader = i;
  hash.forEachInRadius(e.x[i], e.z[i], radius, (j) => {
    if (e.species[j] !== sp || e.lifeStage[j] === LIFE_STAGE.JUVENILE) return;
    if (j < leader) leader = j;
  });
  return leader;
}

/** The killer eats half; same-species neighbours in radius split the rest. Returns creatures fed. */
export function shareKill(e, hash, killer, radius, foodValue) {
  const sp = e.species[killer];
  const others = [];
  hash.forEachInRadius(e.x[killer], e.z[killer], radius, (j) => {
    if (j !== killer && e.species[j] === sp) others.push(j);
  });
  feed(e, killer, foodValue * 0.5);
  if (others.length === 0) { feed(e, killer, foodValue * 0.5); return 1; }
  others.sort((a, b) => a - b);
  const share = foodValue * 0.5 / others.length;
  for (const j of others) feed(e, j, share);
  return 1 + others.length;
}

export function isOrphan(e, i) {
  if (e.lifeStage[i] !== LIFE_STAGE.JUVENILE) return false;
  return e.resolve(e.mother[i]) === NONE && e.resolve(e.father[i]) === NONE;
}
