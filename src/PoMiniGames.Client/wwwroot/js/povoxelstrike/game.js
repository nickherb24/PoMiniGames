// game.js — PoVoxelStrike engine core. M3 scope: the full survival loop — enemies
// escalate forever, the gun heats, debris crushes both sides, death ends the run.
//
// Input contract: during play the CANVAS owns raw input under Pointer Lock.
// Losing the lock for any reason (Esc, tab switch) pauses the simulation and hands the
// overlay to Blazor via OnPaused; Resume re-acquires the lock from the button's click
// gesture. A run is built in state 'ready' — rendered, nothing simulated, behind the
// page's start card — and enter() (that card's button, so a gesture) is what takes the
// lock and starts the clock. The engine's own click-to-play veil is gone: it was a second
// card and a second click after the first.
//
// A gamepad and a touch screen cannot take the lock at all. They get FREE CONTROL instead
// (see input.js): same simulation, no lock, and pause is a button rather than lock loss.
// `_controlling()` is the one test for "the player is driving", whichever way they got in.
//
// Interop contract: a 10 Hz OnHudTick pump of flat primitives (positional,
// same convention as PoMarbleRace — no DTOs across the boundary), plus the discrete
// lifecycle events OnReady / OnResumed / OnPaused / OnGameOver / OnFatalError. Never
// per-frame.
//
// Co-op mode: when the engine is constructed with
// `mode: 'multi'`, the local player's inputs are sampled at the platform's lockstep
// tick rate (20 Hz) and shipped to `multiplayerSink(batch)`. The server stamps a tick
// number and relays every peer's batch back; the engine applies the batches in
// PlayerNumber order. The server is NOT authoritative for the simulation — clients
// run identical local engines, the server just relays inputs. Determinism is the
// client's responsibility.
//
// ARG ORDER IS A CONTRACT. The positional lists below mirror [JSInvokable] methods in
// PoVoxelStrikePage.razor — reorder/insert on BOTH sides or the binder mis-assigns:
//   OnHudTick(hp, score, elapsed, kills, gunsSilenced, gunsTotal, down, revivePct)
//     (heat and blast are NOT here: the crosshair rings show them, engine-side)
//   OnGameOver(score, survivalSeconds, kills, bruteKills, crushKills,
//              voxelsDestroyed, seed, gunsSilenced, gunsTotal, damageTaken)
//                                              ← new args go at the END only
//   OnVictory(same list) · OnReady(assetCount, structureCount, weather)
//   OnResumed() · OnPaused(reason) · OnFatalError(message)
//   Online only: OnLockstepBatch(batch) · OnCarve(kind, structure, x, y, z) · OnChaliceClaimed()

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { buildWorld, ARENA_HALF } from './world.js';
import { DebrisManager } from './debris.js';
import { Weapon } from './combat.js';
import { EnemyManager } from './enemies.js';
import { VoxelAudio } from './audio.js';
import { Vfx } from './vfx.js';
import { resolveQuality, createRenderer } from './quality.js';
import { setQuality, SkyEnvironment, markHotCarve, tickMaterials, resetMaterials } from './materials.js';
import { ParticleSystem } from './particles.js';
import { DecalField } from './decals.js';
import { FortressGuns, Chalice, OUTER_HALF, INNER_HALF, KEEP_HALF } from './fortress.js';
import { ShrapnelField } from './shrapnel.js';
import { createPhysicsWorld, PHYSICS_STEP as SI_PHYSICS_STEP } from './physics.js';
import { Avatar } from './avatar.js';
import { AltInput } from './input.js';
import { Weather } from './weather.js';
import { ClipRecorder } from './clip.js';
import { loadSettings } from './settings.js';

const CAM_DISTANCE = 7;
// How close the chase camera may be pushed by a wall before the avatar is hidden — inside
// that, the figure fills the frame and you are looking at the back of your own head.
const CAM_HIDE_AVATAR_BELOW = 1.5;
const CAM_WALL_MARGIN = 0.35;
const WALK_SPEED = 9;
const RUN_SPEED = 16;
// Take-off speed. At SI gravity this clears about 1.7 m — a rubble pile or a wall stub,
// never the 12 m inner curtain. Walls are still the siege; a jump is for the mess you made.
const JUMP_SPEED = 5.8;
const JUMP_COOLDOWN_S = 0.3;
// Mouse look, radians per pixel at look-speed 1.0 (the pause dialog's slider scales it).
const LOOK_RAD_PER_PX = 0.0025;
const STRIDE_M = 2.3;                   // ground covered per footstep sound
const PHYSICS_STEP = SI_PHYSICS_STEP;
// The player is a rigid body now (see _buildPlayerBody). A sphere, not a capsule:
// cannon-es has no capsule primitive, and a single sphere at the hips with a ground probe
// underneath is the standard, robust way to do this — it cannot catch its corners on a
// voxel edge the way a box does, and every FPS controller built on cannon works this way.
const PLAYER_RADIUS = 0.45;
const PLAYER_MASS = 80;                 // kg
const PLAYER_EYE_ABOVE_CENTRE = 0.75;
// How high a ledge the player walks up without jumping. 0.6 m is a tall step; the old
// code allowed 2.2 m, which is a wall.
const STEP_HEIGHT = 0.6;
const GROUND_PROBE = PLAYER_RADIUS + 0.25;
// Collision groups. Everything in the world is group 1; the player alone is group 2, so
// the ground probe can ray against the world without hitting the body it starts inside.
const WORLD_GROUP = 1;
const PLAYER_GROUP = 2;
const HUD_INTERVAL_S = 0.1;
// Taking the chalice is the win, so it has to out-score any amount of grinding — and
// taking it SOONER has to out-score taking it later. The bonus used to be a flat 25,000
// beside a +10/s clock, which made standing outside the wall for an hour the best play.
// It now decays at 40/s, four times what the clock pays, down to a 5,000 floor.
// PoVoxelStrikeScore.WinBonus (Domain) is the server's copy: the endpoint's plausibility
// ceiling is computed from it, so the two must change together.
const winBonus = (seconds) => Math.max(5000, 25000 - 40 * Math.floor(seconds));
// Seconds the win is held before the summary: the slow orbit, the flare, the fanfare.
const VICTORY_SHOW_S = 4;
const VICTORY_TIME_SCALE = 0.35;
// Collapses at least this big (voxels) get the hit-stop, the sub drop and the dust front.
const BIG_COLLAPSE_VOXELS = 400;
const HIT_STOP_S = 0.28;
const HIT_STOP_SCALE = 0.22;
const LOW_HP = 30;
// Chunks the whole fortress may re-mesh per frame for LOD changes. Greedy meshing made a
// chunk cheap, but 44 structures changing band at once is still 800 of them.
const REMESH_CHUNKS_PER_FRAME = 6;
// Half-width of the sun's shadow window, in metres, centred ahead of the player.
const SHADOW_HALF_M = 45;
// Physics streaming: static collider bodies further than this from the player are taken
// out of the world entirely, and re-added on approach. Measured first at 120 m, which
// combined with each piece's own extent covered the whole 180 m arena and streamed out
// precisely nothing. 70 m is past anything the player is standing on or that debris near
// them can reach; carving and shooting are unaffected either way, because those read the
// voxel grid directly rather than the physics world.
const PHYSICS_STREAM_RADIUS_M = 70;
const PHYSICS_STREAM_INTERVAL_S = 0.5;
// Floor for dynamic resolution. Below this the picture is soft enough that the frames are
// not worth having.
const MIN_RENDER_SCALE = 0.6;
// Kiosk siege AI (demo mode). Tuned so the attract loop reads clearly from across a room:
// the bot should visibly stop at a wall, chew through it, and walk in.
const DEMO_PROBE_RANGE = 14;        // metres of "is something in my way"
const DEMO_BLAST_RANGE = 11;        // only lob the blast ball at something it can reach
const DEMO_BLAST_COOLDOWN_S = 4;
const DEMO_REACH_RADIUS = 5.5;      // close enough to the chalice to count as taken
// How far ahead the bot digs when it is stuck and the probe rays found nothing.
const DEMO_FORCE_DISTANCE = 4;
const DEMO_TRIUMPH_S = 5;
const PLAYER_MAX_HP = 100;
const PLAYER_CRUSH_MIN_SPEED = 5;

// ── Online (co-presence) ──
// Inputs are not replayed on peers: enemies, debris and the player controller all step
// with a variable dt and Math.random, so two engines fed identical inputs diverge within
// seconds. The run is co-presence instead: every client builds the SAME arena from the seed the session dealt, ships its
// own position + yaw at the lockstep rate, and renders the other players as avatars at the
// positions it is sent. Enemies and damage stay local to each client.
//
// Three things cross the wire besides positions. Carves do (each client
// replays the others' through Weapon.applyRemote, so the breach is one breach); the win
// does (one player takes the chalice, the squad wins); and "down" does — a player at 0 HP
// with a squadmate still standing waits for a revive instead of ending their own run.
const PLAYER_COLOR = 0xe4572e;
const PEER_COLORS = [0x3b82f6, 0x22c55e, 0xf59e0b, 0xa855f7, 0x14b8a6, 0xec4899];
// Seconds without a batch before a peer avatar is taken down.
const PEER_STALE_S = 10;
// A peer silent for longer than this cannot be counted on to revive anyone. Generous on
// purpose: a squadmate's browser stalling on a first-carve shader compile goes quiet for
// seconds, and at 3 s that stall read as "nobody left" and killed a player who had help.
const PEER_LIVE_S = 6;
const REVIVE_RADIUS = 3.5;
const REVIVE_S = 3;
const REVIVE_HP = 50;
const BLEED_OUT_S = 45;

