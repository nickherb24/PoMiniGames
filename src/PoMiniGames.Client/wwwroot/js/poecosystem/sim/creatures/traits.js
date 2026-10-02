// traits.js — the five personality traits and the bounded LLM nudge:
// one active nudge per creature, clamped to ±NUDGE.maxDelta, decaying
// linearly to zero over NUDGE.decaySeconds. Every behaviour reads traits through
// effectiveTrait() so a nudge influences the sim only within those bounds.
import { NUDGE, TICK_SECONDS, TRAITS } from '../core/config.js';

export const TRAIT = Object.freeze({ BOLDNESS: 0, SOCIABILITY: 1, CURIOSITY: 2, GREED: 3, DILIGENCE: 4 });

const NUDGE_TICKS = Math.round(NUDGE.decaySeconds / TICK_SECONDS);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function randomTraits(rng) {
  const t = new Float32Array(TRAITS.length);
  for (let k = 0; k < TRAITS.length; k++) t[k] = rng.next();
  return t;
}

export const baseTrait = (e, i, k) => e.traits[i * TRAITS.length + k];

export function setNudge(e, i, k, delta, tick) {
  const d = delta > NUDGE.maxDelta ? NUDGE.maxDelta : delta < -NUDGE.maxDelta ? -NUDGE.maxDelta : delta;
  e.nudgeTrait[i] = k;
  e.nudgeDelta[i] = d;
  e.nudgeEndTick[i] = tick + NUDGE_TICKS;
}

/** Remaining nudge on trait k at `tick` (signed), 0 when none. */
export function activeNudge(e, i, k, tick) {
  if (e.nudgeTrait[i] !== k) return 0;
  const remaining = e.nudgeEndTick[i] - tick;
  if (remaining <= 0) return 0;
  return e.nudgeDelta[i] * (remaining / NUDGE_TICKS);
}

export function effectiveTrait(e, i, k, tick) {
  return clamp01(baseTrait(e, i, k) + activeNudge(e, i, k, tick));
}

export function dominantTrait(e, i) {
  let best = 0;
  for (let k = 1; k < TRAITS.length; k++) if (baseTrait(e, i, k) > baseTrait(e, i, best)) best = k;
  return TRAITS[best];
}
