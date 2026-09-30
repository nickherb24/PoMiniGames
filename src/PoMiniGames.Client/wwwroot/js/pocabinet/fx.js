// pocabinet/fx.js
//
// Car-driven particles and marks for PoCabinet: tyre smoke, grass dust, rain
// spray, wall sparks, car-to-car contact sparks, launch smoke off the line, and
// skid marks that stay on the tarmac for the whole race.
//
// Everything is derived from the poses race.js already draws (position, heading,
// speed) plus, where the car is simulated locally, its body's `sliding` flag —
// so remote cars online and the replay get the same effects, and nothing here
// feeds back into physics. Lateral grip use is estimated from yaw rate × speed
// against the same GRIP_ACCEL the physics caps it at.
//
// update() returns the frame's contact events so race.js can play the crunch
// (positional when it is someone else's shunt), and the frame's barrier hits
// (first touch only), which race.js turns into dents on that car (cars.js).
//
// One-shots race.js fires (2026-09-29): backfire() — a flame out of the tail on
// every exhaust pop audio.js reports; debris() — chunks and paint flakes off a
// shunt; confetti() — the podium shower over the line.

import * as THREE from 'three';
import { wrapAngle } from './track.js';
import { GRIP_ACCEL, RUN_OFF, CAR_RADIUS } from './physics.js';

const WS = 10;
const MAX_SMOKE = 700;
const MAX_SPARKS = 360;
const MAX_SKID = 2600;          // quads in the skid-mark ring buffer
const SKID_W = 0.14;            // half tyre width, world units
const SKID_Y = 0.055;
const REAR = 1.2, TRACK_HALF = 0.72;

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Fade out right at the lens: a puff beside the cockpit would otherwise fill the screen.
    vAlpha = aAlpha * smoothstep(1.2, 4.5, -mv.z);
    gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(-mv.z, 0.1) : 0.0;
    gl_Position = projectionMatrix * mv;
}`;

const SMOKE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.05, d) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * (0.85 + 0.25 * (0.5 - c.y)), a);
    #include <colorspace_fragment>
}`;

