// hitboxes.js — capsule-vs-capsule hit detection for PoBrawl.
//
// Each fighter is decomposed into a small set of capsules (line segment +
// radius). At runtime we sample world-space endpoints for each capsule from
// the rig's THREE.Group hierarchy, then for an active attack we test its
// "striker" capsules against the defender's "hurt" capsules. A hit is only
// registered if at least one striker-hurt capsule pair intersects.
//
// This is the standard fighting-game approach: capsule-capsule tests are O(N*M),
// stable under rotation, and read as "real polygon contact" to a player without
// the cost of a true mesh-mesh pipeline. It is the only hit path: game.js polls
// it every active-attack tick, and the clash test runs on the same geometry.
//
// ── Capsule anatomy ───────────────────────────────────────────────────────
// A capsule is { jointA, jointB, radius } where jointA/jointB are rig joint
// names; its world endpoints are those joints' world positions at test time.
// Sets: striker (deals damage), hurt (receives), guard (block surface).
//
// ── Why capsules not boxes ───────────────────────────────────────────────
// Boxes would be slightly more accurate to the visible primitives but require
// an OBB-OBB SAT test; the rig uses axis-aligned boxes parented to rotated
// joints, so even the "boxes" rotate with the limb. Capsules capture the same
// silhouette with a single segment-segment distance check.

import * as THREE from 'three';

// jointA/jointB are the rig's joint names; radius is the capsule thickness in
// world units.
export const FIGHTER_CAPSULES = {
  // ── Hurt capsules (defender's body) ────────────────────────────────
  hurt: {
    head:      { jointA: 'torso', jointB: 'head',     radius: 0.30 },
    torso:     { jointA: 'hips',  jointB: 'torso',    radius: 0.34 },
    hipL:      { jointA: 'hips',  jointB: 'hipL',     radius: 0.18 },
    hipR:      { jointA: 'hips',  jointB: 'hipR',     radius: 0.18 },
    thighL:    { jointA: 'hipL',  jointB: 'kneeL',    radius: 0.16 },
    thighR:    { jointA: 'hipR',  jointB: 'kneeR',    radius: 0.16 },
    shinL:     { jointA: 'kneeL', jointB: 'footL',    radius: 0.14 },
    shinR:     { jointA: 'kneeR', jointB: 'footR',    radius: 0.14 },
    upperArmL: { jointA: 'torso', jointB: 'elbowL',   radius: 0.13 },
    upperArmR: { jointA: 'torso', jointB: 'elbowR',   radius: 0.13 },
    forearmL:  { jointA: 'shoulderL', jointB: 'elbowL', radius: 0.11 },
    forearmR:  { jointA: 'shoulderR', jointB: 'elbowR', radius: 0.11 },
  },
  // ── Guard capsules (block surface) ──────────────────────────────────
  guard: {
    forearmL:  { jointA: 'shoulderL', jointB: 'elbowL', radius: 0.16 },
    forearmR:  { jointA: 'shoulderR', jointB: 'elbowR', radius: 0.16 },
  },
};

// Per-attack striker capsules. We split strike vs recovery so a swing that
// misses never re-strikes on the way back.
//
// Strikers follow the ACTUAL fist/shoe meshes (registered as rig joints in
// fighters.js) — a hit only registers when the visible limb polygons reach
// the defender. `forwardReach` is a small knuckle/toe pad; the range comes
// from the stretched strike animation and the attack lunge.
export const ATTACK_CAPSULES = {
  punch: {
    active: {
      forearm: { jointA: 'elbowR', jointB: 'fistR', radius: 0.11 },
      fist:    { jointA: 'fistR',  jointB: 'fistR', radius: 0.12,
                 forwardReach: 0.06 },
    },
    // Recovery: capsule shrinks so a follow-up swing is required to hit again.
    recover: {
      forearm: { jointA: 'elbowR', jointB: 'fistR', radius: 0.08 },
    },
  },
  kick: {
    active: {
      shin: { jointA: 'kneeR', jointB: 'footR', radius: 0.13 },
      foot: { jointA: 'footR', jointB: 'footR', radius: 0.14,
              forwardReach: 0.08 },
    },
    recover: {
      shin: { jointA: 'kneeR', jointB: 'footR', radius: 0.09 },
    },
  },
};

// Compute the two world-space endpoints of a capsule from the rig's joints.
// `forwardReach` extends the second endpoint along the rig's local +Z (the
// direction the fighter is facing) so a swing can "reach past" the fist.
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _fwd = new THREE.Vector3();
function capsuleEndpoints(joints, cap, forwardDir) {
  const a = joints[cap.jointA];
  const b = joints[cap.jointB];
  if (!a || !b) return null;
  a.getWorldPosition(_vA);
  b.getWorldPosition(_vB);
  if (cap.forwardReach && forwardDir) {
    _fwd.copy(forwardDir).multiplyScalar(cap.forwardReach);
    _vB.add(_fwd);
  }
  return { a: _vA.clone(), b: _vB.clone() };
}

