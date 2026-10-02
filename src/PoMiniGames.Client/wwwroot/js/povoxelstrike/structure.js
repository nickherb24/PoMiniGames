// structure.js — a placed, destructible voxel structure.
//
// Owns the mutable voxel grid, its chunked render meshes, its coarse static collision
// body, and the structural-support solver. The stress model is a load-bearing
// one made cheap enough for a per-click budget: support propagates from grounded
// voxels — full strength straight up a column, decaying per lateral/hanging step — and
// any solid voxel the propagation cannot reach fails. That expresses both "no load path
// to the ground" (severed) and "cantilever exceeds material strength" (too far from a
// support column) in one BFS, at ~2-5 ms for a typical asset.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createVoxelMaterial } from './materials.js';
import { greedyBoxes } from './voxelboxes.js';
import { greedyMesh } from './greedymesh.js';
import { GRAVITY, materialFor, surfaceOf, MATERIAL_PRESETS } from './physics.js';

// Render-mesh rebuild granularity, in voxels. Doubled alongside world.js's REFINE = 2 to
// keep the same world-space chunk size; at 16 the refined grid would give 8x the chunks
// for no extra fidelity.
const CHUNK = 32;

// Collision is built by greedy-merging the ACTUAL solid voxels (voxelboxes.js), one
// static body per chunk, rather than stamping a box wherever an 8-voxel block had
// anything in it. That old lattice was 2 m across on a 0.25 m wall, so a blasted opening
// still collided as solid for two metres in every direction.
const COLLIDER_BOX_BUDGET = 48;   // per chunk; voxelboxes.js coarsens rather than truncates

// Collider chunking is SEPARATE from render chunking, and much finer.
//
// cannon's narrowphase tests every shape pair of two overlapping bodies, rejecting each
// by bounding sphere. A collider body covering a 32-voxel (8 m) chunk carries a hundred
// or more boxes, so any debris within 8 m of it paid for all of them — measured at 53 ms
// per physics step with the shrapnel removed, against ~95 dynamic bodies, which is not a
// solver cost at all. Splitting the same geometry into 4 m bodies lets the broadphase
// discard almost all of it, because a falling brick only overlaps one or two of them.
// The shapes are identical; only how they are grouped changes.
// MEASURED, not guessed: 16 was tried and made things worse. It split the fortress into
// 2 314 collider bodies and the physics step went from 81 ms to 121 ms — the broadphase's
// per-body sort cost more than the narrowphase saved. 32 keeps bodies chunky and few.
const COLLIDER_CHUNK = 32;

// Level of detail, in voxels per rendered quad, by distance from the camera in metres.
// Collision is NEVER decimated -- voxelboxes.js always works from the real grid -- so
// this trades silhouette precision at range for triangles, and nothing else. Bands carry
// hysteresis so a player standing on a boundary does not thrash a whole building's mesh.
const LOD_BANDS = [
  { near: 0, step: 1 },
  { near: 55, step: 2 },
  { near: 110, step: 4 },
];
const LOD_HYSTERESIS_M = 10;

/**
 * One worker shared by every structure. The solve is single-threaded either way, so a
 * pool would only let two collapses overlap; what matters is that none of them run on
 * the frame thread. Created lazily and once — a worker per structure would be 44 of them.
 * If the environment refuses a module worker (older Safari, a file:// page, a locked-down
 * CSP) this stays null and every structure falls back to solving inline, exactly as before.
 */
let supportWorker;
let supportWorkerFailed = false;
const supportJobs = new Map(); // job id -> Structure
let supportJobId = 0;

function getSupportWorker() {
  if (supportWorker || supportWorkerFailed) return supportWorker ?? null;
  try {
    supportWorker = new Worker(new URL('./supportWorker.js', import.meta.url), { type: 'module' });
    supportWorker.onmessage = (e) => {
      const { id, generation, failing, stressedIdx, stressedRatio } = e.data;
      const structure = supportJobs.get(id);
      supportJobs.delete(id);
      structure?._applySolve(failing, generation, stressedIdx, stressedRatio);
    };
    supportWorker.onerror = (err) => {
      console.warn('[povoxelstrike/structure] support worker failed; solving inline:', err);
      supportWorkerFailed = true;
      supportWorker = null;
    };
  } catch (err) {
    console.warn('[povoxelstrike/structure] support worker unavailable; solving inline:', err);
    supportWorkerFailed = true;
    supportWorker = null;
  }
  return supportWorker;
}

// Bucket range for the support solve. Lateral step cost is derived per material from its
// bending capacity, so this is a resolution, not a distance: a material that cantilevers
// a long way pays 1 per step and gets all 64 of them, a weak one pays more per step.
const SUPPORT_RESOLUTION = 64;
// Section depth assumed when converting tensile strength into a cantilever length. A real
// bending calculation needs the local depth; sampling the true thickness per voxel would
// cost more than the whole solve, and 4 voxels is the order of a wall leaf.

const BENDING_DEPTH_VOXELS = 4;

// Fracture. ROUGHNESS is the fraction by which the crater radius wanders; the wavelength
// is fixed at 4 voxels by the `>> 2` in the carve loop, which is coarse enough to read as
// broken masonry rather than as noise on the surface.
const FRACTURE_ROUGHNESS = 0.22;
const FRACTURE_MIN_VOXELS = 220;      // below this the debris system bursts it anyway
const FRACTURE_VOXELS_PER_PIECE = 190;
const FRACTURE_MAX_PIECES = 8;        // caps the body count one collapse can produce

// ── Stress & damage — the “stress simulation” half of the structural model ────
//
// The support solve answers “what stands”. These constants feed its second output: how
// HARD every surviving voxel is working, as a fraction of the strength it has left.
// A hit injects fatigue (applyImpact) around the crater; the solver then fails voxels
// against their DAMAGED strength, so a column pounded by repeated shots sags, shows
// stress tint, and finally gives way under loads it held comfortably two shots ago —
// the progressive, cumulative failure the reference simulations are all about.
// TINT_ONSET must match STRESS_ONSET in supportWorker.js (that file is
// deliberately dependency-free and cannot import this one).
const TINT_ONSET = 0.35;              // fraction of strength where stress shows on the mesh
const DAMAGE_MAX = 1.25;              // fatigue saturation; beyond this more hits change nothing
const STRENGTH_FLOOR = 0.85;          // max FRACTION of strength damage can remove (sync w/ worker)

