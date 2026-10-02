// pocabinet/scene.js
//
// Three.js scene for PoCabinet. Owns the renderer, camera, fog, lights and the
// static track meshes, all built from the static world the page hands over
// (PoCabinetTrackGeometry.BuildStaticWorld — the same centerline the physics
// runs on, client and server).
//
// Rendering is physically based: MeshStandard/Physical materials lit by a sun
// (DirectionalLight with a shadow map that follows the car in focus), a
// hemisphere fill, and image-based lighting from a PMREM capture of the sky dome
// (re-captured whenever the weather changes). The frame goes through postfx.js
// (HDR bloom, light shafts, ACES tone mapping). Surfaces use procedural textures
// from materials.js — asphalt with a normal and roughness map, grass with a
// world-space macro tint so it never tiles — plus camera-riding grass blades
// (grass.js) on the green tracks.
//
//   • ground (grass, or a plaza on Press Briefing), sized past the fog
//   • asphalt ribbon, painted edge lines, a chequered start line
//   • barrier walls with a striped face, exactly where physics.js stops a car
//   • racing-line overlay coloured by corner speed (assist)
//   • sky dome (sky.js) and trackside scenery (scenery.js)
//   • Playground only: the imported playground.glb (see PLAYGROUND)
//
// World mapping: sim (x, y) → three (x / 10, h, y / 10). h is 0 everywhere except on a
// track that carries heights (track.z — the Playground run): there the road and its lines,
// the cars and the camera all ride at the centerline's height (tilted by track.bank), the
// part of the loop that is only a return link (track.drawn) is not built at all, tarmac is
// only laid from track.roadFrom on (track.built; before it, an open chute), and there are
// no barrier walls.
//
// Camera: third person only. 'chase' (close), 'far' (high and
// long) and 'tv' (trackside cameras handing off along the lap).
//
// Quality is automatic (there are no render quality or FOV settings):
// the loop watches the frame rate and steps the pixel ratio, bloom depth, shadow map
// and grass down a tier after a sustained dip below 45 fps. It never steps back up
// mid-race; a remount starts at 'high' again.
//
// `handle.fx` is the per-frame bag race.js and environment.js write into (speed,
// rain, flash, shake, kerb rumble, slow motion, focus); the loop turns it into
// FOV kick, camera shake and the shadow/grass follow, and fills in the sun's
// screen position and exposure for the post pass.
//
// API surface:
//   const handle = await mount(canvas, world);
//   handle.setView({ x, y, heading, mode, speed, dt }); handle.setRacingLine(bool);
//   handle.setStartLights(lit, go); handle.setWeather(rain);
//   unmount(handle);

import * as THREE from 'three';
import { buildTrack } from './track.js';
import { RUN_OFF, GRIP_ACCEL } from './physics.js';
import { computeKerbs } from './kerbs.js';
import { Sky } from './sky.js';
import { Scenery } from './scenery.js';
import { PostFx } from './postfx.js';
import { Grass } from './grass.js';
import { asphalt, grass as grassTextures, macro, clock } from './materials.js';

export const WORLD_SCALE = 10;

const SUN_BASE = 3.2;
const HEMI_BASE = 0.7;
const ENV_BASE = 0.85;
const SHADOW_EXTENT = 38;
const GRASS_BLADES = { low: 0, medium: 14000, high: 36000 };
const SHADOW_SIZE = { low: 1024, medium: 1536, high: 2048 };

function hex(value, fallback) {
    try { return new THREE.Color(value || fallback); } catch { return new THREE.Color(fallback); }
}

const RENDER_SCALE = { low: 0.6, medium: 0.8, high: 1 };

// Playground Marble Run: wwwroot/models/playground.glb (metres, +Y up) drawn at 50× around
// the world origin, so 1 model metre = 50 scene units = 500 sim units — the scale the track's
// knots in PoCabinetTrackGeometry were baked at, and the one at which the marble gutter's
// 26 cm floor is as wide as the physics corridor (road + run-off). The track is the marble
// run, without its walls (the gutter's sides would stand eight units
// tall around a one-unit car and hide the rest of the scene). So the model's gutter is hidden
// and, down to track.roadFrom, the scene lays an open chute in its place: the gutter's
// floor, same width, same bank, on the same supports, with two edge lines. From there on
// the gutter has ended at the drop well (marbles fall; cars get a ramp) and the scene builds
// a road: the ramp, down the slide, into the finish tray — tarmac and run-off deck. No
// barriers anywhere; the physics still stops a car at the edge. The well and the four
// marbles are hidden too. Render-only (neither physics copy knows the model exists). Loaded
// async after the track is built; if it fails the race runs on the chute over a plain lawn.
const PLAYGROUND = {
    url: 'models/playground.glb',
    scale: 50,
    hidden: /^SM_Marble(Track|DropWell|_\d)/,
    chuteHex: '#2f86d6',
    // Outline (model metres, x/z) of everything it puts on the ground — pad, posts, slide,
    // marble-run supports and tray — kept free of grass blades.
    footprint: [
        6.9, 0.6, 7.49, 1.99, 7.22, 3.38, 6.52, 4.62, 5.26, 5.36, 3.58, 5.21, 2.3, 4.94, 1.32, 4.71,
        0.5, 5, -0.5, 5.63, -1.49, 5.4, -2.43, 4.98, -3.41, 4.51, -4.32, 3.82, -5.27, 2.99, -6.05, 1.9,
        -6.2, 0.6, -6.07, -0.71, -5.92, -2.06, -5.26, -3.25, -4.21, -4.11, -2.73, -4.24, -1.54, -4.32, -0.48, -4.34,
        0.5, -4.1, 1.26, -3.22, 2.03, -3.09, 3.1, -3.3, 3.96, -2.86, 4.81, -2.28, 5.51, -1.48, 5.86, -0.47,
    ],
};
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/';

