// prompt.js — what the LLM is told about a creature (≤ 600 chars). The model is
// asked for one bounded JSON object; nudges.js re-validates whatever comes back.
import { THOUGHTS, TRAITS } from '../core/config.js';
import { LIFE_STAGE } from '../creatures/lifecycle.js';
import { SPECIES } from '../creatures/species.js';
import { effectiveTrait } from '../creatures/traits.js';
import { GOAL_NAMES } from '../behavior/utility.js';

export const SYSTEM_PROMPT =
  'You voice the inner thoughts of one animal on a small island. Reply with ONLY this JSON, nothing else: '
  + '{"thought": "<one short first-person sentence>", "trait": "<one of boldness|sociability|curiosity|greed|diligence>", "delta": <number from -0.25 to 0.25>}. '
  + 'The delta nudges that trait for a minute.';

const STAGE = ['young', 'adult', 'old'];
const pct = (v) => `${Math.round(v * 100)}%`;
const m = (d) => (d === Infinity || d === undefined ? 'none' : `${Math.round(d)}m`);

export function buildPrompt(world, i) {
  const e = world.entities;
  const sp = SPECIES[e.species[i]];
  const tick = world.clock.tick;
  const traits = TRAITS.map((t, k) => `${t} ${effectiveTrait(e, i, k, tick).toFixed(2)}`).join(', ');
  const s = world.senses(i);
  const name = e.names[i];
  const handle = e.handle(i);
  const grievance = world.lineage?.getAncestorGrievance?.(handle);
  const recent = world.log.all().filter(ev => ev.text && ev.text.includes(name)).slice(-2).map(ev => ev.text).join('; ');
  let out = `${name}, ${STAGE[e.lifeStage[i]] ?? 'adult'} ${e.sex[i] === 1 ? 'female' : 'male'} ${sp.name.toLowerCase()}, ${e.age[i].toFixed(1)} years. `
    + `Traits: ${traits}. Hunger ${pct(e.hunger[i])}, thirst ${pct(e.thirst[i])}, health ${pct(e.health[i])}. `
    + `Now: ${GOAL_NAMES[e.goal[i]] ?? 'idle'}. Nearby: food ${m(s.foodDist)}, water ${m(s.waterDist)}, threat ${m(s.threatDist)}`
    + `${s.preyDist !== Infinity ? `, prey ${m(s.preyDist)}` : ''}${s.mateDist !== Infinity ? `, mate ${m(s.mateDist)}` : ''}. `
    + `${s.night ? 'It is night. ' : ''}${e.lifeStage[i] === LIFE_STAGE.JUVENILE ? 'Still a juvenile. ' : ''}`
    + (grievance ? `Ancestry: ${grievance}. ` : '')
    + (recent ? `Recently: ${recent}.` : '');
  if (out.length > THOUGHTS.maxPromptChars) out = out.slice(0, THOUGHTS.maxPromptChars - 1) + '…';
  return out;
}
