// constants.js — match constants shared by BrawlGame and its mixin modules.
// Separate from game.js so the mixins can import them without a cycle.

/** Fixed simulation step. The sim runs at a hard 60 Hz regardless of frame rate. */
export const SIM_DT = 1 / 60;

/** Full health. Region damage and the HUD bars are both expressed against this. */
export const MAX_HP = 100;

// Frame-data table. cancelInto = minimum stateT to transition into each named
// state. { idle: 0 } means recovery auto-completes when stateT reaches the end.
// Damage is sized for ~25-40 exchanges a match; the damage-derived feel scalars
// (stagger threshold, reaction power, audio power) are scaled to it.
// `reach` is the real polygon contact range: striker capsules ride the fist/shoe
// meshes (hitboxes.js), so root-to-root hit distance ≈ limb extension + lunge.
// Punch buys tempo, kick takes the bite: `energyMul` scales ATTACK_ENERGY_COST at
// the swing, and damage per unit of energy is kept about even between them.
export const ATTACKS = {
  punch: { name: 'punch', windup: 0.06, active: 0.06, recover: 0.15, dmg: 3.75, reach: 1.2,
           energyMul: 0.5,
           cancelInto: { idle: 0.22, punch: 0.16, kick: 0.20, block: 0.24 } },
  kick:  { name: 'kick',  windup: 0.12, active: 0.12, recover: 0.30, dmg: 15, reach: 1.45,
           energyMul: 1.0,
           cancelInto: { idle: 0.42, punch: 0.34, kick: 0.36, block: 0.40 } },
};

// Fighters never leave their feet before the final blow — heavy hits get a
// hard stagger (extra knockback + lean) instead of a mid-fight knockdown.
// The KO ragdoll is the only way to the canvas.
export const HEAVY_HIT_DMG = 13; // threshold for the amplified stagger reaction
