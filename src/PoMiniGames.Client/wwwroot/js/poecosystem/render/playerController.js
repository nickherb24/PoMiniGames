// playerController.js — the first-person god. Pure maths over the heightmap:
// no three.js, no DOM, so the walking/flying/swimming rules are unit-tested. The renderer
// copies the resulting pose onto the camera; input binding lives in input.js.
//
// The player is NOT a simulation entity: creatures never see it, it never enters a
// snapshot, and its pose is kept in prefs so Resume puts you back where you stood.
import { WORLD_SIZE } from '../sim/core/config.js';
import { TILE_STATE, isWalkable, tileIndex } from '../sim/terrain/tiles.js';

export const PLAYER = Object.freeze({
  eyeHeight: 1.7,
  radius: 0.4,
  walkSpeed: 3,
  runSpeed: 6,
  flySpeed: 12,
  swimSpeed: 1.6,
  gravity: 9.81,
  jumpSpeed: 4.4,          // ≈1 m of rise
  stepUp: 0.9,             // the tallest ledge a walker can climb
  maxPitch: 1.5533,        // ±89°
  minFlyClearance: 1,      // fly never dips below this above the ground
  maxAltitude: 150,
  swimDepth: 1.2,          // deeper water than this and the god swims
  boundary: 20,            // metres past the map edge before being pushed back
  lookSensitivity: 0.0022, // radians per pixel of pointer movement
});

const SEA_LEVEL = 0;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createPlayer(terrain, startMode = 'walk', blocked = null) {
  const size = terrain?.size ?? WORLD_SIZE;
  const p = {
    x: size / 2, y: 0, z: size / 2, yaw: 0, pitch: 0,
    vy: 0, mode: startMode, grounded: false, blocked: false, size,

    /** Mouse/touch look: dx, dy in pixels. */
    look(dx, dy) {
      p.yaw -= dx * PLAYER.lookSensitivity;
      if (p.yaw > Math.PI) p.yaw -= Math.PI * 2; else if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;
      p.pitch = clamp(p.pitch - dy * PLAYER.lookSensitivity, -PLAYER.maxPitch, PLAYER.maxPitch);
    },
    /** Unit view direction (right-handed, yaw 0 looks toward +Z). */
    direction() {
      const cp = Math.cos(p.pitch);
      return { x: Math.sin(p.yaw) * cp, y: Math.sin(p.pitch), z: Math.cos(p.yaw) * cp };
    },
    toggleFly() { p.mode = p.mode === 'fly' ? 'walk' : 'fly'; p.vy = 0; },
    pose() { return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, mode: p.mode }; },
    setPose(pose) {
      if (!pose || !Number.isFinite(pose.x)) { placeOnLand(p, terrain, p.mode === 'fly', blocked); return; }
      p.x = pose.x; p.y = pose.y; p.z = pose.z; p.yaw = pose.yaw ?? 0; p.pitch = pose.pitch ?? 0;
      p.mode = pose.mode === 'fly' ? 'fly' : 'walk';
      p.vy = 0;
      if (!inBounds(p.x, p.z, size) || !Number.isFinite(p.y)) placeOnLand(p, terrain, p.mode === 'fly', blocked);
      // A pose saved before this rule existed can sit inside a tree, and keeping it would
      // bury the camera again however good the spawn scan now is — so a blocked tile gets
      // the same treatment as an out-of-bounds one.
      else if (blocked && terrain && blocked[tileIndex(p.x, p.z, size)]) placeOnLand(p, terrain, p.mode === 'fly', blocked);
    },
  };
  if (terrain) placeOnLand(p, terrain, startMode === 'fly', blocked);
  return p;
}

const inBounds = (x, z, size) => x > -PLAYER.boundary && z > -PLAYER.boundary && x < size + PLAYER.boundary && z < size + PLAYER.boundary;

/**
 * Tiles the god must not be dropped onto, as a Uint8Array indexed by tile.
 *
 * The spawn scan asks for more than whether a tile is *walkable*, because a forest floor is:
 * the god would be placed on a tile carrying a standing tree, putting the camera at eye
 * height (1.7 m) inside the trunk and its canopy — the view fills with a green blob and
 * nothing behind it is visible. Huts, boulders and lava are included
 * because the sim's own passableTile() already treats them as solid; the god should not
 * stand where a creature cannot walk.
 *
 * A tree tile blocks only while the tree STANDS — a chopped or burnt tree leaves a stump
 * (see flora/trees.js) and tileState is the record of which it is. Without tileState every
 * tree tile blocks, which is the safe direction to fall back to.
 */
export function blockedTiles({ trees, bushes, tileState, size }) {
  const blocked = new Uint8Array(size * size);
  if (tileState) {
    for (let i = 0; i < tileState.length; i++) {
      const s = tileState[i];
      if (s === TILE_STATE.HUT || s === TILE_STATE.BOULDER || s === TILE_STATE.LAVA
        || s === TILE_STATE.TOWER || s === TILE_STATE.FENCE || s === TILE_STATE.CAMPFIRE) blocked[i] = 1;
    }
  }
  if (trees) {
    for (let k = 0; k < trees.length; k++) {
      const t = trees[k];
      const s = tileState ? tileState[t] : TILE_STATE.NORMAL;
      if (s !== TILE_STATE.STUMP && s !== TILE_STATE.BURNT) blocked[t] = 1;
    }
  }
  // Berry bushes are knee-high and would not fill the view the way a tree does, but they
  // cost nothing to avoid and the god has no business standing inside one either.
  if (bushes) for (let k = 0; k < bushes.length; k++) blocked[bushes[k]] = 1;
  return blocked;
}

