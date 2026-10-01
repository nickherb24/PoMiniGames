// combat.js — the one gun, two fire modes (PRD §F4):
//   primary (hold F / left mouse): hitscan carve shots — dig craters into the TERRAIN,
//     carve structures, split debris, damage enemies. Heat-limited with lockout.
//   alt     (G / right mouse):     a VISIBLE glowing ball that flies out, arcs slightly,
//     and detonates on whatever it touches — big carve, ground crater, radial impulse.
// Targets, nearest first: structure voxels (grid DDA), the terrain surface (ray march),
// debris pieces, enemies.

import * as THREE from 'three';

const PRIMARY_INTERVAL_S = 0.14;
const PRIMARY_CARVE_RADIUS = 1.8;   // world units, into structures
const PRIMARY_DIG_RADIUS = 2.3;     // world units, into the ground (≈ a 2-block crater)
const PRIMARY_ENEMY_DAMAGE = 20;
const HEAT_PER_SHOT = 0.055;
const HEAT_COOL_PER_S = 0.4;
const HEAT_REARM_BELOW = 0.35;      // locked out at 1.0 until cooled under this
const ALT_COOLDOWN_S = 3;
const ALT_PROJECTILE_SPEED = 42;
const ALT_PROJECTILE_GRAVITY = -7;  // slight arc so lobbing over hills works
const ALT_PROJECTILE_LIFE_S = 5;
const ALT_CARVE_RADIUS = 6;
const ALT_DIG_RADIUS = 4.5;
const ALT_BLAST_RADIUS = 12;
const ALT_BLAST_STRENGTH = 9;
const ALT_ENEMY_DAMAGE = 70;
// Impact stress: the half of a hit the carve radius does not express. The crater removes
// material; these write FATIGUE into a wider ring around it (see Structure.applyImpact),
// so the structural solver judges what stayed against reduced strength. Peak values are
// fraction-of-strength units: ~4 solid hits on one spot of a stone column start it
// visibly sagging; an alt blast half-breaks everything within its ring at once.
const PRIMARY_IMPACT_RADIUS = 2.6;
const PRIMARY_IMPACT_DAMAGE = 0.3;
const ALT_IMPACT_RADIUS = 6;
const ALT_IMPACT_DAMAGE = 0.55;
const MAX_RANGE = 160;
// Voxel shrapnel. Budgets are per shot, not per second: a primary carve removes on the
// order of 1500 cells at 0.25-unit voxels and an alt blast tens of thousands, so what is
// thrown is always a sample. Power is the metres/second at the blast centre.
const PRIMARY_SHRAPNEL_BUDGET = 24;
const PRIMARY_SHRAPNEL_POWER = 9;
const ALT_SHRAPNEL_BUDGET = 130;
const ALT_SHRAPNEL_POWER = 15;
const DIRT_CLOD_SIZE = 0.32;

// Terrain voxels are 0.2u — much smaller than structure voxels — so raw dig counts
// would swamp the score. Divide for parity with structure carving.
const TERRAIN_SCORE_DIVISOR = 8;

