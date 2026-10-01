// fortress.js — the siege: what the fortress is made of, what shoots at you, and the
// golden chalice you are trying to reach.
//
// The game used to be "survive in a settlement". It is now "break into a fortress".
// That changes the shape of the world from scattered buildings to ONE concentric
// structure: an outer curtain wall with corner bastions, an inner ward inside it, and a
// great keep at the centre with the chalice in its vault. The player spawns outside and
// wins by touching the chalice.
//
// Three things live here:
//   * volume generators for the fortress pieces (rampart runs, bastions, gatehouse,
//     great keep) — same decoded-pvx shape as every other volume, so the destruction
//     stack treats them identically and every wall is diggable;
//   * FortressGuns — wall-mounted turrets that track and shoot the player. A turret dies
//     when the masonry under it is carved away, which is deliberate: it means the ONLY
//     way to silence the guns is the same way you get in, so demolition is never a
//     detour from the objective;
//   * Chalice — the win condition.
//
// Fortress volumes are authored at CELLS_PER_UNIT cells per world unit and placed at the
// reciprocal scale, so a wall "14 units tall" is literally 14 units tall. Everything else
// in the game sizes itself from a sizeRange; these pieces have to interlock, so they are
// dimensioned instead of sampled.

import * as THREE from 'three';
import { buildMaterialTable } from './physics.js';

export const CELLS_PER_UNIT = 2;   // authoring resolution; world.js refines this further
export const FORTRESS_SCALE = 1 / CELLS_PER_UNIT;

// Ring geometry, in world units. Half-extents of two concentric squares plus the keep.
export const OUTER_HALF = 58;
export const INNER_HALF = 30;
export const WALL_HEIGHT_OUTER = 15;
export const WALL_HEIGHT_INNER = 12;
export const KEEP_HALF = 13;
export const KEEP_HEIGHT = 34;
// Spawn sits outside the outer wall on +Z, far enough back that the whole fortress is in
// frame on the first look — the silhouette IS the briefing.
export const SPAWN_Z = 78;

// Colours carry their material with them: the mortar-dark course at the base of a wall
// really is the same stone, but the timber gate jambs are not, and the stress solver
// needs to know that a lintel is oak before it decides whether it snaps.
const STONE_LIGHT = [[172, 174, 182], 'stone'];
const STONE_DARK = [[118, 122, 132], 'stone'];
const STONE_BASE = [[86, 90, 100], 'stone'];
const WOOD = [[104, 76, 48], 'wood'];
const GOLD = [[232, 190, 88], 'stone'];

function makeVol(name, nx, ny, nz, entries) {
  const palette = new Uint8Array(entries.length * 4);
  entries.forEach(([[r, g, b]], i) => palette.set([r, g, b, 255], i * 4));
  const { materials, paletteMaterial } = buildMaterialTable(entries.map(e => e[1]));
  return {
    name,
    dims: [nx, ny, nz],
    cells: new Uint8Array(nx * ny * nz),
    palette,
    paletteMaterial,
    materials,
  };
}

function set(v, x, y, z, c) {
  const [nx, ny, nz] = v.dims;
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
  v.cells[x + y * nx + z * nx * ny] = c;
}

/** Inclusive box fill (c = 0 carves). */
function box(v, x0, y0, z0, x1, y1, z1, c) {
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) set(v, x, y, z, c);
    }
  }
}

const u = (units) => Math.max(1, Math.round(units * CELLS_PER_UNIT));

// ── Rampart: one straight run of curtain wall ──────────────────────────────
// Solid core with a crenellated parapet and a recessed walkway, so a breach reads as a
// hole punched through a thick wall rather than a knocked-over fence.

