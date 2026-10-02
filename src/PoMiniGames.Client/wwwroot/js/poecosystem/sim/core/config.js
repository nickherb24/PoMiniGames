// config.js — every tunable number in the PoEcosystem simulation lives here.
//
// The sim is deterministic per seed, so changing any value in
// this file changes every world; population tuning happens here and nowhere else.

// ── Time ─────────────────────────────────────────────────────────────────
export const TICK_SECONDS = 0.05;          // fixed sim step (20 Hz)
export const MAX_STEPS_PER_TICK = 4;       // accumulator cap: a hidden tab never bursts on return
export const YEAR_SECONDS = 30;            // creature ages are displayed in years
export const DAY_SECONDS = 120;            // cosmetic light cycle, not tied to years
export const DAYS_PER_YEAR = 10;           // calendar days shown in the HUD clock (Year N · Day D)
// Tick 0 is mid-morning, not midnight: a world that opens in the dark reads as broken.
export const DAY_START_FRACTION = 0.32;
export const SPEEDS = Object.freeze([0, 1, 2, 4]);

// ── World ────────────────────────────────────────────────────────────────
export const WORLD_SIZE = 200;             // tiles per side; 1 tile = 1 m
export const CREATURE_CAP = 400;
export const LOW_END_CREATURE_CAP = 250;
export const PROP_CAP = 256;               // ragdoll parts + logs + rocks + projectiles in flight

// ── Personality ──────────────────────────────────────────────────────────
export const TRAITS = Object.freeze(['boldness', 'sociability', 'curiosity', 'greed', 'diligence']);
export const TRAIT_MUTATION_SIGMA = 0.08;  // offspring = mean(parents) + N(0, sigma), clamped [0,1]
export const NUDGE = Object.freeze({ maxDelta: 0.25, decaySeconds: 60 });

// ── Seeded PRNG streams (SPEC / plan decision 4) ─────────────────────────
// One independent stream per subsystem so adding a cosmetic draw never shifts a
// population outcome. Salts are arbitrary distinct constants.
export const RNG_SALT = Object.freeze({
  terrain: 0x1f3d5b79,
  genetics: 0x2c4e6a8b,
  behavior: 0x3d5f7c9d,
  events: 0x4e6a8dbf,
  names: 0x5f7b9ed1,
  cosmetic: 0x6a8cafe3,
  // Adding a key never shifts the streams above it (each stream is seeded from its own
  // salt), and a snapshot written before a key existed simply leaves it at its seed.
  weather: 0x7b9dc1f5,
  tribes: 0x8cae02a7,     // diplomacy + caravans: they called Math.random until now
  ecology: 0x9dbf1339,    // disease outbreaks and spread
});

// ── Physics props (frame propKind = kind * 8 + sizeIndex) ────────────────
export const PROP_KIND = Object.freeze({ ragdollPart: 0, log: 1, rock: 2, projectile: 3 });
export const PROP_SIZES = Object.freeze([
  [0.30, 0.20, 0.45], // 0 small quadruped torso
  [0.18, 0.18, 0.18], // 1 head / small part
  [0.10, 0.28, 0.10], // 2 leg / limb
  [0.55, 0.35, 0.90], // 3 large quadruped torso
  [0.40, 0.55, 0.28], // 4 human chest
  [0.30, 2.60, 0.30], // 5 log
  [0.60, 0.60, 0.60], // 6 rock
  [1.00, 1.00, 1.00], // 7 boulder
]);

