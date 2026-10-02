// track-glb.js — the shared builder for every AUTHORED (GLB) marble course.
//
// This module is a FACTORY, not a course. createGlbCourse() is handed one course's baked data —
// its centerline (track*-path.js), its collision shell (track*-collision.js) and its model URL —
// and returns that course's { loadModel, buildTrack }. maps.js instantiates one per slot.
//
// WHY A FACTORY. It began as a single hard-wired module for marble_track.glb, importing the two
// generated files at module scope. Adding a second course that way means copying ~650 lines of
// tuned physics-adjacent logic, and the notes below are exactly the kind of hard-won detail that
// rots the moment there are two copies of it. Everything course-specific now arrives as an
// argument; everything below is machinery both courses share.
//
// WHAT REPLACED WHAT. The first version of this file generated a procedural descending chute
// whose entire contract was "progress = +Z": every system keyed off a single world coordinate.
// An authored course descends in -Y along a winding XZ path and BRANCHES, so that scalar is
// meaningless. Progress is ARCLENGTH along a baked centerline (produced offline by
// scripts/bake-marble-track.mjs) and every accessor below is keyed on `s` — world units along
// that line, 0 at the start gate — instead of on z.
//
// WHAT YOU SEE IS NOT WHAT YOU HIT. The rendered scene is the GLB exactly as authored, every
// triangle of it. Collision is built from up to three different sources, and the split is
// deliberate — see chunkedTrimeshes for the measurements that forced it:
//   * The swept channels collide against a BAKED shell: the reachable surface only — floor top
//     and wall inner faces — decimated along the sweep. Roughly 5.3x fewer triangles than the
//     visual mesh on both courses, with no change to any surface a marble can actually touch.
//   * A course may name ONE funnel mesh (`bowlMeshName`) that has no ring structure to loft from,
//     so it collides against its own geometry with the downward-facing half culled. Spiral Works
//     uses this for Track-Bowl; Grand Spiral has no such mesh and passes null.
//   * The Obs-* props become PRIMITIVES (cylinder pegs, box gates, crossed-box paddles).
//     Primitives are cheaper, they give clean pinball-style deflection instead of triangle-edge
//     snagging, and the paddles have to be driven bodies anyway — a moving trimesh is not a
//     reliable collider in cannon-es.
// Anything rendered but neither a swept channel nor the named funnel gets NO collider. Spiral
// Works' Track-Bumper is the case that matters: a free-standing decorative rim encircling open
// space beyond the finish, where a collider bought nothing and cost the broadphase a 274-unit
// AABB parked over the end of the course.
// Everything static is split into CHUNK-sized bodies rather than one body per segment, so the
// broadphase can reject on a tight AABB.
//
// NON-TRAPPING. The old chute could promise a marble was never stuck, because it was strictly
// descending and friction was held below tan(slope) everywhere. That property belongs to the
// COURSE, not to this file, and the two authored courses differ on it:
//   * Spiral Works does NOT have it — Track-LowerA and Track-LowerB each contain a real uphill
//     hump (the near-vertical banked loops) which a stalled marble cannot climb. What is still
//     guaranteed there is that no DESCENDING stretch traps.
//   * Grand Spiral does have it: it never rises, and its shallowest local slope is 0.15 against
//     the 0.09 friction coefficient.
// Anything that stops dead is caught by game.js's RACE_TIMEOUT failsafe, not by geometry. Re-run
// the baker for the per-segment slope table — it flags any segment that has fallen below
// friction.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Draco-compressed courses (the Playground Run export) need a decoder; it is fetched only when a
// compressed primitive is actually met, so the uncompressed courses never download it.
let _draco = null;
function gltfLoader() {
  const loader = new GLTFLoader();
  _draco = _draco || new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/');
  return loader.setDRACOLoader(_draco);
}

/**
 * Lane shells synthesized from a baked cross-section table, for a course whose model is a plain
 * trimesh with no ring-major channel layout (the Playground Run export). PATH.RINGS carries eight
 * numbers per sample in that sample's frame — (lateral, height) of the left rim, left floor edge,
 * right floor edge and right rim — so each sample becomes one 4-vertex ring in the authored
 * shells' layout, and LANES, CONTAIN and the collider below treat it exactly like one.
 *
 * The shell IS the collider for the gutter. The export's own collision mesh is the finely
 * tessellated visual gutter, and cannon-es bled a lone marble from ~100 u/s to 30 on it rolling
 * over internal edges (the export's Rapier demo needed FIX_INTERNAL_EDGES for the same reason).
 */
function ringShell(PATH, lanes) {
  const { POINTS: P, RIGHTS: R, UPS: U, RINGS } = PATH;
  const verts = [], indices = [], SEGMENTS = [], COLSEG = [];
  const at = (i, lat, h) => [0, 1, 2].map((k) => P[i * 3 + k] + R[i * 3 + k] * lat + U[i * 3 + k] * h);
  for (const { name, from, to, collide, kerb } of lanes) {
    const base = verts.length / 12;   // rings so far
    for (let i = from; i <= to; i++) {
      const [aL, aH, bL, bH, cL, cH, dL, dH] = RINGS.subarray(i * 8, i * 8 + 8);
      verts.push(...at(i, aL, aH), ...at(i, bL, bH), ...at(i, cL, cH), ...at(i, dL, dH));
    }
    // Rim–floor, floor, floor–rim strips between consecutive rings, as the baked shells index them.
    // A lane over authored geometry that already collides (the slide) is containment only.
    if (collide) {
      for (let r = 0; r < to - from; r++) {
        for (let k = 0; k < 3; k++) {
          const a = (base + r) * 4 + k;
          indices.push(a, a + 5, a + 4, a, a + 1, a + 5);
        }
      }
    }
    SEGMENTS.push({ name, from, to });
    COLSEG.push({ name, kept: to - from + 1, kerb });
  }
  const none = Uint32Array.from([]);
  return {
    PATH: { ...PATH, SEGMENTS },
    COL: { VERTICES: Float32Array.from(verts), INDICES: Uint32Array.from(indices), RUMBLE_INDICES: none, BUMP_INDICES: none, ICE_INDICES: none, SEGMENTS: COLSEG },
  };
}

/**
 * Re-pose the drawn channel onto its ring shell, for a course whose shell is NOT the
 * model's own surface. Playground Run's shell is a smoothed fit (see ringShell): its floor sat up
 * to 2.7 units off the floor the model draws and up to 59° off its bank, so marbles rolled sunk to
 * the centre in the drawn floor on some stretches and floated over it on others. The shell is the
 * one the map is certified on. Laying it on the drawn gutter instead makes the field pool
 * single file in the low corner of the authored 35-52° banks (median finish 93 s -> 123 s, slowest
 * 163 s against the 180 s timeout, four times the unstick nudges). So the DRAWING moves, and the
 * race is the same race: each vertex of `nodes` within reach of the gutter is carried by the 2D map
 * that takes the drawn section (PATH.DRAWN) to the ring at its sample, blended between the two
 * samples it lies between. Floor centre lands on floor centre, floor line on floor line.
 *
 * Where the ring's floor is wider than a marble can use of the drawn one, the section is widened
 * with it (WIDEN): the drawn floor curves up into its walls from ±3.2, and a marble against a ring
 * wall 5.2 out stood 0.3 deep in that curve.
 *
 * Runs once on the cached model, in the model's own units. Nothing here touches a collider.
 */
function conformToShell(scene, PATH, nodes) {
  const { POINTS: P, DIRS: D, RIGHTS: R, UPS: U, RINGS, DRAWN, SCALE } = PATH;
  const REACH = 14 / SCALE;      // the section's far rim corner is 9.3 units from its floor centre
  const USABLE = 4.2 / SCALE;    // widest ring floor a marble can ride without meeting the drawn curve
  const WIDEN = 1.25;
  const n = DRAWN.length / 3;
  const centre = new Float32Array(n * 3), map = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const lat = DRAWN[i * 3], h = DRAWN[i * 3 + 1], c = Math.cos(DRAWN[i * 3 + 2]), s = Math.sin(DRAWN[i * 3 + 2]);
    for (let k = 0; k < 3; k++) centre[i * 3 + k] = P[i * 3 + k] + R[i * 3 + k] * lat + U[i * 3 + k] * h;
    const bl = RINGS[i * 8 + 2], bh = RINGS[i * 8 + 3], cl = RINGS[i * 8 + 4], ch = RINGS[i * 8 + 5];
    const hw = Math.hypot(cl - bl, ch - bh) / 2, tx = (cl - bl) / (2 * hw), ty = (ch - bh) / (2 * hw);
    const w = Math.min(WIDEN, Math.max(1, hw / USABLE));
    // (x, y) from the drawn floor centre -> ring frame: floor centre, then across (widened) and up.
    map.set([(bl + cl) / 2, (bh + ch) / 2, w * c * tx + s * ty, w * s * tx - c * ty, w * c * ty - s * tx, w * s * ty + c * tx], i * 6);
  }
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), inv = new THREE.Matrix4();
  const dot = (arr, i, x, y, z) => arr[i * 3] * x + arr[i * 3 + 1] * y + arr[i * 3 + 2] * z;
  const carry = (i, p, out) => {
    const qx = p.x - P[i * 3], qy = p.y - P[i * 3 + 1], qz = p.z - P[i * 3 + 2];
    const along = dot(D, i, qx, qy, qz), x = dot(R, i, qx, qy, qz) - DRAWN[i * 3], y = dot(U, i, qx, qy, qz) - DRAWN[i * 3 + 1];
    const m = i * 6, x2 = map[m] + map[m + 2] * x + map[m + 3] * y, y2 = map[m + 1] + map[m + 4] * x + map[m + 5] * y;
    return out.set(
      P[i * 3] + R[i * 3] * x2 + U[i * 3] * y2 + D[i * 3] * along,
      P[i * 3 + 1] + R[i * 3 + 1] * x2 + U[i * 3 + 1] * y2 + D[i * 3 + 1] * along,
      P[i * 3 + 2] + R[i * 3 + 2] * x2 + U[i * 3 + 2] * y2 + D[i * 3 + 2] * along);
  };
  const ahead = (i, p) => dot(D, i, p.x - P[i * 3], p.y - P[i * 3 + 1], p.z - P[i * 3 + 2]);
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !nodes.test(o.name)) return;
    const pos = o.geometry.attributes.position;
    inv.copy(o.matrixWorld).invert();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
      let j = 0, best = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = v.x - centre[i * 3], dy = v.y - centre[i * 3 + 1], dz = v.z - centre[i * 3 + 2], d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; j = i; }
      }
      // Reach is judged in the section plane, so the gutter's run past either end of the lane
      // still moves (with the end pose) while the foot of a support pole, far below, stays put.
      const along = ahead(j, v);
      if (best - along * along > REACH * REACH) continue;
      const lo = along >= 0 ? j : j - 1;
      if (lo < 0 || lo >= n - 1) carry(j, v, a);
      else {
        const a0 = ahead(lo, v), a1 = ahead(lo + 1, v);
        carry(lo, v, a).lerp(carry(lo + 1, v, b), Math.min(1, Math.max(0, a0 / ((a0 - a1) || 1))));
      }
      a.applyMatrix4(inv);
      pos.setXYZ(k, a.x, a.y, a.z);
    }
    pos.needsUpdate = true;
    o.geometry.computeVertexNormals();
    o.geometry.computeBoundingBox();
    o.geometry.computeBoundingSphere();
  });
}

