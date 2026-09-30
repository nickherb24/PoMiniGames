// maps.js — the marble-race map registry, and the single track interface the game speaks to.
//
// Slots 1-9. Slot 1 is the original procedural chute, slot 2 is the authored marble_track.glb
// course, slot 3 is marble_track_2.glb, and 4-9 are free for further GLB courses. TO ADD A MAP,
// see ADDING A GLB MAP below — it is a handful of lines here plus one bake, with nothing to
// change in game.js.
//
// ── THE TRACK INTERFACE ─────────────────────────────────────────────────────────────────────
// The two existing maps are built on completely different premises. The procedural chute is a
// straight descent whose progress IS its world +Z coordinate. The GLB course spirals back over
// itself, banks to near-vertical and branches, so it has no such coordinate and measures progress
// as arclength along a baked centerline. Rather than teach the game about both, every map is
// presented through one interface keyed on `s` — distance along the course in world units:
//
//   group            THREE.Object3D holding everything the map renders
//   startPositions   Vector3[] — one per marble, in grid order
//   length           total course length in world units
//   finishS          `s` at which a marble is scored as finished
//   overviewTarget   Vector3 the pick-phase camera frames
//   paddles          [{ body, mesh }] driven props whose meshes follow their bodies each frame
//   project(pos, hint, out)  world position -> { s, index, lateral, height }, `index` being an
//                    opaque hint to pass back next frame to keep the search local
//   centerAt/dirAt/rightAt/upAt(s, out)   the local frame at `s`
//   halfWidthAt(s)   half the channel width at `s`
//   lateralOf(proj)  signed position across the channel, 0 centre / ±1 at the wall
//   isOutOfBounds(proj)   has this marble left the course?
//   floorPoint(pos, proj, out)  the point on the floor beneath a marble, for its contact shadow
//   driveMotors()    re-assert any powered obstacle each frame
//   dispose()
//
// OPTIONAL, and absent on maps that have no such feature — the game feature-detects each:
//   inBoost(s)       is `s` on a boost pad?
//   brakeAt(s)       speed cap on a brake strip at `s`, 0 elsewhere (game.js _applyBrakes)
//   checkpoints      `s` of each checkpoint arch / sector split (addCheckpointArches, game.js)
//   kickers          telegraphed kicker bands (see game.js _applyKickers)
//   regenerate       true if asking for a new track means anything (procedural maps only)
//
// Each entry also says how the map was MADE and how many VERTICES it renders — both shown on the
// track picker. `vertices` was measured 2026-09-30 by building the map in the engine and summing
// every geometry in its track group (course, glass containment, arches, props); it is constant
// per map, seeds included. Re-measure after changing a course or its dressing.
// A registry entry (MAPS below) may also carry a `theme` — scene.js setTheme(): background/fog
// colour, fog range, ambient/hemisphere/key lights and exposure. The page reads names and blurbs
// from mapMenu(), so this file is the only place a map is described.
import * as THREE from 'three';
import { generateTrack } from './track-procedural.js';
import { createGlbCourse } from './track-glb.js';
import * as SPIRAL_WORKS_PATH from './track-path.js';
import * as SPIRAL_WORKS_COL from './track-collision.js';
import * as GRAND_SPIRAL_PATH from './track2-path.js';
import * as GRAND_SPIRAL_COL from './track2-collision.js';

// ── authored courses ────────────────────────────────────────────────────────────────────────
// One createGlbCourse() per GLB. The factory closes over that course's baked centerline and
// collision shell, so the two share every line of the builder and cannot drift apart — see the
// header of track-glb.js for why that mattered enough to refactor.
const spiralWorks = createGlbCourse({
  modelUrl: 'models/marble_track.glb',
  path: SPIRAL_WORKS_PATH,
  collision: SPIRAL_WORKS_COL,
  // Track-Bowl is a funnel with no ring structure, so it collides against its own geometry.
  bowlMeshName: 'Track-Bowl',
  // Rumble strips capping speed before the three split mouths: the field reached Split A at the
  // 85 u/s cap and 108 of 152 census falls happened there.
  brakeBands: [[905, 965, 46], [1480, 1536, 46], [1690, 1712, 46]],
  // FINISH EARLY, at the foot of the Track-LowerA loop (world s 2270.7, 62.3% of the geometry).
  // That loop climbs 23.3 world units and needs ~59 u/s at the bottom simply to crest, so the
  // field bunches there and almost nothing gets over — the race was being decided by game.js's
  // RACE_TIMEOUT instead of by anyone crossing a line. Everything before it descends cleanly, so
  // the line moves to 2230 (40 units clear of the climb) and the raceable course becomes the
  // race. The geometry beyond is still built and still rendered; it is simply past the line now.
  finishS: 2230,
});

