// terrain.js — fine-grained, DIGGABLE block terrain for the arena (seeded).
//
// 0.1-unit voxels on a 1800×1800 column grid (20× the detail of the original 2-unit
// blocks). At this density a naive face-per-block mesh is ~20M triangles, so each chunk
// is GREEDY-MESHED: same-height, same-tint top areas merge into single quads and cliff
// walls merge into runs — flat meadows cost almost nothing, and only the contour edges
// spend triangles. Color jitter is quantized to coarse patches for the same reason.
//
// Collision stays a cannon-es Heightfield sampled at a 20-cell stride (2-unit elements,
// height = MAX of the covered columns) — debris does not need 0.1-unit fidelity, and a
// 1800² heightfield would be megabytes of pillar cache.
//
// Weapons dig it: dig() drops columns inside a carve sphere, dug ground exposes dirt
// (top metre) then stone, and only touched chunks re-mesh. Gameplay reads the surface
// through heightAt() / raycast().

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createVoxelMaterial } from './materials.js';

// Declared here (not world.js) so this module has no import back into world.js — world.js
// imports Terrain, and a top-level back-reference would hit the TDZ mid-evaluation.
export const ARENA_HALF = 90; // playable square is [-ARENA_HALF, ARENA_HALF] on X/Z

// Voxel size halved (0.2 → 0.1): every constant below that is expressed in CELLS rather
// than world units doubles with it, so the arena, hill height, chunk size, dirt band,
// physics element size and wall thickness all keep their world-space dimensions and only
// the granularity changes. Do not tune one of these without its partner.
const BLOCK = 0.1;               // world units per voxel (cube side)
const MAX_LEVEL = 100;           // tallest hill = 10 world units, in 0.1 steps
const CELLS = Math.round((ARENA_HALF * 2) / BLOCK); // 1800 → 1800×1800 columns
const CHUNK_CELLS = 120;         // 12×12 world units per chunk → 15×15 chunks
const CHUNKS = Math.ceil(CELLS / CHUNK_CELLS);
const DIRT_BAND = 10;            // levels of dirt (1 unit) before digging hits stone
// Heightfield resolution, in columns per physics element. The terrain model IS a
// heightmap by construction -- dig() only ever LOWERS a column's top, so it can never
// produce an overhang and a heightfield is the exactly-right collider for it. The only
// error was resolution: at a 20-column stride the collision surface was 2 m blocky over
// 0.1 m voxels, and it took the MAXIMUM of each cell, so debris rested up to two metres
// above the real ground and a crater you had just dug did not exist to physics at all.
// 4 columns is 0.4 m, a 5x refinement, and the sample is the exact column height rather
// than a max.
// MEASURED: 4 (0.4 m elements) cost ~12 ms of every physics step, because cannon builds a
// convex prism per heightfield cell a body overlaps and a 2 m chunk of debris overlaps 25
// of them. 10 gives 1 m elements — still twice as fine as the 2 m this started at, and
// well inside the 0.25 m voxels anything actually stands on.
const PHYS_STRIDE = 10;
const PHYS_N = CELLS / PHYS_STRIDE;

const GRASS = new THREE.Color(0x4c8f46);
const DIRT = new THREE.Color(0x6d5138);
const STONE = new THREE.Color(0x63656b);
const SHADES = 8;                // quantized jitter steps (coarse patches share a shade)
// Shade patches are keyed off (i >> SHADE_SHIFT). 6 keeps the 6.4-world-unit patch the
// 0.2 grid had; leaving it at 5 would halve the patch and re-introduce the per-cell
// noise the quantization exists to remove.
const SHADE_SHIFT = 6;

// Terrain level of detail: columns merged per rendered quad, by distance in metres. The
// ground is greedy-meshed already, but at 0.1 m columns its contour risers alone were
// ~930 k triangles — most of them steps a few centimetres tall, a hundred metres away.
// Physics never sees this: the heightfield collider is always built from the real column
// grid, so LOD changes the picture and not where anything stands.
const TERRAIN_LOD_BANDS = [
  { near: 0, step: 1 },
  { near: 40, step: 4 },
  { near: 90, step: 12 },
];
const TERRAIN_LOD_HYSTERESIS_M = 8;