// Edge length of a collision chunk, world units. Measured U-curve on Spiral Works (101 marbles,
// ms per physics step): 24 -> 66, 48 -> 52, 64 -> 39, 80 -> 47, 160 -> 104. Too small and the
// per-pair narrowphase overhead multiplies; too large and each query hands back a pile of
// triangles to test. 64 sits at the bottom.
const CHUNK = 64;

// How far beneath the floor plane, or how far outside the channel, a marble must be before it
// counts as having left the course. EITHER is enough — see isOutOfBounds. OOB_DROP is generous
// against the ~8-unit wall height so a marble bouncing hard in a banked turn is not retired for
// one deep frame; OOB_LATERAL likewise leaves room for a marble climbing past the flat width of
// a bank.
const OOB_DROP = 24;
const OOB_LATERAL = 20;

// Uniform grid cell for the cold-start centerline lookup, world units.
const GRID_CELL = 48;

// Sweep rate of a timed gate, rad/s. Deliberately far slower than a paddle (1.5): at 0.55 a bar
// takes about 5.7 s per turn, so the lane behind it is open for roughly three seconds at a time —
// long enough to read and aim for, short enough to matter.
const GATE_SPIN = 0.55;

// How far either side of the hint to scan. A marble travelling 150 u/s covers 1.25 world units
// per physics step and samples are ~4 units apart, so ±24 is generous even after several frames
// without an update.
const HINT_WINDOW = 24;

// ── course-independent geometry helpers ─────────────────────────────────────────────────────

/**
 * Restore the spatial early-out in a Trimesh's octree query.
 *
 * cannon-es 0.20 ships Octree.aabbQuery with its own early-out commented out (the source still
 * carries the disabled lines and a "@todo unwrap recursion into a queue" note next to them). As
 * shipped it pushes every child onto the queue unconditionally, so a query walks the ENTIRE tree
 * and costs O(total nodes) instead of O(log n). Since sphere-vs-trimesh issues one query per
 * marble per chunk per step, that single missing test dominated the whole frame: 40.5 ms of a
 * 43.8 ms step was narrowphase, for only 90 actual contacts.
 *
 * The check is sound because Octree.insert only ever stores an element on a node whose AABB
 * CONTAINS that element's AABB — so a node that does not overlap the query cannot hold anything
 * that does, and neither can its descendants. This is the library's own intended behaviour,
 * restored; it is not a change in collision semantics, and the contact set is identical.
 */
function patchOctreeQuery(trimesh) {
  const tree = trimesh.tree;
  tree.aabbQuery = function aabbQuery(aabb, result) {
    const queue = [this];
    while (queue.length) {
      const node = queue.pop();
      if (!node.aabb.overlaps(aabb)) continue;
      if (node.data.length) Array.prototype.push.apply(result, node.data);
      for (let i = 0; i < node.children.length; i++) queue.push(node.children[i]);
    }
    return result;
  };
  return trimesh;
}

/**
 * Split a soup of world-space triangles into a uniform spatial grid and return one
 * CANNON.Trimesh per non-empty cell.
 *
 * WHY, AND DO NOT COLLAPSE THIS BACK. cannon-es's sphere-vs-trimesh narrowphase asks the
 * trimesh's internal Octree which triangles lie near the sphere, then runs seven sub-tests on
 * every triangle it gets back. Two things made that unaffordable with one body per authored
 * segment, and chunking fixes both: each octree stays small, and the chunk AABBs are tight
 * enough that the broadphase discards nearly all of them before the narrowphase is reached (a
 * whole four-turn helix in one body has an AABB a marble overlaps for its entire descent).
 *
 * Triangles are binned by CENTROID, so each belongs to exactly one chunk and none is duplicated
 * or dropped — the union of the chunks is the input surface exactly.
 *
 * @param {ArrayLike<number>} wx @param {ArrayLike<number>} wy @param {ArrayLike<number>} wz
 *   world-space vertex components
 * @param {ArrayLike<number>} indices triangle indices
 * @param {(a:number,b:number,c:number)=>boolean} [keep] optional per-triangle filter
 */
