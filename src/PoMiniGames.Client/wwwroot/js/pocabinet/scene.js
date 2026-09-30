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
//
// World mapping: sim (x, y) → three (x / 10, 0, y / 10).
//
// Camera: third person only (2026-09-23). 'chase' (close), 'far' (high and
// long) and 'tv' (trackside cameras handing off along the lap).
//
// Quality is automatic (2026-09-29, replacing the Render quality and FOV settings):
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
        if (mode === 'chase' || mode === 'far') {
            const far = mode === 'far';
            const s01 = Math.min(1, Math.abs(Number(p.speed) || 0) / 140);
            const back = (far ? 13 : 7.4) + s01 * (far ? 2 : 1.6);
            const up = (far ? 5.2 : 2.35) + s01 * 0.25;
            const target = this._v.set(x - fx * back, up, z - fz * back);
            // Lagged follow so the car swings in frame through corners; time-based so
            // the lag is the same at 30 fps as at 144.
            const dt = Number(p.dt) || 0;
            const k = dt > 0 ? 1 - Math.exp(-dt * (far ? 5 : 8)) : 0.18;
            const look = new THREE.Vector3(x + fx * (far ? 6 : 4.5), far ? 0.6 : 1.0, z + fz * (far ? 6 : 4.5));
            if (!this._chaseInit || p.snap) {
                this._chase.copy(target);
                this._chaseLook.copy(look);
                this._chaseInit = true;
            } else {
                this._chase.lerp(target, k);
                this._chaseLook.lerp(look, 1 - Math.exp(-(dt || 0.016) * 14));
            }
            this._chase.y = Math.max(this._chase.y, 0.7);
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
            const q = t.pointAt(idx * (t.length / 8) + 40);
            const side = t.halfWidth + RUN_OFF + 30;
            this._tvPos = new THREE.Vector3((q.x - q.ty * side) / WORLD_SCALE, 7, (q.y + q.tx * side) / WORLD_SCALE);
        }
        this.camera.position.copy(this._tvPos);
        this.camera.lookAt(x, 0.6, z);
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
        const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
        const sx = Math.round(cx / texel) * texel, sz = Math.round(cz / texel) * texel;
        this.sun.target.position.set(sx, 0, sz);
        this.sun.position.set(sx + this.sunDir.x * 90, this.sunDir.y * 90, sz + this.sunDir.z * 90);
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
        this.fx.reduced = !!o.reducedMotion;
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
        this.roadMesh = new THREE.Mesh(ribbon(this.track, -hw, hw, 0.02, 45),
            macro(new THREE.MeshStandardMaterial({
                color: hex(atmosphere.roadHex, '#393b42'), roughness: 1, metalness: 0,
                map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughnessMap: tar.roughnessMap,
                side: THREE.DoubleSide,
            }), 30, 0.2));
        this.roadMesh.receiveShadow = true;
        group.add(this.roadMesh);

        // Edge lines on the tarmac, then the barriers where physics puts the wall.
        const lineMat = new THREE.MeshStandardMaterial({
            color: 0xe8e8e8, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        for (const [a, b] of [[-hw, -hw + 2.2], [hw - 2.2, hw]]) {
            const line = new THREE.Mesh(ribbon(this.track, a, b, 0.03, 45), lineMat);
            line.receiveShadow = true;
            group.add(line);
        }
        // physics.js stops a car's centre at hw + RUN_OFF - CAR_RADIUS/2; its flank is
        // half a car width further out, so that is where the barrier face belongs.
        const wallLat = hw + RUN_OFF;
        const barrierMat = new THREE.MeshStandardMaterial({
            map: barrierTexture(atmosphere.accentHex), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
        });
        for (const s of [-1, 1]) {
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
            this.grass = new Grass(this.track, hex(this.baseAtmosphere?.groundHex, '#2a3a24'), blades);
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
        this.trackGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
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

function scaleUv(geom, su, sv) {
    const uv = geom.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
}

/** A flat strip between two lateral offsets; uv = (lateral, distance) / tile (sim units). */
function ribbon(track, fromLat, toLat, height, tile) {
    const positions = [], uvs = [];
    const n = track.count;
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const x = track.x[k], y = track.y[k];
        positions.push(
            (x + nx * fromLat) / WORLD_SCALE, height, (y + ny * fromLat) / WORLD_SCALE,
            (x + nx * toLat) / WORLD_SCALE, height, (y + ny * toLat) / WORLD_SCALE,
        );
        const v = (i === n ? track.length : track.cum[k]) / tile;
        uvs.push(fromLat / tile, v, toLat / tile, v);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const indices = [];
    for (let i = 0; i < n; i++) {
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

/** Chequered strip across the road at distance 0 (the lap line). */
function startLine(track) {
    const group = new THREE.Group();
    const p = track.pointAt(0);
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
                0.035,
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
        positions.push(track.x[k] / WORLD_SCALE, 0.065, track.y[k] / WORLD_SCALE);
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
    return new THREE.Line(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
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
    handle.setView({ x: start.x, y: start.y, heading: Math.atan2(start.ty, start.tx), mode: 'chase', snap: true });
    handle.resize();
    handle.startLoop();
    return handle;
}

export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

