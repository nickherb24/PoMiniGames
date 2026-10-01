// renderer.js — the three.js side: owns the scene, the camera the player controller
// drives, the frame interpolation, and the render loop.
//
// Frames arrive at 20 Hz and are drawn at display rate, so two frames are kept and
// positions/yaws are interpolated between them; every frame buffer is returned to the sim
// worker as soon as its data has been copied out, which is what keeps the pool from
// running dry (see host/simRuntime.js).
//
// It is also the conductor for the GFX stack added alongside it: the composer
// (postProcess.js), the particle field (particles.js), the event router (eventFx.js) and
// the atmosphere (lighting.js) all hang off this one frame loop, because every one of them
// needs the same three facts — the frame delta, where the camera is, and what time of day
// the sim thinks it is.
//
// GFX pass 2 hangs more off the same loop, all of it observation — nothing here writes to
// the sim: creature trails (trails.js) and the grass field (grass.js), a SURFACE state
// (wetness from the sim's weather, rain, snow cover, bioluminescent surf) handed to the
// terrain and water, tonight's spectacle (aurora, meteors) decided from the world's seed
// and the date, heat sources and shockwaves for the composer, the mood grade, creature
// voices near the listener, and gamepad rumble for a near blast.
import * as THREE from 'three';
import { CREATURE_CAP, PROP_CAP } from '../sim/core/config.js';
import { FRAME, frameViews } from '../sim/frame.js';
import { TILE, TILE_STATE } from '../sim/terrain/tiles.js';
import { createTerrainMesh } from './terrainMesh.js';
import { createLighting } from './lighting.js';
import { LENS, createCreatureMeshes } from './creatureMeshes.js';
import { createKinThreads } from './kin.js';
import { createPropMeshes } from './propMeshes.js';
import { createFloraMeshes } from './floraMeshes.js';
import { createMinimap } from './minimap.js';
import { blockedTiles, createPlayer, stepPlayer } from './playerController.js';
import { createInput } from './input.js';
import { pickCreature } from './picking.js';
import { createPostProcess } from './postProcess.js';
import { createParticles } from './particles.js';
import { createEventFx } from './eventFx.js';
import { createDirector } from './director.js';
import { createPip } from './pip.js';
import { createSky } from './sky.js';
import { materialClock, materialCloud, materialDetail, materialSeason, materialSnow, materialWet, materialSky } from './materials.js';
import { applyCameraShake } from '../../postFx.js';
import { createSettlementMeshes, bannerColour } from './settlementMesh.js';
import { createFauna } from './fauna.js';
import { createTrails } from './trails.js';
import { createGrass } from './grass.js';
import { GOAL } from '../sim/behavior/utility.js';