function chunkedTrimeshes(wx, wy, wz, indices, keep) {
  const triCount = indices.length / 3;
  const cells = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    if (keep && !keep(a, b, c)) continue;
    const gx = (wx[a] + wx[b] + wx[c]) / 3, gy = (wy[a] + wy[b] + wy[c]) / 3, gz = (wz[a] + wz[b] + wz[c]) / 3;
    const key = `${Math.floor(gx / CHUNK)},${Math.floor(gy / CHUNK)},${Math.floor(gz / CHUNK)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = []));
    cell.push(t);
  }

  const out = [];
  for (const tris of cells.values()) {
    const verts = new Array(tris.length * 9);
    const ind = new Array(tris.length * 3);
    let vi = 0;
    for (let n = 0; n < tris.length; n++) {
      const t = tris[n];
      for (let k = 0; k < 3; k++) {
        const sIdx = indices[t * 3 + k];
        verts[vi * 3] = wx[sIdx]; verts[vi * 3 + 1] = wy[sIdx]; verts[vi * 3 + 2] = wz[sIdx];
        ind[n * 3 + k] = vi;
        vi++;
      }
    }
    // CANNON.Trimesh stores indices in an Int16Array, so a chunk may hold at most 32767/3 ~ 10922
    // triangles before indices silently wrap and the collider becomes garbage geometry. Chunking
    // keeps us orders of magnitude below that; this asserts it rather than trusting it.
    if (vi > 32767) throw new Error(`marble track: collision chunk has ${vi} vertices, past cannon-es Int16 index limit - reduce CHUNK`);
    out.push(patchOctreeQuery(new CANNON.Trimesh(verts, ind)));
  }
  return out;
}

/** World-space vertex components + indices for a three.js mesh, as flat arrays. */
function worldTriangles(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const m = mesh.matrixWorld;
  const v = new THREE.Vector3();
  const wx = new Float64Array(pos.count), wy = new Float64Array(pos.count), wz = new Float64Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    wx[i] = v.x; wy[i] = v.y; wz[i] = v.z;
  }
  let indices;
  if (geo.index) indices = geo.index.array;
  else { indices = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) indices[i] = i; }
  return { wx, wy, wz, indices };
}

/** Axis-aligned world extents of a mesh. */
function worldBox(mesh) {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}


// World units per chequer cell on the finish banner.
const CHECKER_SIZE = 8;

let _checkerTex = null;
let _brakeTex = null;

/** Amber/black chevrons pointing down-track, for the brake strips. Built once, shared. */
function brakeTexture() {
  if (_brakeTex) return _brakeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#1c1206';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#f59e0b';
  for (const y0 of [0, 32]) {
    g.beginPath();
    g.moveTo(0, y0 + 20); g.lineTo(32, y0 + 4); g.lineTo(64, y0 + 20);
    g.lineTo(64, y0 + 30); g.lineTo(32, y0 + 14); g.lineTo(0, y0 + 30);
    g.closePath(); g.fill();
  }
  _brakeTex = new THREE.CanvasTexture(c);
  _brakeTex.colorSpace = THREE.SRGBColorSpace;
  _brakeTex.wrapS = _brakeTex.wrapT = THREE.RepeatWrapping;
  _brakeTex.anisotropy = THREE.Texture.DEFAULT_ANISOTROPY;
  return _brakeTex;
}

/**
 * Black-and-white chequer, generated once and shared by every course.
 *
 * NearestFilter and no mipmaps on purpose: this is a hard-edged graphic, and letting it filter
 * turns the far end of the banner into flat grey exactly where it is read as "the line".
 */
function checkerTexture() {
  if (_checkerTex) return _checkerTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const n = 8, cell = 64 / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      g.fillStyle = ((x + y) & 1) ? '#f2f2f2' : '#0b0b0b';
      g.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  _checkerTex = new THREE.CanvasTexture(c);
  _checkerTex.wrapS = _checkerTex.wrapT = THREE.RepeatWrapping;
  _checkerTex.magFilter = THREE.NearestFilter;
  _checkerTex.minFilter = THREE.LinearMipmapLinearFilter;
  _checkerTex.anisotropy = THREE.Texture.DEFAULT_ANISOTROPY;
  return _checkerTex;
}

/** A fresh, zeroed projection record for a caller to own and reuse. */
export const newProjection = () => ({ s: 0, index: -1, lateral: 0, height: 0 });

/**
 * Build one authored course's loader + builder.
 *
 * @param {object} opts
 * @param {string} opts.modelUrl URL of the GLB, relative to wwwroot
 * @param {object} opts.path the course's generated track*-path.js module namespace
 * @param {object} opts.collision the course's generated track*-collision.js module namespace
 * @param {string|null} [opts.bowlMeshName] mesh that collides against its own geometry, upward
 *   faces only, because it is a funnel with no ring structure to loft a shell from
 * @param {number} [opts.finishBackoff] world units to pull the finish back from the end of the
 *   line, so a marble is scored while it is still ON the floor rather than as it drops past it
 * @param {number|null} [opts.finishS] absolute world arclength of the finish, ending the race
 *   early. Overrides finishBackoff. Use when a stretch of authored course is not raceable
 * @param {number} [opts.paddleSpeed] rad/s for Obs-Paddle props
 * @param {Array<[number, number, number]>} [opts.brakeBands] [s0, s1, maxSpeed] in world
 *   arclength: rumble strips that cap speed ahead of a narrow mouth (game.js _applyBrakes)
 * @param {string|null} [opts.colliderUrl] a second GLB whose every mesh is a static collider,
 *   for a course with no baked shell (downward faces culled — nothing can reach them)
 * @param {Array<{name, from, to, collide}>|null} [opts.ringLanes] sample ranges to synthesize
 *   lanes over from PATH.RINGS when `collision` is null — see ringShell
 * @param {RegExp|null} [opts.hideNodes] model nodes not to draw (a course's own demo marbles)
 * @param {object} [opts.grid] start-grid overrides: colSpacing, rowGap, wallClear (world units)
 * @param {RegExp|null} [opts.colliderNodes] which meshes of the collider model to use
 * @param {number} [opts.driveAccel] u/s² push along the course for marbles on the track, for a
 *   course whose grade is too gentle to race on (game.js _applyDrive); 0 = none
 * @param {RegExp|null} [opts.conformNodes] model nodes to re-pose onto the ring shell, for a path
 *   that carries DRAWN — see conformToShell
 */
export function createGlbCourse({
  modelUrl,
  path: PATH,
  collision: COL,
  bowlMeshName = null,
  finishBackoff = 16,
  finishS = null,
  paddleSpeed = 1.5,
  brakeBands = [],
  colliderUrl = null,
  ringLanes = null,
  hideNodes = null,
  grid = {},
  colliderNodes = null,
  driveAccel = 0,
  conformNodes = null,
}) {
  if (!COL && ringLanes) ({ PATH, COL } = ringShell(PATH, ringLanes));
  const { SCALE, COUNT, ARCLENGTH, POINTS, DIRS, UPS, RIGHTS, HALF_WIDTHS, CUM } = PATH;
  const COL_VERTS = COL.VERTICES;

  // Boost pads, converted once from the baked raw units into the world units `s` is measured in.
  // A course that declares none simply has no inBoost, and game.js feature-detects it away.
  const BOOST_BANDS = (PATH.BOOST_BANDS || []).map(([a, b]) => [a * SCALE, b * SCALE]);
  // Kicker bands are already NORMALIZED fractions — see the kicker block in buildTrack.
  const KICKER_BANDS = PATH.KICKER_BANDS || [];
  // Seconds per charge->fire cycle. Deliberately coprime-ish so two kickers on the same course
  // drift out of phase with each other instead of firing in lockstep every time.
  const KICKER_PERIODS = [2.6, 3.1, 2.2];

  const TRACK = {
    SCALE,
    MARBLE_R: 1.0,           // BASE radius — the roster scales each marble around this (marbles.js)
    LENGTH: ARCLENGTH * SCALE,
    FINISH_BACKOFF: finishBackoff,
  };
  // A course may end EARLY, short of where its geometry stops. Spiral Works needs this: its
  // Track-LowerA loop climbs 23 world units, which takes ~59 u/s at the foot just to crest, and
  // in practice the field piles up there and the race is decided by a timeout rather than by a
  // finish. Cutting the line in front of the loop turns the raceable part of the course into the
  // whole race. LENGTH follows finishS so the HUD's progress still reads 100% at the line rather
  // than stopping at 61%.
  if (finishS != null) {
    TRACK.LENGTH = finishS;
    TRACK.FINISH_S = finishS;
  } else {
    TRACK.FINISH_S = TRACK.LENGTH - TRACK.FINISH_BACKOFF;
  }

  // The baked paddles turn at ±0.121 rad/s (four revolutions across a 208-second Blender preview
  // clip), which is imperceptible at race pace. Any animation in the GLB is discarded and the
  // props are spun as kinematic bodies instead; only the SIGN is kept from the name, so a pair
  // still counter-rotates and the pack cannot just hug one side through the hazard.
  const PADDLE_SPEED = paddleSpeed;

  // ── module-level model cache ──────────────────────────────────────────────────────────────
  // The course is fixed content: unlike the old seeded generator there is nothing to re-roll
  // between races, so the GLB is parsed once per page load and the built track is reused.
  let _modelPromise = null;
  // The collider model's scene, kept here rather than in the course scene's userData: Object3D
  // clone() deep-copies userData through JSON, which a scene graph cannot survive.
  let _colliderScene = null;

  /**
   * Fetch + parse the course model. Safe to call repeatedly; the parse happens once.
   * @returns {Promise<THREE.Group>} the raw glTF scene (unscaled, as authored).
   */
  function loadModel() {
    if (!_modelPromise) {
      _modelPromise = Promise.all([
        gltfLoader().loadAsync(modelUrl),
        colliderUrl ? gltfLoader().loadAsync(colliderUrl) : null,
      ]).then(([gltf, col]) => {
        _colliderScene = col ? col.scene : null;
        if (conformNodes) conformToShell(gltf.scene, PATH, conformNodes);
        return gltf.scene;
      });
    }
    return _modelPromise;
  }

  // ── centerline sampling ───────────────────────────────────────────────────────────────────
  // All baked arrays are in raw GLB units; everything below works in WORLD units (× SCALE) so no
  // call site has to remember which space it is in. Positions and widths scale; the dir/up/right
  // bases are unit vectors and do not.
  const WORLD_CUM = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) WORLD_CUM[i] = CUM[i] * SCALE;

  // Uniform grid over the centerline, for the cold-start / marble-teleported lookup. Every
  // frame's projection normally starts from the marble's previous index and only scans a short
  // window; this is the fallback that finds the line again when there is no usable hint.
  const _grid = new Map();
  const _cellKey = (x, y, z) =>
    `${Math.floor(x / GRID_CELL)},${Math.floor(y / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;
  for (let i = 0; i < COUNT; i++) {
    const k = _cellKey(POINTS[i * 3] * SCALE, POINTS[i * 3 + 1] * SCALE, POINTS[i * 3 + 2] * SCALE);
    let bucket = _grid.get(k);
    if (!bucket) _grid.set(k, (bucket = []));
    bucket.push(i);
  }

  /** Squared distance from (x,y,z) to centerline sample i, in world units. */
  function distSqToSample(i, x, y, z) {
    const dx = POINTS[i * 3] * SCALE - x;
    const dy = POINTS[i * 3 + 1] * SCALE - y;
    const dz = POINTS[i * 3 + 2] * SCALE - z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Nearest sample index by brute grid search — the no-hint path. */
  function nearestSampleGlobal(x, y, z) {
    const cx = Math.floor(x / GRID_CELL), cy = Math.floor(y / GRID_CELL), cz = Math.floor(z / GRID_CELL);
    let best = -1, bestD = Infinity;
    // Widen the ring until something is found: a marble in mid-air over a funnel can be several
    // cells clear of every sample.
    for (let r = 1; r <= 6 && best < 0; r++) {
      for (let ax = cx - r; ax <= cx + r; ax++)
        for (let ay = cy - r; ay <= cy + r; ay++)
          for (let az = cz - r; az <= cz + r; az++) {
            const bucket = _grid.get(`${ax},${ay},${az}`);
            if (!bucket) continue;
            for (const i of bucket) {
              const d = distSqToSample(i, x, y, z);
              if (d < bestD) { bestD = d; best = i; }
            }
          }
    }
    if (best >= 0) return best;
    // Nothing within six cells (a marble that fell out of the world entirely) — fall back to a
    // full scan so the caller still gets a defined answer rather than NaN progress.
    for (let i = 0; i < COUNT; i++) {
      const d = distSqToSample(i, x, y, z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // A GLOBAL search is only ever used to acquire the line for the first time (hint < 0). It must
  // NOT be used as a "the marble looks lost, find it again" fallback, which is what this code did
  // first and which produced a nonsense standings jump of 1450 units in two seconds.
  //
  // The reason is the shape of these courses: a tight descending spiral passes back over itself
  // repeatedly. On Spiral Works the turns of the start helix are only ~46 world units apart
  // vertically, and Track-Mid sits almost directly above Track-Lane2 — which is 1450 units
  // further along the line. So "nearest centerline sample in space" is simply not the same
  // question as "where is this marble in the race", and for a marble that has left the track the
  // two answers are routinely on different parts of the course.
  //
  // Keeping the local result instead is both more truthful and self-correcting: a marble that has
  // genuinely fallen keeps the last position it actually reached, and isOutOfBounds retires it on
  // the same frame rather than teleporting it up the standings first.

  /**
   * Project a world position onto the centerline.
   *
   * `out` is REQUIRED to be reused by the caller: this runs once per marble per frame, and over a
   * 101-marble field returning a fresh object here would be ~6000 allocations a second — the same
   * reason marbles.js keeps scratch objects at module scope.
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {number} hint previous sample index, or -1 for none
   * @param {{s:number, index:number, lateral:number, height:number}} out mutated and returned.
   *   `s` is world units along the line; `lateral` is signed offset along the local right axis and
   *   `height` signed offset along the local up axis, both in world units.
   */
  function project(x, y, z, hint, out) {
    let best = -1, bestD = Infinity;
    if (hint >= 0) {
      const lo = Math.max(0, hint - HINT_WINDOW), hi = Math.min(COUNT - 1, hint + HINT_WINDOW);
      for (let i = lo; i <= hi; i++) {
        const d = distSqToSample(i, x, y, z);
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      best = nearestSampleGlobal(x, y, z);
      bestD = distSqToSample(best, x, y, z);
    }

    // Refine along the tangent at the nearest sample: the samples are ~4 units apart, so snapping
    // to one would quantise progress into visible steps in the standings.
    const px = POINTS[best * 3] * SCALE, py = POINTS[best * 3 + 1] * SCALE, pz = POINTS[best * 3 + 2] * SCALE;
    const dx = x - px, dy = y - py, dz = z - pz;
    const tx = DIRS[best * 3], ty = DIRS[best * 3 + 1], tz = DIRS[best * 3 + 2];
    let along = dx * tx + dy * ty + dz * tz;
    // Clamp into the neighbouring gaps so the refinement can never jump a whole segment.
    const back = best > 0 ? WORLD_CUM[best] - WORLD_CUM[best - 1] : 0;
    const fwd = best < COUNT - 1 ? WORLD_CUM[best + 1] - WORLD_CUM[best] : 0;
    along = Math.max(-back, Math.min(fwd, along));

    const rx = RIGHTS[best * 3], ry = RIGHTS[best * 3 + 1], rz = RIGHTS[best * 3 + 2];
    const ux = UPS[best * 3], uy = UPS[best * 3 + 1], uz = UPS[best * 3 + 2];
    out.s = WORLD_CUM[best] + along;
    out.index = best;
    out.lateral = dx * rx + dy * ry + dz * rz;
    out.height = dx * ux + dy * uy + dz * uz;
    return refineLane(x, y, z, out);
  }

  /** Sample index at arclength `s` (world units), by binary search over the cumulative table. */
  function indexAt(s) {
    let lo = 0, hi = COUNT - 1;
    if (s <= 0) return 0;
    if (s >= WORLD_CUM[hi]) return hi;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (WORLD_CUM[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Interpolating accessors. `out` is always caller-supplied or a shared scratch: these run for
  // every marble every frame and allocating here would be thousands of vectors per second.
  function lerpVec(arr, s, out, scaled) {
    const i = indexAt(s);
    const j = Math.min(COUNT - 1, i + 1);
    const span = WORLD_CUM[j] - WORLD_CUM[i];
    const t = span > 1e-6 ? Math.max(0, Math.min(1, (s - WORLD_CUM[i]) / span)) : 0;
    const k = scaled ? SCALE : 1;
    out.set(
      (arr[i * 3] + (arr[j * 3] - arr[i * 3]) * t) * k,
      (arr[i * 3 + 1] + (arr[j * 3 + 1] - arr[i * 3 + 1]) * t) * k,
      (arr[i * 3 + 2] + (arr[j * 3 + 2] - arr[i * 3 + 2]) * t) * k,
    );
    return out;
  }

  // One scratch PER accessor, never shared. Callers routinely hold two of these at once — the
  // frame loop takes centerAt() and dirAt() together to aim the camera — so a shared scratch would
  // silently hand back the same vector twice.
  const _scratchCenter = new THREE.Vector3();
  const _scratchDir = new THREE.Vector3();
  const _scratchRight = new THREE.Vector3();
  const _scratchUp = new THREE.Vector3();

  /** Centerline (floor-centre) point at arclength `s`. */
  const centerAt = (s, out) => lerpVec(POINTS, s, out || _scratchCenter, true);
  /** Unit forward tangent at `s`. */
  const dirAt = (s, out) => lerpVec(DIRS, s, out || _scratchDir, false).normalize();
  /** Unit lateral axis at `s` (track-local right). */
  const rightAt = (s, out) => lerpVec(RIGHTS, s, out || _scratchRight, false).normalize();
  /** Unit up axis at `s`; carries the authored banking. */
  const upAt = (s, out) => lerpVec(UPS, s, out || _scratchUp, false).normalize();

  /** Half channel width at `s`, world units. */
  function halfWidthAt(s) {
    const i = indexAt(s);
    const j = Math.min(COUNT - 1, i + 1);
    const span = WORLD_CUM[j] - WORLD_CUM[i];
    const t = span > 1e-6 ? Math.max(0, Math.min(1, (s - WORLD_CUM[i]) / span)) : 0;
    return (HALF_WIDTHS[i] + (HALF_WIDTHS[j] - HALF_WIDTHS[i]) * t) * SCALE;
  }

  // ── lanes ─────────────────────────────────────────────────────────────────────────────────
  // The baked centerline follows the MAIN lane only. Branch lanes (splits, the hazard fan, the
  // weave) sit up to 46 units off it, and across a junction the main frame is turned nearly 90°
  // to the channel, so any "where is this marble relative to the track" question asked of the
  // main line alone is wrong exactly where the course is most interesting. Measured with the main
  // line alone: Grand Spiral deleted 293 of 299 marbles it called "off the track" while they were
  // rolling on a side lane or up a flared bank.
  //
  // There is no separate baker output for lanes (the baker is gone), but the collision shell
  // already carries every channel, main and branch, as a strip of 4-vertex rings in travel
  // order — wall top, floor edge, floor edge, wall top (see track*-collision.js). Each lane's
  // frame is read straight off its rings: floor midpoint, across (right), tangent, up, the real
  // floor half-width and how far out its wall tops reach. `s` still comes from the main line so
  // standings stay comparable: a lane ring maps onto the main arclength its segment spans.
  const LANES = [];
  {
    const segInfo = new Map((PATH.SEGMENTS || []).map((sg) => [sg.name, sg]));
    let base = 0;
    for (const sg of COL.SEGMENTS || []) {
      const info = segInfo.get(sg.name);
      const n = sg.kept;
      const vbase = base;
      base += n * 4;
      // Bumper is a decorative rim with no floor; a name the path does not know has no `s`.
      if (!info || /Bumper/.test(sg.name) || n < 2) continue;
      const read = (r, k, out) => {
        const o = (vbase + r * 4 + k) * 3;
        return out.set(COL_VERTS[o] * SCALE, COL_VERTS[o + 1] * SCALE, COL_VERTS[o + 2] * SCALE);
      };
      // Travel order: ring 0 should sit at the segment's `from` end of the main line.
      const mainPt = (i) => new THREE.Vector3(POINTS[i * 3] * SCALE, POINTS[i * 3 + 1] * SCALE, POINTS[i * 3 + 2] * SCALE);
      const mid = (r) => read(r, 1, new THREE.Vector3()).add(read(r, 2, new THREE.Vector3())).multiplyScalar(0.5);
      const reversed = mid(0).distanceTo(mainPt(info.to)) < mid(0).distanceTo(mainPt(info.from));
      const ring = (r) => (reversed ? n - 1 - r : r);

      const lane = {
        name: sg.name, open: /Catch/.test(sg.name), kerb: sg.kerb !== false, n,
        A: new Float32Array(n * 3), B: new Float32Array(n * 3), C: new Float32Array(n * 3), D: new Float32Array(n * 3),
        P: new Float32Array(n * 3), R: new Float32Array(n * 3), U: new Float32Array(n * 3),
        HW: new Float32Array(n), REACH: new Float32Array(n), S: new Float32Array(n), s0: 0, s1: 0,
      };
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
      for (let r = 0; r < n; r++) {
        read(ring(r), 0, a); read(ring(r), 1, b); read(ring(r), 2, c); read(ring(r), 3, d);
        a.toArray(lane.A, r * 3); b.toArray(lane.B, r * 3); c.toArray(lane.C, r * 3); d.toArray(lane.D, r * 3);
        b.clone().add(c).multiplyScalar(0.5).toArray(lane.P, r * 3);
        lane.HW[r] = b.distanceTo(c) / 2;
      }
      const v = (arr, r) => new THREE.Vector3(arr[r * 3], arr[r * 3 + 1], arr[r * 3 + 2]);
      let arc = 0;
      const cum = new Float32Array(n);
      for (let r = 0; r < n; r++) {
        if (r > 0) arc += v(lane.P, r).distanceTo(v(lane.P, r - 1));
        cum[r] = arc;
        const t = v(lane.P, Math.min(n - 1, r + 1)).sub(v(lane.P, Math.max(0, r - 1))).normalize();
        const right = v(lane.C, r).sub(v(lane.B, r)).normalize();
        // up = right × tangent for a right-handed (right = tangent × up) frame; then make sure it
        // points into the channel. The walls say which way that is; at a lane mouth, where a wall
        // has zero height, the main line's up does.
        const up = new THREE.Vector3().crossVectors(right, t).normalize();
        const walls = v(lane.A, r).sub(v(lane.B, r)).add(v(lane.D, r).sub(v(lane.C, r)));
        const mi = Math.round(info.from + ((info.to - info.from) * r) / (n - 1));
        const ref = walls.length() > 0.5 ? walls : new THREE.Vector3(UPS[mi * 3], UPS[mi * 3 + 1], UPS[mi * 3 + 2]);
        if (up.dot(ref) < 0) up.negate();
        right.toArray(lane.R, r * 3);
        up.toArray(lane.U, r * 3);
        // How far across the wall tops reach: flared walls let a marble roll well past the floor.
        const p = v(lane.P, r);
        lane.REACH[r] = Math.max(lane.HW[r], Math.abs(v(lane.A, r).sub(p).dot(right)), Math.abs(v(lane.D, r).sub(p).dot(right)));
      }
      const s0 = WORLD_CUM[info.from], s1 = WORLD_CUM[info.to];
      for (let r = 0; r < n; r++) lane.S[r] = s0 + (arc > 0 ? cum[r] / arc : 0) * (s1 - s0);
      lane.s0 = s0; lane.s1 = s1;
      LANES.push(lane);
    }
  }

  /**
   * A decal ribbon laid across the main channel from s0 to s1 (the finish banner, the brake
   * strips). Follows the channel's real width and banking; lifted and polygon-offset so it never
   * z-fights the floor. Decorative only — no collider.
   */
  function floorBand(s0, s1, map, lift, name) {
    const steps = Math.max(2, Math.ceil((s1 - s0) / 3));
    const pos = [], uv = [], idx = [];
    const c = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      const along = ((s1 - s0) * i) / steps;
      const s = s0 + along;
      centerAt(s, c); rightAt(s, r); upAt(s, u);
      const hw = halfWidthAt(s);
      for (const side of [-1, 1]) {
        pos.push(c.x + r.x * hw * side + u.x * lift, c.y + r.y * hw * side + u.y * lift, c.z + r.z * hw * side + u.z * lift);
        // U spans the real channel width so a pattern keeps its proportions however wide it is.
        uv.push(side < 0 ? 0 : (hw * 2) / CHECKER_SIZE, along / CHECKER_SIZE);
      }
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map, roughness: 0.72, metalness: 0.0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    mesh.receiveShadow = true;
    mesh.name = name;
    return mesh;
  }

  // Brake bands in world arclength, with the speed each one caps a marble at.
  const BRAKE_BANDS = brakeBands.map(([a, b, v]) => [a, b, v]);
  /** Speed cap at `s`, or 0 when `s` is on no brake band. */
  const brakeAt = (s) => {
    for (const [a, b, v] of BRAKE_BANDS) if (s >= a && s <= b) return v;
    return 0;
  };

  // Checkpoints: one at the start of each branch (where lanes split), inside the raceable part.
  const CHECKPOINTS = [...new Set((PATH.SEGMENTS || []).filter((sg) => sg.role === 'alt').map((sg) => sg.from))]
    .map((i) => WORLD_CUM[i])
    .filter((s) => s > 60 && s < TRACK.FINISH_S - 60)
    .sort((a, b) => a - b);

  // ── containment ──────────────────────────────────────────────────────────────────────────────
  // Every closed lane becomes a tube: its walls are extended straight up (along the lane's own
  // up, so banking is followed) to at least CONTAIN_H, and a lid spans the two wall tops. The
  // authored walls are only 21.8 (Spiral Works) / 26 (Grand Spiral) tall except at lane mouths,
  // where they start at ZERO — and marbles reach those mouths at the 85 u/s speed cap. 108 of
  // Spiral Works' 152 falls per three races were at the Split-A mouth.
  //
  // The lid height is capped per ring by the clearance to whatever other channel lies above it
  // (the helixes pass back over themselves ~46 units up; the weave crosses itself), minus a
  // margin, so a lid never pokes into the floor of the level above. A lane named *Catch* stays
  // open: it exists to catch what falls onto it from above.
  //
  // The wall triangles are rendered as faint glass (buildTrack), so the new walls read as walls;
  // the lid is never drawn.
  const CONTAIN_H = 18;
  const CAP_BACK = 3;
  const OVERPASS_MIN = 8;
  const OVERPASS_DS = 150;   // race distance apart before geometry above a ring counts as an overpass
  const LANDING_RINGS = 16;
  const KERB_H = 6;
  const FED_DIST = 25;           // back kerb at a landing zone's start (see fedFromAir)   // rings left unlidded where a lane is fed from the air (~130 units)
  const landing = [];   // rings an end cap's guide wall starts back from the junction (~24 units)
  const CONTAIN_MARGIN = 5;
  // xyz triangle soups (walls, lids, junction floors), per-lane coverage
  const CONTAIN = { walls: [], lids: [], floors: [], stats: [] };
  {
    // Clearance above each ring, from every shell vertex of the OTHER lanes (and of this lane more
    // than a few rings away) that sits over this ring's floor footprint.
    const all = [];
    LANES.forEach((L, li) => {
      for (let r = 0; r < L.n; r++) for (const arr of [L.A, L.B, L.C, L.D]) all.push(arr[r * 3], arr[r * 3 + 1], arr[r * 3 + 2], li, r);
    });
    const t = new THREE.Vector3(), w = new THREE.Vector3();
    const pushTri = (list, p, q, r) => {
      // Skip slivers: a zero-height extension (a wall already taller than the lid) is degenerate.
      const e1 = q.clone().sub(p), e2 = r.clone().sub(p);
      if (e1.cross(e2).lengthSq() < 1e-4) return;
      list.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    };
    // A lane nobody feeds end-to-end is fed from the AIR — after a free fall or out of a funnel —
    // and its first rings are where marbles land. A lid there catches them on its TOP: Grand
    // Spiral's field flies ~100 units off the five-lane fan, landed on the Finish lid, rolled off
    // its edge and was lost. So those rings get walls but no lid.
    const vv3 = (arr, r) => new THREE.Vector3(arr[r * 3], arr[r * 3 + 1], arr[r * 3 + 2]);
    // Fed = some other lane ENDS within FED_DIST of this lane's start. (A tighter test, ahead of
    // and level with the end ring, missed Spiral Works' Penalty lane, which starts 12 units on
    // from the Merge at an angle — it went unlidded and the unstick nudge launched marbles out.)
    // Measured to the end ring's floor EDGE (B–C), not its midpoint: the outer lanes of a fan
    // start 30–46 units to the side of the wide lane's centre, and a midpoint test called them
    // fed from the air — which would have put a back kerb across their entrance.
    const edge = new THREE.Line3(), onEdge = new THREE.Vector3();
    const fedFromAir = LANES.map((L, li) => !LANES.some((M, mi) => {
      if (mi === li) return false;
      edge.start.copy(vv3(M.B, M.n - 1)); edge.end.copy(vv3(M.C, M.n - 1));
      const p = vv3(L.P, 0);
      return edge.closestPointToPoint(p, true, onEdge).distanceTo(p) < FED_DIST;
    }));
    LANES.forEach((L, li) => {
      // A Catch lane is never lidded (it exists to catch what falls onto it) but still gets its
      // walls raised: Grand Spiral's 160-wide catch pan lost marbles straight over its low sides.
      const v = (arr, r) => new THREE.Vector3(arr[r * 3], arr[r * 3 + 1], arr[r * 3 + 2]);
      const topL = [], topR = [], baseL = [], baseR = [];
      L.HLID = new Float32Array(L.n);   // lid height above the floor per ring, 0 = no lid (caps use it)
      for (let r = 0; r < L.n; r++) {
        const P = v(L.P, r), U = v(L.U, r), R = v(L.R, r);
        t.copy(v(L.P, Math.min(L.n - 1, r + 1))).sub(v(L.P, Math.max(0, r - 1))).normalize();
        let clear = Infinity;
        for (let k = 0; k < all.length; k += 5) {
          // Only a DIFFERENT part of the course can be an overpass: more than OVERPASS_DS along the
          // race from this ring. Neighbouring track seen through a curving, banked frame — the lane
          // that feeds a split mouth, or this lane's own next rings — otherwise read as a low
          // ceiling, and cost Split A's detour the lid and wall extension facing the gap between
          // its lanes. Sibling lanes over the same stretch still count (the weave crosses itself).
          const M = LANES[all[k + 3]];
          const sibling = M !== L && M.s0 === L.s0 && M.s1 === L.s1;
          if (!sibling && Math.abs(M.S[all[k + 4]] - L.S[r]) < OVERPASS_DS) continue;
          w.set(all[k] - P.x, all[k + 1] - P.y, all[k + 2] - P.z);
          const hu = w.dot(U);
          // Anything within OVERPASS_MIN of the floor is neighbouring track seen through a banked
          // frame (Split A's feeding lane reads 3.5 units "above" the detour's first ring), not a
          // ceiling. Real overpasses on these courses are ~46 units up.
          if (hu < OVERPASS_MIN || hu >= clear) continue;
          if (Math.abs(w.dot(R)) > L.REACH[r] + 2 || Math.abs(w.dot(t)) > 10) continue;
          clear = hu;
        }
        const A = v(L.A, r), B = v(L.B, r), C = v(L.C, r), D = v(L.D, r);
        const hA = A.clone().sub(B).dot(U), hD = D.clone().sub(C).dot(U);
        // Lid at the taller of CONTAIN_H and the real walls, unless the level above is closer —
        // then just under it. A wall already taller than that height simply is not extended.
        const H = Math.min(Math.max(CONTAIN_H, hA, hD), clear - CONTAIN_MARGIN);
        baseL.push(A); baseR.push(D);
        if (!(H >= 4)) { topL.push(null); topR.push(null); continue; }   // no room: an overpass is the lid
        if (L.open || (fedFromAir[li] && r < LANDING_RINGS)) {
          // Landing zone: extend the walls, leave the top open (see fedFromAir).
          const eL = A.clone().addScaledVector(U, Math.max(0, H - hA)), eD = D.clone().addScaledVector(U, Math.max(0, H - hD));
          landing.push([li, r, eL, eD]);
          topL.push(null); topR.push(null);
          continue;
        }
        L.HLID[r] = H;
        topL.push(A.clone().addScaledVector(U, Math.max(0, H - hA)));
        topR.push(D.clone().addScaledVector(U, Math.max(0, H - hD)));
      }
      // Back kerb across the START of a lane fed from the air: marbles landing there at speed
      // bounce up and backwards, and Spiral Works lost them rolling back out of Lower A's open
      // start into the funnel throat behind it. KERB_H is low enough that anything arriving from
      // above clears it.
      // A lane may opt out (Playground Run's slide): marbles land out of the drop well on BOTH sides
      // of its first ring, and the kerb parked the ones that landed behind it.
      if (fedFromAir[li] && L.kerb) {
        const k0 = vv3(L.B, 0), k1 = vv3(L.C, 0), ku = vv3(L.U, 0).multiplyScalar(KERB_H);
        pushTri(CONTAIN.walls, k0, k1, k1.clone().add(ku)); pushTri(CONTAIN.walls, k0, k1.clone().add(ku), k0.clone().add(ku));
      }
      // Landing-zone walls (no lid): extension quads between consecutive landing rings.
      for (let k = 0; k + 1 < landing.length; k++) {
        const [la, ra, eA, dA] = landing[k], [lb, rb, eB, dB] = landing[k + 1];
        if (la !== li || lb !== li || rb !== ra + 1) continue;
        pushTri(CONTAIN.walls, baseL[ra], baseL[rb], eB); pushTri(CONTAIN.walls, baseL[ra], eB, eA);
        pushTri(CONTAIN.walls, baseR[ra], dB, baseR[rb]); pushTri(CONTAIN.walls, baseR[ra], dA, dB);
      }
      landing.length = 0;
      const lidded = topL.filter(Boolean).length;
      CONTAIN.stats.push({ lane: L.name, index: li, rings: L.n, lidded, caps: 0, fedFromAir: fedFromAir[li], unlidded: topL.map((t, i) => (t ? -1 : i)).filter((i) => i >= 0) });
      for (let r = 0; r < L.n - 1; r++) {
        const a0 = topL[r], a1 = topL[r + 1], d0 = topR[r], d1 = topR[r + 1];
        if (!a0 || !a1 || !d0 || !d1) continue;
        pushTri(CONTAIN.walls, baseL[r], baseL[r + 1], a1); pushTri(CONTAIN.walls, baseL[r], a1, a0);
        pushTri(CONTAIN.walls, baseR[r], d1, baseR[r + 1]); pushTri(CONTAIN.walls, baseR[r], d0, d1);
        pushTri(CONTAIN.lids, a0, a1, d1); pushTri(CONTAIN.lids, a0, d1, d0);
      }
    });

    const vv = (arr, r) => new THREE.Vector3(arr[r * 3], arr[r * 3 + 1], arr[r * 3 + 2]);

    // ── junction bridges ──
    // The shell is decimated per segment, so consecutive segments do not always share a ring: on
    // Grand Spiral the Loop's last ring and Helix B's first sit ~8 units apart with NO floor
    // between them, and the census parked ~50 marbles a race around that hole. Each lane's end
    // ring is joined to the start ring of every lane that continues from it: floor (a collider,
    // never drawn — the model already renders one there), both side walls up to the lid, and the
    // lid. Where the two rings coincide (most split mouths) the bridge has no area and is skipped.
    LANES.forEach((L, li) => {
      if (L.open) return;
      const r = L.n - 1;
      const P = vv(L.P, r), U = vv(L.U, r);
      const T = vv(L.P, r).sub(vv(L.P, r - 1)).normalize();   // out of this lane
      const across = vv(L.C, r).sub(vv(L.B, r)).normalize();
      LANES.forEach((M, mi) => {
        if (mi === li || M.open) return;
        const d = vv(M.P, 0).sub(P);
        if (d.length() < 0.5 || d.dot(T) < -2 || d.dot(T) > 14 || Math.abs(d.dot(U)) > 8) return;
        const TM = vv(M.P, 1).sub(vv(M.P, 0)).normalize();
        if (TM.dot(T) < 0.3) return;   // must continue onward, not run alongside or back
        // Bridge only where the two rings OVERLAP across their width. A split feeds several lanes
        // from one wide end and a merge feeds one wide lane from several narrow ones; bridging
        // each lane to the other's full width sent one lane's bridge walls straight across its
        // sibling's path and jammed the whole field at the junction.
        const LB = vv(L.B, r), LW = LB.distanceTo(vv(L.C, r));
        const MB = vv(M.B, 0), MW = MB.distanceTo(vv(M.C, 0));
        const acrossM = vv(M.C, 0).sub(MB).normalize();
        const clamp = (u, w) => Math.max(0, Math.min(w, u));
        // M's edges measured along L's line, and L's edges along M's line.
        let a0 = vv(M.B, 0).sub(LB).dot(across), a1 = vv(M.C, 0).sub(LB).dot(across);
        let b0 = LB.clone().sub(MB).dot(acrossM), b1 = vv(L.C, r).sub(MB).dot(acrossM);
        const flipped = a0 > a1;   // the rings may run their B/C sides in opposite directions
        if (flipped) [a0, a1] = [a1, a0];
        if (b0 > b1) [b0, b1] = [b1, b0];
        const uL0 = clamp(a0, LW), uL1 = clamp(a1, LW), uM0 = clamp(b0, MW), uM1 = clamp(b1, MW);
        if (uL1 - uL0 < 1 || uM1 - uM0 < 1) return;   // they do not face each other
        const lB = LB.clone().addScaledVector(across, uL0), lC = LB.clone().addScaledVector(across, uL1);
        let mB = MB.clone().addScaledVector(acrossM, uM0), mC = MB.clone().addScaledVector(acrossM, uM1);
        if (flipped) [mB, mC] = [mC, mB];
        if (lB.distanceTo(mB) < 0.5 && lC.distanceTo(mC) < 0.5) return;
        pushTri(CONTAIN.floors, lB, lC, mC); pushTri(CONTAIN.floors, lB, mC, mB);
        const H = Math.min(L.HLID[r] || CONTAIN_H, M.HLID[0] || CONTAIN_H);
        const up = (p) => p.clone().addScaledVector(U, H);
        pushTri(CONTAIN.walls, lB, mB, up(mB)); pushTri(CONTAIN.walls, lB, up(mB), up(lB));
        pushTri(CONTAIN.walls, lC, up(mC), mC); pushTri(CONTAIN.walls, lC, up(lC), up(mC));
        pushTri(CONTAIN.lids, up(lB), up(mB), up(mC)); pushTri(CONTAIN.lids, up(lB), up(mC), up(lC));
        CONTAIN.stats.find((st) => st.index === li).bridges = (CONTAIN.stats.find((st) => st.index === li).bridges || 0) + 1;
      });
    });

    // ── end caps ──
    // Where two lanes meet, the tube of each stops at its own end ring. When the lane beyond is
    // NARROWER, the outer part of this end ring leads nowhere — no floor ahead, no wall — and a
    // marble riding that edge simply leaves the course. That corner, not the lanes, is where the
    // census losses were: Grand Spiral's 40-wide Washboard runs into the 32-wide Loop, and the
    // Loop into Helix B. So each end ring that touches another lane's end ring gets a wall across
    // whatever part of its width the neighbour does not cover. An end that meets NO lane (it opens
    // into a funnel, the free fall or the finish run-out) is left open — that is the course.
    //
    // END rings (the downstream end, where a lane narrows into the next) get an ANGLED guide
    // wall that steers marbles in. START rings wider than the lane feeding them get a FLAT wall
    // along the junction line over the uncovered part: that seals the open corner between the two
    // lanes' walls (Grand Spiral lost 44 marbles a race out of it at the start of Helix B) without
    // standing in the flow — an angled wall there made a pocket that parked ~40 marbles instead.
    LANES.forEach((L, li) => {
      if (L.open) return;
      for (const r of [0, L.n - 1]) {
        const B = vv(L.B, r), C = vv(L.C, r), P = vv(L.P, r), U = vv(L.U, r);
        const W = B.distanceTo(C);
        const across = C.clone().sub(B).normalize();
        const T = vv(L.P, r === 0 ? 1 : L.n - 2).sub(P).normalize();   // into this lane
        const spans = [];
        LANES.forEach((M, mi) => {
          if (mi === li) return;
          for (const q of [0, M.n - 1]) {
            const d = vv(M.P, q).sub(P);
            if (Math.abs(d.dot(T)) > 8 || Math.abs(d.dot(U)) > 6) continue;
            // Only a lane that CONTINUES beyond this end counts — its interior must run the other
            // way. A sibling lane that starts or ends alongside this one (a split's other branch,
            // the fan into the free fall) runs the same way, and counting it capped the whole mouth.
            const TM = vv(M.P, q === 0 ? 1 : M.n - 2).sub(vv(M.P, q)).normalize();
            if (TM.dot(T) > -0.3) continue;
            const u0 = vv(M.B, q).sub(B).dot(across), u1 = vv(M.C, q).sub(B).dot(across);
            spans.push([Math.max(0, Math.min(u0, u1)), Math.min(W, Math.max(u0, u1))]);
          }
        });
        if (!spans.length) continue;   // an open end: funnel, free fall, finish
        spans.sort((a, b) => a[0] - b[0]);
        const gaps = [];
        let at = 0;
        for (const [a, b] of spans) {
          if (a > at + 1) gaps.push([at, a]);
          at = Math.max(at, b);
        }
        if (W > at + 1) gaps.push([at, W]);
        const H = L.HLID[r] || Math.max(CONTAIN_H, vv(L.A, r).sub(B).dot(U), vv(L.D, r).sub(C).dot(U));
        // A gap at the lane's EDGE gets an angled guide wall, not a flat one: from the floor edge
        // CAP_BACK rings back into this lane to where the neighbour's floor begins at the end
        // ring. A flat cap made a pocket that marbles ran into and parked in; the angled wall
        // steers them into the narrower lane. A gap in the MIDDLE (between two continuing lanes)
        // gets a flat nose across it.
        const back = r === 0 ? Math.min(L.n - 1, CAP_BACK) : Math.max(0, L.n - 1 - CAP_BACK);
        for (const [a, b] of gaps) {
          let p0, p1;
          if (r !== 0 && a < 0.5) { p0 = vv(L.B, back); p1 = B.clone().addScaledVector(across, b); }
          else if (r !== 0 && b > W - 0.5) { p0 = vv(L.C, back); p1 = B.clone().addScaledVector(across, a); }
          else { p0 = B.clone().addScaledVector(across, a); p1 = B.clone().addScaledVector(across, b); }
          const q0 = p0.clone().addScaledVector(U, H), q1 = p1.clone().addScaledVector(U, H);
          pushTri(CONTAIN.walls, p0, p1, q1); pushTri(CONTAIN.walls, p0, q1, q0);
          CONTAIN.stats.find((st) => st.index === li).caps++;
        }
      }
    });
  }

  /**
   * Swept guard over the containment surfaces.
   *
   * The containment is a single-sided triangle shell, and cannon-es only keeps a sphere on the
   * near side of a triangle while its CENTRE is on the near side. At the 85 u/s speed cap a marble
   * moves 1.42 units a step — more than its 1-unit radius — so a head-on hit carries the centre
   * through in one step and the solver then pushes it out the FAR side. Floors never see this
   * (marbles press into them gently); walls and lids take head-on hits, and the first census with
   * containment still lost 41 marbles straight through Grand Spiral's fully lidded Loop.
   *
   * So each frame the engine traces every marble's path against these triangles (a uniform grid
   * keeps it to a handful of tests) and, on a crossing, puts the marble back on the inside. This is
   * the one part of the course that must never be crossed, so there is no legitimate crossing to
   * get wrong.
   */
  function createSweepGuard(soups) {
    const CELL = 12;
    const SEAM = 0.03;
    const tris = [];
    for (const soup of soups) for (let i = 0; i < soup.length; i += 9) tris.push(soup.slice(i, i + 9));
    const grid = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    tris.forEach((t, ti) => {
      const lo = [0, 1, 2].map((a) => Math.floor(Math.min(t[a], t[a + 3], t[a + 6]) / CELL));
      const hi = [0, 1, 2].map((a) => Math.floor(Math.max(t[a], t[a + 3], t[a + 6]) / CELL));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const k = key(x, y, z);
        let b = grid.get(k);
        if (!b) grid.set(k, (b = []));
        b.push(ti);
      }
    });
    const seen = new Set();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();
    const dir = new THREE.Vector3(), n = new THREE.Vector3();
    /**
     * @param {{x,y,z}} p0 position before the step @param {{x,y,z}} p1 position after it
     * @param {THREE.Vector3} outPoint where to put the marble back @param {THREE.Vector3} outNormal
     *   unit normal pointing back inside (against the motion)
     * @returns {boolean} true when the path crossed a containment triangle
     */
    return function sweep(p0, p1, radius, outPoint, outNormal) {
      dir.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      if (dir.lengthSq() < 1e-8) return false;
      const lo = [Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.min(p0.z, p1.z)].map((v) => Math.floor(v / CELL));
      const hi = [Math.max(p0.x, p1.x), Math.max(p0.y, p1.y), Math.max(p0.z, p1.z)].map((v) => Math.floor(v / CELL));
      seen.clear();
      let bestT = Infinity;
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const b = grid.get(key(x, y, z));
        if (!b) continue;
        for (const ti of b) {
          if (seen.has(ti)) continue;
          seen.add(ti);
          const t = tris[ti];
          // Möller–Trumbore, segment form (0 <= t <= 1).
          e1.set(t[3] - t[0], t[4] - t[1], t[5] - t[2]);
          e2.set(t[6] - t[0], t[7] - t[1], t[8] - t[2]);
          pv.crossVectors(dir, e2);
          const det = e1.dot(pv);
          if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det;
          tv.set(p0.x - t[0], p0.y - t[1], p0.z - t[2]);
          // A small barycentric tolerance so adjacent triangles OVERLAP at their shared edges: a
          // path grazing the seam between a lane wall and the extension above it slipped between
          // the two exact tests (Spiral Works' Split-A mouth).
          const u = tv.dot(pv) * inv;
          if (u < -SEAM || u > 1 + SEAM) continue;
          qv.crossVectors(tv, e1);
          const v = dir.dot(qv) * inv;
          if (v < -SEAM || u + v > 1 + SEAM) continue;
          const tt = e2.dot(qv) * inv;
          if (tt < 0 || tt > 1 || tt >= bestT) continue;
          bestT = tt;
          n.crossVectors(e1, e2).normalize();
          if (n.dot(dir) > 0) n.negate();
          outNormal.copy(n);
        }
      }
      if (bestT === Infinity) return false;
      outPoint.set(p0.x + dir.x * bestT, p0.y + dir.y * bestT, p0.z + dir.z * bestT).addScaledVector(outNormal, radius + 0.05);
      return true;
    };
  }

  const RIM_H = 20;
  const rimDebug = { filled: 0, entrances: 0 };
  const RIM_BINS = 72;
  /** Append a vertical wall around a funnel's rim to `out` (a triangle soup). See buildTrack. */
  function buildRimWall(wx, wy, wz, out) {
    const n = wx.length;
    let minY = Infinity, maxY = -Infinity, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { minY = Math.min(minY, wy[i]); maxY = Math.max(maxY, wy[i]); cx += wx[i]; cz += wz[i]; }
    cx /= n; cz /= n;
    const top = maxY - (maxY - minY) * 0.25;
    const bins = new Array(RIM_BINS).fill(null);
    for (let i = 0; i < n; i++) {
      if (wy[i] < top) continue;
      const dx = wx[i] - cx, dz = wz[i] - cz, r = Math.hypot(dx, dz);
      const b = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * RIM_BINS) % RIM_BINS;
      if (!bins[b] || r > bins[b].r) bins[b] = { r, p: new THREE.Vector3(wx[i], wy[i], wz[i]) };
    }
    // Leave open the angular sector each lane end faces the funnel through: that is an entrance
    // (a feed channel ending at or above the rim — Spiral Works' drops in from well above it) or an
    // exit. Only END rings count, and only ones level with or above the rim and near it
    // horizontally; the lanes the funnel drains into start far below it.
    let maxR = 0;
    for (const b of bins) if (b) maxR = Math.max(maxR, b.r);
    const ang = (x, z) => Math.atan2(z - cz, x - cx);
    const sectors = [];
    for (const L of LANES) {
      for (const r of [0, L.n - 1]) {
        const px = L.P[r * 3], py = L.P[r * 3 + 1], pz = L.P[r * 3 + 2];
        if (Math.hypot(px - cx, pz - cz) > maxR + 30 || py < top - 15 || py > maxY + 45) continue;
        const a = [ang(L.B[r * 3], L.B[r * 3 + 2]), ang(L.C[r * 3], L.C[r * 3 + 2]), ang(px, pz)];
        sectors.push({ mid: a[2], half: Math.max(...a.map((x) => Math.abs(Math.atan2(Math.sin(x - a[2]), Math.cos(x - a[2]))))) + 0.15 });
      }
    }
    const nearLane = (m) => sectors.some((sc) => {
      const a = ang(m.x, m.z);
      return Math.abs(Math.atan2(Math.sin(a - sc.mid), Math.cos(a - sc.mid))) <= sc.half;
    });
    const up = new THREE.Vector3(0, RIM_H, 0);
    // Join consecutive FILLED bins: a low-poly funnel (Grand Spiral's has 18 rim vertices) leaves
    // most bins empty, and joining only adjacent bins built no wall at all.
    const rim = bins.filter(Boolean);
    rimDebug.filled = rim.length;
    for (let b = 0; b < rim.length; b++) {
      const a = rim[b], c = rim[(b + 1) % rim.length];
      const mid = a.p.clone().add(c.p).multiplyScalar(0.5);
      if (nearLane(mid)) { rimDebug.entrances++; continue; }
      const a2 = a.p.clone().add(up), c2 = c.p.clone().add(up);
      out.push(a.p.x, a.p.y, a.p.z, c.p.x, c.p.y, c.p.z, c2.x, c2.y, c2.z);
      out.push(a.p.x, a.p.y, a.p.z, c2.x, c2.y, c2.z, a2.x, a2.y, a2.z);
    }
  }

  const _lp = new THREE.Vector3();
  /**
   * Refine a main-line projection against the lanes that span its `s`: pick the lane whose floor
   * the point is actually over (smallest overhang past the floor edge, then nearest the floor)
   * and restate lateral/height in THAT lane's frame. Leaves `out` on the main frame when no lane
   * covers `s` (the funnel, a free fall).
   */
  function refineLane(x, y, z, out) {
    out.lane = -1;
    out.hw = halfWidthAt(out.s);
    out.reach = out.hw;
    let bestScore = Infinity;
    for (let li = 0; li < LANES.length; li++) {
      const L = LANES[li];
      if (out.s < L.s0 - 30 || out.s > L.s1 + 30) continue;
      // Nearest ring in space, starting from the ring whose mapped `s` matches.
      let lo = 0, hi = L.n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (L.S[m] < out.s) lo = m + 1; else hi = m; }
      let k = lo, kd = Infinity;
      for (let r = Math.max(0, lo - 4); r <= Math.min(L.n - 1, lo + 4); r++) {
        const dx = x - L.P[r * 3], dy = y - L.P[r * 3 + 1], dz = z - L.P[r * 3 + 2];
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < kd) { kd = dd; k = r; }
      }
      _lp.set(x - L.P[k * 3], y - L.P[k * 3 + 1], z - L.P[k * 3 + 2]);
      const lat = _lp.x * L.R[k * 3] + _lp.y * L.R[k * 3 + 1] + _lp.z * L.R[k * 3 + 2];
      const h = _lp.x * L.U[k * 3] + _lp.y * L.U[k * 3 + 1] + _lp.z * L.U[k * 3 + 2];
      const score = Math.max(0, Math.abs(lat) - L.HW[k]) + Math.abs(h - 1);
      if (score < bestScore) {
        bestScore = score;
        out.lane = li; out.ring = k;
        out.lateral = lat; out.height = h; out.hw = L.HW[k]; out.reach = L.REACH[k];
      }
    }
    return out;
  }

  /**
   * Build the course: scene graph, collision bodies, and the progress accessors the game measures
   * against. The model must already be loaded — call loadModel() first.
   *
   * NOTE on scale: the loaded scene's ROOT is scaled by SCALE before updateMatrixWorld, so every
   * mesh's matrixWorld already carries it. Both collision helpers therefore transform by
   * matrixWorld and stop — applying SCALE again would build every collider at 16x the geometry it
   * is supposed to match.
   *
   * @param {CANNON.World} world
   * @param {object} materials from physics.js createWorld()
   * @param {number} marbleCount size of the starting field
   * @param {THREE.Group} model the parsed glTF scene from loadModel()
   */
  function buildTrack(world, materials, marbleCount, model) {
    const group = new THREE.Group();
    const bodies = [];
    const paddles = [];   // { body, mesh } — visual node driven from its kinematic body each frame
    const motors = [];
    const kickers = [];   // telegraphed push bands, driven by game.js _applyKickers

    // One shared instance of the model per page: clone so a rebuild cannot mutate the cache.
    const scene = model.clone(true);
    scene.scale.setScalar(SCALE);
    scene.updateMatrixWorld(true);

    // The authored materials carry any embedded textures; only the sampling needs fixing up.
    // scene.js raises THREE.Texture.DEFAULT_ANISOTROPY to the hardware ceiling, but GLTFLoader
    // builds its textures from the file's own sampler settings and never sees that default, so
    // without this the track surfaces alias into crawling moiré at grazing camera angles — the
    // same shimmer the procedural textures were fixed for.
    const aniso = THREE.Texture.DEFAULT_ANISOTROPY;
    const seenTex = new Set();

    const trackMeshes = [];
    const propNodes = [];
    const kickerNodes = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      if (hideNodes && hideNodes.test(o.name)) { o.visible = false; return; }
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (mat && mat.map && !seenTex.has(mat.map)) {
          seenTex.add(mat.map);
          mat.map.anisotropy = aniso;
          mat.map.needsUpdate = true;
        }
      }
      if (/^Track-/.test(o.name)) trackMeshes.push(o);
      else if (/^Obs-/.test(o.name)) propNodes.push(o);
      else if (/^Deco-Kicker/.test(o.name)) kickerNodes.push(o);
    });

    // ── kickers ──
    // A telegraphed, push-only band: it brightens as it charges (the TELL), then fires, shoving
    // whatever is crossing it sideways — alternating by marble index so a shot SPLITS the pack
    // rather than moving it. game.js owns all of that (_applyKickers / _fireKicker); the course
    // only supplies the band and something to light up.
    //
    // Bands are NORMALIZED fractions of the course, not world arclength — _fireKicker compares
    // against `m.s / this.track.length`. That is the opposite convention to inBoost(s), which
    // takes world units, and getting them the wrong way round silently fires the kicker at the
    // wrong end of the course rather than erroring.
    //
    // The material is CLONED per kicker. GLTFLoader hands every mesh sharing one Blender material
    // the same instance, so without this, charging one band would light all of them at once.
    kickerNodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (let i = 0; i < kickerNodes.length && i < KICKER_BANDS.length; i++) {
      const mesh = kickerNodes[i];
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const own = mat ? mat.clone() : new THREE.MeshStandardMaterial();
      mesh.material = own;
      kickers.push({ band: KICKER_BANDS[i], mesh, mat: own, period: KICKER_PERIODS[i % KICKER_PERIODS.length], _lastPhase: 0 });
    }

    // ── static track surfaces ──
    // One body per CHUNK, not per authored segment — see chunkedTrimeshes for why that distinction
    // is worth ~14x of the frame budget. Each chunk is its own body so the broadphase can reject
    // it on a tight AABB.
    const addStatic = (shape, material) => {
      const body = new CANNON.Body({ mass: 0, material });
      body.addShape(shape);
      world.addBody(body);
      bodies.push(body);
    };
    const addSurface = (shape) => addStatic(shape, materials.surface);

    const shellSoup = [];   // every static track triangle, for the swept guard (see below)

    // The swept channels collide against the BAKED shell, not the rendered mesh — only the surface
    // a marble can actually reach, decimated along the sweep. See the course's track*-collision.js
    // and the baker for what that costs in fidelity (essentially nothing) and buys in frame time
    // (5.3x fewer triangles to test).
    //
    // The shell is emitted as one vertex buffer with a SEPARATE index array per contact material,
    // so a rumble band or a washboard stretch is the same geometry bound to a different
    // ContactMaterial rather than a second overlapping surface. Overlapping it would have given a
    // marble two floors to resolve against in the same step, which is how you get jitter.
    {
      const n = COL_VERTS.length / 3;
      const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        cx[i] = COL_VERTS[i * 3] * SCALE;
        cy[i] = COL_VERTS[i * 3 + 1] * SCALE;
        cz[i] = COL_VERTS[i * 3 + 2] * SCALE;
      }
      const zoned = [
        [COL.INDICES, materials.surface],
        [COL.RUMBLE_INDICES, materials.rumble],
        [COL.BUMP_INDICES, materials.bump],
        [COL.ICE_INDICES, materials.ice],
      ];
      for (const [indices, material] of zoned) {
        if (!indices || !indices.length) continue;
        for (const shape of chunkedTrimeshes(cx, cy, cz, indices)) addStatic(shape, material);
        for (let t = 0; t < indices.length; t++) {
          const v = indices[t];
          shellSoup.push(cx[v], cy[v], cz[v]);
        }
      }
    }

    // A collider model (the parts of a course with no baked shell: a well, a slide, a tray) collides
    // as authored. It is a closed, outward-facing solid, so faces pointing well downward (the
    // underside) are unreachable and dropped.
    if (_colliderScene) {
      const cs = _colliderScene.clone(true);
      cs.scale.setScalar(SCALE);
      cs.updateMatrixWorld(true);
      cs.traverse((o) => {
        if (!o.isMesh || (colliderNodes && !colliderNodes.test(o.name))) return;
        const { wx, wy, wz, indices } = worldTriangles(o);
        const reachable = (a, b, c) => {
          const e1x = wx[b] - wx[a], e1y = wy[b] - wy[a], e1z = wz[b] - wz[a];
          const e2x = wx[c] - wx[a], e2y = wy[c] - wy[a], e2z = wz[c] - wz[a];
          const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          return ny > -0.6 * Math.hypot(nx, ny, nz);
        };
        for (const shape of chunkedTrimeshes(wx, wy, wz, indices, reachable)) addSurface(shape);
        for (let t = 0; t < indices.length; t += 3) {
          const a = indices[t], b = indices[t + 1], c = indices[t + 2];
          if (reachable(a, b, c)) shellSoup.push(wx[a], wy[a], wz[a], wx[b], wy[b], wz[b], wx[c], wy[c], wz[c]);
        }
      });
    }

    // A funnel is not a swept channel, so the baker has no ring structure to loft a shell from and
    // it collides against its rendered geometry. Its reachable surface is the inside of the cone,
    // whose normals all point upward, so a single normal test culls the underside exactly.
    //
    // The funnel also gets a RIM WALL: marbles arriving fast spin up and over its lip —
    // 30 of Grand Spiral's census losses. The rim is the outermost top vertex per angle bin around
    // the funnel's axis, extruded straight up RIM_H. Bins where a lane meets the rim (the channel
    // that feeds the funnel) are left open, or the wall would shut the entrance.
    const rimWalls = [];
    if (bowlMeshName) {
      for (const mesh of trackMeshes) {
        if (mesh.name !== bowlMeshName) continue;
        const { wx, wy, wz, indices } = worldTriangles(mesh);
        const upwardFacing = (a, b, c) => {
          const e1x = wx[b] - wx[a], e1y = wy[b] - wy[a], e1z = wz[b] - wz[a];
          const e2x = wx[c] - wx[a], e2y = wy[c] - wy[a], e2z = wz[c] - wz[a];
          return e1z * e2x - e1x * e2z > 0;   // the +Y component of (e1 x e2)
        };
        for (const shape of chunkedTrimeshes(wx, wy, wz, indices, upwardFacing)) addSurface(shape);
        for (let t = 0; t < indices.length; t += 3) {
          const a = indices[t], b = indices[t + 1], c = indices[t + 2];
          if (!upwardFacing(a, b, c)) continue;
          shellSoup.push(wx[a], wy[a], wz[a], wx[b], wy[b], wz[b], wx[c], wy[c], wz[c]);
        }
        buildRimWall(wx, wy, wz, rimWalls);
      }
    }

    // ── containment: colliders + glass (see CONTAIN above) ──
    // Colliders from the same soup the glass is drawn from, so what you see is what stops you.
    const soupBodies = (soup) => {
      const n = soup.length / 3;
      const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
      for (let i = 0; i < n; i++) { wx[i] = soup[i * 3]; wy[i] = soup[i * 3 + 1]; wz[i] = soup[i * 3 + 2]; }
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      for (const shape of chunkedTrimeshes(wx, wy, wz, idx)) addSurface(shape);
    };
    soupBodies(CONTAIN.walls);
    soupBodies(CONTAIN.lids);
    soupBodies(CONTAIN.floors);
    soupBodies(rimWalls);
    // The guard covers the WHOLE course, not just the containment: a marble's centre never has a
    // legitimate reason to cross any track surface, and the original shell walls tunnel exactly
    // like the new ones (the Split-A mouth on Spiral Works lost marbles through its own lane wall).
    const sweepGuard = createSweepGuard([CONTAIN.walls, CONTAIN.lids, CONTAIN.floors, rimWalls, shellSoup]);
    const glass = (soup, opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0xcfefff, roughness: 0.05, metalness: 0, transparent: true, opacity,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.userData.noAO = true;   // transparent: keep it out of GTAO's prepass (scene.js)
      mesh.name = 'ContainmentGlass';
      group.add(mesh);
    };
    // Walls only: the lid stays an invisible collider. A glass ceiling over every channel reads as
    // a haze over the whole course.
    // No rail along the lid edges either: the bright line floating over the track reads as clutter.
    glass(CONTAIN.walls, 0.1);
    if (rimWalls.length) glass(rimWalls, 0.1);

    // ── brake bands ──
    // Amber rumble strips before the narrow lane mouths: marbles reach them at the 85 u/s
    // speed cap. game.js caps speed on them (brakeAt); this is the painted strip that says so.
    for (const [a, b] of BRAKE_BANDS) group.add(floorBand(a, b, brakeTexture(), 0.3, 'BrakeBand'));

    // ── obstacle primitives ──
    for (const node of propNodes) {
      const box = worldBox(node);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      if (/^Obs-Peg/.test(node.name)) {
        // Authored as a short vertical cylinder. cannon-es builds Cylinder along +Y, which matches
        // the authored orientation, so no shape rotation is needed.
        const r = Math.max(size.x, size.z) / 2;
        const body = new CANNON.Body({ mass: 0, material: materials.obstacle });
        body.addShape(new CANNON.Cylinder(r, r, size.y, 10));
        body.position.set(centre.x, centre.y, centre.z);
        world.addBody(body);
        bodies.push(body);
      } else if (/^Obs-Gate/.test(node.name)) {
        const body = new CANNON.Body({ mass: 0, material: materials.obstacle });
        body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)));
        body.position.set(centre.x, centre.y, centre.z);
        world.addBody(body);
        bodies.push(body);
      } else if (/^Obs-TimedGate/.test(node.name)) {
        // A bar that sweeps across the lane, blocking it for half of each turn — so a route is
        // only open part of the time.
        //
        // IT ROTATES; IT DOES NOT RISE AND FALL. A lift was the obvious build and it is a marble
        // trap: a kinematic slab has infinite mass, and on its downstroke the contact normal
        // against a marble already resting on the floor points straight down, so the marble has
        // nowhere to be pushed and is simply pinned. Measured in simulation, marbles parked under
        // the descending gates and the field stopped there. A body that SWEEPS always clears
        // again by construction — the same reason the paddles are built this way — so the lane
        // reopens no matter what is in it.
        const pivot = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
        const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: materials.obstacle });
        body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)));
        body.position.set(pivot.x, pivot.y, pivot.z);
        const sign = /-1$/.test(node.name) ? -1 : 1;
        body.angularVelocity.set(0, sign * GATE_SPIN, 0);
        world.addBody(body);
        bodies.push(body);
        motors.push({ body, speed: sign * GATE_SPIN });
        node.removeFromParent();
        node.scale.setScalar(SCALE);
        group.add(node);
        paddles.push({ body, mesh: node });
      } else if (/^Obs-Paddle/.test(node.name)) {
        // Two crossed blades, each 5.8 x 1.6 x 0.3 in authored units, sitting ABOVE the node
        // origin (the mesh spans y 0..1.6), so the pivot is the node position and the shapes are
        // offset up by half the blade height.
        const pivot = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
        const bladeLen = 2.9 * SCALE, bladeH = 1.6 * SCALE, bladeT = 0.15 * SCALE;
        // KINEMATIC, not a hinged dynamic body on a motor. The old Gauntlet rotors were motorised
        // hinges and needed their target re-armed every single frame, because cannon-es zeroes a
        // motor the moment something stalls it — a marble wedged against a blade could stop the
        // rotor dead, and a stopped obstacle is exactly the thing that can trap the pack. A
        // kinematic body has infinite mass: it drives the pack and nothing in the pack can drive
        // it, so "the paddle always sweeps clear again" holds by construction rather than by
        // repair. Marbles still take a proper impulse off it — cannon-es feeds a kinematic body's
        // velocity into contact resolution.
        const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: materials.spinner });
        const lift = new CANNON.Vec3(0, bladeH / 2, 0);
        body.addShape(new CANNON.Box(new CANNON.Vec3(bladeLen, bladeH / 2, bladeT)), lift);
        body.addShape(new CANNON.Box(new CANNON.Vec3(bladeT, bladeH / 2, bladeLen)), lift);
        body.position.set(pivot.x, pivot.y, pivot.z);
        // Direction is taken from a trailing -1 in the name (the pair counter-rotates); the RATE
        // is not — see PADDLE_SPEED.
        const sign = /-1$/.test(node.name) ? -1 : 1;
        body.angularVelocity.set(0, sign * PADDLE_SPEED, 0);
        world.addBody(body);
        bodies.push(body);
        motors.push({ body, speed: sign * PADDLE_SPEED });

        // The prop is now driven by its body, so detach it from the authored transform and let
        // the frame loop write it. Reparenting to the group keeps it out of the scaled subtree,
        // so body-space and mesh-space agree.
        node.removeFromParent();
        node.scale.setScalar(SCALE);
        group.add(node);
        paddles.push({ body, mesh: node });
      }
    }

    group.add(scene);

    // ── finish line ──
    // A chequered banner laid across the channel at FINISH_S, built at RUNTIME from the baked
    // centerline rather than modelled into the GLB. Two reasons it has to work this way: map 2
    // has no source .blend to add a stripe to, and its finish has since MOVED to the foot of the
    // Track-LowerA loop (finishS in maps.js), so anything modelled in would now be in the wrong
    // place. Generated from FINISH_S it is correct on every course by construction, and it
    // follows the channel's real width and banking instead of being a flat quad laid over them.
    //
    // Decorative only — no collider. It is lifted clear of the floor and given a polygon offset
    // so it cannot z-fight the surface it sits on.
    {
      const BAND = 26;
      const s0 = Math.max(0, TRACK.FINISH_S - BAND * 0.5);
      group.add(floorBand(s0, s0 + BAND, checkerTexture(), 0.35, 'FinishBanner'));
    }

    // ── starting grid ──
    // Laid out across the start straight in rows, widest first: the field has to fit the AUTHORED
    // channel, so the column count is derived from the real half-width at each row's own
    // arclength rather than from a fixed chute width.
    const COL_SPACING = grid.colSpacing ?? 3.4;    // > one marble diameter plus margin
    // Rows were 8 units apart, which packed the whole 101-marble field into 88 units of a start
    // straight that is nearly 1000 long. Spiral Works' channel narrows from 40 units wide at the
    // gate to 24 within the first 130, and a pack that dense arriving at that taper jams: the tail
    // was measured sitting motionless for tens of seconds, and freed itself the instant the
    // marbles around it were removed. Spreading the grid out costs nothing and lets the field
    // feed through.
    const ROW_GAP = grid.rowGap ?? 14;             // world units of arclength between rows
    const WALL_CLEAR = grid.wallClear ?? 6;
    const startPositions = [];
    {
      const p = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
      let slot = 0, row = 0;
      while (slot < marbleCount) {
        const s = 6 + row * ROW_GAP;
        const usable = Math.max(6, halfWidthAt(s) * 2 - WALL_CLEAR);   // clear of both walls
        const cols = Math.max(1, Math.min(18, Math.floor(usable / COL_SPACING)));
        const span = Math.min(usable, (cols - 1) * COL_SPACING);
        centerAt(s, p); rightAt(s, right); upAt(s, up);
        for (let c = 0; c < cols && slot < marbleCount; c++, slot++) {
          const lateral = cols === 1 ? 0 : (c / (cols - 1) - 0.5) * span;
          startPositions.push(p.clone()
            .addScaledVector(right, lateral)
            .addScaledVector(up, TRACK.MARBLE_R * 1.25 + 0.6));
        }
        row++;
      }
    }
    // Put the player's marble (index 0, the red one) in the MIDDLE of the pack rather than the
    // front-left corner — it starts on an even footing with a race in front of and behind it.
    const centralSlot = Math.floor(startPositions.length / 2);
    if (centralSlot > 0) {
      const tmp = startPositions[0];
      startPositions[0] = startPositions[centralSlot];
      startPositions[centralSlot] = tmp;
    }

    const overviewTarget = centerAt(0, new THREE.Vector3());

    return {
      group,
      bodies,
      paddles,
      // OPTIONAL on the track interface, like inBoost — omitted entirely when the course has no
      // kicker bands so game.js's feature detection keeps working.
      ...(kickers.length ? { kickers } : {}),
      startPositions,
      length: TRACK.LENGTH,
      finishS: TRACK.FINISH_S,
      overviewTarget,

      /**
       * Project a body position onto the centerline. Pass the caller's previous index as `hint`
       * to keep this to a short local scan — see project().
       */
      project: (pos, hint, out) => project(pos.x, pos.y, pos.z, hint === undefined ? -1 : hint, out),

      centerAt: (s, out) => centerAt(s, out),
      dirAt: (s, out) => dirAt(s, out),
      rightAt: (s, out) => rightAt(s, out),
      upAt: (s, out) => upAt(s, out),
      halfWidthAt,

      // Boost pads. OPTIONAL on the track interface — present only when the course baked some,
      // so game.js's feature detection keeps working for courses that have none. The pads have no
      // collider of their own: this is a predicate, and game.js accelerates whatever is on top.
      ...(BOOST_BANDS.length ? {
        inBoost: (s) => {
          for (let i = 0; i < BOOST_BANDS.length; i++) {
            if (s >= BOOST_BANDS[i][0] && s <= BOOST_BANDS[i][1]) return true;
          }
          return false;
        },
        // Ceiling for boosted marbles on THIS course, overriding game.js's BOOST_MAX_SPEED.
        //
        // Not a tuning preference — a hard limit set by the collider. cannon-es has no continuous
        // collision detection and this course's shell is a single open surface with no thickness
        // behind it, so a marble is only caught if it still overlaps the floor when a step is
        // sampled: it must not travel more than its own 2-unit diameter per step. At
        // physics.FIXED_DT = 1/60 that is 120 u/s, which is why marbles.js clamps everything else
        // to 85. game.js's default boost ceiling is 150 — comfortably PAST the tunnelling speed —
        // and a marble that leaves through the floor is gone, not slow.
        boostMaxSpeed: 110,
      } : {}),

      /**
       * Signed lateral position across the channel: 0 = centerline, ±1 = at the wall. Clamped a
       * little past 1 because a marble riding a banked turn legitimately sits outside the flat
       * half-width. Drives the HUD edge gauge.
       */
      lateralOf: (proj) => {
        const hw = halfWidthAt(proj.s);
        return Math.max(-1.4, Math.min(1.4, proj.lateral / Math.max(1, hw)));
      },

      /**
       * Has this marble left the course?
       *
       * Judged in the track's LOCAL frame, which is what makes a single height test correct here.
       * A world-Y test cannot work on a course that banks to near-vertical — a marble riding the
       * Spiral Works wall-of-death is far below the centerline in world Y while being perfectly in
       * bounds. In the local frame the banking is already accounted for, so a marble on ANY part of
       * the surface reads height ~ +1 (its own radius) and one that has left it reads sharply
       * negative.
       *
       * These are deliberately OR'd. They were AND'd at first, which sounds safer and is not: a
       * marble dropping straight through a gap in the floor — the splitter mouths do have them —
       * falls with lateral ~ 0, satisfied the height test alone, and so was never retired at all.
       * It just kept falling while still holding its place in the standings.
       */
      isOutOfBounds: (proj) => proj.height < -OOB_DROP
        || Math.abs(proj.lateral) > (proj.lane >= 0 ? proj.reach : halfWidthAt(proj.s)) + OOB_LATERAL,

      // Speed cap on a brake band at `s`, 0 elsewhere (game.js _applyBrakes).
      ...(BRAKE_BANDS.length ? { brakeAt } : {}),
      // Where the checkpoint arches stand (maps.js) and sector times split (game.js).
      checkpoints: CHECKPOINTS,
      // OPTIONAL: a steady push along the course (game.js _applyDrive).
      ...(driveAccel ? { driveAccel } : {}),
      // Per-lane containment coverage, for the map certification test's diagnostics.
      containment: CONTAIN.stats,
      laneNames: LANES.map((l) => l.name),
      rimSegments: rimWalls.length / 18,
      rimDebug,
      // Swept check against the containment surfaces — see createSweepGuard.
      sweepGuard,

      /**
       * Which way the course runs at a projected position: along the marble's own lane where it
       * has one (across a junction the main line's tangent is turned ~90° to the channel), else
       * along the main line. game.js aims its unstick nudge with this.
       */
      flowDir: (proj, out) => {
        if (proj.lane < 0) return dirAt(proj.s, out);
        const L = LANES[proj.lane];
        const a = Math.min(proj.ring, L.n - 2);
        return out.set(L.P[(a + 1) * 3] - L.P[a * 3], L.P[(a + 1) * 3 + 1] - L.P[a * 3 + 1], L.P[(a + 1) * 3 + 2] - L.P[a * 3 + 2]).normalize();
      },

      /**
       * Floor point directly beneath a marble, for its contact shadow. Projected onto the local
       * floor PLANE rather than to a world-Y height, so the shadow stays planted on banked turns.
       */
      floorPoint: (pos, proj, out) => {
        const L = proj.lane >= 0 ? LANES[proj.lane] : null;
        const up = L ? _scratchUp.fromArray(L.U, proj.ring * 3) : upAt(proj.s, _scratchUp);
        return out.set(pos.x, pos.y, pos.z).addScaledVector(up, -proj.height + 0.06);
      },

      /**
       * Re-assert the paddles' spin. The bodies are kinematic so nothing in the pack can slow
       * them, but cannon-es integrates a kinematic body's angular velocity into its quaternion and
       * this keeps the rate exact against any drift.
       */
      driveMotors() {
        for (const m of motors) m.body.angularVelocity.set(0, m.speed, 0);
      },

      dispose() {
        for (const b of bodies) world.removeBody(b);
        // NOTHING three.js is freed here, and that is deliberate. THREE.Object3D.clone() copies the
        // node graph but SHARES geometries and materials with its source, and the source is the
        // cached glTF scene that loadModel() hands to every later build. Disposing them here would
        // free the GPU buffers out from under that cache: this race would end fine and the next
        // visit to the page would build a track out of destroyed geometry and render nothing. The
        // cache is page-lifetime by design, so its resources outlive any one track.
      },
    };
  }

  return { TRACK, loadModel, buildTrack, project, centerAt, dirAt, rightAt, upAt, halfWidthAt };
}