export function rampart(lengthUnits, heightUnits, thicknessUnits = 5) {
  const L = u(lengthUnits), H = u(heightUnits) + u(2), T = u(thicknessUnits);
  const v = makeVol('Rampart', L, H, T, [STONE_LIGHT, STONE_DARK, STONE_BASE]);
  const LIGHT = 1, DARK = 2, BASE = 3;
  const wallTop = u(heightUnits);

  box(v, 0, 0, 0, L - 1, wallTop, T - 1, LIGHT);
  box(v, 0, 0, 0, L - 1, u(1.5), T - 1, BASE);              // battered footing course
  // Walkway: a channel down the middle of the top, so the parapet stands proud.
  box(v, 0, wallTop - u(0.5), u(1.2), L - 1, wallTop, T - 1 - u(1.2), 0);
  // Merlons: 2-on / 2-off along both faces.
  const tooth = u(1.2);
  for (let x = 0; x < L; x++) {
    if (Math.floor(x / tooth) % 2 !== 0) continue;
    box(v, x, wallTop + 1, 0, x, H - 1, u(1.0), DARK);
    box(v, x, wallTop + 1, T - 1 - u(1.0), x, H - 1, T - 1, DARK);
  }
  // Arrow slits: the wall has to look manned even before the guns open up.
  for (let x = u(6); x < L - u(6); x += u(9)) {
    box(v, x, u(6), 0, x, u(8), T - 1, 0);
  }
  return v;
}

// ── Bastion: corner tower, taller than the wall, carries a gun platform ────

export function bastion(sizeUnits, heightUnits) {
  const S = u(sizeUnits), H = u(heightUnits) + u(2.5);
  const v = makeVol('Bastion', S, H, S, [STONE_LIGHT, STONE_DARK, STONE_BASE]);
  const LIGHT = 1, DARK = 2, BASE = 3;
  const top = u(heightUnits);
  const shell = u(2);

  box(v, 0, 0, 0, S - 1, top, S - 1, LIGHT);
  box(v, shell, u(2), shell, S - 1 - shell, top - u(1), S - 1 - shell, 0); // hollow shaft
  box(v, 0, 0, 0, S - 1, u(2.5), S - 1, BASE);                            // solid plinth
  box(v, 0, top, 0, S - 1, top, S - 1, DARK);                             // gun deck floor
  const tooth = u(1.2);
  for (let i = 0; i < S; i++) {
    if (Math.floor(i / tooth) % 2 !== 0) continue;
    box(v, i, top + 1, 0, i, H - 1, u(1.0), DARK);
    box(v, i, top + 1, S - 1 - u(1.0), i, H - 1, S - 1, DARK);
    box(v, 0, top + 1, i, u(1.0), H - 1, i, DARK);
    box(v, S - 1 - u(1.0), top + 1, i, S - 1, H - 1, i, DARK);
  }
  return v;
}

// ── Gatehouse: the one way in that is not a hole you made yourself ─────────

export function gatehouse(widthUnits, heightUnits, thicknessUnits = 5) {
  const W = u(widthUnits), H = u(heightUnits) + u(4), T = u(thicknessUnits);
  const v = makeVol('Gatehouse', W, H, T, [STONE_LIGHT, STONE_DARK, STONE_BASE, WOOD]);
  const LIGHT = 1, DARK = 2, BASE = 3, TIMBER = 4;
  const top = u(heightUnits) + u(3);

  box(v, 0, 0, 0, W - 1, top, T - 1, LIGHT);
  box(v, 0, 0, 0, W - 1, u(1.5), T - 1, BASE);
  // The passage. Wide and tall enough to walk and look through — a gate you cannot see
  // daylight through is just a wall with decoration.
  const cx = Math.floor(W / 2), gw = u(3), gh = u(5);
  box(v, cx - gw, 0, 0, cx + gw, gh, T - 1, 0);
  box(v, cx - gw - u(0.7), 0, 0, cx - gw - 1, gh + u(0.7), T - 1, TIMBER); // jambs
  box(v, cx + gw + 1, 0, 0, cx + gw + u(0.7), gh + u(0.7), T - 1, TIMBER);
  box(v, cx - gw, gh + 1, 0, cx + gw, gh + u(0.7), T - 1, TIMBER);         // lintel
  const tooth = u(1.2);
  for (let x = 0; x < W; x++) {
    if (Math.floor(x / tooth) % 2 !== 0) continue;
    box(v, x, top + 1, 0, x, H - 1, u(1.0), DARK);
    box(v, x, top + 1, T - 1 - u(1.0), x, H - 1, T - 1, DARK);
  }
  return v;
}