// ── External modules (workers have no import map; see plan decision 2) ───
export const CANNON_CDN_URL = 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ── Flora ────────────────────────────────────────────────────
export const FLORA = Object.freeze({
  grassInit: Object.freeze({ grass: 0.8, forest: 0.5, hill: 0.4 }),
  // Logistic regrowth rate per second, db/dt = r·(b + seed)·(1 − b); the seed term lets a
  // grazed-bare or burnt tile recover instead of staying at zero forever.
  grassRate: Object.freeze({ grass: 0.04, forest: 0.025, hill: 0.012 }),
  grassSeed: 0.03,
  maxBushes: 300,
  bushChance: 0.25,          // per forest-edge tile, in index order, until the cap
  bushRipenSeconds: 40,
  bushFoodValue: 0.3,        // hunger removed by one stripped bush
  treeDensity: 0.35,         // fraction of forest tiles carrying a tree
  treeRegrowSeconds: 180,    // stump → standing
  treeBurnRegrowMultiplier: 2,
  logsPerTree: 3,
});

// ── Behaviour ────────────────────────────────────────────────
export const MEMORY = Object.freeze({ foodSeconds: 120, waterSeconds: 240 });
export const BEHAVIOR = Object.freeze({
  spatialCell: 8,            // metres per spatial-hash cell (max perception 25 m = 4 cells)
  goalHysteresis: 0.05,      // a new goal must beat the current one by this much
  rescoreEveryTicks: 5,      // goals re-evaluated every N ticks, staggered by index
  wanderTurn: 0.6,           // radians of yaw jitter per wander step
  alertTicks: 120,           // 6 s: how long a herd alarm keeps neighbours fleeing
  orphanHungerMultiplier: 1.5,
  herdRadius: 12,
  packRadius: 12,
  bedsPerHut: 4,
  hutSiteRadius: 6,          // new huts stay within this many tiles of the first hut
  firstHutWaterRadius: 4,    // the first hut is placed on grass within this many tiles of water
});

// ── World composition (start population, interaction rules) ──
export const POPULATION = Object.freeze({ rabbits: 40, deer: 20, wolves: 6, humans: 18, huts: 3, initialAgeFraction: 0.6 });
export const TRIBES = Object.freeze({
  count: 3,
  humansPerTribe: 6,
  territoryRadius: 28,
  minTribeSeparation: 35,
  telemetryThrottleSeconds: 0.5, // 2 Hz telemetry updates to Blazor
  elderAgeYears: 25,
  researchPerElderPerTick: 0.08,
  researchBasePerTick: 0.02,
  frictionBorderOverlapWeight: 1.5,
  frictionScarcityWeight: 2.0,
  warCasualtyThreshold: 0.35, // 35% losses prompts peace negotiation
  peaceCooldownTicks: 600,     // 30 s peace treaty cooldown
});
export const WORLD = Object.freeze({
  grazeRate: 0.4,            // biomass (= hunger) per second while eating grass
  drinkRate: 0.5,            // thirst per second while drinking
  foodBiomassMin: 0.15,      // a tile counts as food above this biomass
  foodScanTiles: 5,          // half-size of the square scanned for grass/bushes
  treeScanTiles: 12,         // half-size of the square humans scan for a standing tree
  carcassSeconds: 60,
  carcassFoodFraction: 0.5,  // food left on a carcass after the kill is eaten
  chopSeconds: 3,
  reachPadding: 0.4,         // metres added to the radii for a bite/kill
  interactDistance: 1.5,     // metres to eat a bush/carcass, drink, mate, enter a hut
  fullLogCooldownSeconds: 60,
  popSampleTicks: 20,        // one population sample per second
  popHistoryMax: 1800,       // 30 minutes of samples
  birthOffset: 1.0,          // metres offspring spawn from the mother
  traitSampleTicks: 200,     // per-species trait means sampled every 10 s (the evolution chart)
  traitHistoryMax: 720,      // two hours of samples
  lineageMax: 6000,          // dead lineage records kept before the oldest are forgotten
  nameMaxChars: 24,          // a player-given creature name is clipped to this
});