// Chunks per merged mesh, per axis. Chunks stay small so a dig re-meshes 12 m of ground
// and not the whole map, but they are DRAWN in groups: 225 chunk meshes was 225 draw
// calls a frame, and this makes it 25. Re-merging a group is a memcpy over vertex data
// that is already built, which is nothing next to re-meshing it.
const GROUP_CHUNKS = 3;
const GROUPS = Math.ceil(CHUNKS / GROUP_CHUNKS);

// Perimeter wall: a stone ring around the arena so the player and enemies stay
// inside. Thickness is in cells (BLOCK units). Height is in world units so it reads
// as a fortress wall against the 10-unit-tall terrain. Greedy merge keeps the inner
// and outer faces as 2 large quads per edge regardless of height.
export const WALL_THICKNESS = 4; // cells; 4 × 0.1 = 0.4 world units
export const WALL_HEIGHT = 15;    // world units; 75 cells

export class Terrain {
  constructor(seed) {
    this.seed = seed >>> 0;
    // Int16, not Int8: at BLOCK = 0.1 the perimeter wall is WALL_HEIGHT / BLOCK = 150
    // levels, which overflows Int8Array's 127 and wraps the wall to a trench.
    this.levels = new Int16Array(CELLS * CELLS);
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        // Same world-space wavelengths as the coarse terrain (32u hills + 11u detail).
        // Divisors doubled with CELLS so the hills keep the same 32u / 11u world-space
        // wavelengths instead of shrinking to half-size bumps.
        const n = 0.7 * valueNoise(i / 320, j / 320, this.seed)
          + 0.3 * valueNoise(i / 110, j / 110, this.seed ^ 0x9e3779b9);
        this.levels[i + j * CELLS] = Math.min(MAX_LEVEL, Math.max(0, Math.round(n * (MAX_LEVEL + 20) - 5)));
      }
    }
    // Frozen pre-dig snapshot: original surface keeps grass; dug ground exposes dirt,
    // then stone — the contrast that makes craters read as craters.
    this.originalLevels = null;

    this.group = null;
    this.chunkData = new Map();         // "ci,cj" -> { positions, normals, colors } | null
    this.groupMeshes = new Map();       // "gi,gj" -> Mesh
    this.dirtyGroups = new Set();
    this.dirtyChunks = new Set();       // dig-driven: rebuilt promptly
    this.lodDirtyChunks = new Set();    // distance-driven: rebuilt on a budget
    this.chunkLod = new Map();          // "ci,cj" -> step
    this.material = null;
    this.body = null;
    this.colliderDirty = false;
    this.scene = null;
    this.physicsWorld = null;
  }

  _cell(x, z) {
    const i = Math.min(CELLS - 1, Math.max(0, Math.floor((x + ARENA_HALF) / BLOCK)));
    const j = Math.min(CELLS - 1, Math.max(0, Math.floor((z + ARENA_HALF) / BLOCK)));
    return [i, j];
  }

  /** Exact stepped surface height (world y) under a world x/z. */
  heightAt(x, z) {
    const [i, j] = this._cell(x, z);
    return this.levels[i + j * CELLS] * BLOCK;
  }

  /**
   * Raise the 4 edge strips of the arena to WALL_HEIGHT, in cell space. Snapshots
   * `originalLevels` to the same value so the wall surface tints as stone, not grass,
   * and digging it reads as excavating stone rather than revealing dirt underneath.
   * Marks every border chunk dirty so the next rebuildDirty picks it up.
   */
  buildPerimeterWall() {
    const wallCells = Math.max(1, Math.round(WALL_HEIGHT / BLOCK));
    const W = WALL_THICKNESS;
    const last = CELLS - 1;
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < W; i++) {
        this.levels[i + j * CELLS] = wallCells;
        this.levels[(last - i) + j * CELLS] = wallCells;
      }
    }
    for (let i = 0; i < CELLS; i++) {
      for (let j = 0; j < W; j++) {
        this.levels[i + j * CELLS] = wallCells;
        this.levels[i + (last - j) * CELLS] = wallCells;
      }
    }
    // Baseline must match the wall or the first dig would expose "dirt" on day one.
    if (!this.originalLevels) this.originalLevels = new Int16Array(this.levels);
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < W; i++) {
        this.originalLevels[i + j * CELLS] = wallCells;
        this.originalLevels[(last - i) + j * CELLS] = wallCells;
      }
    }
    for (let i = 0; i < CELLS; i++) {
      for (let j = 0; j < W; j++) {
        this.originalLevels[i + j * CELLS] = wallCells;
        this.originalLevels[i + (last - j) * CELLS] = wallCells;
      }
    }
    // Every chunk that touches the perimeter (4 strips of chunks) is dirty.
    for (let ci = 0; ci < CHUNKS; ci++) {
      this.dirtyChunks.add(`${ci},0`);
      this.dirtyChunks.add(`${ci},${CHUNKS - 1}`);
    }
    for (let cj = 0; cj < CHUNKS; cj++) {
      this.dirtyChunks.add(`0,${cj}`);
      this.dirtyChunks.add(`${CHUNKS - 1},${cj}`);
    }
    this.colliderDirty = true;
  }

  /**
   * Flatten a disc to the level at its center — the build pad under a structure (and
   * the player spawn). Must run BEFORE build(); pads still count as "original" ground.
   */
  flatten(x, z, radius) {
    const [ci, cj] = this._cell(x, z);
    const level = this.levels[ci + cj * CELLS];
    const r = Math.ceil(radius / BLOCK);
    for (let j = Math.max(0, cj - r); j <= Math.min(CELLS - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(CELLS - 1, ci + r); i++) {
        if ((i - ci) * (i - ci) + (j - cj) * (j - cj) <= r * r) {
          this.levels[i + j * CELLS] = level;
        }
      }
    }
    return level * BLOCK;
  }

  // ── Digging ────────────────────────────────────────────────────────────

  /**
   * Carve a sphere out of the ground: every column whose surface the sphere reaches
   * drops to the sphere's lower boundary. Returns the number of voxels removed.
   */
  dig(point, radius) {
    const [ci, cj] = this._cell(point.x, point.z);
    const r = Math.ceil(radius / BLOCK) + 1;
    let removed = 0;

    for (let j = Math.max(0, cj - r); j <= Math.min(CELLS - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(CELLS - 1, ci + r); i++) {
        const cx = -ARENA_HALF + (i + 0.5) * BLOCK;
        const cz = -ARENA_HALF + (j + 0.5) * BLOCK;
        const d2 = (cx - point.x) ** 2 + (cz - point.z) ** 2;
        if (d2 > radius * radius) continue;

        const drop = Math.sqrt(radius * radius - d2);
        const level = this.levels[i + j * CELLS];
        if (point.y - drop >= level * BLOCK) continue; // sphere never reaches this column
        const newLevel = Math.max(0, Math.min(level, Math.floor((point.y - drop) / BLOCK + 0.02)));
        if (newLevel >= level) continue;

        removed += level - newLevel;
        this.levels[i + j * CELLS] = newLevel;
        this._markDirty(i, j);
      }
    }
    if (removed > 0) {
      this.colliderDirty = true;
      this._markPhysDirty(
        Math.max(0, ci - r), Math.max(0, cj - r),
        Math.min(CELLS - 1, ci + r), Math.min(CELLS - 1, cj + r));
    }
    return removed;
  }

  /** Ray-marched surface hit. @returns {{distance:number, point:THREE.Vector3}|null} */
  raycast(origin, direction, maxDistance) {
    const step = 0.35;
    const p = origin.clone();
    for (let t = step; t <= maxDistance; t += step) {
      p.copy(origin).addScaledVector(direction, t);
      if (Math.abs(p.x) > ARENA_HALF + 4 || Math.abs(p.z) > ARENA_HALF + 4) continue;
      if (p.y <= this.heightAt(p.x, p.z)) {
        let lo = t - step, hi = t;
        for (let n = 0; n < 5; n++) {
          const mid = (lo + hi) / 2;
          p.copy(origin).addScaledVector(direction, mid);
          if (p.y <= this.heightAt(p.x, p.z)) hi = mid; else lo = mid;
        }
        p.copy(origin).addScaledVector(direction, hi);
        return { distance: hi, point: p.clone() };
      }
    }
    return null;
  }

  // ── Meshes (chunked + greedy) + collider ───────────────────────────────

  build(scene, physicsWorld, physicsMaterial = undefined) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.physicsMaterial = physicsMaterial;
    this.originalLevels = new Int16Array(this.levels); // grass baseline, frozen post-pads
    this.material = createVoxelMaterial();
    this.group = new THREE.Group();
    scene.add(this.group);

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        this.dirtyChunks.add(`${ci},${cj}`);
      }
    }
    this.rebuildDirty();

    this.colliderDirty = true;
    this.rebuildCollider();
  }

  _markDirty(i, j) {
    const ci = Math.floor(i / CHUNK_CELLS), cj = Math.floor(j / CHUNK_CELLS);
    this.dirtyChunks.add(`${ci},${cj}`);
    // A border dig changes the neighbour chunk's exposed walls too.
    if (i % CHUNK_CELLS === 0) this.dirtyChunks.add(`${ci - 1},${cj}`);
    if (i % CHUNK_CELLS === CHUNK_CELLS - 1) this.dirtyChunks.add(`${ci + 1},${cj}`);
    if (j % CHUNK_CELLS === 0) this.dirtyChunks.add(`${ci},${cj - 1}`);
    if (j % CHUNK_CELLS === CHUNK_CELLS - 1) this.dirtyChunks.add(`${ci},${cj + 1}`);
  }

  /**
   * @param budget LOD-driven chunks to re-mesh this call. Dig-driven chunks ignore it —
   *   a crater has to appear on the frame you dug it.
   */
  rebuildDirty(budget = Infinity) {
    for (const key of this.dirtyChunks) this._meshChunk(key);
    this.dirtyChunks.clear();

    let spent = 0;
    for (const key of this.lodDirtyChunks) {
      if (spent >= budget) break;
      this._meshChunk(key);
      this.lodDirtyChunks.delete(key);
      spent++;
    }
    for (const key of this.dirtyGroups) this._mergeGroup(key);
    this.dirtyGroups.clear();
    return spent;
  }

  _meshChunk(key) {
    const [ci, cj] = key.split(',').map(Number);
    if (ci < 0 || cj < 0 || ci >= CHUNKS || cj >= CHUNKS) return;
    const step = this.chunkLod.get(key) ?? 1;
    this.chunkData.set(key, this._buildChunkGeometry(ci * CHUNK_CELLS, cj * CHUNK_CELLS, step));
    this.dirtyGroups.add(
      `${Math.floor(ci / GROUP_CHUNKS)},${Math.floor(cj / GROUP_CHUNKS)}`);
  }

  /** Concatenate a group's chunk vertex data into the one mesh that group draws. */
  _mergeGroup(key) {
    const [gi, gj] = key.split(',').map(Number);
    let total = 0;
    const parts = [];
    for (let cj = gj * GROUP_CHUNKS; cj < Math.min(CHUNKS, (gj + 1) * GROUP_CHUNKS); cj++) {
      for (let ci = gi * GROUP_CHUNKS; ci < Math.min(CHUNKS, (gi + 1) * GROUP_CHUNKS); ci++) {
        const data = this.chunkData.get(`${ci},${cj}`);
        if (data) { parts.push(data); total += data.positions.length; }
      }
    }
    const old = this.groupMeshes.get(key);
    if (old) { this.group.remove(old); old.geometry.dispose(); this.groupMeshes.delete(key); }
    if (total === 0) return;

    const positions = new Float32Array(total);
    const normals = new Float32Array(total);
    const colors = new Float32Array(total);
    let at = 0;
    for (const d of parts) {
      positions.set(d.positions, at);
      normals.set(d.normals, at);
      colors.set(d.colors, at);
      at += d.positions.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geometry, this.material);
    // Ground receives building/debris shadows; casting from 810k m² of terrain would
    // only cost shadow-map fill for self-shadowing the height steps barely show.
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.groupMeshes.set(key, mesh);
  }

  /** Assign an LOD band per chunk from the camera position; queue changes for re-mesh. */
  updateLod(cameraPosition) {
    const half = CHUNK_CELLS * BLOCK * 0.5;
    for (let cj = 0; cj < CHUNKS; cj++) {
      const cz = -ARENA_HALF + cj * CHUNK_CELLS * BLOCK + half;
      for (let ci = 0; ci < CHUNKS; ci++) {
        const cx = -ARENA_HALF + ci * CHUNK_CELLS * BLOCK + half;
        const key = `${ci},${cj}`;
        const current = this.chunkLod.get(key) ?? 1;
        const d = Math.hypot(cameraPosition.x - cx, cameraPosition.z - cz);
        let step = current;
        for (let b = TERRAIN_LOD_BANDS.length - 1; b >= 0; b--) {
          const bias = TERRAIN_LOD_BANDS[b].step > current
            ? TERRAIN_LOD_HYSTERESIS_M : -TERRAIN_LOD_HYSTERESIS_M;
          if (d >= TERRAIN_LOD_BANDS[b].near + bias) { step = TERRAIN_LOD_BANDS[b].step; break; }
        }
        if (step !== current) {
          this.chunkLod.set(key, step);
          this.lodDirtyChunks.add(key);
        }
      }
    }
  }

  /**
   * Build or refresh the heightfield collider.
   *
   * A full rebuild is 451² samples; digging happens seven times a second while the
   * trigger is held, so after the first build only the dug rectangle is re-sampled and
   * the cached pillar geometry for those cells is dropped. Cost then scales with the size
   * of the crater instead of the size of the map.
   */
  rebuildCollider() {
    if (!this.colliderDirty || !this.physicsWorld) return;
    this.colliderDirty = false;

    if (!this.body) {
      const data = [];
      for (let i = 0; i <= PHYS_N; i++) {
        const column = new Array(PHYS_N + 1);
        for (let j = 0; j <= PHYS_N; j++) column[j] = this._physSample(i, j);
        data.push(column);
      }
      this.physData = data;
      this.physShape = new CANNON.Heightfield(data, { elementSize: PHYS_STRIDE * BLOCK });
      this.body = new CANNON.Body({ type: CANNON.Body.STATIC, material: this.physicsMaterial });
      this.body.addShape(this.physShape);
      this.body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      this.body.position.set(-ARENA_HALF, 0, ARENA_HALF);
      this.physicsWorld.addBody(this.body);
      this.physDirty = null;
      return;
    }

    const d = this.physDirty;
    if (!d) return;
    this.physDirty = null;
    for (let i = d.i0; i <= d.i1; i++) {
      const column = this.physData[i];
      for (let j = d.j0; j <= d.j1; j++) column[j] = this._physSample(i, j);
    }
    // cannon caches the two triangle prisms it builds per cell; a changed height makes
    // every cached pillar in the region stale. Dropping the whole cache is one object
    // assignment and the cells rebuild lazily on next contact.
    this.physShape.updateMinValue();
    this.physShape.updateMaxValue();
    // `_cachedPillars` is cannon's per-cell prism cache and is the only thing that goes
    // stale when a height changes. `pillarConvex` / `pillarOffset` are scratch that cannon
    // rebuilds on every cache miss -- replacing those was pointless and, with an empty
    // ConvexPolyhedron, a good way to hand the narrowphase geometry with no faces.
    this.physShape._cachedPillars = {};
  }

  /**
   * Height at heightfield vertex (i, j). Vertex (i,j) sits on the column grid directly —
   * at a 4-column stride the vertex spacing is 0.4 m, so a plain sample of the nearest
   * column is both exact enough and 16x cheaper than the max-over-cell the coarse
   * heightfield needed to avoid sinking debris into stair edges.
   */
  _physSample(i, j) {
    const fi = Math.min(CELLS - 1, i * PHYS_STRIDE);
    const fj = Math.min(CELLS - 1, Math.max(0, CELLS - 1 - j * PHYS_STRIDE));
    return this.levels[fi + fj * CELLS] * BLOCK;
  }

  /** Union the dug cell rectangle into the pending heightfield refresh. */
  _markPhysDirty(i0, j0, i1, j1) {
    const a = Math.max(0, Math.floor(i0 / PHYS_STRIDE) - 1);
    const b = Math.min(PHYS_N, Math.ceil(i1 / PHYS_STRIDE) + 1);
    // The heightfield's j axis runs opposite the column grid's (see _physSample).
    const c = Math.max(0, Math.floor((CELLS - 1 - j1) / PHYS_STRIDE) - 1);
    const e = Math.min(PHYS_N, Math.ceil((CELLS - 1 - j0) / PHYS_STRIDE) + 1);
    if (!this.physDirty) this.physDirty = { i0: a, i1: b, j0: c, j1: e };
    else {
      const d = this.physDirty;
      d.i0 = Math.min(d.i0, a); d.i1 = Math.max(d.i1, b);
      d.j0 = Math.min(d.j0, c); d.j1 = Math.max(d.j1, e);
    }
  }

  /** Top-face merge key: level + dug-material bucket + quantized shade patch. */
  _topKey(i, j) {
    const idx = i + j * CELLS;
    const level = this.levels[idx];
    const dug = this.originalLevels[idx] - level;
    const bucket = dug <= 0 ? 0 : dug <= DIRT_BAND ? 1 : 2;
    const shade = Math.floor(hash(i >> SHADE_SHIFT, j >> SHADE_SHIFT, this.seed ^ 0x51ed2701) * SHADES);
    return (level * 3 + bucket) * SHADES + shade;
  }

  _topColor(i, j, tint) {
    const idx = i + j * CELLS;
    const dug = this.originalLevels[idx] - this.levels[idx];
    const shade = Math.floor(hash(i >> SHADE_SHIFT, j >> SHADE_SHIFT, this.seed ^ 0x51ed2701) * SHADES);
    tint.copy(dug <= 0 ? GRASS : dug <= DIRT_BAND ? DIRT : STONE)
      .multiplyScalar(0.92 + (shade / SHADES) * 0.16);
  }

  /**
   * @param step LOD stride in columns. Everything below works in COARSE indices — the
   *   helpers convert — so the greedy merge and the wall-run code are identical at every
   *   level of detail and there is only one mesher to keep correct.
   */
  _buildChunkGeometry(i0, j0, step = 1) {
    const st = Math.max(1, step | 0);
    const i0c = Math.floor(i0 / st);
    const j0c = Math.floor(j0 / st);
    const w = Math.ceil(Math.min(CHUNK_CELLS, CELLS - i0) / st);
    const h = Math.ceil(Math.min(CHUNK_CELLS, CELLS - j0) / st);
    const positions = [], normals = [], colors = [];

    // Coarse column height = MAX of the block. Taking the max keeps a decimated hill
    // standing slightly proud of the real one; taking the average or the min would sink
    // ridge lines below the collider and open gaps you can see under.
    const levelOf = (ci, cj) => {
      const fi0 = ci * st, fj0 = cj * st;
      if (fi0 < 0 || fj0 < 0 || fi0 >= CELLS || fj0 >= CELLS) return 0;
      if (st === 1) return this.levels[fi0 + fj0 * CELLS];
      let best = 0;
      const fi1 = Math.min(CELLS, fi0 + st), fj1 = Math.min(CELLS, fj0 + st);
      for (let fj = fj0; fj < fj1; fj++) {
        const row = fj * CELLS;
        for (let fi = fi0; fi < fi1; fi++) {
          const v = this.levels[fi + row];
          if (v > best) best = v;
        }
      }
      return best;
    };
    const wx = (ci) => -ARENA_HALF + ci * st * BLOCK;
    const wz = (cj) => -ARENA_HALF + cj * st * BLOCK;
    // Colour and dug-material bucket come from the block's first column; the level comes
    // from the block max, so the key stays consistent with the geometry it describes.
    const topKeyC = (ci, cj) => {
      const fi = Math.min(CELLS - 1, ci * st), fj = Math.min(CELLS - 1, cj * st);
      const idx = fi + fj * CELLS;
      const dug = this.originalLevels[idx] - this.levels[idx];
      const bucket = dug <= 0 ? 0 : dug <= DIRT_BAND ? 1 : 2;
      const shade = Math.floor(hash(fi >> SHADE_SHIFT, fj >> SHADE_SHIFT, this.seed ^ 0x51ed2701) * SHADES);
      return (levelOf(ci, cj) * 3 + bucket) * SHADES + shade;
    };
    const topColorC = (ci, cj, out) =>
      this._topColor(Math.min(CELLS - 1, ci * st), Math.min(CELLS - 1, cj * st), out);

    const quad = (corners, normal, color) => {
      for (const c of [0, 1, 2, 0, 2, 3]) {
        positions.push(corners[c][0], corners[c][1], corners[c][2]);
        normals.push(normal[0], normal[1], normal[2]);
        colors.push(color.r, color.g, color.b);
      }
    };
    const tint = new THREE.Color();

    // ── Tops: 2D greedy merge over (level, material, shade) ──────────────
    const keys = new Int32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        keys[i + j * w] = topKeyC(i0c + i, j0c + j);
      }
    }
    const done = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (done[i + j * w]) continue;
        const key = keys[i + j * w];
        let rw = 1;
        while (i + rw < w && !done[i + rw + j * w] && keys[i + rw + j * w] === key) rw++;
        let rh = 1;
        expand: while (j + rh < h) {
          for (let k = 0; k < rw; k++) {
            if (done[i + k + (j + rh) * w] || keys[i + k + (j + rh) * w] !== key) break expand;
          }
          rh++;
        }
        for (let jj = 0; jj < rh; jj++) for (let ii = 0; ii < rw; ii++) done[i + ii + (jj + j) * w] = 1;

        const y = levelOf(i0c + i, j0c + j) * BLOCK;
        topColorC(i0c + i, j0c + j, tint);
        const x0 = wx(i0c + i), x1 = wx(i0c + i + rw), z0 = wz(j0c + j), z1 = wz(j0c + j + rh);
        quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], tint);
      }
    }

    // ── Walls: run-merged along their axis; dirt band on top, stone below ─
    // Winding pairs (c0, c1) verified CCW-from-outside per direction.
    const wall = (loLevel, hiLevel, c0, c1, normal) => {
      const dirtLo = Math.max(loLevel, hiLevel - DIRT_BAND);
      if (dirtLo > loLevel) {
        tint.copy(STONE);
        quad([
          [c0[0], loLevel * BLOCK, c0[1]], [c1[0], loLevel * BLOCK, c1[1]],
          [c1[0], dirtLo * BLOCK, c1[1]], [c0[0], dirtLo * BLOCK, c0[1]],
        ], normal, tint);
      }
      tint.copy(DIRT);
      quad([
        [c0[0], dirtLo * BLOCK, c0[1]], [c1[0], dirtLo * BLOCK, c1[1]],
        [c1[0], hiLevel * BLOCK, c1[1]], [c0[0], hiLevel * BLOCK, c0[1]],
      ], normal, tint);
    };

    // X-facing walls: boundary owned by the higher cell inside this chunk; runs along j.
    for (let i = 0; i < w; i++) {
      const gi = i0c + i;
      for (const side of [1, -1]) {
        let j = 0;
        while (j < h) {
          const L = levelOf(gi, j0c + j), N = levelOf(gi + side, j0c + j);
          if (L <= N) { j++; continue; }
          let run = 1;
          while (j + run < h
            && levelOf(gi, j0c + j + run) === L
            && levelOf(gi + side, j0c + j + run) === N) run++;
          const xB = side === 1 ? wx(gi + 1) : wx(gi);
          const za = wz(j0c + j), zb = wz(j0c + j + run);
          if (side === 1) wall(N, L, [xB, zb], [xB, za], [1, 0, 0]);
          else wall(N, L, [xB, za], [xB, zb], [-1, 0, 0]);
          j += run;
        }
      }
    }
    // Z-facing walls: runs along i.
    for (let j = 0; j < h; j++) {
      const gj = j0c + j;
      for (const side of [1, -1]) {
        let i = 0;
        while (i < w) {
          const L = levelOf(i0c + i, gj), N = levelOf(i0c + i, gj + side);
          if (L <= N) { i++; continue; }
          let run = 1;
          while (i + run < w
            && levelOf(i0c + i + run, gj) === L
            && levelOf(i0c + i + run, gj + side) === N) run++;
          const zB = side === 1 ? wz(gj + 1) : wz(gj);
          const xa = wx(i0c + i), xb = wx(i0c + i + run);
          if (side === 1) wall(N, L, [xa, zB], [xb, zB], [0, 0, 1]);
          else wall(N, L, [xb, zB], [xa, zB], [0, 0, -1]);
          i += run;
        }
      }
    }

    if (positions.length === 0) return null;
    return { positions, normals, colors };
  }

  dispose(scene, physicsWorld) {
    for (const mesh of this.groupMeshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.groupMeshes.clear();
    this.chunkData.clear();
    this.material?.dispose();
    if (this.group) scene.remove(this.group);
    if (this.body) physicsWorld.removeBody(this.body);
  }
}

// ── Seeded value noise ─────────────────────────────────────────────────────

function hash(ix, iz, seed) {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263 + (seed | 0) * 974634721;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx); // smoothstep
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