const grandSpiral = createGlbCourse({
  modelUrl: 'models/marble_track_2.glb',
  path: GRAND_SPIRAL_PATH,
  collision: GRAND_SPIRAL_COL,
  // Track-Bowl2 is this course's funnel — same deal as Spiral Works' Track-Bowl.
  bowlMeshName: 'Track-Bowl2',
});

/**
 * A fresh, zeroed projection record for a caller to own and reuse. `lane`/`ring`/`hw`/`reach`
 * are filled by the authored courses (track-glb.js refineLane): which lane the marble is over,
 * that lane's floor half-width and how far its walls reach. -1 means "judged on the main line".
 */
export const newProjection = () => ({ s: 0, index: -1, lateral: 0, height: 0, lane: -1, ring: 0, hw: 0, reach: 0 });

// ── procedural adapter ──────────────────────────────────────────────────────────────────────
// The procedural chute predates the interface above and speaks in world +Z. Because it descends
// monotonically in +Z, `s` and `z` are the same number, so this adapter is a thin translation
// rather than a reimplementation — and the original generator is left exactly as it was.
const _c = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3();
// Second right-vector scratch: upAt() derives up FROM right, and its caller may be holding
// _r as its own result at the time — sharing one scratch across both would clobber it.
const _r2 = new THREE.Vector3();

// How far beneath the floor plane a marble may sit before it counts as off the chute. The
// original test was `y < floorY(z) - 58` in WORLD space; in the local frame the banking is
// already accounted for, so the margin only has to cover a hard bounce.
const PROC_OOB_DROP = 34;
const PROC_OOB_LATERAL = 26;

function adaptProceduralTrack(t) {
  // The generator's own right vector points the WRONG WAY for this interface, and this is
  // where that gets corrected (2026-09-12).
  //
  // Every consumer of the interface — steering, the lateral sign, the edge gauge — assumes
  // right = dir x up, which is the same vector a chase camera renders as screen-right, and is
  // what both baked GLB courses store. The chute's generator instead derives its basis as
  // `(1,0,0)` rotated by the quaternion that takes +Z onto dir, which is -(dir x up): with the
  // marble running down +Z that is world +X, and a camera looking down +Z renders +X to
  // screen-LEFT. So the right arrow key pushed the marble left, and only on this map.
  //
  // The fix lands here rather than in the generator because `rb` is also the basis every wall,
  // kerb and obstacle is placed along; negating it there would mirror the whole course. The
  // adapter already exists to translate this map's older conventions, so it translates one more.
  //
  // This is also what made the sibling `upAt` below wrong: right x dir recovers up only for a
  // right-handed basis, and with the generator's vector it returned -up, which put a sign error
  // straight into `height`, isOutOfBounds and floorPoint.
  const rightAt = (s, out) => (out || _r).copy(t.rightAt(s)).negate();

  // up = right x dir. The generator publishes dir and right but not up, and for a right-handed
  // basis where right = dir x up, that cross product recovers up exactly.
  const upAt = (s, out) => {
    const d = t.dirAt(s);
    return (out || _u).copy(rightAt(s, _r2)).cross(d).normalize();
  };
  const halfWidthAt = (s) => t.halfWidthAt(s);

  return {
    group: t.group,
    startPositions: t.startPositions,
    length: t.length,
    finishS: t.finishZ,
    overviewTarget: t.overviewTarget,
    paddles: t.turnstiles,
    kickers: t.kickers,
    regenerate: true,

    project(pos, hint, out) {
      const o = out || newProjection();
      const s = Math.max(0, Math.min(t.length, pos.z));
      const c = t.centerAt(s), r = rightAt(s, _r);
      upAt(s, _u);
      const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
      o.s = s;
      o.index = 0;                                     // no hint needed: the lookup is O(1)
      o.lateral = dx * r.x + dy * r.y + dz * r.z;
      o.height = dx * _u.x + dy * _u.y + dz * _u.z;
      return o;
    },

    centerAt: (s, out) => (out ? out.copy(t.centerAt(s)) : t.centerAt(s)),
    dirAt: (s, out) => (out ? out.copy(t.dirAt(s)) : t.dirAt(s)),
    rightAt: (s, out) => rightAt(s, out),
    upAt,
    halfWidthAt,
    lateralOf: (proj) => Math.max(-1.4, Math.min(1.4, proj.lateral / Math.max(1, halfWidthAt(proj.s)))),
    isOutOfBounds: (proj) =>
      proj.height < -PROC_OOB_DROP || Math.abs(proj.lateral) > halfWidthAt(proj.s) + PROC_OOB_LATERAL,
    floorPoint: (pos, proj, out) => {
      upAt(proj.s, _u);
      return out.set(pos.x, pos.y, pos.z).addScaledVector(_u, -proj.height + 0.06);
    },
    inBoost: (s) => t.inBoost(s),
    checkpoints: t.checkpoints,
    driveMotors: () => t.driveMotors(),
    dispose: () => t.dispose(),
  };
}