/** Sim-unit ring of the model's footprint, or null on tracks without a model. */
function keepOutFor(trackId) {
    return trackId === 'playground' ? PLAYGROUND.footprint.map(v => v * PLAYGROUND.scale * WORLD_SCALE) : null;
}

class SceneHandle {
    constructor(renderer, scene, camera, hemi, sun, canvas) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.ambient = hemi;     // kept under the old name for callers that dim "ambient"
        this.hemi = hemi;
        this.sun = sun;
        this.canvas = canvas;
        this.disposed = false;
        this.track = null;
        this.trackGroup = null;
        this.racingLine = null;
        this.groundMesh = null;
        this.roadMesh = null;
        this.sky = null;
        this.envSky = null;
        this.envTarget = null;
        this.pmrem = new THREE.PMREMGenerator(renderer);
        this.scenery = null;
        this.grass = null;
        this.ownedTextures = [];   // textures a loaded model brought (the rest are module-cached)
        this.post = null;
        this.quality = 'high';
        this.baseFov = camera.fov;
        this.fps = { frames: 0, time: 0, slow: 0 };
        this.userScale = 1;
        this.sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
        this.sunDirVisual = null;
        this.sunVisibility = 0;
        this.raining = false;
        this.fx = {
            speed: 0, rain: 0, flash: 0, slow: 0,
            shake: 0, rumble: 0, reduced: false, focus: null,
            exposure: 1, bloom: 0.7, bloomThreshold: 1, sun: null, sunColor: new THREE.Color(1, 0.9, 0.75),
        };
        this.baseAtmosphere = null;
        this._frameCbs = new Set();
        this._raf = null;
        this._lastNow = null;
        this._tvIndex = -1;
        this._chase = new THREE.Vector3();
        this._chaseLook = new THREE.Vector3();
        this._chaseInit = false;
        this._v = new THREE.Vector3();
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
    }

    /** Register a per-frame callback (receives a DOMHighResTimeStamp). */
    onFrame(cb) {
        if (!this.disposed && typeof cb === 'function') this._frameCbs.add(cb);
    }

    offFrame(cb) {
        this._frameCbs.delete(cb);
    }

    startLoop() {
        if (this._raf !== null) return;
        const loop = (now) => {
            if (this.disposed) return;
            this._raf = requestAnimationFrame(loop);
            const dt = this._lastNow === null ? 0 : Math.min(0.1, (now - this._lastNow) / 1000);
            this._lastNow = now;
            clock.value = now / 1000;
            for (const cb of this._frameCbs) {
                try { cb(now); } catch { /* one bad effect never kills the frame */ }
            }
            this.autoQuality(dt);
            try {
                this.applyFx(dt);
                this.followShadow();
                this.grass?.update(this.camera);
                this.sky?.update(this.camera, this.scene.fog, now / 1000);
                this.scenery?.update(dt, this.fx.focus);
                this.updateSunScreen();
            } catch { /* decoration never kills the frame */ }
            if (this.post) this.post.render(this.scene, this.camera, this.fx, now / 1000);
            else this.renderer.render(this.scene, this.camera);
        };
        this._raf = requestAnimationFrame(loop);
    }

    stopLoop() {
        if (this._raf !== null) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
    }

    /**
     * Place the camera for a car pose. mode: 'chase' | 'far' | 'tv'.
     * Car forward = (cos h, 0, sin h) in three's x/z.
     */
    setView(p) {
        if (this.disposed || !p) return;
        const x = (Number(p.x) || 0) / WORLD_SCALE;
        const z = (Number(p.y) || 0) / WORLD_SCALE;
        const heading = Number(p.heading) || 0;
        const mode = p.mode || 'chase';
        const fx = Math.cos(heading), fz = Math.sin(heading);
        // Road height under the car and its slope (both 0 on a flat track): the camera sits
        // back up the slope and looks down it, so a descent reads as one.
        const h = Number(p.h) || 0;
        const rise = Math.tan(Number(p.pitch) || 0);
        if (mode === 'chase' || mode === 'far') {
            const far = mode === 'far';
            const s01 = Math.min(1, Math.abs(Number(p.speed) || 0) / 140);
            const back = (far ? 13 : 7.4) + s01 * (far ? 2 : 1.6);
            const up = (far ? 5.2 : 2.35) + s01 * 0.25;
            const target = this._v.set(x - fx * back, h - rise * back + up, z - fz * back);
            // Lagged follow so the car swings in frame through corners; time-based so
            // the lag is the same at 30 fps as at 144.
            const dt = Number(p.dt) || 0;
            const k = dt > 0 ? 1 - Math.exp(-dt * (far ? 5 : 8)) : 0.18;
            const ahead = far ? 6 : 4.5;
            const look = new THREE.Vector3(x + fx * ahead, h + rise * ahead + (far ? 0.6 : 1.0), z + fz * ahead);
            if (!this._chaseInit || p.snap) {
                this._chase.copy(target);
                this._chaseLook.copy(look);
                this._chaseInit = true;
            } else {
                this._chase.lerp(target, k);
                this._chaseLook.lerp(look, 1 - Math.exp(-(dt || 0.016) * 14));
            }
            this._chase.y = Math.max(this._chase.y, h + 0.7);
            this.camera.position.copy(this._chase);
            this.camera.lookAt(this._chaseLook);
            return;
        }
        // TV: fixed trackside cameras every eighth of the lap, handing off as the car passes.
        this._chaseInit = false;
        const t = this.track;
        if (!t) return;
        const along = Number(p.along) || 0;
        const idx = Math.floor(((along % t.length) + t.length) % t.length / (t.length / 8) + 0.5) % 8;
        if (idx !== this._tvIndex || !this._tvPos) {
            this._tvIndex = idx;
            const at = idx * (t.length / 8) + 40;
            const q = t.pointAt(at);
            const side = t.halfWidth + RUN_OFF + 30;
            this._tvPos = new THREE.Vector3((q.x - q.ty * side) / WORLD_SCALE, 7 + t.heightAt(at) / WORLD_SCALE, (q.y + q.tx * side) / WORLD_SCALE);
        }
        this.camera.position.copy(this._tvPos);
        this.camera.lookAt(x, h + 0.6, z);
    }

    /**
     * Speed FOV kick + camera shake, applied after setView has placed the camera
     * for this frame (setView fully re-places it next frame, so nothing accumulates).
     */
    applyFx(dt) {
        const fx = this.fx;
        const motion = !fx.reduced;
        const fov = this.baseFov + (motion ? Math.pow(Math.min(1, fx.speed), 1.6) * 8 : 0);
        const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
        const next = this.camera.fov + (fov - this.camera.fov) * k;
        if (Math.abs(next - this.camera.fov) > 0.01) {
            this.camera.fov = next;
            this.camera.updateProjectionMatrix();
        }
        const amp = motion ? Math.min(1, fx.shake + fx.rumble * 0.35) : 0;
        if (amp > 0.002) {
            const r = () => Math.random() - 0.5;
            this.camera.position.x += r() * 0.06 * amp;
            this.camera.position.y += r() * 0.08 * amp;
            this.camera.rotateX(r() * 0.012 * amp);
            this.camera.rotateZ(r() * 0.016 * amp);
        }
        const decay = dt > 0 ? Math.exp(-dt * 7) : 1;
        fx.shake *= decay;
        fx.flash *= dt > 0 ? Math.exp(-dt * 4.5) : 1;
        if (fx.flash < 0.004) fx.flash = 0;
    }

    /** Keep the sun's shadow frustum centred on the action, snapped to texels (no shimmer). */
    followShadow() {
        if (!this.sun.castShadow) return;
        const f = this.fx.focus;
        const cx = f ? f.x : this.camera.position.x;
        const cz = f ? f.z : this.camera.position.z;
        const cy = (f && f.y) || 0;   // the road's height under the car in focus
        const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
        const sx = Math.round(cx / texel) * texel, sz = Math.round(cz / texel) * texel;
        this.sun.target.position.set(sx, cy, sz);
        this.sun.position.set(sx + this.sunDir.x * 90, cy + this.sunDir.y * 90, sz + this.sunDir.z * 90);
    }

    /** Sun position on screen for the glare/shafts, and how visible it is. */
    updateSunScreen() {
        const vis = this.sunVisibility;
        if (!(vis > 0.01) || !this.sunDirVisual) { this.fx.sun = null; return; }
        const p = this._v.copy(this.sunDirVisual).multiplyScalar(1000).add(this.camera.position).project(this.camera);
        const facing = this.camera.getWorldDirection(new THREE.Vector3()).dot(this.sunDirVisual);
        if (p.z >= 1 || facing <= 0) { this.fx.sun = null; return; }
        const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
        const fade = Math.max(0, 1 - Math.max(0, edge - 0.85) / 0.35);
        this.fx.sun = { x: p.x * 0.5 + 0.5, y: p.y * 0.5 + 0.5, v: vis * fade };
    }

    /** Apply player view preferences (reduced motion, racing line). */
    applyView(opts) {
        if (this.disposed) return;
        const o = opts && typeof opts === 'object' ? opts : {};
        // The game's own setting, or the platform's (<html data-motion>: the OS preference
        // or the settings sheet's switch).
        this.fx.reduced = !!o.reducedMotion || document.documentElement.dataset.motion === 'reduce';
        this.setRacingLine(!!o.racingLine);
    }

    /** Step quality down a tier after ~3 s averaging under 45 fps (see the header). */
    autoQuality(dt) {
        const f = this.fps;
        if (!(dt > 0) || this.quality === 'low') return;
        f.frames++;
        f.time += dt;
        if (f.time < 1) return;
        const rate = f.frames / f.time;
        f.frames = 0;
        f.time = 0;
        f.slow = rate < 45 ? f.slow + 1 : 0;
        if (f.slow < 3) return;
        f.slow = 0;
        const next = this.quality === 'high' ? 'medium' : 'low';
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * RENDER_SCALE[next]);
        this.setQuality(next);
        this.resize();
    }

    setQuality(q) {
        if (q === this.quality) return;
        this.quality = q;
        this.post?.setQuality(q);
        const size = SHADOW_SIZE[q];
        if (this.sun.shadow.mapSize.x !== size) {
            this.sun.shadow.mapSize.set(size, size);
            this.sun.shadow.map?.dispose();
            this.sun.shadow.map = null;
        }
        this.buildGrass();
    }

    /** Show or hide the racing-line assist overlay. */
    setRacingLine(visible) {
        if (this.racingLine) this.racingLine.visible = !!visible;
    }

    /** Start gantry: `lit` pods red (0..5), or all green on `go`. */
    setStartLights(lit, go) {
        this.scenery?.setStartLights(lit, go);
    }

    /** Rain or clear: fog and sky colour, light levels, the sky's clouds, and a fresh IBL capture. */
    setWeather(rain) {
        this.raining = !!rain;
        const base = this.baseAtmosphere || {};
        const fog = hex(base.fogHex, '#14233f');
        if (rain) fog.lerp(new THREE.Color('#4d545c'), 0.35);
        this.scene.background = fog.clone();
        if (this.scene.fog) {
            this.scene.fog.color.copy(fog);
            this.scene.fog.near = (Number(base.fogStart) || 220) * (rain ? 0.6 : 1);
            this.scene.fog.far = (Number(base.fogEnd) || 900) * (rain ? 0.75 : 1);
        }
        const ambient = (Number(base.ambientIntensity) || 0.5) / 0.55;
        const day = rain ? 0.5 : 1;
        this.sun.intensity = SUN_BASE * ambient * day;
        this.hemi.intensity = HEMI_BASE * ambient * (0.3 + 0.7 * day);
        this.scene.environmentIntensity = ENV_BASE * (0.25 + 0.75 * day);
        this.sunVisibility = this.sky ? this.sky.preset.sunSize > 0 ? day * (rain ? 0 : 1) : 0 : 0;
        this.fx.exposure = 1;
        this.fx.bloomThreshold = 1.1;
        this.sky?.setRain(rain);
        this.captureEnvironment();
    }

    /** Re-render the sky dome into a PMREM cube for image-based lighting and reflections. */
    captureEnvironment() {
        if (!this.sky) return;
        try {
            if (!this.envSky) {
                this.envSky = new Sky(this.track.id);
                this.envScene = new THREE.Scene();
                this.envScene.add(this.envSky.mesh);
            }
            const src = this.sky.material.uniforms, dst = this.envSky.material.uniforms;
            for (const k of Object.keys(src)) {
                const v = src[k].value;
                dst[k].value = v && v.clone ? v.clone() : v;
            }
            if (this.scene.fog) dst.uHorizon.value.copy(this.scene.fog.color);
            this.envSky.mesh.position.set(0, 0, 0);
            const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
            this.envTarget?.dispose();
            this.envTarget = next;
            this.scene.environment = next.texture;
        } catch (e) {
            console.warn('pocabinet/scene: environment capture skipped', e);
        }
    }

    /** Build (or rebuild) every track mesh for a static world. */
    setTrack(world) {
        if (this.disposed) return;
        const atmosphere = world.atmosphere || {};
        this.baseAtmosphere = { ...atmosphere };
        this.scene.background = hex(atmosphere.skyHex, '#14233f');
        this.scene.fog = new THREE.Fog(hex(atmosphere.fogHex, '#14233f').getHex(),
            Number(atmosphere.fogStart) || 220, Number(atmosphere.fogEnd) || 900);

        this.disposeTrackMeshes();
        this.track = buildTrack(world);
        const group = new THREE.Group();
        group.name = 'pocabinet-track';
        const plaza = this.track.id === 'pressbriefing';

        // Ground: reaches past the fog's far edge so it fades into the sky's horizon.
        const minX = Number(world.minX) || 0, maxX = Number(world.maxX) || 0;
        const minY = Number(world.minY) || 0, maxY = Number(world.maxY) || 0;
        const reach = (Number(atmosphere.fogEnd) || 900) * 1.3;
        const w = (maxX - minX) / WORLD_SCALE + reach * 2, d = (maxY - minY) / WORLD_SCALE + reach * 2;
        const groundGeom = new THREE.PlaneGeometry(w, d);
        groundGeom.rotateX(-Math.PI / 2);
        scaleUv(groundGeom, w / (plaza ? 5 : 7), d / (plaza ? 5 : 7));
        const tex = plaza ? asphalt() : grassTextures();
        const groundMat = macro(new THREE.MeshStandardMaterial({
            color: hex(atmosphere.groundHex, '#2a3a24'), roughness: plaza ? 0.75 : 0.95, metalness: 0,
            map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(0.6, 0.6),
            roughnessMap: plaza ? tex.roughnessMap : null,
        }), plaza ? 40 : 70, plaza ? 0.15 : 0.35);
        const ground = new THREE.Mesh(groundGeom, groundMat);
        ground.position.set((minX + maxX) / 2 / WORLD_SCALE, 0, (minY + maxY) / 2 / WORLD_SCALE);
        ground.receiveShadow = true;
        group.add(ground);
        this.groundMesh = ground;

        const hw = this.track.halfWidth;
        const tar = asphalt();
        const built = (i) => this.track.built(i);
        this.roadMesh = new THREE.Mesh(ribbon(this.track, -hw, hw, 0.02, 45, built),
            macro(new THREE.MeshStandardMaterial({
                color: hex(atmosphere.roadHex, '#393b42'), roughness: 1, metalness: 0,
                map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughnessMap: tar.roughnessMap,
                side: THREE.DoubleSide,
            }), 30, 0.2));
        this.roadMesh.receiveShadow = true;
        group.add(this.roadMesh);
        // A road in the air has no lawn beside it: deck the run-off out to where a car is stopped.
        if (this.track.z) {
            const deckMat = new THREE.MeshStandardMaterial({
                color: hex(atmosphere.groundHex, '#2a3a24').multiplyScalar(0.8), roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
            });
            for (const [a, b] of [[-hw - RUN_OFF, -hw], [hw, hw + RUN_OFF]]) {
                const deck = new THREE.Mesh(ribbon(this.track, a, b, 0.02, 45, built), deckMat);
                deck.receiveShadow = true;
                deck.castShadow = true;
                group.add(deck);
            }
            this.roadMesh.castShadow = true;
        }
        // Where the track stands in for a model's gutter (Playground): the gutter's floor
        // without its walls, as wide as the tarmac and run-off together, the run-off a shade
        // darker. Three strips that meet under the edge lines, not one: where the bank
        // changes a strip twists, and a line laid on a wider strip dips through it.
        if (this.track.roadFrom) {
            const reach = hw + RUN_OFF + 8;   // a car stopped at the edge keeps its wheels on it
            const onChute = (i) => this.track.drawn(i) && !built(i);
            for (const [a, b, shade] of [[-reach, -hw, 0.72], [-hw, hw, 1], [hw, reach, 0.72]]) {
                const chute = new THREE.Mesh(ribbon(this.track, a, b, 0.02, 45, onChute), new THREE.MeshStandardMaterial({
                    color: hex(PLAYGROUND.chuteHex, '#2f86d6').multiplyScalar(shade), roughness: 0.55, metalness: 0, side: THREE.DoubleSide,
                }));
                chute.receiveShadow = true;
                chute.castShadow = true;
                group.add(chute);
            }
        }

        // Edge lines on the tarmac, then the barriers where physics puts the wall.
        const lineMat = new THREE.MeshStandardMaterial({
            color: 0xe8e8e8, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        // On the Playground's chute the lines are all that marks the tarmac: outside them is
        // run-off, which drags like grass.
        for (const [a, b] of [[-hw, -hw + 2.2], [hw - 2.2, hw]]) {
            const line = new THREE.Mesh(ribbon(this.track, a, b, 0.03, 45), lineMat);
            line.receiveShadow = true;
            group.add(line);
        }
        // physics.js stops a car's centre at hw + RUN_OFF - CAR_RADIUS/2; its flank is
        // half a car width further out, so that is where the barrier face belongs.
        // The Playground run has none: in its gutter the gutter's
        // own sides are the wall, and on its ramp and slide the edge of the deck is. The
        // physics still stops a car there.
        const wallLat = hw + RUN_OFF;
        const barrierMat = new THREE.MeshStandardMaterial({
            map: barrierTexture(atmosphere.accentHex), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
        });
        for (const s of this.track.z ? [] : [-1, 1]) {
            const wallMesh = new THREE.Mesh(barrier(this.track, s * wallLat, s, 0.7, 2.5), barrierMat);
            wallMesh.castShadow = true;
            wallMesh.receiveShadow = true;
            group.add(wallMesh);
        }

        group.add(startLine(this.track));

        this.racingLine = racingLineMesh(this.track);
        this.racingLine.visible = false;
        group.add(this.racingLine);

        try {
            this.sky = new Sky(this.track.id);
            group.add(this.sky.mesh);
            this.sunDir = new THREE.Vector3(...this.sky.preset.sun).normalize();
            const light = this.sky.lightDirection();
            this.sunDir.copy(light);
            this.sun.color.copy(new THREE.Color(this.sky.preset.sunSize > 0 ? this.sky.preset.sunColor : '#b8a8ff').lerp(new THREE.Color('#ffffff'), 0.55));
            this.fx.sunColor.copy(new THREE.Color(this.sky.preset.sunColor));
            this.sunDirVisual = new THREE.Vector3(...this.sky.preset.sun).normalize();
            this.hemi.color.copy(new THREE.Color(this.sky.preset.zenith).lerp(new THREE.Color('#ffffff'), 0.5));
            this.hemi.groundColor.copy(hex(atmosphere.groundHex, '#2a3a24'));
        } catch (e) {
            this.sky = null;
            console.warn('pocabinet/scene: sky skipped', e);
        }
        try {
            this.scenery = new Scenery(this.track, { ...world, kerbs: computeKerbs(this.track) });
            group.add(this.scenery.group);
        } catch (e) {
            this.scenery = null;
            console.warn('pocabinet/scene: scenery skipped', e);
        }

        this.scene.add(group);
        this.trackGroup = group;
        this.buildGrass();
        this.setWeather(false);
        if (this.track.id === 'playground') this.loadPlayground(group);
    }

    /** Fetch and place playground.glb into `group`; non-fatal, and dropped if the track changed meanwhile. */
    async loadPlayground(group) {
        let draco = null;
        try {
            const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
                import('three/addons/loaders/GLTFLoader.js'),
                import('three/addons/loaders/DRACOLoader.js'),
            ]);
            draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
            const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(PLAYGROUND.url);
            const model = gltf.scene;
            const textures = new Set();
            model.traverse(o => {
                if (!o.isMesh) return;
                for (const m of [o.material].flat()) {
                    for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
                }
                if (PLAYGROUND.hidden.test(o.name)) {
                    o.visible = false;
                } else if (o.name.startsWith('SM_Ground')) {
                    // The pad has ~0.36 m of relief and dips up to 0.13 m below y = 0, where the
                    // scene's own lawn would cut holes in it: lift the dips to just above the lawn
                    // (mounds keep their shape) and let it take shadows without casting them.
                    const pos = o.geometry.attributes.position;
                    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.006) pos.setY(i, 0.006);
                    pos.needsUpdate = true;
                    o.geometry.computeBoundingSphere();
                    o.receiveShadow = true;
                } else {
                    o.castShadow = true;
                    o.receiveShadow = true;
                }
            });
            if (this.disposed || this.trackGroup !== group) {
                disposeObject(model);
                for (const t of textures) t.dispose();
                return;
            }
            model.name = 'pocabinet-playground';
            model.scale.setScalar(PLAYGROUND.scale);
            group.add(model);
            this.ownedTextures.push(...textures);
        } catch (e) {
            console.warn('pocabinet/scene: playground model skipped', e);
        } finally {
            draco?.dispose();
        }
    }

    buildGrass() {
        if (this.grass) {
            this.scene.remove(this.grass.mesh);
            this.grass.dispose();
        }
        this.grass = null;
        const blades = GRASS_BLADES[this.quality] || 0;
        if (!this.track || !blades || this.track.id === 'pressbriefing') return;
        try {
            this.grass = new Grass(this.track, hex(this.baseAtmosphere?.groundHex, '#2a3a24'), blades, keepOutFor(this.track.id));
            this.scene.add(this.grass.mesh);
        } catch (e) {
            this.grass = null;
            console.warn('pocabinet/scene: grass skipped', e);
        }
    }

    disposeTrackMeshes() {
        if (this.grass) {
            this.scene.remove(this.grass.mesh);
            this.grass.dispose();
            this.grass = null;
        }
        if (!this.trackGroup) return;
        this.scene.remove(this.trackGroup);
        this.scenery?.dispose();
        disposeObject(this.trackGroup);
        for (const t of this.ownedTextures) t.dispose();
        this.ownedTextures = [];
        this.trackGroup = null;
        this.racingLine = null;
        this.roadMesh = null;
        this.scenery = null;
        this.sky = null;
        this.envSky?.dispose();
        this.envSky = null;
    }

    /** Match the canvas size to its CSS box; called on resize + after mount. */
    resize() {
        if (this.disposed || !this.canvas) return;
        const w = this.canvas.clientWidth || 800;
        const h = this.canvas.clientHeight || 450;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.post?.setSize();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        window.removeEventListener('resize', this._onResize);
        this.stopLoop();
        this._frameCbs.clear();
        this.disposeTrackMeshes();
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.post?.dispose();
        this.post = null;
        this.renderer.dispose();
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Geometry builders. Lateral offsets are sim units (+ = right of travel).
// ──────────────────────────────────────────────────────────────────────────

/** Free every geometry and material under `root` (textures are the caller's). */
function disposeObject(root) {
    root.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        for (const m of [o.material].flat()) m?.dispose();
    });
}

