// props.js — destructible corner crates, persistent debris, and the physics
// glue that lets fighters interact with them.
//
// Each corner gets a 10-crate pyramid of cannon-es dynamic bodies (G_PROP):
//   • A fighter walking into a stack nudges it apart (explicit shove impulses,
//     since fighters are kinematic in the solver).
//   • A fighter KNOCKED into a stack at speed damages crates, which splinter
//     into debris bodies that persist for the rest of the round.
//   • A crate flung into the opposing fighter chips them and shoves them back.
//   • A KO ragdoll crashes the stack (its mask includes G_PROP).
//
// Everything here runs OUTSIDE world.step, so adding/removing bodies
// mid-shatter is safe.

import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { G_PROP, G_ROOT, G_RAGDOLL, G_ARENA } from './physics.js';

const RING = 5.2;              // matches RING_HALF — keep crates inside the ropes
const CORNER = RING - 0.95;    // stack-center inset from the ring edge
const MAT_Y = 0.04;            // canvas top (arena.js floor)
const BOX = 0.36;              // crate edge length
const HALF = BOX / 2;
const CRATE_MASS = 1.6;
const CRATE_HP = 100;

const MAX_BODIES = 96;         // hard cap on live prop bodies (crates + debris)
const SMASH_KB = 3.6;          // fighter knockback magnitude that starts damaging crates
const PUSH_K = 0.85;           // shove-impulse gain for a fighter walking into a crate
const MAX_PUSH = 15;           // clamp on a single shove impulse
const CHAIN_SPEED = 3.0;       // crate speed that can chip a fighter on contact

// Per-corner local stack layout (4 base + 3 + 2 + 1), ~0.76 wide and ~1.44
// tall — matches the corner posts.
const STACK = [
  // Tier 0 (bottom): 2×2 base of 4 crates
  { x: -0.20, y: HALF,            z: -0.20 },
  { x:  0.20, y: HALF,            z: -0.20 },
  { x: -0.20, y: HALF,            z:  0.20 },
  { x:  0.20, y: HALF,            z:  0.20 },
  // Tier 1: 3 crates in a triangle sitting on the base
  { x: -0.20, y: HALF + BOX,      z:  0.00 },
  { x:  0.20, y: HALF + BOX,      z:  0.00 },
  { x:  0.00, y: HALF + BOX,      z: -0.20 },
  // Tier 2: 2 crates side by side
  { x: -0.20, y: HALF + 2 * BOX,  z:  0.00 },
  { x:  0.20, y: HALF + 2 * BOX,  z:  0.00 },
  // Tier 3 (top): 1 centred crate
  { x:  0.00, y: HALF + 3 * BOX,  z:  0.00 },
];

// ── Crate texture: planks + a corner brace, so a crate reads as a crate ──
let _crateTex = null;
function crateTexture() {
  if (_crateTex) return _crateTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#7c5330';
  g.fillRect(0, 0, 64, 64);
  // Horizontal plank seams.
  g.strokeStyle = 'rgba(40,24,10,0.55)';
  g.lineWidth = 2;
  for (const y of [16, 32, 48]) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke();
  }
  // Grain flecks.
  g.fillStyle = 'rgba(120,84,48,0.5)';
  for (let i = 0; i < 40; i++) {
    g.fillRect(Math.random() * 64, Math.random() * 64, 2, 1);
  }
  // Frame border + diagonal brace.
  g.strokeStyle = 'rgba(54,34,16,0.8)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 60, 60);
  g.beginPath(); g.moveTo(4, 60); g.lineTo(60, 4); g.stroke();
  _crateTex = new THREE.CanvasTexture(c);
  _crateTex.colorSpace = THREE.SRGBColorSpace;
  return _crateTex;
}

let _crateGeo = null;
function crateGeo() {
  return (_crateGeo ??= new THREE.BoxGeometry(BOX, BOX, BOX));
}

function crateMaterial() {
  return new THREE.MeshStandardMaterial({
    map: crateTexture(), color: 0xffffff, roughness: 0.85, metalness: 0.0,
  });
}

