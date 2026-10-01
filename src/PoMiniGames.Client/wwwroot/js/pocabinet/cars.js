// pocabinet/cars.js
//
// Car models for PoCabinet. One shared set of geometries per body style per page;
// per-car materials (paint colour, light intensities) so a livery never touches
// another car.
//
// The model: an extruded side profile for the body, a glass greenhouse with a
// painted roof and pillars, mirrors and trim merged into as few draw calls as
// possible (paint / trim / glass / lights), four wheels (tyre + spoked rim) on
// pivots so the fronts steer, and a soft contact shadow. The body styles (STYLES:
// coupe, hatchback, pickup, van, muscle car) share the lower body and the wheels and
// differ in the cabin and what is behind it. Paint is satin: a thin clearcoat over a
// rough base (the showroom gloss it had made the field a hundred mirrors).
//
// Everything is derived from the pose race.js already has: steering angle from
// yaw rate, body roll from lateral acceleration, pitch and brake lights from
// longitudinal acceleration. Nothing here reads or changes physics.
//
// Damage is per car: addDamage() records up to eight hits, and one onBeforeCompile
// hook on every chassis material (paint, glass, trim, lights: they share the car's
// hit list, so nothing is left floating where a panel used to be) crushes the zone
// round each in the direction the hit came from, shades the bent metal by its own
// folds, dulls the clearcoat and scuffs through to primer. A hard hit by a wheel
// bends it too. A full car is drawn from a tessellated copy of the body (`fine`):
// the plain one is a few long panels with nothing between their edges to bend.
// Every car shares the programs (one cache key); only the uniforms differ. What a
// hit does to the driving is race.js's business (the player's car only), not this
// file's.
//
// World: sim (x, y) → three (x / 10, 0, y / 10); the car is built along +X and
// rotated by −heading about Y (unchanged from the box cars it replaces).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';

const WHEEL_R = 0.36;
const WHEELS = [[1.2, 0.8, true], [1.2, -0.8, true], [-1.22, 0.8, false], [-1.22, -0.8, false]];

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

/**
 * Body styles. One footprint and wheelbase for all of them (the physics hull is one size
 * for everyone); what differs is the silhouette: where the cabin sits, how tall it is and
 * what is behind it. `cabin` is the x of its rear base, rear top, front top and front base.
 */
const STYLES = [
    { cabin: [-1.08, -0.5, 0.34, 0.96], roof: 1.06, wing: true },    // coupe (the player's)
    { cabin: [-1.74, -1.5, 0.3, 0.98], roof: 1.14 },                 // hatchback
    { cabin: [-0.3, -0.18, 0.42, 1.0], roof: 1.2, bed: true },       // pickup
    { cabin: [-1.8, -1.72, 0.95, 1.5], roof: 1.42 },                 // van
    { cabin: [-1.2, -0.7, -0.05, 0.5], roof: 1.02, wing: true },     // long-bonnet muscle car
];

let COMMON = null;
const GEO = [];

/** Parts every style shares: the lower body's profile, lights, wheels, contact shadow. */
function common() {
    if (COMMON) return COMMON;
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

    COMMON = { body: extrude(body, 1.66, 0.07), head, tail, tyre, rim, shadow };
    return COMMON;
}

