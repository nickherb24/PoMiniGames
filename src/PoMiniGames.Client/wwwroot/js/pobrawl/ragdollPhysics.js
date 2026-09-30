// ragdollPhysics.js — true rigid-body KO ragdoll on cannon-es.
//
// The one and only ragdoll: at the final KO the fighter hands off to
// eleven jointed rigid boxes matching the visual rig, connected by
// ConeTwistConstraints, simulated by the same cannon-es world that runs the
// fight. The body carries its momentum, tumbles under gravity, bounces off
// the canvas with restitution, slides with friction, crumples against the
// corner posts and rope walls (G_ARENA colliders), and gets shoved by the
// standing winner's kinematic root.
//
// Construction happens AT KO TIME from the fighter's current world pose:
// every part spawns exactly where its mesh is, so there is no pop. The
// constraints record the KO pose as their zero and allow anatomical
// deviation around it (cone + twist limits per joint), which keeps the pile
// humanoid without scripting the fall.
//
// Driving the visuals: physics owns the pose. Each frame `drive()` writes
// the pelvis transform to the rig root and converts every part's world
// quaternion into the joint's local rotation (parent-relative), walking the
// hierarchy in order. Joint local POSITIONS are never touched — bone lengths
// stay rig-perfect while the constraint solver keeps bodies at the joints.

import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { G_ROOT, G_RAGDOLL, G_ARENA, G_PROP } from './physics.js';

// Body parts: box half-extent source sizes (full w/h/d, scaled by the
// fighter's heightScale), the rig joint that anchors them, the offset from
// that joint pivot to the box center (joint-local), and the part mass.
const PARTS = {
  pelvis:    { joint: 'hips',      size: [0.38, 0.24, 0.28], pivotToCenter: [0, 0, 0],     mass: 3.0 },
  chest:     { joint: 'torso',     size: [0.46, 0.62, 0.32], pivotToCenter: [0, 0.32, 0],  mass: 4.0 },
  head:      { joint: 'head',      size: [0.28, 0.32, 0.28], pivotToCenter: [0, 0.17, 0],  mass: 1.2 },
  upperArmL: { joint: 'shoulderL', size: [0.13, 0.34, 0.13], pivotToCenter: [0, -0.17, 0], mass: 0.8 },
  upperArmR: { joint: 'shoulderR', size: [0.13, 0.34, 0.13], pivotToCenter: [0, -0.17, 0], mass: 0.8 },
  forearmL:  { joint: 'elbowL',    size: [0.12, 0.36, 0.12], pivotToCenter: [0, -0.19, 0], mass: 0.6 },
  forearmR:  { joint: 'elbowR',    size: [0.12, 0.36, 0.12], pivotToCenter: [0, -0.19, 0], mass: 0.6 },
  thighL:    { joint: 'hipL',      size: [0.15, 0.44, 0.16], pivotToCenter: [0, -0.21, 0], mass: 1.5 },
  thighR:    { joint: 'hipR',      size: [0.15, 0.44, 0.16], pivotToCenter: [0, -0.21, 0], mass: 1.5 },
  shinL:     { joint: 'kneeL',     size: [0.13, 0.50, 0.15], pivotToCenter: [0, -0.24, 0], mass: 1.0 },
  shinR:     { joint: 'kneeR',     size: [0.13, 0.50, 0.15], pivotToCenter: [0, -0.24, 0], mass: 1.0 },
};

// Joints: [childPart, parentPart, coneAngle, twistAngle] — limits are
// deviations from the KO-time pose (radians).
const LINKS = [
  ['chest',     'pelvis',    0.50, 0.40], // waist
  ['head',      'chest',     0.80, 0.80], // neck
  ['upperArmL', 'chest',     1.20, 0.50], // shoulders
  ['upperArmR', 'chest',     1.20, 0.50],
  ['forearmL',  'upperArmL', 0.90, 0.30], // elbows
  ['forearmR',  'upperArmR', 0.90, 0.30],
  ['thighL',    'pelvis',    1.00, 0.40], // hips
  ['thighR',    'pelvis',    1.00, 0.40],
  ['shinL',     'thighL',    0.90, 0.25], // knees
  ['shinR',     'thighR',    0.90, 0.25],
];