function scaleUv(geom, su, sv) {
    const uv = geom.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
}

/** World height of the road at centerline sample `k` (0 on a flat track). */
function roadHeight(track, k) {
    return track.z ? track.z[k] / WORLD_SCALE : 0;
}

/** Height the road's bank adds `lat` sim units off the centerline at sample `k` (world units). */
function bankHeight(track, k, lat) {
    return track.bank ? track.bank[k] * lat / WORLD_SCALE : 0;
}

/**
 * A strip between two lateral offsets, following the road's height and bank;
 * uv = (lateral, distance) / tile (sim units). `pick(i)` chooses the segments to lay
 * (default: everything but the return link).
 */
function ribbon(track, fromLat, toLat, height, tile, pick = (i) => track.drawn(i)) {
    const positions = [], uvs = [];
    const n = track.count;
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const x = track.x[k], y = track.y[k];
        const h = height + roadHeight(track, k);
        positions.push(
            (x + nx * fromLat) / WORLD_SCALE, h + bankHeight(track, k, fromLat), (y + ny * fromLat) / WORLD_SCALE,
            (x + nx * toLat) / WORLD_SCALE, h + bankHeight(track, k, toLat), (y + ny * toLat) / WORLD_SCALE,
        );
        const v = (i === n ? track.length : track.cum[k]) / tile;
        uvs.push(fromLat / tile, v, toLat / tile, v);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const indices = [];
    for (let i = 0; i < n; i++) {
        if (!pick(i)) continue;
        const a0 = i * 2, a1 = i * 2 + 1, b0 = (i + 1) * 2, b1 = (i + 1) * 2 + 1;
        indices.push(a0, a1, b0, a1, b1, b0);
    }
    geom.setIndex(indices);
    geom.computeVertexNormals();
    // A flat road: force the normals straight up (winding differs per side).
    const nrm = geom.attributes.normal;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    return geom;
}