// Build one dynamic box body + matching mesh at a world position.
function spawnBox(props, pos, edge, mass, hp, isDebris) {
  if (props.bodies.length >= MAX_BODIES) cullOldestDebris(props);
  const h = edge / 2;
  const body = new CANNON.Body({
    mass,
    material: props.mats.prop,
    shape: new CANNON.Box(new CANNON.Vec3(h, h, h)),
    position: new CANNON.Vec3(pos.x, pos.y, pos.z),
    linearDamping: 0.22,
    angularDamping: 0.4,
  });
  body.collisionFilterGroup = G_PROP;
  // Floor is the default group (G_ROOT bit); fighters are G_ROOT; other crates
  // G_PROP; ragdoll G_RAGDOLL; rope walls G_ARENA.
  body.collisionFilterMask = G_ROOT | G_PROP | G_RAGDOLL | G_ARENA;
  body.userData = { kind: 'prop', hp, isDebris, chipCd: 0, seq: props.seq++ };
  props.world.addBody(body);

  const scale = edge / BOX;
  const mesh = new THREE.Mesh(crateGeo(), isDebris ? props.debrisMat : crateMaterial());
  mesh.scale.setScalar(scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.copy(pos);
  props.scene.add(mesh);

  const entry = { body, mesh };
  body.userData.entry = entry;
  props.bodies.push(entry);
  return entry;
}

function removeEntry(props, entry) {
  if (props.world.bodies.includes(entry.body)) props.world.removeBody(entry.body);
  props.scene.remove(entry.mesh);
  // Geometry is shared (cached); only clone-per-crate materials are disposed.
  if (entry.mesh.material && entry.mesh.material !== props.debrisMat) {
    entry.mesh.material.dispose();
  }
  const i = props.bodies.indexOf(entry);
  if (i >= 0) props.bodies.splice(i, 1);
}

// When we hit the body cap, retire the oldest settled debris fragment so new
// splinters can still spawn without the world growing unbounded.
function cullOldestDebris(props) {
  let oldest = null;
  for (const e of props.bodies) {
    if (!e.body.userData.isDebris) continue;
    if (!oldest || e.body.userData.seq < oldest.body.userData.seq) oldest = e;
  }
  if (oldest) removeEntry(props, oldest);
  else if (props.bodies.length) removeEntry(props, props.bodies[0]);
}

// Build the four corner stacks. Returns the props handle.
export function buildProps(world, mats, scene) {
  const props = {
    world, mats, scene,
    bodies: [],
    seq: 0,
    debrisMat: new THREE.MeshStandardMaterial({
      map: crateTexture(), color: 0xd8b48a, roughness: 0.9,
    }),
  };
  resetProps(props);
  return props;
}

// Restore the corner stacks for a fresh round. REUSES existing crate
// bodies/meshes to avoid a GC spike (audible/visible stutter) during the intro;
// only debris is torn down, shattered crates are respawned.
export function resetProps(props) {
  if (!props) return;
  const targets = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const s of STACK) {
        targets.push({ x: sx * CORNER + s.x, y: MAT_Y + s.y, z: sz * CORNER + s.z });
      }
    }
  }
  // Drop debris; keep intact crate bodies for reuse.
  const crates = [];
  for (const e of props.bodies.slice()) {
    if (e.body.userData.isDebris) removeEntry(props, e);
    else crates.push(e);
  }
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i < crates.length) {
      const e = crates[i];
      e.body.position.set(t.x, t.y, t.z);
      e.body.quaternion.set(0, 0, 0, 1);
      e.body.velocity.set(0, 0, 0);
      e.body.angularVelocity.set(0, 0, 0);
      e.body.userData.hp = CRATE_HP;
      e.mesh.material.color.setRGB(1, 1, 1);
      e.mesh.position.set(t.x, t.y, t.z);
      e.mesh.quaternion.set(0, 0, 0, 1);
    } else {
      spawnBox(props, t, BOX, CRATE_MASS, CRATE_HP, false);
    }
  }
  for (let i = targets.length; i < crates.length; i++) removeEntry(props, crates[i]);
}

// Damage a crate; shatter it into debris once its HP is spent. `vel` is the
// impact velocity used to fling the splinters.
function damageCrate(props, entry, amount, vel, hooks) {
  const ud = entry.body.userData;
  if (ud.isDebris) return; // debris doesn't further shatter
  ud.hp -= amount;
  // Darken the crate as it takes damage (0.35 → visibly battered).
  const t = Math.max(0, ud.hp / CRATE_HP);
  entry.mesh.material.color.setRGB(0.55 + 0.45 * t, 0.5 + 0.5 * t, 0.5 + 0.5 * t);
  if (ud.hp > 0) return;

  const p = entry.body.position.clone();
  hooks?.onImpactFx?.(new THREE.Vector3(p.x, p.y, p.z), 1.4, 'wood');
  removeEntry(props, entry);
  // Splinter into 3-4 smaller boxes carrying the impact velocity + scatter.
  const n = 3 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const frag = spawnBox(props, {
      x: p.x + (Math.random() - 0.5) * BOX * 0.6,
      y: p.y + (Math.random() - 0.5) * BOX * 0.4,
      z: p.z + (Math.random() - 0.5) * BOX * 0.6,
    }, BOX * (0.42 + Math.random() * 0.12), 0.4, 0, true);
    frag.body.velocity.set(
      (vel?.x ?? 0) * 0.5 + (Math.random() - 0.5) * 4,
      Math.abs(vel?.y ?? 0) * 0.3 + 1.5 + Math.random() * 2.5,
      (vel?.z ?? 0) * 0.5 + (Math.random() - 0.5) * 4);
    frag.body.angularVelocity.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12);
  }
}

