// pocabinet/cars.js
//
// Car models for PoCabinet. One shared set of geometries per page; per-car
// materials (paint colour, light intensities) so a livery never touches another car.
//
// The model: an extruded side profile for the body, a glass greenhouse with a
// painted roof and pillars, spoiler, mirrors and trim merged into as few draw calls
// as possible (paint / trim / glass / lights), four wheels (tyre + spoked rim) on
// pivots so the fronts steer, and a soft contact shadow. Paint is a clearcoat
// MeshPhysicalMaterial, so the sky environment map shows in it.
//
// Everything is derived from the pose race.js already has: steering angle from
// yaw rate, body roll from lateral acceleration, pitch and brake lights from
// longitudinal acceleration. Nothing here reads or changes physics.
//
// Damage (2026-09-29) is cosmetic and per car: addDamage() records up to eight
// dents in the car's own paint material, and one onBeforeCompile hook crumples the
// panel toward the body's core, dulls the clearcoat and scuffs through to primer
// around each. Every car shares the program (one cache key); only the uniforms
// differ. A car never drives any differently for it.
//
// World: sim (x, y) → three (x / 10, 0, y / 10); the car is built along +X and
// rotated by −heading about Y (unchanged from the box cars it replaces).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHEEL_R = 0.36;
const WHEELS = [[1.2, 0.8, true], [1.2, -0.8, true], [-1.22, 0.8, false], [-1.22, -0.8, false]];

let GEO = null;

function extrude(shape, width, bevel) {
    const g = new THREE.ExtrudeGeometry(shape, {
        depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
        bevelSegments: 3, curveSegments: 12,
    });
    g.translate(0, 0, -(width - bevel * 2) / 2);
    return g;
}

/** A box placed by a matrix, de-indexed so it merges with extrusions. */
function box(w, h, d, x, y, z, rz = 0, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz)),
        new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return g.toNonIndexed();
}

function strut(x0, y0, x1, y1, z, t) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    return box(len, t, t, (x0 + x1) / 2, (y0 + y1) / 2, z, Math.atan2(y1 - y0, x1 - x0));
}

