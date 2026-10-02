// debris.js — dynamic voxel clusters and their attrition chain:
//   detached cluster → rigidbody → (hit / hard impact) hierarchical split →
//   below the floor → particle burst → fade → gone.
//
// Hard caps, enforced deterministically: MAX_BODIES active rigidbodies —
// beyond it the frozen/oldest/smallest are demoted to particles — and MAX_PARTICLES in
// a fixed InstancedMesh ring buffer (overwriting the oldest slot, so overflow can never
// allocate). Clusters at rest freeze to static after REST_FREEZE_S so a settled ruin
// stops costing simulation.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createVoxelMaterial } from './materials.js';
import { greedyBoxes } from './voxelboxes.js';
import { materialFor, massOf, surfaceOf, MATERIAL_PRESETS } from './physics.js';

// Dynamic rigid bodies are the dominant physics cost (see quality.js). 150 debris pieces
// plus a shrapnel field put ~300 dynamic bodies in the world and the step measured 81 ms;
// this is the debris half of bringing that back under control.
export const MAX_BODIES = 90;
const MAX_PARTICLES = 2000;
const FRAG_FLOOR = 14;        // voxels; smaller clusters burst straight to particles
const FRAG_IMPACT_SPEED = 8;  // m/s relative velocity that fragments on impact
// Hierarchical attrition: a piece survives at most this many impact
// generations, then a hard impact bursts it to particles. Without the ceiling, every
// landing re-split every half and the cascade pinned the body cap forever.
const MAX_FRAG_DEPTH = 3;
const FRAG_MIN_AGE_S = 0.4;   // newborn halves overlap for a frame — don't re-split on it
const REST_FREEZE_S = 8;
const PARTICLE_LIFE_S = 1.3;
const GRAVITY = -9.81;
// Compound-collider budget per falling piece. A cluster is usually a handful of boxes
// after greedy merging; the cap is there so one enormous collapse cannot put a thousand
// shapes on a single body.
// Compound shapes per falling piece. 24 was tried first and cost more than it bought:
// an L-shaped cornice reads as an L with six boxes just as well as with twenty-four.
const PIECE_BOX_BUDGET = 6;
// What survives a wall. Not zero: a blast big enough to breach masonry still shakes what
// is behind it, and a hard zero makes rubble in the lee of a wall look frozen.
const BLAST_SHIELDING = 0.18;