/** Drop the player on the nearest walkable, unoccupied tile to the map centre (spawn /
 *  recovery). `blocked` is blockedTiles() — walkable is not the same as clear.
 *  keepFly preserves a float mode that was requested before any terrain existed. */
export function placeOnLand(p, terrain, keepFly = false, blocked = null) {
  const { size } = terrain;
  const c = size / 2;
  for (let r = 0; r < size / 2; r += 2) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const x = c + Math.cos(ang) * r; const z = c + Math.sin(ang) * r;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      const i = tileIndex(x, z, size);
      if (!isWalkable(terrain.type[i])) continue;
      if (blocked && blocked[i]) continue;
      p.x = x; p.z = z; p.y = terrain.heightAt(x, z) + PLAYER.eyeHeight; p.vy = 0; p.mode = keepFly ? 'fly' : 'walk'; p.grounded = !keepFly;
      return p;
    }
  }
  p.x = c; p.z = c; p.y = terrain.heightAt(c, c) + PLAYER.eyeHeight;
  return p;
}

/**
 * Advance the player by dt seconds. `input` is { forward, right, run, jump, up } where
 * forward/right/up are -1..1. Walking follows the heightmap with a step-up limit; deep
 * water switches to swimming; flying ignores the ground but clamps its altitude.
 */
export function stepPlayer(p, input, dt, terrain) {
  const size = terrain.size;
  const ground = terrain.heightAt(p.x, p.z);
  const deep = ground < SEA_LEVEL - PLAYER.swimDepth;
  if (p.mode !== 'fly') p.mode = deep ? 'swim' : 'walk';

  // Horizontal intent in world space (yaw 0 → +Z).
  let fx = 0; let fz = 0;
  const f = input.forward ?? 0; const r = input.right ?? 0;
  if (f || r) {
    const s = Math.sin(p.yaw); const c = Math.cos(p.yaw);
    fx = s * f + c * r; fz = c * f - s * r;
    const len = Math.hypot(fx, fz);
    fx /= len; fz /= len;
  }

  if (p.mode === 'fly') {
    const speed = PLAYER.flySpeed * (input.run ? 2 : 1);
    // Flying follows the look direction for forward motion, so pitch is a dive.
    const dir = p.direction();
    const horiz = Math.hypot(dir.x, dir.z) || 1;
    const vx = (f ? dir.x / horiz * f : 0) + (r ? Math.cos(p.yaw) * r : 0);
    const vz = (f ? dir.z / horiz * f : 0) + (r ? -Math.sin(p.yaw) * r : 0);
    const n = Math.hypot(vx, vz) || 1;
    p.x += (vx / n) * speed * dt * (f || r ? 1 : 0);
    p.z += (vz / n) * speed * dt * (f || r ? 1 : 0);
    p.y += ((input.up ?? 0) * speed + (f ? dir.y * speed * f : 0)) * dt;
    p.grounded = false;
  } else if (p.mode === 'swim') {
    p.x += fx * PLAYER.swimSpeed * dt;
    p.z += fz * PLAYER.swimSpeed * dt;
    // Float: ease the eye toward just above the surface.
    const target = SEA_LEVEL + PLAYER.eyeHeight * 0.35;
    p.y += (target - p.y) * Math.min(1, dt * 3);
    p.vy = 0;
    p.grounded = false;
  } else {
    const speed = input.run ? PLAYER.runSpeed : PLAYER.walkSpeed;
    const nx = p.x + fx * speed * dt;
    const nz = p.z + fz * speed * dt;
    // Block a step that would climb more than stepUp; slide along each axis instead.
    const climbable = (x, z) => terrain.heightAt(x, z) - ground <= PLAYER.stepUp;
    if (climbable(nx, nz)) { p.x = nx; p.z = nz; }
    else {
      if (climbable(nx, p.z)) p.x = nx;
      if (climbable(p.x, nz)) p.z = nz;
    }
    const feet = terrain.heightAt(p.x, p.z);
    if (p.grounded && input.jump) { p.vy = PLAYER.jumpSpeed; p.grounded = false; }
    p.vy -= PLAYER.gravity * dt;
    p.y += p.vy * dt;
    const floor = feet + PLAYER.eyeHeight;
    if (p.y <= floor) { p.y = floor; p.vy = 0; p.grounded = true; }
    else if (p.y - floor < 0.001) p.grounded = true;
  }

  // Boundary: a soft push back toward the island.
  p.blocked = false;
  const lo = -PLAYER.boundary; const hi = size + PLAYER.boundary;
  if (p.x < lo) { p.x = lo; p.blocked = true; } else if (p.x > hi) { p.x = hi; p.blocked = true; }
  if (p.z < lo) { p.z = lo; p.blocked = true; } else if (p.z > hi) { p.z = hi; p.blocked = true; }

  if (p.mode === 'fly') {
    const floor = terrain.heightAt(p.x, p.z) + PLAYER.minFlyClearance;
    p.y = clamp(p.y, floor, PLAYER.maxAltitude);
  }
  return p;
}