// Closest points between two line segments in 3D, plus the distance between
// them. Returns { d, pa, pb } where pa/pb are the closest points on each
// segment, or null if the segments are degenerate.
//
// Standard segment-segment distance (Real-Time Collision Detection, Ericson).
function closestPointsOnSegments(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d1z = p2.z - p1.z;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y, d2z = p4.z - p3.z;
  const rx = p1.x - p3.x, ry = p1.y - p3.y, rz = p1.z - p3.z;
  const a = d1x*d1x + d1y*d1y + d1z*d1z; // |d1|^2
  const e = d2x*d2x + d2y*d2y + d2z*d2z; // |d2|^2
  const f = d2x*rx + d2y*ry + d2z*rz;
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) return null; // both degenerate
  if (a <= 1e-9) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1x*rx + d1y*ry + d1z*rz;
    if (e <= 1e-9) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1x*d2x + d1y*d2y + d1z*d2z;
      const denom = a*e - b*b;
      if (denom !== 0) {
        s = Math.max(0, Math.min(1, (b*f - c*e) / denom));
      } else {
        s = 0;
      }
      t = (b*s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  const pa = new THREE.Vector3(p1.x + d1x*s, p1.y + d1y*s, p1.z + d1z*s);
  const pb = new THREE.Vector3(p3.x + d2x*t, p3.y + d2y*t, p3.z + d2z*t);
  return { d: pa.distanceTo(pb), pa, pb };
}

/**
 * Test a single attacker capsule against all defender capsules.
 * Returns the first intersection { capsule, point, distance } or null.
 */
// A rig's facing direction flattened to world XZ.
function facing(rig, out) {
  rig.root.getWorldDirection(out);
  out.y = 0;
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  return out.normalize();
}

function testCapsuleAgainstSet(attackerRig, attackerCaps, defenderRig, defenderCaps) {
  const atk = capsuleEndpoints(attackerRig.joints, attackerCaps, facing(attackerRig, _fwd));
  if (!atk) return null;
  let best = null;
  for (const [name, cap] of Object.entries(defenderCaps)) {
    const def = capsuleEndpoints(defenderRig.joints, cap, null);
    if (!def) continue;
    const hit = closestPointsOnSegments(atk.a, atk.b, def.a, def.b);
    if (!hit) continue;
    const threshold = attackerCaps.radius + cap.radius;
    if (hit.d <= threshold) {
      // Tie-break: keep the deepest (smallest gap) intersection so the
      // closest body part wins.
      if (!best || hit.d < best.distance) {
        best = { capsule: name, point: hit.pa.clone(), distance: hit.d, hurtPoint: hit.pb.clone() };
      }
    }
  }
  return best;
}

/**
 * Test every attacker striker capsule against the defender's hurt set.
 * Returns { capsule, hurtBone, point, distance } on the first hit, or null.
 * Picks the deepest intersection across all striker capsules.
 */
export function testAttackHit(attackerRig, attackName, phase, defenderRig) {
  const def = FIGHTER_CAPSULES.hurt;
  const atkSet = ATTACK_CAPSULES[attackName];
  if (!atkSet) return null;
  const caps = phase === 'recover' ? atkSet.recover : atkSet.active;
  if (!caps) return null;
  let best = null;
  for (const [capName, cap] of Object.entries(caps)) {
    const hit = testCapsuleAgainstSet(attackerRig, cap, defenderRig, def);
    if (!hit) continue;
    if (!best || hit.distance < best.distance) {
      best = { ...hit, striker: capName };
    }
  }
  return best;
}

/**
 * Test every attacker striker capsule against the defender's guard set.
 * Returns true if any striker intersects a guard capsule.
 */
export function testAttackBlocked(attackerRig, attackName, phase, defenderRig) {
  const def = FIGHTER_CAPSULES.guard;
  const atkSet = ATTACK_CAPSULES[attackName];
  if (!atkSet) return false;
  const caps = phase === 'recover' ? atkSet.recover : atkSet.active;
  if (!caps) return false;
  for (const cap of Object.values(caps)) {
    if (testCapsuleAgainstSet(attackerRig, cap, defenderRig, def)) return true;
  }
  return false;
}

/**
 * Striker-vs-striker: do two simultaneous swings' limbs meet? Returns the
 * midpoint of the closest approach (a new Vector3), or null.
 */
export function testAttackClash(rigA, attackA, phaseA, rigB, attackB, phaseB) {
  const capsA = ATTACK_CAPSULES[attackA]?.[phaseA === 'recover' ? 'recover' : 'active'];
  const capsB = ATTACK_CAPSULES[attackB]?.[phaseB === 'recover' ? 'recover' : 'active'];
  if (!capsA || !capsB) return null;
  const fwdA = facing(rigA, new THREE.Vector3());
  const fwdB = facing(rigB, new THREE.Vector3());
  for (const ca of Object.values(capsA)) {
    const a = capsuleEndpoints(rigA.joints, ca, fwdA);
    if (!a) continue;
    for (const cb of Object.values(capsB)) {
      const b = capsuleEndpoints(rigB.joints, cb, fwdB);
      if (!b) continue;
      const hit = closestPointsOnSegments(a.a, a.b, b.a, b.b);
      if (hit && hit.d <= ca.radius + cb.radius) return hit.pa.add(hit.pb).multiplyScalar(0.5);
    }
  }
  return null;
}

// ── Region classification ───────────────────────────────────────────────
// Map a hurt-bone name to one of the game's damage regions. Used by the engine
// after a hit is registered.
const HURT_BONE_TO_REGION = {
  head: 'head',
  torso: 'torso',
  upperArmL: 'arms', upperArmR: 'arms',
  forearmL: 'arms', forearmR: 'arms',
  hipL: 'legs', hipR: 'legs',
  thighL: 'legs', thighR: 'legs',
  shinL: 'legs', shinR: 'legs',
};
export function regionForHurtBone(boneName) {
  return HURT_BONE_TO_REGION[boneName] || 'torso';
}