// ── checkpoint arches (2026-09-30) ──
// A glowing half-hoop standing over the channel at each checkpoint: where the course branches on
// the authored maps, at each hazard zone on the procedural ones. Purely visual — game.js reads the
// same `checkpoints` list for the sector splits. Built from the track interface alone, so every
// map gets them. The hoop is squashed to at most ARCH_H tall so a 100-wide channel does not grow
// a 50-high arch through the containment lid.
const ARCH_H = 16;
let _archMat = null;
function addCheckpointArches(track) {
  if (!track.checkpoints || !track.checkpoints.length) return track;
  _archMat = _archMat || new THREE.MeshStandardMaterial({
    color: 0x7c3aed, emissive: 0xa855f7, emissiveIntensity: 1.6, roughness: 0.35, metalness: 0.1,
  });
  const c = new THREE.Vector3(), d = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  for (const s of track.checkpoints) {
    const hw = track.halfWidthAt(s) + 1;
    track.centerAt(s, c); track.dirAt(s, d); track.rightAt(s, r); track.upAt(s, u);
    // Half torus in its local XY plane: X across the channel, Y up, Z along the track.
    const arch = new THREE.Mesh(new THREE.TorusGeometry(hw, 0.7, 8, 40, Math.PI), _archMat);
    basis.makeBasis(r, u, d);
    arch.quaternion.setFromRotationMatrix(basis);
    arch.scale.set(1, Math.min(1, ARCH_H / hw), 1);
    arch.position.copy(c);
    arch.name = 'CheckpointArch';
    track.group.add(arch);
  }
  return track;
}

// ── registry ────────────────────────────────────────────────────────────────────────────────
//
// ADDING A GLB MAP (slots 4-9):
//   1. Drop the model in wwwroot/models/. It must satisfy the ring-major swept-channel layout the
//      baker asserts — see the EXPORT CONTRACT in scripts/build-marble-track-2.py, which
//      generates a conforming course from scratch and is the easiest starting point.
//   2. Add an entry to COURSES in scripts/bake-marble-track.mjs naming the model, its output
//      files and its segment order, then run `node scripts/bake-marble-track.mjs <id>`. That
//      emits the centerline and the collision shell. Check its slope table before going further:
//      any segment it flags as below friction is a place the pack can stall.
//   3. Import the two generated modules here, call createGlbCourse() with them, and add an entry
//      below with the next free `id`.
// `load` is awaited once before the first build and may return anything the map needs; whatever
// it resolves to is handed back to `build` as `asset`.
// Canyon Run: the chute recipe, longer and narrower with a different hazard mix. The kicker band
// sits between the plinko and the rumble strip; bobs are dropped (from > to) for a longer plinko.
const CANYON_RUN = {
  track: { LENGTH: 2200, DROP: 930, START_Y: 180, CHANNEL_WIDTH: 50, SEGMENTS: 640 },
  zones: {
    RIDGES: { from: 0.06, to: 0.16, step: 0.035 },
    BOOST: [[0.18, 0.21], [0.47, 0.50], [0.64, 0.67], [0.83, 0.86]],
    PLINKO: { from: 0.24, to: 0.40, rows: 9 },
    KICKERS: [0.415, 0.435],
    RUMBLE: [[0.44, 0.46], [0.60, 0.63]],
    BOBS: { from: 1, to: 0, step: 0.04 },
    TURNSTILES: { from: 0.69, to: 0.80, step: 0.037 },
    GAUNTLET: { from: 0.87, to: 0.925, step: 0.018 },
    FINISH: [0.93, 1.0],
  },
  pinches: [{ c: 0.22, w: 0.04, d: 0.45 }, { c: 0.55, w: 0.05, d: 0.5 }, { c: 0.855, w: 0.03, d: 0.4 }],
  curve: 1.2,
};

