// game.js — orchestration: phase machine, scoring, the camera director, the rAF loop,
// and C# callbacks.
import * as THREE from 'three';
import { createScene } from './scene.js';
import * as CANNON from 'cannon-es';
import { createWorld, stepWorld } from './physics.js';
import { mapById, DEFAULT_MAP_ID } from './maps.js';
import { createMarbles, MARBLE_COUNT, PLAYER_INDEX, SKINS } from './marbles.js';
import { createAudio } from './audio.js';
// §GFX-16/§GFX-17 — marble is the weather + glass launch consumer. Classic-style
// IIFE modules imported as modules: they self-register on window and run once.
import '../weather.js';
import '../glassFx.js';

const RESULT_MS = 3600;     // how long the result banner shows before next track
const RACE_TIMEOUT = 180;   // s — failsafe, and now the only backstop for a marble that stalls
                            // at the foot of one of the course's uphill loops (see track.js)
const TICK_INTERVAL = 0.1;  // s — throttle for OnRaceTick to C#
const BEST_KEY = 'pomarblerace_best';
const TRACK_STATS_KEY = 'pomarblerace_trackstats';   // { [mapId]: { races, top10, wins, bestPlace, bestTime } }
const MARBLE_KEY = 'pomarblerace_marble';            // { skin, weight } — the intro card's last pick
const LEADERS = 3;          // rivals drawn in glass and trailed (marbles.js)
const AIR_HOLD = 0.12;      // s without floor contact before the rolling bed calls it airborne
const SECTORS_KEY = 'pomarblerace_sectors';          // { [mapId]: [best sector seconds] }

// ── Staying on the map (2026-09-30) ──
// A marble is only retired when it is BOTH outside the course envelope AND has touched nothing
// for LOST_AIR seconds. Touching any static body means it is on the map, whatever the centerline
// maths says — the old envelope-only test deleted marbles rolling on side lanes. One that is
// touching track while the envelope disagrees has reached another part of the course, so its
// position is re-acquired rather than the marble deleted.
const LOST_AIR = 1.0;
const REACQUIRE_AFTER = 1.0;
// Brake strips (track.brakeAt): how fast an over-speed marble is bled down to the strip's cap.
const BRAKE_RATE = 3;
// Unstick: a marble that has not gained STALL_GAIN units of progress in STALL_AFTER seconds gets
// a nudge along the course, then again every STALL_REPEAT seconds, each one STALL_STEP harder
// (up to STALL_MAX). The escalation is for the authored courses' dips with an uphill exit —
// Spiral Works' Split A → Mid junction parked 23-35 marbles a race — where climbing out takes
// ~27 u/s and a fixed small push only rocked the pile.
const STALL_AFTER = 5;
const STALL_REPEAT = 2;
// 12 units per STALL_AFTER, not 2: a marble creeping along a corner at ~0.4 u/s reset a 2-unit
// timer every few seconds and was never nudged at all (Grand Spiral's Loop → Helix B junction
// parked ~50 that way until the race timed out).
const STALL_GAIN = 12;
const STALL_NUDGE = 14;
const STALL_STEP = 8;
const STALL_MAX = 40;
const STALL_LOOKAHEAD = 12;

// localStorage readers, shared with index.js menu(). Every access is guarded: storage can be
// blocked (private mode), and a stat card is never worth a crash.
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
}
export function readBest() {
  try { return parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; } catch { return 0; }
}
export const readTrackStats = () => readJson(TRACK_STATS_KEY, {});
export const readMarbleChoice = () => ({ skin: 'swirl', weight: 'balanced', ...readJson(MARBLE_KEY, {}) });

// ── The player's verb ──
// Continuous lateral steering. Holding left/right adds sideways acceleration to the picked
// marble for as long as it's held — this is the entire interactive surface of the game, so the
// player is always able to pick a lane at a split, take the Catch line over the Penalty ramp, or
// steer off a paddle. The force is divided by mass; every marble in this field has mass 1, so
// that division is currently a no-op and exists for the roster to vary again.
const STEER_ACCEL = 72;      // lateral units/s² — raised with gravity so steering keeps its bite

// ── Boost pads and kickers ──
// These are surfaces a MAP may or may not have. The procedural chute paints boost pads, rumble
// bands and telegraphed kicker bands onto itself; the authored GLB course has no equivalent and
// exposes neither, so _applyBoost and _applyKickers below feature-detect and simply do nothing
// on a map without them. See the optional part of the track interface in maps.js.
const BOOST_ACCEL = 40;      // units/s² along the track tangent while on a pad
const BOOST_MAX_SPEED = 150; // don't let a marble that camps a pad accelerate without bound

// Kickers: a telegraphed push-only band that fires on a cycle, shoving marbles sideways.
const KICK_DV = 16;          // lateral velocity punch at mass 1 when it fires (÷ mass — heavies resist)
const KICK_UP = 4;           // small upward pop so the kick reads as a jolt, not a slide
const KICK_CHARGE = 0.34;    // fraction of each cycle spent visibly charging up — the TELL

// ── Scoring ──
// Placement-weighted across the 101-marble field: finishing anywhere in the top SCORE_TOP
// scores, more for a higher place, with a dominant-win bonus and a streak multiplier on top.
// Beating 100 marbles with only a steering input makes even a top-10 a real result, so the
// scoring bar is the top 10 rather than a podium of 3.
const SCORE_TOP = 10;                // finish in the top 10 of 101 to score / keep a streak
const DOMINANT_GAP = 1.5;            // s clear of 2nd for the dominant-win bonus
const DOMINANT_BONUS = 4;
const MAX_STREAK_STEPS = 4;          // multiplier caps at 1 + 4*0.5 = 3×

// ── Director ──
// The camera locks to the player's own marble (this is a game you steer, so you must always
// see what you're steering); the leader only takes the shot when the player is out of the
// race or during the slow-motion finish. See _pickShot.
const SLOWMO_DIST = 45;       // units from the finish where the leader triggers slow-motion
const SLOWMO_SCALE = 0.35;
// Shot hysteresis, demo mode only. "Follow the leader" over a 101-marble pack means the subject
// changes every time two marbles swap noses — several times a second in traffic — and every
// change asked the camera for a cut. That, not the follow lerp, is what made the demo camera
// jump. A shot now has to run for SHOT_MIN_HOLD before it can be replaced, and the new leader
// has to be SHOT_LEAD_MARGIN units clear of the current subject to be worth cutting to, so the
// camera stays with a marble through a scrap and only moves on once someone has actually gone.
const SHOT_MIN_HOLD = 3.0;    // seconds a shot must run before another marble can take it
const SHOT_LEAD_MARGIN = 14;  // units the leader must be up on the current subject to take the shot

// Out-of-bounds is no longer a world-Y test — the course banks to near-vertical, so "well below
// the centerline" would eliminate marbles for riding a wall-of-death. track.isOutOfBounds()
// judges it in the local frame instead; see the note there.

// How far the camera anchor is pulled from the subject marble back toward the road centreline.
// 0 = lock dead on the marble (jittery — it inherits per-frame physics noise); 1 = the old
// road-only framing, which loses the marble entirely on a 160-unit-wide channel.
const ROAD_BIAS = 0.35;

// Camera anchor scratch. This runs once a frame and both vectors are consumed immediately, but
// centerAt() hands back a SHARED scratch unless given an output, so _camRoad has to be its own
// object or the lerp would read the vector it is writing into.
const _camAnchor = new THREE.Vector3();
const _camRoad = new THREE.Vector3();