const SPARK_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    a = a * a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * (1.0 + 2.0 * a), a);
    #include <colorspace_fragment>
}`;

class Pool {
    constructor(max, frag, blending) {
        this.max = max;
        this.pos = new Float32Array(max * 3);
        this.vel = new Float32Array(max * 3);
        this.size = new Float32Array(max);
        this.alpha = new Float32Array(max);
        this.color = new Float32Array(max * 3);
        this.life = new Float32Array(max);
        this.maxLife = new Float32Array(max);
        this.s0 = new Float32Array(max);
        this.s1 = new Float32Array(max);
        this.a0 = new Float32Array(max);
        this.drag = new Float32Array(max);
        this.grav = new Float32Array(max);
        this.next = 0;
        this.live = 0;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
        this.material = new THREE.ShaderMaterial({
            vertexShader: POINT_VERT,
            fragmentShader: frag,
            uniforms: { uScale: { value: 400 } },
            transparent: true,
            depthWrite: false,
            blending,
        });
        this.points = new THREE.Points(geom, this.material);
        this.points.frustumCulled = false;
        this.points.renderOrder = 5;
        this.geom = geom;
    }

    spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, drag, grav) {
        const i = this.next;
        this.next = (this.next + 1) % this.max;
        const k = i * 3;
        this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
        this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
        this.color[k] = r; this.color[k + 1] = g; this.color[k + 2] = b;
        this.life[i] = life; this.maxLife[i] = life;
        this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
        this.drag[i] = drag; this.grav[i] = grav;
    }

    step(dt) {
        let live = 0;
        for (let i = 0; i < this.max; i++) {
            if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
            this.life[i] -= dt;
            if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
            live++;
            const k = i * 3;
            const damp = Math.exp(-this.drag[i] * dt);
            this.vel[k] *= damp; this.vel[k + 1] = this.vel[k + 1] * damp - this.grav[i] * dt; this.vel[k + 2] *= damp;
            this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
            if (this.pos[k + 1] < 0.02) { this.pos[k + 1] = 0.02; this.vel[k + 1] *= -0.3; }
            const f = 1 - this.life[i] / this.maxLife[i];
            this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * f;
            this.alpha[i] = this.a0[i] * (f < 0.12 ? f / 0.12 : 1 - (f - 0.12) / 0.88);
        }
        this.live = live;
        const a = this.geom.attributes;
        a.position.needsUpdate = true;
        a.aSize.needsUpdate = true;
        a.aAlpha.needsUpdate = true;
        a.aColor.needsUpdate = true;
    }

    dispose() {
        this.geom.dispose();
        this.material.dispose();
    }
}

class SkidMarks {
    constructor() {
        this.pos = new Float32Array(MAX_SKID * 4 * 3);
        const idx = new Uint32Array(MAX_SKID * 6);
        for (let q = 0; q < MAX_SKID; q++) {
            const v = q * 4, k = q * 6;
            idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2;
            idx[k + 3] = v + 1; idx[k + 4] = v + 3; idx[k + 5] = v + 2;
        }
        this.geom = new THREE.BufferGeometry();
        this.attr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
        this.geom.setAttribute('position', this.attr);
        this.geom.setIndex(new THREE.BufferAttribute(idx, 1));
        this.geom.setDrawRange(0, 0);
        this.material = new THREE.MeshBasicMaterial({
            color: 0x0b0b0b, transparent: true, opacity: 0.5, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(this.geom, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 1;
        this.next = 0;
        this.count = 0;
        this.dirtyFrom = -1;
        this.dirtyTo = -1;
    }

    /** One quad from (ax,az)→(bx,bz), width across the direction of travel. */
    add(ax, az, bx, bz) {
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) return;
        const nx = -dz / len * SKID_W, nz = dx / len * SKID_W;
        const q = this.next;
        const k = q * 12;
        const p = this.pos;
        p[k] = ax - nx; p[k + 1] = SKID_Y; p[k + 2] = az - nz;
        p[k + 3] = ax + nx; p[k + 4] = SKID_Y; p[k + 5] = az + nz;
        p[k + 6] = bx - nx; p[k + 7] = SKID_Y; p[k + 8] = bz - nz;
        p[k + 9] = bx + nx; p[k + 10] = SKID_Y; p[k + 11] = bz + nz;
        if (this.dirtyFrom < 0) { this.dirtyFrom = q; this.dirtyTo = q; }
        else { this.dirtyFrom = Math.min(this.dirtyFrom, q); this.dirtyTo = Math.max(this.dirtyTo, q); }
        this.next = (q + 1) % MAX_SKID;
        this.count = Math.min(MAX_SKID, this.count + 1);
    }

    flush() {
        if (this.dirtyFrom < 0) return;
        if (typeof this.attr.addUpdateRange === 'function') {
            this.attr.clearUpdateRanges?.();
            this.attr.addUpdateRange(this.dirtyFrom * 12, (this.dirtyTo - this.dirtyFrom + 1) * 12);
        }
        this.attr.needsUpdate = true;
        this.geom.setDrawRange(0, this.count * 6);
        this.dirtyFrom = this.dirtyTo = -1;
    }

    dispose() {
        this.geom.dispose();
        this.material.dispose();
    }
}

class CarFx {
    /**
     * @param sceneHandle scene.js SceneHandle
     * @param track       runtime track (track.js)
     * @param opts        { grip, raining, groundHex }
     */
    constructor(sceneHandle, track, opts = {}) {
        this.sh = sceneHandle;
        this.track = track;
        this.grip = Number(opts.grip) || 1;
        this.raining = !!opts.raining;
        this.dust = new THREE.Color(opts.groundHex || '#6b6040').lerp(new THREE.Color('#c8b890'), 0.45);
        this.smoke = new Pool(MAX_SMOKE, SMOKE_FRAG, THREE.NormalBlending);
        this.sparks = new Pool(MAX_SPARKS, SPARK_FRAG, THREE.AdditiveBlending);
        this.skids = new SkidMarks();
        this.group = new THREE.Group();
        this.group.name = 'pocabinet-fx';
        this.group.add(this.skids.mesh, this.smoke.points, this.sparks.points);
        sceneHandle.scene.add(this.group);
        this.state = new Map();
        this.pairs = new Map();
        this.wallLat = track.halfWidth + RUN_OFF - CAR_RADIUS * 0.5;
        this.size = new THREE.Vector2();
        this.disposed = false;
    }

    /** Burst of smoke off the rear wheels for `seconds` (launch at GO). */
    launch(id, seconds = 0.8, strength = 1) {
        const s = this.state.get(id) || this.newState();
        s.launch = seconds;
        s.launchStrength = strength;
        this.state.set(id, s);
    }

    newState() {
        return { h: null, x: 0, y: 0, v: 0, lat: 0, hint: -1, skid: [null, null], launch: 0, launchStrength: 1, acc: 0, walled: false, wallAt: 0 };
    }

    /** A flame out of the tail of car `id` (its last pose), `strength` 0..1. */
    backfire(id, strength = 1) {
        const s = this.state.get(id);
        if (!s || s.h === null || this.disposed) return;
        const rnd = Math.random;
        const fx = Math.cos(s.h), fz = Math.sin(s.h);
        const x = s.x / WS - fx * 2.02, z = s.y / WS - fz * 2.02;
        const n = 4 + Math.round(strength * 6);
        for (let i = 0; i < n; i++) {
            const k = rnd();
            const out = 2.5 + rnd() * 4 * strength;
            // Core blue-white, tips orange: brighter the closer to the pipe.
            const hot = k < 0.3;
            this.sparks.spawn(
                x + (rnd() - 0.5) * 0.25, 0.3 + rnd() * 0.08, z + (rnd() - 0.5) * 0.25,
                -fx * out + (rnd() - 0.5) * 0.8, 0.2 + rnd() * 0.5, -fz * out + (rnd() - 0.5) * 0.8,
                0.06 + rnd() * 0.1 * (0.5 + strength), 0.55 + strength * 0.35, 0.12, 1,
                hot ? 0.6 : 1.0, hot ? 0.75 : 0.45 + k * 0.25, hot ? 1.0 : 0.12, 7, -1.5);
        }
    }

    /** Chunks of trim and flakes of `paint` (hex) flying off a shunt at world (x, z). */
    debris(x, z, paint, strength = 1) {
        if (this.disposed) return;
        const rnd = Math.random;
        const c = new THREE.Color(paint || '#888888');
        const n = Math.round(4 + strength * 10);
        for (let i = 0; i < n; i++) {
            const flake = rnd() < 0.55;
            const shade = 0.08 + rnd() * 0.1;
            this.smoke.spawn(x, 0.4 + rnd() * 0.3, z,
                (rnd() - 0.5) * 7 * strength, 1.5 + rnd() * 3.5 * strength, (rnd() - 0.5) * 7 * strength,
                0.7 + rnd() * 0.8, 0.14 + rnd() * 0.08, 0.1, 1,
                flake ? c.r : shade, flake ? c.g : shade, flake ? c.b : shade, 0.4, 9.8);
        }
    }

    /** A shower of confetti over world (x, z) — the podium moment. */
    confetti(x, z, count = 160) {
        if (this.disposed) return;
        const rnd = Math.random;
        const col = new THREE.Color();
        for (let i = 0; i < count; i++) {
            col.setHSL(rnd(), 0.85, 0.58);
            this.smoke.spawn(x + (rnd() - 0.5) * 8, 7 + rnd() * 4, z + (rnd() - 0.5) * 8,
                (rnd() - 0.5) * 5, 2 + rnd() * 4, (rnd() - 0.5) * 5,
                3 + rnd() * 2, 0.16, 0.14, 1, col.r, col.g, col.b, 1.6, 1.4);
        }
    }

    /**
     * @param dt   seconds (already scaled for slow motion)
     * @param cars [{ id, x, y, heading, speed, sliding?, visible }] — sim units
     * @param opts { skids: bool } — false during replays (marks are already down)
     * @returns {{ contacts: Array<{ x, z, strength, ids: [a, b] }>, scraping: Map<id, number> }}
     */
    update(dt, cars, opts = {}) {
        const events = { contacts: [], scraping: new Map(), walls: [] };
        if (this.disposed || dt <= 0) return events;
        const t = this.track;
        const hw = t.halfWidth;
        const skidsOn = opts.skids !== false;
        const rnd = Math.random;

        for (const c of cars) {
            let s = this.state.get(c.id);
            if (!s) { s = this.newState(); this.state.set(c.id, s); }
            const proj = t.project(c.x, c.y, s.hint);
            s.hint = proj.index;
            const v = Math.abs(c.speed);
            // A pose that jumped (replay seek, snapshot snap, respawn) is not a slide.
            if (s.h !== null && Math.hypot(c.x - s.x, c.y - s.y) > v * dt * 3 + 20) {
                s.h = null;
                s.lat = 0;
                s.skid = [null, null];
            }
            s.x = c.x; s.y = c.y;
            // Yaw-rate × speed = lateral acceleration; smoothed so interpolation noise never flickers smoke.
            let lat = 0;
            if (s.h !== null) lat = Math.abs(wrapAngle(c.heading - s.h) / dt) * v;
            s.lat += (lat - s.lat) * Math.min(1, dt * 12);
            const decel = s.v - v;
            s.v = v;
            s.h = c.heading;

            const limit = GRIP_ACCEL * this.grip * (Math.abs(proj.lateral) > hw ? 0.6 : 1);
            let slip = Math.max(0, (s.lat / limit - 0.9) * 8);
            if (c.sliding) slip = Math.max(slip, 1);
            if (decel / dt > 115 && v > 40) slip = Math.max(slip, 0.6);
            slip = Math.min(1, slip) * (v > 22 ? 1 : v / 22);
            if (s.launch > 0) { slip = Math.max(slip, s.launchStrength); s.launch -= dt; }

            const x = c.x / WS, z = c.y / WS;
            const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
            const rx = -fz, rz = fx;
            const onGrass = Math.abs(proj.lateral) > hw + 2;
            const vx = fx * c.speed / WS, vz = fz * c.speed / WS;

            for (let w = 0; w < 2; w++) {
                const side = w ? 1 : -1;
                const wx = x - fx * REAR + rx * TRACK_HALF * side;
                const wz = z - fz * REAR + rz * TRACK_HALF * side;
                // Tyre smoke (tarmac) or dust (grass).
                if (slip > 0.2 || (onGrass && v > 20)) {
                    s.acc += dt * (onGrass ? 26 * Math.min(1, v / 60) : 55 * slip);
                    while (s.acc >= 1) {
                        s.acc -= 1;
                        const col = onGrass ? this.dust : null;
                        const shade = 0.72 + rnd() * 0.12;
                        this.smoke.spawn(
                            wx + (rnd() - 0.5) * 0.3, 0.25, wz + (rnd() - 0.5) * 0.3,
                            vx * 0.25 + (rnd() - 0.5) * 1.2, 0.5 + rnd() * 0.9, vz * 0.25 + (rnd() - 0.5) * 1.2,
                            onGrass ? 0.9 : 1.2 + rnd() * 0.9, 0.5, onGrass ? 2.4 : 3.6 + rnd() * 1.4,
                            onGrass ? 0.35 : 0.22 + slip * 0.2,
                            col ? col.r : shade, col ? col.g : shade, col ? col.b : shade * 1.02, 1.4, -0.25);
                    }
                }
                // Rain spray off the rear wheels.
                if (this.raining && v > 35 && !onGrass && rnd() < dt * 22 * (v / 140)) {
                    this.smoke.spawn(wx, 0.2, wz, vx * 0.35 + (rnd() - 0.5), 0.6 + rnd() * 0.5, vz * 0.35 + (rnd() - 0.5),
                        0.55, 0.6, 2.6, 0.11, 0.8, 0.84, 0.88, 2.2, 0.4);
                }
                // Skid marks.
                if (skidsOn && slip > 0.45 && !onGrass) {
                    const prev = s.skid[w];
                    if (prev) {
                        const d2 = (wx - prev[0]) ** 2 + (wz - prev[1]) ** 2;
                        if (d2 > 0.35 * 0.35) {
                            if (d2 < 9) this.skids.add(prev[0], prev[1], wx, wz);
                            s.skid[w] = [wx, wz];
                        }
                    } else {
                        s.skid[w] = [wx, wz];
                    }
                } else {
                    s.skid[w] = null;
                }
            }

            // Barrier scrape: the physics clamps a car's centre at wallLat.
            const wall = Math.abs(proj.lateral) >= this.wallLat - 0.8 && v > 18;
            if (wall) {
                const side = proj.lateral > 0 ? 1 : -1;
                const nx = -proj.ty * side, nz = proj.tx * side;
                const px = x + nx * CAR_RADIUS * 0.5 / WS, pz = z + nz * CAR_RADIUS * 0.5 / WS;
                const n = Math.min(6, Math.ceil(v / 25));
                for (let i = 0; i < n; i++) {
                    if (rnd() > dt * 40) continue;
                    this.spark(px, 0.35, pz, -vx * 0.5 + (rnd() - 0.5) * 4 - nx * 2, 1.5 + rnd() * 3.5, -vz * 0.5 + (rnd() - 0.5) * 4 - nz * 2);
                }
                events.scraping.set(c.id, Math.min(1, v / 100));
                // First touch of a stint along the wall is the hit; riding it is only the scrape.
                const now = performance.now();
                if (!s.walled && now - s.wallAt > 500) {
                    s.wallAt = now;
                    events.walls.push({ id: c.id, x: px, z: pz, strength: Math.min(1, v / 110) });
                }
            }
            s.walled = wall;
        }

        // Car-to-car contact: centres closer than two radii (+ a little for interpolation).
        const now = performance.now();
        for (let i = 0; i < cars.length; i++) {
            for (let j = i + 1; j < cars.length; j++) {
                const a = cars[i], b = cars[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy);
                if (d > CAR_RADIUS * 2 + 1.5 || d < 1e-6) continue;
                const mx = (a.x + b.x) / 2 / WS, mz = (a.y + b.y) / 2 / WS;
                const rel = Math.hypot(
                    Math.cos(a.heading) * a.speed - Math.cos(b.heading) * b.speed,
                    Math.sin(a.heading) * a.speed - Math.sin(b.heading) * b.speed);
                const n = Math.min(10, 2 + Math.floor(rel / 8));
                for (let k = 0; k < n; k++) {
                    this.spark(mx, 0.45, mz, (rnd() - 0.5) * 6, 1 + rnd() * 3, (rnd() - 0.5) * 6);
                }
                const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
                if (now - (this.pairs.get(key) || 0) > 350) {
                    this.pairs.set(key, now);
                    events.contacts.push({ x: mx, z: mz, strength: Math.min(1, 0.25 + rel / 60), ids: [a.id, b.id] });
                }
            }
        }

        this.smoke.step(dt);
        this.sparks.step(dt);
        this.skids.flush();
        this.updateScale();
        return events;
    }

    spark(x, y, z, vx, vy, vz) {
        const r = Math.random();
        this.sparks.spawn(x, y, z, vx, vy, vz, 0.25 + r * 0.35, 0.28, 0.08, 1,
            1.0, 0.55 + r * 0.3, 0.18 + r * 0.1, 0.6, 9.8);
    }

    updateScale() {
        const r = this.sh.renderer, cam = this.sh.camera;
        r.getDrawingBufferSize(this.size);
        const scale = this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
        this.smoke.material.uniforms.uScale.value = scale;
        this.sparks.material.uniforms.uScale.value = scale;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.group.parent?.remove(this.group);
        this.smoke.dispose();
        this.sparks.dispose();
        this.skids.dispose();
        this.state.clear();
    }
}

export function createFx(sceneHandle, track, opts) {
    return new CarFx(sceneHandle, track, opts);
}