// Launch velocity mix per part: knockDir horizontal push + vertical kick.
// Head/chest lead the tumble (that's where the KO blow landed).
const LAUNCH = {
  head:      { knock: 5.5, up: 1.8 },
  chest:     { knock: 4.5, up: 1.5 },
  pelvis:    { knock: 3.5, up: 1.0 },
  upperArmL: { knock: 3.0, up: 1.0 },
  upperArmR: { knock: 3.0, up: 1.0 },
  forearmL:  { knock: 3.0, up: 0.6 },
  forearmR:  { knock: 3.0, up: 0.6 },
  thighL:    { knock: 2.5, up: 0.4 },
  thighR:    { knock: 2.5, up: 0.4 },
  shinL:     { knock: 2.0, up: 0.2 },
  shinR:     { knock: 2.0, up: 0.2 },
};

// Rig hierarchy for drive(): joint → parent joint, in traversal order.
const JOINT_PARENT = {
  hips: null, torso: 'hips', head: 'torso',
  shoulderL: 'torso', elbowL: 'shoulderL',
  shoulderR: 'torso', elbowR: 'shoulderR',
  hipL: 'hips', kneeL: 'hipL',
  hipR: 'hips', kneeR: 'hipR',
};
const JOINT_ORDER = ['hips', 'torso', 'head', 'shoulderL', 'elbowL',
  'shoulderR', 'elbowR', 'hipL', 'kneeL', 'hipR', 'kneeR'];
const PART_FOR_JOINT = {};
for (const [part, def] of Object.entries(PARTS)) PART_FOR_JOINT[def.joint] = part;

// Scratch objects (module scope, no per-frame alloc).
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();

export class CannonRagdoll {
  constructor(world, ragdollMaterial, rig) {
    this.world = world;
    this.material = ragdollMaterial;
    this.rig = rig;
    this.bodies = null;      // part name -> CANNON.Body
    this.constraints = null;
  }

  get active() {
    return !!this.bodies;
  }