/** Stable 3D value hash in [0,1). Same generator as the terrain's, one dimension up. */
function hash3(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Cantilever reach for a material, in VOXELS -- derived, not tuned.
//
// A cantilever fails in bending, not pure tension: for a beam of length L and section
// depth d carrying only its own weight, peak fibre stress is 3*rho*g*L^2/d. Set that
// equal to the material's tensile strength and solve for L and you get the longest
// unsupported span it holds. Stone (2 MPa tensile, 2400 kg/m3) over a 1 m section gives
// 5.3 m, which is about what a real stone corbel manages and is why battlements can
// overhang at all. Oak comes out in the tens of metres, so timber framing effectively
// never snaps under its own weight -- also correct.
function cantileverVoxels(material, scale) {
  const depth = BENDING_DEPTH_VOXELS * scale;
  const tensile = material?.tensile ?? MATERIAL_PRESETS.stone.tensile;
  const density = material?.density ?? MATERIAL_PRESETS.stone.density;
  return Math.max(1, Math.sqrt((tensile * depth) / (3 * density * GRAVITY)) / scale);
}


export class Structure {
  /**
   * @param volume decoded pvx volume (cells are COPIED — instances carve independently)
   * @param scale world units per voxel
   * @param terrain optional — lets the support solver notice when the ground under a
   *   base column has been dug away (undermining). Without it, grid y=0 is
   *   unconditionally "the ground" and an undermined building floats.
   */
  constructor(volume, scale, position, rotationY, scene, physicsWorld, terrain = null,
    physicsMaterials = null) {
    this.terrain = terrain;
    this.dims = volume.dims;
    this.palette = volume.palette;
    // The material table travels with the structure now: mass, cantilever reach, crush
    // threshold, carve resistance and contact surface all read from it.
    this.volume = { materials: volume.materials, paletteMaterial: volume.paletteMaterial };
    this.materialTable = volume.materials ?? [MATERIAL_PRESETS.stone];
    this.cells = new Uint8Array(volume.cells); // per-instance copy
    this.scale = scale;
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.solidCount = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== 0) this.solidCount++;

    // Stress bookkeeping, owned by the main thread (the worker only reads a snapshot).
    // MUST precede the first rebuildDirtyChunks() below: meshing already consults the
    // tint, and the very first mesh happens in this constructor.
    //   damage     — per-voxel fatigue in [0, DAMAGE_MAX], allocated lazily because most
    //                structures are never pounded; null until the first impact.
    //   stress     — voxel index → load ratio from the last solve, ABOVE TINT_ONSET only.
    //                Compact by construction: the worker ships just the loaded voxels.
    //   _damaged   — indices damage has ever been written to, so stress absorption can
    //                fold permanent cracks into the tint without a full-grid pass.
    //   _stressBands — index → tint band currently meshed, so a solve whose stress picture
    //                confirms the old one re-meshes nothing.
    this.damage = null;
    this.stress = new Map();
    this._damaged = new Set();
    this._stressBands = new Map();

    const [nx, , nz] = this.dims;
    this.cx = nx / 2;
    this.cz = nz / 2;

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = rotationY;
    this.group.scale.setScalar(scale);
    scene.add(this.group);
    this.group.updateMatrixWorld(true);
    this.inverseMatrix = this.group.matrixWorld.clone().invert();

    this.material = createVoxelMaterial();
    // Chunk GEOMETRY is kept (so a carve re-meshes only what it touched) but chunks are
    // no longer separate Meshes: their vertex data is concatenated into ONE mesh per
    // structure. 44 structures at ~18 chunks each was ~780 draw calls a frame; this is 44.
    // Concatenation is a memcpy over already-built arrays, which is far cheaper than
    // re-meshing a whole building, so the incremental win survives.
    this.chunkData = new Map();   // chunkKey -> { positions, normals, colors } | null
    this.dirtyChunks = new Set();       // carve-driven: rebuilt promptly
    this.lodDirtyChunks = new Set();    // LOD-driven: rebuilt on a budget
    this.lodStep = 1;
    this._lodDistance = 0;
    this.mergeDirty = true;
    this.mesh = null;
    for (const key of this._allChunkKeys()) this.dirtyChunks.add(key);
    this.rebuildDirtyChunks();

    // One static body PER CHUNK rather than one for the whole structure: the broadphase
    // can cull a chunk, and a carve rebuilds only the chunks it touched instead of
    // regenerating the entire collider on every shot.
    this.colliderBodies = new Map(); // collider chunk key -> CANNON.Body
    this.colliderDirtyChunks = new Set();
    for (const key of this._allColliderKeys()) this.colliderDirtyChunks.add(key);
    this.colliderDirty = true;

    // Per-palette-entry tables for the stress solve. There are a handful of palette
    // entries and millions of voxels, so this turns a per-voxel sqrt into a lookup.
    const entries = Math.max(1, Math.floor((volume.palette?.length ?? 4) / 4));
    this.stepCost = new Uint8Array(entries + 1);
    this.crushStress = new Float32Array(entries + 1);
    this.voxelWeight = new Float32Array(entries + 1); // newtons per voxel
    for (let v = 1; v <= entries; v++) {
      const m = materialFor(this.volume, v);
      this.stepCost[v] = Math.max(1,
        Math.round(SUPPORT_RESOLUTION / cantileverVoxels(m, this.scale)));
      this.crushStress[v] = m.compressive ?? MATERIAL_PRESETS.stone.compressive;
      this.voxelWeight[v] = (m.density ?? 2400) * this.scale ** 3 * GRAVITY;
    }
    // How far a blast eats into each material, relative to stone. Compressive strength
    // to the quarter power: a 4x weaker material takes a ~40% wider crater, not a 4x one,
    // because the blast energy spreads over a sphere. Plaster shatters, oak resists.
    this.carveMult = new Float32Array(entries + 1);
    for (let v = 1; v <= entries; v++) {
      this.carveMult[v] = Math.min(1.6, Math.max(0.75,
        (MATERIAL_PRESETS.stone.compressive / this.crushStress[v]) ** 0.25));
    }
    this.surface = surfaceOf(this.materialTable[0]);
    this.physicsMaterial = physicsMaterials ? physicsMaterials[this.surface] : undefined;

    // Async solve bookkeeping. `onClusters` is set by the engine and is how detached mass
    // reaches the debris system now that the answer arrives a frame or two after the shot.
    // (The stress fields themselves are initialised near the top of the constructor —
    // meshing reads them from the very first rebuild.)
    this.onClusters = null;
    this.solveGeneration = 0;
    this.solveInFlight = false;
    this.solveAgain = false;

    this.rebuildCollider();
  }

  at(x, y, z) {
    const [nx, ny, nz] = this.dims;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
    return this.cells[x + y * nx + z * nx * ny];
  }

  // ── Carving ────────────────────────────────────────────────────────────

  /**
   * Remove all voxels within worldRadius of worldPoint, then re-solve support and
   * detach whatever fails. Returns { removed:[{x,y,z,value}], clusters:[cluster] }
   * where each cluster is { voxels:[{x,y,z,value}], … } of NEWLY unsupported voxels
   * (already removed from this grid) for the caller to turn into debris.
   */
  carveSphere(worldPoint, worldRadius) {
    const local = worldPoint.clone().applyMatrix4(this.inverseMatrix);
    const vx = local.x + this.cx, vy = local.y, vz = local.z + this.cz;
    const r = worldRadius / this.scale;
    const [nx, ny, nz] = this.dims;
    const removed = [];

    // The crater is NOT a sphere. Two things break it up, and both are physical rather
    // than decorative:
    //   * material -- weak plaster is eaten further out than dense stone (carveMult);
    //   * fracture -- masonry fails along faults, so the boundary is perturbed by a
    //     coherent hash at a ~4-voxel wavelength. Chunks come off angular, and repeated
    //     hits on one spot no longer stack into a machined hemisphere.
    // The scan box is grown by the largest possible multiplier so the widened side of an
    // irregular crater is never clipped by the loop bounds.
    const reach = r * 1.6 * (1 + FRACTURE_ROUGHNESS);
    for (let z = Math.max(0, Math.floor(vz - reach)); z <= Math.min(nz - 1, Math.ceil(vz + reach)); z++) {
      for (let y = Math.max(0, Math.floor(vy - reach)); y <= Math.min(ny - 1, Math.ceil(vy + reach)); y++) {
        for (let x = Math.max(0, Math.floor(vx - reach)); x <= Math.min(nx - 1, Math.ceil(vx + reach)); x++) {
          const i = x + y * nx + z * nx * ny;
          const value = this.cells[i];
          if (value === 0) continue;
          const dx = x + 0.5 - vx, dy = y + 0.5 - vy, dz = z + 0.5 - vz;
          const d2 = dx * dx + dy * dy + dz * dz;
          const rough = 1 + FRACTURE_ROUGHNESS * (hash3(x >> 2, y >> 2, z >> 2) * 2 - 1);
          const rr = r * (this.carveMult[value] ?? 1) * rough;
          if (d2 > rr * rr) continue;
          removed.push({ x, y, z, value });
          this.cells[i] = 0;
          this.solidCount--;
          this._markDirty(x, y, z);
        }
      }
    }
    if (removed.length === 0) return { removed, clusters: [] };

    this.colliderDirty = true;
    // The structural solve is dispatched, not awaited. Detached mass arrives through
    // onClusters within a frame or two; the crater itself is already in the grid, so what
    // the player sees on the trigger pull is unchanged.
    const clusters = this._requestSolve();
    return { removed, clusters };
  }

  // ── Impact stress ─────────────────────────────────────────────────────────

  /**
   * Write impact fatigue into the structure around a world point — the half of a hit
   * that the carve radius does not express. The crater removes material; this weakens
   * what stayed, so the NEXT solve judges it against reduced strength. That is what
   * makes failure cumulative: a column under a tower holds one shell fine, shows stress
   * after the second, and drops the tower on the third.
   *
   * Peak damage falls off quadratically from the hit point (energy density spreads over
   * a sphere) and scales with the same carve multiplier the crater uses, so plaster
   * shatters further out than oak. Re-solving is what turns the written damage into
   * visible collapse — a weakened member fails here, not on some future shot.
   *
   * @param worldPoint hit point
   * @param radius metres of structure around it that takes stress
   * @param peakDamage fatigue written at the centre, in [0, 1+] (fraction-of-strength units)
   */
  applyImpact(worldPoint, radius, peakDamage) {
    if (peakDamage <= 0 || radius <= 0 || this.solidCount === 0) return;
    const local = worldPoint.clone().applyMatrix4(this.inverseMatrix);
    const vx = local.x + this.cx, vy = local.y, vz = local.z + this.cz;
    const r = radius / this.scale;
    const [nx, ny, nz] = this.dims;
    const layer = nx * ny;
    const damage = this.damage ??= new Float32Array(this.cells.length);

    let hurt = 0;
    for (let z = Math.max(0, Math.floor(vz - r)); z <= Math.min(nz - 1, Math.ceil(vz + r)); z++) {
      for (let y = Math.max(0, Math.floor(vy - r)); y <= Math.min(ny - 1, Math.ceil(vy + r)); y++) {
        for (let x = Math.max(0, Math.floor(vx - r)); x <= Math.min(nx - 1, Math.ceil(vx + r)); x++) {
          const i = x + y * nx + z * layer;
          const value = this.cells[i];
          if (value === 0) continue;
          const dx = x + 0.5 - vx, dy = y + 0.5 - vy, dz = z + 0.5 - vz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r * r) continue;
          const falloff = 1 - Math.sqrt(d2) / r;
          const add = peakDamage * falloff * falloff * (this.carveMult[value] ?? 1);
          if (add <= 0) continue;
          const before = damage[i];
          damage[i] = Math.min(DAMAGE_MAX, before + add);
          if (damage[i] !== before) { hurt++; this._damaged.add(i); }
        }
      }
    }
    // Even a hit that severed nothing has changed the load/strength picture, so the
    // solve runs here too — this is how a hit NEXT TO a cracked beam brings the beam
    // down. The usual coalescing bounds the cost under sustained fire. With a worker the
    // solve is async and detachments arrive through onClusters; the inline fallback
    // returns them here, so they go out the same door instead of vanishing.
    if (hurt > 0) {
      const clusters = this._requestSolve();
      if (clusters.length > 0) this.onClusters?.(this, clusters);
    }
  }

  // ── Structural support ─────────────────────────────────────────────────

  /**
   * Solve the structure and detach everything that fails. Two independent failure modes,
   * both now driven by the material constants that ship in every volume:
   *
   *   TENSION / BENDING -- a load path is traced from the grounded voxels upward. Going
   *     straight up a column is free; every lateral or hanging step spends part of a
   *     budget, and the cost of a step is set by how far that material can actually
   *     cantilever (see cantileverVoxels). Run out of budget and the voxel has no way to
   *     reach the ground: it is severed and falls.
   *
   *   COMPRESSION -- weight is accumulated downward through the surviving voxels and
   *     divided by the voxel's face area to give a real stress in pascals. Exceed the
   *     material's compressive strength and it crushes. A 34 m stone keep loads its base
   *     to about 0.8 MPa against a 20 MPa limit, so it stands -- until you carve away
   *     enough of that base that the remaining columns carry twenty-five times the load,
   *     and then it does not.
   *
   * Crushing cascades across carves rather than within one: crushed voxels are removed
   * now, and whatever they were holding fails on the next solve. One pass per shot keeps
   * a carve bounded, and a real collapse takes a beat to run through a building anyway.
   */
  _detachUnsupported() {
    const [nx, ny, nz] = this.dims;
    const layer = nx * ny;
    const support = new Int16Array(this.cells.length).fill(-1);

    // Bucket queue, processed from strongest support down, so each voxel is finalized
    // the first time it is popped (Dijkstra over a small integer range).
    const buckets = Array.from({ length: SUPPORT_RESOLUTION + 1 }, () => []);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = x + z * layer; // y = 0: sitting on the ground grounds a column —
        // but only while the ground is actually still there (undermining check).
        if (this.cells[i] !== 0 && this._groundIntact(x, z)) {
          support[i] = SUPPORT_RESOLUTION;
          buckets[SUPPORT_RESOLUTION].push(i);
        }
      }
    }

    for (let s = SUPPORT_RESOLUTION; s > 0; s--) {
      const bucket = buckets[s];
      for (let b = 0; b < bucket.length; b++) {
        const i = bucket[b];
        if (support[i] !== s) continue; // superseded by a stronger path
        const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / layer) | 0;
        // Up a column costs nothing: that is pure compression, and masonry is strong in
        // compression. Every sideways or hanging step is bending, and pays.
        this._relax(support, buckets, x, y + 1, z, s, 0);
        this._relax(support, buckets, x + 1, y, z, s, 1);
        this._relax(support, buckets, x - 1, y, z, s, 1);
        this._relax(support, buckets, x, y, z + 1, s, 1);
        this._relax(support, buckets, x, y, z - 1, s, 1);
        this._relax(support, buckets, x, y - 1, z, s, 1);   // hanging below
      }
      bucket.length = 0;
    }

    // Failing voxels → connected clusters (6-conn flood fill), removed from the grid.
    // Survivors also seed a stress field from the bending budget they spent — same as
    // the worker path, so tint and damage behave identically when the worker is absent.
    const ratio = new Float32Array(this.cells.length);
    const clusters = [];
    const failing = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === 0) continue;
      if (support[i] <= 0) { failing.push(i); continue; }
      const r = 1 - support[i] / SUPPORT_RESOLUTION;
      if (r > TINT_ONSET) ratio[i] = r;
    }
    // Compression pass over everything the load path DID reach.
    const area = this.scale * this.scale;
    const load = new Float32Array(this.cells.length);
    for (let y = ny - 1; y >= 0; y--) {
      for (let z = 0; z < nz; z++) {
        const rowBase = y * nx + z * layer;
        for (let x = 0; x < nx; x++) {
          const i = rowBase + x;
          const v = this.cells[i];
          if (v === 0 || support[i] <= 0) continue;
          const carried = load[i] + this.voxelWeight[v];
          const eff = this.crushStress[v]
            * (1 - (this.damage ? Math.min(STRENGTH_FLOOR, this.damage[i]) : 0));
          const stress = carried / area / eff;
          if (stress > 1) { failing.push(i); continue; }
          if (stress > ratio[i]) ratio[i] = stress;
          if (y === 0) continue;
          const below = i - nx;
          if (this.cells[below] !== 0) { load[below] += carried; continue; }
          // Nothing directly underneath: the load spreads onto whatever diagonal
          // neighbours below are solid, the way a corbelled course sheds weight sideways.
          let n = 0;
          const cand = [];
          if (x > 0 && this.cells[below - 1] !== 0) { cand.push(below - 1); n++; }
          if (x < nx - 1 && this.cells[below + 1] !== 0) { cand.push(below + 1); n++; }
          if (z > 0 && this.cells[below - layer] !== 0) { cand.push(below - layer); n++; }
          if (z < nz - 1 && this.cells[below + layer] !== 0) { cand.push(below + layer); n++; }
          if (n === 0) continue; // hanging; the tension pass already judged it
          const share = carried / n;
          for (const c of cand) load[c] += share;
        }
      }
    }
    // Absorb the stress picture before cutting clusters, exactly like _applySolve.
    const stressedIdx = [];
    const stressedRatio = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (ratio[i] > TINT_ONSET) { stressedIdx.push(i); stressedRatio.push(ratio[i]); }
    }
    this._absorbStress(stressedIdx, stressedRatio);
    if (failing.length === 0) return clusters;

    return this._clusterFailing(failing);
  }

  /**
   * Turn a flat list of failing cell indices into connected clusters, removing them from
   * the grid. Shared by the inline and the worker paths.
   */
  _clusterFailing(failingInput) {
    const [nx, ny, nz] = this.dims;
    const layer = nx * ny;
    const clusters = [];
    const failing = [];
    for (const i of failingInput) if (this.cells[i] !== 0) failing.push(i);
    if (failing.length === 0) return clusters;

    const failSet = new Uint8Array(this.cells.length);
    for (const i of failing) failSet[i] = 1;

    for (const seed of failing) {
      if (failSet[seed] !== 1) continue;
      const voxels = [];
      const stack = [seed];
      failSet[seed] = 2;
      while (stack.length > 0) {
        const i = stack.pop();
        const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / layer) | 0;
        voxels.push({ x, y, z, value: this.cells[i] });
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const qx = x + dx, qy = y + dy, qz = z + dz;
          if (qx < 0 || qy < 0 || qz < 0 || qx >= nx || qy >= ny || qz >= nz) continue;
          const q = qx + qy * nx + qz * layer;
          if (failSet[q] === 1) { failSet[q] = 2; stack.push(q); }
        }
      }
      for (const v of voxels) {
        this.cells[v.x + v.y * nx + v.z * layer] = 0;
        this.solidCount--;
        this._markDirty(v.x, v.y, v.z);
      }
      for (const part of this._fracture(voxels)) clusters.push({ voxels: part });
    }
    return clusters;
  }

  /**
   * Split one detached blob along fracture planes. Masonry does not come away as a single
   * smooth lump: it breaks into angular, interlocking pieces. A Voronoi partition around
   * random seed points inside the blob is the cheapest thing that produces exactly that —
   * flat internal faces, irregular sizes, no rounding.
   *
   * Small blobs are left whole: below FRACTURE_MIN_VOXELS the debris system bursts them
   * to particles anyway, so splitting would only add bookkeeping.
   */
  _fracture(voxels) {
    if (voxels.length < FRACTURE_MIN_VOXELS) return [voxels];
    const k = Math.min(FRACTURE_MAX_PIECES,
      Math.max(2, Math.round(voxels.length / FRACTURE_VOXELS_PER_PIECE)));
    const seeds = [];
    for (let i = 0; i < k; i++) seeds.push(voxels[(Math.random() * voxels.length) | 0]);

    const groups = Array.from({ length: k }, () => []);
    for (const v of voxels) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < k; i++) {
        const s = seeds[i];
        const dx = v.x - s.x, dy = v.y - s.y, dz = v.z - s.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      groups[best].push(v);
    }
    return groups.filter(g => g.length > 0);
  }

  /**
   * Does `world` sit inside this building with solid voxels overhead? Used by the audio
   * reverb zones to decide whether the player is in a stone room or in the open.
   * Returns 0 (outside) or 1 (enclosed) rather than a boolean so callers can max() over
   * every structure and feed the result straight into a crossfade.
   *
   * The ceiling scan is capped: a full column walk on a 112-tall refined castle, run for
   * every structure every frame, is exactly the kind of loop that turns a 4 Hz check into
   * a per-frame cost. 40 cells above the head is the tallest ceiling worth detecting.
   */
  indoorAt(world) {
    const local = this._indoorVec ??= new THREE.Vector3();
    local.copy(world).applyMatrix4(this.inverseMatrix);
    const [nx, ny, nz] = this.dims;
    const x = Math.floor(local.x + this.cx);
    const y = Math.floor(local.y);
    const z = Math.floor(local.z + this.cz);
    if (x < 0 || z < 0 || x >= nx || z >= nz || y < 0 || y >= ny) return 0;
    if (this.cells[x + y * nx + z * nx * ny] !== 0) return 0; // standing in solid rock
    const layer = nx * ny;
    const top = Math.min(ny - 1, y + 40);
    for (let yy = y + 1; yy <= top; yy++) {
      if (this.cells[x + yy * nx + z * layer] !== 0) return 1;
    }
    return 0;
  }

  /**
   * Is the terrain under base voxel (x, 0, z) still at pad height? The build pad was
   * flattened to the structure's base at spawn, so any surface more than ~one voxel
   * below the base means someone dug it out — that column no longer grounds anything.
   */
  _groundIntact(x, z) {
    if (!this.terrain) return true;
    const w = this._groundProbe ??= new THREE.Vector3();
    w.set(x + 0.5 - this.cx, 0.5, z + 0.5 - this.cz).applyMatrix4(this.group.matrixWorld);
    return this.terrain.heightAt(w.x, w.z) >= this.group.position.y - this.scale * 1.2;
  }

  /**
   * Re-run the support solve without a carve — call after the terrain near this
   * structure was dug (undermining). Returns detached clusters exactly like
   * carveSphere's second half; the caller turns them into debris.
   */
  /**
   * Kick off a solve. Returns clusters immediately ONLY on the inline fallback path;
   * with a worker it returns empty and the result is delivered to `onClusters`.
   */
  _requestSolve() {
    const worker = getSupportWorker();
    if (!worker) return this._detachUnsupported();

    if (this.solveInFlight) {
      // Coalesce: one solve in flight per structure. Sustained fire would otherwise queue
      // a full solve per shot and the worker would fall behind the grid it is solving.
      this.solveAgain = true;
      return [];
    }
    this.solveInFlight = true;
    this.solveAgain = false;

    const [nx, , nz] = this.dims;
    const grounded = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        if (this.cells[x + z * nx * this.dims[1]] !== 0 && this._groundIntact(x, z)) {
          grounded[x + z * nx] = 1;
        }
      }
    }

    const id = ++supportJobId;
    supportJobs.set(id, this);
    const snapshot = this.cells.slice(); // transferred; the structure keeps its own grid
    const damage = this.damage ? this.damage.slice() : new Float32Array(0); // transferred copy
    worker.postMessage({
      id, generation: this.solveGeneration, dims: this.dims, cells: snapshot, grounded,
      stepCost: this.stepCost, crushStress: this.crushStress, voxelWeight: this.voxelWeight,
      scale: this.scale, resolution: SUPPORT_RESOLUTION, damage,
    }, [snapshot.buffer, grounded.buffer, damage.buffer]);
    return [];
  }

  /**
   * Apply a worker result. Indices that are already empty are skipped — the grid may have
   * been carved further while the solve ran, and a result from a MORE solid grid can only
   * be incomplete, never wrong (see the note in supportWorker.js).
   */
  _applySolve(failing, generation, stressedIdx = [], stressedRatio = []) {
    this.solveInFlight = false;
    if (generation !== this.solveGeneration) { failing = failing.filter(() => true); }
    // Absorb the stress picture BEFORE detaching: the tint diff should include voxels
    // that are about to leave (their chunks re-mesh anyway when the cluster is cut out).
    this._absorbStress(stressedIdx, stressedRatio);
    const clusters = failing.length > 0 ? this._clusterFailing(failing) : [];
    if (clusters.length > 0) this.onClusters?.(this, clusters);
    if (this.solveAgain) { this.solveAgain = false; this._requestSolve(); }
  }

  /**
   * Fold one solve's stress field into the tint state. Only voxels whose visible stress
   * BAND changed mark their chunk dirty, so a solve that confirms the old picture costs
   * a map rebuild and nothing else; entries the new solve no longer reports fade back to
   * whatever permanent damage alone justifies — cracks stay after the load moves on.
   */
  _absorbStress(stressedIdx, stressedRatio) {
    const next = new Map();
    for (let k = 0; k < stressedIdx.length; k++) {
      const i = stressedIdx[k];
      if (this.cells[i] === 0) continue; // carved away while the solve ran
      next.set(i, stressedRatio[k]);
    }
    // Permanent damage keeps tinting even where the current load is mild.
    if (this.damage) {
      for (const i of this._damaged) {
        if (this.cells[i] === 0) { this._damaged.delete(i); continue; }
        const d = Math.min(1, this.damage[i]);
        if (d > TINT_ONSET && d > (next.get(i) ?? 0)) next.set(i, d);
      }
    }
    for (const [i, r] of next) {
      const band = this._bandOf(r);
      if ((this._stressBands.get(i) ?? 0) !== band) {
        this._stressBands.set(i, band);
        this._dirtyTintChunk(i);
      }
    }
    for (const [i] of this._stressBands) {
      if (!next.has(i)) { this._stressBands.delete(i); this._dirtyTintChunk(i); }
    }
    this.stress = next;
  }

  /** Tint bands are coarse on purpose: re-mesh only on a visible step, not every ratio wiggle. */
  _bandOf(v) {
    return v <= TINT_ONSET ? 0 : Math.min(4, 1 + (((v - TINT_ONSET) / (1 - TINT_ONSET)) * 4 | 0));
  }

  /** A tint change only alters faces of the voxel's OWN chunk (each chunk meshes its own voxels). */
  _dirtyTintChunk(i) {
    const [nx, ny] = this.dims;
    const x = i % nx, y = ((i / nx) | 0) % ny;
    const z = (i / (nx * ny)) | 0;
    this.dirtyChunks.add(
      `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)},${Math.floor(z / CHUNK)}`);
  }

  /** Visible stress at a voxel for the mesher: live load ratio, or the crack scar it left. */
  _stressAt(x, y, z) {
    const [nx, ny] = this.dims;
    const i = x + y * nx + z * nx * ny;
    let v = this.stress.get(i) ?? 0;
    if (this.damage) { const d = this.damage[i]; if (d > v) v = d; }
    return v;
  }

  recheckSupport() {
    if (this.solidCount === 0) return [];
    const clusters = this._detachUnsupported();
    if (clusters.length > 0) this.colliderDirty = true;
    return clusters;
  }

  /**
   * Relax the load path into a neighbour. `steps` is 0 for straight up (free) and 1 for a
   * bending step, whose cost in budget comes from the DESTINATION material -- oak spends
   * one unit and reaches sixty-four steps, plaster spends five and reaches twelve.
   */
  _relax(support, buckets, x, y, z, s, steps) {
    const [nx, ny, nz] = this.dims;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = x + y * nx + z * nx * ny;
    const v = this.cells[i];
    if (v === 0) return;
    const next = steps === 0 ? s : s - this.stepCost[v];
    if (next <= 0 || support[i] >= next) return;
    support[i] = next;
    buckets[next].push(i);
  }

  // ── Raycast (Amanatides-Woo DDA in voxel space) ───────────────────────

  /** @returns {{ distance:number, point:THREE.Vector3 } | null} nearest solid-voxel hit */
  raycast(origin, direction, maxDistance) {
    const o = origin.clone().applyMatrix4(this.inverseMatrix);
    o.x += this.cx; o.z += this.cz;
    const d = direction.clone().transformDirection(this.inverseMatrix).normalize();

    const [nx, ny, nz] = this.dims;
    const maxT = maxDistance / this.scale;

    // Clip the ray to the grid AABB BEFORE marching, and start the DDA at the entry
    // point. This is not an optimisation, it is a correctness fix: the march advances one
    // CELL per iteration and is bounded by a guard proportional to the grid size, so a
    // ray that starts far outside spends its whole budget crossing empty space and
    // returns null before it ever reaches the wall. At 0.25-unit voxels and a 160-unit
    // weapon range that is 640 cells of approach against a guard of a few hundred — which
    // is exactly why small or distant structures could not be shot at all, while the big
    // ones (bigger grid, bigger guard) worked fine.
    let tEnter = 0, tExit = maxT, enterAxis = -1;
    const oc = [o.x, o.y, o.z], dc = [d.x, d.y, d.z], hi = [nx, ny, nz];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dc[a]) < 1e-9) {
        if (oc[a] < 0 || oc[a] > hi[a]) return null;   // parallel and outside the slab
        continue;
      }
      const inv = 1 / dc[a];
      let ta = (0 - oc[a]) * inv;
      let tb = (hi[a] - oc[a]) * inv;
      if (ta > tb) { const swap = ta; ta = tb; tb = swap; }
      if (ta > tEnter) { tEnter = ta; enterAxis = a; }
      if (tb < tExit) tExit = tb;
      if (tEnter > tExit) return null;
    }

    let t = tEnter;
    // Nudge inside the entry face so floor() cannot land on the cell behind it.
    const ex = o.x + d.x * (t + 1e-4);
    const ey = o.y + d.y * (t + 1e-4);
    const ez = o.z + d.z * (t + 1e-4);
    let x = Math.min(nx - 1, Math.max(0, Math.floor(ex)));
    let y = Math.min(ny - 1, Math.max(0, Math.floor(ey)));
    let z = Math.min(nz - 1, Math.max(0, Math.floor(ez)));

    const stepX = Math.sign(d.x) || 1, stepY = Math.sign(d.y) || 1, stepZ = Math.sign(d.z) || 1;
    const tDeltaX = Math.abs(1 / d.x), tDeltaY = Math.abs(1 / d.y), tDeltaZ = Math.abs(1 / d.z);
    let tMaxX = d.x !== 0 ? t + ((stepX > 0 ? x + 1 - ex : ex - x) * tDeltaX) : Infinity;
    let tMaxY = d.y !== 0 ? t + ((stepY > 0 ? y + 1 - ey : ey - y) * tDeltaY) : Infinity;
    let tMaxZ = d.z !== 0 ? t + ((stepZ > 0 ? z + 1 - ez : ez - z) * tDeltaZ) : Infinity;

    // Face the ray last crossed, kept current so the hit can report a normal — decals and
    // impact sprays need one, and the caller previously got `undefined`. Seeded from the
    // slab test's entry axis; when the origin is already inside the grid there is no
    // entry face, so fall back to the axis the ray travels most slowly along.
    let axis = enterAxis >= 0 ? enterAxis : 1;
    let axisStep = axis === 0 ? stepX : axis === 1 ? stepY : stepZ;

    // One iteration per cell crossed, and the ray can cross at most the grid's Manhattan
    // span before it exits — hence this bound rather than a multiple of it.
    const guard = nx + ny + nz + 3;
    for (let i = 0; i < guard; i++) {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return null;
      if (this.at(x, y, z) !== 0) {
        const localPoint = new THREE.Vector3(
          o.x + d.x * t - this.cx, o.y + d.y * t, o.z + d.z * t - this.cz);
        const localNormal = new THREE.Vector3(
          axis === 0 ? -axisStep : 0, axis === 1 ? -axisStep : 0, axis === 2 ? -axisStep : 0);
        return {
          distance: t * this.scale,
          point: localPoint.applyMatrix4(this.group.matrixWorld),
          normal: localNormal.transformDirection(this.group.matrixWorld).normalize(),
        };
      }
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        t = tMaxX; tMaxX += tDeltaX; x += stepX; axis = 0; axisStep = stepX;
      } else if (tMaxY <= tMaxZ) {
        t = tMaxY; tMaxY += tDeltaY; y += stepY; axis = 1; axisStep = stepY;
      } else {
        t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ; axis = 2; axisStep = stepZ;
      }
      if (t > tExit || t > maxT) return null;
    }
    return null;
  }

  // ── Render meshes (chunked, rebuilt only where carved) ─────────────────

  _markDirty(x, y, z) {
    // Derived from CHUNK, NOT hardcoded. These were `>> 4` / `& 15` while CHUNK is 32, so
    // every carve marked the WRONG chunk dirty: the chunk that actually changed never
    // re-meshed and an unrelated one did. The hole existed in the grid and in the
    // collider, but not on screen.
    const cxk = Math.floor(x / CHUNK), cyk = Math.floor(y / CHUNK), czk = Math.floor(z / CHUNK);
    const mark = (a, b, c) => this.dirtyChunks.add(`${a},${b},${c}`);
    mark(cxk, cyk, czk);
    // A face on a chunk border changes the neighbour chunk's visible faces too.
    const lx = x % CHUNK, ly = y % CHUNK, lz = z % CHUNK;
    if (lx === 0) mark(cxk - 1, cyk, czk);
    if (lx === CHUNK - 1) mark(cxk + 1, cyk, czk);
    if (ly === 0) mark(cxk, cyk - 1, czk);
    if (ly === CHUNK - 1) mark(cxk, cyk + 1, czk);
    if (lz === 0) mark(cxk, cyk, czk - 1);
    if (lz === CHUNK - 1) mark(cxk, cyk, czk + 1);
    // Colliders are chunked separately and finer; only the touched one changes, since a
    // collider box never depends on a neighbouring chunk's contents.
    this.colliderDirtyChunks.add(
      `${Math.floor(x / COLLIDER_CHUNK)},${Math.floor(y / COLLIDER_CHUNK)},${Math.floor(z / COLLIDER_CHUNK)}`);
    this.colliderDirty = true;
  }

  *_allColliderKeys() {
    const [nx, ny, nz] = this.dims;
    for (let z = 0; z < Math.ceil(nz / COLLIDER_CHUNK); z++)
      for (let y = 0; y < Math.ceil(ny / COLLIDER_CHUNK); y++)
        for (let x = 0; x < Math.ceil(nx / COLLIDER_CHUNK); x++)
          yield `${x},${y},${z}`;
  }

  *_allChunkKeys() {
    const [nx, ny, nz] = this.dims;
    for (let z = 0; z < Math.ceil(nz / CHUNK); z++)
      for (let y = 0; y < Math.ceil(ny / CHUNK); y++)
        for (let x = 0; x < Math.ceil(nx / CHUNK); x++)
          yield `${x},${y},${z}`;
  }

  /**
   * Re-mesh what changed and re-upload the merged geometry.
   *
   * @param budget max LOD-driven chunks to re-mesh this call. Carve-driven chunks ignore
   *   the budget: a hole has to appear on the frame you made it. LOD chunks do not, and a
   *   whole building changing band would otherwise re-mesh every chunk in one frame —
   *   which is the stutter this budget exists to spread out.
   * @returns how much of the budget was spent, so the caller can share one across the
   *   whole fortress rather than letting each structure spend it in full.
   */
  rebuildDirtyChunks(budget = Infinity) {
    let spent = 0;
    for (const key of this.dirtyChunks) {
      this._meshChunk(key);
      this.lodDirtyChunks.delete(key); // just rebuilt at the current step
    }
    if (this.dirtyChunks.size > 0) { this.dirtyChunks.clear(); this.mergeDirty = true; }

    if (this.lodDirtyChunks.size > 0 && budget > 0) {
      for (const key of this.lodDirtyChunks) {
        if (spent >= budget) break;
        this._meshChunk(key);
        this.lodDirtyChunks.delete(key);
        spent++;
      }
      this.mergeDirty = true;
    }

    if (this.mergeDirty) this._merge();
    return spent;
  }

  _meshChunk(key) {
    const [ckx, cky, ckz] = key.split(',').map(Number);
    if (ckx < 0 || cky < 0 || ckz < 0) { this.chunkData.delete(key); return; }
    this.chunkData.set(key, this._buildChunkData(ckx * CHUNK, cky * CHUNK, ckz * CHUNK));
  }

  /** Concatenate every chunk's vertex data into the single mesh this structure draws. */
  _merge() {
    this.mergeDirty = false;
    let total = 0;
    for (const data of this.chunkData.values()) if (data) total += data.positions.length;

    if (total === 0) {
      if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
      return;
    }

    const positions = new Float32Array(total);
    const normals = new Float32Array(total);
    const colors = new Float32Array(total);
    let at = 0;
    for (const data of this.chunkData.values()) {
      if (!data) continue;
      positions.set(data.positions, at);
      normals.set(data.normals, at);
      colors.set(data.colors, at);
      at += data.positions.length;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
  }

  /**
   * Pick an LOD band for this structure and, when it changes, queue every chunk for a
   * lazy re-mesh. Called per frame with the camera position; the distance test is a
   * subtraction, so the per-frame cost is nothing and the work only happens on a change.
   */
  updateLod(cameraPosition) {
    const d = this.group.position.distanceTo(cameraPosition);
    // Hysteresis: only accept a band change once the camera is clearly past the boundary
    // in the direction it is moving, so walking along a wall does not re-mesh it repeatedly.
    let step = this.lodStep;
    for (let i = LOD_BANDS.length - 1; i >= 0; i--) {
      const edge = LOD_BANDS[i].near;
      const bias = LOD_BANDS[i].step > this.lodStep ? LOD_HYSTERESIS_M : -LOD_HYSTERESIS_M;
      if (d >= edge + bias) { step = LOD_BANDS[i].step; break; }
    }
    if (step === this.lodStep) return;
    this.lodStep = step;
    for (const key of this._allChunkKeys()) this.lodDirtyChunks.add(key);
  }

  /**
   * Merged vertex data for one chunk. The per-voxel face loop this replaces emitted a
   * quad for every exposed face — a 100-voxel run of flat wall was 10 000 identical
   * coplanar quads instead of one.
   */
  _buildChunkData(x0, y0, z0) {
    const [nx, ny, nz] = this.dims;
    return greedyMesh({
      // Reads the FULL grid, not the chunk: a face on a chunk boundary is only hidden if
      // the neighbour's voxel is solid, and a chunk blind to its neighbours would seal
      // itself into a box.
      get: (x, y, z) => this.at(x, y, z),
      min: [x0, y0, z0],
      max: [Math.min(x0 + CHUNK, nx), Math.min(y0 + CHUNK, ny), Math.min(z0 + CHUNK, nz)],
      palette: this.palette,
      offset: [this.cx, 0, this.cz],
      step: this.lodStep,
      // Stress/damage darkens the faces — damaged masonry reads as cracked masonry.
      tint: (x, y, z) => this._stressAt(x, y, z),
    });
  }

  // ── Static collision (exact, greedy-merged, one body per chunk) ────────

  /**
   * Add or remove this structure's collider bodies from the physics world wholesale.
   * Used by the engine's distance streaming: a building on the far side of the fortress
   * still has an exact collider, it just is not resident in the broadphase until you are
   * close enough for it to matter.
   */
  setColliderActive(active) {
    if (active === (this.colliderActive ?? true)) return;
    this.colliderActive = active;
    for (const body of this.colliderBodies.values()) {
      if (active) this.physicsWorld.addBody(body);
      else this.physicsWorld.removeBody(body);
    }
  }

  /**
   * Rebuild collision for the chunks a carve touched. Each chunk becomes one static body
   * whose shapes are its greedy-merged solid voxels, so the collider is the shape you can
   * see instead of a lattice drawn around it.
   */
  rebuildCollider() {
    if (!this.colliderDirty) return;
    this.colliderDirty = false;
    if (this.colliderDirtyChunks.size === 0) return;

    const [nx, ny, nz] = this.dims;
    const cx = Math.ceil(nx / COLLIDER_CHUNK);
    const cy = Math.ceil(ny / COLLIDER_CHUNK);
    const cz = Math.ceil(nz / COLLIDER_CHUNK);
    const px = this.group.position, ry = this.group.rotation.y;

    for (const key of this.colliderDirtyChunks) {
      const [ci, cj, ck] = key.split(',').map(Number);
      const old = this.colliderBodies.get(key);
      if (old) { this.physicsWorld.removeBody(old); this.colliderBodies.delete(key); }
      if (ci < 0 || cj < 0 || ck < 0 || ci >= cx || cj >= cy || ck >= cz) continue;

      const x0 = ci * COLLIDER_CHUNK, y0 = cj * COLLIDER_CHUNK, z0 = ck * COLLIDER_CHUNK;
      const w = Math.min(COLLIDER_CHUNK, nx - x0);
      const h = Math.min(COLLIDER_CHUNK, ny - y0);
      const d = Math.min(COLLIDER_CHUNK, nz - z0);
      const sub = new Uint8Array(w * h * d);
      let any = false;
      for (let z = 0; z < d; z++) {
        for (let y = 0; y < h; y++) {
          const src = x0 + (y0 + y) * nx + (z0 + z) * nx * ny;
          const dst = y * w + z * w * h;
          for (let x = 0; x < w; x++) {
            if (this.cells[src + x] !== 0) { sub[dst + x] = 1; any = true; }
          }
        }
      }
      if (!any) continue;

      const { boxes, count } = greedyBoxes(sub, [w, h, d], COLLIDER_BOX_BUDGET);
      const body = new CANNON.Body({ type: CANNON.Body.STATIC, material: this.physicsMaterial });
      for (let i = 0; i < count; i++) {
        const o = i * 6;
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(
            boxes[o + 3] * this.scale, boxes[o + 4] * this.scale, boxes[o + 5] * this.scale)),
          new CANNON.Vec3(
            (x0 + boxes[o] - this.cx) * this.scale,
            (y0 + boxes[o + 1]) * this.scale,
            (z0 + boxes[o + 2] - this.cz) * this.scale));
      }
      body.position.set(px.x, px.y, px.z);
      body.quaternion.setFromEuler(0, ry, 0);
      // Respect the streaming state: a chunk rebuilt while this structure is streamed out
      // must stay out, or carving something distant would quietly resurrect it.
      if (this.colliderActive ?? true) this.physicsWorld.addBody(body);
      this.colliderBodies.set(key, body);
    }
    this.colliderDirtyChunks.clear();
  }


  /** Is the voxel containing this world-space point solid? (enemy steering probes) */
  solidAtWorld(point) {
    const local = point.clone().applyMatrix4(this.inverseMatrix);
    return this.at(Math.floor(local.x + this.cx), Math.floor(local.y), Math.floor(local.z + this.cz)) !== 0;
  }

  /** World-space center of one voxel — where a detached cluster's debris spawns. */
  voxelWorldCenter(x, y, z) {
    return new THREE.Vector3(x + 0.5 - this.cx, y + 0.5, z + 0.5 - this.cz)
      .applyMatrix4(this.group.matrixWorld);
  }

  dispose() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    this.chunkData.clear();
    this.material.dispose();
    this.scene.remove(this.group);
    // Per-chunk collider bodies, not the single `this.body` that used to exist. Removing
    // a property that is now always undefined silently leaked every one of them.
    for (const body of this.colliderBodies.values()) this.physicsWorld.removeBody(body);
    this.colliderBodies.clear();
  }
}