// ── The tribe's works (behavior/tech.js) ────────────────────────────────
// Each tier unlocks when every listed condition holds, checked once a second. Tiers are
// cumulative and never lost; what they build can still burn or be buried.
export const TECH = Object.freeze({
  fire: Object.freeze({ hutsBuilt: 1, humans: 5 }),
  palisade: Object.freeze({ hutsBuilt: 3, humans: 9 }),
  farming: Object.freeze({ year: 4, humans: 11 }),
  watchtower: Object.freeze({ year: 8, hutsBuilt: 5 }),
  campfireScareRadius: 10,   // wolves treat a lit campfire inside this many metres as a threat
  campfireWarmRadius: 6,     // humans this close regain health at night
  campfireRegenPerSecond: 0.02,
  fenceRadius: 8,            // tiles from the first hut to the palisade ring
  fenceGateEvery: 6,         // every Nth ring tile is left open so the village stays reachable
  fieldCount: 8,             // berry plots planted on farming
  fieldRipenMultiplier: 3,   // a field ripens this many times faster than a wild bush
  towerPerceptionMultiplier: 1.4,
  towerHuntReachBonus: 1.5,
});

// ── Physics. Cosmetic only: no rule reads a body. ───────────
export const PHYSICS = Object.freeze({
  gravity: 9.81,
  substeps: 2,               // cannon steps per sim tick (1 on low-end devices)
  solverIterations: 10,
  maxActiveRagdolls: 16,     // ≈100 bodies; beyond this a death lies down statically
  ragdollMaxSeconds: 8,      // a ragdoll is frozen into a carcass by then at the latest
  carcassSeconds: 60,        // frozen carcass parts stay this long
  logSeconds: 300,           // a settled log stays this long
  rockSeconds: 120,          // a settled rock stays this long (SPEC: obstacle for 120 s)
  settleTimeoutSeconds: 15,  // rocks/logs are frozen by then even if still twitching
  treeHingeSeconds: 1,       // the trunk swings on its stump this long before breaking free
  sleepSpeedLimit: 0.2,
  sleepTimeLimit: 0.5,
  linearDamping: 0.08,
  angularDamping: 0.25,
  friction: 0.6,
  restitution: 0.15,
});

// ── Natural events ───────────────────────────────────────────
export const EVENTS = Object.freeze({
  minSpacingSeconds: 45,     // between any two natural events
  intervalSeconds: Object.freeze({ lightning: [90, 240], rockslide: [120, 300], eruption: [240, 480], drought: [180, 420] }),
  lightning: Object.freeze({ killRadius: 6, treeRadius: 3, fearRadius: 10, strength: 40 }),
  drought: Object.freeze({ durationSeconds: 25, fearRadius: 20 }),
  rockslide: Object.freeze({
    count: [3, 8], speed: [3, 7], up: [2, 5],
    rollTiles: 12,           // corridor length downhill from the impact tile
    rollSeconds: 4,          // window during which corridor tiles are lethal
    impactRadius: 1.5,       // metres around the analytic impact point that kill at impact tick
    boulderSeconds: 120,     // the settled rock blocks the corridor's end tile this long
    fearRadius: 12,
  }),
  fire: Object.freeze({
    spreadPerSecond: Object.freeze({ grass: 0.08, forest: 0.1 }), // per flammable neighbour per second; grass scales with biomass, so ~0.4 offspring per burning tile and fires die out
    maxBurning: 400,         // cap on simultaneously burning tiles (cost bound)
  }),
  volcano: Object.freeze({
    blastRadius: 12, strength: 60,
    projectiles: [8, 15], speed: [6, 14], up: [8, 16],
    lavaSeconds: 30,         // lava creeps this long, then cools to rock
    creepSeconds: 1,         // the lava front advances one tile per creep
    branchChance: 0.4,       // chance a front tile also spills into a second lower neighbour
    maxLavaTiles: 150,
    fearRadius: 40,
  }),
  fearDecayPerSecond: 0.15,  // fear painted on tiles fades at this rate
  fireSeconds: 6,            // a tile burns this long (T12 fire spread builds on it)
  burntSeconds: 60,          // burnt tiles recover to normal after this long
});