export class DebrisManager {
  constructor(scene, physicsWorld, fx = null, physicsMaterials = null) {
    this.scene = scene;
    this.world = physicsWorld;
    this.physicsMaterials = physicsMaterials;
    this.structures = null; // set by the engine; used for blast line-of-sight
    this.fx = fx;           // { collapse(voxels, pos), impact(mass, pos, speed) } | null
    this.pieces = [];       // { mesh, body, voxels:count, color, scale, age, restTime, frozen, fragCooldown }
    this._pendingFragments = [];

    // Particle pool: one InstancedMesh of unit cubes, slots reused oldest-first.
    this.particleMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      createVoxelMaterial({ vertexColors: false }),
      MAX_PARTICLES);
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.count = MAX_PARTICLES;
    this.particleMesh.frustumCulled = false;
    scene.add(this.particleMesh);
    this.particles = new Array(MAX_PARTICLES).fill(null); // { pos, vel, size, life } | null
    this.particleCursor = 0;
    this._zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_PARTICLES; i++) this.particleMesh.setMatrixAt(i, this._zeroMatrix);
    this.activeParticles = 0;
  }

  // ── Spawning ───────────────────────────────────────────────────────────

  /**
   * Turn one detached cluster (list of {x,y,z,value} in a structure's grid) into a
   * rigidbody, or straight into particles when it is below the fragmentation floor.
   */
  spawnCluster(structure, cluster, impulse = null) {
    if (cluster.voxels.length < FRAG_FLOOR) {
      this._burstFromCluster(structure, cluster);
      return;
    }

    // Local AABB of the cluster in its source grid.
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const v of cluster.voxels) {
      minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); minZ = Math.min(minZ, v.z);
      maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); maxZ = Math.max(maxZ, v.z);
    }
    const nx = maxX - minX + 1, ny = maxY - minY + 1, nz = maxZ - minZ + 1;
    const cells = new Uint8Array(nx * ny * nz);
    for (const v of cluster.voxels) cells[(v.x - minX) + (v.y - minY) * nx + (v.z - minZ) * nx * ny] = v.value;

    const centerWorld = structure.voxelWorldCenter(
      (minX + maxX) / 2, (minY + maxY) / 2 - 0.5, (minZ + maxZ) / 2);

    // A real chunk let go: rumble + a dust bloom in the structure's own colors.
    this.fx?.collapse(cluster.voxels.length, centerWorld);
    this.dustAt(centerWorld,
      this._paletteColor(structure.palette, cluster.voxels[0].value),
      Math.min(14, 4 + (cluster.voxels.length >> 5)), structure.scale);

    const material = materialFor(structure.volume, cluster.voxels[0].value);
    this._spawnPiece({
      cells, dims: [nx, ny, nz], palette: structure.palette,
      scale: structure.scale, rotationY: structure.group.rotation.y,
      position: centerWorld, velocity: new THREE.Vector3(), impulse,
      voxels: cluster.voxels.length, fragDepth: 0, material,
    });
  }

  _spawnPiece({ cells, dims, palette, scale, rotationY, position, velocity, impulse, voxels,
    fragDepth, material }) {
    const mat = material ?? MATERIAL_PRESETS.stone;
    this._enforceBodyCap();

    const geometry = buildCenteredGeometry(cells, dims, palette);
    const mesh = new THREE.Mesh(geometry, createVoxelMaterial());
    mesh.scale.setScalar(scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // Real mass. The old formula divided rho*V by 100 and then capped the result at
    // 500 kg, so a collapsing tower section weighed about as much as a bag of sand and
    // bounced accordingly. A cubic metre of stone is 2400 kg and it is allowed to be.
    const mass = massOf(voxels, scale, mat.density ?? 2400);
    const body = new CANNON.Body({
      mass,
      position: new CANNON.Vec3(position.x, position.y, position.z),
      velocity: new CANNON.Vec3(velocity.x, velocity.y, velocity.z),
      angularDamping: 0.35,
      linearDamping: 0.05,
      material: this.physicsMaterials ? this.physicsMaterials[surfaceOf(mat)] : undefined,
    });
    // Shape: the piece's own voxels, greedy-merged, offset to the mesh's centre. The
    // single AABB box this replaces meant an L-shaped cornice tumbled and stacked like a
    // rectangular brick, and a hollow arch collided as if it were filled in.
    const { boxes, count } = greedyBoxes(cells, dims, PIECE_BOX_BUDGET);
    const ox = dims[0] / 2, oy = dims[1] / 2, oz = dims[2] / 2;
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(
          Math.max(1e-3, boxes[o + 3] * scale),
          Math.max(1e-3, boxes[o + 4] * scale),
          Math.max(1e-3, boxes[o + 5] * scale))),
        new CANNON.Vec3(
          (boxes[o] - ox) * scale, (boxes[o + 1] - oy) * scale, (boxes[o + 2] - oz) * scale));
    }
    body.updateMassProperties();
    body.quaternion.setFromEuler(0, rotationY, 0);
    if (impulse) body.applyImpulse(new CANNON.Vec3(impulse.x * mass, impulse.y * mass, impulse.z * mass));
    this.world.addBody(body);

    const piece = {
      mesh, body, cells, dims, palette, scale, voxels, material: mat,
      age: 0, restTime: 0, frozen: false, fragCooldown: 0, fragDepth: fragDepth ?? 0,
    };
    // Impacts fragment: queue rather than mutate inside cannon's
    // collide callback — the physics step must not see bodies vanish mid-solve.
    body.addEventListener('collide', (e) => {
      const rel = Math.abs(e.contact.getImpactVelocityAlongNormal());
      // Landing thud + dust kick — the audio side throttles itself, so calling from
      // every contact is safe.
      if (rel > 4 && piece.age > 0.15) {
        this.fx?.impact(piece.body.mass, piece.body.position, rel);
        if (rel > 6.5) {
          this.dustAt(new THREE.Vector3(
            piece.body.position.x, piece.body.position.y, piece.body.position.z),
            this._averageColor(piece), 4, piece.scale);
        }
      }
      if (piece.frozen || piece.fragCooldown > 0 || piece.age < FRAG_MIN_AGE_S) return;
      if (rel <= FRAG_IMPACT_SPEED) return;
      piece.fragCooldown = 0.5;
      this._pendingFragments.push(piece);
    });
    this.pieces.push(piece);
  }

  // ── Fragmentation ──────────────────────────────────────────────────────

  /** Split a piece in two along its longest axis; small halves burst to particles. */
  fragment(piece) {
    const idx = this.pieces.indexOf(piece);
    if (idx < 0) return;
    this._removePiece(idx);

    // End of the hierarchy: past the depth ceiling or too small to halve, the piece
    // scales down to transient particles.
    if (piece.voxels < FRAG_FLOOR * 2 || piece.fragDepth >= MAX_FRAG_DEPTH) {
      this._burstFromPiece(piece);
      return;
    }

    const [nx, ny, nz] = piece.dims;
    const axis = nx >= ny && nx >= nz ? 0 : (ny >= nz ? 1 : 2);
    const extent = piece.dims[axis];
    const cut = Math.max(1, Math.min(extent - 1, Math.floor(extent * (0.35 + Math.random() * 0.3))));

    for (const side of [0, 1]) {
      const from = side === 0 ? 0 : cut;
      const to = side === 0 ? cut : extent;
      const sub = extractRange(piece.cells, piece.dims, axis, from, to);
      if (sub.voxels === 0) continue;

      // Sub-piece world position: offset from the parent's center along the cut axis,
      // rotated by the parent's current orientation.
      const localOffset = new THREE.Vector3();
      localOffset.setComponent(axis, ((from + to) / 2 - extent / 2) * piece.scale);
      const q = new THREE.Quaternion(
        piece.body.quaternion.x, piece.body.quaternion.y, piece.body.quaternion.z, piece.body.quaternion.w);
      localOffset.applyQuaternion(q);
      const pos = new THREE.Vector3(
        piece.body.position.x, piece.body.position.y, piece.body.position.z).add(localOffset);

      if (sub.voxels < FRAG_FLOOR) {
        this._burst(pos, this._averageColor(piece), Math.min(sub.voxels, 10), piece.scale,
          new THREE.Vector3(piece.body.velocity.x, piece.body.velocity.y, piece.body.velocity.z));
        continue;
      }
      const spread = localOffset.clone().normalize().multiplyScalar(1.5);
      this._spawnPiece({
        cells: sub.cells, dims: sub.dims, palette: piece.palette, scale: piece.scale,
        rotationY: 0, position: pos,
        velocity: new THREE.Vector3(
          piece.body.velocity.x + spread.x, piece.body.velocity.y + 1, piece.body.velocity.z + spread.z),
        impulse: null, voxels: sub.voxels, fragDepth: piece.fragDepth + 1,
        material: piece.material,
      });
      // Keep the parent's orientation on the halves.
      const spawned = this.pieces[this.pieces.length - 1];
      spawned.body.quaternion.copy(piece.body.quaternion);
    }
  }

  /** Primary-fire hit test against debris meshes. Returns the hit piece + distance or null. */
  raycast(raycaster) {
    const meshes = this.pieces.map(p => p.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const piece = this.pieces.find(p => p.mesh === hits[0].object);
    return piece ? { piece, distance: hits[0].distance, point: hits[0].point } : null;
  }

  /**
   * Support was removed near `position` (terrain dug, structure carved, or a piece
   * dissolved): wake every frozen/sleeping piece in radius so it falls again instead
   * of hanging in the air. Frozen pieces go back to dynamic — freezing is a budget
   * optimization, not a promise of permanence.
   */
  wakeNear(position, radius) {
    const r2 = radius * radius;
    for (const piece of this.pieces) {
      const dx = piece.body.position.x - position.x;
      const dy = piece.body.position.y - position.y;
      const dz = piece.body.position.z - position.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (piece.frozen) {
        piece.frozen = false;
        piece.restTime = 0;
        piece.body.type = CANNON.Body.DYNAMIC;
        piece.body.updateMassProperties();
      }
      piece.body.wakeUp();
    }
  }

  /** Radial blast: impulse on every piece within radius (alt-fire). */
  /**
   * Radial impulse from a detonation.
   *
   * Two things are physical here that were not before. Falloff is 1/r² over the
   * unobstructed part of the blast rather than linear, because that is how the energy of
   * an expanding shell actually thins out. And the line from the charge to each piece is
   * TRACED: masonry in the way absorbs the front, so a wall now shields whatever is
   * behind it instead of the explosion reaching through it as if it were not there.
   */
  applyBlast(center, radius, strength) {
    const dir = new THREE.Vector3();
    const from = new THREE.Vector3(center.x, center.y, center.z);
    for (const piece of this.pieces) {
      if (piece.frozen) continue;
      const d = new THREE.Vector3(
        piece.body.position.x - center.x, piece.body.position.y - center.y, piece.body.position.z - center.z);
      const dist = d.length();
      if (dist > radius) continue;
      // Inverse-square, normalised so a contact blast is 1 and the shell edge is ~0.
      const falloff = Math.max(0, (1 / (1 + (dist / radius) * 3) ** 2 - 0.0625) / 0.9375);
      let shield = 1;
      if (this.structures && dist > 0.5) {
        dir.copy(d).divideScalar(dist);
        for (const st of this.structures) {
          const hit = st.raycast(from, dir, dist);
          if (hit && hit.distance < dist - 0.4) { shield = BLAST_SHIELDING; break; }
        }
      }
      const j = strength * falloff * shield * piece.body.mass;
      d.normalize().multiplyScalar(j);
      d.y += j * 0.4; // lift so blasts read as blasts
      piece.body.wakeUp();
      piece.body.applyImpulse(new CANNON.Vec3(d.x, d.y, d.z));
    }
  }

  // ── Frame update ───────────────────────────────────────────────────────

  update(dt) {
    for (const piece of this._pendingFragments.splice(0)) this.fragment(piece);

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i];
      piece.age += dt;
      if (piece.fragCooldown > 0) piece.fragCooldown -= dt;

      piece.mesh.position.copy(piece.body.position);
      piece.mesh.quaternion.copy(piece.body.quaternion);

      // Fell through the world (tunnelled) — reclaim it silently.
      if (piece.body.position.y < -20) { this._removePiece(i, true); continue; }

      if (!piece.frozen) {
        const speed = piece.body.velocity.length() + piece.body.angularVelocity.length();
        piece.restTime = speed < 0.4 ? piece.restTime + dt : 0;
        if (piece.restTime > REST_FREEZE_S) {
          // Settled ruin → static scenery: stops costing the solver, still shootable.
          piece.frozen = true;
          piece.body.type = CANNON.Body.STATIC;
          piece.body.velocity.setZero();
          piece.body.angularVelocity.setZero();
          piece.body.updateMassProperties();
        }
      }
    }

    this._updateParticles(dt);
  }

  _enforceBodyCap() {
    while (this.pieces.length >= MAX_BODIES) {
      // Demotion order (deterministic): frozen first, then oldest+smallest.
      let victim = 0, best = -Infinity;
      for (let i = 0; i < this.pieces.length; i++) {
        const p = this.pieces[i];
        const score = (p.frozen ? 1e6 : 0) + p.age * 10 - p.voxels;
        if (score > best) { best = score; victim = i; }
      }
      const piece = this.pieces[victim];
      this._removePiece(victim);
      this._burstFromPiece(piece, 6);
    }
  }

  _removePiece(index, silent = false) {
    const piece = this.pieces[index];
    this.pieces.splice(index, 1);
    this.world.removeBody(piece.body);
    this.scene.remove(piece.mesh);
    piece.mesh.geometry.dispose();
    piece.mesh.material.dispose();
    if (silent) piece.cells = null;
    // Anything stacked on the removed piece just lost its floor — wake it, or a
    // frozen chunk above stays nailed to the air.
    const reach = Math.max(piece.dims[0], piece.dims[1], piece.dims[2]) * piece.scale;
    this.wakeNear(new THREE.Vector3(
      piece.body.position.x, piece.body.position.y, piece.body.position.z), reach + 2);
  }

  // ── Particles ──────────────────────────────────────────────────────────

  _burstFromCluster(structure, cluster) {
    const first = cluster.voxels[0];
    const pos = structure.voxelWorldCenter(first.x, first.y, first.z);
    this._burst(pos, this._paletteColor(structure.palette, first.value),
      Math.min(cluster.voxels.length, 12), structure.scale, new THREE.Vector3());
  }

  _burstFromPiece(piece, cap = 12) {
    const pos = new THREE.Vector3(piece.body.position.x, piece.body.position.y, piece.body.position.z);
    const vel = new THREE.Vector3(piece.body.velocity.x, piece.body.velocity.y, piece.body.velocity.z);
    this._burst(pos, this._averageColor(piece), Math.min(piece.voxels, cap), piece.scale, vel);
  }

  burstAt(position, color, count, size) {
    this._burst(position, color, count, size, new THREE.Vector3());
  }

  /**
   * Slow-rising dust/smoke: same instanced pool as debris sparks, but buoyant and
   * long-lived, tinted a washed-out version of the source color so it reads as dust
   * rather than confetti.
   */
  dustAt(position, color, count, size) {
    const dusty = color.clone().lerp(new THREE.Color(0.62, 0.6, 0.58), 0.55);
    for (let n = 0; n < count; n++) {
      const i = this.particleCursor;
      this.particleCursor = (this.particleCursor + 1) % MAX_PARTICLES;
      if (this.particles[i] === null) this.activeParticles++;
      const life = 1.6 + Math.random() * 1.2;
      this.particles[i] = {
        pos: position.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 2.2, Math.random() * 1.4, (Math.random() - 0.5) * 2.2)),
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 2.2, 0.6 + Math.random() * 1.6, (Math.random() - 0.5) * 2.2),
        size: size * (0.7 + Math.random() * 0.9),
        life,
        maxLife: life,
        smoke: true,
      };
      this.particleMesh.setColorAt(i, dusty);
    }
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }

  _burst(position, color, count, size, baseVelocity) {
    for (let n = 0; n < count; n++) {
      const i = this.particleCursor;
      this.particleCursor = (this.particleCursor + 1) % MAX_PARTICLES;
      if (this.particles[i] === null) this.activeParticles++;
      this.particles[i] = {
        pos: position.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 1.5, Math.random() * 1.2, (Math.random() - 0.5) * 1.5)),
        vel: baseVelocity.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 7, Math.random() * 6, (Math.random() - 0.5) * 7)),
        size: size * (0.5 + Math.random() * 0.6),
        life: PARTICLE_LIFE_S,
        maxLife: PARTICLE_LIFE_S,
        smoke: false,
      };
      this.particleMesh.setColorAt(i, color);
    }
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }

  _updateParticles(dt) {
    const m = new THREE.Matrix4();
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p === null) continue;
      any = true;
      p.life -= dt;
      if (p.life <= 0 || p.pos.y < 0) {
        this.particles[i] = null;
        this.activeParticles--;
        this.particleMesh.setMatrixAt(i, this._zeroMatrix);
        continue;
      }
      let s;
      if (p.smoke) {
        // Buoyant + heavy drag: dust billows in place instead of raining.
        p.vel.multiplyScalar(Math.max(0, 1 - 1.1 * dt));
        p.vel.y += 0.5 * dt;
        p.pos.addScaledVector(p.vel, dt);
        const t = 1 - p.life / p.maxLife;
        s = p.size * (0.8 + t * 1.3) * Math.min(1, p.life / 0.5); // grow, then thin out
      } else {
        p.vel.y += GRAVITY * dt * 0.6;
        p.pos.addScaledVector(p.vel, dt);
        s = p.size * Math.min(1, p.life / (p.maxLife * 0.5)); // shrink out
      }
      m.makeScale(s, s, s).setPosition(p.pos);
      this.particleMesh.setMatrixAt(i, m);
    }
    if (any) this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  _paletteColor(palette, value) {
    const p = (value - 1) * 4;
    return new THREE.Color(palette[p] / 255, palette[p + 1] / 255, palette[p + 2] / 255);
  }

  _averageColor(piece) {
    // First solid voxel's palette color is a good-enough tint for burst dust.
    for (let i = 0; i < piece.cells.length; i++) {
      if (piece.cells[i] !== 0) return this._paletteColor(piece.palette, piece.cells[i]);
    }
    return new THREE.Color(0.6, 0.6, 0.62);
  }

  get bodyCount() { return this.pieces.length; }
  get particleCount() { return this.activeParticles; }

  dispose() {
    while (this.pieces.length > 0) this._removePiece(0, true);
    this.scene.remove(this.particleMesh);
    this.particleMesh.geometry.dispose();
    this.particleMesh.material.dispose();
  }
}