export class Engine {
  /**
   * @param {object|null} online null for solo/demo, else { playerNumber, seed, names } from
   *   the lockstep session — see index.js start(). `names` maps player number → display name.
   * @param {object} opts { seed?: number, survival?: boolean } — a seed to replay (Daily
   *   Siege, "replay this arena") and whether the roaming horde is on.
   */
  constructor(host, dotnetRef, demo, volumes, mode = 'solo', online = null, opts = {}) {
    this.host = host;
    this.dotnetRef = dotnetRef;
    this.demo = demo;
    this.volumes = volumes;
    this.survival = !!opts.survival && mode !== 'multi';
    this.settings = loadSettings();
    // 'solo' (default) or 'multi'. Multi enables the lockstep input shipper.
    this.mode = mode === 'multi' ? 'multi' : 'solo';
    this.multiplayerSink = null;
    this.multiplayerPlayerNumber = 1;
    this._lockstepClock = 0;
    this._lockstepTick = 0;
    // Same tick rate as the server pump
    // (PoVoxelStrikeLockstepService.TickIntervalMs = 50). Drift-corrected in the frame
    // loop below — see _frame().
    this._lockstepIntervalMs = 50;

    this.disposed = false;
    this.running = false;
    // 'ready' | 'playing' | 'paused' | 'dead'. A played run waits in 'ready' behind the
    // start card until enter(); the kiosk bot has no card and starts playing.
    this.state = demo ? 'playing' : 'ready';
    // World seed: generated per run, surfaced in OnGameOver so the run
    // summary can show it. Hex keeps it short enough to read aloud.
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    if (Number.isFinite(opts.seed) && opts.seed > 0) this.seed = opts.seed >>> 0;
    // Online: the whole squad builds the arena the session dealt.
    if (online && online.seed) this.seed = online.seed >>> 0;
    if (online && online.playerNumber) this.multiplayerPlayerNumber = online.playerNumber | 0;
    this.peerNames = (online && online.names) || {};
    this.peers = new Map();   // playerNumber → { avatar, target, yaw, seenAt, down, speed }
    this.carveSink = null;    // online: (kind, structureIndex, x, y, z) → the hub
    this.winSink = null;      // online: () → the hub, when this player takes the chalice
    this.free = false;        // free control: driving without Pointer Lock (pad / touch)
    this.rafId = 0;
    this.lastTime = 0;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = -0.25;
    this._fireMouse = false;
    this._jumpCd = 0;
    this._jumpQueued = false;

    // Run stats (score formula inputs).
    this.hp = PLAYER_MAX_HP;
    this.elapsed = 0;
    this.kills = 0;
    this.bruteKills = 0;
    this.crushKills = 0;
    this.voxelsDestroyed = 0;
    this.damageTaken = 0;
    this.hudClock = 0;
    // Down-but-not-out (online only): see _goDown.
    this.downed = false;
    this.reviveT = 0;
    this.bleedT = 0;
    // Simulation time scale: the hit-stop on a big collapse and the slow victory beat.
    this._hitStopT = 0;
    this._hitStopCd = 0;
    this.wonAt = -1;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (!this._controlling() || this.state !== 'playing') return;
      // Keyboard fire (user request: trackpad users shouldn't need mouse buttons):
      // F digs (held — read off this.keys every frame), G blasts. Mouse buttons work too.
      if (e.code === 'KeyG' && !this.downed) this.weapon.fireAlt(this._muzzle());
      if (e.code === 'Space') { this._jumpQueued = true; e.preventDefault(); } // no page scroll
      // Under Pointer Lock the browser takes Esc itself and the lock loss is the pause;
      // in free control nothing does, so Esc has to be a pause key here.
      if (e.code === 'Escape' && this.free) this.pause();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => this._look(e.movementX, e.movementY);
    this._onMouseDown = (e) => this._mouseButton(e, true);
    this._onMouseUp = (e) => this._mouseButton(e, false);
    this._onContextMenu = (e) => { if (this._locked()) e.preventDefault(); };
    this._onPointerLockChange = () => this._lockChanged();
  }