function geometry() {
    if (GEO) return GEO;
    // Side profile: x forward, y up, extruded across the width (z).
    const body = new THREE.Shape();
    body.moveTo(-1.84, 0.22);
    body.lineTo(1.8, 0.22);
    body.quadraticCurveTo(1.95, 0.24, 1.94, 0.4);
    body.quadraticCurveTo(1.9, 0.52, 1.7, 0.56);
    body.quadraticCurveTo(1.3, 0.63, 0.98, 0.66);
    body.lineTo(-1.1, 0.69);
    body.quadraticCurveTo(-1.62, 0.71, -1.84, 0.66);
    body.quadraticCurveTo(-1.96, 0.46, -1.84, 0.22);
    const bodyGeo = extrude(body, 1.66, 0.07);

    // Wheel arches: dark cut-outs are faked by the trim arches below.
    const cabin = new THREE.Shape();
    cabin.moveTo(-1.08, 0.66);
    cabin.lineTo(0.96, 0.66);
    cabin.quadraticCurveTo(0.6, 0.92, 0.34, 1.05);
    cabin.lineTo(-0.5, 1.06);
    cabin.quadraticCurveTo(-0.8, 0.95, -1.08, 0.66);
    const glass = extrude(cabin, 1.3, 0.04);

    const paint = mergeGeometries([
        bodyGeo,
        box(0.9, 0.045, 1.26, -0.08, 1.075, 0),                      // roof
        strut(0.96, 0.67, 0.34, 1.06, 0.62, 0.06), strut(0.96, 0.67, 0.34, 1.06, -0.62, 0.06),     // A-pillars
        strut(-1.08, 0.67, -0.5, 1.07, 0.62, 0.07), strut(-1.08, 0.67, -0.5, 1.07, -0.62, 0.07),   // C-pillars
        box(0.06, 0.4, 0.06, -0.08, 0.86, 0.63), box(0.06, 0.4, 0.06, -0.08, 0.86, -0.63),          // B-pillars
        box(0.34, 0.035, 1.72, -1.72, 0.9, 0),                       // wing
        box(0.12, 0.2, 0.08, 0.72, 0.74, 0.86), box(0.12, 0.2, 0.08, 0.72, 0.74, -0.86), // mirrors
    ]);
    const trim = mergeGeometries([
        box(0.1, 0.16, 1.5, 1.96, 0.3, 0),                           // front bumper lip
        box(0.08, 0.14, 1.1, 1.93, 0.43, 0),                         // grille
        box(0.1, 0.16, 1.5, -1.95, 0.3, 0),                          // rear diffuser
        box(0.06, 0.16, 0.05, -1.66, 0.8, 0.5), box(0.06, 0.16, 0.05, -1.66, 0.8, -0.5), // wing stands
        box(3.3, 0.06, 1.5, 0, 0.2, 0),                              // floor
        box(2.0, 0.08, 0.04, 0, 0.26, 0.86), box(2.0, 0.08, 0.04, 0, 0.26, -0.86),     // sills
    ]);
    const head = mergeGeometries([box(0.05, 0.09, 0.34, 1.9, 0.5, 0.52), box(0.05, 0.09, 0.34, 1.9, 0.5, -0.52)]);
    const tail = mergeGeometries([box(0.05, 0.1, 0.36, -1.9, 0.56, 0.56), box(0.05, 0.1, 0.36, -1.9, 0.56, -0.56)]);

    const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 24, 1);
    tyre.rotateX(Math.PI / 2);
    const rimParts = [];
    const disc = new THREE.CylinderGeometry(0.25, 0.25, 0.29, 20, 1);
    disc.rotateX(Math.PI / 2);
    rimParts.push(disc.toNonIndexed());
    for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2;
        for (const z of [0.147, -0.147]) {
            const s = new THREE.BoxGeometry(0.22, 0.045, 0.012);
            s.translate(0.11, 0, 0);
            s.rotateZ(a);
            s.translate(0, 0, z);
            rimParts.push(s.toNonIndexed());
        }
    }
    const rim = mergeGeometries(rimParts);

    const shadow = new THREE.PlaneGeometry(4.6, 2.5);
    shadow.rotateX(-Math.PI / 2);

    GEO = { paint, glass, trim, head, tail, tyre, rim, shadow };
    return GEO;
}

let shadowTex = null;
function contactShadowTexture() {
    if (shadowTex) return shadowTex;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 32, 4, 64, 32, 62);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 64);
    shadowTex = new THREE.CanvasTexture(c);
    return shadowTex;
}

// Shared (colour-independent) materials.
let SHARED = null;
function shared() {
    if (SHARED) return SHARED;
    SHARED = {
        glass: new THREE.MeshPhysicalMaterial({ color: '#0c1116', roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02 }),
        trim: new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.55, metalness: 0.2 }),
        tyre: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92, metalness: 0 }),
        rim: new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.22, metalness: 1 }),
        shadow: new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.75 }),
    };
    return SHARED;
}

const MAX_DENTS = 8;
const DENT_MERGE = 0.55;   // a hit this close to an existing dent deepens it instead