const MAPS = [
  {
    id: 1,
    name: 'Neon Chute',
    made: 'Built in code — procedural generator',
    vertices: 22394,
    blurb: 'Procedural — a new chute every race, with boost pads, rumble strips and the Gauntlet.',
    // Night: the chute's neon emissives are the light show, so the fill drops and goes violet.
    theme: {
      bg: 0x070a1c, fogNear: 70, fogFar: 240,
      ambient: [0x9ea4cc, 2.6], hemi: [0xb89cff, 0x1a1030, 1.7], key: [0xd8e0ff, 2.6], exposure: 1.1,
    },
    load: () => Promise.resolve(null),
    build: (world, materials, marbleCount, _asset, seed) =>
      addCheckpointArches(adaptProceduralTrack(generateTrack(world, materials, seed >>> 0, marbleCount))),
  },
  {
    id: 2,
    name: 'Spiral Works',
    made: 'Modelled by hand in Blender',
    vertices: 70316,
    blurb: 'A four-turn helix into split lanes, a funnel, two banked loops and a hazard fan.',
    // Factory floor under sodium lamps: warm key, rust-brown ground bounce, smoky brown haze.
    theme: {
      bg: 0x17130f, fogNear: 78, fogFar: 250,
      ambient: [0xc4b59c, 3.3], hemi: [0xffd9a8, 0x3a2a1c, 2.0], key: [0xffc98a, 3.2], exposure: 1.12,
    },
    load: () => spiralWorks.loadModel(),
    build: (world, materials, marbleCount, asset) => addCheckpointArches(spiralWorks.buildTrack(world, materials, marbleCount, asset)),
  },
  {
    id: 3,
    name: 'Grand Spiral',
    made: 'Generated in Blender by a Python script',
    vertices: 52430,
    blurb: 'A wide weave: a risky split, washboard, a funnel, a free fall and boost pads to the line.',
    // Open daytime sky: pale blue haze pushed further out, bright neutral sun.
    theme: {
      bg: 0x7fb0d8, fogNear: 150, fogFar: 560,
      ambient: [0xd0d8e0, 2.8], hemi: [0xbcdcff, 0x6a6450, 2.0], key: [0xffeccc, 4.0], exposure: 0.95,
    },
    load: () => grandSpiral.loadModel(),
    build: (world, materials, marbleCount, asset) => addCheckpointArches(grandSpiral.buildTrack(world, materials, marbleCount, asset)),
  },
  {
    id: 4,
    name: 'Canyon Run',
    made: 'Built in code — procedural generator',
    vertices: 22828,
    blurb: 'Procedural at dusk — a longer, tighter canyon: twin kicker gates, a long plinko and a double Gauntlet.',
    // Built from the Neon Chute recipe (track-procedural.js), whose 44-tall walls have never lost
    // a marble. Narrower, longer and twistier, with a different hazard mix.
    theme: {
      bg: 0x3b2233, fogNear: 90, fogFar: 330,
      ambient: [0xffd2b0, 2.8], hemi: [0xffb38a, 0x3a2418, 1.8], key: [0xffa060, 3.4], exposure: 1.05,
    },
    load: () => Promise.resolve(null),
    build: (world, materials, marbleCount, _asset, seed) =>
      addCheckpointArches(adaptProceduralTrack(generateTrack(world, materials, seed >>> 0, marbleCount, CANYON_RUN))),
  },
];

/** Every registered map, in slot order. */
export const MAP_LIST = MAPS;

/** The slot the game opens on when nothing has been chosen. */
export const DEFAULT_MAP_ID = 2;

/** Look a map up by slot id, falling back to the default rather than throwing. */
export function mapById(id) {
  return MAPS.find((m) => m.id === Number(id)) || MAPS.find((m) => m.id === DEFAULT_MAP_ID) || MAPS[0];
}

/** Slot ids and names, for the host's map picker. */
export function mapMenu() {
  return MAPS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb, made: m.made, vertices: m.vertices }));
}
