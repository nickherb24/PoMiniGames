// utility.js — goal selection. Every goal is scored from drives × traits ×
// what the creature perceives (`ctx`, built by world.js each re-score); the best wins
// unless the current goal is within the hysteresis margin, which stops dithering.
// Traits are read through effectiveTrait so LLM nudges act here and only here.
import { BEHAVIOR, TICK_SECONDS } from '../core/config.js';
import { NONE } from '../core/entities.js';
import { LIFE_STAGE } from '../creatures/lifecycle.js';
import { SPECIES } from '../creatures/species.js';
import { TRAIT, effectiveTrait } from '../creatures/traits.js';

export const GOAL = Object.freeze({
  WANDER: 0, EAT: 1, DRINK: 2, FLEE: 3, HUNT: 4, MATE: 5, FOLLOW_PARENT: 6, RETURN_HOME: 7, CHOP: 8, BUILD: 9, REST: 10,
});
export const GOAL_NAMES = Object.freeze(['Wandering', 'Eating', 'Drinking', 'Fleeing', 'Hunting', 'Seeking a mate', 'Following a parent', 'Heading home', 'Chopping wood', 'Building a hut', 'Resting']);
const GOAL_COUNT = 11;

const near = (d, radius) => (d === Infinity || d === undefined ? 0 : d <= 0 ? 1 : d >= radius ? 0 : 1 - d / radius);

function fitToMate(e, i, tick) {
  if (e.lifeStage[i] === LIFE_STAGE.JUVENILE) return false;
  if (e.hunger[i] >= 0.6 || e.thirst[i] >= 0.6 || e.health[i] <= 0.5) return false;
  if (e.gestationEndTick[i] > tick) return false;
  const cooldown = Math.round(SPECIES[e.species[i]].mateCooldownSeconds / TICK_SECONDS);
  return e.lastMateTick[i] === NONE || tick - e.lastMateTick[i] >= cooldown;
}

/**
 * ctx fields (distances in metres, Infinity when nothing perceived):
 * tick, threatDist, foodDist, carcassDist, preyDist, waterDist, mateDist, parentDist,
 * homeDist, treeDist, night, hasHome, needsHut, logsCarried, fear (0..1 from the tile).
 */
export function scoreGoals(e, i, ctx) {
  const s = new Float32Array(GOAL_COUNT);
  const sp = SPECIES[e.species[i]];
  const tick = ctx.tick ?? 0;
  const h = e.hunger[i]; const t = e.thirst[i];
  const bold = effectiveTrait(e, i, TRAIT.BOLDNESS, tick);
  const social = effectiveTrait(e, i, TRAIT.SOCIABILITY, tick);
  const curious = effectiveTrait(e, i, TRAIT.CURIOSITY, tick);
  const greed = effectiveTrait(e, i, TRAIT.GREED, tick);
  const diligent = effectiveTrait(e, i, TRAIT.DILIGENCE, tick);
  const fear = ctx.fear ?? 0;

  s[GOAL.WANDER] = 0.15 + 0.15 * curious;
  // Resting is for the fed: a hungry creature never sleeps through a meal.
  s[GOAL.REST] = (1 - h) * (1 - t) * (0.2 + (ctx.night ? 0.25 : 0));

  // Flee peaks at 0.935 (bold 0.5) with the threat on top of the creature and falls off by
  // 15 m, so a very thirsty animal will still risk the shore (drink can reach 1.0).
  if (ctx.threatDist !== Infinity) s[GOAL.FLEE] = (0.5 + 1.0 * near(ctx.threatDist, 15)) * (1.15 - 0.6 * bold);
  s[GOAL.FLEE] += fear * 0.6;

  const foodDist = Math.min(ctx.foodDist ?? Infinity, sp.carnivore ? (ctx.carcassDist ?? Infinity) : Infinity);
  if (foodDist !== Infinity) s[GOAL.EAT] = h * (0.45 + 0.55 * near(foodDist, 30)) * (1 + 0.1 * greed);
  // Thirst is convex so a half-thirsty animal keeps foraging instead of living on the shore.
  if (ctx.waterDist !== Infinity) s[GOAL.DRINK] = Math.pow(t, 1.5) * (0.45 + 0.55 * near(ctx.waterDist, 30));
  if (sp.carnivore && ctx.preyDist !== Infinity) s[GOAL.HUNT] = h * (0.5 + 0.5 * near(ctx.preyDist, 40)) + 0.1 * bold * h;

  if (ctx.mateDist !== Infinity && fitToMate(e, i, tick)) {
    // Reproduction must beat wandering for a comfortably fed adult (≈0.48 at hunger 0.4)
    // and lose to eating once hunger passes ~0.7 — that is what keeps a population going.
    s[GOAL.MATE] = (0.45 + 0.25 * near(ctx.mateDist, 30) + 0.1 * social) * (1 - 0.8 * Math.max(h, t));
  }
  if (e.lifeStage[i] === LIFE_STAGE.JUVENILE && ctx.parentDist !== Infinity) {
    // Low enough that a thirsty or hungry juvenile breaks off to drink or eat.
    s[GOAL.FOLLOW_PARENT] = 0.3 + 0.25 * near(ctx.parentDist, 30) + 0.1 * social;
  }

  if (sp.builds && ctx.hasHome) {
    // Home at night, but never on an empty stomach: a hungry villager keeps foraging.
    s[GOAL.RETURN_HOME] = ctx.night ? (0.35 + 0.2 * near(ctx.homeDist, 60)) * (1 - Math.max(h, t)) : 0.05;
    if (ctx.needsHut) {
      const logs = ctx.logsCarried ?? 0;
      if (logs >= 3) s[GOAL.BUILD] = 0.6 + 0.2 * near(ctx.homeDist, 50);
      else s[GOAL.CHOP] = (0.3 + 0.3 * near(ctx.treeDist, 50)) * (0.4 + 0.8 * diligent);
    }
  }
  return s;
}

/** Pick a goal with hysteresis, record it on the creature, and return it. */
export function chooseGoal(e, i, ctx) {
  const s = scoreGoals(e, i, ctx);
  let best = 0;
  for (let g = 1; g < GOAL_COUNT; g++) if (s[g] > s[best]) best = g;
  const current = e.goal[i];
  if (current !== best && s[current] > 0 && s[best] - s[current] < BEHAVIOR.goalHysteresis) return current;
  if (current !== best) { e.goal[i] = best; e.goalSince[i] = ctx.tick ?? 0; }
  return best;
}