export class Weapon {
  constructor(scene, camera, structures, terrain, debris, enemies, onCarve, fx = null,
    shrapnel = null) {
    this.shrapnel = shrapnel;
    this.scene = scene;
    this.camera = camera;
    this.structures = structures;
    this.terrain = terrain;
    this.debris = debris;
    this.enemies = enemies;
    this.onCarve = onCarve; // (removedCount, clusterVoxelCount) → score accounting
    // { shot(muzzle), altLaunch(muzzle), detonate(point), impact(point, kind, normal, radius),
    //   carved(kind, structureIndex, point) } | null
    this.fx = fx;
    this._remote = false;   // true only while applyRemote is replaying a squadmate's carve

    this.primaryHeld = false;
    this.primaryClock = 0;
    this.altClock = 0;
    this.heat = 0;
    this.locked = false;
    // Demo autopilot aim: when set ({origin, direction}), shots use this ray instead of
    // the camera crosshair — the kiosk has no mouse to aim with.
    this.aimOverride = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = MAX_RANGE;

    this.tracers = []; // { line, life }
    // Additive + hot color so the bloom pass picks tracers up as light streaks.
    this.tracerMaterial = new THREE.LineBasicMaterial({
      color: 0xffd98c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.blastMaterial = new THREE.MeshBasicMaterial({
      color: 0xff9d45, transparent: true, opacity: 0.5, depthWrite: false,
    });
    this.blasts = [];      // { mesh, life }
    this.projectiles = []; // { mesh, vel, life }  — the alt-fire balls
    this.projectileGeometry = new THREE.SphereGeometry(0.38, 12, 10);
    this.projectileMaterial = new THREE.MeshBasicMaterial({ color: 0xffb066 });
  }

  setPrimaryHeld(held) { this.primaryHeld = held; }

  update(dt, muzzleWorld) {
    this.primaryClock -= dt;
    this.altClock -= dt;

    this.heat = Math.max(0, this.heat - HEAT_COOL_PER_S * dt);
    if (this.locked && this.heat <= HEAT_REARM_BELOW) this.locked = false;

    if (this.primaryHeld && !this.locked && this.primaryClock <= 0) {
      this.primaryClock = PRIMARY_INTERVAL_S;
      this.heat += HEAT_PER_SHOT;
      if (this.heat >= 1) { this.heat = 1; this.locked = true; }
      this._firePrimary(muzzleWorld);
    }

    this._updateProjectiles(dt);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.12);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.life -= dt;
      b.mesh.scale.setScalar(1 + (1 - b.life / 0.35) * 2.2);
      b.mesh.material.opacity = 0.5 * Math.max(0, b.life / 0.35);
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        this.blasts.splice(i, 1);
      }
    }
  }

  /** Alt fire: launch the ball along the aim line. Returns false while on cooldown. */
  fireAlt(muzzleWorld) {
    if (this.altClock > 0) return false;
    this.altClock = ALT_COOLDOWN_S;

    const dir = this.aimOverride
      ? this.aimOverride.direction.clone()
      : this.camera.getWorldDirection(new THREE.Vector3());
    const mesh = new THREE.Mesh(this.projectileGeometry, this.projectileMaterial);
    mesh.position.copy(muzzleWorld).addScaledVector(dir, 1.2);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh,
      vel: dir.multiplyScalar(ALT_PROJECTILE_SPEED),
      life: ALT_PROJECTILE_LIFE_S,
    });
    this.fx?.altLaunch(muzzleWorld);
    return true;
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.vel.y += ALT_PROJECTILE_GRAVITY * dt;

      // Sub-step the sweep so a fast ball cannot tunnel through a thin wall.
      const steps = Math.max(1, Math.ceil(p.vel.length() * dt / 0.8));
      let detonated = false;
      for (let s = 0; s < steps && !detonated; s++) {
        p.mesh.position.addScaledVector(p.vel, dt / steps);
        const pos = p.mesh.position;
        detonated =
          pos.y <= this.terrain.heightAt(pos.x, pos.z)
          || this.structures.some(st => st.solidAtWorld(pos))
          || this.enemies.enemies.some(e => e.mesh.position.distanceTo(pos) < e.def.radius + 0.6);
      }
      if (detonated || p.life <= 0) {
        this._detonate(p.mesh.position.clone());
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  /**
   * Online: replay a squadmate's carve here. `kind` 0 is a dig shot, 1 a blast;
   * `structureIndex` indexes this.structures (the same list on every client, because the
   * arena is built from the shared seed) or is -1 for the ground. It runs the very code a
   * local shot runs, minus two things: it scores nothing, and it is not relayed again.
   * @param from where the shot came from (the squadmate's avatar), for the tracer
   */
  applyRemote(kind, structureIndex, point, from = null) {
    this._remote = true;
    try {
      if (kind === 1) { this._detonate(point); return; }
      if (from) this._spawnTracer(from, point);
      const structure = structureIndex >= 0 ? this.structures[structureIndex] : null;
      if (structure) this._carveStructure(structure, point, null);
      else if (structureIndex < 0) this._digTerrain(point, null);
    } finally {
      this._remote = false;
    }
  }

  /** Score accounting for a carve — silent when the carve is a squadmate's. */
  _scored(removed, clusterVoxels) { if (!this._remote) this.onCarve?.(removed, clusterVoxels); }

  /** Tell the engine a carve landed, so an online run can relay it. Never for a replayed one. */
  _relay(kind, structure, point) {
    if (!this._remote) this.fx?.carved?.(kind, structure ? this.structures.indexOf(structure) : -1, point);
  }

  _detonate(point) {
    this._relay(1, null, point);
    // The blast's shrapnel budget is shared across every structure it touches, so a shot
    // into a corner where three walls meet does not spawn three full bursts.
    let budget = ALT_SHRAPNEL_BUDGET;
    for (const s of this.structures) {
      const { removed, clusters } = s.carveSphere(point, ALT_CARVE_RADIUS);
      let clusterVoxels = 0;
      for (const c of clusters) { clusterVoxels += c.voxels.length; this.debris.spawnCluster(s, c); }
      if (removed.length > 0) {
        this._scored(removed.length, clusterVoxels);
        s.applyImpact(point, ALT_IMPACT_RADIUS, ALT_IMPACT_DAMAGE);
      }
      if (removed.length > 0 && budget > 0) {
        const share = Math.min(budget, Math.ceil(ALT_SHRAPNEL_BUDGET / 2));
        this.shrapnel?.spawnFromCarve(s, removed, point, ALT_SHRAPNEL_POWER, share);
        budget -= share;
      }
    }
    const dug = this.terrain.dig(point, ALT_DIG_RADIUS);
    if (dug > 0) {
      this._scored(Math.max(1, Math.round(dug / TERRAIN_SCORE_DIVISOR)), 0);
      this._recheckUndermined(point, ALT_DIG_RADIUS);
      this.shrapnel?.spawnBurst(point, 34, DIRT_CLOD_SIZE,
        new THREE.Color(0x6d5138), ALT_SHRAPNEL_POWER * 0.8);
    }

    // Unfreeze BEFORE the blast so settled ruins take the impulse too — applyBlast
    // deliberately skips frozen bodies.
    this.debris.wakeNear(point, ALT_BLAST_RADIUS);
    this.debris.applyBlast(point, ALT_BLAST_RADIUS, ALT_BLAST_STRENGTH);
    this.enemies.applyBlast(point, ALT_BLAST_RADIUS, ALT_ENEMY_DAMAGE);
    this.debris.burstAt(point, new THREE.Color(0xffb066), 24, 0.5);
    this._spawnBlastShell(point);
    this.fx?.detonate(point);
  }

  _firePrimary(muzzleWorld) {
    this.fx?.shot(muzzleWorld);
    const hit = this._nearestHit();
    if (!hit) {
      const end = this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(MAX_RANGE)
        .add(this.camera.getWorldPosition(new THREE.Vector3()));
      this._spawnTracer(muzzleWorld, end);
      return;
    }
    this._spawnTracer(muzzleWorld, hit.point);

    if (hit.kind === 'structure') {
      this._carveStructure(hit.structure, hit.point, hit.normal);
    } else if (hit.kind === 'terrain') {
      this._digTerrain(hit.point, hit.normal);
    } else if (hit.kind === 'debris') {
      this.debris.fragment(hit.piece);
    } else {
      this.enemies.damage(hit.enemy, PRIMARY_ENEMY_DAMAGE, false);
    }
  }

  /** One dig shot into a structure. Shared by the local trigger and applyRemote. */
  _carveStructure(structure, point, normal) {
    this._relay(0, structure, point);
    const { removed, clusters } = structure.carveSphere(point, PRIMARY_CARVE_RADIUS);
    let clusterVoxels = 0;
    for (const c of clusters) { clusterVoxels += c.voxels.length; this.debris.spawnCluster(structure, c); }
    if (removed.length > 0) this._scored(removed.length, clusterVoxels);
    // Fatigue around the crater — repeated hits on one column progressively weaken it
    // even where the carve itself removed nothing new.
    structure.applyImpact(point, PRIMARY_IMPACT_RADIUS, PRIMARY_IMPACT_DAMAGE);
    // The stone this shot knocked loose, thrown as real bodies.
    this.shrapnel?.spawnFromCarve(structure, removed, point,
      PRIMARY_SHRAPNEL_POWER, PRIMARY_SHRAPNEL_BUDGET);
    this.debris.burstAt(point, new THREE.Color(0xd9d9df), 4, 0.35);
    this.debris.wakeNear(point, PRIMARY_CARVE_RADIUS + 3); // ledge shot from under a resting chunk
    this.fx?.impact(point, 'structure', normal, PRIMARY_CARVE_RADIUS);
  }

  /** One dig shot into the ground. Shared by the local trigger and applyRemote. */
  _digTerrain(point, normal) {
    this._relay(0, null, point);
    const dug = this.terrain.dig(point, PRIMARY_DIG_RADIUS);
    if (dug > 0) {
      this._scored(Math.max(1, Math.round(dug / TERRAIN_SCORE_DIVISOR)), 0);
      this._recheckUndermined(point, PRIMARY_DIG_RADIUS);
      // Terrain voxels are 0.1 units -- far too small to be worth a rigid body each, so
      // the ground throws clods at DIRT_CLOD_SIZE instead of true voxel size. It is the
      // one place the simulation is deliberately coarser than the grid.
      this.shrapnel?.spawnBurst(point, 10, DIRT_CLOD_SIZE,
        new THREE.Color(0x6d5138), PRIMARY_SHRAPNEL_POWER * 0.7);
    }
    this.debris.burstAt(point, new THREE.Color(0x6d5138), 5, 0.4); // dirt spray
    this.debris.wakeNear(point, PRIMARY_DIG_RADIUS + 3); // dug the floor from under debris
    this.fx?.impact(point, 'terrain', normal, PRIMARY_DIG_RADIUS);
  }

  /** Nearest of: structure voxel grids (DDA), the terrain surface, debris, enemies. */
  _nearestHit() {
    const origin = this.aimOverride
      ? this.aimOverride.origin.clone()
      : this.camera.getWorldPosition(new THREE.Vector3());
    const direction = this.aimOverride
      ? this.aimOverride.direction.clone()
      : this.camera.getWorldDirection(new THREE.Vector3());

    let best = null;
    for (const s of this.structures) {
      const hit = s.raycast(origin, direction, MAX_RANGE);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { kind: 'structure', structure: s, ...hit };
      }
    }
    const terrainHit = this.terrain.raycast(origin, direction, MAX_RANGE);
    if (terrainHit && (!best || terrainHit.distance < best.distance)) {
      best = { kind: 'terrain', ...terrainHit };
    }
    this.raycaster.set(origin, direction);
    const debrisHit = this.debris.raycast(this.raycaster);
    if (debrisHit && (!best || debrisHit.distance < best.distance)) {
      best = { kind: 'debris', ...debrisHit };
    }
    const enemyHit = this.enemies.raycast(this.raycaster);
    if (enemyHit && (!best || enemyHit.distance < best.distance)) {
      best = { kind: 'enemy', ...enemyHit };
    }
    return best;
  }

  /**
   * A terrain dig may have cut the ground from under a structure's base columns.
   * Re-solve support for any structure whose footprint the dig could reach; failing
   * clusters fall as debris (crush scoring flows through the normal onCarve path).
   */
  _recheckUndermined(point, radius) {
    for (const s of this.structures) {
      const dx = s.group.position.x - point.x;
      const dz = s.group.position.z - point.z;
      const reach = Math.max(s.dims[0], s.dims[2]) * s.scale * 0.75 + radius;
      if (dx * dx + dz * dz > reach * reach) continue;
      let clusterVoxels = 0;
      for (const c of s.recheckSupport()) {
        clusterVoxels += c.voxels.length;
        this.debris.spawnCluster(s, c);
      }
      if (clusterVoxels > 0) this._scored(0, clusterVoxels);
    }
  }

  _spawnTracer(from, to) {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geometry, this.tracerMaterial.clone());
    this.scene.add(line);
    this.tracers.push({ line, life: 0.12 });
  }

  _spawnBlastShell(point) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ALT_CARVE_RADIUS * 0.5, 16, 12), this.blastMaterial.clone());
    mesh.position.copy(point);
    this.scene.add(mesh);
    this.blasts.push({ mesh, life: 0.35 });
  }

  get altReadyIn() { return Math.max(0, this.altClock); }
  get altCooldownTotal() { return ALT_COOLDOWN_S; }

  dispose() {
    for (const t of this.tracers) { this.scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); }
    for (const b of this.blasts) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.tracers.length = 0;
    this.blasts.length = 0;
    this.projectiles.length = 0;
    this.tracerMaterial.dispose();
    this.blastMaterial.dispose();
    this.projectileGeometry.dispose();
    this.projectileMaterial.dispose();
  }
}
