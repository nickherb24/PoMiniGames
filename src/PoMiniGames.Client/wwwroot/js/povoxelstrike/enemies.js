// enemies.js — the three archetypes, spawn director, and threat perception.
//
//   Swarmer — fast, weak, melee; flows around solids (steering probes, no navmesh)
//   Brute   — slow, heavy melee; carves through a structure that blocks its path
//   Spitter — keeps its distance, fires a slow carving projectile at line of sight
//
// Navigation is deliberately steering-based: probe ahead at a few angles and take the
// first clear one. Destruction re-routes enemies for free because the probes read the
// live voxel grids. Threat perception: an enemy under fast-falling debris flees its
// ground shadow — killable by collapse (that is the game), but not for standing still.
//
// The escalation curve is continuous (endless survival): spawn interval
// shrinks and the archetype mix hardens with elapsed time; there are no wave breaks.
//
// Roaming enemies are off in the Siege by default. The fortress guns are the threat
// there, and chasing blocks would pull the player's attention away from the walls --
// the thing the whole game is about. The debris-crush kill path and the threat-perception
// code are load-bearing for the destruction sandbox, so the enemies stay behind
// `opts.enabled`: the start card's Survival mode turns the horde on, on top of the guns.
// Solo only — an online run is co-presence, and each client would be fighting its own
// private horde.

import * as THREE from 'three';
import { createActorMaterial } from './materials.js';

const ARCHETYPES = {
  swarmer: {
    hp: 40, speed: 7.5, radius: 0.55, height: 1.1, color: 0xd94f3d,
    meleeRange: 1.4, meleeDamage: 4, meleeInterval: 0.7, score: 25,
  },
  brute: {
    hp: 220, speed: 3.2, radius: 1.1, height: 2.6, color: 0x8a4fd9,
    meleeRange: 2.4, meleeDamage: 15, meleeInterval: 1.5, score: 75, // 25 base + 50 brute bonus
    carveRadius: 2.6, carveInterval: 2.2,
  },
  spitter: {
    hp: 60, speed: 4.5, radius: 0.7, height: 1.7, color: 0x3da58a,
    preferredRange: [22, 34], spitInterval: 3, spitDamage: 8, spitSpeed: 26, score: 25,
  },
};

const CRUSH_MIN_SPEED = 5;
const FLEE_PROBE_RADIUS = 10;

export class EnemyManager {
  /**
   * @param opts { enabled, demo, onPlayerDamage(amount), onKill(type, byCrush),
   *               onCarve(removed, clusterVoxels),
   *               fx?: { spit(pos), enemyDeath(type, pos) } }
   */
  constructor(scene, structures, debris, terrain, opts) {
    this.scene = scene;
    this.structures = structures;
    this.debris = debris;
    this.terrain = terrain;
    this.opts = opts;
    this.enemies = [];   // { type, def, mesh, hp, attackClock, carveClock, spitClock, flash }
    this.projectiles = []; // { mesh, vel, life }
    this.spawnClock = 3;   // grace period before the first spawn
    this.geometries = {
      swarmer: new THREE.BoxGeometry(1.1, 1.1, 1.1),
      brute: new THREE.BoxGeometry(2.2, 2.6, 2.2),
      spitter: new THREE.ConeGeometry(0.7, 1.7, 6),
    };
    this.projectileGeometry = new THREE.SphereGeometry(0.28, 8, 6);
    this.projectileMaterial = new THREE.MeshBasicMaterial({ color: 0x7dffb0 });
  }

  // ── Spawn director (continuous escalation) ─────────────────────────────

  updateSpawning(dt, elapsed, playerPos, cameraForward) {
    if (!this.opts.enabled) return;
    this.spawnClock -= dt;
    if (this.spawnClock > 0) return;
    const maxAlive = Math.min(40, 6 + elapsed / 15);
    if (this.enemies.length >= maxAlive) { this.spawnClock = 0.5; return; }
    this.spawnClock = Math.max(1.1, 5 - elapsed / 45);

    // Mix hardens over time: spitters join at 20 s, brutes at 45 s.
    const roll = Math.random();
    let type = 'swarmer';
    if (elapsed > 45 && roll < 0.18) type = 'brute';
    else if (elapsed > 20 && roll < 0.42) type = 'spitter';
    this.spawn(type, playerPos, cameraForward);
  }

  spawn(type, playerPos, cameraForward) {
    const def = ARCHETYPES[type];
    // Map-edge ring, preferring points outside the view frustum: behind the
    // camera, or far enough ahead that a pop-in is below noticing.
    let pos = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * 82, z = Math.sin(a) * 82;
      const candidate = new THREE.Vector3(x, this.terrain.heightAt(x, z) + def.height / 2, z);
      const toC = candidate.clone().sub(playerPos).normalize();
      if (!cameraForward || toC.dot(cameraForward) < 0.25 || candidate.distanceTo(playerPos) > 60) {
        pos = candidate;
        break;
      }
    }
    if (!pos) pos = new THREE.Vector3(82, this.terrain.heightAt(82, 0) + def.height / 2, 0);