const _dir = new THREE.Vector3();

// Per-frame: shove crates that fighters press into, resolve smashes + chain
// reactions, then mirror every body transform onto its mesh.
//
// hooks: { onChip(fighter, dmg, dirX, dirZ), onImpactFx(posVec3, power, kind) }
export function updateProps(props, dt, fighters, hooks) {
  if (!props) return;
  const alive = fighters ? fighters.filter((f) => f && f.state !== 'ko') : [];

  for (const entry of props.bodies.slice()) {
    const body = entry.body;
    const ud = body.userData;
    if (ud.chipCd > 0) ud.chipCd -= dt;
    const bx = body.position.x, by = body.position.y, bz = body.position.z;

    for (const f of alive) {
      const rp = f.rig.root.position;
      const dx = bx - rp.x, dz = bz - rp.z;
      const d = Math.hypot(dx, dz);
      const boxH = body.shapes[0].halfExtents.x;
      const reach = 0.55 + boxH + 0.12;
      // Only crates within the fighter's body height band are reachable.
      if (d > reach || d < 1e-4 || by > 1.7 || by < -0.2) continue;
      const nx = dx / d, nz = dz / d;
      const kbx = f.knockback.x, kbz = f.knockback.z;
      const fvx = (f.vel?.x ?? 0) + kbx, fvz = (f.vel?.z ?? 0) + kbz;
      const approach = fvx * nx + fvz * nz;      // fighter speed toward the crate
      if (approach <= 0.15) continue;

      // applyImpulse's second arg is the offset FROM the centre of mass, not a
      // world point — a small +Y offset makes the crate topple.
      const imp = Math.min(MAX_PUSH, approach * body.mass * PUSH_K);
      body.wakeUp();
      body.applyImpulse(
        new CANNON.Vec3(nx * imp, imp * 0.25, nz * imp),
        new CANNON.Vec3(0, boxH * 0.6, 0));

      // A KNOCKED fighter (not just walking) smashes the crate + gets chipped.
      const kbMag = Math.hypot(kbx, kbz);
      if (kbMag > SMASH_KB && !ud.isDebris) {
        const dmg = THREE.MathUtils.clamp((kbMag - SMASH_KB) * 22, 12, 100);
        damageCrate(props, entry, dmg, { x: fvx, y: 2, z: fvz }, hooks);
        f.knockback.multiplyScalar(0.55);
        hooks?.onChip?.(f, Math.min(3, kbMag - SMASH_KB), -nx, -nz);
        break; // this crate is gone/handled for this fighter
      }
    }

    // Chain reaction #2: a fast-flying crate that strikes the OTHER fighter.
    if (ud.chipCd <= 0) {
      const speed = Math.hypot(body.velocity.x, body.velocity.z);
      if (speed > CHAIN_SPEED) {
        for (const f of alive) {
          const rp = f.rig.root.position;
          const dx = rp.x - bx, dz = rp.z - bz;
          const d = Math.hypot(dx, dz);
          const boxH = body.shapes[0].halfExtents.x;
          if (d > 0.55 + boxH + 0.1 || by > 1.7) continue;
          const nd = d || 1e-4;
          f.knockback.x += (dx / nd) * speed * 0.14;
          f.knockback.z += (dz / nd) * speed * 0.14;
          hooks?.onChip?.(f, Math.min(2, speed * 0.28), dx / nd, dz / nd);
          ud.chipCd = 0.45;
          break;
        }
      }
    }

    entry.mesh.position.set(bx, by, bz);
    entry.mesh.quaternion.set(
      body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
  }
}

export function disposeProps(props) {
  if (!props) return;
  for (const e of props.bodies.slice()) removeEntry(props, e);
  props.bodies.length = 0;
  props.debrisMat?.dispose();
}
