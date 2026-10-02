// fauna.js — ambient birds and fish. Render-side only, on purpose:
// the sim's four species are wired through fixed-width arrays end to end (counts, the frame
// encoder, the trait history, every chart and the server's chronicle), so a fifth sim
// species is a schema change, not a feature. These are life the island is seen to have —
// they never eat, breed, die or touch a rule, and no RNG stream is drawn for them.
//
// Birds are boids (cohesion, alignment, separation) chasing a slow flock target that loops
// the island; they roost at night and ground themselves in a storm. Fish are schools
// circling in the shallows, where the water shader is transparent enough to see them.
import * as THREE from 'three';
import { TILE } from '../sim/terrain/tiles.js';

const FLOCKS = { high: 3, medium: 2, low: 0 };
const BIRDS_PER_FLOCK = 8;
const SCHOOLS = { high: 7, medium: 4, low: 0 };
const FISH_PER_SCHOOL = { high: 7, medium: 4, low: 0 };
const FISH_VISIBLE_METRES = 80;

function birdGeometry() {
  // A flat "V": nose, two wing tips, tail. Flapping is a per-instance Y scale that swings
  // the tips through the body plane, which reads as a wingbeat at this size.
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0, 0.28, -0.62, 0.18, -0.12, 0, 0, -0.32,
    0, 0, 0.28, 0, 0, -0.32, 0.62, 0.18, -0.12,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

function fishGeometry() {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0, 0.22, 0.06, 0.03, 0, 0, 0, -0.2,
    0, 0, 0.22, 0, 0, -0.2, -0.06, 0.03, 0,
    0, 0, -0.2, 0.07, 0.05, -0.3, -0.07, 0.05, -0.3,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function createFauna(scene, terrainApi, { tier = 'high' } = {}) {
  const flockCount = FLOCKS[tier] ?? 0;
  const schoolCount = SCHOOLS[tier] ?? 0;
  const perSchool = FISH_PER_SCHOOL[tier] ?? 0;
  const size = terrainApi.size;
  const dummy = new THREE.Object3D();

  // ── birds ─────────────────────────────────────────────────────────────
  const birdTotal = flockCount * BIRDS_PER_FLOCK;
  let birds = null;
  if (birdTotal > 0) {
    const mesh = new THREE.InstancedMesh(birdGeometry(), new THREE.MeshLambertMaterial({ color: 0x2e3036, side: THREE.DoubleSide, flatShading: true }), birdTotal);
    mesh.frustumCulled = false;
    mesh.name = 'birds';
    scene.add(mesh);
    const pos = new Float32Array(birdTotal * 3);
    const vel = new Float32Array(birdTotal * 3);
    const phase = new Float32Array(birdTotal);
    for (let b = 0; b < birdTotal; b++) {
      const f = Math.floor(b / BIRDS_PER_FLOCK);
      pos[b * 3] = size * (0.3 + 0.2 * f) + Math.random() * 8;
      pos[b * 3 + 1] = 24 + Math.random() * 6;
      pos[b * 3 + 2] = size * 0.5 + Math.random() * 8;
      vel[b * 3] = Math.random() - 0.5; vel[b * 3 + 2] = Math.random() - 0.5;
      phase[b] = Math.random() * Math.PI * 2;
    }
    birds = { mesh, pos, vel, phase, presence: 1 };
  }

  // ── fish ──────────────────────────────────────────────────────────────
  // School centres: shallow water tiles touching land, spread out by taking every k-th.
  const schools = [];
  if (schoolCount > 0 && perSchool > 0) {
    const shallow = [];
    const type = terrainApi.type;
    for (let z = 2; z < size - 2; z++) for (let x = 2; x < size - 2; x++) {
      const t = z * size + x;
      if (type[t] !== TILE.OCEAN && type[t] !== TILE.LAKE) continue;
      const land = type[t + 1] === TILE.BEACH || type[t - 1] === TILE.BEACH || type[t + size] === TILE.BEACH || type[t - size] === TILE.BEACH
        || type[t + 2] === TILE.BEACH || type[t - 2] === TILE.BEACH;
      if (land) shallow.push(t);
    }
    const stride = Math.max(1, Math.floor(shallow.length / schoolCount));
    for (let k = 0; k < schoolCount && k * stride < shallow.length; k++) {
      const t = shallow[(k * stride + (stride >> 1)) % shallow.length];
      const cx = (t % size) + 0.5; const cz = Math.floor(t / size) + 0.5;
      const bed = terrainApi.heightAt(cx, cz);
      schools.push({ cx, cz, y: Math.max(-0.55, Math.min(-0.12, bed * 0.45)), radius: 1.4 + Math.random() * 1.6, speed: 0.5 + Math.random() * 0.5, offset: Math.random() * 10 });
    }
  }
  let fish = null;
  if (schools.length) {
    const mesh = new THREE.InstancedMesh(fishGeometry(), new THREE.MeshLambertMaterial({ color: 0x7f9fb4, side: THREE.DoubleSide, flatShading: true }), schools.length * perSchool);
    mesh.frustumCulled = false;
    mesh.name = 'fish';
    mesh.count = 0;
    scene.add(mesh);
    fish = { mesh };
  }

  function stepBirds(dt, time, night, storm) {
    const { mesh, pos, vel, phase } = birds;
    // Roost at night and in a storm: the flock fades out rather than vanishing mid-air.
    const want = night > 0.72 || storm > 0.5 ? 0 : 1;
    birds.presence += (want - birds.presence) * Math.min(1, dt * 0.6);
    if (birds.presence < 0.02) { mesh.visible = false; return; }
    mesh.visible = true;
    const centre = size / 2;
    for (let f = 0; f < flockCount; f++) {
      // Each flock chases its own slow loop over the island.
      const a = time * (0.045 + f * 0.012) + f * 2.1;
      const tx = centre + Math.cos(a) * (55 + f * 12);
      const tz = centre + Math.sin(a * 1.3) * (45 + f * 10);
      const ty = Math.max(16, terrainApi.heightAt(tx, tz) + 18) + f * 3;
      const lo = f * BIRDS_PER_FLOCK; const hi = lo + BIRDS_PER_FLOCK;
      let mx = 0, my = 0, mz = 0, ax = 0, ay = 0, az = 0;
      for (let b = lo; b < hi; b++) { mx += pos[b * 3]; my += pos[b * 3 + 1]; mz += pos[b * 3 + 2]; ax += vel[b * 3]; ay += vel[b * 3 + 1]; az += vel[b * 3 + 2]; }
      const n = BIRDS_PER_FLOCK;
      mx /= n; my /= n; mz /= n; ax /= n; ay /= n; az /= n;
      for (let b = lo; b < hi; b++) {
        const o = b * 3;
        let fx = (mx - pos[o]) * 0.35 + (ax - vel[o]) * 0.5 + (tx - pos[o]) * 0.08;
        let fy = (my - pos[o + 1]) * 0.35 + (ay - vel[o + 1]) * 0.5 + (ty - pos[o + 1]) * 0.12;
        let fz = (mz - pos[o + 2]) * 0.35 + (az - vel[o + 2]) * 0.5 + (tz - pos[o + 2]) * 0.08;
        for (let c = lo; c < hi; c++) {
          if (c === b) continue;
          const dx = pos[o] - pos[c * 3]; const dy = pos[o + 1] - pos[c * 3 + 1]; const dz = pos[o + 2] - pos[c * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 4 && d2 > 1e-4) { const k = 2.4 / d2; fx += dx * k; fy += dy * k; fz += dz * k; }
        }
        vel[o] += fx * dt; vel[o + 1] += fy * dt; vel[o + 2] += fz * dt;
        const sp = Math.hypot(vel[o], vel[o + 1], vel[o + 2]);
        const clamp = sp > 10 ? 10 / sp : sp < 5 ? 5 / Math.max(0.01, sp) : 1;
        vel[o] *= clamp; vel[o + 1] *= clamp; vel[o + 2] *= clamp;
        pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt;
        const ground = terrainApi.heightAt(pos[o], pos[o + 2]);
        if (pos[o + 1] < ground + 6) { pos[o + 1] = ground + 6; vel[o + 1] = Math.abs(vel[o + 1]); }

        dummy.position.set(pos[o], pos[o + 1], pos[o + 2]);
        dummy.rotation.set(0, Math.atan2(vel[o], vel[o + 2]), 0);
        const flap = Math.sin(time * 11 + phase[b]);
        const s = birds.presence;
        dummy.scale.set(s, flap * s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(b, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function stepFish(time, player) {
    const { mesh } = fish;
    let k = 0;
    for (const sc of schools) {
      if (Math.hypot(sc.cx - player.x, sc.cz - player.z) > FISH_VISIBLE_METRES) continue;
      for (let m = 0; m < perSchool; m++) {
        const a = (time + sc.offset) * sc.speed + (m / perSchool) * Math.PI * 2;
        const r = sc.radius * (0.7 + 0.3 * Math.sin(m * 1.7 + time * 0.4));
        const x = sc.cx + Math.cos(a) * r; const z = sc.cz + Math.sin(a) * r;
        dummy.position.set(x, sc.y + Math.sin(time * 2 + m) * 0.04, z);
        // Tangent to the circle: the fish faces where it is swimming.
        dummy.rotation.set(0, Math.atan2(-Math.sin(a), Math.cos(a)), Math.sin(time * 9 + m) * 0.15);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(k++, dummy.matrix);
      }
    }
    mesh.count = k;
    if (k) mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    update(dt, time, { player, night = 0, storm = 0 } = {}) {
      if (birds) stepBirds(Math.min(dt, 0.05), time, night, storm);
      if (fish && player) stepFish(time, player);
    },
    get birdCount() { return birdTotal; },
    get fishSchools() { return schools.length; },
    dispose() {
      for (const f of [birds, fish]) {
        if (!f) continue;
        scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
      }
    },
  };
}