/** The dent hook on one car's paint: uniforms are this material's own. */
function dentable(paint) {
    const dents = Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 0, 0, 0));
    paint.userData.dents = dents;
    paint.onBeforeCompile = (shader) => {
        shader.uniforms.uDents = { value: dents };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
uniform vec4 uDents[${MAX_DENTS}];
varying float vDamage;
varying vec3 vPanel;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
vDamage = 0.0;
vPanel = position;
for (int i = 0; i < ${MAX_DENTS}; i++) {
    vec4 d = uDents[i];
    if (d.w <= 0.0) continue;
    float f = d.w * (1.0 - smoothstep(0.0, 0.8, distance(position, d.xyz)));
    vDamage = max(vDamage, f);
    vec3 core = vec3(position.x * 0.7, 0.45, 0.0);
    float wob = 0.7 + 0.3 * sin(position.x * 23.0 + position.y * 17.0 + position.z * 29.0);
    transformed -= normalize(position - core + 1e-4) * f * 0.17 * wob;
}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
varying float vDamage;
varying vec3 vPanel;`)
            .replace('#include <color_fragment>', `#include <color_fragment>
{
    float scuff = smoothstep(0.1, 0.8, vDamage);
    vec3 cell = floor(vPanel * vec3(38.0, 11.0, 38.0));
    float scratch = step(0.8, fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
    diffuseColor.rgb *= 1.0 - scuff * 0.5;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.52, 0.55), scratch * smoothstep(0.3, 0.95, vDamage));
}`)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.9, smoothstep(0.1, 0.7, vDamage));`)
            .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat *= 1.0 - smoothstep(0.1, 0.6, vDamage);
#endif`);
    };
    paint.customProgramCacheKey = () => 'pocabinet-dents';
}

const HEAD_DAY = new THREE.Color('#fff4dc').multiplyScalar(1.2);
const TAIL = new THREE.Color('#ff1a12');

class CarHandle {
    constructor(group, chassis, paint, headMat, tailMat, wheels) {
        this.group = group;
        this.chassis = chassis;
        this.paint = paint;
        this.headMat = headMat;
        this.tailMat = tailMat;
        this.wheels = wheels;
        this.disposed = false;
        this.spin = 0;
        this.steer = 0;
        this.roll = 0;
        this.pitch = 0;
        this.braking = 0;
        this.last = null;
        this.nextDent = 0;
        this._v = new THREE.Vector3();
        this.applyLights();
    }

    /** Paint colour as '#rrggbb' (debris flakes match the car). */
    get paintHex() {
        return `#${this.paint.color.getHexString()}`;
    }

    /**
     * A hit at world (x, z), `strength` 0..1: dent the nearest panel. Returns false
     * when the car is already as bent as it gets there.
     */
    addDamage(x, z, strength) {
        if (this.disposed) return false;
        const p = this.group.worldToLocal(this._v.set(x, 0.5, z));
        // Onto the body's skin: clamp into its footprint, then out to the nearest face.
        p.x = Math.max(-1.9, Math.min(1.94, p.x));
        p.z = Math.max(-0.83, Math.min(0.83, p.z));
        if (1.9 - Math.abs(p.x) < 0.83 - Math.abs(p.z)) p.x = Math.sign(p.x || 1) * 1.9;
        else p.z = Math.sign(p.z || 1) * 0.83;
        p.y = 0.48;
        const dents = this.paint.userData.dents;
        const s = Math.min(1, Math.max(0.15, Number(strength) || 0));
        const near = dents.find(d => d.w > 0 && Math.hypot(d.x - p.x, d.z - p.z) < DENT_MERGE);
        if (near) {
            if (near.w >= 1) return false;
            near.w = Math.min(1, near.w + s * 0.5);
            return true;
        }
        dents[this.nextDent].set(p.x, p.y, p.z, s * 0.7);
        this.nextDent = (this.nextDent + 1) % MAX_DENTS;
        return true;
    }