  /**
   * Async because the renderer is: the WebGPU path has to await adapter init before it
   * can report whether it came up. index.js awaits this; nothing else may assume the
   * engine is usable the instant the constructor returns.
   */
  async start() {
    const width = this.host.clientWidth || 800;
    const height = this.host.clientHeight || 480;

    // Resolve the GFX tier FIRST and publish it: world geometry is built further down
    // this method and every material it creates reads the tier through materials.js.
    this.q = resolveQuality();
    setQuality(this.q);

    // MSAA is redundant once SMAA is in the chain, and the two together cost twice for
    // one result — so the tier that turns SMAA on turns hardware AA off.
    const built = await createRenderer({ antialias: !this.q.smaa });
    if (this.disposed) { built.renderer.dispose?.(); return; }
    this.renderer = built.renderer;
    this.rendererApi = built.api;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // PBR wants a filmic curve and a linear working space; without tone mapping the
    // sun-lit faces of a white cottage clip to flat white the moment the sun is up.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // ACES rolls highlights off hard, so a "correct" exposure of 1.0 reads as gloomy in a
    // scene made almost entirely of mid-grey stone. 1.2 puts the walls in the upper
    // midtones where the damage is readable; 1.45 (tried first) clipped stone and sky to
    // flat white, which is not "brighter", it is less picture.
    this.renderer.toneMappingExposure = 1.2;
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.host.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    // Dusk-blue palette so the grass terrain reads as outdoors while staying on the
    // platform's dark theme. The gradient sky dome (vfx.buildSky) replaces the flat
    // clear color; the fog is tuned to the dome's horizon so distance melts into sky.
    // Fog range is tuned to the FORTRESS, not to the old scattered settlement: the outer
    // wall is 116 units across and the keep sits 58 units behind the gate, so the previous
    // 70/230 range dissolved the objective into haze from the moment you could see it.
    // Start the falloff past the far wall and end it past the arena boundary.
    this.scene.fog = new THREE.Fog(0x3d4961, 150, 520);
    const hemi = new THREE.HemisphereLight(0xbfc8dd, 0x2c2e33, 1.6);
    this.scene.add(hemi);
    // Unshadowed interior fill. The keep is a roofed stone box: without this the vault
    // holding the chalice — the place the whole game points at — was lit only by the
    // chalice's own lamp.
    const ambient = new THREE.AmbientLight(0xc8d4e8, 0.7);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff2df, 2.2);
    sun.position.set(40, 80, 25);
    // One 2048 shadow map over the whole arena: ~13 cm texels, chunky but exactly the
    // voxel aesthetic — and cheap enough that collapsing towers cast moving shadows.
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    // The shadow camera FOLLOWS the player (see _updateShadowCamera) instead of covering
    // the whole 260 m arena from a fixed box. Same map resolution over a 70 m window is
    // ~7x finer per texel AND rasterises a fraction of the geometry, because everything
    // outside the window is culled out of the shadow pass entirely.
    sun.shadow.camera.left = -SHADOW_HALF_M;
    sun.shadow.camera.right = SHADOW_HALF_M;
    sun.shadow.camera.top = SHADOW_HALF_M;
    sun.shadow.camera.bottom = -SHADOW_HALF_M;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 280;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, width / height, 0.1, 500);

    this.vfx = new Vfx(this.renderer, this.scene, this.camera, this.host, this.q);
    this.vfx.buildSky();
    // Time-of-day owns the sun and the hemisphere fill from here on: it repaints their
    // colour and intensity every frame, so the literals set above are only the values
    // that hold for the first frame.
    this.sun = sun;
    this.vfx.attachSun(sun, hemi, ambient);
    this.skyEnv = new SkyEnvironment(this.renderer, this.scene, this.q);
    this.skyEnv.update(0, this.vfx.skyKey, this.vfx._sunDir, true);
    this.particles = new ParticleSystem(this.scene, this.q.particles);
    this.particles.setViewportHeight(this.renderer.getSize(new THREE.Vector2()).y);
    this.decals = new DecalField(this.scene, this.q.decals);
    this._spaceClock = 0;
    // Demo (kiosk) keeps the visuals but stays silent — there is no user gesture to
    // unlock an AudioContext, and the catalog page should not hum on its own.
    this.audio = this.demo ? null : new VoxelAudio();
    this.audio?.setQuality(this.q); // before the first cue: it decides the reverb graph
    this._prevLocked = false;
    this._cueClock = 1.5;
    this._tensionClock = 0;
    this._heartClock = 0;
    this._steamClock = 0;
    this._stride = 0;
    this.indoors = 0;

    // Physics: cannon-es (the platform's physics engine — PoRacer/PoMarbleRace ship it
    // via the same import map).
    // SI units, sweep-and-prune broadphase and the full per-material contact table all
    // come from physics.js — there is one definition of what stone-on-stone means.
    const built2 = createPhysicsWorld();
    this.physicsWorld = built2.world;
    this.physicsMaterials = built2.materials;
    this.physicsAccumulator = 0;

    const { structures, terrain, spawn, chaliceSpot, turretMounts } = buildWorld(
      this.scene, this.physicsWorld, this.volumes, this.seed, this.physicsMaterials);
    this.structures = structures;
    this.terrain = terrain;
    this.spawnPoint = spawn;

    this.shrapnel = new ShrapnelField(this.scene, this.physicsWorld, this.q.shrapnel,
      { terrain: this.terrain, structures: this.structures }, this.physicsMaterials.stone);
    this.debris = new DebrisManager(this.scene, this.physicsWorld, {
      collapse: (voxels, position) => {
        this.audio?.collapse(voxels, position);
        // Shake scales with tonnage and falls off with distance; a truly big fall
        // close by also rings the ears.
        const d = this.player.position.distanceTo(position);
        const proximity = Math.max(0, 1 - d / 50);
        this.vfx.addShake(Math.min(0.5, voxels / 700) * proximity);
        if (voxels > 250 && d < 18) this.audio?.concussion(0.5);
        // Masonry dust: count tracks tonnage so a cornice puffs and a tower billows.
        this.particles.emit(position, Math.min(90, 6 + (voxels >> 2)), {
          color: 0xb9ab95, speed: 1.6, spread: 3, size: 0.9,
          life: 2.6, upward: 0.7,
        });
        // Close enough to be in the cloud: grit on the lens.
        if (d < 24) this.vfx.lensDust(Math.min(0.9, voxels / 450) * (1 - d / 24));
        if (voxels >= BIG_COLLAPSE_VOXELS) this._bigCollapse(voxels, position, proximity);
      },
      impact: (mass, position) => {
        this.audio?.debrisHit(mass, position);
        this.particles.emit(position, Math.min(10, 2 + (mass / 60) | 0), {
          color: 0x9c8f79, speed: 1.1, spread: 1, size: 0.5, life: 1.1, upward: 0.5,
        });
      },
    }, this.physicsMaterials);
    this.debris.structures = this.structures; // blast shielding needs the occluders
    // The structural solve runs in a worker now, so detached mass arrives a frame or two
    // after the shot that caused it rather than as a return value. This is the delivery
    // point; scoring still counts every voxel, just slightly later.
    for (const s of this.structures) {
      s.onClusters = (structure, clusters) => {
        for (const c of clusters) {
          this.voxelsDestroyed += c.voxels.length;
          this.debris.spawnCluster(structure, c);
        }
      };
    }
    this.enemies = new EnemyManager(this.scene, this.structures, this.debris, this.terrain, {
      enabled: this.survival,
      demo: this.demo,
      onPlayerDamage: (amount) => this._damagePlayer(amount),
      onKill: (type, byCrush) => {
        this.kills++;
        if (type === 'brute') this.bruteKills++;
        if (byCrush) { this.crushKills++; this.audio?.crush(0); }
      },
      onCarve: (removed, clusterVoxels) => { this.voxelsDestroyed += removed + clusterVoxels; },
      fx: {
        spit: (position) => this.audio?.spit(position, 1),
        enemyDeath: (type, position) => {
          this.audio?.enemyDeath(type, position);
          this.particles.emit(position, 14, {
            color: type === 'brute' ? 0x8a6a4a : 0x7dffb0,
            speed: 3.2, spread: 1.2, size: 0.45, life: 0.9, upward: 1.0,
          });
        },
      },
    });
    this.weapon = new Weapon(this.scene, this.camera, this.structures, this.terrain, this.debris,
      this.enemies, (removed, clusterVoxels) => { this.voxelsDestroyed += removed + clusterVoxels; },
      {
        shot: (muzzle) => { this.audio?.shot(); this.vfx.muzzleFlash(muzzle); this._firedT = 0.1; },
        altLaunch: () => this.audio?.altLaunch(),
        // Online: every carve that lands here is offered to the squad (see index.js).
        carved: (kind, structureIndex, point) =>
          this.carveSink?.(kind, structureIndex, point.x, point.y, point.z),
        detonate: (point) => {
          const near = Math.max(0, 1 - this.player.position.distanceTo(point) / 55);
          this.audio?.explosion(point, near);
          this.vfx.shockwave(point);
          // Scaled by distance now that a squadmate's blast across the arena lands here too.
          this.vfx.addShake(0.45 * near);
          markHotCarve(point, 6);
          this.particles.emit(point, 70, {
            color: 0x6b6157, speed: 7, spread: 2, size: 1.4, life: 2.4, upward: 1.1,
          });
          this.particles.emit(point, 26, {
            color: 0xffb066, speed: 10, spread: 1, size: 0.7, life: 0.5, upward: 1.4,
          });
          this.decals.stamp(point, this._surfaceNormal(point), { radius: 3.4, color: 0x140f0b });
        },
        // Primary-fire contact: a small puff and a small burn, so sustained digging
        // leaves a visible trench rather than a clean hole.
        impact: (point, kind, normal, radius) => {
          markHotCarve(point, radius);
          this.particles.emit(point, 6, {
            color: kind === 'terrain' ? 0x6d5138 : 0xc9c6c0,
            speed: 2.2, spread: 0.6, size: 0.32, life: 0.8, upward: 0.9,
          });
          this.decals.stamp(point, normal ?? this._surfaceNormal(point),
            { radius: 0.85, color: 0x1c1712, life: 26 });
        },
      },
      this.shrapnel);

    // The player is a voxel figure (avatar.js); `this.player` is its root group, which is
    // all the rest of the engine ever asked of the capsule it replaces — a position and a
    // yaw.
    this.avatar = new Avatar(PLAYER_COLOR);
    this.player = this.avatar.group;
    // Spawn is OUTSIDE the outer wall. The origin is the middle of the keep now, and a
    // player who starts on the objective has not besieged anything.
    this.player.position.copy(this.spawnPoint);
    this._prevPlayerPos = this.player.position.clone();
    this._playerVel = new THREE.Vector3();
    this._buildPlayerBody();
    this.scene.add(this.player);
    // Face the gate, not the spawn apron behind it.
    this.player.rotation.y = this.yaw;
    this._camDist = CAM_DISTANCE;

    // ── The siege fixtures ──────────────────────────────────────────────
    this.chalice = new Chalice(this.scene, chaliceSpot, this.q);
    this.guns = new FortressGuns(this.scene, this.structures, this.terrain, {
      onPlayerDamage: (amount, from) => this._damagePlayer(amount, from),
      fx: {
        fire: (position) => {
          this.audio?.turretShot(position);
          this.vfx.muzzleFlash(position);
          this.particles.emit(position, 5, {
            color: 0xffd9a0, speed: 3.4, spread: 0.4, size: 0.35, life: 0.4, upward: 0.6,
          });
        },
        whiz: (position) => this.audio?.whiz(position),
        hit: (position) => {
          this.particles.emit(position, 7, {
            color: 0xc9c6c0, speed: 2.6, spread: 0.5, size: 0.3, life: 0.6, upward: 1.0,
          });
          this.decals.stamp(position, this._surfaceNormal(position),
            { radius: 0.6, color: 0x241c14, life: 18 });
        },
        // A gun going quiet is the reward for demolition, so it gets its own beat.
        destroyed: (position) => {
          this.audio?.collapse(180, position);
          this.particles.emit(position, 30, {
            color: 0x8d8478, speed: 4.5, spread: 1.5, size: 0.8, life: 1.8, upward: 1.2,
          });
        },
      },
    });
    for (const mount of turretMounts) this.guns.add(mount.position, mount.structure);

    // Weather belongs to the seed, so a Daily Siege and an online squad share it.
    this.weather = new Weather(this.scene, this.seed, this.q, {
      overcast: (amount) => { this.vfx.overcast = amount; },
      flash: (amount) => this.vfx.flash(amount),
      thunder: (delay) => this.audio?.thunder(delay),
    });

    this._buildCrosshair();
    this.input = new AltInput(this.host, { pause: () => this.pause() });
    this.clip = (this.q.collapseClip && !this.demo) ? new ClipRecorder(this.canvas) : null;

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('contextmenu', this._onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this.host);

    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame((t) => this._frame(t));

    this._notify('OnReady', this.volumes.length, structures.length, this.weather.kind);
  }

  /** Is the player driving — under Pointer Lock, or in free control (pad / touch)? */
  _controlling() { return this._locked() || this.free; }

  /**
   * Take control: the start card's button, and the pause dialog's Resume. Both are click
   * gestures, which is what makes the lock request legal. The state only moves to
   * 'playing' once control is actually held (_lockChanged, or _beginFree) — a refused lock
   * request therefore leaves the card up to be clicked again, instead of a running clock
   * with nobody at the controls.
   * @param free force free control (a pad button pressed on the card)
   */
  enter(free = false) {
    if (this.demo || this.disposed) return;
    if (this.state !== 'ready' && this.state !== 'paused') return;
    if (free || this.input.touch) { this._beginFree(); return; }
    try {
      const pending = this.canvas.requestPointerLock();
      pending?.catch?.(() => { /* refused (no gesture, or Chrome's post-Esc cooldown): click again */ });
    } catch { /* same */ }
  }

  /** Blazor's Resume button. Kept as its own name; it is the same act as entering. */
  resume() { this.enter(); }

  _beginFree() {
    this.free = true;
    this.state = 'playing';
    this.audio?.setPaused(false);
    this.crosshair.style.display = 'block';
    this.input.setActive(true);
    this._notify('OnResumed');
  }

  /** Pause on purpose: the touch button, a pad's Start, or Esc in free control. */
  pause() {
    if (this.state !== 'playing' || this.demo) return;
    if (this._locked()) { document.exitPointerLock(); return; } // _lockChanged does the rest
    this.free = false;
    this._fireMouse = false;
    this.input.setActive(false);
    this.crosshair.style.display = 'none';
    this.state = 'paused';
    this.audio?.setPaused(true);
    this._notify('OnPaused', 'button');
  }

  /** Live settings from the pause dialog. The graphics tier is read at the next start(). */
  applySettings(settings) {
    this.settings = settings;
    if (this.camera && this.camera.fov !== settings.fov) {
      this.camera.fov = settings.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    this.resizeObserver?.disconnect();
    if (this._locked()) document.exitPointerLock();

    this.input?.dispose();
    this.clip?.dispose();
    this.weather?.dispose();
    for (const peer of this.peers.values()) peer.avatar.dispose();
    this.peers.clear();
    this.avatar?.dispose();
    resetMaterials();
    this.audio?.dispose();
    this.vfx?.dispose();
    this.particles?.dispose();
    this.decals?.dispose();
    this.skyEnv?.dispose();
    this.guns?.dispose();
    this.chalice?.dispose();
    this.shrapnel?.dispose();
    this.weapon?.dispose();
    this.enemies?.dispose();
    this.debris?.dispose();
    for (const s of this.structures ?? []) s.dispose();
    this.terrain?.dispose(this.scene, this.physicsWorld);

    // Free GPU resources explicitly — this SPA holds one live GL context per mounted 3D
    // game and Chrome caps the pool (~16), so a leaked context starves sibling games.
    this.scene?.traverse((obj) => {
      obj.geometry?.dispose();
      if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
    });
    this.renderer?.dispose();
    // dispose() does not hand the context back; see pobrawl/game.js dispose().
    try { this.renderer?.forceContextLoss?.(); } catch { /* context already gone */ }
    this.canvas?.remove();
    this.crosshair?.remove();
    this.hitArc?.remove();
    this.cracks?.remove();
  }

  // ── Frame loop ─────────────────────────────────────────────────────────

  _frame(time) {
    if (!this.running) return;
    // Clamped on BOTH ends: rAF can hand the first callback a timestamp EARLIER than the
    // performance.now() taken in start() (observed ~2.8 s stale in headless Chromium). An
    // unclamped negative dt turns the camera lerp factor 1−e^(−12·dt) negative and the
    // follow diverges exponentially instead of converging.
    const dt = Math.min(Math.max((time - this.lastTime) / 1000, 0), 0.05);
    this.lastTime = time;

    // Paused, or 'ready' behind the start card: render the frozen scene, nothing advances
    // (the clock must not run nor the wall guns fire while the start card is up). Dead: the world keeps moving for the kill-cam beat (debris
    // settles, enemies mill), but the clock and input do not.
    const simulating = this.state !== 'paused' && this.state !== 'ready';
    const playing = this.state === 'playing';

    // Simulation time scale. `dt` stays real time for the camera, the screen effects, the
    // run clock and the lockstep shipper; `sdt` is what the world advances by. Two things
    // bend it: the hit-stop under a big collapse, and the slow beat after the chalice.
    let scale = 1;
    if (this._hitStopT > 0) { this._hitStopT -= dt; scale = HIT_STOP_SCALE; }
    if (this._hitStopCd > 0) this._hitStopCd -= dt;
    if (this.wonAt >= 0 && this.wonAt < VICTORY_SHOW_S) scale = Math.min(scale, VICTORY_TIME_SCALE);
    const sdt = dt * scale;

    const pad = this.input.poll(dt);
    if (!this.demo) this._applyInput(pad);

    if (playing) {
      this.elapsed += dt;
      if (this.demo) this._updateDemo(dt);
      else if (this.downed) this._updateDowned(dt);
      else if (this._controlling()) this._move(dt, pad);
      // Height is the physics body's business now — the mesh is synced from it after the
      // step. The exponential settle onto terrain.heightAt() that used to live here was
      // what made the player float over craters and up two-metre ledges.
    }

    if (simulating) {
      this.physicsAccumulator = Math.min(this.physicsAccumulator + sdt, 0.1);
      while (this.physicsAccumulator >= PHYSICS_STEP) {
        // Swept contacts run BEFORE the step, on the motion the step is about to take.
        this.shrapnel.sweep(PHYSICS_STEP);
        this.physicsWorld.step(PHYSICS_STEP);
        this.physicsAccumulator -= PHYSICS_STEP;
      }
      if (this.playerBody) {
        this.onGround = this._probeGround();
        // Keep the player inside the arena. This is the one hard constraint left on the
        // body: the perimeter wall is terrain and can be dug through, and falling off the
        // edge of the heightfield is not a failure state anyone asked for.
        const b = this.playerBody.position;
        b.x = THREE.MathUtils.clamp(b.x, -ARENA_HALF + 1, ARENA_HALF - 1);
        b.z = THREE.MathUtils.clamp(b.z, -ARENA_HALF + 1, ARENA_HALF - 1);
        this.player.position.set(b.x, b.y - PLAYER_RADIUS + 0.9, b.z);
      }

      this.weapon.update(sdt, this._muzzle());
      // Overheat lockout: sound the vent exactly once, on the rising edge.
      if (this.weapon.locked && !this._prevLocked) this.audio?.lockout();
      this._prevLocked = this.weapon.locked;
      this.debris.update(sdt);
      if (playing) this.enemies.updateSpawning(
        dt, this.elapsed, this.player.position, this.camera.getWorldDirection(new THREE.Vector3()));
      this.enemies.update(sdt, this.player.position);
      this.enemies.checkCrush(this.debris.pieces);
      // Velocity is differenced, not integrated: _move() writes the position directly, so
      // this is the only honest source for the turrets' lead calculation. Differenced
      // over SIM time, the clock the bullets fly on.
      this._playerVel.copy(this.player.position).sub(this._prevPlayerPos)
        .divideScalar(Math.max(sdt, 1e-4));
      this._prevPlayerPos.copy(this.player.position);
      this.guns.update(sdt, this.player.position, this._playerVel);
      this.chalice.update(sdt);
      // Demo runs its own celebrate-and-restart loop (see _updateDemo); ending the run
      // would leave the kiosk sitting on a game-over screen.
      if (playing && !this.demo && !this.downed && this.chalice.reached(this.player.position)) {
        this._claimChalice(false);
      }
      if (playing) this._checkPlayerCrush(sdt);
      // One re-mesh budget shared by the whole fortress. A carve's own chunks always
      // rebuild immediately (a hole must appear on the frame you made it); LOD band
      // changes are lazy and draw from this, so crossing a distance boundary spreads a
      // building's re-mesh over several frames instead of spiking one.
      let remeshBudget = REMESH_CHUNKS_PER_FRAME;
      for (const s of this.structures) {
        s.updateLod(this.camera.position);
        remeshBudget -= s.rebuildDirtyChunks(Math.max(0, remeshBudget));
        s.rebuildCollider(); // no-op unless flagged dirty by a carve
      }
      this.terrain.updateLod(this.camera.position);
      this.terrain.rebuildDirty(Math.max(0, remeshBudget)); // no-op unless a dig landed
      this.terrain.rebuildCollider();
    }

    if (playing) this._updateFeel(dt);
    if (this.wonAt >= 0) this._updateVictory(dt);

    // The figure walks at the speed the body is actually making, not the speed asked for.
    const bv = this.playerBody.velocity;
    this._firedT = Math.max(0, (this._firedT ?? 0) - dt);
    this.avatar.update(sdt, simulating ? Math.hypot(bv.x, bv.z) : 0, this._firedT > 0, this.weapon.heat);

    this._followCamera(dt);
    this.vfx.setHeat(this.weapon.heat);
    this.vfx.update(dt);
    tickMaterials(this.vfx.time);
    this.vfx.applyShake(); // AFTER lookAt so the shake never fights the follow lerp
    this.particles.update(sdt);
    this.decals.update(dt);
    this.shrapnel.update(sdt);
    this._updateSpace(dt);
    this.weather.update(dt, this.camera.position, this.indoors);
    this._updateShadowCamera();
    this._streamColliders(dt);
    this._updateRenderScale(dt);
    this.skyEnv.update(dt, this.vfx.skyKey, this.vfx._sunDir);
    if (this.audio) {
      // The listener must follow the SHAKEN camera: the shake is what the player sees,
      // so it is also what the player should hear.
      this.camera.updateMatrixWorld();
      this.audio.setListener(this.camera);
    }

    this.hudClock -= dt;
    if (this.hudClock <= 0 && (this.state === 'playing' || this.state === 'paused')) {
      this.hudClock = HUD_INTERVAL_S;
      this._pumpHud();
    }

    // Drift-corrected 50 ms lockstep tick. Drains any
    // accumulated time so a stutter frame doesn't double-ship a batch; an idle frame
    // catches up. The server is the source of truth for the tick number — we ship a
    // monotonic local counter purely so the wrapper knows which tick each batch belongs
    // to if it wants to surface it in dev consoles.
    if (this.mode === 'multi' && this.multiplayerSink) {
      this._lockstepClock += dt * 1000;
      while (this._lockstepClock >= this._lockstepIntervalMs) {
        this._lockstepClock -= this._lockstepIntervalMs;
        this._shipLockstepBatch();
      }
      this._updatePeers(dt);
    }

    this.vfx.render();
    this.rafId = requestAnimationFrame((t) => this._frame(t));
  }

  // ── Online ──

  /** One lockstep batch: this tick's held movement keys, aim, and where this player is. */
  _shipLockstepBatch() {
    const p = this.player?.position;
    if (!p || this.state === 'dead') return;
    const k = this.keys;
    const batch = {
      connectionId: '',
      playerNumber: this.multiplayerPlayerNumber,
      tick: ++this._lockstepTick,
      inputs: [{
        forward: k.has('KeyW') || k.has('ArrowUp'),
        back: k.has('KeyS') || k.has('ArrowDown'),
        left: k.has('KeyA') || k.has('ArrowLeft'),
        right: k.has('KeyD') || k.has('ArrowRight'),
        // Cosmetic on the far side (the squadmate's gun kicks); the carve itself travels
        // as its own message, because a batch is latest-wins and a hole must not be.
        fire: this.weapon.primaryHeld && !this.weapon.locked,
        altFire: false,
        yaw: THREE.MathUtils.radToDeg(this.yaw),
        pitch: THREE.MathUtils.radToDeg(this.pitch),
        x: p.x, y: p.y, z: p.z,
        down: this.downed,
      }],
    };
    try { this.multiplayerSink(batch); } catch { /* the page reports a dead hub itself */ }
  }

  /** A squadmate's carve, relayed by the hub: replay it on this client's copy of the arena. */
  applyCarve(playerNumber, kind, structureIndex, x, y, z) {
    if (this.mode !== 'multi' || this.disposed || !this.weapon) return;
    const peer = this.peers.get(playerNumber);
    const from = peer ? peer.avatar.group.position.clone().setY(peer.avatar.group.position.y + 0.7) : null;
    this.weapon.applyRemote(kind, structureIndex, new THREE.Vector3(x, y, z), from);
  }

  /** A squadmate took the chalice: this player wins too, on their own stats. */
  squadWin() {
    if (this.mode !== 'multi' || this.disposed || this.state !== 'playing') return;
    this.chalice.taken = true;
    this._claimChalice(true);
  }

  /** Squadmates who could still walk over and revive someone. */
  _livePeers() {
    let n = 0;
    const now = performance.now();
    for (const peer of this.peers.values()) {
      if (!peer.down && now - peer.seenAt < PEER_LIVE_S * 1000) n++;
    }
    return n;
  }

  /**
   * 0 HP with a squadmate still standing: down, not dead. The guns stop mattering
   * (_damagePlayer ignores a downed player), the HUD shows the revive, and the run ends
   * here only if nobody comes — a squadmate holding within REVIVE_RADIUS for REVIVE_S
   * stands the player back up on REVIVE_HP. Each client decides its own revive from the
   * positions it is sent; there is no server referee, the same as everything else online.
   */
  _goDown() {
    this.downed = true;
    this.hp = 0;
    this.reviveT = 0;
    this.bleedT = 0;
    this.weapon.setPrimaryHeld(false);
    this.avatar.setDown(true);
    const v = this.playerBody.velocity;
    v.x = v.z = 0;
    this.audio?.playerHit();
    this._pumpHud();
  }

  _updateDowned(dt) {
    const v = this.playerBody.velocity;
    v.x = v.z = 0;
    let helper = false;
    const now = performance.now();
    for (const peer of this.peers.values()) {
      if (peer.down || now - peer.seenAt > PEER_LIVE_S * 1000) continue;
      if (peer.avatar.group.position.distanceTo(this.player.position) <= REVIVE_RADIUS) { helper = true; break; }
    }
    this.reviveT = helper ? this.reviveT + dt : Math.max(0, this.reviveT - dt * 2);
    this.bleedT += dt;
    if (this.reviveT >= REVIVE_S) {
      this.downed = false;
      this.hp = REVIVE_HP;
      this.avatar.setDown(false);
      this._showCracks();
      return;
    }
    // Nobody left who could come, or nobody came.
    if (this._livePeers() === 0 || this.bleedT >= BLEED_OUT_S) this._die();
  }

  /** A relayed frame: every peer's latest batch. Ours is skipped; the rest move their avatars. */
  applyLockstepFrame(frame) {
    if (this.mode !== 'multi' || this.disposed || !frame || !Array.isArray(frame.batches)) return;
    for (const b of frame.batches) {
      if (!b || b.playerNumber === this.multiplayerPlayerNumber) continue;
      const input = Array.isArray(b.inputs) && b.inputs.length ? b.inputs[b.inputs.length - 1] : null;
      if (!input) continue;
      let peer = this.peers.get(b.playerNumber);
      if (!peer) peer = this._spawnPeer(b.playerNumber, input);
      peer.target.set(input.x || 0, input.y || 0, input.z || 0);
      peer.yaw = THREE.MathUtils.degToRad(input.yaw || 0);
      peer.firing = !!input.fire;
      peer.down = !!input.down;
      peer.seenAt = performance.now();
    }
  }

  _spawnPeer(playerNumber, input) {
    const avatar = new Avatar(PEER_COLORS[(playerNumber - 1) % PEER_COLORS.length]);
    avatar.setName(this.peerNames[playerNumber] || `P${playerNumber}`);
    avatar.group.position.set(input.x || 0, input.y || 0, input.z || 0);
    this.scene.add(avatar.group);
    const peer = {
      avatar, target: avatar.group.position.clone(), yaw: 0,
      seenAt: performance.now(), down: false, firing: false,
    };
    this.peers.set(playerNumber, peer);
    return peer;
  }

  _updatePeers(dt) {
    if (!this.peers.size) return;
    const k = Math.min(1, dt * 12);
    const now = performance.now();
    for (const [n, peer] of this.peers) {
      const at = peer.avatar.group.position;
      const before = this._peerVec ??= new THREE.Vector3();
      before.copy(at);
      at.lerp(peer.target, k);
      peer.avatar.group.rotation.y = peer.yaw;
      // Walk cycle from the distance the avatar was actually moved this frame.
      const speed = Math.hypot(at.x - before.x, at.z - before.z) / Math.max(dt, 1e-4);
      peer.avatar.setDown(peer.down);
      peer.avatar.update(dt, speed, peer.firing, 0);
      if (now - peer.seenAt > PEER_STALE_S * 1000) {
        peer.avatar.dispose();
        this.peers.delete(n);
      }
    }
  }

  /**
   * A pad or touch frame, folded into the same switches the keyboard and mouse throw.
   * Held fire is recomputed here every frame from all three sources, so no device has to
   * remember to release it for another.
   */
  _applyInput(pad) {
    // A pad button on the start card or the pause dialog is a way in: free control.
    if ((this.state === 'ready' || this.state === 'paused') && pad.any) { this.enter(true); return; }
    if (this.state !== 'playing' || !this._controlling()) { this.weapon.setPrimaryHeld(false); return; }
    if (pad.pause) { this.pause(); return; }
    if (pad.lookX || pad.lookY) this._look(pad.lookX, pad.lookY);
    this.weapon.setPrimaryHeld(!this.downed && (this._fireMouse || this.keys.has('KeyF') || pad.fire));
    if (pad.alt && !this.downed) this.weapon.fireAlt(this._muzzle());
    if (pad.jump) this._jumpQueued = true;
  }

  /**
   * The feel layer: everything in here is picture or sound, never simulation. Runs on
   * real time while the run is live.
   */
  _updateFeel(dt) {
    // Overheated: the barrel vents steam for as long as the lockout lasts.
    if (this.weapon.locked) {
      this._steamClock -= dt;
      if (this._steamClock <= 0) {
        this._steamClock = 0.09;
        this.particles.emit(this._muzzle(), 3, {
          color: 0xdfe6ee, speed: 1.3, spread: 0.25, size: 0.5, life: 0.9, upward: 1.7,
        });
      }
    }

    // Nearly dead: colour drains, the mix goes dull, a heartbeat that quickens as HP falls.
    const low = !this.demo && this.hp > 0 && this.hp <= LOW_HP;
    this.vfx.setDesat(low ? 0.25 + 0.45 * (1 - this.hp / LOW_HP) : 0);
    this.audio?.setLowHp(low);
    if (low) {
      this._heartClock -= dt;
      if (this._heartClock <= 0) {
        this._heartClock = 0.55 + 0.4 * (this.hp / LOW_HP);
        this.audio?.heartbeat();
      }
    }

    // Footsteps: one per stride of ground actually covered, voiced by what is underfoot.
    if (this.onGround && !this.downed && this.audio) {
      const b = this.playerBody;
      this._stride += Math.hypot(b.velocity.x, b.velocity.z) * dt;
      if (this._stride >= STRIDE_M) {
        this._stride = 0;
        // Standing clear above the terrain surface means masonry or rubble is underfoot.
        const feet = b.position.y - PLAYER_RADIUS;
        const turf = feet - this.terrain.heightAt(b.position.x, b.position.z) < 0.4;
        this.audio.footstep(turf ? 'grass' : 'stone');
      }
    }

    if (this.audio) this._updateAudioAmbience(dt);
  }

  /** The win beat: a gold fountain off the plinth while the camera circles the keep. */
  _updateVictory(dt) {
    this.wonAt += dt;
    if (this.wonAt > VICTORY_SHOW_S + 1) return;
    this._fountainT = (this._fountainT ?? 0) - dt;
    if (this._fountainT > 0) return;
    this._fountainT = 0.2;
    this.particles.emit(this.chalice.position, 30, {
      color: 0xffd05a, speed: 9, spread: 1.2, size: 0.7, life: 2.4, upward: 2.2,
    });
  }

  /**
   * A fall big enough to stop the clock for: a few frames of hit-stop, the sub dropping
   * out, a dust front racing along the ground, and — if it beats the run's best — the clip.
   * One collapse arrives as many clusters, so the stop is rate-limited rather than stacked.
   */
  _bigCollapse(voxels, position, proximity) {
    this.clip?.trigger(voxels);
    this.vfx.groundRing(position, this.terrain.heightAt(position.x, position.z));
    if (proximity <= 0.15 || this._hitStopCd > 0) return;
    this._hitStopCd = 1.5;
    this.audio?.subDrop(position, Math.min(1, voxels / 900) * proximity);
    if (!this.q.reducedMotion) this._hitStopT = HIT_STOP_S;
  }

  /** Enemy presence cues + music tension, on their own slow clocks. */
  _updateAudioAmbience(dt) {
    this._tensionClock -= dt;
    if (this._tensionClock <= 0) {
      this._tensionClock = 1;
      // How deep into the fortress, and how many guns have had a line on the player
      // lately. The rings are squares, so "depth" is the larger of |x| and |z|.
      const p = this.player.position;
      const reach = Math.max(Math.abs(p.x), Math.abs(p.z));
      const depth = reach < KEEP_HALF ? 0.75 : reach < INNER_HALF ? 0.5 : reach < OUTER_HALF ? 0.3 : 0.1;
      this.audio.setTension(depth + Math.min(0.3, this.guns.sightedCount * 0.06)
        + (this.hp <= LOW_HP ? 0.15 : 0) + this.enemies.count / 40);
    }

    this._cueClock -= dt;
    if (this._cueClock > 0 || this.enemies.enemies.length === 0) return;
    this._cueClock = 0.8 + Math.random() * 0.6;
    // One cue per tick, from a random nearby enemy — a crowd murmurs, it doesn't roll-call.
    const pool = this.enemies.enemies;
    const e = pool[(Math.random() * pool.length) | 0];
    const d = e.mesh.position.distanceTo(this.player.position);
    if (d > 50) return;
    this.audio.enemyCue(e.type, this._panFor(e.mesh.position), Math.max(0.1, 1 - d / 50));
  }

  /** Stereo pan (−1..1) of a world position relative to the camera. */
  /**
   * Reverb zone probe. Throttled to 4 Hz: it walks every structure, and the answer only
   * has to beat the 250 ms crossfade in setSpace() to feel instant.
   */
  /**
   * Keep the sun's shadow box centred just ahead of the player. A directional light's
   * shadow camera is an orthographic box: making it cover the arena means every texel is
   * 6-13 cm and every wall in the fortress is rasterised into it every frame. A 90 m box
   * that travels with the player renders a handful of buildings at a much finer texel.
   */
  _updateShadowCamera() {
    if (!this.sun?.castShadow) return;
    const p = this.player.position;
    // Snap to texel-sized steps. Without this the whole shadow map shimmers as the box
    // slides, because every texel lands on different geometry each frame.
    const texel = (SHADOW_HALF_M * 2) / this.q.shadowMapSize;
    const cx = Math.round(p.x / texel) * texel;
    const cz = Math.round(p.z / texel) * texel;
    this.sun.position.set(cx + this.vfx._sunDir.x * 120,
      p.y + this.vfx._sunDir.y * 120, cz + this.vfx._sunDir.z * 120);
    this.sun.target.position.set(cx, p.y, cz);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /**
   * Add and remove static collider bodies by distance. The fortress puts ~7 700 collision
   * shapes in the world; the broadphase sorts and the narrowphase bounding-sphere-tests
   * all of them forever, even the far side of the keep that nothing can reach. Streaming
   * keeps only what is near the player resident. Accuracy is untouched — a body is either
   * fully present or too far away to be touched.
   */
  _streamColliders(dt) {
    this._streamClock = (this._streamClock ?? 0) - dt;
    if (this._streamClock > 0) return;
    this._streamClock = PHYSICS_STREAM_INTERVAL_S;
    const p = this.player.position;
    for (const s of this.structures) {
      const dx = s.group.position.x - p.x;
      const dz = s.group.position.z - p.z;
      // Reach includes the piece's own extent: a 116 m curtain wall is "near" long before
      // its centre is.
      const reach = PHYSICS_STREAM_RADIUS_M + Math.max(s.dims[0], s.dims[2]) * s.scale * 0.5;
      s.setColliderActive(dx * dx + dz * dz <= reach * reach);
    }
  }

  /**
   * Dynamic resolution. Every post-processing pass costs per pixel, so when frames run
   * long the cheapest lever is to render fewer of them and let SMAA clean up the edges.
   * Physics and simulation are untouched — this only changes how many pixels are shaded.
   */
  _updateRenderScale(dt) {
    if (!this.q.dynamicResolution) return;
    this._frameAvg = this._frameAvg === undefined ? dt : this._frameAvg * 0.9 + dt * 0.1;
    this._scaleClock = (this._scaleClock ?? 0) - dt;
    if (this._scaleClock > 0) return;
    this._scaleClock = 0.5;

    const target = 1 / 60;
    let scale = this._renderScale ?? 1;
    if (this._frameAvg > target * 1.35) scale -= 0.1;
    else if (this._frameAvg < target * 1.05) scale += 0.05;
    scale = Math.min(1, Math.max(MIN_RENDER_SCALE, scale));
    if (Math.abs(scale - (this._renderScale ?? 1)) < 0.01) return;
    this._renderScale = scale;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * scale);
    this._resize();
  }

  _updateSpace(dt) {
    this._spaceClock -= dt;
    if (this._spaceClock > 0) return;
    this._spaceClock = 0.25;
    const head = this._headVec ??= new THREE.Vector3();
    head.copy(this.player.position);
    let indoors = 0;
    for (const s of this.structures) {
      // Cheap reject first: outside the building's own radius it cannot enclose anyone.
      const reach = Math.max(s.dims[0], s.dims[2]) * s.scale * 0.75;
      if (head.distanceToSquared(s.group.position) > reach * reach) continue;
      indoors = Math.max(indoors, s.indoorAt(head));
      if (indoors >= 1) break;
    }
    // Three listeners: the reverb, the rain bed, and (via this.indoors) the rain itself,
    // which must not fall through a roof.
    this.indoors = indoors;
    this.audio?.setSpace(indoors);
    this.audio?.setRain(this.weather.wet && this.state === 'playing' ? 1 : 0, indoors);
  }

  /**
   * Best-guess surface normal at a contact point, for orienting a decal. Sampling the
   * terrain height on a small cross is exact for the stepped heightfield and good enough
   * on a wall, where the gradient saturates and the mark ends up near-vertical.
   */
  _surfaceNormal(point) {
    const n = this._normVec ??= new THREE.Vector3();
    const e = 0.6;
    const hL = this.terrain.heightAt(point.x - e, point.z);
    const hR = this.terrain.heightAt(point.x + e, point.z);
    const hD = this.terrain.heightAt(point.x, point.z - e);
    const hU = this.terrain.heightAt(point.x, point.z + e);
    return n.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  _panFor(position) {
    const v = this._panVec ??= new THREE.Vector3();
    const right = this._panRight ??= new THREE.Vector3();
    v.copy(position).sub(this.camera.position);
    right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    const len = v.length() || 1;
    return THREE.MathUtils.clamp(v.dot(right) / len, -1, 1);
  }

  _pumpHud() {
    // Crosshair rings track the same snapshot cadence; the CSS transition smooths the
    // 10 Hz steps into a continuous sweep.
    if (this.ringHeat) {
      this.ringHeat.style.setProperty('--p', Math.round(this.weapon.heat * 100));
      this.ringHeat.classList.toggle('pvs-ring-locked', this.weapon.locked);
      const altPct = Math.round((1 - this.weapon.altReadyIn / this.weapon.altCooldownTotal) * 100);
      this.ringAlt.style.setProperty('--p', altPct);
      this.ringAlt.classList.toggle('pvs-ring-ready', altPct >= 100);
    }

    // Flat positional primitives by design — see the interop note at the top. Heat and
    // blast are deliberately absent: the rings above are their only readout now.
    this._notify('OnHudTick',
      Math.max(0, Math.round(this.hp)),
      this._score(),
      Math.round(this.elapsed),
      this.kills,
      this.guns.turrets.length - this.guns.liveCount,
      this.guns.turrets.length,
      this.downed,
      Math.round(Math.min(1, this.reviveT / REVIVE_S) * 100));
  }

  /** The end-of-run payload, shared by the loss and the win. Order is the interop contract. */
  _runStats(score) {
    return [
      score, Math.round(this.elapsed * 10) / 10,
      this.kills, this.bruteKills, this.crushKills, this.voxelsDestroyed,
      this.seed.toString(16).padStart(8, '0'),
      this.guns.turrets.length - this.guns.liveCount, this.guns.turrets.length,
      Math.round(this.damageTaken),
    ];
  }

  _score() {
    return Math.floor(this.elapsed) * 10 + this.kills * 25 + this.bruteKills * 50
      + this.crushKills * 40 + Math.floor(this.voxelsDestroyed / 20);
  }

  /**
   * The chalice is in hand: the run ends in a win. Deliberately shares the teardown with
   * death (same pointer-lock release, same HUD pump) so there is one end-of-run path and
   * only the notification differs.
   */
  /** @param relayed true when a squadmate took it — do not announce it to the squad again. */
  _claimChalice(relayed) {
    this.state = 'dead';
    this.won = true;
    this.wonAt = 0;            // starts the victory beat: slow time, orbit camera, fountain
    this.downed = false;
    this.avatar.setDown(false);
    this.chalice.celebrate();
    this.audio?.explosion(this.chalice.position, 0.6);
    this.audio?.fanfare();
    this.audio?.setLowHp(false);
    this.vfx.setDesat(0);
    this.cracks.style.opacity = '0';   // the visor is whole again for the victory lap
    this.vfx.addShake(0.6);
    this.vfx.shockwave(this.chalice.position);
    this.particles.emit(this.chalice.position, 120, {
      color: 0xffd05a, speed: 8, spread: 1.5, size: 0.7, life: 2.2, upward: 1.6,
    });
    this._endControl();
    this._pumpHud();
    if (!relayed) this.winSink?.();
    // The bonus is priced on the same rounded seconds the submission carries, so the
    // server's WinBonus(survivalSeconds) lands on the identical number.
    const seconds = Math.round(this.elapsed * 10) / 10;
    this._notify('OnVictory', ...this._runStats(this._score() + winBonus(seconds)));
  }

  /** The run is over either way: let go of the gun, the lock and the on-screen controls. */
  _endControl() {
    this.weapon.setPrimaryHeld(false);
    this._fireMouse = false;
    this.free = false;
    this.input.setActive(false);
    this.crosshair.style.display = 'none';
    if (this._locked()) document.exitPointerLock();
  }

  /**
   * Put the player in the physics world.
   *
   * They used to be outside it entirely: position was written directly, the ground was a
   * height lookup with a 2.2 m auto-step, and walls were a hand-rolled probe of five
   * points at three heights. That could not be pushed, buried, knocked down a slope or
   * hit by a falling wall, and it walked up two-metre ledges.
   *
   * Now: a sphere body with rotation locked, driven by setting horizontal velocity while
   * gravity and contacts do the rest. Friction against the world is zero by design (see
   * the contact table in physics.js) so the player never sticks to a wall; braking is
   * done by writing velocity, which is what every responsive FPS controller does.
   */
  _buildPlayerBody() {
    const p = this.player.position;
    this.playerBody = new CANNON.Body({
      mass: PLAYER_MASS,
      shape: new CANNON.Sphere(PLAYER_RADIUS),
      position: new CANNON.Vec3(p.x, p.y + PLAYER_RADIUS, p.z),
      material: this.physicsMaterials.player,
      linearDamping: 0.0,
      angularDamping: 1.0,
      allowSleep: false,
      collisionFilterGroup: PLAYER_GROUP,
      collisionFilterMask: WORLD_GROUP | PLAYER_GROUP,
    });
    this.playerBody.fixedRotation = true;   // no tumbling; the camera owns orientation
    this.playerBody.updateMassProperties();
    this.physicsWorld.addBody(this.playerBody);
    this._groundRay = { from: new CANNON.Vec3(), to: new CANNON.Vec3() };
    this.onGround = false;
  }

  /**
   * Is there world within GROUND_PROBE below the player? Uses the physics world's own
   * raycast, so it sees the terrain heightfield, the fortress colliders AND the rubble —
   * standing on a pile of your own debris counts as standing on something.
   */
  _probeGround() {
    if (!this.playerBody) return false;
    const b = this.playerBody.position;
    this._groundRay.from.set(b.x, b.y, b.z);
    this._groundRay.to.set(b.x, b.y - GROUND_PROBE, b.z);
    const result = this._rayResult ??= new CANNON.RaycastResult();
    result.reset();
    // The ray starts at the body's own centre, so without a filter it can hit the player
    // sphere first and report "airborne" while standing still. Filtering by group is the
    // fix; treating a self-hit as not-grounded (the first attempt) meant the step assist
    // never ran and ground movement permanently used the sluggish in-air control factor.
    this.physicsWorld.raycastClosest(this._groundRay.from, this._groundRay.to,
      { skipBackfaces: true, collisionFilterMask: WORLD_GROUP }, result);
    return result.hasHit;
  }

  /** @param from world position of whatever did it (a wall gun), for the HUD's hit arc */
  _damagePlayer(amount, from = null) {
    if (this.demo || this.state !== 'playing' || this.downed) return;
    this.hp -= amount;
    this.damageTaken += amount;
    this.audio?.playerHit();
    this.vfx.flashDamage(Math.min(0.7, 0.2 + amount / 30));
    this.vfx.addShake(Math.min(0.5, amount / 45));
    if (from) this._showHitArc(from);
    this._showCracks();
    if (this.hp > 0) return;
    this.hp = 0;
    // Online, with someone still standing: down and waiting, not out.
    if (this.mode === 'multi' && this._livePeers() > 0) this._goDown();
    else this._die();
  }

  _die() {
    this.hp = 0;
    this.downed = false;
    this.state = 'dead';
    this.audio?.death();
    this.vfx.setDesat(0.8);
    this.vfx.addShake(0.8);
    this._endControl();
    this._pumpHud();
    this._notify('OnGameOver', ...this._runStats(this._score()));
  }

  /**
   * Point at what hit you: an arc on the reticle, turned to the attacker's bearing
   * relative to where the camera is looking. The CSS animation is the fade; restarting it
   * (remove class, reflow, add class) is how a second hit re-flashes an arc already shown.
   */
  _showHitArc(from) {
    const p = this.player.position;
    // Bearing of the source in the camera's ground frame; forward is (−sin yaw, −cos yaw).
    const bearing = Math.atan2(from.x - p.x, -(from.z - p.z)) + this.yaw;
    this.hitArc.style.setProperty('--bearing', `${THREE.MathUtils.radToDeg(bearing).toFixed(0)}deg`);
    this.hitArc.classList.remove('pvs-hit-arc-on');
    void this.hitArc.offsetWidth;
    this.hitArc.classList.add('pvs-hit-arc-on');
  }

  /** The visor cracks as HP falls below 60, and stays cracked until the run ends. */
  _showCracks() {
    this.cracks.style.opacity = (THREE.MathUtils.clamp((60 - this.hp) / 60, 0, 1) * 0.85).toFixed(2);
  }

  /** The debris is impartial — the player half of the crush check. */
  _checkPlayerCrush(dt) {
    for (const piece of this.debris.pieces) {
      if (piece.frozen) continue;
      if (piece.crushCd > 0) { piece.crushCd -= dt; continue; }
      const speed = piece.body.velocity.length();
      if (speed < PLAYER_CRUSH_MIN_SPEED) continue;
      const reach = Math.max(piece.dims[0], piece.dims[1], piece.dims[2]) * piece.scale * 0.5;
      const d = this.player.position.distanceTo(
        new THREE.Vector3(piece.body.position.x, piece.body.position.y, piece.body.position.z));
      if (d < reach + 0.7) {
        piece.crushCd = 0.6;
        this.audio?.crush(0);
        // Momentum, rescaled for REAL masses. The old coefficient was tuned when debris
        // weighed 1% of what it should, so once physics.js fixed the units every pebble
        // hit the 50-damage cap and a single collapse was instant death. Now a 300 kg
        // chunk at 8 m/s does about 29, and a falling tower section still kills you.
        const momentum = piece.body.mass * speed;   // kg m/s
        this._damagePlayer(Math.min(60, Math.max(2, momentum * 0.012)));
      }
    }
  }

  _muzzle() {
    return new THREE.Vector3(
      this.player.position.x, this.player.position.y + 0.7, this.player.position.z);
  }

  // ── Demo autopilot (kiosk attract mode) ───────
  // Wanders the arena, picks something nearby — an enemy, a building, or a patch of
  // ground — and digs/shoots at it in bursts, with the occasional blast ball. Shots aim
  // through weapon.aimOverride since the kiosk has no mouse.

  /**
   * Kiosk siege AI.
   *
   * The demo used to amble to random points and shoot whatever happened to be nearby,
   * which showed off the destruction but not the GAME. It now plays the actual objective:
   * march on the keep, blast a way through whatever stands between it and the chalice,
   * and go inside. Losing does not apply — when it reaches the prize it celebrates and
   * starts a fresh assault, so the attract loop never ends on a dead screen.
   *
   * There is no pathfinding, deliberately. The bot walks the straight line to the chalice
   * and treats anything on that line as a wall to be removed, because that IS the game:
   * the fortress has no route in that does not go through masonry. When it stops making
   * progress it sidesteps, and if that fails too it blasts the obstruction.
   */
  _updateDemo(dt) {
    const st = this.demoState ??= {
      phase: 'advance',       // 'advance' | 'breach' | 'triumph'
      aim: null,
      burstT: 1.2, firing: false, altT: 2,
      strafe: 0, strafeT: 0,
      stuckT: 0, lastX: 0, lastZ: 0, progressT: 0,
      triumphT: 0,
    };
    const p = this.player.position;
    const goal = this.chalice.position;

    if (st.phase === 'triumph') {
      // Stand in the vault for a beat, then re-arm and walk back out to do it again.
      st.triumphT -= dt;
      this.weapon.setPrimaryHeld(false);
      this.weapon.aimOverride = null;
      if (st.triumphT <= 0) this._restartDemoSiege();
      return;
    }

    // ── Where am I going, and what is in the way? ──────────────────────────
    const toGoal = this._demoVec ??= new THREE.Vector3();
    toGoal.set(goal.x - p.x, 0, goal.z - p.z);
    const distance = toGoal.length();
    if (distance > 0.001) toGoal.divideScalar(distance);

    // Probe straight ahead at chest height. Whatever it hits first is the obstacle; if it
    // hits nothing within the probe, the way is clear and the bot just walks.
    const muzzle = this._muzzle();
    const eye = this._demoEye ??= new THREE.Vector3();
    eye.copy(muzzle);
    const obstacle = this._demoObstacle(eye, toGoal, DEMO_PROBE_RANGE);

    // ── Aim ───────────────────────────────────────────────────────────────
    // At the obstruction when there is one, otherwise at the chalice itself, which keeps
    // the camera pointed at the objective and makes the attract loop legible.
    //
    // `forced` is the backstop for the case the rays cannot see: if the bot has stopped
    // gaining ground it digs straight ahead regardless of what the probe thinks. Progress
    // is the ground truth here, not the raycast.
    const forced = st.stuckT >= 1 && !obstacle;
    if (forced) {
      const ahead = this._demoForce ??= new THREE.Vector3();
      ahead.copy(toGoal).multiplyScalar(DEMO_FORCE_DISTANCE).add(eye);
      st.aim = ahead;
    } else {
      st.aim = obstacle ? obstacle.point : goal;
    }
    st.phase = (obstacle || forced) ? 'breach' : 'advance';

    const toA = this._demoAim ??= new THREE.Vector3();
    toA.subVectors(st.aim, muzzle);
    const targetYaw = Math.atan2(-toA.x, -toA.z);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += dy * Math.min(1, 5 * dt);
    this.player.rotation.y = this.yaw;
    this.weapon.aimOverride = { origin: muzzle, direction: toA.clone().normalize() };

    // ── Move ──────────────────────────────────────────────────────────────
    // Advance while the way is clear, and while breaching keep pressing forward so the
    // bot walks through the hole the instant it opens. A slow oscillating sidestep stops
    // it grinding a corner forever.
    st.strafeT -= dt;
    if (st.strafeT <= 0) {
      st.strafeT = 1.6 + Math.random() * 1.4;
      st.strafe = (Math.random() * 2 - 1) * 0.55;
    }
    const speed = st.phase === 'breach' ? WALK_SPEED * 0.35 : WALK_SPEED * 0.8;
    const wishX = (toGoal.x + -toGoal.z * st.strafe) * speed;
    const wishZ = (toGoal.z + toGoal.x * st.strafe) * speed;
    const v = this.playerBody.velocity;
    const control = this.onGround ? 1 : 0.18;
    v.x += (wishX - v.x) * control;
    v.z += (wishZ - v.z) * control;
    this._stepUp(wishX, wishZ);

    // ── Stuck detection ───────────────────────────────────────────────────
    // Measured over a second of real movement, not per frame: a bot pressed against a
    // wall it is actively demolishing is not stuck, it is working.
    st.progressT += dt;
    if (st.progressT >= 1) {
      const moved = Math.hypot(p.x - st.lastX, p.z - st.lastZ);
      st.lastX = p.x; st.lastZ = p.z;
      st.progressT = 0;
      st.stuckT = moved < 1.2 ? st.stuckT + 1 : 0;
      if (st.stuckT === 1) st.altT = 0;   // first stalled second: blast now, not in four
      if (st.stuckT >= 3) {
        // Three seconds without ground gained: sidestep as well, in case the bot is
        // grinding a corner that digging straight ahead will never clear.
        st.strafe = (Math.random() < 0.5 ? -1 : 1) * 0.9;
        st.strafeT = 2.5;
      }
    }

    // ── Fire ──────────────────────────────────────────────────────────────
    // Dig continuously while breaching, in bursts otherwise. The blast ball goes on a
    // cooldown and is spent on whatever is blocking the path -- never on open air, which
    // is what the old random-target version did most of the time.
    st.burstT -= dt;
    if (st.burstT <= 0) {
      st.firing = !st.firing;
      st.burstT = st.firing ? 1.4 + Math.random() : 0.5 + Math.random() * 0.8;
    }
    this.weapon.setPrimaryHeld(st.phase === 'breach' ? true : st.firing);
    st.altT -= dt;
    const worthBlasting = (obstacle && obstacle.distance < DEMO_BLAST_RANGE) || forced;
    if (st.altT <= 0 && worthBlasting) {
      st.altT = DEMO_BLAST_COOLDOWN_S;
      this.weapon.fireAlt(muzzle);
    }

    // ── Win ───────────────────────────────────────────────────────────────
    if (distance < DEMO_REACH_RADIUS && Math.abs(p.y - goal.y) < 6) {
      st.phase = 'triumph';
      st.triumphT = DEMO_TRIUMPH_S;
      this.weapon.setPrimaryHeld(false);
      this.audio?.explosion(goal, 1);
      this.vfx.addShake(0.6);
      this.vfx.shockwave(goal);
      this.particles.emit(goal, 140, {
        color: 0xffd05a, speed: 9, spread: 1.6, size: 0.75, life: 2.4, upward: 1.7,
      });
    }
  }

  /**
   * First structure surface on the ray, or null. Only structures are probed: terrain in
   * the way is a slope the bot walks up, not something it needs to shoot through, and
   * treating every hillside as an obstruction had it digging craters in the approach
   * instead of getting on with the assault.
   */
  _demoObstacle(origin, direction, range) {
    // THREE rays, not one: chest, knee and head. A single chest-height ray threads a
    // doorway or an arrow slit and reports "clear" while the bot's body is hard against
    // the jamb beside it — which is exactly how it spent 85 seconds parked 10 m from the
    // chalice with a clear line of sight to it.
    const probe = this._demoProbe ??= new THREE.Vector3();
    let best = null;
    for (const dy of [0, -0.9, 0.7]) {
      probe.set(origin.x, origin.y + dy, origin.z);
      for (const s of this.structures) {
        const hit = s.raycast(probe, direction, range);
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
    }
    return best;
  }

  /** Reset the attract loop: chalice back on its plinth, bot back outside the walls. */
  _restartDemoSiege() {
    this.chalice.taken = false;
    this.chalice.group.visible = true;
    const s = this.spawnPoint;
    this.playerBody.position.set(s.x, s.y + PLAYER_RADIUS, s.z);
    this.playerBody.velocity.set(0, 0, 0);
    this.demoState.phase = 'advance';
    this.demoState.stuckT = 0;
    this.demoState.progressT = 0;
    this.demoState.lastX = s.x;
    this.demoState.lastZ = s.z;
  }

  /** @param pad this frame's AltInput record: its stick adds to the keys, analogue. */
  _move(dt, pad) {
    let fwd = pad.moveY, strafe = pad.moveX;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;
    this.player.rotation.y = this.yaw;

    // Jump: an impulse on the body, so gravity and the solver own the arc and the landing.
    this._jumpCd -= dt;
    if (this._jumpQueued && this.onGround && this._jumpCd <= 0) {
      this.playerBody.velocity.y = JUMP_SPEED;
      this._jumpCd = JUMP_COOLDOWN_S;
    }
    this._jumpQueued = false;

    const v = this.playerBody.velocity;
    // A stick is analogue (a half push is a half-speed walk); keys are all-or-nothing and
    // a diagonal must not be faster than a straight line, so the length is capped at 1.
    const len = Math.hypot(fwd, strafe);
    if (len < 0.05) {
      // Nothing held: stop. The body is frictionless against the world by design (see
      // physics.js), so returning here without zeroing would leave the last commanded
      // velocity in place after the keys are released and the player would slide on forever.
      if (this.onGround) { v.x = 0; v.z = 0; }
      return;
    }
    // Shift runs; so does a stick pushed to the stop.
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || Math.hypot(pad.moveX, pad.moveY) > 0.92;
    const speed = (run ? RUN_SPEED : WALK_SPEED) * Math.min(1, len);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Move in the camera's ground frame: forward is where the camera looks on XZ.
    const wishX = (fwd * -sin + strafe * cos) / len * speed;
    const wishZ = (fwd * -cos + strafe * -sin) / len * speed;

    // Horizontal velocity is COMMANDED, vertical is left to gravity and contacts. That
    // split is what keeps the controls crisp while still letting the world push back:
    // walls stop you because the solver says so, not because a probe vetoed the move.
    // In the air the player keeps most of their momentum — you cannot turn on a sixpence
    // mid-fall — while on the ground the command wins outright.
    const control = this.onGround ? 1 : 0.18;
    v.x += (wishX - v.x) * control;
    v.z += (wishZ - v.z) * control;
    this._stepUp(wishX, wishZ);
  }

  /**
   * Step assist. A sphere resting on the ground cannot climb a sharp 0.4 m voxel ledge —
   * it just presses into the face — so a short forward probe at ankle height looks for a
   * step whose top is within STEP_HEIGHT and lifts the body onto it. Anything taller is a
   * wall, and a wall is supposed to stop you: that is the entire premise of the siege.
   */
  _stepUp(wishX, wishZ) {
    if (!this.onGround) return;
    const speed = Math.hypot(wishX, wishZ);
    if (speed < 0.1) return;
    const b = this.playerBody.position;
    const ahead = this._stepVec ??= new THREE.Vector3();
    ahead.set(wishX / speed, 0, wishZ / speed).multiplyScalar(PLAYER_RADIUS + 0.25);

    const footY = b.y - PLAYER_RADIUS;
    const ground = this.terrain.heightAt(b.x + ahead.x, b.z + ahead.z);
    const rise = ground - footY;
    if (rise > 0.02 && rise <= STEP_HEIGHT) {
      this.playerBody.position.y = ground + PLAYER_RADIUS + 0.02;
      if (this.playerBody.velocity.y < 0) this.playerBody.velocity.y = 0;
    }
  }


  /**
   * Settled debris is solid scenery: a frozen (or resting) chunk of a collapsed
   * building blocks the player like any wall. Moving debris stays passable — the crush
   * check is what punishes standing under it — and pebbles too small to read as an
   * obstacle are ignored.
   */

  /** Deltas are in mouse pixels; the pad and the touch drag are converted to them in input.js. */
  _look(mx, my) {
    if (!this._controlling() || this.state !== 'playing') return;
    const k = LOOK_RAD_PER_PX * this.settings.sens;
    this.yaw -= mx * k;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - my * k * (this.settings.invertY ? -1 : 1), -1.2, 0.5);
  }

  _mouseButton(e, down) {
    if (!this._locked() || this.state !== 'playing') return;
    if (e.button === 0) this._fireMouse = down;   // _applyInput turns it into held fire
    if (e.button === 2 && down && !this.downed) this.weapon.fireAlt(this._muzzle());
  }

  _followCamera(dt) {
    const p = this.player.position;
    const eyeY = p.y + 0.7;

    // The win: let go of the player and circle the keep from above, slowly, so the beam,
    // the breach and the wreckage are all in frame for the beat before the summary.
    if (this.wonAt >= 0 && !this.q.reducedMotion) {
      // Out past the outer wall and well above the keep's roof (34 units): any closer and
      // the frame is one face of the keep.
      const c = this.chalice.position;
      const a = this.yaw + this.wonAt * 0.4;
      const orbit = this._orbitVec ??= new THREE.Vector3();
      orbit.set(c.x + Math.sin(a) * 84, c.y + 62, c.z + Math.cos(a) * 84);
      this.camera.position.lerp(orbit, 1 - Math.exp(-2.2 * dt));
      this.camera.lookAt(c.x, c.y + 14, c.z);
      this.player.visible = true;
      return;
    }

    // Unit vector from the eye back to where the chase camera wants to sit.
    const back = this._camBack ??= new THREE.Vector3();
    back.set(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch));
    // The eye is eased toward the head, not pinned to it: the body moves on the fixed
    // physics step, and a camera bolted to it stutters on any display faster than that.
    const head = this._camHead ??= new THREE.Vector3();
    head.set(p.x, eyeY, p.z);
    const eye = this._camEye ??= head.clone();
    eye.lerp(head, 1 - Math.exp(-22 * dt));

    // Wall collision. The camera used to be clamped against the terrain height and
    // nothing else, so inside the keep — the room the whole game points at — it sat on
    // the far side of the masonry looking at the outside of a wall. One ray from the eye
    // along the boom, against every structure near enough to matter and the ground:
    // whatever it meets first is how long the boom may be.
    let reach = CAM_DISTANCE;
    for (const s of this.structures) {
      const dx = s.group.position.x - p.x, dz = s.group.position.z - p.z;
      const near = Math.max(s.dims[0], s.dims[2]) * s.scale * 0.75 + CAM_DISTANCE;
      if (dx * dx + dz * dz > near * near) continue;
      const hit = s.raycast(eye, back, reach);
      if (hit && hit.distance < reach) reach = hit.distance;
    }
    const ground = this.terrain.raycast(eye, back, reach);
    if (ground && ground.distance < reach) reach = ground.distance;
    reach = Math.max(0.3, reach - CAM_WALL_MARGIN);

    // Pulled IN at once (a camera easing through a wall shows the far side of it on the
    // way), let back OUT gently so walking past a pillar is not a snap-zoom.
    this._camDist = reach < this._camDist
      ? reach
      : this._camDist + (reach - this._camDist) * (1 - Math.exp(-5 * dt));
    this.camera.position.copy(eye).addScaledVector(back, this._camDist);
    // Never let the chase camera sink into a hillside behind the player.
    const camFloor = this.terrain.heightAt(this.camera.position.x, this.camera.position.z) + 0.4;
    if (this.camera.position.y < camFloor) this.camera.position.y = camFloor;
    this.camera.lookAt(eye);
    // Hard against a wall the boom is shorter than the figure is deep: hide it, and the
    // view is first-person until there is room again.
    this.player.visible = this._camDist >= CAM_HIDE_AVATAR_BELOW;
  }

  _resize() {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.vfx?.resize(width, height);
    this.particles?.setViewportHeight(height * Math.min(window.devicePixelRatio, 2));
  }

  // ── Pointer lock ───────────────────────────────────────────────────────

  _locked() { return document.pointerLockElement === this.canvas; }

  _lockChanged() {
    if (this.disposed) return;
    const locked = this._locked();
    if (locked) {
      this.free = false;
      this.crosshair.style.display = 'block';
      document.addEventListener('mousemove', this._onMouseMove);
      document.addEventListener('mousedown', this._onMouseDown);
      document.addEventListener('mouseup', this._onMouseUp);
      // Pointer lock is the moment control transfers — from the start card ('ready') and
      // from the pause dialog alike — so it is also the moment the run goes live, and the
      // only place the Blazor state machine learns "actually playing" from.
      if (!this.demo && (this.state === 'ready' || this.state === 'paused')) {
        this.state = 'playing';
        this.audio?.setPaused(false);
        this._notify('OnResumed');
      }
      return;
    }
    if (this.free) return; // lock was never the way in; nothing was lost
    this.crosshair.style.display = 'none';
    this._fireMouse = false;
    this.weapon.setPrimaryHeld(false);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    // Lock loss during play ALWAYS pauses — the player is never killed while
    // unable to steer. Blazor owns the pause dialog.
    if (this.state === 'playing' && !this.demo) {
      this.state = 'paused';
      this.audio?.setPaused(true);
      this._notify('OnPaused', 'pointerlock');
    }
  }

  _buildCrosshair() {
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'pvs-crosshair';
    this.crosshair.style.display = 'none';
    // Glanceable state around the reticle: inner ring = weapon heat, outer = blast
    // cooldown. Conic-gradient fills driven by --p (0..100) from _pumpHud. These rings
    // are the ONLY heat/blast readout: a HUD bar would say the same thing a second time,
    // a glance away from where the player is aiming.
    this.crosshair.innerHTML =
      '<div class="pvs-ring pvs-ring-heat" style="--p: 0"></div>' +
      '<div class="pvs-ring pvs-ring-alt" style="--p: 100"></div>';
    this.ringHeat = this.crosshair.querySelector('.pvs-ring-heat');
    this.ringAlt = this.crosshair.querySelector('.pvs-ring-alt');
    this.host.appendChild(this.crosshair);

    // Which way the hit came from (see _showHitArc). Always in the DOM; the class shows it.
    this.hitArc = document.createElement('div');
    this.hitArc.className = 'pvs-hit-arc';
    this.host.appendChild(this.hitArc);

    // The cracked visor (see _showCracks): a few fracture lines out of the corners.
    this.cracks = document.createElement('div');
    this.cracks.className = 'pvs-cracks';
    this.cracks.style.opacity = '0';
    this.cracks.innerHTML =
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="M0 8 L9 13 L14 9 L22 18 M9 13 L7 24 L13 31 M100 90 L90 84 L86 90 L77 80 M90 84 L93 73 L87 66' +
      ' M0 78 L8 74 L11 80 L19 72 M100 14 L92 19 L89 13 L82 22 M92 19 L94 29"/></svg>';
    this.host.appendChild(this.cracks);
  }

  _notify(method, ...args) {
    try { this.dotnetRef.invokeMethodAsync(method, ...args); }
    catch (err) { console.warn(`[PoVoxelStrike] ${method} interop failed:`, err); }
  }
}