/** The geometries of body style `index`: the shared parts plus its own paint, glass and trim. */
function geometry(index) {
    if (GEO[index]) return GEO[index];
    const c = common();
    const s = STYLES[index];
    const [rb, rt, ft, fb] = s.cabin;
    const top = s.roof, mid = (rt + ft) / 2;

    // Wheel arches: dark cut-outs are faked by the trim arches below.
    const cabin = new THREE.Shape();
    cabin.moveTo(rb, 0.66);
    cabin.lineTo(fb, 0.66);
    cabin.quadraticCurveTo((fb + ft) / 2 - 0.05, (0.66 + top) / 2 + 0.065, ft, top - 0.01);
    cabin.lineTo(rt, top);
    cabin.quadraticCurveTo((rb + rt) / 2, (0.66 + top) / 2 + 0.09, rb, 0.66);
    const glass = extrude(cabin, 1.3, 0.04);

    const painted = [
        c.body,
        box(ft - rt + 0.06, 0.045, 1.26, mid, top + 0.015, 0),                           // roof
        strut(fb, 0.67, ft, top, 0.62, 0.06), strut(fb, 0.67, ft, top, -0.62, 0.06),     // A-pillars
        strut(rb, 0.67, rt, top + 0.01, 0.62, 0.07), strut(rb, 0.67, rt, top + 0.01, -0.62, 0.07),   // C-pillars
        box(0.06, top - 0.66, 0.06, mid, (top + 0.66) / 2, 0.63), box(0.06, top - 0.66, 0.06, mid, (top + 0.66) / 2, -0.63),   // B-pillars
        box(0.12, 0.2, 0.08, fb - 0.24, 0.74, 0.86), box(0.12, 0.2, 0.08, fb - 0.24, 0.74, -0.86),   // mirrors
    ];
    const trimmed = [
        box(0.1, 0.16, 1.5, 1.96, 0.3, 0),                           // front bumper lip
        box(0.08, 0.14, 1.1, 1.93, 0.43, 0),                         // grille
        box(0.1, 0.16, 1.5, -1.95, 0.3, 0),                          // rear diffuser
        box(3.3, 0.06, 1.5, 0, 0.2, 0),                              // floor
        box(2.0, 0.08, 0.04, 0, 0.26, 0.86), box(2.0, 0.08, 0.04, 0, 0.26, -0.86),     // sills
    ];
    if (s.wing) {
        painted.push(box(0.34, 0.035, 1.72, -1.72, 0.9, 0));
        trimmed.push(box(0.06, 0.16, 0.05, -1.66, 0.8, 0.5), box(0.06, 0.16, 0.05, -1.66, 0.8, -0.5));   // wing stands
    }
    if (s.bed) {
        // Load bed: two rails and a tailgate on the rear deck.
        painted.push(box(1.42, 0.16, 0.07, -1.1, 0.77, 0.76), box(1.42, 0.16, 0.07, -1.1, 0.77, -0.76), box(0.07, 0.16, 1.59, -1.8, 0.77, 0));
    }
    const paint = mergeGeometries(painted);
    const trim = mergeGeometries(trimmed);

    // The chassis again with no edge longer than a hand's width, for the cars drawn in full:
    // a dent can only move vertices, and the bonnet is otherwise one quad from wing to wing.
    const tess = new TessellateModifier(0.3, 6);
    const fine = { paint: tess.modify(paint), glass: tess.modify(glass), trim: tess.modify(trim) };

    GEO[index] = { ...c, paint, glass, trim, fine };
    return GEO[index];
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
        glass: new THREE.MeshPhysicalMaterial({ color: '#0c1116', roughness: 0.18, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.15 }),
        trim: new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.55, metalness: 0.2 }),
        tyre: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92, metalness: 0 }),
        rim: new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.5, metalness: 0.7 }),
        shadow: new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.75 }),
    };
    return SHARED;
}

const MAX_DENTS = 8;
const DENT_MERGE = 0.55;   // a hit this close to an existing dent deepens it instead

/**
 * The dent hook on one of a car's chassis materials; `dents` is that car's hit list (xyz on
 * the body, w = how hard, 0..1), shared by all of them. Chunk names are three 0.165's; a
 * material without one of them (the unlit lights) simply skips that part.
 */
