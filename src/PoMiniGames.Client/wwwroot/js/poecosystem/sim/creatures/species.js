// species.js — the four species. Rates are per real second at 1× speed.
// Ages are in years (YEAR_SECONDS); speeds in metres per second on the 1 m tile grid.

export const SPECIES_ID = Object.freeze({ RABBIT: 0, DEER: 1, WOLF: 2, HUMAN: 3 });

const STARVE_SECONDS = 75;   // hunger 0 → 1
// Thirst 0 → 1 per species (CP-C tuning): grazers take moisture from grass, so a rabbit
// 60 m from the shore is not a dead rabbit; big-bodied predators and humans drink more.
const DEHYDRATE_SECONDS = Object.freeze([120, 90, 80, 90]);

const PREY_OF = (eats) => Object.freeze([eats.rabbit ? 0 : -1, eats.deer ? 1 : -1].filter(i => i >= 0));

function species(o) {
  // Behaviour that used to be an `if (species === X)` in world.js is a capability here, so
  // species.js stays the complete description of a species.
  const prey = PREY_OF(o.eats);
  return Object.freeze({
    prey,
    carnivore: prey.length > 0,
    packHunts: false, sharesKills: false, alarms: false, builds: false, fleeStyle: 'direct',
    hungerRate: 1 / STARVE_SECONDS,
    thirstRate: 1 / DEHYDRATE_SECONDS[o.id],
    starveDamage: 0.05,        // health per second while hunger or thirst > 0.9 (death in ~20 s)
    regenRate: 0.01,           // health per second while both drives < 0.5
    oldAgeStart: 0.85,         // fraction of maxAge where old-age hazard begins
    juvenileScale: 0.55,
    ...o,
  });
}

export const SPECIES = Object.freeze([
  species({
    id: 0, name: 'Rabbit', plural: 'Rabbits',
    maxAgeYears: 6, matureYears: 1, walkSpeed: 3, runSpeed: 6,
    eats: Object.freeze({ grass: true, berries: true, trees: true }),
    gestationSeconds: 20, litter: Object.freeze([1, 3]), mateCooldownSeconds: 60,
    radius: 0.25, mass: 2, perception: 12, mealValue: 0.35, foodValue: 0.5, sprintSeconds: 2,
    foodScanTiles: 5, huntReach: 0, flees: Object.freeze({ 2: 9, 3: 4 }),
    alarms: true, fleeStyle: 'scatter',
  }),
  species({
    id: 1, name: 'Deer', plural: 'Deer',
    maxAgeYears: 12, matureYears: 2, walkSpeed: 4, runSpeed: 8,
    eats: Object.freeze({ grass: true, berries: true, trees: true }),
    gestationSeconds: 30, litter: Object.freeze([1, 2]), mateCooldownSeconds: 40,
    radius: 0.6, mass: 60, perception: 18, mealValue: 0.3, foodValue: 1.0, sprintSeconds: 4,
    foodScanTiles: 6, huntReach: 0, flees: Object.freeze({ 2: 12, 3: 5 }),
    alarms: true,
  }),
  species({
    id: 2, name: 'Wolf', plural: 'Wolves',
    maxAgeYears: 12, matureYears: 2, walkSpeed: 4.5, runSpeed: 9,
    eats: Object.freeze({ rabbit: true, deer: true, carcass: true }),
    gestationSeconds: 30, litter: Object.freeze([2, 3]), mateCooldownSeconds: 70,
    radius: 0.5, mass: 40, perception: 35, mealValue: 0.6, foodValue: 0.8, sprintSeconds: 5,
    foodScanTiles: 0, huntReach: 0.4, flees: Object.freeze({}),
    packHunts: true, sharesKills: true,
  }),
  species({
    id: 3, name: 'Human', plural: 'Humans',
    maxAgeYears: 24, matureYears: 4, walkSpeed: 2, runSpeed: 4,
    eats: Object.freeze({ berries: true, rabbit: true, deer: true, carcass: true }),
    gestationSeconds: 40, litter: Object.freeze([1, 1]), mateCooldownSeconds: 60,
    radius: 0.4, mass: 70, perception: 22, mealValue: 0.5, foodValue: 0, sprintSeconds: 6,
    // flees: threat species id → distance at which it triggers a flee. Slow humans
    // only scare prey up close; huntReach is the extra kill distance (humans throw spears).
    foodScanTiles: 20, huntReach: 5.5, flees: Object.freeze({ 2: 8 }),
    builds: true,
  }),
]);