// ── Weather (events/weather.js) ──────────────────────────────────────────
// A spell of one kind lasts `spellSeconds`, then the next is rolled from the season's
// weights. A year is only 30 s and a season 6-9 s, so spells are short, and a season
// change ends any natural spell the new season gives no weight (no snow in spring).
// Every multiplier is eased in and out by the spell's intensity, so a drought tightens
// over a few seconds rather than switching on. Order: clear, rain, storm, drought, snow.
export const WEATHER = Object.freeze({
  spellSeconds: Object.freeze([10, 24]),
  easeSeconds: 3,
  seasonWeights: Object.freeze([
    Object.freeze([5, 4, 1, 0, 0]),   // spring
    Object.freeze([6, 2, 1, 3, 0]),   // summer
    Object.freeze([5, 3, 2, 1, 0]),   // autumn
    Object.freeze([4, 1, 0, 0, 5]),   // winter
  ]),
  grassGrowth: Object.freeze([1, 1.8, 1.5, 0.35, 0.15]),
  bushRipen: Object.freeze([1, 1.3, 1.2, 0.6, 0.3]),
  thirst: Object.freeze([1, 0.75, 0.8, 1.35, 0.9]),
  fireBurnout: Object.freeze([1, 3, 4, 0.7, 4]),   // >1 burns a tile out faster
  fireSpread: Object.freeze([1, 0.35, 0.3, 1.6, 0.2]),
  wetnessPerSecond: Object.freeze([0, 0.02, 0.03, -0.025, 0.01]),
  stormStrikeChancePerSecond: 0.04,
});

// ── Disease (creatures/disease.js) ───────────────────────────────────────
// The population brake the island never had: a crowded species can catch a sickness that
// spreads by contact, drains health and leaves survivors immune for a while.
export const DISEASE = Object.freeze({
  checkEverySeconds: 30,
  outbreakDensity: Object.freeze([110, 55, 24, 40]),   // by species id
  outbreakChance: 0.35,
  spreadRadius: 2.5,
  spreadChancePerSecond: 0.12,
  sickSeconds: 40,
  immuneSeconds: 240,
  damagePerSecond: 0.012,
});

// ── Varieties (world.js sampleTraits) ────────────────────────────────────
// When a species' mean personality drifts this far (euclidean, five traits) from the mean
// its last variety was named at, the island names a new variety after the biggest shift.
// The founders are random, so the first few years always drift fast as they die off: the
// baseline is only taken once `settleYears` have passed, and a species waits
// `cooldownYears` between varieties.
export const VARIETY = Object.freeze({ drift: 0.26, minCount: 6, max: 40, settleYears: 4, cooldownYears: 15 });

// ── Timeline (dashboard) ─────────────────────────────────────────────────
export const HISTORY = Object.freeze({ landmarksMax: 300, yearsMax: 2000 });

// ── Thoughts ─────────────────────────────────────────────────
export const THOUGHTS = Object.freeze({
  maxPromptChars: 600,
  maxThoughtChars: 120,
  templateEveryTicks: 40,    // with the LLM off (or between its answers) a template thought lands every 2 s
  feedCap: 40,               // island-wide thought stream kept for the dashboard's feed panel
});

// ── Host / worker protocol (plan decision 3) ─────────────────────────────
export const HOST = Object.freeze({
  frameBuffers: 3,           // transferable frame pool; frames are skipped, never allocated, when empty
  loopMs: 50,                // worker wake-up interval (one sim tick at 1×)
  statsEveryTicks: 10,       // stats + drained events every 0.5 s
  detailEveryTicks: 5,       // inspector refresh for the selected creature
  tilesEveryTicks: 20,       // tile state / grass / tree state sync once per second
  autosaveSeconds: 10,
  thoughtBatchSize: 8,       // cloud thoughts: creatures per server call (the endpoint takes 8)
  thoughtBatchEveryMs: 20000,
});