// ── Great keep: the prize is inside this ───────────────────────────────────
// Hollow, with a vault chamber at the base. The only openings are one narrow door and
// the windows above it, so the fast route in is through a wall — which is the point.

export function greatKeep(halfUnits, heightUnits) {
  const S = u(halfUnits * 2), H = u(heightUnits);
  const v = makeVol('Great Keep', S, H, S, [STONE_LIGHT, STONE_DARK, STONE_BASE, GOLD]);
  const LIGHT = 1, DARK = 2, BASE = 3, GILT = 4;
  const shell = u(2.5);

  box(v, 0, 0, 0, S - 1, H - u(4), S - 1, LIGHT);
  box(v, shell, u(1), shell, S - 1 - shell, H - u(5), S - 1 - shell, 0); // hollow
  box(v, 0, 0, 0, S - 1, u(2), S - 1, BASE);                            // plinth
  box(v, shell, u(1), shell, S - 1 - shell, u(2), S - 1 - shell, 0);    // vault floor void
  // Upper tier + crown.
  const t0 = u(3), t1 = S - 1 - u(3);
  box(v, t0, H - u(5), t0, t1, H - 1, t1, LIGHT);
  box(v, t0 + shell, H - u(4), t0 + shell, t1 - shell, H - 1, t1 - shell, 0);
  const tooth = u(1.2);
  for (let i = t0; i <= t1; i++) {
    if (Math.floor(i / tooth) % 2 !== 0) continue;
    box(v, i, H - u(1.2), t0, i, H - 1, t0 + u(0.8), DARK);
    box(v, i, H - u(1.2), t1 - u(0.8), i, H - 1, t1, DARK);
  }
  // Vault door on +Z, deliberately narrow, with a gilded surround so the eye finds it.
  const cx = Math.floor(S / 2), dw = u(1.6), dh = u(3.2);
  box(v, cx - dw, u(2), S - 1 - shell, cx + dw, u(2) + dh, S - 1, 0);
  box(v, cx - dw - 1, u(2), S - 1 - u(0.6), cx - dw - 1, u(2) + dh + 1, S - 1, GILT);
  box(v, cx + dw + 1, u(2), S - 1 - u(0.6), cx + dw + 1, u(2) + dh + 1, S - 1, GILT);
  box(v, cx - dw, u(2) + dh + 1, S - 1 - u(0.6), cx + dw, u(2) + dh + 1, S - 1, GILT);
  // Window slits higher up, so the keep reads as occupied rather than solid.
  for (const wy of [u(9), u(15), u(21)]) {
    box(v, cx, wy, 0, cx, wy + u(1.5), shell, 0);
    box(v, 0, wy, cx, shell, wy + u(1.5), cx, 0);
    box(v, S - 1 - shell, wy, cx, S - 1, wy + u(1.5), cx, 0);
  }
  return v;
}

// ── The chalice ────────────────────────────────────────────────────────────

const WIN_RADIUS = 3.2;