const TAU = Math.PI * 2;
// What the auto-director calls a cut to an event tile.
const EVENT_CAPTIONS = { lightning: 'Lightning strike', rockslide: 'Rockslide', eruption: 'The volcano erupts', tech: 'The tribe builds', outbreak: 'Sickness spreads' };
// Weather kinds (sim/events/weather.js) → how closed the cloud deck is.
const OVERCAST = [0, 0.7, 1, 0, 0.6];
const WEATHER_STORM = 2;
// Weather kinds (sim/events/weather.js).
const WEATHER_RAIN = 1;
const WEATHER_DROUGHT = 3;
const WEATHER_SNOW = 4;
// Tonight's spectacle, per season (Spring, Summer, Autumn, Winter): the chance a given
// night has an aurora, and bioluminescent surf. A shower of meteors is its own draw.
const AURORA_CHANCE = [0.1, 0.05, 0.25, 0.45];
const BIO_CHANCE = [0.3, 0.45, 0.25, 0.1];
// Mood grade per season and weather (idea 8): [r, g, b, saturation].
const SEASON_MOOD = [[1, 1.02, 0.98, 1.05], [1.05, 1, 0.92, 1.08], [1.07, 0.97, 0.86, 1.04], [0.93, 0.98, 1.07, 0.85]];
const WEATHER_MOOD = [null, [0.97, 0.99, 1.02, 0.92], [0.94, 0.97, 1.02, 0.82], [1.06, 1, 0.88, 0.88], [0.96, 0.99, 1.05, 0.9]];
const EPIDEMIC_MOOD = [0.95, 1.05, 0.9, 0.9];
const VOICE_RANGE = 70;           // metres: creatures further than this are not voiced
const HEAT_RANGE = 85;
// GFX pass 3 (2026-09-30).
const THERMAL_MOOD = [0.5, 0.62, 0.95, 0.12];   // the world behind a thermal lens: cold and nearly grey
const UNDER_FOG = new THREE.Color(0x0b5f73);
const UNDER_FOG_DENSITY = 0.05;
const CLOUD_SHADE = 0.42;         // how much sun a cloud takes at noon under a broken sky
const GRAZE_CELL = 4;             // metres per cell of the minimap's grazing layer
const TRAFFIC_BLOCK = 4;          // trail texels per cell of the traffic layer
/** Deterministic 0..1 from a few integers — the world's seed and the date, never the viewer. */
function hash01(...parts) {
  let h = 2166136261;
  for (const v of parts) { h ^= (v | 0); h = Math.imul(h, 16777619); h ^= h >>> 13; }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const shortestAngle = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Adaptive resolution. The floor is deliberately high: below ~0.6x the island reads as
// mush, and a game that has gone soft is worse than one that has gone to 40 fps.
const DPR_FLOOR = 0.62;
const DPR_DOWN_FPS = 45;
const DPR_UP_FPS = 58;
const DPR_DOWN_SECONDS = 2;    // consecutive bad seconds before dropping — one stutter is not a trend
const DPR_UP_SECONDS = 6;      // and a long run of good ones before climbing back

export function createRenderer(container, {
  cap = CREATURE_CAP, propCap = PROP_CAP, minimapCanvas = null, quality = {}, audio = null,
  onPick = () => {}, onAction = () => {}, onFps = () => {},
  // The auto-director takes the camera after this many seconds without input (0 = never);
  // demo mode passes a few seconds, 1-player a couple of minutes.
  directorIdleSeconds = 0,
  // Accessibility (Settings): 'default' | 'cb' tribe banner colours, and no camera shake.
  palette = 'default', reducedMotion = false,
  // Key bindings (input.js DEFAULT_BINDINGS shape), loaded from prefs by the engine.
  bindings = null,
  // The score's tempo (music.js), so the campfire drums sit on its beat.
  tempo = () => 54,
  // Called right after every composed frame (the reel's mirror).
  onAfterRender = null,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'poeco-canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;';
  container.appendChild(canvas);

  // PoQuality is the app's quality authority (?fx= override, reduced-motion cap, battery
  // demotion, fps watchdog); the core count is only the fallback when it has not loaded.
  // An explicit tier from the Settings panel wins outright (it is the player's choice, made
  // on this machine); otherwise the old resolution applies.
  const forcedTier = quality.tier === 'high' || quality.tier === 'medium' || quality.tier === 'low' ? quality.tier : null;
  const lowEnd = forcedTier ? forcedTier === 'low' : (quality.lowEnd ?? (window.PoQuality ? window.PoQuality.tier() === 'low' : (navigator.hardwareConcurrency ?? 8) <= 4));
  // One tier string, resolved once, handed to every subsystem. `lowEnd` from the caller is
  // an override that can only demote — a Blazor-side low-end hint must not be undone by a
  // machine that happens to report a fast GPU.
  const tier = forcedTier ?? (lowEnd ? 'low' : (window.PoQuality?.tier?.() ?? 'high'));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
  const maxDpr = window.PoCanvasDpr?.ceiling ? window.PoCanvasDpr.ceiling(lowEnd ? 1 : 2) : Math.min(devicePixelRatio || 1, lowEnd ? 1 : 2);
  let dprScale = 1;
  renderer.setPixelRatio(maxDpr);
  renderer.shadowMap.enabled = !lowEnd;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.5, 700);
  // lighting owns scene.fog now: its colour and density both ride the same day/night curve
  // as the sky, and the water and particle shaders read the density back off it.
  const lighting = createLighting(scene, { shadows: !lowEnd, shadowMapSize: lowEnd ? 1024 : 2048, tier });
  // The sky dome and clouds ride the camera; every hooked Lambert material (materials.js)
  // reads one shared clock, set once per frame below.
  const skyDome = createSky(scene, { tier });
  materialDetail.value = tier === 'low' ? 0 : 1;
  const creatures = createCreatureMeshes(scene, cap);
  const kinThreads = createKinThreads(scene);
  const props = createPropMeshes(scene, propCap);
  const particles = createParticles(scene, { tier });
  const eventFx = createEventFx(particles, audio, { tier });
  const post = createPostProcess(renderer, scene, camera, {
    tier, width: container.clientWidth || 1, height: container.clientHeight || 1, pixelRatio: maxDpr,
  });

  // terrainApi mirrors the sim terrain's read API (heightAt/type) from the transferred arrays.
  let terrainApi = null;       // heightAt/type lookups the controller needs
  let island = null;
  let flora = null;
  let minimap = null;
  let player = createPlayer({ size: 200, heightAt: () => 0, type: new Uint8Array(200 * 200) }, 'fly');
  let pendingPose = null;      // a pose set before the first terrain message
  let terrainReady = false;
  let settlementMeshes = null;
  let fauna = null;
  // Weather as the last stats message reported it; the per-frame emitters read it.
  let weatherKind = 0; let weatherIntensity = 0;
  let rainDebt = 0;
  // GFX pass 2 state. `surface` is what the terrain and water read every frame.
  let trails = null;
  let grass = null;
  const surface = { wet: 0, rain: 0, snow: 0, bio: 0 };
  let snowFall = 0;                // snow laid by a weather spell; melts when it ends
  let bioTarget = 0;
  let spectacleKey = '';
  const moodGrade = new THREE.Color(1, 1, 1);
  const heatNdc = new THREE.Vector3();
  const heatList = [];
  let voiceAt = 0; let howlAt = -1e9; let barkAt = -1e9; let thumpAt = -1e9; let drumBarAt = 0;
  const howlTimers = new Set();
  // GFX pass 3 state: how far under water the camera is (eased), the season's shedding,
  // the minimap's data layer and what feeds it, and where each watched creature last stood.
  let underK = 0; let bubbleDebt = 0; let seasonDebt = 0;
  let layer = 'none'; let heat = null; let lastGrass = null; let layerAt = 0;
  let watchedAt = new Map(); let watchedNow = new Map();
  // The tour (Blazor) wants to know the first look and the first step, once each.
  const told = { look: false, move: false };
  // The page can hold the director off (the onboarding tour needs the camera to stay put).
  let directorHeld = false;
  let lastRecycle = null;
  let contextLost = false;
  let motionReduced = !!reducedMotion;

  // Two frames + their views, for interpolation.
  let prev = null; let curr = null; let prevAt = 0; let currAt = 0;
  const interp = new Float32Array(cap * FRAME.CREATURE_STRIDE);
  const speeds = new Float32Array(cap);
  let interpCount = 0;
  let propCount = 0;
  let hovered = null;
  let followHandle = -1;
  let stats = null;
  let running = true;
  let fps = 0; let frames = 0; let fpsAt = 0;
  let slowSeconds = 0; let fastSeconds = 0;
  let lastTime = 0;
  let lastPropTick = -1;   // the impact watcher runs per SIM frame, not per rendered frame

  // Burning and molten tile positions, rebuilt on each tile sync (1 Hz) so the per-frame
  // plume emitter never has to walk the 40 000-entry tile array.
  let fireTiles = [];
  let lavaTiles = [];

  const sunNdc = new THREE.Vector3();
  const sunView = new THREE.Vector3();
  const sunUv = new THREE.Vector2();
  const sunFromCam = new THREE.Vector3();

  // The campfire's light (behavior/tech.js FIRE): one point light parked on the hearth,
  // bright at night and a flicker by day. Zero intensity until the tribe has a fire.
  const campfireLight = new THREE.PointLight(0xffa040, 0, 28, 1.7);
  campfireLight.name = 'campfire';
  scene.add(campfireLight);
  let campfireAt = null;

  // Auto-director + pop-out window. The director drives the same player pose the
  // controller does; any real input hands the camera back (see noteInput).
  const director = createDirector({
    onSubject: (handle) => onAction('directorSubject', handle),
    onCaption: (caption) => onAction('directorCaption', caption),
  });
  let lastInputAt = performance.now();
  // Once the player has actually touched the camera, the director waits this long before
  // taking it back — never the (much shorter) opening delay. Demo mode arms at 4 s so an
  // untouched kiosk cuts to the drama almost at once, and that same 4 s used to apply
  // after a look as well: the camera was yanked out of the player's hands a breath after
  // they stopped moving the mouse, which reads as the mouse not working at all.
  const DIRECTOR_RETAKE_SECONDS = 25;
  let everInteracted = false;
  // An explicit toggle-off (the 🎬 button, or C) is a preference, not a pause: without
  // this the auto-arm below re-enabled the director on the very next frame in demo mode,
  // because turning it off by hand never touched lastInputAt — so the switch did nothing
  // at all. Touching the mouse still only defers it; only the switch retires it.
  let directorDismissed = false;
  function setDirector(on) {
    if (director.enabled === !!on) return;
    director.setEnabled(on);
    if (on) followHandle = -1;
    onAction('director', !!on);
  }
  /** Mark player input without deciding what it means for the director. */
  function markInput(now = performance.now()) {
    lastInputAt = now;
    everInteracted = true;
  }
  function noteInput(now = performance.now()) {
    markInput(now);
    if (director.enabled) setDirector(false);
  }
  function toggleDirector() {
    const next = !director.enabled;
    markInput();
    directorDismissed = !next;
    setDirector(next);
  }
  const pip = createPip(canvas, { onChange: (on) => onAction('pip', on) });

  const input = createInput(canvas, {
    bindings,
    onLook: (dx, dy) => {
      if (dx || dy) { noteInput(); if (!told.look) { told.look = true; onAction('tour', 'look'); } }
      player.look(dx, dy);
    },
    onAction: (action, value) => {
      if (action === 'fly') { noteInput(); player.toggleFly(); return; }
      if (action === 'inspect') { noteInput(); onPick(hovered ? hovered.handle : -1); return; }
      if (action === 'director') { toggleDirector(); return; }
      if (action === 'pip') { pip.toggle(); return; }
      if (action === 'follow' || action === 'speed') noteInput();
      onAction(action, value);
    },
  });

  function resize() {
    const w = container.clientWidth || 1; const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    post.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  window.addEventListener('resize', resize);

  /**
   * Adaptive resolution (GFX option 9). onFps was already plumbed but only ever fed a
   * readout; this is what actually pays for the composer on a weak GPU. Scaling the
   * pixel ratio rather than dropping a pass keeps the LOOK identical and only the
   * sharpness moves, which is the least noticeable thing to give up.
   */
  function setDprScale(next) {
    const clamped = Math.max(DPR_FLOOR, Math.min(1, next));
    if (Math.abs(clamped - dprScale) < 0.01) return;
    dprScale = clamped;
    renderer.setPixelRatio(maxDpr * dprScale);
    post.setPixelRatio(maxDpr * dprScale);
    resize();
  }

  function setTerrain(msg) {
    if (island) { scene.remove(island.mesh, island.water); island.dispose(); }
    if (flora) flora.dispose();
    fireTiles = []; lavaTiles = [];
    const cs = msg.size + 1;
    terrainApi = {
      size: msg.size, height: msg.height, type: msg.tileType,
      heightAt(x, z) {
        if (x < 0 || z < 0 || x > msg.size || z > msg.size) return -3;
        const ix = Math.min(msg.size - 1, Math.floor(x)); const iz = Math.min(msg.size - 1, Math.floor(z));
        const fx = x - ix; const fz = z - iz; const o = iz * cs + ix;
        const top = msg.height[o] + (msg.height[o + 1] - msg.height[o]) * fx;
        const bottom = msg.height[o + cs] + (msg.height[o + cs + 1] - msg.height[o + cs]) * fx;
        return top + (bottom - top) * fz;
      },
    };
    island = createTerrainMesh(terrainApi, { tier });
    lighting.setWorldSize?.(msg.size);
    scene.add(island.mesh, island.water);
    flora = createFloraMeshes(scene, terrainApi, { trees: msg.trees, bushes: msg.bushes });
    if (minimapCanvas) minimap = createMinimap(minimapCanvas, terrainApi);
    if (settlementMeshes) settlementMeshes.dispose();
    settlementMeshes = createSettlementMeshes(scene, (x, z) => terrainApi.heightAt(x, z), palette);
    fauna?.dispose();
    fauna = createFauna(scene, terrainApi, { tier });
    trails?.dispose();
    trails = createTrails(terrainApi.size);
    grass?.dispose();
    grass = createGrass(scene, terrainApi, { tier });
    // A new island: nothing the last one fed the data layers or the watch marks carries over.
    heat = null; lastGrass = null; watchedAt.clear(); watchedNow.clear();
    refreshLayer();
    // A pose set before the terrain arrived (Resume reads prefs synchronously at start)
    // must survive the rebuild, or the god is teleported back to the island's centre.
    // Fresh players float ('fly') until they press F to walk (2026-09-02 user call).
    const pending = pendingPose ?? (terrainReady ? player.pose() : null);
    pendingPose = null;
    terrainReady = true;
    // Spawn clear of trees, bushes, huts and boulders: the terrain message carries all four,
    // and the terrain is the only moment they are all in hand (see blockedTiles).
    const blocked = msg.tileState
      ? blockedTiles({ trees: msg.trees, bushes: msg.bushes, tileState: msg.tileState, size: terrainApi.size })
      : null;
    player = createPlayer(terrainApi, 'fly', blocked);
    if (pending) player.setPose(pending);
  }

  function setTiles(msg) {
    if (!island) return;
    island.paint(msg.tileState, msg.grass);
    grass?.setTiles(msg.tileState, msg.grass);
    flora?.update(msg, lastTime / 1000);
    minimap?.setTiles(msg);
    lastGrass = msg.grass ?? lastGrass;
    if (layer === 'grazing') refreshLayer();

    // One pass over the tile states per sync, converted straight to world points. Capped
    // because a full firestorm is 400 tiles and the emitter only ever samples a handful.
    // The campfire joins the fire list (it smokes) and parks the point light.
    const state = msg.tileState;
    fireTiles = []; lavaTiles = []; campfireAt = null;
    if (state && terrainApi) {
      const size = terrainApi.size;
      for (let t = 0; t < state.length; t++) {
        const s = state[t];
        if (s !== TILE_STATE.FIRE && s !== TILE_STATE.LAVA && s !== TILE_STATE.CAMPFIRE) continue;
        const x = (t % size) + 0.5; const z = Math.floor(t / size) + 0.5;
        const y = terrainApi.heightAt(x, z);
        if (s === TILE_STATE.CAMPFIRE) { if (!campfireAt) { campfireAt = { x, y, z }; fireTiles.push(campfireAt); } continue; }
        const list = s === TILE_STATE.FIRE ? fireTiles : lavaTiles;
        if (list.length >= 96) continue;
        list.push({ x, y, z });
      }
    }
  }

  function acceptFrame(buffer, recycle) {
    lastRecycle = recycle;
    // The sim's creature cap is the world's, not ours: a low-end (phone) world runs 250 while
    // this renderer is sized for CREATURE_CAP, and reading a 250-row buffer as 400 rows threw
    // a RangeError on every frame, so phones drew no creatures at all. The row count is
    // recovered from the buffer itself (the layout in sim/frame.js), capped at ours.
    const rows = (buffer.byteLength - FRAME.HEADER_INTS * 4 - propCap * FRAME.PROP_STRIDE * 4) / (4 + FRAME.CREATURE_STRIDE * 4);
    const views = frameViews(buffer, Math.min(cap, rows | 0), propCap);
    if (curr) { if (prev) recycle(prev.buffer); prev = curr; prevAt = currAt; }
    curr = { buffer, views };
    currAt = performance.now();
    if (!prev) prevAt = currAt;   // no previous frame: anchor the interpolation clock
  }

  function interpolate(now) {
    if (!curr) return;
    const c = curr.views;
    const count = c.header[FRAME.H_COUNT];
    const p = prev?.views;
    const span = Math.max(1, currAt - prevAt);
    const alpha = p ? Math.min(1.4, (now - currAt) / span + 1) : 1;   // extrapolate slightly past the last frame
    interpCount = count;
    propCount = c.header[FRAME.H_PROPS];
    for (let k = 0; k < count; k++) {
      const o = k * FRAME.CREATURE_STRIDE;
      // Match rows by handle: the sim's order is stable within a tick but births/deaths shift it.
      let po = -1;
      if (p) { const h = c.handles[k]; if (p.handles[k] === h) po = o; else { for (let j = 0; j < p.header[FRAME.H_COUNT]; j++) if (p.handles[j] === h) { po = j * FRAME.CREATURE_STRIDE; break; } } }
      if (po < 0) { for (let f = 0; f < FRAME.CREATURE_STRIDE; f++) interp[o + f] = c.creatures[o + f]; speeds[k] = 0; continue; }
      const t = alpha;
      const px = p.creatures[po]; const pz = p.creatures[po + 2];
      interp[o] = px + (c.creatures[o] - px) * t;
      interp[o + 1] = p.creatures[po + 1] + (c.creatures[o + 1] - p.creatures[po + 1]) * t;
      interp[o + 2] = pz + (c.creatures[o + 2] - pz) * t;
      interp[o + 3] = p.creatures[po + 3] + shortestAngle(p.creatures[po + 3], c.creatures[o + 3]) * t;
      for (let f = 4; f < FRAME.CREATURE_STRIDE; f++) interp[o + f] = c.creatures[o + f];
      speeds[k] = Math.hypot(c.creatures[o] - px, c.creatures[o + 2] - pz) * (1000 / span);
    }
  }

  /**
   * Where the sun lands on screen, and how hard it should scatter. Shafts are skipped
   * outright when the sun is behind the camera — marching toward a projected point that is
   * really behind you produces streaks in exactly the wrong direction.
   */
  function updateShafts(sky, dir) {
    if (!post.enabled) return;
    // camera.lookAt has just moved the camera but matrixWorldInverse is only refreshed
    // inside render(), so without this the shafts would trail the view by a frame.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    sunView.copy(lighting.sun.position).applyMatrix4(camera.matrixWorldInverse);
    if (sunView.z >= -0.5) { post.setSun(null, 0); return; }      // three looks down -z
    sunNdc.copy(lighting.sun.position).project(camera);
    const off = Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y));
    const edge = 1 - smoothstep(0.75, 1.7, off);
    if (edge <= 0.01) { post.setSun(null, 0); return; }

    sunFromCam.copy(lighting.sun.position).sub(camera.position).normalize();
    const facing = Math.max(0, dir.x * sunFromCam.x + dir.y * sunFromCam.y + dir.z * sunFromCam.z);

    // Shafts belong to a low sun. At noon the light is overhead, there is nothing for it to
    // rake across, and a strong pass just fogs the frame.
    const hour = 0.2 + sky.dusk * 0.95 + sky.day * 0.2;
    sunUv.set(sunNdc.x * 0.5 + 0.5, sunNdc.y * 0.5 + 0.5);
    post.setSun(sunUv, Math.min(1.1, facing * facing * edge * hour), sky.sunColour);
  }

  /**
   * The ground's weather state (idea 3). Wetness is the sim's own (weather.js tracks how
   * soaked the island is and dries it out); snow cover is laid here, because the sim has
   * no notion of snow on the ground — only of snow falling.
   */
  function updateSurface(dt) {
    const wetTarget = Math.max(0, Math.min(1, stats?.weather?.wetness ?? 0));
    surface.wet += (wetTarget - surface.wet) * Math.min(1, dt * 0.5);
    const raining = weatherKind === WEATHER_RAIN || weatherKind === WEATHER_STORM ? weatherIntensity : 0;
    surface.rain += (raining - surface.rain) * Math.min(1, dt * 0.8);
    const season = stats?.season ?? 0;
    if (weatherKind === WEATHER_SNOW) snowFall = Math.min(1, snowFall + dt * weatherIntensity * 0.03);
    else snowFall = Math.max(0, snowFall - dt * (season === 1 ? 0.02 : season === 3 ? 0.002 : 0.008));
    // Winter's own cover, and the thaw in the first part of Spring (the old seasonal rule).
    const seasonal = season === 3 ? 0.75 : season === 0 ? Math.max(0, 0.75 - (stats?.seasonProgress ?? 0) * 2.5) : 0;
    const snowTarget = Math.max(seasonal, snowFall);
    surface.snow += (snowTarget - surface.snow) * Math.min(1, dt * 0.25);
    surface.bio += (bioTarget - surface.bio) * Math.min(1, dt * 0.05);
    materialSnow.value = surface.snow;
    materialWet.value = surface.wet * (1 - surface.snow);
  }

  /** Tonight's aurora, meteor rate and glowing surf — a property of the world and the date. */
  function decideSpectacle(s) {
    const key = `${s.seed}:${s.year}:${s.day}`;
    if (key === spectacleKey) return;
    spectacleKey = key;
    const season = s.season ?? 0;
    const seed = s.seed | 0; const year = s.year | 0; const day = s.day | 0;
    const aurora = hash01(seed, year, day, 1) < AURORA_CHANCE[season] ? 0.45 + 0.55 * hash01(seed, year, day, 2) : 0;
    const meteors = hash01(seed, year, day, 3) < 0.12 ? 0.55 : 0.07;
    skyDome.setSpectacle(aurora, meteors);
    bioTarget = hash01(seed, year, day, 4) < BIO_CHANCE[season] ? 0.6 + 0.4 * hash01(seed, year, day, 5) : 0;
  }

  /**
   * The minimap's data layer (2026-09-30). Three come from the sim's heat book (setHeat),
   * two are already on this side of the worker: grazing pressure is the tile sync's grass
   * biomass read backwards, and traffic is the wear grid trails.js keeps for the paths.
   */
  function refreshLayer() {
    if (!minimap) return;
    if (layer === 'deaths' && heat) minimap.setLayer(layer, heat.deaths, heat.side);
    else if (layer === 'predation' && heat) minimap.setLayer(layer, heat.kills, heat.side);
    else if (layer === 'sickness' && heat) minimap.setLayer(layer, heat.sick, heat.side);
    else if (layer === 'grazing' && lastGrass && terrainApi) {
      const size = terrainApi.size; const side = Math.ceil(size / GRAZE_CELL);
      const out = new Float32Array(side * side); const n = new Uint16Array(side * side);
      for (let t = 0; t < size * size; t++) {
        const type = terrainApi.type[t];
        if (type !== TILE.GRASS && type !== TILE.HILL) continue;
        const c = (((t / size) | 0) / GRAZE_CELL | 0) * side + ((t % size) / GRAZE_CELL | 0);
        out[c] += 255 - lastGrass[t]; n[c]++;
      }
      for (let c = 0; c < out.length; c++) if (n[c]) out[c] /= n[c];
      minimap.setLayer(layer, out, side);
    } else if (layer === 'traffic' && trails) {
      const W = trails.width; const wear = trails.wear; const side = Math.floor(W / TRAFFIC_BLOCK);
      const out = new Float32Array(side * side);
      for (let z = 0; z < W; z++) {
        const row = ((z / TRAFFIC_BLOCK) | 0) * side;
        for (let x = 0; x < W; x++) { const c = row + ((x / TRAFFIC_BLOCK) | 0); const v = wear[z * W + x]; if (v > out[c]) out[c] = v; }
      }
      minimap.setLayer(layer, out, side);
    } else minimap.setLayer(null);
  }

  /** Blossom in spring, leaves in autumn: let go from canopy height near the camera. */
  function emitSeason(dt) {
    const season = stats?.season;
    if (!particles.enabled || !terrainApi || (season !== 0 && season !== 2) || surface.snow > 0.3) return;
    seasonDebt += dt * (tier === 'high' ? 7 : 4);
    let n = Math.min(4, Math.floor(seasonDebt));
    seasonDebt -= n;
    const size = terrainApi.size;
    while (n-- > 0) {
      const x = player.x + (Math.random() - 0.5) * 56; const z = player.z + (Math.random() - 0.5) * 56;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      const type = terrainApi.type[(z | 0) * size + (x | 0)];
      // Forest sheds everywhere; open grass only now and then, as if a tree were near.
      if (type !== TILE.FOREST && (type !== TILE.GRASS || Math.random() < 0.75)) continue;
      particles.emit(season === 0 ? 'petal' : 'leaf', x, terrainApi.heightAt(x, z) + 2.5 + Math.random() * 3.5, z, { count: 1, dir: [0.45, -0.2, 0.2] });
    }
  }

  /**
   * Below the waterline (2026-09-30): the fog closes in and turns teal, the composer sways
   * and takes the red out, the mix goes through a low-pass, and air rises past the lens.
   * Returns the eased 0..1 factor.
   */
  function updateUnderwater(dt) {
    const target = terrainApi ? Math.max(0, Math.min(1, (-0.12 - player.y) / 0.5)) : 0;
    underK += (target - underK) * Math.min(1, dt * 6);
    if (underK < 0.004) underK = 0;
    audio?.setUnderwater?.(underK > 0.5);
    post.setUnderwater(underK);
    if (underK > 0.01) {
      lighting.fog.color.lerp(UNDER_FOG, underK);
      lighting.fog.density += (UNDER_FOG_DENSITY - lighting.fog.density) * underK;
    }
    if (underK > 0.4 && particles.enabled) {
      bubbleDebt += dt * 14;
      let n = Math.min(3, Math.floor(bubbleDebt));
      bubbleDebt -= n;
      const d = player.direction();
      while (n-- > 0) {
        particles.emit('bubble', player.x + d.x * 3 + (Math.random() - 0.5) * 6, player.y - 1.5 + Math.random() * 1.5, player.z + d.z * 3 + (Math.random() - 0.5) * 6, { count: 1 });
      }
    }
    return underK;
  }

  /**
   * Life and death marks for the watch-list (2026-09-30). The frame flags every watched
   * creature, so a watched handle that is in one sim frame and gone from the next has died:
   * a wisp rises from where it last stood and a bell rings from there. No event needed —
   * the position is exactly the one the event would not have carried.
   */
  function trackWatched(views, count) {
    watchedNow.clear();
    for (let k = 0; k < count; k++) {
      const o = k * FRAME.CREATURE_STRIDE;
      if ((views.creatures[o + FRAME.STATE] | 0) & FRAME.C_WATCHED) watchedNow.set(views.handles[k], [views.creatures[o], views.creatures[o + 1], views.creatures[o + 2]]);
    }
    let alive = null;
    for (const [handle, at] of watchedAt) {
      if (watchedNow.has(handle)) continue;
      if (!alive) { alive = new Set(); for (let k = 0; k < count; k++) alive.add(views.handles[k]); }
      if (alive.has(handle)) continue;            // taken off the watch-list, not dead
      particles.emit('wisp', at[0], at[1] + 0.6, at[2], { count: 18, radius: 0.45 });
      audio?.knell?.({ x: at[0], y: at[1] + 1, z: at[2] });
    }
    const swap = watchedAt; watchedAt = watchedNow; watchedNow = swap;
  }

  /** The mood grade (idea 8): season, weather and sickness tint the whole frame. */
  function decideMood(s, snap = false) {
    // A thermal lens is a camera, not a season: the world goes cold so the animals read.
    if (creatures.tint === LENS.THERMAL) {
      moodGrade.setRGB(THERMAL_MOOD[0], THERMAL_MOOD[1], THERMAL_MOOD[2]);
      post.setMood(moodGrade, THERMAL_MOOD[3], snap);
      return;
    }
    const m = SEASON_MOOD[s.season ?? 0] ?? SEASON_MOOD[0];
    let r = m[0]; let g = m[1]; let b = m[2]; let sat = m[3];
    const w = WEATHER_MOOD[weatherKind];
    if (w) {
      const i = Math.min(1, weatherIntensity);
      r *= 1 + (w[0] - 1) * i; g *= 1 + (w[1] - 1) * i; b *= 1 + (w[2] - 1) * i; sat *= 1 + (w[3] - 1) * i;
    }
    const sick = (s.sick ?? []).reduce((a, v) => a + v, 0);
    const epidemic = Math.min(1, (sick / Math.max(1, s.alive ?? 1)) * 4);
    if (epidemic > 0.02) {
      r *= 1 + (EPIDEMIC_MOOD[0] - 1) * epidemic; g *= 1 + (EPIDEMIC_MOOD[1] - 1) * epidemic;
      b *= 1 + (EPIDEMIC_MOOD[2] - 1) * epidemic; sat *= 1 + (EPIDEMIC_MOOD[3] - 1) * epidemic;
    }
    moodGrade.setRGB(r, g, b);
    post.setMood(moodGrade, sat, snap);
  }

  /**
   * Heat sources for the composer (idea 4): the nearest fire and lava tiles in front of
   * the camera, projected to screen space. Lava burns hotter than a grass fire.
   */
  function updateHeat() {
    if (!post.enabled) return;
    heatList.length = 0;
    if (motionReduced) { post.setHeat(heatList); return; }
    const consider = (tiles, hot) => {
      for (const t of tiles) {
        const d = Math.hypot(t.x - player.x, t.y - player.y, t.z - player.z);
        if (d > HEAT_RANGE || d < 1.5) continue;
        heatNdc.set(t.x, t.y + 0.6, t.z).project(camera);
        if (heatNdc.z > 1 || Math.abs(heatNdc.x) > 1.2 || Math.abs(heatNdc.y) > 1.2) continue;
        const radius = Math.min(0.35, (3.2 / (d * Math.tan((camera.fov * Math.PI) / 360))) * 0.5);
        heatList.push({ x: heatNdc.x * 0.5 + 0.5, y: heatNdc.y * 0.5 + 0.5, radius, strength: hot * (1 - d / HEAT_RANGE), d });
      }
    };
    consider(lavaTiles, 1);
    consider(fireTiles, 0.75);
    heatList.sort((a, b) => a.d - b.d);
    // Neighbouring burning tiles project to nearly the same spot; keep ones that are apart.
    const picked = [];
    for (const h of heatList) {
      if (picked.length >= 4) break;
      if (picked.some(q => Math.hypot(q.x - h.x, q.y - h.y) < q.radius * 0.8)) continue;
      picked.push(h);
    }
    post.setHeat(picked);
  }

  /**
   * Creature voices (idea 6), at 2 Hz: a hunting pack howls after dark, a bolting deer
   * barks, a fleeing rabbit drums the ground, and a tribe with Fire drums at night.
   */
  function updateVoices(timeSec, night) {
    if (!audio || !curr || !terrainApi) return;
    if (timeSec - voiceAt < 0.5) return;
    voiceAt = timeSec;
    let wolves = 0; let hunting = 0; let wx = 0; let wy = 0; let wz = 0;
    let deer = null; let rabbit = null;
    const r2 = VOICE_RANGE * VOICE_RANGE;
    for (let k = 0; k < interpCount; k++) {
      const o = k * FRAME.CREATURE_STRIDE;
      const dx = interp[o] - player.x; const dz = interp[o + 2] - player.z;
      if (dx * dx + dz * dz > r2) continue;
      const species = interp[o + 5] | 0; const goal = interp[o + 6] | 0;
      if (species === 2) { wolves++; wx += interp[o]; wy += interp[o + 1]; wz += interp[o + 2]; if (goal === GOAL.HUNT) hunting++; }
      else if (goal === GOAL.FLEE) {
        if (species === 1 && !deer) deer = { x: interp[o], y: interp[o + 1] + 1, z: interp[o + 2] };
        else if (species === 0 && !rabbit) rabbit = { x: interp[o], y: interp[o + 1], z: interp[o + 2] };
      }
    }
    const gap = (hunting ? 24 : 55) + (hash01(Math.floor(timeSec), 9) * 20);
    if (wolves && night > 0.35 && timeSec - howlAt > gap) {
      howlAt = timeSec;
      const at = { x: wx / wolves, y: wy / wolves + 1.2, z: wz / wolves };
      const voices = Math.min(3, wolves);
      for (let i = 0; i < voices; i++) {
        const id = setTimeout(() => { howlTimers.delete(id); if (running) audio.howl(at, 0.88 + i * 0.13 + Math.random() * 0.05); }, i * 650 + Math.random() * 400);
        howlTimers.add(id);
      }
    }
    if (deer && timeSec - barkAt > 5) { barkAt = timeSec; audio.bark(deer); }
    if (rabbit && timeSec - thumpAt > 3.5) { thumpAt = timeSec; audio.footThump(rabbit); }

    const ctx = audio.context;
    if (ctx && campfireAt && night > 0.4 && Math.hypot(campfireAt.x - player.x, campfireAt.z - player.z) < 110) {
      const beat = 30 / Math.max(30, tempo() || 54);
      if (drumBarAt < ctx.currentTime) drumBarAt = ctx.currentTime + 0.2;
      if (drumBarAt < ctx.currentTime + 1.1) { audio.drumBar(campfireAt, drumBarAt, beat); drumBarAt += beat * 4; }
    }
  }

  /** A connected gamepad rumbles for a near blast (the phone path is impactBus's). */
  function rumble(strength, delayMs = 0) {
    if (motionReduced || strength < 0.05 || !navigator.getGamepads) return;
    try {
      for (const pad of navigator.getGamepads() ?? []) {
        const act = pad?.vibrationActuator;
        if (!act?.playEffect) continue;
        act.playEffect('dual-rumble', {
          startDelay: Math.round(delayMs), duration: Math.round(180 + strength * 520),
          strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6),
        })?.catch?.(() => {});
      }
    } catch { /* haptics are never load-bearing */ }
  }

  /** Rain and snow, emitted in a column above the god so the weather is always on screen. */
  function emitWeather(dt) {
    if (!particles.enabled || weatherIntensity <= 0.02) return;
    const k = weatherKind;
    if (k !== 1 && k !== 2 && k !== 4) return;
    const perSecond = (k === 4 ? 70 : k === 2 ? 420 : 260) * weatherIntensity * (tier === 'medium' ? 0.6 : 1);
    rainDebt += dt * perSecond;
    const n = Math.min(40, Math.floor(rainDebt));
    rainDebt -= n;
    const kind = k === 4 ? 'snow' : 'rain';
    const top = player.y + (k === 4 ? 10 : 14);
    for (let q = 0; q < n; q++) {
      const x = player.x + (Math.random() - 0.5) * 44; const z = player.z + (Math.random() - 0.5) * 44;
      particles.emit(kind, x, top + Math.random() * 4, z, { count: 1, dir: [k === 2 ? 0.12 : 0.04, -1, 0.05], spread: k === 4 ? 0.5 : 0.06 });
    }
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
    lastTime = now;
    const timeSec = now / 1000;
    frames++;
    if (now - fpsAt >= 1000) {
      fps = frames * 1000 / (now - fpsAt); frames = 0; fpsAt = now; onFps(fps);
      if (fps < DPR_DOWN_FPS) { slowSeconds++; fastSeconds = 0; } else if (fps > DPR_UP_FPS) { fastSeconds++; slowSeconds = 0; } else { slowSeconds = 0; fastSeconds = 0; }
      if (slowSeconds >= DPR_DOWN_SECONDS) { setDprScale(dprScale - 0.12); slowSeconds = 0; }
      else if (fastSeconds >= DPR_UP_SECONDS && dprScale < 1) { setDprScale(dprScale + 0.08); fastSeconds = 0; }
    }

    interpolate(now);

    // The director needs this frame's creature rows, so the pose is stepped after the
    // interpolation and the direction is read once the pose is final.
    const intent = input.consume();
    if (terrainApi) {
      if (intent.forward || intent.right || intent.up || intent.jump) {
        noteInput(now);
        if (!told.move) { told.move = true; onAction('tour', 'move'); }
      } else if (directorIdleSeconds > 0 && !director.enabled && !directorDismissed && !directorHeld
        && now - lastInputAt > (everInteracted ? Math.max(directorIdleSeconds, DIRECTOR_RETAKE_SECONDS) : directorIdleSeconds) * 1000) setDirector(true);
      const driven = director.enabled && curr
        && director.update(dt, timeSec, { player, terrain: terrainApi, interp, handles: curr.views.handles, count: interpCount });
      if (!driven) stepPlayer(player, intent, dt, terrainApi);
    }
    // The camera is re-seated on EVERY frame, terrain or not. It used to live inside the
    // branch above, which meant that while the world was still loading — or never arrived
    // at all — look input moved the pose and nothing moved the camera, so the mouse read
    // as broken rather than as early. The player exists from construction (a flat stand-in
    // heightmap), so this is always a valid pose.
    const dir = player.direction();
    camera.position.set(player.x, player.y, player.z);
    camera.lookAt(player.x + dir.x, player.y + dir.y, player.z + dir.z);
    // The listener follows the UNSHAKEN pose: a camera shake is a lens artefact, and
    // panning the world's audio with it would make an eruption sound like vertigo.
    if (terrainApi) audio?.setPlayer(player, dir);

    if (curr) {
      // Follow: gently tether the god behind the followed creature (the director has its own tether).
      if (followHandle >= 0 && !director.enabled) {
        for (let k = 0; k < interpCount; k++) {
          if (curr.views.handles[k] !== followHandle) continue;
          const o = k * FRAME.CREATURE_STRIDE;
          const tx = interp[o] - Math.sin(player.yaw) * 6; const tz = interp[o + 2] - Math.cos(player.yaw) * 6;
          player.x += (tx - player.x) * Math.min(1, dt * 2);
          player.z += (tz - player.z) * Math.min(1, dt * 2);
          break;
        }
      }
      creatures.draw(interp, interpCount, timeSec, speeds, curr.views.handles, terrainApi?.heightAt);
      kinThreads.update(interp, curr.views.handles, interpCount, timeSec);
      trails?.stamp(interp, interpCount, speeds, dt);
      props.draw(curr.views.props, propCount);
      // Only on a frame the sim actually produced: see eventFx.props for why feeding it
      // repeated rows would read every falling body as one that had just landed.
      const tick = curr.views.header[FRAME.H_TICK];
      if (tick !== lastPropTick) {
        lastPropTick = tick;
        eventFx.props(curr.views.props, propCount, currAt, terrainApi);
        trackWatched(curr.views, curr.views.header[FRAME.H_COUNT]);
      }
      // The traffic layer follows a grid that changes every frame; two seconds is plenty.
      if (layer === 'traffic' && timeSec - layerAt > 2) { layerAt = timeSec; refreshLayer(); }
      hovered = pickCreature(camera.position, dir, interp, curr.views.handles, interpCount);
      minimap?.draw(interp, interpCount, player);
    }

    const overcast = (OVERCAST[weatherKind] ?? 0) * weatherIntensity;
    skyDome.setOvercast(overcast);
    const sky = lighting.update(stats?.dayFraction ?? 0.5, player, timeSec, skyDome.overcast);
    scene.background = sky.sky;
    materialClock.value = timeSec;
    if (stats && stats.season !== undefined) materialSeason.value = stats.season;
    updateSurface(dt);
    materialSky.value.copy(sky.sky);
    // A bow needs rain that has just eased off, ground still wet, a sun that is up, and a
    // sky that has opened; the dome hides it again when the sun climbs past 42 degrees.
    skyDome.setRainbow(Math.max(0, Math.min(1, surface.wet * 1.7 - 0.25)) * Math.max(0, 1 - surface.rain * 3.5)
      * (sky.day > 0.28 ? 1 : 0) * (1 - skyDome.overcast * 0.85));
    skyDome.update(sky, player, timeSec);
    // Cloud shadows: the deck the dome has just drawn, handed to every hooked surface.
    materialCloud.uCloudTime.value = timeSec;
    materialCloud.uCloudCover.value = skyDome.cover;
    materialCloud.uCloudSun.value.copy(sky.sunDir);
    materialCloud.uCloudShade.value = tier === 'low' ? 0 : CLOUD_SHADE * Math.min(1, sky.day * 2.5) * (1 - skyDome.overcast * 0.75);
    updateUnderwater(dt);
    island?.update(timeSec, sky, surface);
    const windy = weatherKind === WEATHER_STORM ? weatherIntensity : weatherKind === WEATHER_RAIN ? weatherIntensity * 0.4 : 0.12;
    grass?.update(dt, player, windy);
    if (campfireAt) {
      campfireLight.position.set(campfireAt.x, campfireAt.y + 1.1, campfireAt.z);
      const flicker = 0.85 + 0.15 * Math.sin(timeSec * 11.3) * Math.sin(timeSec * 7.1);
      campfireLight.intensity = (14 + (sky.night ?? 0) * 70) * flicker;
    } else campfireLight.intensity = 0;

    eventFx.ambient(dt, { fireTiles, lavaTiles, player, dayFraction: stats?.dayFraction ?? 0.5 });
    emitWeather(dt);
    emitSeason(dt);
    fauna?.update(dt, timeSec, { player, night: sky.night ?? 0, storm: weatherKind === WEATHER_STORM ? weatherIntensity : 0 });
    particles.update(dt, {
      fogColor: sky.sky, fogDensity: sky.fogDensity,
      pixelHeight: renderer.domElement.height, fov: camera.fov,
    });

    post.setNight(sky.night, sky.dusk);
    updateShafts(sky, dir);
    updateHeat();
    post.setHaze(weatherKind === WEATHER_DROUGHT && !motionReduced ? weatherIntensity * (sky.day ?? 1) : 0);
    updateVoices(timeSec, sky.night ?? 0);
    post.update(dt);
    // Shake LAST, after everything that reads the camera has read it: applyCameraShake
    // offsets in the camera's own basis and is recomputed from scratch each frame, so it
    // must not be applied before the audio listener or the shaft projection. Still gated
    // on terrainApi, though the re-seat above is now unconditional: every shake is raised
    // by a sim event, and there are none before a world exists.
    if (terrainApi && !motionReduced) applyCameraShake(camera, timeSec, 0.55);
    post.render();
    pip.mirror();
    onAfterRender?.();
    // While the world is popped out, the pop-out window's frame clock drives the loop:
    // a hidden tab's own requestAnimationFrame never fires.
    pip.raf(frame);
  }
  requestAnimationFrame(frame);

  // A lost GL context (driver reset, GPU process crash, too many contexts) stops every draw
  // dead. preventDefault is what makes the browser offer a restore at all; the engine
  // answers 'contextRestored' by rebuilding the renderer from the cached terrain and tiles,
  // because every GPU resource this module made is gone with the context.
  const onContextLost = (e) => { e.preventDefault(); contextLost = true; running = false; onAction('contextLost'); };
  const onContextRestored = () => { onAction('contextRestored'); };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  return {
    canvas, scene, camera, renderer, particles,
    get player() { return player.pose(); },
    get playerState() { return player; },
    get fps() { return fps; },
    get dprScale() { return dprScale; },
    get tier() { return tier; },
    get hovered() { return hovered; },
    get locked() { return input.locked; },
    setTerrain, setTiles, acceptFrame,
    setStats(s) {
      stats = s;
      if (s?.weather) {
        weatherKind = s.weather.kind | 0; weatherIntensity = s.weather.intensity ?? 0;
        audio?.setWeather?.(weatherKind, weatherIntensity);
      }
      if (s) { decideSpectacle(s); decideMood(s); }
      if (island && s?.tribes) island.setTribes(s.tribes, (id) => bannerColour(palette, id));
      if (settlementMeshes && s?.buildings) {
        settlementMeshes.syncBuildings(s.buildings);
      }
    },
    /** A drained sim event: routed to particles, the camera, the ear and the director. */
    onEvent(ev) {
      if (!ev || ev.tile === undefined || ev.tile < 0 || !terrainApi) return;
      const at = eventFx.worldOf(ev.tile, terrainApi, terrainApi.size);
      eventFx.event(ev, at, player, post);
      // Shockwave + rumble (idea 4 and the haptics bonus): only for the physical blasts,
      // scaled by distance, and only when the blast is actually in front of the camera.
      if (ev.kind === 'eruption' || ev.kind === 'lightning' || ev.kind === 'rockslide') {
        const dist = Math.hypot(at.x - player.x, at.y - player.y, at.z - player.z);
        const reach = ev.kind === 'eruption' ? 220 : ev.kind === 'lightning' ? 120 : 80;
        const near = Math.max(0, 1 - dist / reach);
        if (near > 0 && !motionReduced) {
          heatNdc.set(at.x, at.y + 2, at.z).project(camera);
          if (heatNdc.z < 1 && Math.abs(heatNdc.x) < 1.3 && Math.abs(heatNdc.y) < 1.3) {
            post.shockwave(heatNdc.x * 0.5 + 0.5, heatNdc.y * 0.5 + 0.5, near * (ev.kind === 'eruption' ? 1 : 0.6));
          }
        }
        // The pad rumbles when the SOUND arrives, not the light.
        rumble(near * near * (ev.kind === 'eruption' ? 1 : 0.7), (dist / 343) * 1000);
      }
      if (director.enabled) director.cut(at.x, at.z, EVENT_CAPTIONS[ev.kind] ?? ev.text ?? '', lastTime / 1000);
    },
    /**
     * A chronicle moment (idea 7): the director cuts to it if it is running, and an
     * extinction drains the colour out of the frame for a few seconds.
     */
    moment(ev) {
      if (!ev) return;
      if (ev.kind === 'extinction') post.dip(1, 5);
      if (director.enabled && terrainApi && ev.tile !== undefined && ev.tile >= 0) {
        const at = eventFx.worldOf(ev.tile, terrainApi, terrainApi.size);
        director.cut(at.x, at.z, ev.text ?? '', lastTime / 1000);
      }
    },
    /** The creature `handle` as the frame has it now, or null: position, species, traits. */
    creatureInfo(handle) {
      if (!curr || handle === undefined || handle < 0) return null;
      for (let k = 0; k < interpCount; k++) {
        if (curr.views.handles[k] !== handle) continue;
        const o = k * FRAME.CREATURE_STRIDE;
        const traits = [];
        for (let f = 0; f < 5; f++) traits.push(interp[o + FRAME.TRAIT_OFFSET + f]);
        return { handle, species: interp[o + 5] | 0, traits, x: interp[o], y: interp[o + 1], z: interp[o + 2] };
      }
      return null;
    },
    get followHandle() { return followHandle; },
    /**
     * A still of the current view at up to twice the display resolution (the reel's photo
     * mode). Rendered on demand outside the loop and copied into a 2D canvas in the same
     * task, which is what makes it readable without preserveDrawingBuffer.
     */
    photo() {
      if (contextLost) return null;
      const base = renderer.getPixelRatio();
      const w = container.clientWidth || 1;
      const scale = Math.max(1, Math.min(2, 4096 / Math.max(1, w * base)));
      try {
        if (scale > 1) { renderer.setPixelRatio(base * scale); post.setPixelRatio(base * scale); resize(); }
        post.render();
        const out = document.createElement('canvas');
        out.width = canvas.width; out.height = canvas.height;
        out.getContext('2d').drawImage(canvas, 0, 0);
        return out;
      } finally {
        if (scale > 1) { renderer.setPixelRatio(base); post.setPixelRatio(base); resize(); }
      }
    },
    get surface() { return { ...surface }; },
    // Selection is the sim's and the page's business, not the renderer's: nothing is
    // drawn differently for the inspected creature since the wireframe box went
    // (creatureMeshes.js). Kept as a no-op so the engine API stays one shape.
    select() {},
    follow(handle) { if (handle >= 0) noteInput(); followHandle = handle ?? -1; },
    /** A lens: a trait index 0–4, a LENS value (hunger, health, thermal, kin), or -1 for none. */
    setTint(lens) { creatures.setTint(lens); if (stats) decideMood(stats, true); },
    get tint() { return creatures.tint; },
    /** The camera's subject and its living relatives (index.js asks the sim every two seconds). */
    setKin(handle, list) { creatures.setKin(handle, list); kinThreads.set(handle, list); },
    get kinThreads() { return kinThreads.count; },
    /** The minimap's data layer: 'none' | 'deaths' | 'predation' | 'sickness' | 'grazing' | 'traffic'. */
    setLayer(name) { layer = name || 'none'; layerAt = 0; refreshLayer(); },
    get layer() { return layer; },
    /** The sim's heat book ({ side, deaths, kills, sick }), for the three layers it feeds. */
    setHeat(h) { heat = h; refreshLayer(); },
    /** A birth in a watched family: a ring opens around the parent and a chime rises from it. */
    birthMark(handle) {
      if (!curr) return;
      for (let k = 0; k < interpCount; k++) {
        if (curr.views.handles[k] !== handle) continue;
        const o = k * FRAME.CREATURE_STRIDE;
        particles.ring('mote', interp[o], interp[o + 1] + 0.35, interp[o + 2], 28);
        audio?.chime?.({ x: interp[o], y: interp[o + 1] + 1, z: interp[o + 2] });
        return;
      }
    },
    get underwater() { return underK; },
    get rainbow() { return skyDome.rainbow; },
    // The page's 🎬 button goes through the same switch the C key does, so an explicit
    // off is remembered rather than undone by the idle timer.
    setDirector(on) { if (director.enabled === !!on) return; toggleDirector(); },
    get director() { return director.enabled; },
    get directorCaption() { return director.caption; },
    togglePip: () => pip.toggle(),
    get pipActive() { return pip.active; },
    setPose(pose) { if (terrainReady) player.setPose(pose); else pendingPose = pose; },
    /** Park the camera looking at a world point from 26 m back and 22 m up (timeline, tribes). */
    flyTo(x, z) {
      noteInput();
      const h = terrainApi ? Math.max(0, terrainApi.heightAt(x, z)) : 0;
      const pose = { x, y: h + 22, z: Math.max(1, z - 26), yaw: 0, pitch: -0.62, mode: 'fly' };
      if (terrainReady) player.setPose(pose); else pendingPose = pose;
    },
    /** Hold the director off (true) or release it (false). A held director is also switched off. */
    holdDirector(on) { directorHeld = !!on; if (directorHeld && director.enabled) setDirector(false); },
    setBindings: (b) => input.setBindings(b),
    setReducedMotion(on) { motionReduced = !!on; },
    get contextLost() { return contextLost; },
    get faunaInfo() { return { birds: fauna?.birdCount ?? 0, fishSchools: fauna?.fishSchools ?? 0 }; },
    touchMove: (x, z) => input.setTouchVector(x, z),
    touchRelease: () => input.releaseTouch(),
    toggleFly: () => player.toggleFly(),
    requestLock: () => canvas.requestPointerLock?.(),
    dispose() {
      running = false;
      // The two frames held for interpolation belong to the worker's pool of three; a
      // renderer rebuilt without returning them (quality change, context restore) would
      // leave the sim one buffer short, and it skips frames when the pool is empty.
      if (lastRecycle) { if (prev) lastRecycle(prev.buffer); if (curr) lastRecycle(curr.buffer); }
      prev = null; curr = null;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      fauna?.dispose();
      for (const id of howlTimers) clearTimeout(id);
      howlTimers.clear();
      grass?.dispose(); trails?.dispose();
      observer.disconnect();
      window.removeEventListener('resize', resize);
      input.dispose();
      pip.dispose();
      scene.remove(campfireLight);
      settlementMeshes?.dispose();
      audio?.setUnderwater?.(false);
      kinThreads.dispose();
      creatures.dispose(); props.dispose(); flora?.dispose(); island?.dispose(); lighting.dispose(); skyDome.dispose(); minimap?.dispose();
      particles.dispose(); post.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
