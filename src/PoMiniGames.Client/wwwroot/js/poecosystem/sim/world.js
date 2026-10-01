// world.js — composition root. Everything the host or a test touches goes through
// createWorld(): step() advances one fixed tick, stats()/detail() read, debug() pokes.
//
// Determinism contract (SPEC §13 criterion 4): every rule below reads only sim state
// and the seeded streams. `physics` is write-only — the world tells it about deaths,
// felled trees and rocks and reads back prop poses for the frame, never for a rule.
import { BEHAVIOR, CREATURE_CAP, EVENTS, FLORA, HISTORY, POPULATION, TECH, THOUGHTS, TICK_SECONDS, TRAITS, VARIETY, WORLD } from './core/config.js';
import { createClock } from './core/clock.js';
import { NONE, createEntities } from './core/entities.js';
import { createBus, createEventLog } from './core/events.js';
import { createStreams } from './core/prng.js';
import { createSpatialHash } from './core/spatial.js';
import { generateIsland } from './terrain/island.js';
import { bfsDistanceField, descendStep, shoreTiles } from './terrain/pathing.js';
import { NEIGHBOURS8, TILE, TILE_STATE, isFlammable, isSolidState, isWalkable, tileIndex, tileX, tileZ } from './terrain/tiles.js';
import { FOOTPRINT, createGround } from './terrain/ground.js';
import { createGrass, dryUpGrass, grazeAt, stepGrass } from './flora/grass.js';
import { createBushes, dryUpBushes, isRipe, stepBushes, stripBush } from './flora/bushes.js';
import { TREE_STATE, browseTree, burnTree, chopTree, createTrees, dryUpTrees, stepTrees } from './flora/trees.js';
import { SPECIES, SPECIES_ID } from './creatures/species.js';
import { drink, feed, stepDrives } from './creatures/drives.js';
import { DEATH_CAUSE, LIFE_STAGE, checkVitals, killCreature, oldAgeDeathChance, spawnCreature, updateLifeStage } from './creatures/lifecycle.js';
import { TRAIT, activeNudge, effectiveTrait, randomTraits } from './creatures/traits.js';
import { canMate, chooseSex, inheritTraits, litterSize } from './creatures/genetics.js';
import { createNamer } from './creatures/names.js';
import { createLineage } from './creatures/lineage.js';
import { MEMORY_KIND, forget, recall, remember } from './behavior/memory.js';
import { canStand, fleeFrom, lipOf, moveCreature, refuge, seekTo, stop, wander } from './behavior/steering.js';
import { GOAL, GOAL_NAMES, chooseGoal } from './behavior/utility.js';
import { herdCohesion, isAlerted, isOrphan, packLeader, raiseAlarm, scatterDirection, shareKill } from './behavior/social.js';
import { addHut, buildHut, chooseHutSite, createSettlement, giveLogs, isNight, nearestHut, needsHut } from './behavior/humans.js';
import { TECH_NAMES, advanceTech, campfireDistance, hasTower, maintainWorks, tribeName } from './behavior/tech.js';
import { EVENT_KIND, createEventScheduler } from './events/scheduler.js';
import { pickStrikeTile, strikeLightning } from './events/lightning.js';
import { stepCorridors, triggerRockslide } from './events/rockslide.js';
import { stepFire } from './events/fire.js';
import { erupt, stepLava } from './events/volcano.js';
import { createThoughtScheduler } from './thoughts/scheduler.js';
import { buildPrompt } from './thoughts/prompt.js';
import { templateThought } from './thoughts/templates.js';
import { THOUGHT_SOURCE, applyThought } from './thoughts/nudges.js';
import { createLedger } from './telemetry/ledger.js';
import { nullPhysics } from './physics/world.js';
import { createTribeStore } from './tribe/tribeStore.js';
import { WEATHER_NAMES, createWeather, getWeatherState, setWeatherState, stepWeather, triggerCatastrophicDrought, weatherTelemetry } from './events/weather.js';
import { isSick, stepDisease } from './creatures/disease.js';

export { nullPhysics };   // re-exported: createWorld's default physics lives beside it

const GESTATION_TICKS = SPECIES.map(sp => Math.round(sp.gestationSeconds / TICK_SECONDS));
// The (2r+1)² tile offsets of a food scan, nearest first; equal distances stay in row
// order (dz, then dx), which is the tile the old full scan settled on.
const SCAN_ORDERS = new Map();
function scanOrder(r) {
  let o = SCAN_ORDERS.get(r);
  if (!o) {
    const cells = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) cells.push([Math.hypot(dx, dz), dz, dx]);
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    o = { d: Float64Array.from(cells, c => c[0]), dz: Int8Array.from(cells, c => c[1]), dx: Int8Array.from(cells, c => c[2]) };
    SCAN_ORDERS.set(r, o);
  }
  return o;
}
const HEAT_CELL = 4;        // metres per heat-grid cell (50 × 50 over the 200 m island)
const JOURNAL_MAX = 12;

/**
 * Build a world. `terrain` may be supplied when the caller has already generated the
 * island for this seed (the host builds the physics heightfield from it first) — island
 * generation is ~28 ms, so doing it twice per world is the single biggest avoidable cost
 * on the boot path.
 */