// ── Online (host-authoritative relay) ──
// The host browser is the only simulation: it streams marble positions to the guest at NET_HZ
// and applies the guest's steering to the guest's marble. The guest builds the same course from
// the same seed and renders what it is sent. See PoMarbleRaceShared.cs for why not lockstep.
const NET_HZ = 15;
const NET_INTERVAL = 1 / NET_HZ;
// The guest's marble. Not red (that is the host's, and PACK_PALETTE keeps clear of red for the
// same reason) and not in the palette either: an off-white the pack never uses.
export const GUEST_COLOR = 0xf8fafc;
// Guest-side easing toward the last streamed position, per second: high enough that 15 Hz reads
// as continuous, low enough that a late frame slides rather than snaps.
const NET_SMOOTH = 14;
const _rollAxis = new CANNON.Vec3();
const _guardPoint = new THREE.Vector3();
const _guardNormal = new THREE.Vector3();
const _rollQ = new CANNON.Quaternion();

export class Game {
  /**
   * @param {string} containerId
   * @param {object|null} dotnetRef
   * @param {boolean} demo
   * @param {number} mapId which map to race (see maps.js). Falls back to the default.
   * @param {*} asset whatever that map's load() resolved to — a parsed glTF scene for the GLB
   *   course, null for the procedural one. Loading happens BEFORE the Game is constructed so the
   *   frame loop never has to run trackless; index.js owns that await.
   * @param {object|null} online null for a local game, else { role: 'host'|'guest', seed, guestIndex }.
   * @param {object|null} marble the player's { skin, weight } from the intro card, or null.
   */
  constructor(containerId, dotnetRef, demo, mapId, asset, online, marble) {
    this.container = document.getElementById(containerId);
    this.dotnet = dotnetRef || null;
    this.demo = !!demo;
    this.map = mapById(mapId === undefined ? DEFAULT_MAP_ID : mapId);
    this.mapAsset = asset;
    // Online role, or null for a local game.
    this.online = online || null;
    this.isGuest = !!online && online.role === 'guest';
    this.guestIndex = online ? online.guestIndex : -1;
    this._guestSteer = 0;      // host: the guest's held direction as last relayed, -1/0/+1
    this._sentSteer = 0;       // guest: last direction sent, so only changes cross the wire
    this._netAccum = 0;
    this._netTick = 0;
    this._netFinish = 0;       // guest: finish order, in the order the host's frames report it
    this._guestHud = null;
    this.scene = createScene(this.container);
    this.scene.setTheme(this.map.theme);
    const w = createWorld();
    this.world = w.world;
    this.materials = w.materials;
    this.audio = createAudio();

    this.phase = 'pick';
    this.score = 0;
    this.streak = 0;
    this.best = readBest();
    this.chosen = -1;
    // The races of the current scoring run, sent with each result so a board submission can be
    // recomputed server-side (MarbleRaceRunVerifier). A miss empties it along with the score.
    this.runRaces = [];
    // The player's marble. Demo and an online guest race the default (the guest's pick would
    // have to cross the wire to reach the host's physics). A skin the best run has not unlocked
    // falls back to the default rather than trusting whatever localStorage says.
    this.marbleOpts = { glass: this.scene.heavy };
    if (marble && !this.demo && !this.isGuest) {
      const sk = SKINS.find((k) => k.id === marble.skin);
      this.marbleOpts.skin = sk && sk.need <= this.best ? sk.id : 'swirl';
      this.marbleOpts.weight = marble.weight;
      try { localStorage.setItem(MARBLE_KEY, JSON.stringify({ skin: marble.skin, weight: marble.weight })); } catch { }
    }
    this._leaders = [];        // this frame's top rivals, for the glass + trails (marbles.js sync)
    this._touch = new Set();   // marble bodies touching a static body this step (_markContacts)
    this._sector = 0;          // next checkpoint the player's marble has to pass
    this._sectorStart = 0;
    this._surface = 'surface'; // what the camera's marble is rolling on, for the audio bed
    this._airT = 0;
    this._nearFinish = 0;
    // Only procedural maps re-roll between races (map.regenerate). The authored course is fixed
    // content, so _nextTrack() resets the field on the SAME track rather than rebuilding it —
    // which also spares it rebuilding hundreds of trimesh colliders every race.
    // Date.parse(new Date().toString()) round-trips through a second-precision string, so two
    // loads in the same second raced the identical track. Use the raw epoch ms.
    this.seed = ((Date.now() & 0xffffff) ^ 0x9e3779) >>> 0;
    // Online: both browsers build the course from the seed the server dealt, not from the clock.
    if (this.online) this.seed = this.online.seed >>> 0;
    this.track = null;

    // §GFX-17: weather derives from the race seed, so every client of the same
    // seed computes the same sky with zero network traffic. §GFX-19: the match
    // state wakes the reactive soundtrack. Both are optional modules — a
    // missing one costs atmosphere, never functionality. (Placed after the
    // seed assignment: the seed IS the weather input.)
    this._weatherType = window.PoWeather?.apply({ seed: String(this.seed), stage: this.container }) || 'clear';
    window.PoMusicDirector?.match(true);
    // §GFX-16: scene-composited glass behind the pick card and podium panels.
    // Deferred a beat — the renderer canvas exists by now, but its first frame
    // does not, and glassFx captures live so the panels update as the race runs.
    setTimeout(() => {
      const canvas = this.container.querySelector('canvas');
      if (canvas) this._glassStop = window.PoGlass?.attachHud(canvas, '.mr-pick-card, .mr-place, .mr-countdown');
    }, 1200);
    this.marbleSet = null;
    this.raceClock = 0;
    this.tickAccum = 0;
    this.resultTimer = 0;
    this.disposed = false;
    this._raf = 0;
    this._lastTs = 0;

    // player verb — lateral steering, held via keyboard or the on-screen pads
    this._steerLeft = false;
    this._steerRight = false;
    this._steerSparkAccum = 0;
    this._wasBoosting = false;

    // director
    this.slowmo = false;
    this._lastFocus = null;
    this._shotMarble = null;    // current subject; with _shotSince it drives the hysteresis above
    this._shotSince = 0;

    this._buildTrack();
    this._bindKeys();
  }