function dentable(material, dents) {
    material.onBeforeCompile = (shader) => {
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
    // A harder hit crushes a wider zone, and all of it the way the hit was going: in toward
    // the car's spine and a little down, as a panel folds. Not each vertex toward the middle,
    // which shrank the corner instead of pushing it in.
    float reach = 0.45 + 0.75 * d.w;
    float f = d.w * (1.0 - smoothstep(0.0, reach, distance(position, d.xyz)));
    vDamage = max(vDamage, f);
    vec3 dir = normalize(vec3(d.x * 0.55, 0.3, 0.0) - d.xyz);
    float crease = 0.72 + 0.28 * sin(position.x * 23.0 + position.y * 17.0 + position.z * 29.0);
    transformed += dir * f * 0.34 * crease;
}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
varying float vDamage;
varying vec3 vPanel;`)
            .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
{
    // Bent metal catches the light fold by fold: where the body is crushed, shade it by the
    // crushed surface itself (the vertex normals still describe the undamaged car).
    vec3 folded = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    normal = normalize(mix(normal, folded, smoothstep(0.03, 0.3, vDamage)));
    nonPerturbedNormal = normal;
}`)
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
    material.customProgramCacheKey = () => 'pocabinet-dents';
    return material;
}

const HEAD_DAY = new THREE.Color('#fff4dc').multiplyScalar(1.2);
const TAIL = new THREE.Color('#ff1a12');

class CarHandle {
    constructor(group, chassis, mats, dents, wheels, style) {
        this.group = group;
        this.chassis = chassis;
        this.mats = mats;               // this car's own materials, all dented from `dents`
        this.paint = mats.paint;
        this.tailMat = mats.tail;
        this.dents = dents;
        this.wheels = wheels;
        this.style = style;             // index into STYLES (the crowd draws by it)
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
        const dents = this.dents;
        const s = Math.min(1, Math.max(0.15, Number(strength) || 0));
        // A hard hit by a wheel bends it for good (update() leans it in and toes it out).
        for (const w of this.wheels) {
            const d = Math.hypot(w.pivot.position.x - p.x, w.pivot.position.z - p.z);
            if (s > 0.4 && d < 0.9) w.bent = Math.min(1, w.bent + (s - 0.4) * (1 - d / 0.9) * 1.6);
        }
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
     * Place the car. `snap` = { x, y, heading, speedKmh } (sim units), plus on a track with
     * height { h, pitch, roll }: the road's height (world units), slope and bank under it.
     * Called every rendered frame by race.js; the secondary motion is time-based.
     */
    update(snap) {
        if (this.disposed || !snap) return;
        const now = performance.now();
        const x = snap.x / 10, z = snap.y / 10;
        const speed = (Number(snap.speedKmh) || 0) / 2 / 10;     // world units/s
        this.group.position.set(x, Number(snap.h) || 0, z);
        // Yaw, then the road's slope about the car's own lateral axis, then its bank about
        // the car's length (+ roll = right side up; the car's right is local +Z).
        this.group.rotation.set(-(Number(snap.roll) || 0), -snap.heading, Number(snap.pitch) || 0, 'YZX');

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
            // The car's right is +Z: a bent wheel leans in at the top and points away from the car.
            const out = w.pivot.position.z > 0 ? -w.bent : w.bent;
            w.pivot.rotation.x = out * 0.2;
            w.pivot.rotation.y = (w.front ? this.steer : 0) + out * 0.12;
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
        for (const m of Object.values(this.mats)) m.dispose();
    }
}


/**
 * Build a car and add it to `parent`. Returns a handle with `update(snap)`,
 * `addDamage(x, z, s)` and `dispose()`.
 * @param {THREE.Object3D} parent
 * @param {{ id?: string, name: string, color?: string, style?: number }} opts  style: any
 *        integer, taken round the body styles (0 = the coupe)
 */
export function mountCar(parent, opts) {
    if (!parent) throw new Error('pocabinet/cars: parent object is required');
    if (!opts || !opts.name) throw new Error('pocabinet/cars: opts.name is required');
    const style = (((opts.style | 0) % STYLES.length) + STYLES.length) % STYLES.length;
    const g = geometry(style);
    const m = shared();

    const dents = Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 0, 0, 0));
    const mats = {
        // Satin, not showroom: a thin clearcoat over a rough base, so a field of a hundred
        // reads as paint colours rather than as a hundred mirrors of the sky.
        paint: dentable(new THREE.MeshPhysicalMaterial({
            color: opts.color || '#888888', roughness: 0.58, metalness: 0.15,
            clearcoat: 0.25, clearcoatRoughness: 0.4,
        }), dents),
        glass: dentable(m.glass.clone(), dents),
        trim: dentable(m.trim.clone(), dents),
        head: dentable(new THREE.MeshBasicMaterial({ color: HEAD_DAY.clone() }), dents),
        tail: dentable(new THREE.MeshBasicMaterial({ color: TAIL.clone() }), dents),
    };

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
    add(g.fine.paint, mats.paint);
    add(g.fine.glass, mats.glass);
    add(g.fine.trim, mats.trim);
    add(g.head, mats.head, chassis, false);
    add(g.tail, mats.tail, chassis, false);

    const wheels = [];
    for (const [x, z, front] of WHEELS) {
        const pivot = new THREE.Group();
        pivot.position.set(x, WHEEL_R, z);
        group.add(pivot);
        const tyre = add(g.tyre, m.tyre, pivot);
        const rim = add(g.rim, m.rim, pivot);
        wheels.push({ pivot, tyre, rim, front, bent: 0 });
    }

    const shadow = new THREE.Mesh(g.shadow, m.shadow);
    shadow.position.y = 0.03;
    shadow.renderOrder = 1;
    group.add(shadow);

    parent.add(group);
    return new CarHandle(group, chassis, mats, dents, wheels, style);
}

