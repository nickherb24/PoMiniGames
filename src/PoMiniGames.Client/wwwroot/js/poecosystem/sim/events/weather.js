// weather.js — the island's weather. The season only tints snow onto the ground and
// changes nothing a creature can feel; weather does. A spell is one of five kinds; it scales grass growth, bush ripening, thirst
// and fire, and a storm throws its own lightning. Nothing outside the sim can set it: the
// island is observed, never steered.
//
// Stepped once a second from world.step. Every draw comes from the dedicated `weather`
// stream, so weather never shifts an event, birth or name.
import { TICK_SECONDS, WEATHER } from '../core/config.js';

export const WEATHER_KIND = Object.freeze({ CLEAR: 0, RAIN: 1, STORM: 2, DROUGHT: 3, SNOW: 4 });
export const WEATHER_NAMES = Object.freeze(['Clear', 'Rain', 'Storm', 'Drought', 'Snow']);
const OPENERS = Object.freeze([
  'The sky cleared', 'Rain began to fall', 'A storm rolled in', 'A drought settled over the island', 'Snow began to fall',
]);

const secs = (s) => Math.round(s / TICK_SECONDS);

export function createWeather() {
  return {
    kind: WEATHER_KIND.CLEAR, since: 0, endTick: secs(WEATHER.spellSeconds[0]),
    intensity: 0, wetness: 0.5, lastSeason: 0,
    // The multipliers the rest of the sim reads, refreshed on every step.
    effects: { grass: 1, bush: 1, thirst: 1, fireBurnout: 1, fireSpread: 1 },
    counts: [0, 0, 0, 0, 0],   // spells begun, by kind (almanac + milestones)
  };
}

function pickKind(rng, season) {
  const w = WEATHER.seasonWeights[season] ?? WEATHER.seasonWeights[0];
  let total = 0;
  for (const v of w) total += v;
  let r = rng.next() * total;
  for (let k = 0; k < w.length; k++) { r -= w[k]; if (r < 0) return k; }
  return WEATHER_KIND.CLEAR;
}

function begin(world, weather, kind, seconds) {
  const tick = world.clock.tick;
  const changed = kind !== weather.kind;
  weather.kind = kind;
  weather.since = tick;
  weather.endTick = tick + secs(seconds);
  if (!changed) return;
  weather.counts[kind] = (weather.counts[kind] ?? 0) + 1;
  // Clear skies after clear skies is not news; any other change is logged so the timeline
  // and the chronicler can tell a wet decade from a dry one.
  world.log.push({ tick, kind: 'weather', weather: kind, text: OPENERS[kind] });
}

const lerp1 = (table, kind, t) => 1 + ((table[kind] ?? 1) - 1) * t;

/** The multipliers follow (kind, intensity) alone, so a restored world recomputes them exactly. */
function refreshEffects(w) {
  const t = w.intensity;
  w.effects.grass = lerp1(WEATHER.grassGrowth, w.kind, t);
  w.effects.bush = lerp1(WEATHER.bushRipen, w.kind, t);
  w.effects.thirst = lerp1(WEATHER.thirst, w.kind, t);
  w.effects.fireBurnout = lerp1(WEATHER.fireBurnout, w.kind, t);
  w.effects.fireSpread = lerp1(WEATHER.fireSpread, w.kind, t);
}

/** Once a second. Rolls the next spell, eases intensity, and refreshes the multipliers. */
export function stepWeather(world) {
  const w = world.weather;
  const tick = world.clock.tick;
  const season = world.clock.season();
  const rng = world.streams.weather;

  // A new season closes a natural spell it would never have rolled (snow into spring).
  if (season !== w.lastSeason) {
    w.lastSeason = season;
    if ((WEATHER.seasonWeights[season]?.[w.kind] ?? 0) === 0) w.endTick = tick;
  }
  if (tick >= w.endTick) {
    const [lo, hi] = WEATHER.spellSeconds;
    begin(world, w, pickKind(rng, season), lo + rng.next() * (hi - lo));
  }

  const ease = secs(WEATHER.easeSeconds);
  const rise = Math.min(1, (tick - w.since) / ease);
  const fall = Math.min(1, Math.max(0, (w.endTick - tick) / ease));
  w.intensity = w.kind === WEATHER_KIND.CLEAR ? 0 : Math.max(0, Math.min(rise, fall));

  const t = w.intensity;
  refreshEffects(w);

  // Soil moisture: rain soaks, drought bakes, clear skies drift back to the middle.
  const dw = w.kind === WEATHER_KIND.CLEAR ? (0.5 - w.wetness) * 0.01 : (WEATHER.wetnessPerSecond[w.kind] ?? 0) * t;
  w.wetness = Math.max(0, Math.min(1, w.wetness + dw));

  // A storm is where lightning comes from; the natural scheduler still fires its own.
  if (w.kind === WEATHER_KIND.STORM && t > 0.5 && rng.next() < WEATHER.stormStrikeChancePerSecond) return 'strike';
  return null;
}

export function weatherTelemetry(w) {
  return {
    kind: w.kind, name: WEATHER_NAMES[w.kind] ?? 'Clear', intensity: Math.round(w.intensity * 100) / 100,
    wetness: Math.round(w.wetness * 100) / 100, counts: w.counts.slice(),
  };
}

export function getWeatherState(w) {
  return { kind: w.kind, since: w.since, endTick: w.endTick, intensity: w.intensity, wetness: w.wetness, lastSeason: w.lastSeason, counts: w.counts.slice() };
}

export function setWeatherState(w, s) {
  if (!s) return;
  w.kind = s.kind | 0; w.since = s.since | 0; w.endTick = s.endTick | 0;
  w.intensity = Number.isFinite(s.intensity) ? s.intensity : 0;
  w.wetness = Number.isFinite(s.wetness) ? s.wetness : 0.5;
  w.lastSeason = s.lastSeason | 0;
  w.counts = Array.isArray(s.counts) ? s.counts.slice(0, 5) : [0, 0, 0, 0, 0];
  while (w.counts.length < 5) w.counts.push(0);
  refreshEffects(w);
}

/** Triggers a catastrophic drought weather catastrophe that parches the island. */
export function triggerCatastrophicDrought(world, durationSeconds = 30) {
  const w = world.weather;
  const tick = world.clock.tick;
  w.kind = WEATHER_KIND.DROUGHT;
  w.since = tick;
  w.endTick = tick + secs(durationSeconds);
  w.intensity = 1.0;
  w.wetness = 0;
  w.counts[WEATHER_KIND.DROUGHT] = (w.counts[WEATHER_KIND.DROUGHT] ?? 0) + 1;
  refreshEffects(w);
  w.effects.grass = 0;
  w.effects.bush = 0;
  w.effects.thirst = 2.0;
  world.log.push({ tick, kind: 'weather', weather: WEATHER_KIND.DROUGHT, text: 'A catastrophic drought dried up the land of vegetation' });
  world.bus.emit('catastrophe', { kind: 'drought', text: 'A catastrophic drought has dried up the island!' });
}