// ── Shared cluster helpers ───────────────────────────────────────────────

/** Culled-face geometry CENTERED on the cluster AABB (matches its cannon box). */
function buildCenteredGeometry(cells, dims, palette) {
  const [nx, ny, nz] = dims;
  const at = (x, y, z) =>
    (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) ? 0 : cells[x + y * nx + z * nx * ny];
  const FACES = [
    { d: [1, 0, 0], n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { d: [-1, 0, 0], n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { d: [0, 1, 0], n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { d: [0, -1, 0], n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { d: [0, 0, 1], n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { d: [0, 0, -1], n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const positions = [], normals = [], colors = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const value = at(x, y, z);
    if (value === 0) continue;
    const p = (value - 1) * 4;
    const r = palette[p] / 255, g = palette[p + 1] / 255, b = palette[p + 2] / 255;
    for (const face of FACES) {
      if (at(x + face.d[0], y + face.d[1], z + face.d[2]) !== 0) continue;
      for (const i of [0, 1, 2, 0, 2, 3]) {
        positions.push(x + face.c[i][0] - nx / 2, y + face.c[i][1] - ny / 2, z + face.c[i][2] - nz / 2);
        normals.push(face.n[0], face.n[1], face.n[2]);
        colors.push(r, g, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Copy a [from,to) slab of a cluster grid along one axis into its own tight grid. */
function extractRange(cells, dims, axis, from, to) {
  const [nx, ny, nz] = dims;
  const outDims = [...dims];
  outDims[axis] = to - from;
  const out = new Uint8Array(outDims[0] * outDims[1] * outDims[2]);
  let voxels = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const c = [x, y, z];
    if (c[axis] < from || c[axis] >= to) continue;
    const v = cells[x + y * nx + z * nx * ny];
    if (v === 0) continue;
    c[axis] -= from;
    out[c[0] + c[1] * outDims[0] + c[2] * outDims[0] * outDims[1]] = v;
    voxels++;
  }
  return { cells: out, dims: outDims, voxels };
}