  // ── public API (called from index.js / interop) ──
  start() {
    this.audio.resume();
    this._lastTs = 0;
    this._paused = true; // 2026-07-19: gate the rAF loop on resume() so the
                         // engine can't run the pick countdown and racing
                         // phase while the intro modal is still up.
    const loop = (ts) => {
      if (this.disposed) return;
      const now = ts || performance.now();
      const dt = this._lastTs ? (now - this._lastTs) / 1000 : 0.016;
      this._lastTs = now;
      if (!this._paused) this._frame(Math.min(dt, 0.05));
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    // Demo mode is auto-cycled by the kiosk; it gets the same pause gate
    // (the intro card flashes for DemoDelayMs then calls resume()).
    if (this.demo) this._autoPickSoon();
  }

  // 2026-07-19 browser audit #1: the engine used to call _setPhase('pick')
  // during construction and immediately start a 3s auto-pick, all while
  // the intro modal was still on screen. resume() is the explicit
  // acknowledgment from the host that the intro is dismissed and the
  // engine may now run the pick phase (and the rAF tick).
  resume() {
    if (this._paused) {
      this._paused = false;
      this._lastTs = 0; // discard the dt we accumulated while paused
      // Re-emit the current phase so the host can sync its overlay state.
      this._invoke('OnPhase', this.phase, this.chosen, this.score, this.best, this.streak, this.seed | 0);
    }
  }

  pick(index) {
    if (this.phase !== 'pick') return;
    if (index < 0 || index >= MARBLE_COUNT) return;
    this.chosen = index;
    this._steerLeft = this._steerRight = false;
    this._sector = 0;
    this._sectorStart = 0;
    this._setPhase('racing');
    this.raceClock = 0;
    this.tickAccum = TICK_INTERVAL;
    for (const m of this.marbleSet.marbles) m.prevPlace = -1;
    this.scene.followTarget(this.marbleSet.marbles[index].mesh.position, 0, true);
    this.scene.punchFov();   // a quick FOV widen as the race kicks off
    this.audio.resume();
    this.audio.playGun();
  }

  // The player's in-race input: hold a direction to steer the picked marble sideways. dir is
  // -1 (left) or +1 (right); active toggles the hold. Keyboard drives this on keydown/keyup,
  // the on-screen pads on pointer down/up. The force itself is applied every physics step in
  // _applySteer — this just records which way, if any, is currently held.
  setSteer(dir, active) {
    if (dir < 0) this._steerLeft = !!active;
    else if (dir > 0) this._steerRight = !!active;
    // Guest: the host applies the force, so what crosses the wire is the net held direction,
    // and only when it changes — a held key must not stream a packet per keydown auto-repeat.
    if (this.isGuest) {
      const net = (this._steerRight ? 1 : 0) - (this._steerLeft ? 1 : 0);
      if (net !== this._sentSteer) { this._sentSteer = net; this._invoke('OnSteer', net); }
    }
  }

  // Host: the guest's steering as relayed by the hub. Applied every physics step in _applySteer.
  setGuestSteer(dir) { this._guestSteer = Math.max(-1, Math.min(1, dir | 0)); }

  // Applied once per physics step while racing. Left+right held cancel out. The push is along
  // the track's LOCAL right vector, so it stays intuitive through banked turns and hairpins
  // where world-space X would flip under the player.
  _applySteer(sdt) {
    if (this.demo || this.phase !== 'racing') return;
    const dir = (this._steerRight ? 1 : 0) - (this._steerLeft ? 1 : 0);
    if (dir) this._pushMarble(this.marbleSet.marbles[this.chosen], dir, sdt);
    // Online host: the guest's held direction drives the guest's marble through the SAME push
    // below, so both humans steer with identical physics.
    if (this.online && !this.isGuest && this._guestSteer) {
      this._pushMarble(this.marbleSet.marbles[this.guestIndex], this._guestSteer, sdt);
    }
  }

  // One steering push on one marble. Split out of _applySteer (2026-09-14, online mode) so the
  // host can apply it to the guest's marble too. The sign history below is unchanged.
  _pushMarble(m, dir, sdt) {
    if (!m || m.finished || m.eliminated) return;

    const rb = this.track.rightAt(m.s);
    // A lateral acceleration (÷ mass so it's independent of the mass unit), applied along the
    // track's local right vector.
    //
    // NOT negated. The sign has now been flipped twice and the history is the useful part:
    //
    //   1. Originally un-negated, derived from first principles — the baked basis defines
    //      right = dir x up, a camera's screen-right is likewise forward x up, so track-right
    //      should already be screen-right.
    //   2. Negated, because players reported steering backwards. It was, at the time.
    //   3. Un-negated again — because between (2) and now the CAMERA changed. It used to frame
    //      the road centreline; it now anchors on the marble itself (see ROAD_BIAS). Reframing
    //      the shot changed which way `right` reads on screen and undid the correction.
    //   4. Still un-negated, and reported backwards again on 2026-09-12 — but the sign was not
    //      the culprit this time and flipping it would have broken the other two maps. The
    //      chute's generator was publishing -(dir x up) as its right vector while both baked
    //      GLB courses published dir x up, so the SAME sign here steered correctly on the
    //      authored courses and backwards on the chute. Fixed where the disagreement was:
    //      maps.js adaptProceduralTrack now negates the chute's vector at the boundary.
    //
    // The lesson worth keeping: steering feel is a property of the CAMERA, not of the track
    // basis. The derivation in (1) is sound and holds whenever the shot is anchored on the
    // subject. Do not re-derive this — if it ever feels backwards again, check first whether it
    // is backwards on EVERY map. If it is, look at the camera, then flip this sign and record
    // why. If it is only one map, that map's basis is what disagrees.
    const dv = (STEER_ACCEL / m.body.mass) * dir * sdt;
    m.body.velocity.x += rb.x * dv;
    m.body.velocity.y += rb.y * dv;
    m.body.velocity.z += rb.z * dv;

    // Throttled sparks off the steered marble — feedback that the input is landing, without
    // the every-frame audio a held key would otherwise spam.
    this._steerSparkAccum += sdt;
    if (this._steerSparkAccum >= 0.08) {
      this._steerSparkAccum = 0;
      this.scene.burstSparks(m.mesh.position, m.spec.color, 3, 0.7);
    }
  }

  regenerate() {
    if (this.phase === 'racing') return; // ignore mid-race spam; R is for pick/result
    this._nextTrack();
  }

  setMuted(m) { this.audio.setMuted(m); }

  beep(final) { this.audio.playBeep(!!final); }

  dispose() {
    this.disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._unbindKeys();
    if (this.marbleSet) this.marbleSet.dispose();
    if (this.track) this.track.dispose();
    this.audio.dispose();
    this.scene.dispose();
    // §GFX-16/§GFX-17 teardown: the glass capturer holds a capture interval and
    // the weather overlay a rAF loop — both must die with the game.
    if (this._glassStop) this._glassStop();
    window.PoWeather?.stop();
    window.PoMusicDirector?.tension?.(0);
    window.PoMusicDirector?.match(false);
  }

  // ── internals ──
  // Builds the course through the active map. A map that says it can regenerate (the procedural
  // chute) gets a fresh track per race; one that cannot (an authored model) is built once and
  // reused, which also spares it rebuilding hundreds of trimesh colliders every race.
  _buildTrack() {
    this._podiumSent = false; // reset the top-3 podium for the new race
    if (this.track && this.track.regenerate) {
      this.scene.remove(this.track.group);
      this.track.dispose();
      this.track = null;
    }
    if (!this.track) {
      this.track = this.map.build(this.world, this.materials, MARBLE_COUNT, this.mapAsset, this.seed);
      this.scene.add(this.track.group);
    }
    this.marbleSet = createMarbles(this.world, this.materials, this.track.startPositions, -1,
      (v, pos, color) => {
        // Only BIG collisions make a sound — the constant clinking from every
        // little tap was too noisy. Sparks still fire on the smaller hits.
        // #9: the clink is now placed in the stereo field by where the hit happened on screen.
        if (v > 8) this.audio.playClink(v, this.scene.audioCue(pos));
        this.scene.burstSparks(pos, color, Math.min(14, 4 + Math.floor(v)), Math.min(1.6, 0.5 + v * 0.12));
        // GFX #5: a genuinely heavy hit lights the track around it for a beat. Gated harder than
        // the clink, or traffic would strobe.
        if (v > 14) this.scene.pulseLight(pos, 0xffd9a0, Math.min(1.5, 0.5 + v * 0.04));
        // The same heavy hit holds the frame for a beat. Local races only: online, the host's
        // clock is the guest's race, and one player's hit should not stall the other's view.
        if (v > 14 && !this.online) window.PoImpact?.hitstop?.(45);
      },
      // Marble-only specular environment (realism pass #3). Bound as `envMap` on the marble
      // materials alone — deliberately NOT scene.environment, so the track stays matte.
      this.scene.marbleEnv,
      // Online: the guest's marble is recoloured so both humans can find themselves in the pack.
      this.online ? { [this.guestIndex]: GUEST_COLOR } : null,
      this.marbleOpts);
    // One group, not 101 meshes: the pack is a single InstancedMesh now (marbles.js #1), and the
    // player's Mesh rides in the same group.
    this.scene.add(this.marbleSet.group);
    this.scene.add(this.marbleSet.decorations);
    this.chosen = -1;
    this.slowmo = false;
    this._guestSteer = 0;
    this._netFinish = 0;
    this._guestHud = null;
    this._gradeState = '';        // #3 — force the next _setGrade through even if the name repeats
    // Drop the director's references into the marble set we just disposed — a stale _shotMarble
    // would keep the hysteresis holding a shot on a marble that is no longer in the world.
    this._shotMarble = null;
    this._lastFocus = null;
    this._leaders = [];
    this._setPhase('pick');
    // frame the start gate from above, looking along the track rather than down world +Z
    this.scene.followTarget(this.track.overviewTarget, 0, true, this.track.dirAt(0));
  }

  // #3 — request a colour grade. Deduped because this is called from the frame loop: setGrade
  // itself is cheap, but re-arming the same target every frame would be noise in a profile and
  // makes the intent unreadable. scene.js eases toward whatever is set, so changes are always
  // transitions.
  _setGrade(name) {
    if (this._gradeState === name) return;
    this._gradeState = name;
    this.scene.setGrade(name);
  }

  _setPhase(p) {
    this.phase = p;
    // Grade follows the phase. 'result' deliberately doesn't set one — _resolve has already
    // chosen win/loss by then, and overwriting it here would wash that straight out.
    if (p === 'pick') this._setGrade('pick');
    else if (p === 'racing') this._setGrade('racing');
    if (p !== 'racing') window.PoMusicDirector?.tension?.(0);
    // 2026-07-19 browser audit #1: skip phase notifications while the
    // intro is up. The host can't react to OnPhase('pick') until resume()
    // fires anyway, and a notify during intro would race the host's
    // StartPickCountdown. The constructor's first _setPhase('pick') is
    // simply held until resume() flushes it.
    if (this._paused) return;
    // The seed rides along (appended — positional contract) so an online host can relay it and
    // the guest builds the same next course. Sent as int32; the receiver restores the uint32.
    this._invoke('OnPhase', p, this.chosen, this.score, this.best, this.streak, this.seed | 0);
  }

  _nextTrack(seed) {
    if (this.marbleSet) { this.scene.remove(this.marbleSet.group); this.scene.remove(this.marbleSet.decorations); this.marbleSet.dispose(); }
    // An online guest is handed the host's seed; everyone else rolls the LCG forward.
    this.seed = seed !== undefined ? (seed >>> 0) : (this.seed * 1664525 + 1013904223) >>> 0;
    // Whether that seed produces a NEW track depends on the map — see _buildTrack.
    this._buildTrack();
    if (this.demo) this._autoPickSoon();
  }

  _autoPickSoon() {
    // demo mode: assign the red marble after a short beat so the start gate is visible first
    // (the demo camera follows the leader regardless — chosen just needs to be valid).
    this._demoPickAt = performance.now() + 1200;
  }

  // ── Camera director ──
  // This is a game you steer, so the camera stays LOCKED to your own marble the whole race —
  // you must always see the marble you're controlling. The only times it leaves you: when
  // you're out of the race (eliminated/finished → follow the leader so there's still a race to
  // watch), and the slow-motion finish (the leader's money shot — unless YOU are that leader,
  // in which case staying on you already frames it).
  // `order` is this frame's post-step leaderboard(), computed once in _frame and shared with
  // the audio bed — leaderboard() is an O(n log n) pass over the 101-marble field, so it's
  // not re-derived here.
  _pickShot(order) {
    const leader = order[0];
    const now = performance.now();
    // Stamp the subject on every change so the hysteresis below can measure how long the current
    // shot has run. Cheap, and it keeps _shotSince honest for the non-demo cuts too.
    const take = (marble) => {
      if (marble !== this._shotMarble) { this._shotMarble = marble; this._shotSince = now; }
      return marble;
    };

    if (this.demo) {
      const cur = this._shotMarble;
      // Nothing to hold on to, or the subject is out of the race → take the leader outright.
      if (!cur || cur.eliminated || cur.finished) return take(leader);
      if (cur === leader) return take(leader);
      // Hold the shot: only cut once it has run its minimum AND the leader has genuinely gone.
      // Returning `cur` without take() deliberately leaves _shotSince alone — the shot is
      // continuing, not restarting.
      const held = (now - this._shotSince) / 1000;
      const behind = leader.s - cur.s;
      if (held < SHOT_MIN_HOLD || behind < SHOT_LEAD_MARGIN) return cur;
      return take(leader);
    }

    const me = this.marbleSet.marbles[this.chosen];
    const meAlive = me && !me.eliminated && !me.finished;
    // 1-player: stay LOCKED to your own marble the entire race — including the
    // slow-mo finish. You must always see the marble you're steering. The camera
    // only leaves you once you're out of the race (eliminated or finished), when
    // it falls back to the leader so there's still a race to watch.
    if (!meAlive) return take(leader);

    return take(me);
  }

  // Boost pads. A no-op on maps that have none — see the track interface in maps.js.
  _applyBoost(sdt) {
    if (!this.track.inBoost) return;
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;
    let playerBoosting = false;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      if (!this.track.inBoost(m.s)) continue;
      const v = m.body.velocity;
      // A map may lower the ceiling. It has to be able to: the default is 150, but an authored
      // course whose collider is a zero-thickness shell tunnels above ~120 u/s (see
      // boostMaxSpeed in track-glb.js), and a marble that leaves through the floor is gone.
      if (v.length() < (this.track.boostMaxSpeed || BOOST_MAX_SPEED)) {
        const d = this.track.dirAt(m.s);
        v.x += d.x * BOOST_ACCEL * sdt;
        v.y += d.y * BOOST_ACCEL * sdt;
        v.z += d.z * BOOST_ACCEL * sdt;
      }
      if (m === me) playerBoosting = true;
      if (Math.random() < 0.25) this.scene.burstSparks(m.mesh.position, 0x22d3ee, 2, 0.5);
    }
    // Edge-trigger the whoosh so it fires once per pad, not every frame you're on one.
    if (playerBoosting && !this._wasBoosting) {
      this.audio.playWhoosh(this.scene.audioCue(me.mesh.position));   // #9 placed at the pad
    }
    this._wasBoosting = playerBoosting;
  }