export class Chalice {
  constructor(scene, position, quality) {
    this.scene = scene;
    this.position = position.clone();
    this.taken = false;
    this.t = 0;

    this.group = new THREE.Group();
    this.group.position.copy(position);
    // Emissive gold: the bloom pass is already in the chain, so a bright emissive is all
    // it takes for the chalice to glow through a breach from across the courtyard.
    const gold = new THREE.MeshStandardMaterial({
      color: 0xffcc4d, emissive: 0xff9d1c, emissiveIntensity: 1.6,
      roughness: 0.24, metalness: 0.95,
    });
    this.material = gold;
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.26, 0.85, 18, 1, true), gold);
    cup.position.y = 1.05;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 10), gold);
    stem.position.y = 0.4;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.16, 18), gold);
    foot.position.y = 0.1;
    const knop = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), gold);
    knop.position.y = 0.62;
    for (const m of [cup, stem, foot, knop]) { m.castShadow = true; this.group.add(m); }
    this.parts = [cup, stem, foot, knop];

    // A light of its own, so the vault is lit even before you breach the roof. Range is
    // short: this is a landmark, not a second sun.
    this.light = new THREE.PointLight(0xffb64d, quality.pbr ? 26 : 16, 26, 2);
    this.light.position.y = 1.2;
    this.group.add(this.light);

    // Beacon column, visible over the walls so the objective is legible from spawn.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 1.4, 90, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffc45c, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    beam.position.y = 45;
    this.beam = beam;
    this.group.add(beam);

    scene.add(this.group);
  }

  update(dt) {
    if (this.celebrating) {
      // The win beat: the cup lifts and spins up, the beacon flares to a pillar. Runs on
      // the engine's slowed victory clock, so it reads as a held moment, not a pop.
      this.t += dt;
      this.group.rotation.y += dt * (3 + this.t * 4);
      for (const p of this.parts) p.position.y += dt * 1.1;
      const flare = Math.min(1, this.t / 1.2);
      this.beam.scale.set(1 + flare * 3.5, 1, 1 + flare * 3.5);
      this.beam.material.opacity = 0.16 + flare * 0.4;
      this.light.intensity = 26 + flare * 70;
      return;
    }
    if (this.taken) return;
    this.t += dt;
    this.group.rotation.y += dt * 0.9;
    for (const p of this.parts) p.position.y += Math.sin(this.t * 2.1) * dt * 0.12;
    this.light.intensity = 20 + Math.sin(this.t * 3.3) * 6;
    this.beam.material.opacity = 0.13 + Math.sin(this.t * 1.7) * 0.04;
  }

  /** The chalice was taken for real (not by the kiosk bot): play the flare instead of vanishing. */
  celebrate() {
    this.taken = true;
    this.celebrating = true;
    this.t = 0;
  }

  /** True on the frame the player first touches it. Latches, so it fires exactly once. */
  reached(playerPosition) {
    if (this.taken) return false;
    const dx = playerPosition.x - this.position.x;
    const dz = playerPosition.z - this.position.z;
    const dy = playerPosition.y - this.position.y;
    if (dx * dx + dz * dz + dy * dy > WIN_RADIUS * WIN_RADIUS) return false;
    this.taken = true;
    return true;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const p of this.parts) p.geometry.dispose();
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    this.material.dispose();
  }
}

// ── Wall guns ──────────────────────────────────────────────────────────────

const TURRET_RANGE = 120;
const TURRET_COOLDOWN_S = 2.2;
const TURRET_SPREAD = 0.035;       // radians of aim error, so the fortress is not a sniper
const BULLET_SPEED = 46;
const BULLET_LIFE_S = 4;
// 22 guns ring the fortress. Damage is set for the case where several have line of
// sight at once: crossing open ground under four guns should hurt and be survivable,
// which at this cooldown means single digits, not a rifle shot.
const BULLET_DAMAGE = 6;
const ALIVE_CHECK_S = 0.6;
// How far below a muzzle the support scan looks. Has to clear the tallest interior void
// any fortress piece has under its gun deck (the bastion shaft, ~5 units).
const SUPPORT_DEPTH = 7;