export function unmountCar(handle) {
    if (!handle) return;
    handle.dispose();
}

/**
 * Every car that is not drawn in full, as one instanced mesh per body style (2026-09-30,
 * the 100-car field). A full car is fourteen draw calls and as many again in the shadow
 * pass; a hundred of them took a 29 fps frame to 3. A crowd mesh is the plain body, glass,
 * trim and tyres of its style merged into one geometry: the paint is the instance colour,
 * the rest is baked dark in vertex colour, and it casts its shadow in one call too. race.js
 * fills them each frame from the handles it is not showing (CarHandle.update has already
 * placed them).
 */
export class CarCrowd {
    constructor(parent, max) {
        const shaded = (geom, v) => {
            const c = geom.index ? geom.toNonIndexed() : geom.clone();
            c.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(c.attributes.position.count * 3).fill(v), 3));
            return c;
        };
        this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
        this.max = max;
        this.meshes = STYLES.map((_, style) => {
            const g = geometry(style);
            const parts = [shaded(g.paint, 1), shaded(g.glass, 0.04), shaded(g.trim, 0.07)];
            for (const [x, z] of WHEELS) parts.push(shaded(g.tyre, 0.05).translate(x, WHEEL_R, z));
            const mesh = new THREE.InstancedMesh(mergeGeometries(parts), this.material, max);
            for (const p of parts) p.dispose();
            mesh.name = `pocabinet-car-crowd-${style}`;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;   // its bounds are wherever the field is
            mesh.count = 0;
            parent.add(mesh);
            return mesh;
        });
    }

    begin() { for (const m of this.meshes) m.count = 0; }

    /** Draw `handle`'s car here this frame (its own group should be hidden). */
    add(handle) {
        const mesh = this.meshes[handle.style];
        if (handle.disposed || mesh.count >= this.max) return;
        handle.group.updateMatrix();
        mesh.setMatrixAt(mesh.count, handle.group.matrix);
        mesh.setColorAt(mesh.count, handle.paint.color);
        mesh.count++;
    }

    end() {
        for (const m of this.meshes) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
    }

    dispose() {
        for (const m of this.meshes) {
            m.parent?.remove(m);
            m.geometry.dispose();
            m.dispose();
        }
        this.material.dispose();
    }
}