    /**
     * Place the car. `snap` = { x, y, heading, speedKmh } (sim units).
     * Called every rendered frame by race.js; the secondary motion is time-based.
     */
    update(snap) {
        if (this.disposed || !snap) return;
        const now = performance.now();
        const x = snap.x / 10, z = snap.y / 10;
        const speed = (Number(snap.speedKmh) || 0) / 2 / 10;     // world units/s
        this.group.position.set(x, 0, z);
        this.group.rotation.y = -snap.heading;

        if (this.last) {
            const dt = Math.min(0.1, Math.max(1e-3, (now - this.last.t) / 1000));
            let dh = snap.heading - this.last.h;
            dh = Math.atan2(Math.sin(dh), Math.cos(dh));
            const yawRate = dh / dt;
            const accel = (speed - this.last.v) / dt;
            const k = 1 - Math.exp(-dt * 8);
            const steerTarget = Math.max(-0.45, Math.min(0.45, yawRate * 0.35 * (speed > 0.5 ? 1 : 0)));
            this.steer += (steerTarget - this.steer) * k;
            this.roll += (Math.max(-0.07, Math.min(0.07, -yawRate * speed * 0.004)) - this.roll) * k;
            this.pitch += (Math.max(-0.05, Math.min(0.05, accel * 0.0028)) - this.pitch) * k;
            const brake = accel < -3 ? 1 : 0;
            if (brake !== this.braking) { this.braking = brake; this.applyLights(); }
            this.spin -= speed * dt / WHEEL_R;
        }
        this.last = { t: now, h: snap.heading, v: speed };
        this.chassis.rotation.x = this.roll;
        this.chassis.rotation.z = this.pitch;
        for (const w of this.wheels) {
            if (w.front) w.pivot.rotation.y = this.steer;
            w.tyre.rotation.z = this.spin;
            w.rim.rotation.z = this.spin;
        }
    }

    applyLights() {
        this.tailMat.color.copy(TAIL).multiplyScalar(this.braking ? 3.1 : 1.2);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.group.parent) this.group.parent.remove(this.group);
        this.paint.dispose();
        this.headMat.dispose();
        this.tailMat.dispose();
    }
}


/**
 * Build a car and add it to `parent`. Returns a handle with `update(snap)`,
 * `addDamage(x, z, s)` and `dispose()`.
 * @param {THREE.Object3D} parent
 * @param {{ id?: string, name: string, color?: string }} opts
 */
export function mountCar(parent, opts) {
    if (!parent) throw new Error('pocabinet/cars: parent object is required');
    if (!opts || !opts.name) throw new Error('pocabinet/cars: opts.name is required');
    const g = geometry();
    const m = shared();

    const paint = new THREE.MeshPhysicalMaterial({
        color: opts.color || '#888888', roughness: 0.32, metalness: 0.45,
        clearcoat: 1, clearcoatRoughness: 0.05,
    });
    dentable(paint);
    const headMat = new THREE.MeshBasicMaterial({ color: HEAD_DAY.clone() });
    const tailMat = new THREE.MeshBasicMaterial({ color: TAIL.clone() });

    const group = new THREE.Group();
    group.name = `pocabinet-car-${opts.id || opts.name}`;
    const chassis = new THREE.Group();
    group.add(chassis);

    const add = (geom, mat, parentObj = chassis, cast = true) => {
        const mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = cast;
        mesh.receiveShadow = cast;
        parentObj.add(mesh);
        return mesh;
    };
    add(g.paint, paint);
    add(g.glass, m.glass);
    add(g.trim, m.trim);
    add(g.head, headMat, chassis, false);
    add(g.tail, tailMat, chassis, false);

    const wheels = [];
    for (const [x, z, front] of WHEELS) {
        const pivot = new THREE.Group();
        pivot.position.set(x, WHEEL_R, z);
        group.add(pivot);
        const tyre = add(g.tyre, m.tyre, pivot);
        const rim = add(g.rim, m.rim, pivot);
        wheels.push({ pivot, tyre, rim, front });
    }

    const shadow = new THREE.Mesh(g.shadow, m.shadow);
    shadow.position.y = 0.03;
    shadow.renderOrder = 1;
    group.add(shadow);

    parent.add(group);
    return new CarHandle(group, chassis, paint, headMat, tailMat, wheels);
}

export function unmountCar(handle) {
    if (!handle) return;
    handle.dispose();
}