export class FortressGuns {
  /**
   * @param opts { onPlayerDamage(amount, fromPosition),
   *   fx: { fire(position), hit(position), whiz(position), destroyed(position) } }
   */
  constructor(scene, structures, terrain, opts = {}) {
    this.scene = scene;
    this.structures = structures;
    this.terrain = terrain;
    this.opts = opts;
    this.turrets = [];
    this.bullets = [];
    this._aliveClock = 0;

    this.barrelGeometry = new THREE.CylinderGeometry(0.26, 0.34, 2.2, 10);
    this.barrelGeometry.rotateX(Math.PI / 2); // point down −Z so lookAt aims the muzzle
    this.mountGeometry = new THREE.SphereGeometry(0.55, 10, 8);
    this.barrelMaterial = new THREE.MeshStandardMaterial({
      color: 0x39383d, roughness: 0.5, metalness: 0.7,
    });
    // A tracer, not a ball: a thin bolt stretched along its flight (lookAt aims it), and
    // additive so the bloom pass turns it into a streak. At 46 u/s a 0.22 sphere was a dot
    // you felt before you saw; a 2.6-unit line says where it came from.
    this.bulletGeometry = new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6);
    this.bulletGeometry.rotateX(Math.PI / 2);
    this.bulletMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd08a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    this._dir = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._probe = new THREE.Vector3();
  }

  /**
   * Mount a gun.
   * @param position world muzzle position
   * @param structure the piece it is bolted to; when that masonry is carved away the gun
   *   falls silent. Passing null makes an indestructible gun, which nothing here does.
   */
  add(position, structure) {
    const group = new THREE.Group();
    group.position.copy(position);
    const mount = new THREE.Mesh(this.mountGeometry, this.barrelMaterial);
    const barrel = new THREE.Mesh(this.barrelGeometry, this.barrelMaterial);
    barrel.position.z = -0.9;
    barrel.castShadow = true;
    group.add(mount, barrel);
    this.scene.add(group);
    // Support probe. A SINGLE point below the muzzle does not work: every fortress piece
    // is hollow in a different place -- a rampart has a carved walkway down its top, a
    // bastion is an empty shaft under its gun deck, the keep is a hollow tower. A fixed
    // offset lands in the void on some of them and retires the gun on frame one (it
    // retired 13 of 22, then 9 of 22, before this became a scan). So: walk DOWN from the
    // muzzle and call the gun supported if any cell in the column is still stone.
    const support = position.clone();
    this.turrets.push({
      group, structure, support, alive: true,
      cooldown: Math.random() * TURRET_COOLDOWN_S,
    });
  }

  get liveCount() {
    let n = 0;
    for (const t of this.turrets) if (t.alive) n++;
    return n;
  }

  /** Guns that have had a clear line to the player in the last few seconds (music tension). */
  get sightedCount() {
    let n = 0;
    for (const t of this.turrets) if (t.alive && t.sawT > 0) n++;
    return n;
  }

  /**
   * Does this gun still have masonry under it? Scans a short column below the muzzle;
   * the gun falls silent only when the whole column has been carved away.
   */
  _supported(turret) {
    const p = this._probe;
    for (let drop = 0.8; drop <= SUPPORT_DEPTH; drop += 0.5) {
      p.copy(turret.support);
      p.y -= drop;
      if (turret.structure.solidAtWorld(p)) return true;
    }
    return false;
  }

  /** Is there clear air from `from` to `to`? Terrain first: it is the cheaper test. */
  _hasLineOfSight(from, to, distance) {
    this._dir.copy(to).sub(from).normalize();
    const ground = this.terrain.raycast(from, this._dir, distance);
    if (ground && ground.distance < distance - 0.6) return false;
    for (const s of this.structures) {
      const hit = s.raycast(from, this._dir, distance);
      if (hit && hit.distance < distance - 0.6) return false;
    }
    return true;
  }

  update(dt, playerPosition, playerVelocity) {
    // Retire guns whose masonry is gone. Throttled: solidAtWorld is a matrix transform
    // plus a grid lookup per turret, and a dead gun does not become alive again.
    this._aliveClock -= dt;
    const checkAlive = this._aliveClock <= 0;
    if (checkAlive) this._aliveClock = ALIVE_CHECK_S;

    for (const t of this.turrets) {
      if (!t.alive) continue;
      if (checkAlive && t.structure && !this._supported(t)) {
        t.alive = false;
        t.group.visible = false;
        this.opts.fx?.destroyed?.(t.group.position);
        continue;
      }
      if (t.sawT > 0) t.sawT -= dt;
      const d = t.group.position.distanceTo(playerPosition);
      if (d > TURRET_RANGE) continue;

      // Lead the shot. Without it a strafing player is never hit and the fortress reads
      // as decorative; with it, standing still is what gets you killed.
      this._aim.copy(playerPosition);
      if (playerVelocity) this._aim.addScaledVector(playerVelocity, d / BULLET_SPEED);
      this._aim.y += 0.4;
      t.group.lookAt(this._aim);

      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      if (!this._hasLineOfSight(t.group.position, this._aim, d)) {
        t.cooldown = 0.35; // re-check soon rather than burning a full reload on a wall
        continue;
      }
      t.cooldown = TURRET_COOLDOWN_S * (0.75 + Math.random() * 0.5);
      t.sawT = 4;
      this._fire(t, this._aim);
    }

    this._updateBullets(dt, playerPosition);
  }

  _fire(turret, aim) {
    const mesh = new THREE.Mesh(this.bulletGeometry, this.bulletMaterial);
    mesh.position.copy(turret.group.position);
    const vel = this._dir.copy(aim).sub(mesh.position).normalize();
    // Cone spread, applied as two small perpendicular nudges.
    vel.x += (Math.random() - 0.5) * TURRET_SPREAD * 2;
    vel.y += (Math.random() - 0.5) * TURRET_SPREAD * 2;
    vel.z += (Math.random() - 0.5) * TURRET_SPREAD * 2;
    vel.normalize().multiplyScalar(BULLET_SPEED);
    mesh.lookAt(mesh.position.x + vel.x, mesh.position.y + vel.y, mesh.position.z + vel.z);
    this.scene.add(mesh);
    this.bullets.push({
      mesh, vel: vel.clone(), life: BULLET_LIFE_S,
      origin: turret.group.position, whizzed: false,
    });
    this.opts.fx?.fire?.(turret.group.position);
  }

  _updateBullets(dt, playerPosition) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      // Substep by travel distance: at 46 u/s a 60 Hz frame moves 0.77 units, which is
      // wider than the player capsule — a single-step test tunnels straight through.
      const steps = Math.max(1, Math.ceil((b.vel.length() * dt) / 0.35));
      let dead = b.life <= 0;
      for (let s = 0; s < steps && !dead; s++) {
        b.mesh.position.addScaledVector(b.vel, dt / steps);
        const p = b.mesh.position;
        const gap = p.distanceTo(playerPosition);
        if (gap < 1.15) {
          // The gun's position rides along so the HUD can point at what hit you.
          this.opts.onPlayerDamage?.(BULLET_DAMAGE, b.origin);
          this.opts.fx?.hit?.(p);
          dead = true;
          break;
        }
        // A near miss, once per bullet, on the step it starts moving away again.
        if (!b.whizzed && gap < 4.5
          && (playerPosition.x - p.x) * b.vel.x + (playerPosition.y - p.y) * b.vel.y
            + (playerPosition.z - p.z) * b.vel.z < 0) {
          b.whizzed = true;
          this.opts.fx?.whiz?.(p);
        }
        if (p.y <= this.terrain.heightAt(p.x, p.z)
          || this.structures.some(st => st.solidAtWorld(p))) {
          this.opts.fx?.hit?.(p);
          dead = true;
        }
      }
      if (dead) {
        this.scene.remove(b.mesh);
        this.bullets.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const t of this.turrets) this.scene.remove(t.group);
    for (const b of this.bullets) this.scene.remove(b.mesh);
    this.turrets.length = 0;
    this.bullets.length = 0;
    this.barrelGeometry.dispose();
    this.mountGeometry.dispose();
    this.barrelMaterial.dispose();
    this.bulletGeometry.dispose();
    this.bulletMaterial.dispose();
  }
}