export function createWorld({ seed = 1, caps = {}, physics = null, terrain: suppliedTerrain = null } = {}) {
  const cap = caps.creatureCap ?? CREATURE_CAP;
  const streams = createStreams(seed);
  const terrain = suppliedTerrain ?? generateIsland(seed);
  const { size } = terrain;
  const tileState = new Uint8Array(size * size);
  const fear = new Float32Array(size * size);
  const grass = createGrass(terrain);
  const bushes = createBushes(terrain, streams.terrain);
  const trees = createTrees(terrain, streams.terrain);
  const settlement = createSettlement(cap);
  const tribeStore = createTribeStore(terrain, streams);
  const e = createEntities(cap);
  const clock = createClock();
  const log = createEventLog(200);
  const bus = createBus();
  const spatial = createSpatialHash(size);
  const namer = createNamer(streams.names);
  // Distance-to-drinkable-water field. Passability includes the tile state, so a hut
  // (or later a boulder / lava) on a shore tile never becomes a route creatures can't
  // take; it is rebuilt whenever such a tile changes (rare: huts, rockslides, eruptions).
  const shore = shoreTiles(terrain);
  // Water is drunk from any shore tile a creature is standing on, routed or not: the free
  // corner of a shore tile a hut mostly covers is still at the water's edge.
  const isShore = new Uint8Array(size * size);
  for (const t of shore) isShore[t] = 1;
  // Where a body may stand (terrain/ground.js): cliffs, and the footprint of everything
  // solid. Derived from the state below, never saved. The invariant the snapshot round-trip
  // rests on is that it is fresh at the end of every step — a restored world rebuilds it
  // from state — so it is refreshed with the shore field (huts, boulders, lava) and once
  // more after the once-a-second block, the only other place a solid thing appears.
  const ground = createGround(terrain);
  const refreshGround = () => ground.rebuild({ tileState, trees, bushes, settlement, buildings: tribeStore.construction.buildings });
  refreshGround();
  // A fence counts as solid here too: the field is species-agnostic, and the palisade has
  // gates, so the village stays connected to water for its builders as well. A closed tile
  // (cliff, cut-off pocket, under a building) is never routed through, so a lake is drunk
  // from where its bank is gentle and a walled-in one is not a water source at all.
  const passableTile = (i) => isWalkable(terrain.type[i]) && !isSolidState(tileState[i]) && tileState[i] !== TILE_STATE.FENCE && !ground.closed[i];
  let shoreField = bfsDistanceField(terrain, shore, passableTile);
  const rebuildShoreField = () => { refreshGround(); shoreField = bfsDistanceField(terrain, shore, passableTile); };
  // The tile to take the shore field from: the creature's own, or — on the free edge of a
  // tile the field does not enter (the corner of one a hut mostly covers) — the routed
  // tile touching it that is nearest water. NONE when there is none.
  const routedTile = (t) => {
    if (shoreField[t] >= 0) return t;
    const x = tileX(t, size); const z = tileZ(t, size);
    let best = NONE;
    for (const [dx, dz] of NEIGHBOURS8) {
      const nx = x + dx; const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const j = nz * size + nx;
      if (shoreField[j] >= 0 && (best === NONE || shoreField[j] < shoreField[best])) best = j;
    }
    return best;
  };
  const phys = physics ?? nullPhysics();
  const carcasses = [];
  let nextCarcassId = 1;
  const popHistory = [];
  // Per-creature plan: what perceive()/chooseGoal() decided at the last rescore, held as
  // handles so a target that died in between resolves to NONE and forces a rescore.
  const plans = Array.from({ length: cap }, () => ({}));
  const dirty = new Uint8Array(cap);
  const PLAN_KEYS = ['foodDist', 'foodKind', 'foodTile', 'foodIdx', 'carcassDist', 'carcassId', 'threatDist', 'threatX', 'threatZ', 'parentDist', 'homeDist', 'treeIdx'];
  function commitPlan(i, c) {
    const p = plans[i];
    for (const k of PLAN_KEYS) p[k] = c[k];
    p.prey = c.preyIdx === NONE ? NONE : e.handle(c.preyIdx);
    p.mate = c.mateIdx === NONE ? NONE : e.handle(c.mateIdx);
    p.parent = c.parentIdx === NONE ? NONE : e.handle(c.parentIdx);
    dirty[i] = 0;
  }
  const carcassIndex = (id) => { for (let k = 0; k < carcasses.length; k++) if (carcasses[k].id === id) return k; return -1; };
  const counts = [0, 0, 0, 0];
  const extinct = [false, false, false, false];
  let lastFullTick = -1e9;
  let lastStanding = NONE;
  let silent = false;
  let ended = false;
  // Natural events: the scheduler, rockslide corridors in flight, boulders blocking tiles,
  // and burning / burnt tiles (T12's fire spread extends the same lists).
  const scheduler = createEventScheduler(streams.events);
  const corridors = [];
  const boulders = [];
  const fires = [];   // { tile, ticksLeft }
  const burnt = [];   // { tile, ticksLeft }
  const secsToTicks = (s) => Math.round(s / TICK_SECONDS);
  const naturalEvents = { lightning: 0, rockslide: 0, eruption: 0, drought: 0 };
  // Thoughts: the LLM round-robin (driven by the host) and the template cadence (ours).
  const thoughtScheduler = createThoughtScheduler();
  const thoughtStats = { requested: 0, applied: 0, rejected: 0 };
  let templateCursor = 0;
  // Almanac (dashboard): lifetime counters. Pure bookkeeping — no rule reads them and no
  // RNG stream is touched, so a world stays bit-identical whether or not they run.
  const almanac = {
    born: [0, 0, 0, 0], died: [0, 0, 0, 0], byCause: {}, stages: new Array(12).fill(0),
    hutsBuilt: 0, treesFelled: 0, oldestName: '', oldestSpecies: 0, oldestAge: 0,
  };
  // Thought feed (dashboard): every thought a creature has, drained by the host at the
  // stats cadence. Reuses the event log so the id/drain machinery comes for free.
  const thoughtFeed = createEventLog(THOUGHTS.feedCap);
  // Lifetime animal telemetry: per-creature death records + the predation matrix. The
  // snapshot carries it, so a resumed world keeps its whole history (telemetry/ledger.js).
  const ledger = createLedger();
  // Family trees (creatures/lineage.js), the player's watch-list, and the per-species trait
  // means over time (the evolution chart). All three are bookkeeping the rules never read.
  const lineage = createLineage({ cap: WORLD.lineageMax });
  const watched = new Set();
  const traitHistory = [];
  const tribe = tribeName(seed);

  // ── 2026-09-23 additions: weather, disease, varieties, the timeline ──
  // All of it is the island's own doing. PoEcosystem is observed, never steered: nothing
  // here takes input from the page, and a world stays deterministic per seed.
  const weather = createWeather();
  let sick = [0, 0, 0, 0];
  // Varieties (speciation, bookkeeping only): the trait mean each species' current
  // variety was named at, and every variety the island has named.
  const varietyBase = [null, null, null, null];
  const varieties = [];
  // Landmarks: the events worth a marker on the timeline, kept apart from the 200-entry
  // log so a century of births cannot push the first campfire off the end. yearHistory is
  // one row per year — [year, rabbits, deer, wolves, humans, tech] — the coarse series the
  // timeline draws once the per-second popHistory (30 min) has scrolled past.
  const landmarks = createEventLog(HISTORY.landmarksMax);
  const yearHistory = [];
  let lastYearSampled = -1;
  // ── 2026-09-30 additions: all three are bookkeeping no rule reads and no RNG touches ──
  // Heat: where things happened, on a coarse grid (HEAT_CELL metres a cell) — deaths, kills
  // by a predator, and creature-seconds spent sick. The minimap's data layers draw these.
  const heatSide = Math.ceil(size / HEAT_CELL);
  const heat = { deaths: new Uint16Array(heatSide * heatSide), kills: new Uint16Array(heatSide * heatSide), sick: new Uint16Array(heatSide * heatSide) };
  const heatCell = (x, z) => Math.min(heatSide - 1, Math.max(0, (z / HEAT_CELL) | 0)) * heatSide + Math.min(heatSide - 1, Math.max(0, (x / HEAT_CELL) | 0));
  const warm = (grid, c) => { if (grid[c] < 65535) grid[c]++; };
  // The journal: the sagas the page had written for this island, so they travel with a save.
  const journal = [];
  // Every module logs through log.push (the tribe store, lightning, tech…), so the one
  // place to catch a landmark without touching each of them is the push itself. Weather
  // only counts when it is news — a storm or a drought.
  const LANDMARK_KINDS = new Set(['tech', 'extinction', 'eruption', 'diplomacy', 'treaty', 'variety', 'outbreak', 'legend', 'weather']);
  const pushLog = log.push;
  log.push = (ev) => {
    const entry = pushLog(ev);
    if (LANDMARK_KINDS.has(ev.kind) && (ev.kind !== 'weather' || ev.weather === 2 || ev.weather === 3)) {
      landmarks.push({ tick: entry.tick, year: clock.year(), kind: ev.kind, text: ev.text, tile: ev.tile ?? NONE });
    }
    return entry;
  };

  const tileOf = (i) => tileIndex(e.x[i], e.z[i], size);
  const centre = (t) => [tileX(t, size) + 0.5, tileZ(t, size) + 0.5];
  const dist = (i, x, z) => Math.hypot(e.x[i] - x, e.z[i] - z);
  const nameOf = (i) => e.names[i] || `${SPECIES[e.species[i]].name} #${i}`;

  // ── population bookkeeping ───────────────────────────────────────────
  function recount() {
    counts.fill(0);
    almanac.stages.fill(0);
    e.forEachAlive((i) => { counts[e.species[i]]++; almanac.stages[e.species[i] * 3 + e.lifeStage[i]]++; });
  }

  function spawn(speciesId, x, z, { age = 0, traits = null, mother = NONE, father = NONE } = {}) {
    const i = spawnCreature(e, {
      speciesId, x, z, tick: clock.tick, age, mother, father,
      sex: chooseSex(streams.genetics),
      traits: traits ?? randomTraits(streams.genetics),
      name: namer.next(speciesId),
    });
    if (i < 0) return -1;
    // Never born inside a trunk or on a cliff's lip: the nearest standing room instead.
    if (!canStand(terrain, tileState, ground, x, z, lipOf(speciesId))) {
      const at = refuge(terrain, tileState, ground, x, z, lipOf(speciesId));
      if (at) { x = at.x; z = at.z; e.x[i] = x; e.z[i] = z; }
    }
    e.y[i] = terrain.heightAt(x, z);
    e.yaw[i] = streams.genetics.range(0, Math.PI * 2);
    if (speciesId === SPECIES_ID.HUMAN) { const h = nearestHut(settlement, x, z); e.homeTile[i] = h ? h.tile : NONE; }
    counts[speciesId]++;
    dirty[i] = 1;
    lineage.born({ handle: e.handle(i), name: e.names[i], species: speciesId, sex: e.sex[i], mother, father, tick: clock.tick });
    return i;
  }

  /** Per-species mean of every base trait, -1 for an extinct species (the chart skips it). */
  function sampleTraits() {
    const sum = new Float64Array(4 * TRAITS.length); const n = [0, 0, 0, 0];
    e.forEachAlive((i) => {
      const s = e.species[i]; n[s]++;
      for (let k = 0; k < TRAITS.length; k++) sum[s * TRAITS.length + k] += e.traits[i * TRAITS.length + k];
    });
    const row = new Float32Array(4 * TRAITS.length);
    for (let s = 0; s < 4; s++) for (let k = 0; k < TRAITS.length; k++) row[s * TRAITS.length + k] = n[s] ? sum[s * TRAITS.length + k] / n[s] : -1;
    traitHistory.push(row);
    if (traitHistory.length > WORLD.traitHistoryMax) traitHistory.shift();
    noteVarieties(row, n);
  }

  // Adjectives for a trait that rose / fell, in TRAITS order.
  const VARIETY_WORDS = [['Bold', 'Timid'], ['Gregarious', 'Solitary'], ['Curious', 'Wary'], ['Greedy', 'Frugal'], ['Diligent', 'Idle']];
  /** Name a new variety when a species' mean personality has drifted far from its last one. */
  function noteVarieties(row, n) {
    const year = clock.year();
    if (year < VARIETY.settleYears) return;
    for (let s = 0; s < 4; s++) {
      if (n[s] < VARIETY.minCount) continue;
      const mean = Array.from(row.subarray(s * TRAITS.length, (s + 1) * TRAITS.length));
      const base = varietyBase[s];
      if (!base) { varietyBase[s] = mean; continue; }
      const last = varieties.findLast(v => v.species === s);
      if (last && year - last.year < VARIETY.cooldownYears) continue;
      let d2 = 0; let big = 0; let bigDelta = 0;
      for (let k = 0; k < TRAITS.length; k++) {
        const d = mean[k] - base[k]; d2 += d * d;
        if (Math.abs(d) > Math.abs(bigDelta)) { big = k; bigDelta = d; }
      }
      if (Math.sqrt(d2) < VARIETY.drift) continue;
      varietyBase[s] = mean;
      const name = `${VARIETY_WORDS[big][bigDelta > 0 ? 0 : 1]} ${SPECIES[s].plural}`;
      varieties.push({ species: s, name, tick: clock.tick, year: clock.year(), traits: mean.map(v => Math.round(v * 100) / 100) });
      if (varieties.length > VARIETY.max) varieties.shift();
      log.push({ tick: clock.tick, kind: 'variety', species: s, text: `A new variety has emerged: ${name}` });
    }
  }

  /**
   * Biodiversity: Shannon diversity H' = −Σ pᵢ ln pᵢ over the four species, and Pielou's
   * evenness J = H' / ln S (S = species alive). H' tops out at ln 4 ≈ 1.39 when all four are
   * equally common; J reads 1 for a perfectly even island and falls as one species takes over.
   */
  function biodiversity() {
    const total = counts[0] + counts[1] + counts[2] + counts[3];
    let h = 0; let alive = 0;
    for (let s = 0; s < 4; s++) {
      if (counts[s] <= 0) continue;
      alive++;
      const p = counts[s] / total;
      h -= p * Math.log(p);
    }
    const evenness = alive > 1 ? h / Math.log(alive) : 0;
    return { shannon: Math.round(h * 1000) / 1000, evenness: Math.round(evenness * 1000) / 1000, richness: alive };
  }

  const campfireXZ = () => { const t = settlement.campfireTile; return t === NONE ? null : centre(t); };

  /** Set a flammable tile burning (lightning, later lava and spread). */
  function ignite(tile, force = false) {
    if (!isFlammable(terrain.type[tile])) return false;
    const s = tileState[tile];
    if (s !== TILE_STATE.NORMAL && s !== TILE_STATE.STUMP && !(force && s === TILE_STATE.BURNT)) return false;
    tileState[tile] = TILE_STATE.FIRE;
    fires.push({ tile, ticksLeft: secsToTicks(EVENTS.fireSeconds) });
    const k = trees.byTile[tile];
    if (k >= 0 && trees.state[k] === TREE_STATE.STANDING) { burnTree(trees, k, tileState); tileState[tile] = TILE_STATE.FIRE; }
    return true;
  }

  /**
   * One definition of "may I overwrite this creature's thought?": a live LLM thought (one
   * whose nudge has not decayed yet) wins, anything else may be replaced by a template.
   * The tick cadence, detail() and thoughts.template() all go through here.
   */
  function giveTemplateThought(i) {
    if (e.lastThoughtSource[i] === THOUGHT_SOURCE.LLM && e.nudgeEndTick[i] > clock.tick) return false;
    e.lastThought[i] = templateThought(world, i, streams.cosmetic);
    e.lastThoughtSource[i] = THOUGHT_SOURCE.TEMPLATE;
    thoughtFeed.push({ tick: clock.tick, kind: 'thought', handle: e.handle(i), name: nameOf(i), species: e.species[i], source: THOUGHT_SOURCE.TEMPLATE, text: e.lastThought[i] });
    return true;
  }

  function fireNaturalEvent(kind) {
    naturalEvents[kind] = (naturalEvents[kind] ?? 0) + 1;
    if (kind === EVENT_KIND.LIGHTNING) {
      const tile = pickStrikeTile(terrain, streams.events);
      if (tile >= 0) strikeLightning(world, tile, streams.events);
    } else if (kind === EVENT_KIND.ROCKSLIDE) {
      triggerRockslide(world, streams.events);
    } else if (kind === EVENT_KIND.ERUPTION && world.erupt) {
      world.erupt();
    } else if (kind === EVENT_KIND.DROUGHT) {
      triggerCatastrophicDrought(world, EVENTS.drought?.durationSeconds ?? 30);
      dryUpGrass(grass);
      dryUpBushes(bushes);
      dryUpTrees(trees);
    }
  }

  function kill(i, cause, extra = '', killerIdx = NONE) {
    const sp = SPECIES[e.species[i]];
    // Telemetry first: killCreature below clears the slot's liveness, and the record must
    // capture the drives/position the creature had while it lived.
    const ki = killerIdx !== NONE && e.alive[killerIdx] ? killerIdx : NONE;
    ledger.death({
      name: e.names[i] || `${sp.name} #${i}`,
      species: sp.id, sex: e.sex[i],
      bornTick: e.birthTick[i], diedTick: clock.tick,
      ageYears: e.age[i], maxAgeYears: sp.maxAgeYears, cause,
      killer: ki === NONE ? null : e.species[ki], killerName: ki === NONE ? null : nameOf(ki),
      offspring: e.offspring[i], distance: e.dist[i],
      hunger: e.hunger[i], thirst: e.thirst[i],
      traits: Array.from(e.traits.subarray(i * TRAITS.length, (i + 1) * TRAITS.length)),
    });
    if (ki !== NONE) ledger.kill(e.species[ki], sp.id);
    const cell = heatCell(e.x[i], e.z[i]);
    warm(heat.deaths, cell);
    if (ki !== NONE) warm(heat.kills, cell);
    lineage.died(e.handle(i), clock.tick, cause);
    carcasses.push({ id: nextCarcassId++, x: e.x[i], z: e.z[i], species: sp.id, food: sp.foodValue * WORLD.carcassFoodFraction, expires: clock.tick + Math.round(WORLD.carcassSeconds / TICK_SECONDS) });
    phys.onDeath({ x: e.x[i], y: e.y[i], z: e.z[i], yaw: e.yaw[i], species: sp.id, scale: e.scale[i], handle: e.handle(i) }, cause, streams.cosmetic);
    bus.emit('death', { index: i, handle: e.handle(i), species: sp.id, cause });
    killCreature(e, i, cause, log, clock.tick, extra);
    settlement.carried[i] = 0;
    counts[sp.id]--;
    almanac.died[sp.id]++;
    almanac.byCause[cause] = (almanac.byCause[cause] ?? 0) + 1;
  }

  // ── initial world ────────────────────────────────────────────────────
  {
    for (let k = 0; k < POPULATION.huts; k++) {
      const site = chooseHutSite(settlement, terrain, tileState, streams.terrain, ground.closed, shoreField);
      if (site !== NONE) addHut(settlement, terrain, tileState, site);
    }
    rebuildShoreField();
    // Nobody starts on a cliff, in a cut-off pocket or under a hut.
    const grassTiles = []; const wildTiles = [];
    for (let i = 0; i < terrain.type.length; i++) {
      if (ground.closed[i]) continue;
      if (terrain.type[i] === TILE.GRASS && tileState[i] === TILE_STATE.NORMAL) grassTiles.push(i);
      else if (terrain.type[i] === TILE.FOREST || terrain.type[i] === TILE.HILL) wildTiles.push(i);
    }
    const place = (speciesId, n, pool) => {
      const sp = SPECIES[speciesId];
      for (let k = 0; k < n; k++) {
        const t = pool[streams.terrain.int(pool.length)];
        const [x, z] = centre(t);
        spawn(speciesId, x + streams.terrain.range(-0.4, 0.4), z + streams.terrain.range(-0.4, 0.4), { age: streams.genetics.range(0, sp.maxAgeYears * POPULATION.initialAgeFraction) });
      }
    };
    place(SPECIES_ID.RABBIT, POPULATION.rabbits, grassTiles);
    place(SPECIES_ID.DEER, POPULATION.deer, grassTiles);
    // Wolves start as one pack: scattered singles never meet a mate on a 200 m island.
    const denPool = wildTiles.length ? wildTiles : grassTiles;
    const den = denPool[streams.terrain.int(denPool.length)];
    const pack = [];
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
      const x = tileX(den, size) + dx; const z = tileZ(den, size) + dz;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      const t = z * size + x;
      if (isWalkable(terrain.type[t]) && tileState[t] === TILE_STATE.NORMAL && !ground.closed[t]) pack.push(t);
    }
    place(SPECIES_ID.WOLF, POPULATION.wolves, pack.length ? pack : denPool);
    const village = [];
    if (settlement.huts.length) {
      const o = settlement.huts[0];
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
        const x = tileX(o.tile, size) + dx; const z = tileZ(o.tile, size) + dz;
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        const t = z * size + x;
        if (isWalkable(terrain.type[t]) && tileState[t] === TILE_STATE.NORMAL && !ground.closed[t]) village.push(t);
      }
    }
    place(SPECIES_ID.HUMAN, POPULATION.humans, village.length ? village : grassTiles);
    recount();
    popHistory.push(counts.slice());
    sampleTraits();
  }

  // ── perception ───────────────────────────────────────────────────────
  const ctx = {};
  function perceive(i) {
    const sp = SPECIES[e.species[i]];
    const x = e.x[i]; const z = e.z[i]; const tick = clock.tick;
    const t = tileOf(i);
    ctx.tick = tick;
    ctx.threatDist = Infinity; ctx.threatX = 0; ctx.threatZ = 0;
    ctx.preyDist = Infinity; ctx.preyIdx = NONE;
    ctx.mateDist = Infinity; ctx.mateIdx = NONE;
    ctx.parentDist = Infinity; ctx.parentIdx = NONE;
    ctx.foodDist = Infinity; ctx.foodKind = ''; ctx.foodTile = NONE; ctx.foodIdx = NONE;
    ctx.carcassDist = Infinity; ctx.carcassId = NONE;
    ctx.waterDist = Infinity; ctx.homeDist = Infinity; ctx.hasHome = false; ctx.needsHut = false; ctx.logsCarried = 0;
    ctx.treeDist = Infinity; ctx.treeIdx = NONE;
    ctx.night = isNight(clock.dayFraction());
    ctx.fear = fear[t];

    const flees = sp.flees; const prey = sp.prey;
    const juvenile = e.lifeStage[i] === LIFE_STAGE.JUVENILE;
    const mother = juvenile ? e.resolve(e.mother[i]) : NONE;
    const father = juvenile ? e.resolve(e.father[i]) : NONE;
    // The watchtower (behavior/tech.js) lets the tribe see further while it stands.
    const perception = sp.builds && hasTower(settlement) ? sp.perception * TECH.towerPerceptionMultiplier : sp.perception;
    spatial.forEachInRadius(x, z, perception, (j, d2) => {
      if (j === i) return;
      const d = Math.sqrt(d2);
      const sj = e.species[j];
      const fleeAt = flees[sj];
      if (fleeAt !== undefined && d <= fleeAt && d < ctx.threatDist) { ctx.threatDist = d; ctx.threatX = e.x[j]; ctx.threatZ = e.z[j]; }
      // Anything a creature walks TO has to be at the end of a walkable line (ground.clearLine):
      // prey, a mate or a parent across a lake or below a cliff is not one it can reach.
      if (prey.includes(sj) && d < ctx.preyDist && ground.clearLine(x, z, e.x[j], e.z[j])) { ctx.preyDist = d; ctx.preyIdx = j; }
      if (sj === sp.id && e.sex[j] !== e.sex[i] && d < ctx.mateDist && !juvenile && canMate(e, i, j, tick) && ground.clearLine(x, z, e.x[j], e.z[j])) { ctx.mateDist = d; ctx.mateIdx = j; }
      if ((j === mother || j === father) && d < ctx.parentDist && ground.clearLine(x, z, e.x[j], e.z[j])) { ctx.parentDist = d; ctx.parentIdx = j; }
    });
    // Carnivores remember where they last saw prey, so a hungry wolf with nothing in
    // sight roams back toward the herds instead of random-walking the beach.
    if (ctx.preyIdx !== NONE) remember(e, i, MEMORY_KIND.FOOD, tileOf(ctx.preyIdx), tick);
    // A lit campfire scares wolves off the village (behavior/tech.js FIRE). Only wolves:
    // the herds are not afraid of a hearth, and the humans built it.
    if (sp.id === SPECIES_ID.WOLF) {
      const cd = campfireDistance(world, x, z);
      if (cd <= TECH.campfireScareRadius && cd < ctx.threatDist) { const [cx, cz] = campfireXZ(); ctx.threatDist = Math.max(1, cd); ctx.threatX = cx; ctx.threatZ = cz; }
    }
    // Alerted by a herd-mate but unable to see the predator: believe the alarm. This is a
    // perception rule, so it belongs here — senses() feeds the LLM prompt from the same
    // ctx, and would otherwise tell the model 'threat none' while the creature flees.
    if (ctx.threatDist === Infinity && isAlerted(e, i, tick)) {
      ctx.threatX = e.alertX[i]; ctx.threatZ = e.alertZ[i];
      ctx.threatDist = Math.max(1, Math.hypot(x - ctx.threatX, z - ctx.threatZ));
    }

    // Food: grass, trees, and ripe bushes in a square around the creature (herbivores + humans for berries).
    if (sp.eats.grass || sp.eats.berries || sp.eats.trees) {
      const tx = tileX(t, size); const tz = tileZ(t, size);
      // Nearest first, so the first tile that passes is the answer and the scan stops there
      // (scanOrder keeps the old tie-break). Grass is eaten standing on its tile, so a
      // closed (ground.js), fenced or built-on tile grows none that counts; a bush or a
      // tree is eaten from beside it, so the walk stops a metre short. Either way the walk
      // there has to be clear, or a grazer starves pressed against the foot of a cliff
      // with food in sight above it.
      const order = scanOrder(sp.foodScanTiles || WORLD.foodScanTiles);
      for (let k = 0; k < order.d.length; k++) {
        const xx = tx + order.dx[k]; const zz = tz + order.dz[k];
        if (xx < 0 || zz < 0 || xx >= size || zz >= size) continue;
        const tt = zz * size + xx;
        const st = tileState[tt];
        if (!isWalkable(terrain.type[tt]) || st === TILE_STATE.FIRE || st === TILE_STATE.LAVA) continue;
        if (sp.eats.grass && grass.biomass[tt] >= WORLD.foodBiomassMin && !ground.closed[tt] && st !== TILE_STATE.FENCE && !isSolidState(st)
          && ground.clearLine(x, z, xx + 0.5, zz + 0.5)) { ctx.foodDist = order.d[k]; ctx.foodKind = 'grass'; ctx.foodTile = tt; break; }
        if (sp.eats.berries) {
          const b = bushes.byTile[tt];
          if (b >= 0 && isRipe(bushes, b) && ground.clearLine(x, z, xx + 0.5, zz + 0.5, 1)) { ctx.foodDist = order.d[k]; ctx.foodKind = 'bush'; ctx.foodTile = tt; ctx.foodIdx = b; break; }
        }
        if (sp.eats.trees) {
          const tr = trees.byTile[tt];
          if (tr >= 0 && trees.state[tr] === TREE_STATE.STANDING && trees.foliage && trees.foliage[tr] >= 0.1 && ground.clearLine(x, z, xx + 0.5, zz + 0.5, 1)) {
            ctx.foodDist = order.d[k]; ctx.foodKind = 'tree'; ctx.foodTile = tt; ctx.foodIdx = tr; break;
          }
        }
      }
      if (ctx.foodDist === Infinity) {
        const mem = recall(e, i, MEMORY_KIND.FOOD, tick);
        if (mem !== NONE) {
          // A remembered meal is walked to in a straight line like any other: one that is
          // now across water or a cliff is forgotten rather than pined for.
          const [cx, cz] = centre(mem);
          if (sp.eats.grass && grass.biomass[mem] >= WORLD.foodBiomassMin && !ground.closed[mem] && ground.clearLine(x, z, cx, cz)) { ctx.foodDist = dist(i, cx, cz); ctx.foodKind = 'grass'; ctx.foodTile = mem; }
          else if (sp.eats.trees && trees.byTile[mem] >= 0 && trees.state[trees.byTile[mem]] === TREE_STATE.STANDING && trees.foliage && trees.foliage[trees.byTile[mem]] >= 0.1 && ground.clearLine(x, z, cx, cz, 1)) {
            ctx.foodDist = dist(i, cx, cz); ctx.foodKind = 'tree'; ctx.foodTile = mem; ctx.foodIdx = trees.byTile[mem];
          }
          else forget(e, i, MEMORY_KIND.FOOD);
        }
      }
    }
    if (sp.eats.carcass) {
      for (let k = 0; k < carcasses.length; k++) {
        const c = carcasses[k];
        const d = dist(i, c.x, c.z);
        if (d <= sp.perception && d < ctx.carcassDist && ground.clearLine(x, z, c.x, c.z, 1)) { ctx.carcassDist = d; ctx.carcassId = c.id; }
      }
    }
    const wt = routedTile(t);
    if (isShore[t]) ctx.waterDist = 0;
    else if (wt !== NONE) ctx.waterDist = shoreField[wt] + (wt === t ? 0 : 1);
    else {
      const mem = recall(e, i, MEMORY_KIND.WATER, tick);
      if (mem !== NONE) { const [cx, cz] = centre(mem); ctx.waterDist = dist(i, cx, cz); }
    }
    if (sp.builds) {
      const h = nearestHut(settlement, x, z);
      ctx.hasHome = !!h;
      if (h) ctx.homeDist = dist(i, h.x, h.z);
      ctx.needsHut = needsHut(settlement, counts[SPECIES_ID.HUMAN]);
      ctx.logsCarried = settlement.carried[i];
      if (ctx.needsHut && ctx.logsCarried < FLORA.logsPerTree) {
        const tx = tileX(t, size); const tz = tileZ(t, size); const r = WORLD.treeScanTiles;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          const xx = tx + dx; const zz = tz + dz;
          if (xx < 0 || zz < 0 || xx >= size || zz >= size) continue;
          const k = trees.byTile[zz * size + xx];
          if (k < 0 || trees.state[k] !== TREE_STATE.STANDING) continue;
          const d = Math.hypot(dx, dz);
          if (d < ctx.treeDist && ground.clearLine(x, z, xx + 0.5, zz + 0.5, 1)) { ctx.treeDist = d; ctx.treeIdx = k; }
        }
      }
    }
    return ctx;
  }

  // ── acting ───────────────────────────────────────────────────────────
  function act(i, goal, c, dt) {
    const sp = SPECIES[e.species[i]];
    const tick = clock.tick;
    switch (goal) {
      case GOAL.REST: stop(e, i); return;
      case GOAL.WANDER: {
        if (sp.carnivore && e.hunger[i] > 0.4) {
          // Roam: head for the last place prey was seen, otherwise sweep in long straight
          // lines at full walking speed so the search actually covers ground.
          const mem = recall(e, i, MEMORY_KIND.FOOD, tick);
          if (mem !== NONE) {
            const [cx, cz] = centre(mem);
            if (dist(i, cx, cz) < 4 || !ground.clearLine(e.x[i], e.z[i], cx, cz, 1)) forget(e, i, MEMORY_KIND.FOOD);
            else { seekTo(e, i, cx, cz, sp.walkSpeed); return; }
          }
          e.yaw[i] += (streams.behavior.next() - 0.5) * 0.15;
          e.vx[i] = Math.sin(e.yaw[i]) * sp.walkSpeed; e.vz[i] = Math.cos(e.yaw[i]) * sp.walkSpeed;
          return;
        }
        wander(e, i, streams.behavior, sp.walkSpeed * 0.6);
        const social = effectiveTrait(e, i, TRAIT.SOCIABILITY, tick);
        if (social > 0.3) {
          const h = herdCohesion(e, spatial, i, BEHAVIOR.herdRadius);
          if (h.n > 0) {
            const d = dist(i, h.cx, h.cz);
            if (d > 5) {
              const w = social * 0.6;
              e.vx[i] = e.vx[i] * (1 - w) + (h.cx - e.x[i]) / d * sp.walkSpeed * 0.6 * w;
              e.vz[i] = e.vz[i] * (1 - w) + (h.cz - e.z[i]) / d * sp.walkSpeed * 0.6 * w;
            }
          }
        }
        return;
      }
      case GOAL.EAT: {
        const carnivoreFood = sp.eats.carcass && c.carcassId !== NONE && c.carcassDist <= c.foodDist;
        if (carnivoreFood) {
          const k = carcassIndex(c.carcassId);
          if (k < 0) { dirty[i] = 1; stop(e, i); return; }
          const carc = carcasses[k];
          if (dist(i, carc.x, carc.z) <= WORLD.interactDistance) {
            const bite = Math.min(sp.mealValue, carc.food);
            feed(e, i, bite);
            carc.food -= bite;
            if (carc.food <= 0.05) carcasses.splice(k, 1);
            dirty[i] = 1;
            stop(e, i);
          } else seekTo(e, i, carc.x, carc.z, sp.walkSpeed);
          return;
        }
        if (c.foodKind === 'grass') {
          const t = tileOf(i);
          if (grass.biomass[t] >= WORLD.foodBiomassMin) {
            const eaten = grazeAt(grass, t, WORLD.grazeRate * dt);
            feed(e, i, eaten);
            remember(e, i, MEMORY_KIND.FOOD, t, tick);
            stop(e, i);
          } else if (t === c.foodTile || grass.biomass[c.foodTile] < WORLD.foodBiomassMin) { dirty[i] = 1; stop(e, i); }
          else { const [cx, cz] = centre(c.foodTile); seekTo(e, i, cx, cz, sp.walkSpeed); }
          return;
        }
        if (c.foodKind === 'bush') {
          const [cx, cz] = centre(c.foodTile);
          if (dist(i, cx, cz) <= WORLD.interactDistance) {
            feed(e, i, stripBush(bushes, c.foodIdx));
            remember(e, i, MEMORY_KIND.FOOD, c.foodTile, tick);
            dirty[i] = 1;
            stop(e, i);
          } else if (!isRipe(bushes, c.foodIdx)) { dirty[i] = 1; stop(e, i); }
          else seekTo(e, i, cx, cz, sp.walkSpeed);
          return;
        }
        if (c.foodKind === 'tree') {
          const tr = c.foodIdx >= 0 ? c.foodIdx : trees.byTile[c.foodTile];
          const [cx, cz] = centre(c.foodTile);
          if (dist(i, cx, cz) <= WORLD.interactDistance + 0.5) {
            if (tr >= 0 && trees.state[tr] === TREE_STATE.STANDING && trees.foliage && trees.foliage[tr] >= 0.05) {
              const eaten = browseTree(trees, tr, WORLD.grazeRate * dt);
              feed(e, i, eaten);
              remember(e, i, MEMORY_KIND.FOOD, c.foodTile, tick);
              stop(e, i);
            } else { dirty[i] = 1; stop(e, i); }
          } else if (tr < 0 || trees.state[tr] !== TREE_STATE.STANDING || (trees.foliage && trees.foliage[tr] < 0.05)) {
            dirty[i] = 1; stop(e, i);
          } else {
            seekTo(e, i, cx, cz, sp.walkSpeed);
          }
          return;
        }
        dirty[i] = 1;
        stop(e, i);
        return;
      }
      case GOAL.DRINK: {
        const t = tileOf(i);
        if (isShore[t]) {
          drink(e, i, WORLD.drinkRate * dt);
          remember(e, i, MEMORY_KIND.WATER, t, tick);
          stop(e, i);
        } else if (shoreField[t] > 0) {
          const [cx, cz] = centre(descendStep(terrain, shoreField, t));
          seekTo(e, i, cx, cz, sp.walkSpeed);
        } else if (routedTile(t) !== NONE) {
          const [cx, cz] = centre(routedTile(t));
          seekTo(e, i, cx, cz, sp.walkSpeed);
        } else {
          const mem = recall(e, i, MEMORY_KIND.WATER, tick);
          if (mem !== NONE) { const [cx, cz] = centre(mem); seekTo(e, i, cx, cz, sp.walkSpeed); } else stop(e, i);
        }
        return;
      }
      case GOAL.HUNT: {
        let prey = e.resolve(c.prey);
        if (sp.packHunts) {
          const leader = packLeader(e, spatial, i, BEHAVIOR.packRadius);
          if (leader !== i) { const lt = e.resolve(e.target[leader]); if (lt !== NONE && sp.prey.includes(e.species[lt])) prey = lt; }
        }
        if (prey === NONE) { dirty[i] = 1; stop(e, i); return; }
        e.target[i] = e.handle(prey);
        const d = dist(i, e.x[prey], e.z[prey]);
        const reach = sp.huntReach + (sp.builds && hasTower(settlement) ? TECH.towerHuntReachBonus : 0);
        if (d <= sp.radius + SPECIES[e.species[prey]].radius + WORLD.reachPadding + reach) {
          const food = SPECIES[e.species[prey]].foodValue;
          const preyName = nameOf(prey);
          kill(prey, DEATH_CAUSE.PREDATION, ` by ${nameOf(i)}`, i);
          if (sp.sharesKills) shareKill(e, spatial, i, BEHAVIOR.packRadius, food);
          else feed(e, i, Math.min(sp.mealValue, food));
          bus.emit('kill', { killer: i, preyName });
          e.target[i] = NONE;
          dirty[i] = 1;
          stop(e, i);
        } else seekTo(e, i, e.x[prey], e.z[prey], sp.runSpeed);
        return;
      }
      case GOAL.FLEE: {
        if (c.threatDist !== Infinity) {
          if (sp.fleeStyle === 'scatter') {
            const d = scatterDirection(e, i, c.threatX, c.threatZ, streams.behavior);
            e.vx[i] = d.x * sp.runSpeed; e.vz[i] = d.z * sp.runSpeed;
          } else fleeFrom(e, i, c.threatX, c.threatZ, sp.runSpeed);
          if (sp.alarms && !isAlerted(e, i, tick)) raiseAlarm(e, spatial, i, BEHAVIOR.herdRadius, tick, c.threatX, c.threatZ);
        } else if (Math.hypot(e.vx[i], e.vz[i]) < 0.1) {
          wander(e, i, streams.behavior, sp.runSpeed);
        }
        return;
      }
      case GOAL.MATE: {
        const m = e.resolve(c.mate);
        if (m === NONE) { dirty[i] = 1; stop(e, i); return; }
        if (dist(i, e.x[m], e.z[m]) <= WORLD.interactDistance) {
          if (canMate(e, i, m, tick)) {
            e.lastMateTick[i] = tick; e.lastMateTick[m] = tick;
            const female = e.sex[i] === 1 ? i : m; const male = female === i ? m : i;
            e.gestationEndTick[female] = tick + GESTATION_TICKS[sp.id];
            e.pendingFather[female] = e.handle(male);
          }
          dirty[i] = 1;
          stop(e, i);
        } else seekTo(e, i, e.x[m], e.z[m], sp.walkSpeed);
        return;
      }
      case GOAL.FOLLOW_PARENT: {
        const p = e.resolve(c.parent);
        if (p === NONE) { dirty[i] = 1; stop(e, i); return; }
        if (dist(i, e.x[p], e.z[p]) <= 2.5) { stop(e, i); return; }
        seekTo(e, i, e.x[p], e.z[p], sp.walkSpeed);
        return;
      }
      case GOAL.RETURN_HOME: {
        const h = nearestHut(settlement, e.x[i], e.z[i]);
        // Home is the hut's wall, not its centre: nobody can stand inside its footprint.
        if (!h || dist(i, h.x, h.z) <= FOOTPRINT.hut + WORLD.interactDistance) { stop(e, i); return; }
        seekTo(e, i, h.x, h.z, sp.walkSpeed);
        return;
      }
      case GOAL.CHOP: {
        const k = c.treeIdx;
        if (k === NONE || trees.state[k] !== TREE_STATE.STANDING) { dirty[i] = 1; stop(e, i); return; }
        const [cx, cz] = centre(trees.tile[k]);
        if (dist(i, cx, cz) <= WORLD.interactDistance) {
          stop(e, i);
          if (tick - e.goalSince[i] >= Math.round(WORLD.chopSeconds / TICK_SECONDS)) {
            if (chopTree(trees, k, tileState)) {
              giveLogs(settlement, i, FLORA.logsPerTree);
              phys.fellTree({ x: cx, y: terrain.heightAt(cx, cz), z: cz, dirX: cx - e.x[i], dirZ: cz - e.z[i] }, streams.cosmetic);
              log.push({ tick, kind: 'chop', text: `${nameOf(i)} felled a tree`, tile: trees.tile[k] });
              almanac.treesFelled++;
            }
            e.goalSince[i] = tick;
          }
        } else seekTo(e, i, cx, cz, sp.walkSpeed);
        return;
      }
      case GOAL.BUILD: {
        const o = settlement.huts[0];
        if (!o) { stop(e, i); return; }
        if (dist(i, o.x, o.z) <= BEHAVIOR.hutSiteRadius) {
          stop(e, i);
          if (buildHut(e, i, settlement, terrain, tileState, streams.behavior, log, tick, ground.closed)) { almanac.hutsBuilt++; rebuildShoreField(); }
          dirty[i] = 1;
        } else seekTo(e, i, o.x, o.z, sp.walkSpeed);
        return;
      }
      default: stop(e, i);
    }
  }

  // ── births ───────────────────────────────────────────────────────────
  function giveBirth(mother) {
    const sp = SPECIES[e.species[mother]];
    const father = e.resolve(e.pendingFather[mother]);
    const n = litterSize(sp, streams.genetics);
    const motherHandle = e.handle(mother);
    const fatherHandle = father === NONE ? NONE : e.handle(father);
    const fatherName = father === NONE ? null : nameOf(father);
    for (let k = 0; k < n; k++) {
      if (e.count >= cap) {
        if (clock.tick - lastFullTick >= Math.round(WORLD.fullLogCooldownSeconds / TICK_SECONDS)) {
          lastFullTick = clock.tick;
          log.push({ tick: clock.tick, kind: 'full', text: 'The island is full — births are on hold' });
        }
        break;
      }
      const a = streams.genetics.range(0, Math.PI * 2);
      let x = e.x[mother] + Math.cos(a) * WORLD.birthOffset; let z = e.z[mother] + Math.sin(a) * WORLD.birthOffset;
      if (!isWalkable(terrain.type[tileIndex(x, z, size)]) || ground.closed[tileIndex(x, z, size)]) { x = e.x[mother]; z = e.z[mother]; }
      const traits = inheritTraits(e, mother, father, streams.genetics);
      const i = spawn(sp.id, x, z, { traits, mother: motherHandle, father: fatherHandle });
      if (i < 0) break;
      log.push({ tick: clock.tick, kind: 'birth', species: sp.id, creature: e.handle(i), mother: motherHandle, father: fatherHandle, text: `${nameOf(i)} (${sp.name.toLowerCase()}) born to ${nameOf(mother)}${fatherName ? ' + ' + fatherName : ''}` });
      bus.emit('birth', { index: i, mother });
      almanac.born[sp.id]++;
      e.offspring[mother]++;
    }
    e.gestationEndTick[mother] = NONE;
    e.pendingFather[mother] = NONE;
  }

  // ── the tick ─────────────────────────────────────────────────────────
  function step() {
    clock.step();
    const dt = TICK_SECONDS; const tick = clock.tick;
    stepGrass(grass, terrain, tileState, dt * weather.effects.grass);
    stepBushes(bushes, dt * weather.effects.bush, TECH.fieldRipenMultiplier);
    const thirstExtra = weather.effects.thirst - 1;
    stepTrees(trees, tileState, dt, weather.effects.grass);
    spatial.rebuild(e);
    const hearth = settlement.campfireTile !== NONE && isNight(clock.dayFraction());

    for (let i = 0; i < e.high; i++) {
      if (!e.alive[i]) continue;
      const sp = SPECIES[e.species[i]];
      stepDrives(e, i, sp, dt);
      if (thirstExtra !== 0) { const th = e.thirst[i] + sp.thirstRate * dt * thirstExtra; e.thirst[i] = th < 0 ? 0 : th > 1 ? 1 : th; }
      if (isOrphan(e, i)) e.hunger[i] = Math.min(1, e.hunger[i] + sp.hungerRate * dt * (BEHAVIOR.orphanHungerMultiplier - 1));
      updateLifeStage(e, i, sp);
      if (e.age[i] > almanac.oldestAge) { almanac.oldestAge = e.age[i]; almanac.oldestName = nameOf(i); almanac.oldestSpecies = sp.id; }
      if (tileState[tileOf(i)] === TILE_STATE.FIRE || tileState[tileOf(i)] === TILE_STATE.LAVA) e.health[i] -= 0.5 * dt;
      // Warmth: a villager by the fire at night heals (behavior/tech.js FIRE).
      else if (hearth && sp.builds && campfireDistance(world, e.x[i], e.z[i]) <= TECH.campfireWarmRadius) e.health[i] = Math.min(1, e.health[i] + TECH.campfireRegenPerSecond * dt);
      const vital = checkVitals(e, i);
      if (vital) {
        const here = tileState[tileOf(i)];
        kill(i, here === TILE_STATE.LAVA ? DEATH_CAUSE.ERUPTION : here === TILE_STATE.FIRE ? DEATH_CAUSE.FIRE : isSick(e, i, tick) ? DEATH_CAUSE.DISEASE : vital);
        continue;
      }
      const oldAge = oldAgeDeathChance(e, i, sp, dt);
      if (oldAge > 0 && streams.behavior.next() < oldAge) { kill(i, DEATH_CAUSE.OLD_AGE); continue; }
      if (e.gestationEndTick[i] !== NONE && tick >= e.gestationEndTick[i]) giveBirth(i);

      if (dirty[i] || (tick + i) % BEHAVIOR.rescoreEveryTicks === 0) {
        const c = perceive(i);
        chooseGoal(e, i, c);
        commitPlan(i, c);
      }
      const px0 = e.x[i]; const pz0 = e.z[i];
      act(i, e.goal[i], plans[i], dt);
      moveCreature(e, i, terrain, tileState, dt, ground);
      e.dist[i] += Math.hypot(e.x[i] - px0, e.z[i] - pz0);   // lifetime metres (telemetry)
    }

    for (let k = carcasses.length - 1; k >= 0; k--) if (carcasses[k].expires <= tick) carcasses.splice(k, 1);

    // Natural events: scheduled strikes/slides, rolling rocks, fires, fading fear.
    const due = scheduler.poll(tick);
    if (due) fireNaturalEvent(due);
    if (stepCorridors(world)) rebuildShoreField();
    stepFire(world);
    if (stepLava(world)) rebuildShoreField();
    if (tick % 20 === 0) {
      const decay = EVENTS.fearDecayPerSecond;
      for (let t = 0; t < fear.length; t++) if (fear[t] > 0) fear[t] = fear[t] > decay ? fear[t] - decay : 0;
    }
    phys.step(dt);

    // A template thought lands on the next creature in turn every few seconds, so the
    // inspector always has something to show even with the model off.
    if (tick % THOUGHTS.templateEveryTicks === 0 && e.count > 0) {
      for (let n = 0; n < e.cap; n++) {
        const i = (templateCursor + n) % e.cap;
        if (!e.alive[i]) continue;
        templateCursor = (i + 1) % e.cap;
        giveTemplateThought(i);
        break;
      }
    }

    // Extinctions, last species standing, population history.
    let living = 0; let lastId = NONE;
    for (let s = 0; s < 4; s++) {
      if (counts[s] === 0) {
        if (!extinct[s]) { extinct[s] = true; log.push({ tick, kind: 'extinction', species: s, text: `${SPECIES[s].plural} are extinct` }); bus.emit('extinction', { species: s }); }
      } else { extinct[s] = false; living++; lastId = s; }
    }
    lastStanding = living === 1 ? lastId : NONE;
    silent = living === 0;

    const allAnimalsDead = counts[0] === 0 && counts[1] === 0 && counts[2] === 0;
    if (allAnimalsDead && !ended) {
      ended = true;
      clock.setSpeed(0);
      log.push({ tick, kind: 'end', text: `All animals have died. The simulation ended in year ${clock.year()}.` });
      bus.emit('simulationEnd', { year: clock.year(), living, silent });
    }
    if (tick % WORLD.popSampleTicks === 0) {
      popHistory.push(counts.slice());
      if (popHistory.length > WORLD.popHistoryMax) popHistory.shift();
    }
    if (tick % WORLD.traitSampleTicks === 0) sampleTraits();

    // The tribe's ladder, once a second: climb a tier when its conditions hold, and rebuild
    // anything the island has since buried.
    if (tick % 20 === 0) {
      const reached = advanceTech(world, { hutsBuilt: almanac.hutsBuilt, humans: counts[SPECIES_ID.HUMAN], year: clock.year() }, tribe);
      if (reached) {
        log.push({ tick, kind: 'tech', level: reached.level, tile: reached.tile, text: reached.text });
        bus.emit('tech', reached);
        if (reached.solidChanged) rebuildShoreField();
      }
      if (maintainWorks(world)) rebuildShoreField();

      // Weather and disease: once a second, each on its own stream.
      if (stepWeather(world) === 'strike') {
        const t = pickStrikeTile(terrain, streams.weather);
        if (t >= 0) strikeLightning(world, t, streams.weather);
      }
      sick = stepDisease(world, counts);
      if (sick[0] + sick[1] + sick[2] + sick[3] > 0) e.forEachAlive((i) => { if (isSick(e, i, tick)) warm(heat.sick, heatCell(e.x[i], e.z[i])); });

      // One coarse row per year for the timeline: [year, rabbits, deer, wolves, humans, tech, H'×1000].
      const year = clock.year();
      if (year !== lastYearSampled) {
        lastYearSampled = year;
        yearHistory.push([year, counts[0], counts[1], counts[2], counts[3], settlement.tech, Math.round(biodiversity().shannon * 1000)]);
        if (yearHistory.length > HISTORY.yearsMax) yearHistory.shift();
      }

      if (tribeStore) {
        if (tribeStore.stepDiplomacy) tribeStore.stepDiplomacy(log, tick);
        if (tribeStore.stepTech) tribeStore.stepTech(log, tick);
        if (tribeStore.stepConstruction) tribeStore.stepConstruction(terrain, tileState, streams.behavior, log, tick);
        if (tribeStore.stepCaravans) tribeStore.stepCaravans(log, tick);
      }
      // A tier's works, a planted field, a tribe's new building: the footprints follow,
      // and the shore field with them when a building closed a tile it routed through.
      if (refreshGround()) rebuildShoreField();
    }
  }

  // ── reads ────────────────────────────────────────────────────────────
  function stats() {
    // The age pyramid is recomputed here rather than maintained on every birth/death/age
    // transition: one O(high) scan at the 2 Hz stats cadence is cheaper than three hooks
    // that must each stay in sync with updateLifeStage.
    almanac.stages.fill(0);
    e.forEachAlive(i => almanac.stages[e.species[i] * 3 + e.lifeStage[i]]++);
    return {
      seed, terrainHash: terrain.hash, tick: clock.tick, speed: clock.speed,
      year: clock.year(), day: clock.day(), dayFraction: clock.dayFraction(),
      season: clock.season(), seasonProgress: clock.seasonProgress(),
      counts: counts.slice(), alive: e.count, huts: settlement.huts.length,
      extinct: extinct.slice(), lastStanding, silent, ended, popHistory, carcasses: carcasses.length,
      naturalEvents: { ...naturalEvents },
      almanac: {
        born: almanac.born.slice(), died: almanac.died.slice(), byCause: { ...almanac.byCause }, stages: almanac.stages.slice(),
        hutsBuilt: almanac.hutsBuilt, treesFelled: almanac.treesFelled,
        oldestName: almanac.oldestName, oldestSpecies: almanac.oldestSpecies, oldestAge: almanac.oldestAge,
      },
      telemetryCount: ledger.count,
      traitHistory,
      tech: { level: settlement.tech, name: TECH_NAMES[settlement.tech] ?? 'Camp', tribe, campfire: settlement.campfireTile !== NONE, tower: settlement.towerTile !== NONE, fields: settlement.fieldTiles.length },
      watched: watchedList(),
      lineageCount: lineage.count,
      tribes: tribeStore ? tribeStore.toTelemetry() : null,
      buildings: tribeStore?.getBuildingsTelemetry ? tribeStore.getBuildingsTelemetry() : [],
      caravans: tribeStore?.getCaravansTelemetry ? tribeStore.getCaravansTelemetry() : [],
      treaties: tribeStore?.treatyTelemetry ? tribeStore.treatyTelemetry() : [],
      weather: weatherTelemetry(weather),
      sick: sick.slice(),
      varieties: varieties.map(v => ({ species: v.species, name: v.name, year: v.year })),
      maxGeneration: lineage.maxGeneration,
      biodiversity: biodiversity(),
      landmarkCount: landmarks.count, landmarkLastId: landmarks.recent(1)[0]?.id ?? 0, yearCount: yearHistory.length,
      sagaCount: journal.length,
    };
  }

  /** The timeline's data: every landmark, the per-year rows and the journal (sent only when they change). */
  function history() {
    return { landmarks: landmarks.all(), years: yearHistory.map(r => r.slice()), sagas: journal.map(s => ({ ...s })) };
  }

  /** The per-creature STATE word of the render frame (sim/frame.js): sick, watched. */
  function frameState(i) {
    return (isSick(e, i, clock.tick) ? 1 : 0) | (watched.has(e.handle(i)) ? 2 : 0);
  }

  /**
   * The finder: living creatures whose name or species contains `text`, ordered by `sort`
   * ('oldest' | 'weakest' | 'hungriest' | 'young' | 'sick' | 'watched'; anything else is by name).
   */
  function find({ text = '', sort = '', limit = 12 } = {}) {
    const needle = String(text ?? '').trim().toLowerCase().slice(0, 40);
    const rows = [];
    e.forEachAlive((i) => {
      const sp = SPECIES[e.species[i]];
      if (needle && !nameOf(i).toLowerCase().includes(needle) && !sp.name.toLowerCase().includes(needle) && !sp.plural.toLowerCase().includes(needle)) return;
      if (sort === 'sick' && !isSick(e, i, clock.tick)) return;
      if (sort === 'watched' && !watched.has(e.handle(i))) return;
      rows.push(i);
    });
    const key = {
      oldest: (i) => -e.age[i], weakest: (i) => e.health[i], hungriest: (i) => -e.hunger[i], young: (i) => -e.offspring[i],
    }[sort];
    if (key) rows.sort((a, b) => key(a) - key(b)); else rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    return rows.slice(0, Math.max(1, Math.min(40, limit | 0))).map((i) => ({
      handle: e.handle(i), name: nameOf(i), species: e.species[i], ageYears: e.age[i], health: e.health[i], hunger: e.hunger[i],
      young: e.offspring[i], sick: isSick(e, i, clock.tick), watched: watched.has(e.handle(i)), x: e.x[i], z: e.z[i],
    }));
  }

  /** A creature's LIVING relatives, for the kin threads: [{ handle, rel }] — 0 elder, 1 young, 2 sibling. */
  function kinOf(handle) {
    const t = lineage.tree(handle);
    if (!t) return [];
    const out = []; const seen = new Set([handle]);
    const add = (h, rel) => { if (h === NONE || h === undefined || seen.has(h) || e.resolve(h) === NONE) return; seen.add(h); out.push({ handle: h, rel }); };
    for (const r of [t.mother, t.father, ...t.grandparents]) if (r) add(r.h, 0);
    for (const r of t.children) add(r.h, 1);
    for (const p of [t.self.mother, t.self.father]) if (p !== NONE) for (const h of lineage.childrenOf(p)) add(h, 2);
    return out.slice(0, 48);
  }

  /** Copies of the heat grids (the minimap's data layers). */
  function heatmap() {
    return { side: heatSide, cell: HEAT_CELL, deaths: heat.deaths.slice(), kills: heat.kills.slice(), sick: heat.sick.slice() };
  }

  /** The watch-list as the HUD shows it: living entries first, then the fallen. */
  function watchedList() {
    const out = [];
    for (const h of watched) {
      const i = e.resolve(h);
      if (i !== NONE) { out.push({ handle: h, name: nameOf(i), species: e.species[i], alive: true, ageYears: e.age[i], cause: '' }); continue; }
      const r = lineage.get(h);
      out.push({ handle: h, name: r?.name ?? 'Unknown', species: r?.species ?? 0, alive: false, ageYears: r ? (r.died - r.born) * TICK_SECONDS / 30 : 0, cause: r?.cause ?? '' });
    }
    out.sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? -1 : 1));
    return out;
  }

  /** A family tree for the inspector, or null for a handle nothing remembers. */
  function lineageOf(handle) {
    const t = lineage.tree(handle);
    if (!t) return null;
    const pick = (r) => (r ? { handle: r.h, name: r.name, species: r.species, sex: r.sex, alive: e.resolve(r.h) !== NONE, cause: r.cause, bornTick: r.born, diedTick: r.died } : null);
    return {
      self: pick(t.self), mother: pick(t.mother), father: pick(t.father),
      grandparents: t.grandparents.map(pick), children: t.children.map(pick),
      siblings: t.siblings, descendants: t.descendants, generation: t.generation,
    };
  }

  /** Player-given name: clipped, printable, and mirrored into the lineage record. */
  function rename(handle, name) {
    const i = e.resolve(handle);
    if (i === NONE) return false;
    const clean = String(name ?? '').replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, WORLD.nameMaxChars);
    if (!clean) return false;
    e.names[i] = clean;
    lineage.rename(handle, clean);
    log.push({ tick: clock.tick, kind: 'rename', creature: handle, species: e.species[i], text: `${clean} was given a name` });
    return true;
  }

  function setWatched(handle, on) {
    if (on) { if (e.resolve(handle) === NONE && !lineage.get(handle)) return false; watched.add(handle); } else watched.delete(handle);
    return true;
  }

  function detail(handle) {
    const i = e.resolve(handle);
    if (i === NONE) return null;
    // Every detail payload carries a quote: the template rotation takes minutes to reach
    // every creature, so one is minted here rather than at any single call site.
    if (!e.lastThought[i]) giveTemplateThought(i);
    const sp = SPECIES[e.species[i]]; const tick = clock.tick;
    const traits = []; const baseTraits = [];
    for (let k = 0; k < TRAITS.length; k++) { traits.push(effectiveTrait(e, i, k, tick)); baseTraits.push(e.traits[i * TRAITS.length + k]); }
    const nudgeTrait = e.nudgeTrait[i];
    const nudge = nudgeTrait >= 0 && activeNudge(e, i, nudgeTrait, tick) !== 0 ? { trait: TRAITS[nudgeTrait], delta: activeNudge(e, i, nudgeTrait, tick) } : null;
    // Parents are looked up through the lineage first so a dead parent keeps its name in
    // the inspector instead of vanishing the moment it dies.
    const parentName = (h) => { const p = e.resolve(h); if (p !== NONE) return nameOf(p); return lineage.get(h)?.name ?? ''; };
    const family = lineage.tree(handle);
    return {
      handle, name: nameOf(i), species: sp.id, speciesName: sp.name, sex: e.sex[i],
      watched: watched.has(handle), children: family?.children.length ?? 0, descendants: family?.descendants ?? 0, generation: family?.generation ?? 0,
      ageYears: e.age[i], lifeStage: e.lifeStage[i], hunger: e.hunger[i], thirst: e.thirst[i], health: e.health[i],
      traits, baseTraits, nudge, goal: GOAL_NAMES[e.goal[i]] ?? 'Idle', goalSince: e.goalSince[i],
      lastThought: e.lastThought[i], lastThoughtSource: e.lastThoughtSource[i],
      mother: parentName(e.mother[i]), father: parentName(e.father[i]), x: e.x[i], y: e.y[i], z: e.z[i],
      sick: isSick(e, i, tick),
    };
  }

  function debug(op, arg = {}) {
    switch (op) {
      case 'massKill': {
        const targets = [];
        e.forEachAlive(i => { if (arg.species === undefined || e.species[i] === arg.species) targets.push(i); });
        for (const i of targets) kill(i, DEATH_CAUSE.DEBUG);
        return targets.length;
      }
      case 'lightning': {
        const tile = arg.tile ?? pickStrikeTile(terrain, streams.events);
        if (tile < 0) return false;
        scheduler.markFired(EVENT_KIND.LIGHTNING, clock.tick);
        naturalEvents.lightning++;
        return strikeLightning(world, tile, streams.events);
      }
      case 'rockslide': {
        scheduler.markFired(EVENT_KIND.ROCKSLIDE, clock.tick);
        naturalEvents.rockslide++;
        return triggerRockslide(world, streams.events);
      }
      case 'erupt': {
        if (!world.erupt) return false;
        scheduler.markFired(EVENT_KIND.ERUPTION, clock.tick);
        naturalEvents.eruption++;
        return world.erupt();
      }
      default: return false;
    }
  }

  function applyCommand(cmd) {
    if (cmd.type === 'setSpeed') clock.setSpeed(cmd.speed);
  }

  // ── save / restore (persistence/snapshot.js wraps these) ─────────────
  const ENTITY_COLS = e.columns();
  function getState() {
    const cols = {};
    for (const c of ENTITY_COLS) cols[c] = e[c].slice();
    return {
      clock: clock.getState(), rng: streams.getState(), namer: namer.getState(), log: log.getState(),
      scheduler: scheduler.getState(), thoughtScheduler: thoughtScheduler.getState(), thoughtStats: { ...thoughtStats },
      templateCursor, nextCarcassId, lastFullTick, naturalEvents: { ...naturalEvents }, extinct: extinct.slice(),
      popHistory: popHistory.map(r => r.slice()),
      tileState: tileState.slice(), fear: fear.slice(),
      grass: { biomass: grass.biomass.slice(), cursor: grass.cursor },
      bushes: { ripeness: bushes.ripeness.slice(), count: bushes.count, tile: bushes.tile.slice(), fast: bushes.fast.slice() },
      trees: { state: trees.state.slice(), regrow: trees.regrow.slice(), foliage: trees.foliage ? trees.foliage.slice() : null },
      ended: !!ended,
      settlement: {
        huts: settlement.huts.map(h => ({ ...h })), carried: settlement.carried.slice(),
        tech: settlement.tech, campfireTile: settlement.campfireTile, towerTile: settlement.towerTile, fieldTiles: settlement.fieldTiles.slice(),
      },
      lineage: lineage.getState(), watched: [...watched], traitHistory: traitHistory.map(r => r.slice()),
      entities: { high: e.high, count: e.count, free: e.getFreeList(), cols, names: e.names.slice(), lastThought: e.lastThought.slice() },
      plans: plans.slice(0, e.high).map(p => ({ ...p })), dirty: dirty.slice(),
      carcasses: carcasses.map(c => ({ ...c })), corridors: corridors.map(r => ({ ...r, corridor: r.corridor.slice() })),
      boulders: boulders.map(b => ({ ...b })), fires: fires.map(f => ({ ...f })), burnt: burnt.map(b => ({ ...b })),
      almanac: {
        born: almanac.born.slice(), died: almanac.died.slice(), byCause: { ...almanac.byCause }, stages: almanac.stages.slice(),
        hutsBuilt: almanac.hutsBuilt, treesFelled: almanac.treesFelled,
        oldestName: almanac.oldestName, oldestSpecies: almanac.oldestSpecies, oldestAge: almanac.oldestAge,
      },
      telemetry: ledger.getState(),
      tribes: tribeStore.getState(),
      weather: getWeatherState(weather),
      varieties: varieties.map(v => ({ ...v, traits: v.traits.slice() })), varietyBase: varietyBase.map(b => (b ? b.slice() : null)),
      landmarks: landmarks.getState(), yearHistory: yearHistory.map(r => r.slice()), lastYearSampled,
      heat: { deaths: heat.deaths.slice(), kills: heat.kills.slice(), sick: heat.sick.slice() },
      journal: journal.map(s => ({ ...s })),
      lava: world.lava ? { front: world.lava.front.slice(), tiles: world.lava.tiles.slice(), endTick: world.lava.endTick, nextCreep: world.lava.nextCreep } : null,
    };
  }
  function setState(s) {
    clock.setState(s.clock); streams.setState(s.rng); namer.setState(s.namer); log.setState(s.log);
    scheduler.setState(s.scheduler); thoughtScheduler.setState(s.thoughtScheduler);
    Object.assign(thoughtStats, s.thoughtStats); templateCursor = s.templateCursor | 0; nextCarcassId = s.nextCarcassId | 0; lastFullTick = s.lastFullTick;
    Object.assign(naturalEvents, s.naturalEvents); for (let k = 0; k < 4; k++) extinct[k] = !!s.extinct[k];
    ended = !!s.ended;
    if (s.trees?.foliage && trees.foliage) trees.foliage.set(s.trees.foliage);
    // Almanac/telemetry are additive: snapshots from before they existed restore with the
    // counters zeroed rather than being refused (schemaVersion stays 1).
    if (s.almanac) {
      for (let k = 0; k < 4; k++) { almanac.born[k] = s.almanac.born[k] | 0; almanac.died[k] = s.almanac.died[k] | 0; }
      almanac.byCause = { ...(s.almanac.byCause ?? {}) };
      for (let k = 0; k < 12; k++) almanac.stages[k] = s.almanac.stages[k] | 0;
      almanac.hutsBuilt = s.almanac.hutsBuilt | 0; almanac.treesFelled = s.almanac.treesFelled | 0;
      almanac.oldestName = s.almanac.oldestName ?? ''; almanac.oldestSpecies = s.almanac.oldestSpecies | 0; almanac.oldestAge = s.almanac.oldestAge ?? 0;
    }
    if (s.telemetry) ledger.setState(s.telemetry);
    if (s.tribes) tribeStore.setState(s.tribes);
    setWeatherState(weather, s.weather);
    varieties.length = 0; for (const v of s.varieties ?? []) varieties.push({ ...v, traits: (v.traits ?? []).slice() });
    for (let k = 0; k < 4; k++) varietyBase[k] = s.varietyBase?.[k] ? s.varietyBase[k].slice() : null;
    if (s.landmarks) landmarks.setState(s.landmarks);
    yearHistory.length = 0; for (const r of s.yearHistory ?? []) yearHistory.push(r.slice());
    lastYearSampled = Number.isInteger(s.lastYearSampled) ? s.lastYearSampled : -1;
    // Heat and the journal are additive (2026-09-30): an older save restores with both empty.
    for (const k of ['deaths', 'kills', 'sick']) { heat[k].fill(0); if (s.heat?.[k]?.length === heat[k].length) heat[k].set(s.heat[k]); }
    journal.length = 0; for (const j of s.journal ?? []) journal.push({ ...j });
    popHistory.length = 0; for (const r of s.popHistory) popHistory.push(r.slice());
    tileState.set(s.tileState); fear.set(s.fear);
    grass.biomass.set(s.grass.biomass); grass.cursor = s.grass.cursor | 0;
    // Bushes were a bare ripeness array before farming could plant new ones; both forms load.
    if (s.bushes && !ArrayBuffer.isView(s.bushes)) {
      bushes.ripeness.set(s.bushes.ripeness);
      bushes.byTile.fill(-1);
      bushes.count = s.bushes.count | 0; bushes.tile.set(s.bushes.tile);
      for (let k = 0; k < bushes.count; k++) bushes.byTile[bushes.tile[k]] = k;
      if (s.bushes.fast) bushes.fast.set(s.bushes.fast); else bushes.fast.fill(0);
    } else { bushes.ripeness.set(s.bushes); bushes.fast.fill(0); }
    trees.state.set(s.trees.state); trees.regrow.set(s.trees.regrow);
    settlement.huts.length = 0; for (const h of s.settlement.huts) settlement.huts.push({ ...h });
    settlement.carried.set(s.settlement.carried);
    settlement.tech = s.settlement.tech | 0;
    settlement.campfireTile = s.settlement.campfireTile ?? NONE; settlement.towerTile = s.settlement.towerTile ?? NONE;
    settlement.fieldTiles = (s.settlement.fieldTiles ?? []).slice();
    lineage.setState(s.lineage);
    watched.clear(); for (const h of s.watched ?? []) watched.add(h);
    traitHistory.length = 0; for (const r of s.traitHistory ?? []) traitHistory.push(Float32Array.from(r));
    // A column added after the snapshot was written (sickUntil, immuneUntil) restores to its
    // reset value rather than refusing the whole save.
    for (const c of ENTITY_COLS) {
      if (s.entities.cols[c]) e[c].set(s.entities.cols[c]);
      else e[c].fill(e[c] instanceof Int32Array || e[c] instanceof Int8Array ? NONE : 0);
    }
    e.high = s.entities.high; e.count = s.entities.count; e.setFreeList(s.entities.free);
    for (let i = 0; i < e.cap; i++) { e.names[i] = s.entities.names[i] ?? ''; e.lastThought[i] = s.entities.lastThought[i] ?? ''; }
    for (let i = 0; i < e.cap; i++) { const p = plans[i]; for (const k of Object.keys(p)) delete p[k]; if (s.plans[i]) Object.assign(p, s.plans[i]); }
    // "Nothing perceived" is Infinity, which JSON writes as null: a cloud save (codec.js)
    // came back with every such distance null, null compares as 0, and the restored world
    // left its twin within five ticks. IndexedDB (structured clone) never lost them.
    for (let i = 0; i < e.cap; i++) for (const k of PLAN_KEYS) if (k.endsWith('Dist') && plans[i][k] === null) plans[i][k] = Infinity;
    dirty.set(s.dirty);
    carcasses.length = 0; for (const c of s.carcasses) carcasses.push({ ...c });
    corridors.length = 0; for (const r of s.corridors) corridors.push({ ...r, corridor: r.corridor.slice() });
    boulders.length = 0; for (const b of s.boulders) boulders.push({ ...b });
    fires.length = 0; for (const f of s.fires) fires.push({ ...f });
    burnt.length = 0; for (const b of s.burnt) burnt.push({ ...b });
    world.lava = s.lava ? { front: s.lava.front.slice(), tiles: s.lava.tiles.slice(), endTick: s.lava.endTick, nextCreep: s.lava.nextCreep } : null;
    recount();
    rebuildShoreField();
    spatial.rebuild(e);
    // A world saved before lineages existed: seed records for the living so trees start
    // from here rather than from nothing.
    if (lineage.count === 0) e.forEachAlive((i) => lineage.born({ handle: e.handle(i), name: e.names[i], species: e.species[i], sex: e.sex[i], mother: e.mother[i], father: e.father[i], tick: e.birthTick[i] }));
    if (traitHistory.length === 0) sampleTraits();
  }

  const world = {
    seed, terrain, tileState, fear, grass, bushes, trees, settlement, ground, entities: e, clock, log, bus, spatial, namer, streams,
    get shoreField() { return shoreField; }, carcasses, physics: phys, popHistory,
    scheduler, corridors, boulders, fires, burnt, ignite, rebuildShoreField, lava: null,
    thoughtFeed, telemetry: ledger, lineage, tribe,
    erupt: () => erupt(world),
    senses: (i) => ({ ...perceive(i) }),
    thoughts: {
      get pending() { return thoughtScheduler.pending; },
      next(selected = NONE) {
        const h = thoughtScheduler.next(e, selected);
        if (h === NONE) return null;
        thoughtStats.requested++;
        return { handle: h, prompt: buildPrompt(world, e.resolve(h)) };
      },
      apply(handle, text) {
        const r = applyThought(world, handle, text, THOUGHT_SOURCE.LLM);
        thoughtScheduler.complete(handle);
        if (r.applied) thoughtStats.applied++; else thoughtStats.rejected++;
        const i = e.resolve(handle);
        if (i !== NONE) thoughtFeed.push({ tick: clock.tick, kind: 'thought', handle, name: nameOf(i), species: e.species[i], source: e.lastThoughtSource[i], text: e.lastThought[i] });
        return r;
      },
      cancel() { thoughtScheduler.cancel(); },
      /**
       * The batched cloud path (/api/ecosystem/thoughts/batch): up to `n` creatures as the
       * structured items the endpoint takes. Each answer comes back through apply(), so a
       * batched thought is validated and nudged exactly like a single one.
       */
      batch(n, selected = NONE) {
        const out = [];
        for (const h of thoughtScheduler.take(e, selected, n)) {
          const i = e.resolve(h);
          if (i === NONE) continue;
          const c = perceive(i);
          const near = [];
          if (c.threatDist !== Infinity) near.push(`danger ${Math.round(c.threatDist)} m away`);
          if (c.preyDist !== Infinity) near.push(`prey ${Math.round(c.preyDist)} m away`);
          if (c.foodDist !== Infinity) near.push(`${c.foodKind === 'bush' ? 'berries' : c.foodKind || 'food'} ${Math.round(c.foodDist)} m away`);
          if (c.mateDist !== Infinity) near.push('a mate close by');
          if (isSick(e, i, clock.tick)) near.push('feeling sick');
          near.push(c.night ? 'night' : 'day');
          if (weather.kind !== 0) near.push(WEATHER_NAMES[weather.kind].toLowerCase());
          out.push({
            handle: h, species: SPECIES[e.species[i]].name, name: nameOf(i),
            hunger: Math.round(e.hunger[i] * 100) / 100, thirst: Math.round(e.thirst[i] * 100) / 100, health: Math.round(e.health[i] * 100) / 100,
            goal: GOAL_NAMES[e.goal[i]] ?? 'Idle', nearby: near.join(', '),
          });
        }
        thoughtStats.requested += out.length;
        return out;
      },
      /**
       * Give one creature a template thought now. The rotation takes minutes to reach
       * everyone, so the inspector would otherwise open on an empty quote for a creature
       * that has not had its turn. Never overwrites a live LLM thought.
       */
      template(handle) {
        const i = e.resolve(handle);
        return i === NONE ? false : giveTemplateThought(i);
      },
      stats() { return { ...thoughtStats }; },
      scheduler: thoughtScheduler,
    },
    step, stats, detail, debug, applyCommand, kill, spawn, getState, setState,
    lineageOf, rename, setWatched, tribeStore,
    weather, history, biodiversity,
    frameState, find, kinOf, heatmap,
    /** A council's answer to a diplomatic moment (the /treaty endpoint), applied by the tribe store. */
    applyTreaty: (t) => (tribeStore?.applyTreaty ? tribeStore.applyTreaty(t, log, clock.tick) : false),
    /**
     * A line of lore the page earned from the server (milestone legends): logged, and so kept
     * on the timeline. A 'saga' is a decade chronicle — JSON { fromYear, toYear, title, saga,
     * epigraph } — kept in the journal, which the snapshot carries.
     */
    note(kind, text, tile = NONE) {
      if (kind === 'saga') {
        let s; try { s = JSON.parse(text); } catch { return false; }
        const clip = (v, n) => String(v ?? '').trim().slice(0, n);
        const saga = clip(s?.saga, 1600);
        if (!saga) return false;
        journal.push({ fromYear: s.fromYear | 0, toYear: s.toYear | 0, title: clip(s.title, 100), saga, epigraph: clip(s.epigraph, 200) });
        if (journal.length > JOURNAL_MAX) journal.shift();
        return true;
      }
      if (kind !== 'legend' || typeof text !== 'string' || !text.trim()) return false;
      log.push({ tick: clock.tick, kind, tile, text: text.trim().slice(0, 300) });
      return true;
    },
  };
  return world;
}