  // Brake strips (Spiral Works). Bleeds an over-speed marble down to the strip's cap; a no-op on maps
  // without any. Scaling the velocity rather than adding a force keeps the heading untouched.
  _applyBrakes(sdt) {
    if (!this.track.brakeAt) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      const cap = this.track.brakeAt(m.s);
      if (!cap) continue;
      const v = m.body.velocity;
      const sp = v.length();
      if (sp > cap) v.scale(Math.max(cap / sp, 1 - BRAKE_RATE * sdt), v);
    }
  }

  // Course drive (track.driveAccel): a steady push along the course for marbles touching the track,
  // on a map whose grade is too gentle to race on under gravity alone (Playground Run). Only on the
  // track, so a free fall is untouched; clampSpeeds still caps the result. A no-op elsewhere.
  _applyDrive(sdt) {
    const a = this.track.driveAccel;
    if (!a) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj || !this._touch.has(m.body)) continue;
      const d = this.track.flowDir ? this.track.flowDir(m.proj, _camRoad) : this.track.dirAt(m.s, _camRoad);
      const v = m.body.velocity;
      v.x += d.x * a * sdt; v.y += d.y * a * sdt; v.z += d.z * a * sdt;
    }
  }

  _savePrev() {
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      (m.prev || (m.prev = new CANNON.Vec3())).copy(m.body.position);
    }
  }

  _guardContainment() {
    const sweep = this.track.sweepGuard;
    if (!sweep) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.prev) continue;
      if (!sweep(m.prev, m.body.position, m.radius, _guardPoint, _guardNormal)) continue;
      m.body.position.set(_guardPoint.x, _guardPoint.y, _guardPoint.z);
      // Bounce off the inside of the surface it tried to pass (restitution 0.3).
      const v = m.body.velocity;
      const vn = v.x * _guardNormal.x + v.y * _guardNormal.y + v.z * _guardNormal.z;
      if (vn < 0) {
        v.x -= 1.3 * vn * _guardNormal.x;
        v.y -= 1.3 * vn * _guardNormal.y;
        v.z -= 1.3 * vn * _guardNormal.z;
      }
    }
  }

  // Which marbles are touching a static body (floor, wall, lid, obstacle) after this step. One
  // pass over the solver's contact list; marble-on-marble contacts do not count.
  _markContacts() {
    const t = this._touch;
    t.clear();
    const marble = this.materials.marble;
    for (const c of this.world.contacts) {
      const a = c.bi, b = c.bj;
      if (a.material === marble && b.material !== marble) t.add(a);
      else if (b.material === marble && a.material !== marble) t.add(b);
    }
  }

  // Unstick (see STALL_*): nudge a marble that has stopped making progress along the course. The
  // direction is the marble's own lane where the track can say (track.flowDir) — across a lane
  // junction the main line's tangent is turned ~90° to the channel, and the stalls cluster
  // exactly there — else toward the centerline a little ahead.
  _unstick(sdt) {
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      if (m.stallS === undefined || m.s > m.stallS + STALL_GAIN) { m.stallS = m.s; m.stallT = 0; m.nudges = 0; continue; }
      m.stallT += sdt;
      if (m.stallT < STALL_AFTER) continue;
      m.stallT = STALL_AFTER - STALL_REPEAT;
      let d;
      // Along the lane when the marble is in one; otherwise (a funnel, a free fall) toward the
      // course a little ahead — in a funnel that is the throat. The main line's tangent there
      // points nowhere useful, and pushing along it shoved a marble resting on Grand Spiral's
      // funnel lip straight off the outside.
      if (this.track.flowDir && m.proj && m.proj.lane >= 0) {
        d = this.track.flowDir(m.proj, _camRoad);
      } else {
        const ahead = this.track.centerAt(m.s + STALL_LOOKAHEAD, _camRoad);
        const p = m.body.position;
        d = ahead.set(ahead.x - p.x, ahead.y - p.y, ahead.z - p.z).normalize();
      }
      const push = Math.min(STALL_MAX, STALL_NUDGE + STALL_STEP * (m.nudges || 0));
      m.nudges = (m.nudges || 0) + 1;
      m.body.velocity.x += d.x * push;
      m.body.velocity.y += d.y * push + 3;
      m.body.velocity.z += d.z * push;
    }
  }

  // Sector splits (map checkpoints): as your own marble passes each checkpoint, and at the line,
  // report the time since the last one against this map's best for that sector.
  _checkSectors() {
    const cps = this.track.checkpoints;
    if (this.demo || !cps) return;
    const me = this.marbleSet.marbles[this.isGuest ? this.guestIndex : this.chosen];
    if (!me || me.eliminated) return;
    while (this._sector < cps.length && me.s >= cps[this._sector]) this._splitSector(this.raceClock, cps.length + 1);
    if (me.finished && this._sector === cps.length) this._splitSector(me.finishTime, cps.length + 1);
  }

  _splitSector(at, count) {
    const idx = this._sector;
    const time = Math.round((at - this._sectorStart) * 100) / 100;
    this._sector++;
    this._sectorStart = at;
    const all = readJson(SECTORS_KEY, {});
    const bests = all[this.map.id] || [];
    const best = bests[idx] || 0;
    if (!best || time < best) {
      bests[idx] = time;
      all[this.map.id] = bests;
      try { localStorage.setItem(SECTORS_KEY, JSON.stringify(all)); } catch { }
    }
    this._invoke('OnSector', idx + 1, count, time, best);
  }

  // #6 Kickers: drive the telegraph (brightening pad) and the fire moment. Push-only, so it
  // can scatter the pack and force a steering correction but never trap a marble. A no-op on
  // maps that have none.
  _applyKickers() {
    const kickers = this.track.kickers;
    if (!kickers) return;
    const t = this.raceClock;
    for (const k of kickers) {
      const phase = (t % k.period) / k.period;         // 0..1 within the charge->fire cycle
      // Tell: brighten over the last KICK_CHARGE of the cycle, easing in so it "winds up".
      const charge = phase > (1 - KICK_CHARGE) ? (phase - (1 - KICK_CHARGE)) / KICK_CHARGE : 0;
      k.mat.emissiveIntensity = 0.5 + charge * charge * 2.4;
      // Fire on the wrap, when phase resets from near-1 back toward 0.
      if (phase < k._lastPhase) this._fireKicker(k);
      k._lastPhase = phase;
    }
  }

  _fireKicker(k) {
    const [a, b] = k.band;
    const len = this.track.length;
    let hits = 0;
    let lastHitPos = null;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      const frac = m.s / len;
      if (frac < a || frac > b) continue;
      lastHitPos = m.mesh.position;
      const rb = this.track.rightAt(m.s);
      // Alternate the kick direction by marble index so a fire splits the pack rather than
      // shoving everyone the same way — and the player has to steer back to their line.
      const dv = (KICK_DV / m.body.mass) * (m.index % 2 === 0 ? 1 : -1);
      m.body.velocity.x += rb.x * dv;
      m.body.velocity.y += rb.y * dv + KICK_UP;
      m.body.velocity.z += rb.z * dv;
      this.scene.burstSparks(m.mesh.position, 0xe879f9, 14, 1.5);
      hits++;
    }
    k.mat.emissiveIntensity = 3.6;          // bright flash on fire (visible even when it hits nothing)
    if (hits > 0) {
      // ...but only make noise when it actually connects, and place it where it connected (#9).
      this.audio.playWhoosh(this.scene.audioCue(lastHitPos));
      // GFX #5 - a magenta flash off the band, which is what makes the kick read as a discharge
      // rather than the pack spontaneously scattering.
      this.scene.pulseLight(lastHitPos, 0xe879f9, 1.5);
    }
  }

  _frame(dt) {
    // demo auto-pick
    if (this.demo && this.phase === 'pick' && this._demoPickAt && performance.now() >= this._demoPickAt) {
      this._demoPickAt = 0;
      this.pick(Math.floor(Math.random() * MARBLE_COUNT));
    }

    if (this.phase === 'racing' && this.isGuest) {
      // Guest: no physics, the host's frames are the truth. Everything else below is host-only.
      this._guestRacingFrame(dt);
    } else if (this.phase === 'racing') {
      const lbPre = this.marbleSet.leaderboard();
      const leaderPre = lbPre[0];
      // Slow-motion as the leader runs at the line. sdt scales the simulation, so finish
      // times stay measured in simulation seconds and remain comparable across races.
      this.slowmo = !!leaderPre && !leaderPre.finished &&
        (this.track.finishS - leaderPre.s) < SLOWMO_DIST;
      // Hit-stop rides the same scale: impactBus holds time at 0.12 for a few dozen ms after a
      // heavy hit or the winner's finish (1 otherwise, and always 1 under reduced motion).
      const want = (this.slowmo ? dt * SLOWMO_SCALE : dt) * (window.PoImpact?.getTimeScale?.() ?? 1);

      this.track.driveMotors();
      this._applySteer(want);   // player's held steering, integrated by the step below
      this._savePrev();
      // sdt is the time the physics actually advanced, which is less than `want` on any frame
      // where cannon-es gives up catching up (see stepWorld). Everything below runs on it: with
      // the race clock on `want`, a page at 15 fps ran the clock at twice the pace of the marbles
      // and the race ended at RACE_TIMEOUT with two thirds of the field still on the course.
      const sdt = stepWorld(this.world, want);
      // Interlock, not tuning: cannon-es has no CCD and the course's collision shell is a single
      // surface with nothing behind it, so a marble must never carry a velocity that would step
      // it further than its own diameter. See MAX_SPEED in marbles.js.
      this.marbleSet.clampSpeeds();
      // Containment is single-sided; a fast head-on hit can carry a marble through it in one
      // step. Trace this frame's paths and put any crossing back inside (track.sweepGuard).
      this._guardContainment();
      // Re-project the field onto the centerline FIRST: `s` is the ranking key, the finish test
      // and the bounds test, and every one of those below would read last frame's positions
      // otherwise.
      this.marbleSet.updateProgress(this.track);
      // Both read each marble's `s`, so they run after the re-projection above. Their impulses
      // land on the next step, exactly as they did when this was keyed on world z.
      this._applyBoost(sdt);
      this._applyBrakes(sdt);
      this._applyKickers();
      this._markContacts();
      this._applyDrive(sdt);
      this._unstick(sdt);
      this._surface = this._surfaceOf(this._lastFocus, dt);
      this.marbleSet.sync(this.track, this.scene.camera.position, this._leaders);
      for (const p of this.track.paddles) { p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion); }

      this.raceClock += sdt;
      // Finishes are resolved BEFORE the out-of-bounds sweep. Crossing the line is terminal:
      // a marble that has already finished is frozen and can't fall, and one that crosses and
      // drops in the same step has still finished. Sweeping first meant a marble past the
      // line could be scored as eliminated instead of a finisher.
      const { justFinished } = this.marbleSet.checkFinishes(this.track.finishS, this.raceClock);

      // Remove any marble that has genuinely left the course — see LOST_AIR. The envelope test
      // lives in the track because it has to be made in the track's LOCAL (per-lane) frame.
      for (const m of this.marbleSet.marbles) {
        if (m.finished || m.eliminated || !m.proj) continue;
        const onTrack = this._touch.has(m.body);
        m.airT = onTrack ? 0 : (m.airT || 0) + sdt;
        if (!this.track.isOutOfBounds(m.proj)) { m.lostT = 0; continue; }
        if (onTrack) {
          m.lostT = (m.lostT || 0) + sdt;
          if (m.lostT > REACQUIRE_AFTER) { m.pathIndex = -1; m.lostT = 0; }
        } else if (m.airT > LOST_AIR) {
          this.marbleSet.eliminate(m);
        }
      }

      // Recomputed after the sweep rather than taken from checkFinishes: a marble eliminated
      // just above is out of the race too, and the race ends once nothing is still running.
      const allDone = this.marbleSet.marbles.every((m) => m.finished || m.eliminated);

      for (const m of justFinished) {
        this.scene.burstConfetti(m.mesh.position);   // celebrate each ball crossing the line
        // #9 — spatialized, so a pack crossing ahead of you spreads across the stereo field
        // instead of stacking a hundred identical chimes dead centre.
        this.audio.playFinish(this.scene.audioCue(m.mesh.position));
        if (m.index === this.chosen) this._celebrateOwnFinish(m, m.finishOrder + 1);
      }
      // §GFX-2 — rack the focus for the WINNER only. Firing it per finisher
      // would re-trigger it a hundred times as the pack crosses, which reads as
      // the image pumping rather than as a photo finish.
      if (justFinished.length && justFinished.some((m) => m.finishOrder === 0)) {
        // Only when the shot is ON the winner: the focus plane is the chase distance, so with the
        // camera locked to your own marble back in the pack it blurred your view of the course.
        if (this._lastFocus && this._lastFocus.finishOrder === 0) this.scene.photoFinish();
        window.PoImpact?.impact('win', 1);
        // §GFX-14/§GFX-18: photo-finish post preset + the finish-gate chime.
        window.PoImpactFx?.win(1);
        window.PoMaterialAudio?.hit('glass', 0.7);
      }
      // Podium: the moment the 3rd marble crosses, freeze the top-3 (winner + 2)
      // with their gaps behind the winner and push it to the HUD overlay.
      if (!this._podiumSent && this.marbleSet.marbles.filter((m) => m.finished).length >= 3) {
        this._podiumSent = true;
        this._sendPodium();
      }
      if (allDone || this.raceClock >= RACE_TIMEOUT) {
        if (!allDone) this.marbleSet.forceFinishRemaining(this.raceClock);
        this._resolve();
      }

      // One post-step ranking pass, taken after the finish/eliminate sweeps (and any
      // _resolve) above so it reflects this frame's settled standings. Shared by the
      // audio bed and the camera director below — nothing mutates positions or race
      // flags between here and the _pickShot call.
      const order = this.marbleSet.leaderboard();

      // Audio beds ride the focused marble's speed and how close the race is to resolving.
      // #10: tightened the range (400→300) and eased it (pow 0.6) so the bed ramps up harder
      // and sooner as the leader runs at the line — the music leans into the finish.
      const leaderNow = order[0];
      const nearRaw = leaderNow
        ? 1 - Math.max(0, Math.min(1, (this.track.finishS - leaderNow.s) / 300))
        : 0;
      const nearFinish = Math.pow(nearRaw, 0.6);
      this._nearFinish = nearFinish;
      // The rolling bed rides the marble on camera (not the leader) and what it is touching.
      const rolling = this._lastFocus || leaderNow;
      this.audio.updateBeds(rolling ? rolling.speed : 0, nearFinish, this.phase === 'racing', this._surface);

      // #3 — FINAL STRETCH grade. Deliberately keyed off the same 0.86 leader-progress threshold
      // the HUD's own "🏁 FINAL STRETCH" klaxon uses (PoMarbleRacePage.razor), so the screen and
      // the banner agree instead of warming up at different moments. _resolve overrides this
      // with win/loss the instant the race is decided.
      if (this.phase === 'racing') {
        this._setGrade(this.marbleSet.progress() >= 0.86 ? 'final' : 'racing');
      }

      // Snap on a shot change rather than lerping across the track: a director's cut is a
      // cut. Lerping between two marbles 200 units apart reads as the camera losing the race.
      const focus = this._pickShot(order);
      if (focus) {
        // Frame the SUBJECT, biased toward the road.
        //
        // This used to anchor purely on the track centerline at the subject's down-track
        // position, on the reasoning that the road should stay horizontally centred however far
        // across it the marble drifted. That held while the only course was the procedural
        // chute, whose channel is 64 units wide — road-centre and marble were near enough the
        // same point. It does not hold now: the authored courses run up to 160 units across at
        // the catch pans, so a marble on the outside of a banked turn sat far out of frame and
        // the camera appeared to be watching the track rather than the racer.
        //
        // The anchor is now the marble's own position pulled ROAD_BIAS of the way back toward
        // the centerline. At 0.35 the subject stays framed on every course while the road keeps
        // enough weight to damp the per-frame physics jitter that made a pure marble anchor
        // wobble — which is the problem the centerline anchor was solving in the first place.
        const fs = focus.s;
        const fwd = this.track.dirAt(fs);
        const anchor = _camAnchor.copy(focus.mesh.position)
          .lerp(this.track.centerAt(fs, _camRoad), ROAD_BIAS);
        this.scene.followTarget(anchor, dt, focus !== this._lastFocus, fwd, focus.speed);
        this._lastFocus = focus;
      }
      this._leaders = this._topRivals(order);
      this._checkSectors();

      this.tickAccum += dt;
      if (this.tickAccum >= TICK_INTERVAL) { this.tickAccum = 0; this._sendTick(); }
      if (this.online && !this.isGuest) this._netSend(dt);
    } else if (this.phase === 'result') {
      // keep the paddles/marbles visually settled; advance after the banner
      this.marbleSet.sync(this.track, this.scene.camera.position, this._leaders);
      this.resultTimer -= dt;
      const winner = this.marbleSet.leaderboard()[0];
      if (winner) {
        const ws = winner.s;
        this.scene.followTarget(this.track.centerAt(ws), dt, false, this.track.dirAt(ws));
      }
      // Guest: the host decides when the next race starts (nextTrack, with its seed).
      if (this.resultTimer <= 0 && !this.isGuest) this._nextTrack();
    } else {
      // pick phase: gentle overview of the start gate. The heading matters here too — without
      // it the camera sat straight back in world -Z while the track headed off at an angle,
      // which threw the road across one side of the frame before the race even started.
      const ov = this.track.overviewTarget;
      this.scene.followTarget(ov, dt, false, this.track.dirAt(0));
    }

    this.scene.render();
  }

  // The top rivals, for the glass and trails. Never the red marble: it is always trailed, and it
  // is a Mesh of its own rather than a pack instance, so it has nothing to swap into the glass.
  _topRivals(order) {
    const out = [];
    for (const m of order) {
      if (m.index === PLAYER_INDEX) continue;
      out.push(m);
      if (out.length === LEADERS) break;
    }
    return out;
  }

  // What `m` is rolling on, as an audio.js SURFACES key, read from the solver's contact list after
  // the step: the contact material of whatever non-marble body it touches. Riding on other marbles
  // counts as the plain surface. No contact for AIR_HOLD seconds is 'air' — a single substep
  // without contact is a bounce, not a jump, and would otherwise stutter the bed.
  _surfaceOf(m, dt) {
    if (!m || m.finished || m.eliminated) return 'surface';
    if (this.track.inBoost && this.track.inBoost(m.s)) return 'boost';
    if (this.track.brakeAt && this.track.brakeAt(m.s)) return 'rumble';
    if (this.isGuest) return 'surface';   // no physics on the guest, so no contacts to read
    let kind = null;
    for (const c of this.world.contacts) {
      const other = c.bi === m.body ? c.bj : c.bj === m.body ? c.bi : null;
      if (!other) continue;
      const name = other.material ? other.material.name : '';
      if (name === 'marble') { kind = kind || 'surface'; continue; }
      kind = name === 'rumble' || name === 'bump' || name === 'ice' ? name
        : name === 'obstacle' || name === 'spinner' ? 'obstacle' : 'surface';
      if (kind !== 'surface') break;
    }
    if (kind) { this._airT = 0; return kind; }
    this._airT += dt;
    return this._airT >= AIR_HOLD ? 'air' : this._surface;
  }

  // GFX #6 — your own top-10 crossing: a big confetti burst, a gold flash, a crowd roar and a kick
  // of camera shake. Every other finisher still gets the small per-marble confetti and chime.
  _celebrateOwnFinish(m, place) {
    if (this.demo || place < 1 || place > SCORE_TOP) return;
    this.scene.burstConfetti(m.mesh.position, 120);
    this.scene.pulseLight(m.mesh.position, 0xfde047, 2);
    this.audio.playRoar();
    window.PoImpact?.impact('win', 0.8);
  }

  // GFX #1 — the soundtrack's tension: how close the leader is to the line, plus whether you are
  // in the scoring places. PoMusicDirector dedupes small changes, so 10 Hz is fine.
  _setTension(place) {
    const md = window.PoMusicDirector;
    if (!md || !md.tension) return;
    const contention = place >= 1 && place <= SCORE_TOP ? 0.3 : place >= 1 && place <= SCORE_TOP * 2.5 ? 0.15 : 0;
    md.tension(0.15 + 0.45 * this._nearFinish + contention);
  }

  // Per-track record for the intro card's track buttons (F7). Local only; demo never counts.
  _recordTrackStat(place, time) {
    const all = readTrackStats();
    const st = all[this.map.id] || { races: 0, top10: 0, wins: 0, bestPlace: 0, bestTime: 0 };
    st.races++;
    if (place >= 1) {
      if (place <= SCORE_TOP) st.top10++;
      if (place === 1) st.wins++;
      if (!st.bestPlace || place < st.bestPlace) st.bestPlace = place;
      if (!st.bestTime || time < st.bestTime) st.bestTime = Math.round(time * 100) / 100;
    }
    all[this.map.id] = st;
    try { localStorage.setItem(TRACK_STATS_KEY, JSON.stringify(all)); } catch { }
  }

  _resolve() {
    this.audio.silenceBeds();
    const order = this.marbleSet.leaderboard();   // final standings — assigns place to every marble
    const me = this.marbleSet.marbles[this.chosen];
    // A marble that fell off the track has no placing: it neither finished nor holds a rank.
    // Reporting its last-known place scored the player a point for being eliminated, and an
    // elimination before the first standings pass left place at -1, which `place <= 3` also
    // counted as a win.
    const finished = !!me && me.finished && !me.eliminated;
    const place = finished ? me.place : -1;
    // Score for finishing anywhere in the top SCORE_TOP of the 101-marble field.
    const won = finished && place >= 1 && place <= SCORE_TOP;

    let gained = 0;
    if (won) {
      // Higher place = more points: 1st is worth SCORE_TOP, SCORE_TOP-th is worth 1.
      let base = SCORE_TOP - place + 1;
      // A dominant win — 1st and clear of 2nd by DOMINANT_GAP — is worth more again. This is
      // where finish TIME enters the score.
      if (place === 1 && order.length > 1 && order[1].finished &&
          (order[1].finishTime - me.finishTime) >= DOMINANT_GAP) {
        base += DOMINANT_BONUS;
      }
      this.streak += 1;
      const mult = 1 + Math.min(this.streak - 1, MAX_STREAK_STEPS) * 0.5;
      gained = Math.round(base * mult);
      this.score += gained;
      // MIRRORED IN C#: MarbleRaceRunVerifier re-adds these races with the same arithmetic, so a
      // change to the scoring above must land there too.
      const lead = place === 1 && order.length > 1 && order[1].finished ? order[1].finishTime - me.finishTime : 0;
      this.runRaces.push({ place, time: Math.round(me.finishTime * 1000) / 1000, lead: Math.round(lead * 1000) / 1000 });
    } else {
      // The run ends. A miss (finishing outside the top SCORE_TOP, or falling off) costs the
      // whole run — that's the stake that makes a streak worth watching.
      this.streak = 0;
      this.score = 0;
      this.runRaces = [];
    }
    if (this.score > this.best) { this.best = this.score; try { localStorage.setItem(BEST_KEY, String(this.best)); } catch { } }
    if (!this.demo) this._recordTrackStat(place, finished ? me.finishTime : 0);

    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    // #3 — the result grade, set AFTER _setPhase so it isn't overwritten by a phase grade.
    this._setGrade(won ? 'win' : 'loss');
    this.audio.playSting(won);
    if (!this.demo) window.PoMusicDirector?.verdict?.(won);
    this._sendTick(); // final standings
    // The run's races ride along (appended — positional contract) for the board submission.
    // Your own finish time rides along too (0 when you did not finish), offered as the map's
    // world record by the page.
    this._invoke('OnRaceResult', won, place, this.score, gained, this.streak, this.best, this.map.id,
      this.runRaces.map((r) => r.place), this.runRaces.map((r) => r.time), this.runRaces.map((r) => r.lead),
      finished ? Math.round(me.finishTime * 100) / 100 : 0);
    // Online host: the guest's standing, for the page to relay. Same top-SCORE_TOP rule, no
    // streak — the run/score system belongs to the host's own session.
    if (this.online && !this.isGuest) {
      const g = this.marbleSet.marbles[this.guestIndex];
      const gFinished = !!g && g.finished && !g.eliminated;
      const gPlace = gFinished ? g.place : -1;
      this._invoke('OnGuestResult', gFinished && gPlace >= 1 && gPlace <= SCORE_TOP, gPlace);
    }
  }

  // C# is handed primitives and parallel arrays rather than JSON strings on the hot paths. Colours
  // and names are omitted; C# derives them from the marble index (0 = the red player, the rest
  // from PACK_PALETTE).
  _invoke(method, ...args) {
    if (!this.dotnet) return;
    // invokeMethodAsync rejects asynchronously, so a bare try/catch here would never see the
    // failure — it has to be caught on the promise.
    try {
      const p = this.dotnet.invokeMethodAsync(method, ...args);
      if (p && p.catch) p.catch(() => { });
    } catch { }
  }

  _sendPodium() {
    if (!this.dotnet) return;
    const top3 = this.marbleSet.marbles
      .filter((m) => m.finished)
      .sort((a, b) => a.finishOrder - b.finishOrder)
      .slice(0, 3);
    const winTime = top3.length ? top3[0].finishTime : 0;
    const round2 = (v) => Math.round(v * 100) / 100;
    this._invoke('OnPodium',
      top3.map((m) => m.index),
      top3.map((m) => round2(m.finishTime)),
      top3.map((m) => round2(m.finishTime - winTime)));
  }

  // The HUD tick: the player's place and the field size are all the page draws mid-race.
  _sendTick() {
    if (!this.dotnet) return;
    const order = this.marbleSet.leaderboard();
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;

    // Overtake cue (GFX #10): compare the player's place against the last tick's before the
    // snapshot below overwrites it, and pan it to the marble that took part — the one just
    // behind you after a gain, the one just ahead after a loss.
    if (me && !me.eliminated && this.phase === 'racing' && me.prevPlace > 0 && me.place !== me.prevPlace) {
      const gained = me.place < me.prevPlace;
      const other = order[gained ? me.place : me.place - 2];
      this.audio.playOvertake(gained, other ? this.scene.audioCue(other.mesh.position) : null);
    }
    for (const m of order) m.prevPlace = m.place;

    const myPlace = me && !me.eliminated ? me.place : -1;
    if (this.phase === 'racing') this._setTension(this.demo ? -1 : myPlace);
    this._invoke('OnRaceTick', myPlace, order.length);
  }

  // ── Online ──

  // Host: stream the field to the guest. float32 x,y,z per marble in index order, one flag byte
  // per marble (0 live, 1 finished, 2 eliminated), plus the guest marble's place so the guest page
  // can show it without a simulation of its own.
  _netSend(dt) {
    this._netAccum += dt;
    if (this._netAccum < NET_INTERVAL) return;
    this._netAccum = 0;
    const ms = this.marbleSet.marbles;
    const pos = new Float32Array(ms.length * 3);
    const flags = new Uint8Array(ms.length);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const p = m.body.position;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      flags[i] = m.eliminated ? 2 : m.finished ? 1 : 0;
    }
    const order = this.marbleSet.leaderboard();
    const g = ms[this.guestIndex];
    this._invoke('OnHostFrame',
      ++this._netTick, Math.round(this.raceClock * 100) / 100, this.phase,
      new Uint8Array(pos.buffer), flags,
      g && !g.eliminated ? g.place : -1, order.length);
  }

  // Guest: a streamed snapshot from the host. Positions become easing targets (applied in
  // _guestRacingFrame), flags fire the same finish/elimination cues the host saw, and the first
  // racing frame is what starts the guest's race.
  applyFrame(tick, clock, phase, positions, flags, guestPlace, field) {
    if (!this.isGuest || !this.marbleSet) return;
    if (phase === 'racing' && this.phase === 'pick') this.pick(this.guestIndex);
    if (this.phase !== 'racing') return;
    const ms = this.marbleSet.marbles;
    // The interop layer hands a byte[] over as a Uint8Array; view it as the float32 it carries.
    const pos = new Float32Array(positions.buffer, positions.byteOffset, Math.floor(positions.byteLength / 4));
    for (let i = 0; i < ms.length && i * 3 + 2 < pos.length; i++) {
      const m = ms[i];
      if (m.eliminated) continue;
      if (!m.netTarget) {
        m.netTarget = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        m.body.position.set(m.netTarget.x, m.netTarget.y, m.netTarget.z);
      } else {
        m.netTarget.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      }
      const f = flags[i];
      if (f === 2) { this.marbleSet.eliminate(m); continue; }
      if (f === 1 && !m.finished) {
        m.finished = true;
        m.finishOrder = this._netFinish++;
        m.finishTime = clock;
        m.body.position.set(m.netTarget.x, m.netTarget.y, m.netTarget.z);
        this.scene.burstConfetti(m.mesh.position);
        this.audio.playFinish(this.scene.audioCue(m.mesh.position));
        if (m.finishOrder === 0 && m === this._lastFocus) this.scene.photoFinish();
        if (m.index === this.guestIndex) this._celebrateOwnFinish(m, m.finishOrder + 1);
      }
    }
    this.raceClock = clock;
    this._guestHud = { guestPlace, field };
  }

  // Guest: no physics. Ease every live marble toward its streamed target, fake the roll from the
  // distance covered, then run the same progress/sync/camera/HUD path as the host's frame.
  _guestRacingFrame(dt) {
    const k = Math.min(1, dt * NET_SMOOTH);
    const inv = 1 / Math.max(dt, 1e-3);
    for (const m of this.marbleSet.marbles) {
      if (m.eliminated || m.finished || !m.netTarget) continue;
      const p = m.body.position;
      const dx = (m.netTarget.x - p.x) * k, dy = (m.netTarget.y - p.y) * k, dz = (m.netTarget.z - p.z) * k;
      p.x += dx; p.y += dy; p.z += dz;
      // sync() reads speed off the body's velocity; derive it from the easing step.
      m.body.velocity.set(dx * inv, dy * inv, dz * inv);
      // A rolling sphere turns by distance/radius about the axis perpendicular to its travel.
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1e-4) {
        _rollAxis.set(dz, 0, -dx);
        if (_rollAxis.lengthSquared() > 1e-8) {
          _rollAxis.normalize();
          _rollQ.setFromAxisAngle(_rollAxis, dist / m.radius);
          _rollQ.mult(m.body.quaternion, m.body.quaternion);
        }
      }
    }
    this.marbleSet.updateProgress(this.track);
    this.marbleSet.sync(this.track, this.scene.camera.position, this._leaders);
    for (const p of this.track.paddles) { p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion); }

    const order = this.marbleSet.leaderboard();
    const leaderNow = order[0];
    const nearRaw = leaderNow ? 1 - Math.max(0, Math.min(1, (this.track.finishS - leaderNow.s) / 300)) : 0;
    this._nearFinish = Math.pow(nearRaw, 0.6);
    const rolling = this._lastFocus || leaderNow;
    this.audio.updateBeds(rolling ? rolling.speed : 0, this._nearFinish, true, this._surfaceOf(rolling, dt));
    this._setGrade(this.marbleSet.progress() >= 0.86 ? 'final' : 'racing');

    const focus = this._pickShot(order);
    if (focus) {
      const fs = focus.s;
      const anchor = _camAnchor.copy(focus.mesh.position).lerp(this.track.centerAt(fs, _camRoad), ROAD_BIAS);
      this.scene.followTarget(anchor, dt, focus !== this._lastFocus, this.track.dirAt(fs), focus.speed);
      this._lastFocus = focus;
    }
    this._leaders = this._topRivals(order);
    this._checkSectors();

    this.tickAccum += dt;
    if (this.tickAccum >= TICK_INTERVAL) { this.tickAccum = 0; this._sendGuestTick(order); }
  }

  // Guest: the HUD tick, with the guest marble's place taken from the host's frame rather than
  // measured here. Same OnRaceTick contract as _sendTick.
  _sendGuestTick(order) {
    if (!this.dotnet) return;
    const h = this._guestHud || {};
    const place = h.guestPlace ?? -1;
    this._setTension(place);
    this._invoke('OnRaceTick', place, h.field || order.length);
  }

  // Guest: the host resolved the race. Mirror _resolve's presentation without its scoring.
  guestResult(won) {
    if (!this.isGuest || this.phase !== 'racing') return;
    this.audio.silenceBeds();
    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    this._setGrade(won ? 'win' : 'loss');
    this.audio.playSting(!!won);
    window.PoMusicDirector?.verdict?.(!!won);
  }

  // Guest: the host has moved on to the next race, on this seed.
  nextTrack(seed) {
    if (!this.isGuest) return;
    this._nextTrack(seed >>> 0);
  }

  _bindKeys() {
    this._keyHandler = (e) => {
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.regenerate(); }
      // M was documented as the mute key but was never actually bound to anything, and the
      // only other caller (a Settings drawer) had been deleted — so mute was unreachable.
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); this.audio.toggleMuted(); }
      // Held-key steering: keydown starts the hold (auto-repeat re-sets the same flag, which
      // is idempotent), keyup below ends it.
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); this.setSteer(-1, true); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); this.setSteer(1, true); }
    };
    this._keyUpHandler = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { this.setSteer(-1, false); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { this.setSteer(1, false); }
    };
    // Losing focus (alt-tab, click away) has no keyup, so release steering here or the marble
    // keeps drifting into the wall with nothing held.
    this._blurHandler = () => { this._steerLeft = this._steerRight = false; };
    window.addEventListener('keydown', this._keyHandler);
    window.addEventListener('keyup', this._keyUpHandler);
    window.addEventListener('blur', this._blurHandler);
  }
  _unbindKeys() {
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    if (this._keyUpHandler) window.removeEventListener('keyup', this._keyUpHandler);
    if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
  }
}
