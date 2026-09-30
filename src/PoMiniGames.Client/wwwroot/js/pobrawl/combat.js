// combat.js — health/armor/death/winner resolution for the match.
// Adapted from GameBlocks (github.com/xt4d/GameBlocks, MIT) gameplay/CombatPlay.js,
// trimmed to what a 1v1 brawler needs: two players, each its own team, armor
// absorption, a PLAYER_KILLED / COMBAT_FINISHED event queue, and winner resolution.
// The engine owns visuals/animation; this owns the numbers and the "who won" rule.

const COMBAT_STATES = Object.freeze({
  WAITING: 'WAITING',
  STARTED: 'STARTED',
  FINISHED: 'FINISHED',
});

export const COMBAT_EVENTS = Object.freeze({
  PLAYER_KILLED: 'combat.player.killed',
  COMBAT_FINISHED: 'combat.finished',
});

// Region ids used for per-region damage. The engine maps each to a rig region.
export const REGIONS = Object.freeze({
  HEAD: 'head', TORSO: 'torso', ARMS: 'arms', LEGS: 'legs',
});

export class CombatPlay {
  constructor({ maxHealth = 100, maxArmor = 100, armorAbsorption = 0.6 } = {}) {
    this.maxHealth = maxHealth;
    this.maxArmor = maxArmor;
    this.armorAbsorption = armorAbsorption;
    this.players = new Map();
    this.combatState = COMBAT_STATES.WAITING;
    this.winnerTeamId = null;
    this._events = [];
  }

  addPlayer({ playerId, teamId, health = this.maxHealth, armor = 0 }) {
    this.players.set(playerId, {
      playerId, teamId,
      maxHealth: this.maxHealth, health,
      maxArmor: this.maxArmor, armor,
      alive: health > 0,
    });
  }

  startGame() {
    this.winnerTeamId = null;
    this.combatState = COMBAT_STATES.STARTED;
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  damage({ playerId, amount, sourceId = null, bypassArmor = false }) {
    if (this.combatState !== COMBAT_STATES.STARTED) return 0;
    const p = this.players.get(playerId);
    if (!p || !p.alive) return 0;

    const armorDamage = bypassArmor ? 0 : Math.min(p.armor, amount * this.armorAbsorption);
    const healthDamage = Math.min(p.health, amount - armorDamage);
    p.armor -= armorDamage;
    p.health -= healthDamage;
    p.alive = p.health > 0;

    if (!p.alive) {
      this._events.push({ type: COMBAT_EVENTS.PLAYER_KILLED, playerId, sourceId });
    }
    return healthDamage;
  }

  getAliveTeamIds() {
    return Array.from(new Set(
      Array.from(this.players.values()).filter((p) => p.alive).map((p) => p.teamId)
    ));
  }

  // Resolves the match when one team remains, then drains queued events.
  step() {
    if (this.combatState === COMBAT_STATES.STARTED) {
      const alive = this.getAliveTeamIds();
      if (alive.length <= 1) {
        this.combatState = COMBAT_STATES.FINISHED;
        this.winnerTeamId = alive[0] ?? null;
        this._events.push({ type: COMBAT_EVENTS.COMBAT_FINISHED, winnerTeamId: this.winnerTeamId });
      }
    }
    const events = this._events;
    this._events = [];
    return events;
  }
}

// Per-region damage state lives alongside the CombatPlay in the engine, but the
// rules for region-to-effect translation are shared here so tests and AI can
// reason about them. The engine calls `regionEffect(regionDmg)` to compute the
// combined status effect modifier for the current tick.
//
// Region damage thresholds (0..100):
//   head  >= 70  → +flinch (longer hitstun)
//   arms  >= 70  → -attack power
//   legs  >= 70  → -move speed
// Returns multipliers and additive flags the engine can apply.
export function regionEffect(regionDmg) {
  let moveMul = 1.0;
  let atkMul = 1.0;
  let flinchBonus = 0;
  const head = regionDmg.head ?? 0;
  const arms = regionDmg.arms ?? 0;
  const legs = regionDmg.legs ?? 0;
  if (head >= 70) flinchBonus = 0.10;
  else if (head >= 40) flinchBonus = 0.04;
  if (arms >= 70) atkMul = 0.85;
  else if (arms >= 30) atkMul = 0.95;
  if (legs >= 70) moveMul = 0.65;
  else if (legs >= 30) moveMul = 0.85;
  return { moveMul, atkMul, flinchBonus };
}