  // Build the skeleton from the rig's CURRENT world pose and launch it.
  // opts.velocity — fighter world velocity at the moment of the KO blow.
  // opts.rng      — seeded RNG for the tumble jitter (demo reproducibility).
  // opts.launch   — shape of the killing blow: { upMul, flip, spin,
  //                 knockMul, velMul }. upMul scales the vertical launch
  //                 (uppercuts loft the body), flip adds pitch angular
  //                 velocity about the axis perpendicular to knockDir (leg
  //                 sweeps flip forward, head shots whip backward), spin
  //                 adds yaw. knockMul scales the directed launch speed and
  //                 velMul the carried momentum — near-zero for the
  //                 "lights out, crumples in place" KO.
  activate(knockDir, opts = {}) {
    if (this.bodies) this.dispose();
    const s = (this.rig.config && this.rig.config.heightScale) || 1;
    const vel = opts.velocity || { x: 0, z: 0 };
    const rand = opts.rng ? () => opts.rng.random() : Math.random;
    const launch = opts.launch || {};
    const upMul = launch.upMul ?? 1;
    const flip = launch.flip ?? 0;
    const spin = launch.spin ?? 0;
    const knockMul = launch.knockMul ?? 1;
    const velMul = launch.velMul ?? 1;
    const flipAxisX = -knockDir.z, flipAxisZ = knockDir.x;
    this.rig.root.updateMatrixWorld(true);

    this.bodies = {};
    this.constraints = [];

    for (const [part, def] of Object.entries(PARTS)) {
      const joint = this.rig.joints[def.joint];
      if (!joint) continue;
      joint.getWorldPosition(_p);
      joint.getWorldQuaternion(_q);
      _v.set(def.pivotToCenter[0] * s, def.pivotToCenter[1] * s, def.pivotToCenter[2] * s)
        .applyQuaternion(_q);
      const body = new CANNON.Body({
        mass: def.mass,
        material: this.material,
        position: new CANNON.Vec3(_p.x + _v.x, _p.y + _v.y, _p.z + _v.z),
        linearDamping: 0.08,
        angularDamping: 0.25,
      });
      body.quaternion.set(_q.x, _q.y, _q.z, _q.w);
      body.addShape(new CANNON.Box(new CANNON.Vec3(
        (def.size[0] / 2) * s, (def.size[1] / 2) * s, (def.size[2] / 2) * s)));
      body.collisionFilterGroup = G_RAGDOLL;
      // G_PROP so a launched KO body crashes through the corner crates.
      body.collisionFilterMask = G_RAGDOLL | G_ARENA | G_ROOT | G_PROP;
      body.userData = { kind: 'ragdoll', part };

      // Momentum carry + directed launch + a touch of angular jitter so no
      // two KOs tumble identically.
      const L = LAUNCH[part];
      body.velocity.set(
        vel.x * velMul + knockDir.x * L.knock * knockMul,
        L.up * upMul,
        vel.z * velMul + knockDir.z * L.knock * knockMul
      );
      body.angularVelocity.set(
        (rand() - 0.5) * 3 + flipAxisX * flip,
        (rand() - 0.5) * 2 + spin,
        (rand() - 0.5) * 3 + flipAxisZ * flip);

      this.world.addBody(body);
      this.bodies[part] = body;
    }

    // Cone-twist joints. Pivots/axes are computed from the live pose so the
    // constraint zero IS the KO pose — no first-frame snap.
    for (const [childName, parentName, angle, twistAngle] of LINKS) {
      const child = this.bodies[childName];
      const parent = this.bodies[parentName];
      if (!child || !parent) continue;
      const cDef = PARTS[childName];

      // The anatomical joint pivot in world space (child pivot).
      _q.set(child.quaternion.x, child.quaternion.y, child.quaternion.z, child.quaternion.w);
      _v.set(-cDef.pivotToCenter[0] * s, -cDef.pivotToCenter[1] * s, -cDef.pivotToCenter[2] * s)
        .applyQuaternion(_q);
      const jw = new THREE.Vector3(
        child.position.x + _v.x, child.position.y + _v.y, child.position.z + _v.z);

      // pivotB: joint pivot in child-body frame (constant).
      const pivotB = new CANNON.Vec3(
        -cDef.pivotToCenter[0] * s, -cDef.pivotToCenter[1] * s, -cDef.pivotToCenter[2] * s);

      // pivotA: joint pivot in parent-body frame.
      _qInv.set(parent.quaternion.x, parent.quaternion.y, parent.quaternion.z, parent.quaternion.w).invert();
      _v.set(jw.x - parent.position.x, jw.y - parent.position.y, jw.z - parent.position.z)
        .applyQuaternion(_qInv);
      const pivotA = new CANNON.Vec3(_v.x, _v.y, _v.z);

      // Cone axis: from the joint pivot toward the child's center, expressed
      // in each body's local frame (aligned in world at build time).
      _axis.set(child.position.x - jw.x, child.position.y - jw.y, child.position.z - jw.z);
      if (_axis.lengthSq() < 1e-8) _axis.set(0, -1, 0); else _axis.normalize();
      _v.copy(_axis).applyQuaternion(_qInv); // parent-local
      const axisA = new CANNON.Vec3(_v.x, _v.y, _v.z);
      _qInv.set(child.quaternion.x, child.quaternion.y, child.quaternion.z, child.quaternion.w).invert();
      _v.copy(_axis).applyQuaternion(_qInv); // child-local
      const axisB = new CANNON.Vec3(_v.x, _v.y, _v.z);

      const c = new CANNON.ConeTwistConstraint(parent, child, {
        pivotA, pivotB, axisA, axisB,
        angle, twistAngle,
        collideConnected: false,
      });
      this.world.addConstraint(c);
      this.constraints.push(c);
    }
  }