/**
 * Barrier wall: inner face at `lateral`, a top, and an outer face `thick` sim units
 * further out (on side `s`). uv.x runs along the lap for the striped texture.
 */
function barrier(track, lateral, s, height, thick) {
    const positions = [], uvs = [];
    const n = track.count;
    const rows = [[lateral, 0], [lateral, height], [lateral + s * thick, height], [lateral + s * thick, 0]];
    const vs = [0, 0.8, 0.9, 1];
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const u = (i === n ? track.length : track.cum[k]) / 80;
        rows.forEach(([lat, h], r) => {
            positions.push((track.x[k] + nx * lat) / WORLD_SCALE, h, (track.y[k] + ny * lat) / WORLD_SCALE);
            uvs.push(u, vs[r]);
        });
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const idx = [];
    for (let i = 0; i < n; i++) {
        for (let r = 0; r < 3; r++) {
            const a0 = i * 4 + r, a1 = i * 4 + r + 1, b0 = (i + 1) * 4 + r, b1 = (i + 1) * 4 + r + 1;
            idx.push(a0, a1, b0, a1, b1, b0);
        }
    }
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return geom;
}

const barrierTextures = new Map();
function barrierTexture(accentHex) {
    const key = accentHex || '#c6a35a';
    if (barrierTextures.has(key)) return barrierTextures.get(key);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    for (let i = 0; i < 4; i++) {
        g.fillStyle = i % 2 ? '#e9e6df' : key;
        g.fillRect(i * 64, 0, 64, 52);
    }
    g.fillStyle = '#3a3c40';
    g.fillRect(0, 52, 256, 12);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0, 0, 256, 4);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    barrierTextures.set(key, tex);
    return tex;
}