    const mesh = new THREE.Mesh(this.geometries[type], createActorMaterial({ color: def.color }));
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.enemies.push({
      type, def, mesh, hp: def.hp,
      attackClock: 0, carveClock: 0, spitClock: 1 + Math.random() * 2, flash: 0, bob: 0,
    });
  }

  // ── Frame update ───────────────────────────────────────────────────────

  update(dt, playerPos) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.attackClock -= dt; e.carveClock -= dt; e.spitClock -= dt;
      if (e.flash > 0) { e.flash -= dt; if (e.flash <= 0) e.mesh.material.color.setHex(e.def.color); }

      const toPlayer = playerPos.clone().sub(e.mesh.position); toPlayer.y = 0;
      const dist = toPlayer.length();

      const flee = this._fleeVector(e);
      if (flee) {
        this._steerMove(e, flee, dt, 1.25); // evacuation overrides everything
      } else if (e.type === 'spitter') {
        this._updateSpitter(e, playerPos, toPlayer, dist, dt);
      } else {
        this._updateMelee(e, playerPos, toPlayer, dist, dt);
      }
      // Follow the block terrain (same auto-step settle as the player), plus the
      // decaying melee lunge bob on top.
      if (e.bob > 0) e.bob = Math.max(0, e.bob - dt * 1.5);
      const groundY = this.terrain.heightAt(e.mesh.position.x, e.mesh.position.z) + e.def.height / 2;
      e.mesh.position.y += (groundY + e.bob - e.mesh.position.y) * Math.min(1, 10 * dt);
      e.mesh.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
    }
    this._updateProjectiles(dt, playerPos);
  }

  _updateMelee(e, playerPos, toPlayer, dist, dt) {
    if (dist <= e.def.meleeRange) {
      if (e.attackClock <= 0) {
        e.attackClock = e.def.meleeInterval;
        this.opts.onPlayerDamage(e.def.meleeDamage);
        e.bob = 0.3; // lunge bob, decayed in update()
      }
      return;
    }
    const dir = toPlayer.normalize();
    const moved = this._steerMove(e, dir, dt, 1);
    // A brute that cannot route around what blocks it goes THROUGH it.
    if (!moved && e.type === 'brute' && e.carveClock <= 0) {
      e.carveClock = e.def.carveInterval;
      const probe = e.mesh.position.clone().addScaledVector(dir, e.def.radius + 1.2);
      probe.y = this.terrain.heightAt(probe.x, probe.z) + 1.2;
      const s = this.structures.find(st => st.solidAtWorld(probe));
      if (s) this._carve(s, probe, e.def.carveRadius);
    }
  }

  _updateSpitter(e, playerPos, toPlayer, dist, dt) {
    const [near, far] = e.def.preferredRange;
    const dir = toPlayer.clone().normalize();
    if (dist < near) this._steerMove(e, dir.clone().negate(), dt, 1);
    else if (dist > far) this._steerMove(e, dir, dt, 1);
    else {
      // Hold the band; strafe when the shot is blocked to reacquire line of sight.
      if (!this._hasLineOfSight(e, playerPos)) {
        const strafe = new THREE.Vector3(-dir.z, 0, dir.x);
        this._steerMove(e, strafe, dt, 0.8);
      } else if (e.spitClock <= 0) {
        e.spitClock = e.def.spitInterval;
        this._spit(e, playerPos);
      }
    }
  }

  _hasLineOfSight(e, playerPos) {
    const from = e.mesh.position.clone(); from.y += e.def.height * 0.3;
    const to = playerPos.clone(); to.y += 0.3;
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    for (const s of this.structures) {
      const hit = s.raycast(from, dir, dist);
      if (hit) return false;
    }
    return true;
  }

  _spit(e, playerPos) {
    const from = e.mesh.position.clone(); from.y += e.def.height * 0.3;
    const target = playerPos.clone(); target.y += 0.2;
    const vel = target.sub(from).normalize().multiplyScalar(e.def.spitSpeed);
    const mesh = new THREE.Mesh(this.projectileGeometry, this.projectileMaterial);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.projectiles.push({ mesh, vel, life: 4, damage: e.def.spitDamage });
    this.opts.fx?.spit(from);
  }

  _updateProjectiles(dt, playerPos) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      let dead = p.life <= 0
        || p.mesh.position.y < this.terrain.heightAt(p.mesh.position.x, p.mesh.position.z);

      if (!dead && p.mesh.position.distanceTo(playerPos) < 1.1) {
        this.opts.onPlayerDamage(p.damage);
        dead = true;
      }
      if (!dead) {
        const s = this.structures.find(st => st.solidAtWorld(p.mesh.position));
        if (s) { this._carve(s, p.mesh.position, 0.9); dead = true; } // spit carves a nick (PRD §F6)
      }
      if (dead) { this.scene.remove(p.mesh); this.projectiles.splice(i, 1); }
    }
  }

  /**
   * Steering: try the desired direction, then ±35°/±70°/±105° alternates; take the
   * first whose probe point is clear of structure voxels. Returns false when fully
   * boxed in (the brute's cue to start carving).
   */
  _steerMove(e, desired, dt, speedFactor) {
    const speed = e.def.speed * speedFactor;
    for (const angle of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
      const dir = desired.clone().applyAxisAngle(UP, angle);
      const probe = e.mesh.position.clone().addScaledVector(dir, e.def.radius + 0.9);
      probe.y = this.terrain.heightAt(probe.x, probe.z) + Math.max(0.6, e.def.height * 0.4);
      if (this.structures.some(s => s.solidAtWorld(probe))) continue;
      e.mesh.position.addScaledVector(dir, speed * dt);
      e.mesh.position.x = THREE.MathUtils.clamp(e.mesh.position.x, -88, 88);
      e.mesh.position.z = THREE.MathUtils.clamp(e.mesh.position.z, -88, 88);
      return true;
    }
    return false;
  }

  /** Threat perception: flee the ground shadow of fast-falling debris overhead. */
  _fleeVector(e) {
    for (const piece of this.debris.pieces) {
      if (piece.frozen || piece.body.velocity.y > -3) continue;
      const dx = piece.body.position.x - e.mesh.position.x;
      const dz = piece.body.position.z - e.mesh.position.z;
      // Only debris still ABOVE this enemy is a falling threat — settled ground pieces aren't.
      if (piece.body.position.y < e.mesh.position.y + e.def.height
        || dx * dx + dz * dz > FLEE_PROBE_RADIUS ** 2) continue;
      const away = new THREE.Vector3(-dx, 0, -dz);
      return away.lengthSq() < 0.01 ? new THREE.Vector3(1, 0, 0) : away.normalize();
    }
    return null;
  }

  _carve(structure, point, radius) {
    const { removed, clusters } = structure.carveSphere(point, radius);
    let clusterVoxels = 0;
    for (const c of clusters) { clusterVoxels += c.voxels.length; this.debris.spawnCluster(structure, c); }
    if (removed.length > 0) {
      this.opts.onCarve?.(removed.length, clusterVoxels);
      // A brute pounding a wall fatigues it like any other impact, just smaller:
      // the collapse should track the beating, not only the bite marks.
      structure.applyImpact(point, radius * 1.2, 0.22);
    }
    this.debris.wakeNear(point, radius + 3); // a brute tunnels out someone's floor too
  }

  // ── Damage in ──────────────────────────────────────────────────────────

  damage(enemy, amount, byCrush) {
    if (!this.enemies.includes(enemy)) return;
    enemy.hp -= amount;
    enemy.flash = 0.12;
    enemy.mesh.material.color.setHex(0xffffff);
    if (enemy.hp <= 0) this._kill(enemy, byCrush);
  }

  applyBlast(center, radius, maxDamage) {
    for (const e of [...this.enemies]) {
      const dist = e.mesh.position.distanceTo(center);
      if (dist < radius) this.damage(e, maxDamage * (1 - dist / radius), false);
    }
  }

  /** Debris crush check (debris is impartial — this is the enemy half). */
  checkCrush(pieces) {
    for (const piece of pieces) {
      if (piece.frozen) continue;
      const speed = piece.body.velocity.length();
      if (speed < CRUSH_MIN_SPEED) continue;
      const reach = Math.max(piece.dims[0], piece.dims[1], piece.dims[2]) * piece.scale * 0.5;
      for (const e of [...this.enemies]) {
        const d = e.mesh.position.distanceTo(piece.body.position);
        if (d < reach + e.def.radius) {
          this.damage(e, Math.min(200, piece.body.mass * speed * 0.08), true);
        }
      }
    }
  }

  _kill(enemy, byCrush) {
    const i = this.enemies.indexOf(enemy);
    if (i >= 0) this.enemies.splice(i, 1);
    // Dissolve: the enemy bursts into voxel particles in its own color — brutes into
    // more, bigger chunks.
    const big = enemy.type === 'brute';
    this.debris.burstAt(enemy.mesh.position.clone(), new THREE.Color(enemy.def.color),
      big ? 34 : 20, big ? 0.5 : 0.32);
    this.opts.fx?.enemyDeath(enemy.type, enemy.mesh.position);
    this.scene.remove(enemy.mesh);
    enemy.mesh.material.dispose();
    this.opts.onKill(enemy.type, byCrush);
  }

  raycast(raycaster) {
    const meshes = this.enemies.map(e => e.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const enemy = this.enemies.find(e => e.mesh === hits[0].object);
    return enemy ? { enemy, distance: hits[0].distance, point: hits[0].point } : null;
  }

  get count() { return this.enemies.length; }

  dispose() {
    for (const e of this.enemies) { this.scene.remove(e.mesh); e.mesh.material.dispose(); }
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.enemies.length = 0;
    this.projectiles.length = 0;
    for (const g of Object.values(this.geometries)) g.dispose();
    this.projectileGeometry.dispose();
    this.projectileMaterial.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