  // Write the simulated pose back to the THREE rig: pelvis drives the root,
  // every body's world quaternion becomes its joint's parent-relative
  // rotation. Bone lengths never change — only rotations + root transform.
  drive() {
    if (!this.bodies) return;
    const root = this.rig.root;
    const joints = this.rig.joints;
    const s = (this.rig.config && this.rig.config.heightScale) || 1;

    // Root: place so the hips pivot lands on the pelvis body (pivotToCenter
    // is zero for the pelvis, so body position == hips pivot).
    const pelvis = this.bodies.pelvis;
    _v.copy(joints.hips.position).multiplyScalar(s).applyQuaternion(root.quaternion);
    root.position.set(
      pelvis.position.x - _v.x,
      pelvis.position.y - _v.y,
      pelvis.position.z - _v.z);

    // Joint rotations, walking the hierarchy so each parent's world quat is
    // already known when its children convert.
    const worldQuats = this._worldQuats || (this._worldQuats = {});
    for (const name of JOINT_ORDER) {
      const body = this.bodies[PART_FOR_JOINT[name]];
      const joint = joints[name];
      if (!body || !joint) continue;
      _q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      const parentName = JOINT_PARENT[name];
      const parentQuat = parentName ? worldQuats[parentName] : root.quaternion;
      _qInv.copy(parentQuat).invert();
      joint.quaternion.copy(_qInv.multiply(_q));
      (worldQuats[name] || (worldQuats[name] = new THREE.Quaternion())).set(_q.x, _q.y, _q.z, _q.w);
    }
  }

  dispose() {
    if (!this.bodies) return;
    for (const c of this.constraints || []) {
      if (this.world.constraints.includes(c)) this.world.removeConstraint(c);
    }
    for (const b of Object.values(this.bodies)) {
      if (this.world.bodies.includes(b)) this.world.removeBody(b);
    }
    this.bodies = null;
    this.constraints = null;
  }
}

// ── Severed limb ──────────────────────────────────────────────────────
// A torn-off arm is its own two-bone ragdoll: the upper arm and the forearm
// are separate rigid boxes linked at the elbow by a loose cone-twist, so the
// limb flops instead of tumbling as one rigid stick. Nothing drives it —
// the animator does not own these joints (vfx.js _severArm drops them from
// rig.joints at sever time), so the arm is purely limp from the moment it
// comes off until it settles on the canvas.
//
// The two THREE objects are expected to already be re-parented to the scene
// (world transform == local transform); `drive()` writes each body's pose
// straight onto them.
const SEVERED_SEGMENTS = [
  { key: 'shoulder', size: [0.13, 0.34, 0.13], pivotToCenter: [0, -0.17, 0], mass: 0.8 },
  { key: 'elbow',    size: [0.12, 0.36, 0.12], pivotToCenter: [0, -0.19, 0], mass: 0.6 },
];