/** Chequered strip across the road where a lap ends: distance 0 on a circuit, the finish of a point-to-point run. */
function startLine(track) {
    const group = new THREE.Group();
    const p = track.pointAt(track.lapLength);
    const y = 0.035 + track.heightAt(track.lapLength) / WORLD_SCALE;
    const cols = 12, rows = 2, hw = track.halfWidth;
    const cell = (hw * 2) / cols;
    const geom = new THREE.PlaneGeometry(cell / WORLD_SCALE, cell / WORLD_SCALE);
    geom.rotateX(-Math.PI / 2);
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.55 });
    const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lat = -hw + cell * (c + 0.5);
            const fwd = (r - 0.5) * cell;
            const m = new THREE.Mesh(geom, (r + c) % 2 === 0 ? white : black);
            m.position.set(
                (p.x + -p.ty * lat + p.tx * fwd) / WORLD_SCALE,
                y,
                (p.y + p.tx * lat + p.ty * fwd) / WORLD_SCALE);
            m.rotation.y = -Math.atan2(p.ty, p.tx);
            m.receiveShadow = true;
            group.add(m);
        }
    }
    return group;
}

/**
 * Racing-line assist: a thin line down the centre coloured by the speed the
 * curvature allows — green flat out, amber lift, red brake. Same curvature and
 * grip numbers the AI and the auto-brake use, so the colours never lie.
 */
function racingLineMesh(track) {
    const positions = [];
    const colors = [];
    const green = new THREE.Color('#2ecc71'), amber = new THREE.Color('#f1c40f'), red = new THREE.Color('#e74c3c');
    const c = new THREE.Color();
    for (let i = 0; i <= track.count; i++) {
        const k = i % track.count;
        positions.push(track.x[k] / WORLD_SCALE, 0.065 + roadHeight(track, k), track.y[k] / WORLD_SCALE);
        let kappa = 0;
        for (let j = 0; j < 8; j++) kappa = Math.max(kappa, track.curvatureAt((k + j) % track.count));
        const vMax = Math.sqrt(GRIP_ACCEL * 0.9 / Math.max(kappa, 1e-5));
        const t = Math.min(1, Math.max(0, (vMax - 80) / 50)); // ≤80 u/s brake … ≥130 flat out
        if (t > 0.5) c.copy(amber).lerp(green, (t - 0.5) * 2);
        else c.copy(red).lerp(amber, t * 2);
        colors.push(c.r * 2, c.g * 2, c.b * 2);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const pairs = [];
    for (let i = 0; i < track.count; i++) if (track.drawn(i)) pairs.push(i, i + 1);
    geom.setIndex(pairs);
    return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
}

// ──────────────────────────────────────────────────────────────────────────
//  Public mount / unmount.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mount the scene on a canvas.
 * @param {HTMLCanvasElement|string} canvas the element, or its DOM id — Blazor's
 *        IJSRuntime does not marshal ElementReference as a live element.
 * @param {{ atmosphere: object, centerXY: number[], trackWidth: number,
 *           minX: number, minY: number, maxX: number, maxY: number }} world
 */
export async function mount(canvas, world) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    if (!canvas) throw new Error('pocabinet/scene: canvas element is required');
    if (!world || !world.atmosphere) throw new Error('pocabinet/scene: world is required');

    // preserveDrawingBuffer so the clip recorder and the result card can read frames back.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 5000);
    camera.position.set(0, 3, 0);
    scene.add(camera);

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a4a2a, HEMI_BASE);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, SUN_BASE);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_SIZE.high, SHADOW_SIZE.high);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT; sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
    sc.near = 1; sc.far = 220;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);

    const handle = new SceneHandle(renderer, scene, camera, hemi, sun, canvas);
    try {
        handle.post = new PostFx(renderer);
    } catch (e) {
        handle.post = null;   // no post pass: the scene renders straight to the canvas
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        console.warn('pocabinet/scene: post-processing unavailable', e);
    }
    handle.setTrack(world);
    const start = handle.track.pointAt(-40);
    handle.setView({ x: start.x, y: start.y, h: handle.track.heightAt(-40) / WORLD_SCALE, heading: Math.atan2(start.ty, start.tx), mode: 'chase', snap: true });
    handle.resize();
    handle.startLoop();
    return handle;
}

export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