export class SeveredArm {
  // opts: { shoulder, elbow, scale, velocity, angularVelocity }
  constructor(world, material, opts) {
    this.world = world;
    this.segments = [];
    this.constraints = [];
    const s = opts.scale || 1;
    const objs = { shoulder: opts.shoulder, elbow: opts.elbow };
    const bodies = {};

    for (const def of SEVERED_SEGMENTS) {
      const obj = objs[def.key];
      if (!obj) continue;
      const p2c = new THREE.Vector3(
        def.pivotToCenter[0] * s, def.pivotToCenter[1] * s, def.pivotToCenter[2] * s);
      _q.copy(obj.quaternion);
      _v.copy(p2c).applyQuaternion(_q);
      const body = new CANNON.Body({
        mass: def.mass,
        material,
        position: new CANNON.Vec3(
          obj.position.x + _v.x, obj.position.y + _v.y, obj.position.z + _v.z),
        linearDamping: 0.04,
        angularDamping: 0.12,
      });
      body.quaternion.set(_q.x, _q.y, _q.z, _q.w);
      body.addShape(new CANNON.Box(new CANNON.Vec3(
        (def.size[0] / 2) * s, (def.size[1] / 2) * s, (def.size[2] / 2) * s)));
      body.collisionFilterGroup = G_RAGDOLL;
      body.collisionFilterMask = G_RAGDOLL | G_ARENA | G_ROOT | G_PROP;
      body.userData = { kind: 'severedLimb' };
      if (opts.velocity) {
        body.velocity.set(opts.velocity.x, opts.velocity.y, opts.velocity.z);
      }
      if (opts.angularVelocity) {
        body.angularVelocity.set(
          opts.angularVelocity.x, opts.angularVelocity.y, opts.angularVelocity.z);
      }
      world.addBody(body);
      bodies[def.key] = body;
      this.segments.push({ obj, body, p2c });
    }

    // Elbow: same construction as the KO ragdoll's joints — pivots and axes
    // derived from the live pose so the constraint's zero IS the pose the arm
    // came off in, and the limits are deviation around it.
    const parent = bodies.shoulder, child = bodies.elbow;
    if (parent && child && objs.elbow) {
      const jw = objs.elbow.position; // the elbow pivot, in world space
      const cp = SEVERED_SEGMENTS[1].pivotToCenter;
      const pivotB = new CANNON.Vec3(-cp[0] * s, -cp[1] * s, -cp[2] * s);

      _qInv.set(parent.quaternion.x, parent.quaternion.y,
        parent.quaternion.z, parent.quaternion.w).invert();
      _v.set(jw.x - parent.position.x, jw.y - parent.position.y, jw.z - parent.position.z)
        .applyQuaternion(_qInv);
      const pivotA = new CANNON.Vec3(_v.x, _v.y, _v.z);

      _axis.set(child.position.x - jw.x, child.position.y - jw.y, child.position.z - jw.z);
      if (_axis.lengthSq() < 1e-8) _axis.set(0, -1, 0); else _axis.normalize();
      _v.copy(_axis).applyQuaternion(_qInv);
      const axisA = new CANNON.Vec3(_v.x, _v.y, _v.z);
      _qInv.set(child.quaternion.x, child.quaternion.y,
        child.quaternion.z, child.quaternion.w).invert();
      _v.copy(_axis).applyQuaternion(_qInv);
      const axisB = new CANNON.Vec3(_v.x, _v.y, _v.z);

      // Looser than a living elbow (0.90/0.30): dead weight, no muscle tone.
      const c = new CANNON.ConeTwistConstraint(parent, child, {
        pivotA, pivotB, axisA, axisB,
        angle: 1.3, twistAngle: 0.6,
        collideConnected: false,
      });
      world.addConstraint(c);
      this.constraints.push(c);
    }
  }

  get active() {
    return this.segments.length > 0;
  }

  // Largest linear/angular speed across the limb — the settle test.
  get speed() {
    let m = 0;
    for (const s of this.segments) {
      m = Math.max(m, s.body.velocity.length(), s.body.angularVelocity.length() * 0.25);
    }
    return m;
  }

  // Physics pose → THREE transforms. Each object is a scene child, so its
  // local transform IS its world transform; we back the box center out to the
  // joint pivot the mesh hierarchy is anchored on.
  drive() {
    for (const s of this.segments) {
      const b = s.body;
      _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      _v.copy(s.p2c).applyQuaternion(_q);
      s.obj.quaternion.copy(_q);
      s.obj.position.set(b.position.x - _v.x, b.position.y - _v.y, b.position.z - _v.z);
    }
  }

  // Retire the bodies once the limb has come to rest — the meshes stay where
  // the simulation left them. The world never sleeps (allowSleep = false), so
  // without this a settled arm would jitter on solver noise forever.
  dispose() {
    for (const c of this.constraints) {
      if (this.world.constraints.includes(c)) this.world.removeConstraint(c);
    }
    for (const s of this.segments) {
      if (this.world.bodies.includes(s.body)) this.world.removeBody(s.body);
    }
    this.constraints.length = 0;
    this.segments.length = 0;
  }
}
