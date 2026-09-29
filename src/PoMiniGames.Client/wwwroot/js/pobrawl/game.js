// game.js — PoBrawl match orchestrator.
// Owns: scene, camera, fixed-timestep sim, per-fighter state machine, momentum +
// per-region damage + hit-pause + screen shake + cinematic camera + replay buffer,
// audio bus, and the Blazor interop callbacks.
import * as THREE from 'three';
import { buildArena, animateCrowd, updateAtmosphere, updateRopes, updateBanners, twangRope, damagePost, disposeArenaReflector, RING_HALF } from './arena.js';
import { buildProps, resetProps, updateProps, disposeProps } from './props.js';
import { buildFighter, updateJiggles, setExpression, CHARACTERS, CHARACTER_IDS } from './fighters.js';
import { Animator } from './animation.js';
import { KeyboardController } from './input.js';
import { AiController } from './ai.js';
import { RandomGenerator } from './rng.js';
import { CombatPlay, REGIONS, regionEffect } from './combat.js';
import { PERSONALITIES, makePersonalityState } from './personalities.js';
import * as PostFx from '../postFx.js';
import * as VisualRuntime from '../visualRuntime.js';
import * as Quality from './quality.js';
import { AudioBus } from './audio.js';
import { ReplayBuffer } from './replay.js';
import { CannonRagdoll } from './ragdollPhysics.js';
import {
  createPhysicsWorld, stepWorld, buildArenaColliders,
  buildFighterPhysics, syncHurtSpheres, syncRigRoot,
  buildSwingPhysics, syncStrikerSpheres, destroySwingPhysics,
  G_HURT, G_STRIKER,
} from './physics.js';
// ── Subsystem mixins (2026-08-11 audit #9) ──────────────────────────────────
// BrawlGame was one 5,400-line class. These modules hold its personality/super
// system, its transient VFX layer, its KO-sequence + camera code and (since
// 2026-09-23) the whole hit-resolution pipeline, mixed into the prototype below so
// `this` and every call site are unchanged. mixin.js explains why prototypes
// rather than free functions or Object.assign.
import { mixin } from './mixin.js';
import { PersonalityEffects } from './personalityEffects.js';
import { Vfx } from './vfx.js';
import { Cinematics } from './cinematics.js';
import { HitResolution } from './hitResolution.js';
import { Training } from './training.js';
import { SIM_DT, MAX_HP, ATTACKS, HEAVY_HIT_DMG } from './constants.js';
import { SceneSetup, ENV_INTENSITY } from './sceneSetup.js';
// GFX/SOUND top-10 pass (2026-09-23): each a self-contained module the engine
// drives, rather than more methods on an already very large class.
import { GamepadBridge } from './gamepad.js';
import { MatWear } from './matWear.js';
import { NewsDesk } from './news.js';
import { KoClipRecorder } from './clip.js';
import { NetController, Netplay } from './netplay.js';
import { Commentary } from './commentary.js';

const MAX_FRAME_DT = 0.05;

// The app-wide reduced-motion flag (user toggle OR OS preference), stamped by
// appPrefs.js on <html data-motion="reduce">. This is the ONLY switch left
// after the per-game comfort panel was removed (2026-09-23): gore is always on
// and the calm presentation follows the platform setting alone.
function motionReduced() {
  try {
    return document.documentElement.getAttribute('data-motion') === 'reduce';
  } catch {
    return false;
  }
}

// One round, sixty seconds. The UI and end condition now read as a countdown
// from 60 down to 0, but the raw engine clock still tracks elapsed fight time
// so KO / timeout decisions and replay capture remain stable.
const TIME_LIMIT = 60;

// Lateral orbit speed for the circle keys, in the same units as the 2.4 / 1.9
// forward / backward walk. Slightly under the advance so that closing distance
// is still the faster way to cross the ring and circling reads as positioning
// rather than a second, better run.
const CIRCLE_SPEED = 2.0;

// How close the two health bars have to be at TIME! for the decision to be a
// draw rather than a win, in HP points out of MAX_HP (100) — so this reads as
// "within a tenth of a bar".
//
// It is a band, not an exact tie. An exact-equal-HP requirement is what the old
// rule effectively had, and it made draws unreachable: two fighters who traded
// for a minute land a couple of points apart, and awarding that the full win
// misrepresents a fight nobody won. Ten points is roughly one clean hit, which
// is the smallest margin a player can actually see on the bars.
const DRAW_HP_BAND = 10;

// ── Spawn X by HUD side ────────────────────────────────────────────────────
// Each fighter spawns at the X that lines up with the side their energy bar
// is drawn on by the Blazor HUD:
//   • index 1 → HUD `.pb-hp-side` (no right class) → renders on the LEFT
//   • index 2 → HUD `.pb-hp-side.pb-hp-right`     → renders on the RIGHT
// The world-space spawn X mirrors that screen side: negative X projects to
// the left of the camera (which sits at +Z looking toward −Z), positive X
// projects to the right. Single source of truth — change here, not in
// `_spawnFighters`, so the spawn and the HUD can never desync.
const SPAWN_X_BY_SIDE = { left: -1.6, right: 1.6 };

// ── Overhead house light swing ────────────────────────────────────────────
// The ring spotlight (arena.js `lights.spot`) sweeps a wide elongated
// ellipse over the ring (mostly along Z, with a smaller X amplitude and a
// pronounced vertical bob), aimed down at the midpoint between the fighters.
// The pool of light, the cast shadows and the volumetric shaft therefore all
// sweep visibly back and forth across the canvas — the rig lamp is no longer
// nailed above the centre, it swings like a hanging studio fixture. See the
// "Room light swing" block in _updateLighting.
const HOUSE_LIGHT_RADIUS = 4.4;              // wide Z swing (was 2.6)
const HOUSE_LIGHT_RADIUS_X = 1.6;            // narrower X swing for an ellipse, not a circle
const HOUSE_LIGHT_BOB = 1.8;                 // vertical bobbing amplitude
const HOUSE_LIGHT_HEIGHT = 11;
const HOUSE_LIGHT_SPEED = (Math.PI * 2) / 12; // rad/s — one lap per ~12 s (was 26)

const MIN_SEPARATION = 0.95;

// The frame-data table (ATTACKS) and HEAVY_HIT_DMG are in constants.js, because
// hitResolution.js reads them too. The block / perfect-guard / counter economy,
// dismemberment thresholds and hit-pause ceiling moved to hitResolution.js with the
// only code that reads them (2026-09-23).

const HITSTUN = 0.35;

// ── Hold-to-charge (Urban Champion style) ────────────────────────────────
// Press-and-hold punch/kick winds the attack up; release throws it. Charge
// scales damage/knockback from a quick tap (1x) to a full hold (CHARGE_MAX_MUL)
// over CHARGE_TIME seconds. Held attacks are intentionally a huge upgrade over
// quick taps, so the timing reward is clear and the choice to commit to a full
// charge feels meaningful.
const CHARGE_TIME = 1.0;
const CHARGE_MAX_MUL = 4.0;


// ── Energy meter ─────────────────────────────────────────────────────────
// One 0..1 pool per fighter — the blue bar under the HP bar in the Blazor HUD.
// It is BOTH how hard this fighter's strikes land and whether they are allowed
// to throw one at all.
//
// 2026-09-12 rework (user request: "make blocking more rewarded and pure
// offensive a bad strategy"). The old pool was filled by the wind-up itself and
// emptied in full on release, which made offence free: an attack at an empty
// bar was still a legal attack at the 1x multiplier, so mashing punch threw
// unlimited weak strikes forever and there was no reason to ever stop swinging.
// "Holding the attack button refills the bar" is also flatly incompatible with
// "throwing lots of punches drains the bar", so the wind-up no longer creates
// energy — it SPENDS it:
//
//   • winding up drains the pool into the strike (chargeAmt), so the coil is
//     paid for out of the bar and the bar visibly empties as you load up;
//   • releasing costs a further flat ATTACK_ENERGY_COST, which is what taxes
//     tap-spam — a jab banks almost no charge but still pays the toll;
//   • dropping under the floor GASSES the fighter: no punch, no kick, at all,
//     until they have recovered back up to ENERGY_RECOVER_TO (see _canAttack);
//   • blocking refills it fast, idling refills it slowly, and swinging refills
//     it not at all.
//
// The net effect is that a pure-offence rush runs itself out of the ability to
// fight inside a few seconds and then stands there defenceless, while guarding
// is how a fighter buys the power for the next exchange.
// Both fighters come out of the corner fresh. The old 1/3 bank made sense when
// the wind-up REFILLED the bar (you were expected to charge it up yourself);
// now that attacking is what drains it, opening at 1/3 would gas a fighter out
// after two jabs before the round had really started. A full bar is worth
// roughly four spammed punches, or one fully committed haymaker.
const ENERGY_DEFAULT = 1.0;

// Flat toll charged on every swing release, on top of whatever the wind-up
// already drained. This is the anti-spam term: at 0.22 a fighter who only ever
// taps gets roughly four KICKS from a full bar before gassing out, and the idle
// regen below cannot keep up with continuous mashing. Each attack scales it by
// its own `energyMul`, so a punch pays half (≈ eight jabs to a bar) — see the
// ATTACKS table for why the two buttons are priced apart.
const ATTACK_ENERGY_COST = 0.22;

// Hysteresis band for the gate. Falling below ENERGY_ATTACK_FLOOR sets the
// gassed flag; clearing it needs ENERGY_RECOVER_TO, which is deliberately
// higher so an exhausted fighter cannot chip out one more jab the instant a
// single frame of regen lands. That gap is the punishment window.
const ENERGY_ATTACK_FLOOR = 0.22;
const ENERGY_RECOVER_TO = 0.40;

// Regen, as a fraction of a full bar per second, by state. Blocking is ~3.4x
// idle: guarding is the deliberate, rewarded way back into the fight, which is
// the whole point of the rework. Swinging (the punch/kick states) regenerates
// nothing — you do not catch your breath mid-combination. The KO state is
// exempt entirely; a bar still moving behind the K.O. banner reads as a bug.
const ENERGY_REGEN_PER_SEC = 0.16;
const ENERGY_BLOCK_REGEN_PER_SEC = 0.55;
const ENERGY_HITSTUN_REGEN_PER_SEC = 0.08;



// ── Hit feedback (damage numbers + combo readout) ────────────────────────
// A combo is a run of landed hits with no more than COMBO_WINDOW between
// them. It is deliberately longer than HITSTUN (0.35 s): hitstun is how long
// the defender is *locked*, and requiring the next hit inside that window
// would only ever count true frame-traps, which this engine's charge-and-
// release rhythm essentially never produces. 1.1 s reads as "kept the
// pressure up", which is the thing worth showing the player.
const COMBO_WINDOW = 1.1;
// A combo only surfaces at 2+; a "1 HIT" badge on every jab is noise.
const COMBO_MIN_SHOWN = 2;
// Hard ceiling on live damage-number nodes. A full-charge flurry can land
// several hits inside one animation lifetime, and on a phone the compositor
// cost of unbounded absolutely-positioned text is real. Oldest is evicted.
const MAX_DAMAGE_NUMBERS = 14;

// VS splash hold (#8). resetMatch always used 1300 ms; the first match of an
// engine now opens on the same splash, so the figure lives in one place.
const SPLASH_HOLD_MS = 1300;

// Half-width of the ring canvas (arena.js builds it as an 11.6 m box). The mat
// wear map (#7) spans exactly this, so its texels land where the vinyl is.
const MAT_HALF = 5.8;

// Danger state (#4): below this share of max HP a fighter is "in the red"; the
// effect is full strength DANGER_RAMP below it.
const DANGER_HP = 0.25;
const DANGER_RAMP = 0.2;

// The view-transition pseudo-elements live on the document root, which a
// Blazor-scoped stylesheet cannot reach, so the timing for the #8 name flight is
// injected once, globally. Namespaced to pb-name-* and harmless when unused.
function ensureViewTransitionStyle() {
  if (document.getElementById('pb-vt-style')) return;
  const st = document.createElement('style');
  st.id = 'pb-vt-style';
  st.textContent = `
    ::view-transition-group(pb-name-1),
    ::view-transition-group(pb-name-2) {
      animation-duration: 0.62s;
      animation-timing-function: cubic-bezier(.2, .9, .2, 1);
    }
    ::view-transition-old(pb-name-1), ::view-transition-new(pb-name-1),
    ::view-transition-old(pb-name-2), ::view-transition-new(pb-name-2) {
      height: 100%;
      animation-duration: 0.62s;
    }`;
  document.head.appendChild(st);
}


// Scratch vector for the blob-shadow tracker.
const _blobPos = new THREE.Vector3();
// Scratch vectors for contact-impulse resolution.
const _dmgProj = new THREE.Vector3();
// Scratch vectors for the lighting updater.
const _spotTarget = new THREE.Vector3();
const _blDir = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const _upY = new THREE.Vector3(0, 1, 0);
// Scratch vectors for posture (look-at / momentum) updates.
const _animVel = new THREE.Vector3();
const _lookA = new THREE.Vector3();
const _lookB = new THREE.Vector3();

export class BrawlGame {
  constructor(container, dotnetRef, options) {
    this.container = container;
    this.dotnet = dotnetRef;
    this.options = options;
    this.muted = false;
    this.disposed = false;
    this.raf = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.timeScale = 1;
    // Effects list — sparks, debris, post chunks. Updated each render tick.
    this.effects = [];
    // Renderer-level feedback: hit-pause, screen shake, FOV punch.
    this.hitstopT = 0;
    this.shakeT = 0;
    this.shakeAmp = 0;
    this.fovPunch = 0;
    this.fovBase = 55;
    // Post-FX pulses: bloom strength, chromatic aberration, radial blur and
    // exposure spike on hits and KO, then decay exponentially in _updateFx.
    this.caPulse = 0;
    this.bloomPulse = 0;
    this.exposurePulse = 0;
    this.radialPulse = 0;
    // Clash (striker-vs-striker) debounce.
    this._clashCooldown = 0;
    // Spring-damper camera state (see _updateCamera).
    this._camVel = new THREE.Vector3();
    // KO "lights down" blend (0 = house lights, 1 = spotlight-only).
    this.lightsDim = 0;
    // Atmosphere clock — always advances (this.clock only runs while fighting).
    // Driven by the RENDER loop, so it is wall-clock seconds, not sim seconds.
    this.atmoT = 0;
    // ── Simulation clock ────────────────────────────────────────────────
    // Monotonic seconds accumulated in _tick, the fixed-step sim tick. This is
    // the "now" that every timed personality effect is written against:
    // `per.modeExpiresAt = this.t + cfg.durationSecs`, `this.t < per.iframesUntil`,
    // `_inputBlindUntil`, `lbjMissKBUntil`, Ford's stumble/retaliate windows,
    // JFK's dash, FDR's startup boost, and the super meter's prompt window.
    //
    // It was never declared and never assigned. Roughly forty sites read it, so
    // every one of them was evaluating against `undefined`: the comparisons
    // (`this.t < X`) were uniformly false and the arithmetic (`this.t + X`)
    // produced NaN, which then made its own comparisons false as well. The net
    // effect was that no timed personality effect in the game had ever applied —
    // including every signature super, which is why the feature looked inert
    // even after the meter and the input path were connected.
    //
    // Deliberately NOT reset between rounds: it only has to be monotonic, and
    // per-round state is rebuilt by makePersonalityState on respawn anyway.
    // Advancing on the sim tick rather than alongside atmoT keeps effect
    // durations in step with the simulation that consumes them — hitstop pauses
    // both together instead of letting buffs bleed out during a frozen frame.
    this.t = 0;
    // The PA's ring introduction for the next splash (PoBrawlPage fetches it; PoBrawl.next
    // hands in the next rung's). One-shot: _introHold speaks it and clears it.
    this._introLine = (options && options.introLine) || null;
    // Cinematic state: KO zoom + replay buffer.
    this.cameraMode = 'normal'; // 'normal' | 'ko' | 'replay'
    this.cameraModeT = 0;
    this.koShot = 'side'; // per-KO camera variant: 'side' | 'overhead'
    this.replayT = 0;
    this.excited = 0; // crowd excitement
    this.audio = new AudioBus();
    this.replay = new ReplayBuffer();
    // Seeded RNG: pass options.seed to reproduce a match. Without one, every page load
    // used to fall back to the same 1337, so the "random" news headlines, KO shots and
    // demo pairings replayed identically on every visit (2026-09-29).
    this.rng = new RandomGenerator((options && options.seed) || (1 + Math.floor(Math.random() * 0x7ffffffe)));
    // The training room (training.js). A demo rolls its drills per match in
    // start()/resetMatch. The comfort switches went with their panel — gore is
    // always on and calm follows motionReduced() above.
    this.training = options && options.training && options.mode === '1p'
      ? this._makeTraining(options.training)
      : null;
    // GFX quality is pinned to the maximum tier (MSAA×4 + GTAO + bloom + CA).
    // The auto-stepdown and the on-screen "FX" tier badge were removed per user
    // request — the game always renders at full quality regardless of framerate.
  }

  start() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 540;

    // ── Audio-reactive HUD (GFX/SOUND #8) ────────────────────────────────
    // visualRuntime.js has published --audio-bass/mid/treble/peak since it was
    // written, but `_audioReactive` defaults to FALSE and nothing in the app
    // had ever called this — the analyser pump was dead code and every
    // stylesheet reading those variables was reading an unset value. Switched
    // on here (and off again in dispose) so the cost is paid only by the page
    // that consumes it, which is the contract that module documents.
    try { VisualRuntime.enableAudioReactive(true); } catch { /* never block the game on chrome */ }

    // antialias:false is deliberate. Every frame is rendered into the
    // composer's own MSAA target (see _buildComposer) and reaches the canvas
    // as a fullscreen quad in OutputPass — a quad has no interior edges, so a
    // multisampled default framebuffer would be allocated and never resolved
    // against any geometry. The `samples` on composerRT is the real AA.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    // Tier-aware DPR through the SHARED pixel budget (quality.js → PoCanvasDpr.resolve).
    // This used to be PoCanvasDpr.ceiling(), which applies no total-pixel cap at all —
    // see the note on Quality.pixelRatio for what that cost on a large window.
    this.renderer.setPixelRatio(Quality.pixelRatio(w, h));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    // PCFSoft: percentage-closer soft edges — the fighters' shadows get a
    // real penumbra instead of the stepped PCF look.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // AgX handles saturated bright lights (bloom pulses, colored corner
    // accents) far more gracefully than ACES, which skews hot colors.
    // Measured against ACES/Neutral/Reinhard on a live frame: AgX keeps ~15%
    // of pixels in the midtones where the others crush 95-98% into shadow.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    // Contrast comes from the lighting ratio (key vs hemisphere fill), NOT from
    // exposure — exposure lifts shadows and highlights together, so pushing it
    // just makes a flat image a brighter flat image. Measured: at 1.9 the frame
    // went 99.8% midtones with 0% shadows, visibly worse than 1.15. The real
    // lever is the hemisphere cut + hotter key in arena.js; exposure only takes
    // the small step needed to keep overall level after that cut.
    //
    // Was bumped 1.3 → 1.5 when the IBL fill was removed, because the rig then
    // had to carry the full ambient level alone. #1 puts a (much dimmer,
    // arena-coloured) environment back, so the compensation comes back off —
    // leaving exposure at 1.5 on top of env fill would re-flatten exactly the
    // contrast the hemisphere cut was protecting. Tied to ENV_INTENSITY so the
    // two can never drift: zero the env and the exposure returns on its own.
    this.exposureBase = ENV_INTENSITY > 0 ? 1.36 : 1.5;
    this.renderer.toneMappingExposure = this.exposureBase;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // ── IBL (GFX/SOUND #1) ──────────────────────────────────────────────
    // Re-added 2026-08-09 by request, but NOT the way it was before.
    //
    // History matters here: IBL was removed once already because
    // RoomEnvironment's bright white boxes laid softbox speculars over
    // everything and washed the hall out. Handing a PBR renderer a generic
    // studio and hoping is what failed — not image-based lighting itself.
    //
    // What goes in now is an environment built FROM this arena's own palette
    // (see _buildEnvironment): a dark hall, one warm pool overhead where the
    // house light actually hangs, cool bounce off the canvas below, and the
    // red/blue corner accents in the right places. The wardrobe's sheen and
    // clearcoat lobes finally have something to reflect, and what they reflect
    // is the room they are standing in.
    //
    // Held well under 1 so it fills rather than lights. Set ENV_INTENSITY to 0
    // to get the pre-2026-08-09 look back — nothing else needs changing.
    this._buildEnvironment();
    // Light COUNT is fixed at boot from the tier — it is a shader #define, so it
    // cannot track live tier changes without recompiling every material. Shadow map
    // sizes and the post chain are retuned live in _applyQuality below.
    this.arena = buildArena(this.scene, { rectAreaLights: Quality.settings().rectAreaLights });
    // #10 — before _applyTextureAnisotropy, so the jumbotron canvas texture it
    // installs gets filtered along with everything else.
    this._initReactiveArena();

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100);
    this.camera.position.set(0, 2.4, 7);

    // Post chain: render → GTAO → bloom → CA/vignette → tone-map/sRGB
    // output (see _buildComposer).
    this._buildComposer(w, h);

    // GPU particle pool: one THREE.Points draw call for every spark, sweat
    // droplet and confetti fleck (the old system built a SphereGeometry mesh
    // per spark). Additive blending means "fade" is just color → black, so
    // no per-particle alpha attribute is needed.
    this._initParticles();

    // Pooled shock rings + the flat-silhouette / speedline / smear timers (#3).
    this._initImpactFrames();

    // Impact light pool: reused PointLights flashed at hit points. A fixed
    // pool keeps the scene's light count constant (adding/removing lights at
    // runtime forces shader recompiles).
    this._impactLights = Array.from({ length: 3 }, () => {
      const light = new THREE.PointLight(0xffa050, 0, 5, 2);
      this.scene.add(light);
      return { light, life: 0, dur: 0.15, peak: 0 };
    });
    this._impactCursor = 0;

    // Per-fighter backlights: cool kicker spots behind each fighter, opposite
    // the camera — constant halo separation from the dark background.
    // Repositioned every frame in _updateLighting.
    this._backlights = [0, 1].map(() => {
      const s = new THREE.SpotLight(0x7d95ff, 3.0, 14, Math.PI / 5, 0.85, 1.6);
      s.castShadow = false;
      this.scene.add(s);
      this.scene.add(s.target);
      return s;
    });

    // ── KO Limelight: tight, narrow SpotLight that tracks the ragdoll ──
    // Used during the KO cinematic to follow the falling body and offer
    // that "single bright slash of light over the loser" feel. Intensity
    // starts at 0; spikes to ~6.0 on a KO event and tracks the loser's
    // torso each frame while d > 0.
    this._limelight = new THREE.SpotLight(0xfff0d0, 0, 9, Math.PI / 9, 0.7, 1.0);
    this._limelight.castShadow = false;
    this.scene.add(this._limelight);
    this.scene.add(this._limelight.target);
    this._limelightActive = 0; // 0 = idle, >0 = active timeleft
    this._limelightTarget = new THREE.Vector3();

    // Companion cool "victor halo" — opposite-side kicker that follows the
    // WINNER while the loser has the warm limelight. Together they light
    // both fighters from different angles during the KO cinematic.
    this._victorHalo = new THREE.SpotLight(0xa0c4ff, 0, 12, Math.PI / 6, 0.7, 1.2);
    this._victorHalo.castShadow = false;
    this.scene.add(this._victorHalo);
    this.scene.add(this._victorHalo.target);

    this.banner = document.createElement('div');
    this.banner.className = 'pb-banner';
    this.container.appendChild(this.banner);

    // CSS overlay for chromatic aberration / vignette flash on KO.
    this.flash = document.createElement('div');
    this.flash.className = 'pb-flash';
    this.container.appendChild(this.flash);

    // Floating hit feedback: damage numbers rising off the contact point and a
    // per-fighter combo readout. DOM rather than sprites on purpose — these are
    // screen-space text that must stay crisp and theme-independent, and routing
    // them through three.js would mean a texture atlas and a draw call per
    // number for something the compositor already does for free.
    this.fx = document.createElement('div');
    this.fx.className = 'pb-fx';
    this.fx.innerHTML = `
      <div class="pb-combo pb-combo--p1"><span class="pb-combo__n"></span><span class="pb-combo__label">HIT</span></div>
      <div class="pb-combo pb-combo--p2"><span class="pb-combo__n"></span><span class="pb-combo__label">HIT</span></div>`;
    this.container.appendChild(this.fx);
    this._comboEls = [
      this.fx.querySelector('.pb-combo--p1'),
      this.fx.querySelector('.pb-combo--p2'),
    ];
    this._dmgNodes = [];
    // Ringside commentary + the caption bar every spoken line goes through (commentary.js).
    this._initCommentary();

    // Virtual touch controls for coarse-pointer / portrait-mobile layouts
    // (CSS decides visibility). Buttons dispatch synthetic KeyboardEvents,
    // so the P1 KeyboardController — including hold-to-charge and the
    // tap-vs-hold block key — works unchanged. Demo mode is CPU vs CPU,
    // so no controls there.
    const spectating = this.options.mode === 'online' && !this.options.localSide;
    if (this.options.mode !== 'demo' && !spectating) this._buildTouchControls();

    // #2 — controllers drive the same key codes as the keyboard (gamepad.js).
    // 1P: the first pad is player 1. 2P: first pad P1, second P2. Demo: none.
    if (this.options.mode !== 'demo') {
      this.gamepads = new GamepadBridge(this.options.mode === '2p' ? [1, 2] : [1]);
    }

    // #9 — the Breaking News result package (news.js).
    this.news = new NewsDesk(this.container, {
      onSaveClip: () => this.saveClip(),
      demo: this.options.mode === 'demo',
    });

    // #10 — rolling KO clip (clip.js). Not in demo (nobody to hand it to), not
    // in the training room (no KO), not on the low tier (encoding costs frames).
    if ((this.options.mode === '1p' || this.options.mode === '2p' || this.options.mode === 'online') && !this.training
        && Quality.tier() !== 'low') {
      this.clip = new KoClipRecorder(this.renderer.domElement, () => this.audio.tapStream());
      if (this.clip.ok) this.clip.start(); else this.clip = null;
    }

    // Inter-round splash. Created once; reused via _showSplash() so the
    // browser doesn't pay the cost of mounting a new DOM node every match.
    this.splash = document.createElement('div');
    this.splash.className = 'pb-splash';
    // #8 (2026-09-23): a fight-card layout — two foil-edged name cards slam in
    // from either side and meet at a spinning seal. The name spans keep their
    // classes (and so their _showSplash wiring); they are also what the View
    // Transition in _hideSplash flies up into the HUD.
    this.splash.innerHTML = `
      <div class="pb-splash__inner">
        <div class="pb-splash__round"></div>
        <div class="pb-splash__cards">
          <div class="pb-splash__card pb-splash__card--p1"><span class="pb-splash__p1"></span></div>
          <div class="pb-splash__seal" aria-hidden="true"><span class="pb-splash__versus">VS</span></div>
          <div class="pb-splash__card pb-splash__card--p2"><span class="pb-splash__p2"></span></div>
        </div>
      </div>`;
    this.container.appendChild(this.splash);
    this._splashHide = 0; // wall-clock at which the splash should fade out

    this._onResize = () => {
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      if (!cw || !ch) return;
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      // The pixel budget is a function of the CSS size, so a resize can change the
      // resolved DPR even though the tier has not moved — a window dragged from a
      // quarter of the screen to fullscreen is exactly the case the budget exists
      // for, and re-resolving here is what keeps it enforced after boot.
      this.renderer.setPixelRatio(Quality.pixelRatio(cw, ch));
      this.composer.setPixelRatio(Quality.pixelRatio(cw, ch));
      this.renderer.setSize(cw, ch);
      this.composer.setSize(cw, ch);
      // BokehPass owns render targets sized independently of the composer's;
      // without this its depth buffer keeps the old aspect and the blur skews.
      if (this.rackFocus) this.rackFocus.setSize(cw, ch);
    };
    window.addEventListener('resize', this._onResize);

    // Track the measured tier for the rest of the match. visualRuntime's monitor
    // is already running (PoBrawl itself starts it via enableAudioReactive above,
    // and the module self-starts on import), so this is a live signal, not a
    // one-shot read of a value that never moves.
    this._offTierChange = Quality.onTierChange(() => {
      if (this.disposed) return;
      this._applyQuality();
    });
    // Seed from the boot tier. Shadow sizes and post-pass enables built above use
    // the same settings object, so this is normally a no-op — it matters when the
    // tier has ALREADY dropped during Blazor boot, before the engine started.
    this._applyQuality();

    // Build the physics world before spawning fighters — per-fighter bodies
    // (kinematic rig-root + dynamic hurt spheres) are created in _spawnFighters.
    this._physics = createPhysicsWorld();
    this._setupPhysicsCollisions();
    // Static post/rope colliders — only the KO ragdoll interacts with them.
    buildArenaColliders(this._physics.world, this._physics.materials);
    // Destructible corner crates + debris (props.js). The hooks let the module
    // deal chip damage / spawn impact FX back through the engine.
    this._propHooks = this._makePropHooks();
    this.props = buildProps(this._physics.world, this._physics.materials, this.scene);
    // A demo match is sometimes a training drill instead (training.js).
    if (this.options.mode === 'demo') this.training = this._rollDemoDrill();
    this._spawnFighters(this.options.p1Character, this.options.p2Character);
    this._initTraining();
    if (this.options.mode === 'online') this._initNet();
    // Textures are built by arena.js/fighters.js as module-level cached
    // singletons with no renderer handle, so none of them could set anisotropy
    // themselves — every map was sampling at 1x. Apply it once here, after the
    // first arena+fighter build has created them; later rounds reuse the same
    // cached texture objects and stay filtered.
    this._applyTextureAnisotropy();
    // #8 — the first match opens on the VS splash too (it used to be reserved for
    // resetMatch, so the very first fight — the one a new player sees — started
    // cold on "3"). Training skips it: the room is for getting straight to work.
    // The warm-up goes FIRST on the splash path, as it does in resetMatch: it
    // blocks the main thread for the whole shader compile, and a splash timer
    // armed before it would spend its hold behind that stall and close unseen.
    if (this.training) {
      this._startCountdown();
      this._warmupRender();
    } else {
      this._warmupRender();
      this._beginWithSplash(this.fighters[0].charId, this.fighters[1].charId,
        this.options.mode === '2p' ? 'ONE ROUND · 60 SECONDS'
          : this.options.mode === 'demo' ? 'EXHIBITION'
          : this.options.mode === 'online' ? (spectating ? 'LIVE · SPECTATING' : 'ONLINE · 60 SECONDS')
          : 'MAIN EVENT');
    }

    // Kick the audio context the first time the user interacts with the page —
    // .razor lifecycle alone doesn't always satisfy autoplay policy.
    const resumeAudio = () => {
      this.audio.resume();
      this.audio.startMusic();
      // #6 — the hall bed can only start once the context is unsuspended;
      // starting looping sources on a suspended context leaves them silently
      // stalled and they never recover on resume.
      this.audio.startCrowd();
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
    };
    window.addEventListener('pointerdown', resumeAudio);
    window.addEventListener('keydown', resumeAudio);
    // M mutes the fight. No binding in any layout uses M, and a focused text field keeps it.
    this._onMuteKey = (e) => {
      if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      this.setMuted(!this.muted);
      this._caption(this.muted ? '🔇 Muted (M)' : '🔊 Sound on (M)');
    };
    window.addEventListener('keydown', this._onMuteKey);

    this.lastFrame = performance.now();
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = (now - this.lastFrame) / 1000;
      // Floored at 0: a rAF timestamp can predate `lastFrame` when _warmupRender stamped it from
      // performance.now() after a long shader compile (or a background tab delivers a stale frame
      // time). A negative dt drove the accumulator seconds below zero and froze the sim until it
      // climbed back — measured at 11 s on a software-GL client, with the online fight running on.
      let dt = Math.max(0, Math.min(rawDt, MAX_FRAME_DT));
      this.lastFrame = now;

      // #2 — sample the pads before the sim so a press lands on this frame's tick.
      if (this.gamepads) this.gamepads.poll();
      this.accumulator += dt * this.timeScale;
      while (this.accumulator >= SIM_DT) {
        this.accumulator -= SIM_DT;
        this._tick(SIM_DT);
      }
      this._updateCamera(dt);
      this._updateEffects(dt);
      this._updateCrowd(dt);
      this._updateFx(dt);
      this._updateLighting(dt);
      this.atmoT += dt;
      updateAtmosphere(this.arena, dt, this.atmoT, this.excited);
      updateRopes(this.arena, dt, this.fighters, this.atmoT);
      updateBanners(this.arena.backdrop, this.atmoT);
      if (this.props) updateProps(this.props, dt, this.fighters, this._propHooks);
      this._updateBlobShadows();
      this._updateTrainingOverlay();
      this._updateMatWear(dt);
      if (this.fighters) {
        for (const f of this.fighters) {
          updateJiggles(f.rig, dt);
          this._updateTrail(f, dt);
          // Transient 'hurt' faces relax back to the resting expression.
          // KO'd fighters keep the dazed face under the result modal.
          if (f.expressionT > 0) {
            f.expressionT -= dt;
            if (f.expressionT <= 0 && f.state !== 'ko') {
              setExpression(f.rig, 'neutral');
            }
          }
        }
      }
      this.composer.render();
      // #10 — same task as the render, or the WebGL canvas is already cleared.
      if (this.clip) this.clip.mirror(now);
    };
    this.raf = requestAnimationFrame(loop);
  }


  // ══ Reactive arena (GFX/SOUND #10) ═══════════════════════════════════
  // The hall was scenery: a jumbotron showing procedural static, rig lenses at
  // a constant emissive, and a ring mat that never acknowledged a body hitting
  // it. All three now respond to the match.

  _initReactiveArena() {
    // ── Rig LEDs ──────────────────────────────────────────────────────
    this._rigLenses = [];
    this.arena.backdrop?.traverse((o) => {
      if (o.userData?.rigLens && o.material) this._rigLenses.push(o);
    });

    // ── Live jumbotron ────────────────────────────────────────────────
    // 256×128 — the screens are 14 m from the camera behind a fog falloff, so
    // anything sharper is texture upload cost nobody can resolve. Both screens
    // share one material (see arena.js buildBackdrop), hence one canvas.
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    this._jumboCanvas = c;
    this._jumboCtx = c.getContext('2d');
    this._jumboTex = new THREE.CanvasTexture(c);
    this._jumboTex.colorSpace = THREE.SRGBColorSpace;
    const screenMat = this.arena.backdrop?.userData?.screenMat;
    if (screenMat) {
      // The outgoing map is arena.js's module-level cached singleton, shared
      // with any future arena build — replace the reference, never dispose it.
      screenMat.map = this._jumboTex;
      screenMat.needsUpdate = true;
    }
    this._jumboT = 0;
    this._jumboFlash = '';   // one-shot centre caption ('K.O.', 'FIGHT', …)
    this._jumboFlashT = 0;

    // ── Ring-mat ripple ───────────────────────────────────────────────
    // A SHADING ripple, not a displacement: the mat is a BoxGeometry with one
    // segment per face, so there are no interior vertices to push and adding
    // them would mean re-tessellating the ring to animate a few centimetres
    // nobody would see at this camera distance. Concentric bands of light and
    // shadow racing out from the impact read as the canvas taking the weight,
    // and cost one branch in a fragment shader that already runs.
    this._ripple = {
      origin: new THREE.Vector2(0, 0),
      t: { value: 99 },          // seconds since the strike; >2 = idle
      amp: { value: 0 },
      originU: { value: new THREE.Vector2(0, 0) },
    };
    const mat = this.arena.canvasMat;
    // ── Mat wear (GFX/SOUND #7) ─────────────────────────────────────────
    // Built here because the canvas shader below is the one place both the
    // ripple and the wear lookup get injected — two onBeforeCompile hooks on
    // one material would overwrite each other.
    this.matWear = new MatWear(MAT_HALF);
    const W = {
      wear: { value: this.matWear.wear.tex },
      wet: { value: this.matWear.wet.tex },
      half: { value: MAT_HALF },
    };
    if (mat) {
      const R = this._ripple;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uRippleT = R.t;
        shader.uniforms.uRippleAmp = R.amp;
        shader.uniforms.uRippleOrigin = R.originU;
        shader.uniforms.uWearMap = W.wear;
        shader.uniforms.uWetMap = W.wet;
        shader.uniforms.uWearHalf = W.half;
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', 'varying vec2 vMatXZ;\nvoid main() {')
          // World XZ of the fragment. Piggybacks on begin_vertex (which defines
          // `transformed`) rather than on worldpos_vertex, because that chunk
          // only emits a world position when an envmap/shadow define happens to
          // be set — which would make this silently break if lighting changed.
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\n  vMatXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', /* glsl */`
            uniform float uRippleT;
            uniform float uRippleAmp;
            uniform vec2 uRippleOrigin;
            uniform sampler2D uWearMap;
            uniform sampler2D uWetMap;
            uniform float uWearHalf;
            varying vec2 vMatXZ;
            float _matWet = 0.0;
            void main() {`)
          // Wear goes into the ALBEDO (before lighting), so scuffs sit in the
          // vinyl under the spots rather than being painted over the lit result.
          // The box's side faces get the edge texel; at 4 cm tall nobody sees it.
          .replace('#include <map_fragment>', /* glsl */`
            #include <map_fragment>
            {
              vec2 _wuv = vMatXZ / (2.0 * uWearHalf) + 0.5;
              if (all(greaterThanEqual(_wuv, vec2(0.0))) && all(lessThanEqual(_wuv, vec2(1.0)))) {
                vec4 _wear = texture2D(uWearMap, _wuv);
                // Straight alpha: WebGL un-premultiplies a canvas on upload, so
                // dividing by alpha again here turned faint texels into speckles.
                diffuseColor.rgb = mix(diffuseColor.rgb, _wear.rgb, _wear.a);
                _matWet = texture2D(uWetMap, _wuv).a;
                diffuseColor.rgb *= 1.0 - 0.38 * _matWet;
              }
            }`)
          // Wet vinyl is glossier: the sweat catches the spots as it dries off.
          .replace('#include <roughnessmap_fragment>', /* glsl */`
            #include <roughnessmap_fragment>
            roughnessFactor = mix(roughnessFactor, 0.28, _matWet);`)
          .replace('#include <opaque_fragment>', /* glsl */`
            #include <opaque_fragment>
            if (uRippleAmp > 0.001) {
              float _d = distance(vMatXZ, uRippleOrigin);
              // Expanding wave front at ~4.5 m/s with a gaussian envelope, so
              // the disturbance is a moving band rather than the whole mat
              // pulsing at once.
              float _front = uRippleT * 4.5;
              float _band = exp(-pow((_d - _front) * 1.9, 2.0));
              float _wave = sin(_d * 7.0 - uRippleT * 22.0);
              // Falls off with distance travelled AND with age — a ripple that
              // only faded with time would still be visible at the ropes.
              float _fade = uRippleAmp * exp(-_d * 0.24) * exp(-uRippleT * 1.7);
              gl_FragColor.rgb *= 1.0 + _wave * _band * _fade * 0.55;
            }`);
      };
      mat.needsUpdate = true;
    }
  }

  /** Kick a ripple out from a world XZ point — a knockdown, a KO, a body slam. */
  _ringRipple(x, z, amp = 1) {
    if (!this._ripple) return;
    this._ripple.originU.value.set(x, z);
    this._ripple.t.value = 0;
    this._ripple.amp.value = Math.min(1.2, amp);
  }

  _updateReactiveArena(dt) {
    // Rig LEDs ride the audio envelope plus crowd excitement. The envelope is
    // the same signal the bloom pulse reads, so the lamps flare on the same
    // frame the impact is heard rather than a frame or two behind it.
    if (this._rigLenses && this._rigLenses.length) {
      const env = this.audio ? this.audio.getEnvelope() : 0;
      const exc = Math.min(1, this.excited || 0);
      for (let i = 0; i < this._rigLenses.length; i++) {
        const lens = this._rigLenses[i];
        // Per-lamp phase so the truss chases rather than strobing as one block
        // — eight lamps flashing in unison reads as a bug in the renderer.
        const phase = Math.sin(this.atmoT * 3.1 + i * 0.8) * 0.5 + 0.5;
        lens.material.emissiveIntensity =
          (lens.userData.baseEmissive || 1.4) * (1 + env * 1.6 + exc * 0.5 * phase);
      }
    }

    // Ripple clock. Parked at a high value when idle so the shader branch is
    // skipped via uRippleAmp rather than left running on a stale phase.
    if (this._ripple && this._ripple.amp.value > 0) {
      this._ripple.t.value += dt;
      if (this._ripple.t.value > 2.2) this._ripple.amp.value = 0;
    }

    // Jumbotron: redraw at ~8 Hz. It is a texture upload, so it does NOT want
    // to be on the frame clock — at 60 fps that is 60 canvas repaints and 60
    // GPU uploads a second for a screen the size of a postage stamp on screen.
    this._jumboT = (this._jumboT || 0) + dt;
    if (this._jumboFlashT > 0) this._jumboFlashT -= dt;
    if (this._jumboT >= 0.125) { this._jumboT = 0; this._drawJumbotron(); }
  }

  /** One-shot big caption on the jumbotron. */
  _jumboCaption(text, secs = 1.6) {
    this._jumboFlash = text;
    this._jumboFlashT = secs;
    this._jumboT = 99; // force a redraw on the next update rather than waiting
  }

  _drawJumbotron() {
    const g = this._jumboCtx;
    if (!g || !this.fighters || !this.combat) return;
    const W = 256, H = 128;
    g.fillStyle = '#08101f';
    g.fillRect(0, 0, W, H);

    // Header strip.
    g.fillStyle = 'rgba(90,124,250,0.18)';
    g.fillRect(0, 0, W, 18);
    g.font = 'bold 11px Impact, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#cfe0ff';
    g.textAlign = 'left';
    g.fillText('PO BRAWL', 8, 9);
    g.textAlign = 'right';
    g.fillText(this.training ? 'TRAINING'
      : `${Math.ceil(Math.max(0, TIME_LIMIT - (this.clock || 0)))}"`, W - 8, 9);

    // Two name plates with live HP.
    const names = this.fighters.map((f) => (f.rig.config.name || '').toUpperCase());
    const hps = this.fighters.map((f) => this._hp(f) / MAX_HP);
    for (let i = 0; i < 2; i++) {
      const y = 30 + i * 30;
      g.textAlign = 'left';
      g.font = 'bold 12px Impact, sans-serif';
      g.fillStyle = '#e8eeff';
      g.fillText(names[i].slice(0, 14), 10, y);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(10, y + 9, W - 20, 7);
      g.fillStyle = i === 0 ? '#22c55e' : '#ef4444';
      g.fillRect(10, y + 9, Math.max(0, (W - 20) * hps[i]), 7);
    }

    // Centre caption: an explicit one-shot beats a live combo, which beats
    // nothing. Combos are the common case, so they cost no extra state.
    let caption = this._jumboFlashT > 0 ? this._jumboFlash : '';
    if (!caption) {
      const best = this.fighters.reduce((a, b) => (b.comboN > a.comboN ? b : a));
      if (best.comboN >= COMBO_MIN_SHOWN) caption = `${best.comboN} HIT`;
    }
    if (caption) {
      g.textAlign = 'center';
      g.font = 'bold 30px Impact, sans-serif';
      g.fillStyle = 'rgba(255,214,102,0.92)';
      g.fillText(caption, W / 2, H - 22);
    }

    // Scanlines last, over everything — this is a screen being filmed, and the
    // banding is what stops the panel reading as a flat lit quad.
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);

    this._jumboTex.needsUpdate = true;
  }


  _makeController(playerIndex, spawnedCharId = null) {
    const mode = this.options.mode;
    const difficulty = this.options.difficulty || 'medium';
    // Each AI controller also learns its charId so it can pull personality
    // additive AI knobs (HW Bush's blockP/baitP/punishP bump). The SPAWNED id wins
    // over options: a demo reshuffle (resetMatch(true)) never writes the new pair
    // back into options, so reading options there handed every reshuffled CPU the
    // first match's personality.
    const charIdForIndex = spawnedCharId ?? (playerIndex === 1
      ? this.options.p1Character
      : this.options.p2Character);
    // The training room (1P) or a demo drill claims the dummy's slot, and in a
    // drill the drilling president's too. Null means "not a training slot".
    const trainingController = this._trainingController(playerIndex, charIdForIndex);
    if (trainingController) return trainingController;
    // Online both corners are puppets of the server's snapshots (netplay.js).
    if (mode === 'online') return new NetController(playerIndex === this.options.localSide);
    const keys = (layout) => new KeyboardController(layout);
    if (mode === 'demo') return new AiController(difficulty, this.rng, charIdForIndex);
    if (mode === '2p') return keys(playerIndex);
    return playerIndex === 1
      ? keys(1)
      : new AiController(difficulty, this.rng, charIdForIndex);
  }

  _spawnFighters(p1Char, p2Char) {
    if (this.fighters) {
      for (const f of this.fighters) {
        // Tear down any active swing physics before disposing the fighter.
        if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
        // Dispose cannon bodies we created for this fighter.
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
        this.scene.remove(f.rig.root);
        f.rig.disposePortrait?.();
        if (f.blob) {
          this.scene.remove(f.blob);
          f.blob.geometry.dispose();
          f.blob.material.dispose(); // texture is shared; disposed in dispose()
        }
        if (f.aoDisc) {
          this.scene.remove(f.aoDisc);
          f.aoDisc.geometry.dispose();
          f.aoDisc.material.dispose();
        }
        if (f.trail) {
          this.scene.remove(f.trail.mesh);
          f.trail.mesh.geometry.dispose();
          f.trail.mesh.material.dispose();
        }
        f.controller.dispose();
      }
    }

    // A fresh match starts on a clean canvas — the accumulated blood
    // stains belong to the fight that produced them.
    if (this._bloodStains) {
      for (const s of this._bloodStains) this.scene.remove(s);
      this._bloodStains.length = 0;
    }
    // …and so do the scuffs, skids and sweat (#7).
    if (this.matWear) this.matWear.clear();
    this._koDust = null;

    // Clear any arms torn off in the previous fight.
    if (this._pendingSevers) this._pendingSevers.length = 0;
    if (this._severedLimbs) {
      for (const l of this._severedLimbs) {
        if (l.arm) l.arm.dispose();
        for (const obj of [l.shoulder, l.elbow]) {
          if (!obj) continue;
          this.scene.remove(obj);
          obj.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
          });
        }
      }
      this._severedLimbs.length = 0;
    }

    this.combat = new CombatPlay({ maxHealth: MAX_HP });
    this.replay.start();

    this.fighters = [1, 2].map((index) => {
      const charId = index === 1 ? p1Char : p2Char;
      const resolvedId = CHARACTERS[charId] ? charId : CHARACTER_IDS[0];
      // Wardrobe material tier. Build-time only, like the light count and for the
      // same reason: swapping a material's class means new shader programs for
      // every mesh wearing it, so it cannot chase a live tier change without a
      // recompile stall. Fighters ARE rebuilt between rounds, so a tier that
      // dropped mid-match is picked up at the next spawn.
      const rig = buildFighter(resolvedId, {
        physicalMaterials: Quality.settings().physicalMaterials,
      }, this.options.mode === '1p' && index === 1 ? this.options.playerHead : null);
      // #4 — must run before the first render: onBeforeCompile only fires on
      // initial program compile, so injecting after a material has been drawn
      // once does nothing until something else dirties it.
      const inkUniforms = this._applyInkEdge(rig);
      // Spawn on the same side as this fighter's energy bar in the Blazor HUD
      // (see SPAWN_X_BY_SIDE at the top of the file). The camera at +Z
      // looking toward −Z renders negative X on the screen-left and positive
      // X on the screen-right, matching `pb-hp-side` (P1) and `pb-hp-right`
      // (P2) respectively.
      const side = index === 1 ? 'left' : 'right';
      rig.root.position.set(SPAWN_X_BY_SIDE[side], 0, 0);
      this.scene.add(rig.root);
      const playerId = `p${index}`;
      this.combat.addPlayer({ playerId, teamId: String(index) });

      // Build cannon-es bodies for this fighter. The kinematic rig-root
      // handles push-apart with the opponent; the dynamic hurt spheres +
      // DistanceConstraints are what the strikers collide with.
      const initialXZ = { x: rig.root.position.x, z: rig.root.position.z };
      const fighterPhysics = buildFighterPhysics(this._physics.world, this._physics.materials, { rig }, initialXZ);

      // Soft contact shadow + ambient-occlusion disc. Two stacked planes:
      //   • blob — the existing shadow blob (radial gradient that darkens
      //     and widens as the fighter drops; sells vertical grounding)
      //   • aoDisc — a tight, near-pitch-black inner ring that hugs the
      //     planted foot. Reads as ambient occlusion, not cast shadow —
      //     sells horizontal contact (the fighter isn't floating).
      const blob = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: this._makeBlobTexture(), transparent: true,
          opacity: 0.34, depthWrite: false,
        })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.055;
      this.scene.add(blob);

      // AO disc scales with mass — heavy fighters (LBJ mass 1.25) get a
      // visibly larger plant patch than light fighters (JFK mass 0.9).
      const aoR = 0.95 * Math.sqrt(rig.config.mass || 1.0);
      const aoDisc = new THREE.Mesh(
        new THREE.PlaneGeometry(aoR * 2, aoR * 2),
        new THREE.MeshBasicMaterial({
          map: this._makeBlobTexture({ inner: 'rgba(0,0,0,0.85)', outer: 'rgba(0,0,0,0)' }),
          transparent: true, opacity: 0.55, depthWrite: false,
        })
      );
      aoDisc.rotation.x = -Math.PI / 2;
      aoDisc.position.y = 0.056; // 1 mm above blob to avoid z-fight
      this.scene.add(aoDisc);

      return {
        index,
        playerId,
        // 'left' | 'right' — mirrors the side this fighter's HUD bar is drawn
        // on by Blazor, and the X coordinate they spawned at. Single source of
        // truth for any code that needs "which side am I on?" (camera framing,
        // KO camera, replay, future AI hints). Set above; do not mutate after
        // spawn — moving across the ring is tracked separately on `vel.x`.
        side,
        // Resolved character id (demo mode reshuffles these every reset — the
        // HUD reads it back via the OnMatchStart callback so the on-screen
        // names always match the actual fighters).
        charId: resolvedId,
        rig,
        // #4 — the ink-edge uniform objects for this rig's materials, so the
        // super cinematic can spike the edge to the character's accent colour
        // and let it fall back without re-walking the hierarchy every frame.
        inkUniforms,
        // Stance offsets give each president a personal idle silhouette
        // (Trump's chin-up lean, Nixon's hunch) on top of the shared guard.
        animator: new Animator(rig.joints, rig.config.stance),
        controller: this._makeController(index, resolvedId),
        // Personality entrance — played under the "3 / 2 / 1 / FIGHT!" banner
        // during _startCountdown. Resolves to GUARD by the time FIGHT! fires.
        entranceKey: (CHARACTERS[charId] && CHARACTERS[charId].entrance) || 'salute',
        state: 'idle',
        stateT: 0,
        attack: null,
        hasHit: false,
        // ── Hold-to-charge ────────────────────────────────────────────
        chargeName: null,  // 'punch'|'kick' while state === 'charge'
        chargeAmt: 0,      // 0..1 charge drained out of `energy` while charging
        chargeMul: 1,      // damage/knockback multiplier of the current swing
        energy: ENERGY_DEFAULT, // 0..1 strike power AND stamina (see the ENERGY_* block)
        gassed: false,     // true while under the floor: no punch, no kick (see _canAttack)
        // ── Guard timing (see the PERFECT_GUARD_* block) ──────────────
        // Engine time the guard last went UP. Every route into the 'block'
        // state stamps it, and _applyHit compares it against the moment the
        // strike connects to tell a read from a camp. -99 so a fighter who has
        // not guarded yet can never score a perfect one off the initialiser.
        guardAt: -99,
        blockStunT: 0,     // frozen out of our own recovery by the guard we hit
        counterUntil: -99, // perfect guard armed a bonus swing until this time

        // The super meter is NOT here. It lives on `personality.superMeter`
        // (makePersonalityState), which is where _applyHit fills it and
        // _fireSuper consumes it. A duplicate field on the fighter used to sit
        // at this line, and because it read plausibly the HUD push and the AI's
        // superMeterFull check both bound to it instead — the dead copy — which
        // is what kept the whole signature-super feature inert. Don't add it back.
        // ── Per-round scorecard ───────────────────────────────────────
        // Counters for the end-of-fight recap and the on-screen combo readout.
        // Every round (including a best-of-3 rematch) goes through
        // _spawnFighters, so initialising here IS the per-round reset.
        stats: { hits: 0, blocks: 0, biggestHit: 0, bestCombo: 0 },
        comboN: 0,      // consecutive landed hits inside COMBO_WINDOW
        comboT: -99,    // engine time of this fighter's last landed hit
        chargeCued: false, // full-charge audio cue fired
        chargeSparkT: 0,   // spark-mote emission timer
        // ── Momentum + weight ─────────────────────────────────────────
        vel: new THREE.Vector3(),
        targetVel: new THREE.Vector3(),
        knockback: new THREE.Vector3(),
        // sideVel removed 2026-08-11: the sidestep impulse it carried became
        // held circling, which steers through `vel` like ordinary movement.
        // ── Per-region damage ─────────────────────────────────────────
        regionDmg: { head: 0, torso: 0, arms: 0, legs: 0 },
        // ── Dismemberment ─────────────────────────────────────────────
        // Which arm sides ('L'/'R') have torn off, plus the still-bleeding
        // stumps that keep squirting for a beat. See _severArm / _tick.
        armsLost: new Set(),
        stumps: [],
        // ── Misc ──────────────────────────────────────────────────────
        idleT: this.rng.random() * 10,
        speedAmt: 0,
        // Facial expression timer: >0 while a transient 'hurt' face is held.
        expressionT: 0,
        // Rotational knockback: yaw angular velocity + accumulated offset
        // layered on top of the hard-set facing (see the yaw-track block).
        spinVel: 0,
        spinYaw: 0,
        // Skid/landing ground-reaction state.
        _skidT: 0,
        _wasSkidding: false,
        // ── Personality state (per-president Punch-Out!! pattern) ──────
        // Runtime counters that personalities data above refer to. Reset on
        // match restart via _resetPersonalities below.
        // Off online: every personality effect that moves HP (reflect, flourishes, supers) would
        // move HP the server never moved. BOB has none either way.
        personality: makePersonalityState(this.options.mode === 'online' ? null : resolvedId),
        // Slow effect (Biden charge hit): applies a moveMul to the body for
        // a few seconds. Read in the _tickFighting mobility pass.
        slowUntil: 0,
        slowMul: 1.0,
        // Block-reduce nudge (Nixon "Tricky Dick"): on the next commit dirty
        // hit, the defender's block absorbs `dirtyBlockFraction` less.
        dirtyBlockReduce: 0,
        hpCur: MAX_HP,
        // Impact feedback: cartoon squash timer (shape only — per user request
        // the model's colors never change on hits or KO).
        squashT: 0,
        // Soft contact-shadow mesh (tracks the hips each frame).
        blob,
        // AO disc: mass-tinted "planted foot" patch. Tighter than blob,
        // never widens with drop — it just anchors the fighter to the floor.
        aoDisc,
        // Additive swing ribbon following the striking limb.
        trail: this._makeTrail(),
        // Track the last frame's windup flag for the AI to read.
        lastWasWindup: false,
        // Rigid-body ragdoll — the real cannon-es skeleton used for the KO.
        // Built lazily (pendingKO) because KOs can fire inside world.step.
        koRagdoll: new CannonRagdoll(this._physics.world, this._physics.materials.ragdoll, rig),
        pendingKO: null,
        // Cannon-es physics — kinematic rig root + dynamic hurt spheres.
        fighterPhysics,
        // Active swing bodies (striker spheres). Created on _enterAttack,
        // destroyed when swing transitions to idle or KO interrupts.
        swingPhysics: null,
      };
    });
    this.hudDirty = true;
    this.hudTimer = 0;
    // Tell the HUD which characters actually spawned so the left/right names
    // match the fighters — critical in demo mode, where resetMatch reshuffles
    // the roster without the Blazor layer knowing.
    if (this.dotnet) {
      this.dotnet.invokeMethodAsync('OnMatchStart',
        this.fighters[0].charId, this.fighters[1].charId).catch(() => {});
      // Whether this match is a training session or a demo drill, so the page can
      // badge a drill and drop the ladder chrome. Its own call rather than a third
      // OnMatchStart argument: interop fails silently on an arity change (see the
      // OnHud note), and a new method simply does not bind on a stale page.
      this.dotnet.invokeMethodAsync('OnTrainingState',
        !!this.training, this.training ? this.training.dummy : '').catch(() => {});
    }
  }

  _hp(f) {
    return Math.max(0, Math.round(this.combat.getPlayer(f.playerId).health));
  }

  _startCountdown() {
    this.phase = 'countdown';
    this.phaseT = 0;
    this.clock = 0;
    this.winner = 0;
    // Rebuild the corner crate stacks so each round opens with an intact ring.
    if (this.props) resetProps(this.props);
    // Drop the previous round's floating numbers and combo badges.
    this._clearFx();
    // Land the previous match's celebrant before the fresh countdown.
    if (this.celebrant) this.celebrant.rig.root.position.y = 0;
    this.celebrant = null;
    this.pendingCelebration = null;
    this.celebrationT = 0;
    this.timeScale = 1;
    this.cameraMode = 'normal';
    this.cameraModeT = 0;
    // A super fired on the last frame of the previous round would otherwise
    // still own timeScale and the camera into this countdown (#2).
    this._superT = 0;
    this._superFighter = null;
    // Re-arm the PA count (#7); without this the new round's "3" matches the
    // remembered value and the announcer sits out the whole countdown.
    this._lastCount = null;
    this._resetCommentary();
    // Snap the boom back to the canonical +Z side before the round starts.
    // The KO cinematic swings the camera around to the −Z side of the ring
    // (see _updateCamera 'ko' branch), and the normal spring camera's
    // perp-flip keeps whatever side it's already on — so without this reset
    // the next round is filmed from behind, mirroring the arena: P1 (world
    // −X, drawn on the screen-left in the HUD) would render on the right and
    // the left/right names read swapped against the fighters. Resetting here
    // guarantees screen-left always maps to P1.
    this._snapCameraToFraming();
    // Kick the personality entrance for each fighter. The track lasts ~1.5 s
    // (3-4 keyframes); the countdown is 3.7 s, so the entrance resolves to
    // GUARD before FIGHT! fires and the match starts clean.
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.animator && f.entranceKey) f.animator.play(f.entranceKey);
      }
      // Period-appropriate chiptune intro for the opponent (P2). Plays on
      // introGain while the music loop ducks; fades back up after ~5 s.
      if (this.audio && this.fighters[1]) {
        this.audio.playIntroTheme(this.fighters[1].charId);
      }
    }
    this._setBanner('3');
    // #9 / #10 — the previous result's lower third goes, and the clip recorder
    // starts cycling again for the new fight.
    if (this.news) this.news.hide();
    if (this.clip) this.clip.resume();
    this._dangerPushed = -1;
  }

  /**
   * Opening VS splash for an engine's first match (#8): the same card
   * resetMatch shows between rounds, then the countdown. The fighters idle under
   * it — phase 'intro' matches none of _tick's branches, so nothing fights,
   * scores or times out until the countdown takes over.
   */
  _beginWithSplash(p1Char, p2Char, label) {
    this.phase = 'intro';
    this.phaseT = 0;
    this.clock = 0;
    this.winner = 0;
    this._snapCameraToFraming();
    this._roundLabel = label;
    this._showSplash(p1Char, p2Char, SPLASH_HOLD_MS);
    const hold = this._introHold();
    // Online the server's pre-roll starts the count (netplay.js applyNet), so both screens say
    // "FIGHT!" on the same tick.
    if (this.options.mode === 'online') return;
    this._splashTimer = setTimeout(() => {
      if (this.disposed) return;
      this._hideSplash();
      this._startCountdown();
    }, hold);
  }

  /**
   * Speak the ring introduction, if one is waiting, and return how long the VS splash should
   * hold so the line finishes before "3" (the count cancels whatever the PA is saying).
   */
  _introHold() {
    const line = this._introLine;
    this._introLine = null;
    if (!line || this.training || this.options.mode === 'demo') return SPLASH_HOLD_MS;
    this.audio?.announce(line, { rate: 1.02, pitch: 0.7, duckSec: 4 });
    const words = String(line).split(/\s+/).length;
    return Math.min(7000, Math.max(SPLASH_HOLD_MS, 600 + words * 360));
  }

  // Compile every GPU program the current scene needs, then reset the frame
  // clock. three compiles a material's shader lazily, on its first render;
  // with this many distinct materials (arena + backdrop + crowd + props + two
  // freshly built fighters + the whole post chain) that lands as one long
  // stall on the first animated frame of a match. It doesn't just drop the
  // opening camera move — a main-thread block that long also starves the
  // music scheduler's setInterval past its lookahead window, so the bass line
  // hiccups at the same moment. That combination is the "everything stutters
  // at the start of a round" symptom. Warming up here spends the same time,
  // but spends it before the clock starts / behind the round splash.
  _warmupRender() {
    try {
      this.renderer.compile(this.scene, this.camera);
      this.composer.render();
    } catch { /* best effort — never block the match on the warm-up */ }
    // Don't bill the warm-up to the simulation: the next frame's dt is
    // measured from here, and no catch-up ticks are owed.
    this.lastFrame = performance.now();
    this.accumulator = 0;
  }

  resetMatch(randomize) {
    let p1 = this.options.p1Character, p2 = this.options.p2Character;
    if (randomize) {
      const ids = this.rng.shuffle(CHARACTER_IDS);
      [p1, p2] = ids;
    }
    if (this.options.mode === 'demo') {
      this.training = this._rollDemoDrill();
    }
    this._spawnFighters(p1, p2);
    this._initTraining();
    this._renderTrainingHud();
    // New rigs mean new materials: compile them under the splash rather than
    // on the countdown's first frame.
    this._warmupRender();
    // Show the inter-round splash, then start the countdown once it's
    // faded in. The splash doubles as a brief loading screen — the new
    // match's physics + arena are ready under it, so the transition reads
    // as "next round" rather than "page reload".
    this._showSplash(p1, p2, SPLASH_HOLD_MS);
    const hold = this._introHold();
    // Guarded: a navigation inside the hold used to fire this on a disposed game.
    clearTimeout(this._splashTimer);
    this._splashTimer = setTimeout(() => {
      if (this.disposed) return;
      this._hideSplash();
      this._startCountdown();
    }, hold);
  }

  _showSplash(p1Char, p2Char, holdMs) {
    const p1 = CHARACTERS[p1Char]?.name ?? p1Char;
    const p2 = CHARACTERS[p2Char]?.name ?? p2Char;
    // `roundLabel` is a one-shot override set by PoBrawl.next() — the 2-player
    // best-of-3 uses it to name the round ("ROUND 2"), where the generic
    // "NEXT ROUND" would leave the players unable to tell which round is
    // starting. Consumed here so it can never leak into the following match.
    const label = this._roundLabel
      || (this.training ? (this.training.showcase ? 'TRAINING DRILL' : 'TRAINING')
        : this.options.mode === 'demo' ? 'DEMO' : 'NEXT ROUND');
    this._roundLabel = null;
    this.splash.querySelector('.pb-splash__round').textContent = label;
    this.splash.querySelector('.pb-splash__p1').textContent = p1;
    this.splash.querySelector('.pb-splash__p2').textContent = p2;
    this.splash.classList.remove('pb-splash--instant');
    this.splash.classList.add('pb-splash--visible');
    // #8 — riser into a boom timed to the cards slamming together.
    this.audio?.vsSting();
  }

  // #8 — the names FLY into the HUD. With the View Transitions API the splash's
  // two name spans and the page's two .pb-hp-name labels swap a shared
  // view-transition-name across the DOM update, so the browser morphs each name
  // from the centre card to its health bar. Only one element per name may carry
  // it at a time, which is why it moves from the splash to the HUD INSIDE the
  // update callback. Without the API (Firefox, Safari < 18), under reduced
  // motion, or if the HUD is not on the page, the splash just fades as before.
  _hideSplash() {
    const splash = this.splash;
    if (!splash.classList.contains('pb-splash--visible')) return;
    const huds = this.container.parentElement?.querySelectorAll('.pb-hp-name') || [];
    const names = [splash.querySelector('.pb-splash__p1'), splash.querySelector('.pb-splash__p2')];
    if (typeof document.startViewTransition !== 'function' || huds.length < 2 || motionReduced()
        || document.visibilityState !== 'visible') {
      splash.classList.remove('pb-splash--visible');
      return;
    }
    ensureViewTransitionStyle();
    names[0].style.viewTransitionName = 'pb-name-1';
    names[1].style.viewTransitionName = 'pb-name-2';
    let vt;
    try {
      vt = document.startViewTransition(() => {
        names[0].style.viewTransitionName = '';
        names[1].style.viewTransitionName = '';
        huds[0].style.viewTransitionName = 'pb-name-1';
        huds[1].style.viewTransitionName = 'pb-name-2';
        // The new state must have the splash fully gone, not mid-fade — the
        // root cross-fade is what fades it now.
        splash.classList.add('pb-splash--instant');
        splash.classList.remove('pb-splash--visible');
      });
    } catch {
      splash.classList.remove('pb-splash--visible');
      return;
    }
    vt.finished.finally(() => {
      huds[0].style.viewTransitionName = '';
      huds[1].style.viewTransitionName = '';
      names[0].style.viewTransitionName = '';
      names[1].style.viewTransitionName = '';
    }).catch(() => { /* skipped transition */ });
  }

  // ── simulation ──────────────────────────────────────────────────────────

  _tick(dt) {
    // The sim clock every timed personality effect is written against. See the
    // declaration in the constructor — it was missing entirely until now.
    this.t += dt;
    this.phaseT += dt;

    if (this.phase === 'countdown') {
      const remaining = 3 - Math.floor(this.phaseT);
      this._setBanner(remaining > 0 ? String(remaining) : 'FIGHT!');
      // #7 — the PA calls the count. Edge-triggered off the banner value rather
      // than a timer of its own, so the voice can never drift out of step with
      // the number on screen.
      if (remaining !== this._lastCount) {
        this._lastCount = remaining;
        if (remaining > 0) this.audio?.announce(String(remaining), { rate: 1.05, pitch: 0.6, duckSec: 0.25 });
        else {
          this.audio?.announce('Fight!', { rate: 1.1, pitch: 0.5, duckSec: 0.5 });
          this._jumboCaption('FIGHT', 1.4);
          this.audio?.crowdSwell(0.85);
        }
      }
      if (this.phaseT >= 3.7) {
        this.phase = 'fighting';
        this.combat.startGame();
        this._setBanner('');
      }
    } else if (this.phase === 'fighting') {
      this.clock += dt;
      this._tickFighting(dt);
      this._tickCombos();
      this._tickCommentary();
      // The training room has no clock (a drill ends itself inside _tickTraining).
      if (this.training) this._tickTraining();
      // Online the server rings the bell (netplay.js _tickNet), on its own clock.
      if (!this.training && !this.online && this.clock >= TIME_LIMIT && this.phase === 'fighting') {
        const h1 = this._hp(this.fighters[0]), h2 = this._hp(this.fighters[1]);
        // Decision on health. A clear health lead wins; bars within DRAW_HP_BAND
        // of each other is a DRAW.
        //
        // This reverses the previous rule, which forced a winner out of every
        // no-KO finish and broke exact ties toward P1 by index. That rule made
        // the 60 seconds decide something the fight had not: a one-point gap
        // after a minute of even trading was reported as a victory, and in 1P it
        // advanced the ladder on the strength of rounding.
        const margin = Math.abs(h1 - h2);
        let winner;
        if (margin <= DRAW_HP_BAND) winner = 0;   // too close to call
        else winner = h1 > h2 ? 1 : 2;
        // 'TIME!' is the flash on the way out, not the final word: _endMatch
        // calls _reportResult synchronously and that sets the real banner —
        // 'DRAW' for winner 0, '<NAME> WINS!' otherwise.
        this._endMatch(winner, 'TIME!');
      }
    } else if (this.phase === 'ko') {
      // Build any pending rigid-body ragdoll now — we're guaranteed to be
      // outside cannon's step here, so body removal/creation is safe.
      this._buildPendingKO();
      this._buildPendingSevers();
      if (this._physics) stepWorld(this._physics.world, dt);
      this._tickKoFall(dt);
      this._tickReplay(dt);
      if (this.phaseT >= 1.4) {
        this.timeScale = 1;
        this.phase = 'result';
        this.phaseT = 0;
        this._startCelebration(this.pendingCelebration);
        this._reportResult();
      }
    } else if (this.phase === 'result') {
      this._buildPendingKO();
      this._buildPendingSevers();
      if (this._physics) stepWorld(this._physics.world, dt);
      this._tickKoFall(dt);
      this._tickCelebration(dt);
      if (this.options.mode === 'demo' && this.phaseT >= 3) {
        this.resetMatch(true);
      }
    }

    // Hit-pause countdown: skip sim while paused but still advance render rate later.
    if (this.hitstopT > 0) {
      this.hitstopT = Math.max(0, this.hitstopT - dt);
    }
    if (this._clashCooldown > 0) this._clashCooldown -= dt;

    for (const f of this.fighters) {
      f.idleT += dt;
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      this._updatePosture(f, opp, dt);
      // Per-fighter personality evaluation: trigger-once modes, slow clears,
      // flourish scheduling.
      this._tickPersonalities(f, dt);
      this._tickClintonFlourish(f, dt);
      f.animator.update({
        dt, speed: f.speedAmt, idleT: f.idleT,
        root: f.rig.root,
        vel: _animVel.set(f.vel.x + f.knockback.x, 0, f.vel.z + f.knockback.z),
      });
      f.animator.decayLean(dt);
      f.hpCur = this._hp(f);

      // NOTE: the experimental hitstun ragdoll-blend was removed after joint
      // telemetry showed its per-tick quaternion slerp COMPOUNDS against the
      // animator's lerp — the spine converged toward the flying verlet pose
      // (70°+ folds) instead of adding a subtle flavor on top. The reaction
      // springs + hitstun track are the hit reaction now, tuned to a
      // realistic 5-15° deflection.

      // Cartoon squash: compress the whole body for a couple of frames on impact.
      if (f.squashT > 0) {
        f.squashT = Math.max(0, f.squashT - dt);
        const q = f.squashT / 0.14;
        const s = q * q * 0.2;
        f.rig.joints.hips.scale.set(1 + s * 0.8, 1 - s, 1 + s * 0.8);
      }

      // Bleeding stumps: keep squirting from the torn shoulder socket for a beat.
      if (f.stumps && f.stumps.length) {
        for (let n = f.stumps.length - 1; n >= 0; n--) {
          const st = f.stumps[n];
          st.t -= dt;
          st.emit -= dt;
          if (st.emit <= 0) {
            st.emit = 0.07;
            // Shoulder socket in torso-local space (see fighters.js: shoulder at
            // x = ±0.28·buildScale, y = 0.5), lifted to world.
            const socket = new THREE.Vector3(
              (st.side === 'L' ? -1 : 1) * 0.28 * f.rig.config.buildScale, 0.5, 0);
            f.rig.joints.torso.localToWorld(socket);
            const out = new THREE.Vector3(st.side === 'L' ? -1 : 1, 0.5, 0).normalize();
            this._bloodSquirt(socket, out, 1.1);
          }
          if (st.t <= 0) f.stumps.splice(n, 1);
        }
      }
    }

    // Drive music tension from the lower of the two HPs (0..1 → 0..1).
    if (this.fighters && this.fighters.length) {
      const low = Math.min(...this.fighters.map((f) => f.hpCur)) / MAX_HP;
      this.audio.setMusicTension(1 - low);
    }

    // Audio-reactive bloom: every SFX call nudges the AudioBus envelope;
    // here we decay it and pulse UnrealBloomPass strength so each impact
    // glows brighter for ~150 ms. Base 0.32, peak +0.6, eased back via
    // exp-decay (k ≈ 7.5 in audio.tick).
    if (this.audio && typeof this.audio.tick === 'function') this.audio.tick(dt);
    if (this.bloomPass) {
      const env = (this.audio && this.audio.getEnvelope) ? this.audio.getEnvelope() : 0;
      const target = 0.32 + env * 0.6;
      // Smoothly chase the target so back-to-back hits stack without snap.
      const k = 1 - Math.exp(-dt * 18);
      this.bloomPass.strength = this.bloomPass.strength + (target - this.bloomPass.strength) * k;
    }

    this._pushHud(dt);
    this.replay.record({ clock: this.clock, fighters: this.fighters });
  }

  _tickFighting(dt) {
    const [f1, f2] = this.fighters;

    // Skip sim while in hit-pause.
    if (this.hitstopT > 0) return;

    for (const f of this.fighters) {
      if (f.blockStunT > 0) {
        f.blockStunT = Math.max(0, f.blockStunT - dt);
        f.vel.multiplyScalar(0.2);
        f.knockback.multiplyScalar(0.25);
      }
      const opp = f === f1 ? f2 : f1;
      const ctx = this._aiContext(f, opp, dt);
      let intent = f.controller.update(ctx);
      if (f.blockStunT > 0) {
        intent = { ...intent, punch: false, kick: false, block: false, side: 0 };
      }
      // ── Nixon "I Am Not a Crook" eye-gouge ──────────────────────────
      // 30% of block presses drop during the 0.3 s blind window. The simplest
      // realization is to clear the `block` flag with miss-rate probability.
      // Ford "PARDON ME" super: same channel, higher miss-rate (60%), longer
      // window (1.0 s). The runtime miss rate is read from
      // f._inputBlindMissRate so future supers can reuse this without a
      // new branch.
      if (f._inputBlindUntil && this.t < f._inputBlindUntil) {
        const missRate = f._inputBlindMissRate
          || PERSONALITIES.nixon?.oncePerRound?.blindMissRate
          || 0.30;
        if (Math.random() < missRate) intent = { ...intent, block: false };
      }
      // ── W Bush "Decider Mode" freeze: stall out his attacking moves ──
      if (f.controller?.__freezeUntil && this.t < f.controller.__freezeUntil) {
        intent = { ...intent, punch: false, kick: false, side: 0 };
      }
      this._tickFighter(f, opp, intent, dt);
      if (this.online) this._netDeadline(f, opp);
      // Super meter fills passively by taking damage (see _tickSuperMeter).
      // Drain any activated super state, decay swing-counted supers.
      this._tickSuperMeter(f, opp, dt);
    }

    if (this.online) this._tickNet(dt);

    // ── Ring clamp + cannon-es physics step ────────────────────────
    // 1. Clamp each fighter inside the ring (still the engine's job — cannon
    //    wouldn't otherwise know about the arena boundary). A fighter thrown
    //    hard into the boundary rebounds off the ropes instead of sticking.
    for (const f of this.fighters) {
      const pos = f.rig.root.position;
      const rawX = pos.x, rawZ = pos.z;
      pos.x = THREE.MathUtils.clamp(rawX, -RING_HALF, RING_HALF);
      pos.z = THREE.MathUtils.clamp(rawZ, -RING_HALF, RING_HALF);
      // Elastic rope rebound (#3): the ropes catch a launched fighter and
      // spring them back INTO the ring. Harder impacts snap back harder
      // (restitution ramps 0.55 → 0.9 with incoming speed) instead of the old
      // flat 0.65 — a hard knockback into the ropes now rebounds like a real
      // rope-a-dope bounce rather than a dead stop.
      if (pos.x !== rawX && Math.abs(f.knockback.x) > 1.2) {
        const speed = Math.abs(f.knockback.x);
        const power = Math.min(2.6, speed / 3.5);
        const restitution = THREE.MathUtils.clamp(0.55 + speed * 0.05, 0.55, 0.9);
        f.knockback.x *= -restitution;
        f.animator.applyLean(0, rawX > 0 ? 0.4 : -0.4);
        f.animator.applyReaction('torso', -3, 0, 0);
        twangRope(this.arena, 'x', rawX > 0 ? 1 : -1, power);
      }
      if (pos.z !== rawZ && Math.abs(f.knockback.z) > 1.2) {
        const speed = Math.abs(f.knockback.z);
        const power = Math.min(2.6, speed / 3.5);
        const restitution = THREE.MathUtils.clamp(0.55 + speed * 0.05, 0.55, 0.9);
        f.knockback.z *= -restitution;
        f.animator.applyLean(rawZ > 0 ? -0.4 : 0.4, 0);
        f.animator.applyReaction('torso', -3, 0, 0);
        twangRope(this.arena, 'z', rawZ > 0 ? 1 : -1, power);
      }

      // Turnbuckle hazard (#9): a fighter knocked into a CORNER takes bonus
      // damage and is flung back toward ring-center harder than a plain rope
      // bounce. Cooldown-gated so a body wedged in the corner isn't shredded.
      f._cornerCd = Math.max(0, (f._cornerCd || 0) - dt);
      const inCorner = Math.abs(pos.x) > RING_HALF - 0.5 && Math.abs(pos.z) > RING_HALF - 0.5;
      const cornerKb = Math.hypot(f.knockback.x, f.knockback.z);
      if (inCorner && cornerKb > 3.0 && f._cornerCd === 0 && f.state !== 'ko') {
        f._cornerCd = 0.6;
        const sx = Math.sign(pos.x) || 1, sz = Math.sign(pos.z) || 1;
        const tox = -sx / Math.SQRT2, toz = -sz / Math.SQRT2; // toward center
        f.knockback.x = tox * cornerKb * 0.7;
        f.knockback.z = toz * cornerKb * 0.7;
        f.animator.applyReaction('torso', -3.5, 0, 0);
        this._propHooks.onChip(f, Math.min(4, cornerKb - 3.0), tox, toz);
        const pv = new THREE.Vector3(sx * (RING_HALF + 0.1), 1.0, sz * (RING_HALF + 0.1));
        this._spawnSparks(pv, sx < 0 ? 0xff5a4a : 0x4a7dff, 10, 2.2);
        this.audio.impact({ power: 1.3, worldPos: pv });
      }

      // ── Ground reaction: skids and landings ────────────────────────
      // Heavy knockback drags the feet: kick up canvas dust along the
      // slide, then a landing squash when the body finally grips.
      const kb = Math.hypot(f.knockback.x, f.knockback.z);
      if (kb > 3.2 && f.state !== 'ko') {
        f._wasSkidding = true;
        f._skidT -= dt;
        if (f._skidT <= 0) {
          f._skidT = 0.05;
          this._spawnParticle(
            pos.x + (this.rng.random() - 0.5) * 0.25, 0.1,
            pos.z + (this.rng.random() - 0.5) * 0.25,
            -f.knockback.x * 0.12, 0.7 + this.rng.random() * 0.6, -f.knockback.z * 0.12,
            0x8a8fb8, 0.4, -2.5);
        }
      } else if (f._wasSkidding && kb < 1.6) {
        // The slide grips: compress into the landing.
        f._wasSkidding = false;
        f.squashT = Math.max(f.squashT, 0.12);
      }
    }

    // 2. Sync cannon bodies to current rig transforms BEFORE stepping so
    //    the solver sees the fighter where the controllers put them.
    if (this._physics) {
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.fighterPhysics) {
          syncHurtSpheres(f, f.fighterPhysics.hurtSpheres);
          syncRigRoot(f.fighterPhysics.rigRoot, f);
          if (f.swingPhysics) {
            const phase = (f.stateT > (f.attack?.windup ?? 0) + (f.attack?.active ?? 0))
              ? 'recover' : 'active';
            syncStrikerSpheres(f, f.swingPhysics.spheres, f.state, phase);
          }
        }
      }
      stepWorld(this._physics.world, dt);
      // An arm torn off inside this step's beginContact dispatch gets its
      // bodies built here, now that we're safely outside world.step.
      this._buildPendingSevers();

      // 3. Push-apart via cannon-es contact events. When two kinematic
      //    rig-roots overlap, cannon reports a contact but doesn't move
      //    them by itself. We translate each root by half the deficit
      //    along the contact normal — same effect as the old
      //    MIN_SEPARATION code, but driven by cannon's broadphase +
      //    narrowphase instead of a single point-distance check.
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.fighterPhysics) {
          for (const c of this._physics.world.contacts) {
            const a = c.bi, b = c.bj;
            if (a === f.fighterPhysics.rigRoot || b === f.fighterPhysics.rigRoot) {
              const other = a === f.fighterPhysics.rigRoot ? b : a;
              if (!other.userData || other.userData.kind !== 'rigRoot') continue;
              const dx = f.fighterPhysics.rigRoot.position.x - other.position.x;
              const dz = f.fighterPhysics.rigRoot.position.z - other.position.z;
              const d = Math.hypot(dx, dz) || 1e-4;
              const overlap = (f.fighterPhysics.rigRoot.shapes[0].radius +
                              other.shapes[0].radius) - d;
              if (overlap > 0) {
                const nx = dx / d, nz = dz / d;
                const push = overlap * 0.5;
                f.fighterPhysics.rigRoot.position.x += nx * push;
                f.fighterPhysics.rigRoot.position.z += nz * push;
                other.position.x -= nx * push;
                other.position.z -= nz * push;
              }
            }
          }
        }
      }

      // 3b. Cannon never generates contacts between the two rig roots —
      //    both are KINEMATIC, and the broadphase skips pairs with no
      //    dynamic body — so the contact loop above only handles ragdoll
      //    shoves. Enforce the fighter-vs-fighter minimum separation
      //    directly: half the deficit each, XZ only.
      const [fA, fB] = this.fighters;
      if (fA.state !== 'ko' && fB.state !== 'ko'
          && fA.fighterPhysics && fB.fighterPhysics) {
        const pa = fA.fighterPhysics.rigRoot.position;
        const pb = fB.fighterPhysics.rigRoot.position;
        const dx = pa.x - pb.x, dz = pa.z - pb.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        if (d < MIN_SEPARATION) {
          const push = (MIN_SEPARATION - d) * 0.5;
          const nx = dx / d, nz = dz / d;
          pa.x += nx * push; pa.z += nz * push;
          pb.x -= nx * push; pb.z -= nz * push;

          // Body-check shove (#2): the part of each fighter's knockback driving
          // INTO the other is transferred, so charging/knocked into an opponent
          // shoves them instead of both sliding to a dead stop at the clamp.
          const aInto = -(fA.knockback.x * nx + fA.knockback.z * nz); // A → B
          if (aInto > 0.4) {
            fB.knockback.x += -nx * aInto * 0.45;
            fB.knockback.z += -nz * aInto * 0.45;
            fA.knockback.x -= -nx * aInto * 0.2;
            fA.knockback.z -= -nz * aInto * 0.2;
          }
          const bInto = (fB.knockback.x * nx + fB.knockback.z * nz);  // B → A
          if (bInto > 0.4) {
            fA.knockback.x += nx * bInto * 0.45;
            fA.knockback.z += nz * bInto * 0.45;
            fB.knockback.x -= nx * bInto * 0.2;
            fB.knockback.z -= nz * bInto * 0.2;
          }
        }
      }

      // 4. Read rig-root positions back into the THREE rigs so the visual
      //    matches the kinematic body.
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.fighterPhysics) {
          const p = f.fighterPhysics.rigRoot.position;
          f.rig.root.position.x = p.x;
          f.rig.root.position.z = p.z;
        }
      }
    }

    // Post collisions: high-momentum knockback against breakable props.
    for (const f of this.fighters) {
      for (const post of this.arena.posts) {
        if (!post.userData.breakable || !post.visible) continue;
        const d = post.position.clone().sub(f.rig.root.position);
        d.y = 0;
        const horiz = Math.hypot(d.x, d.z);
        if (horiz < 0.55 && f.knockback.lengthSq() > 6) {
          const chunks = damagePost(post, 30, this.scene);
          this.effects.push(...chunks.map((c) => ({ mesh: c, life: c.userData.life })));
          // Reflect knockback and dampen hard.
          f.knockback.multiplyScalar(-0.3);
          this._spawnSparks(post.position, 0xc8a060, 8, 1.5);
          this.audio.impact({ power: 1.0, worldPos: post.position });
        }
      }
    }

    // Face each other (yaw only). A body lying on the canvas doesn't yaw-track.
    // Rotational knockback rides on top as a decaying yaw offset: a hook
    // spins the defender off-facing, then they recover square.
    for (const f of this.fighters) {
      const opp = f === f1 ? f2 : f1;
      if (f.state !== 'ko') {
        if (f.spinVel !== 0 || f.spinYaw !== 0) {
          f.spinYaw += f.spinVel * dt;
          f.spinYaw = THREE.MathUtils.clamp(f.spinYaw, -0.7, 0.7);
          f.spinVel *= Math.exp(-dt * 5.5);
          f.spinYaw *= Math.exp(-dt * 4);
          if (Math.abs(f.spinVel) < 0.02 && Math.abs(f.spinYaw) < 0.005) {
            f.spinVel = 0;
            f.spinYaw = 0;
          }
        }
        const p = opp.rig.root.position;
        f.rig.root.rotation.y = Math.atan2(
          p.x - f.rig.root.position.x, p.z - f.rig.root.position.z) + f.spinYaw;
      }
    }
  }

  _aiContext(f, opp, dt) {
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const oppAttack = (opp.state === 'punch' || opp.state === 'kick') ? opp.attack : null;
    // A charging opponent reads as windup — the coil is the tell to block.
    const oppInWindup = opp.state === 'charge'
      || (!!oppAttack && opp.stateT < oppAttack.windup);
    const oppInActive = !!oppAttack && opp.stateT >= oppAttack.windup
      && opp.stateT <= oppAttack.windup + oppAttack.active;
    const oppInRecover = !!oppAttack && opp.stateT > oppAttack.windup + oppAttack.active;
    return {
      dt,
      distance: dist,
      // Sign of (opponent.x − self.x): +1 when the opponent is to our right,
      // −1 when to our left. The keyboard controller uses this to keep the
      // left/right keys screen-relative regardless of which side we're on.
      towardX: Math.sign(opp.rig.root.position.x - f.rig.root.position.x) || 1,
      kickRange: ATTACKS.kick.reach * opp.rig.config.heightScale + 0.3,
      opponentWindup: oppInWindup,
      opponentActive: oppInActive,
      opponentRecover: oppInRecover,
      opponentState: opp.state,
      ownAttacks: ATTACKS,
      // Super meter full? Exposed so the AI's super-activation block knows
      // when it has a budget to spend. Player controllers don't read this —
      // their intent.super is driven by the super key directly.
      //
      // Reads `f.personality.superMeter`, NOT `f.superMeter`. The meter is
      // filled (_applyHit) and consumed (_fireSuper) on the personality state,
      // but this check and _pushHud both used to read a same-named field on the
      // fighter that is initialised to 0 and never written again — so the flag
      // was permanently false and no CPU president ever fired its signature
      // super in the game's history. The fighter-level `superMeter` field is
      // gone; personality state is the one home for it.
      superMeterFull: (f.personality?.superMeter || 0) >= 1.0,
      // Energy gate (2026-09-12). The engine enforces this regardless — a
      // gassed fighter's punch/kick intent is simply dropped in _tickFighter —
      // but the AI needs to KNOW, or it spends the whole recovery mashing
      // attack inputs into a closed gate and standing there wide open. Reading
      // it lets the CPU do what a player should do here: put the guard up and
      // earn the bar back.
      selfExhausted: !!f.gassed,
      selfEnergy: f.energy,
      // The same gate read from the other side. A gassed opponent cannot throw
      // anything until the bar recovers, and the guard is the fastest way back
      // up it — so this is the AI's cue to load a full coil (ai.js `punishGas`)
      // and ask the player whether they have learned to block yet.
      opponentExhausted: !!opp.gassed,
      // The freeze a blocked swing costs its thrower (BLOCK_STUN). The training
      // room's punisher dummy answers into it; ai.js does not read it.
      opponentBlockStunned: opp.blockStunT > 0,
    };
  }

  _tickFighter(f, opp, intent, dt) {
    f.stateT += dt;

    // ── Energy regen ──────────────────────────────────────────────────
    // Replaces the old idle bleed (2026-09-12). See the ENERGY_* block for the
    // design: guarding refills fast, standing refills slowly, swinging refills
    // nothing, and the charge state is exempt because it is actively DRAINING
    // the pool into the strike — regenerating there would refund the wind-up.
    //
    // No hudDirty here on purpose: _pushHud already flushes every 0.25 s, so a
    // continuous change reaches the HUD four times a second without flagging a
    // push on every single frame.
    //
    // Biden's "THE BIG GUY" super is exempt for the length of its lock window:
    // its whole payload is a *guaranteed* max-power strike (it sets energy to
    // 1.0 once on activation), and letting the regen logic touch the bar before
    // he can throw it risks quietly converting that guarantee into something
    // less. Regen could only ever help him, but the gassed bookkeeping below
    // must not fire mid-lock either, so the whole block is skipped.
    const bigGuyLocked = f.personality?._bigGuyLockUntil
      && this.t < f.personality._bigGuyLockUntil;
    if (f.state !== 'charge' && f.state !== 'ko' && !bigGuyLocked) {
      let regen = 0;
      if (f.state === 'block') regen = ENERGY_BLOCK_REGEN_PER_SEC;
      else if (f.state === 'hitstun') regen = ENERGY_HITSTUN_REGEN_PER_SEC;
      else if (f.state !== 'punch' && f.state !== 'kick') regen = ENERGY_REGEN_PER_SEC;
      if (regen > 0) f.energy = Math.min(1, f.energy + dt * regen);
    }
    // Gassed-out bookkeeping, with the hysteresis band from ENERGY_RECOVER_TO.
    // Kept outside the exempt branch so a fighter can never be left flagged
    // gassed while sitting on a full bar.
    if (f.gassed) {
      if (f.energy >= ENERGY_RECOVER_TO) { f.gassed = false; this.hudDirty = true; }
    } else if (f.energy < ENERGY_ATTACK_FLOOR) {
      f.gassed = true;
      this.hudDirty = true;
    }
    const pos = f.rig.root.position;
    const effect = regionEffect(f.regionDmg);
    const moveSpeed = intent.move > 0 ? 2.4 : 1.9;
    const moveAccel = f.rig.config.moveAccel * 0.5; // tune base accel

    f.speedAmt = 0;

    // ── Movement with momentum ────────────────────────────────────────
    // Compute a desired world velocity from intent, lerp `vel` toward it,
    // and integrate. Knockback is added directly and decays.
    const desired = new THREE.Vector3();
    const incapacitated = f.state === 'ko';
    // Charging roots the fighter — all the weight is loaded into the coil.
    const rooted = f.state === 'charge';
    const canSteer = !incapacitated && !rooted;

    // Unit vector toward the opponent. Hoisted out of the move branch below
    // because circling needs it too: an orbit is defined by the line between
    // the fighters, so both axes of movement derive from it.
    const toward = opp.rig.root.position.clone().sub(pos);
    toward.y = 0;
    if (toward.lengthSq() > 1e-6) toward.normalize();

    // Speed modifiers, hoisted for the same reason — a slowed or dashing
    // fighter should circle slowed or dashing too.
    // Biden "The Big Guy" slow-on-charge: halved moveMul while the slow
    // window is live. Defaults to 1.0 (no slowdown).
    // JFK "PT-109 Survivor" dash speed boost: +30% for 4 s when below 50%.
    // FDR "Four-Term Foundation" startup boost: +10% for first 3 s.
    const slow = f.slowMul || 1.0;
    let passiveMul = 1.0;
    const per = f.personality;
    if (per?.jfkDashUntil && this.t < per.jfkDashUntil) passiveMul *= 1.30;
    if (per?.fdrStartupUntil && this.t < per.fdrStartupUntil
        && PERSONALITIES.fdr?.startupBoost) {
      passiveMul *= PERSONALITIES.fdr.startupBoost.speedMul || 1.10;
    }

    if (intent.move !== 0 && canSteer) {
      desired.add(toward.clone().multiplyScalar(
        intent.move * moveSpeed * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.min(1, Math.abs(intent.move));
    }

    // ── Circling (camera depth) ───────────────────────────────────────
    // `intent.side` is a HELD direction along the CAMERA's forward axis
    // (W/↑ = +1, into the screen; S/↓ = −1, out toward the viewer), not the
    // edge-triggered dodge it used to be. Because the fighters stand side-on to
    // the camera, walking that axis is what carries you around your opponent.
    //
    // Screen-relative, deliberately. The first cut derived the axis from the
    // line between the fighters — rotationally consistent, but it flipped on
    // screen whenever the two swapped sides of the ring, so the same key walked
    // you into the screen in one exchange and out of it in the next. A movement
    // key that reverses under the player is worse than one that is merely
    // arbitrary, so the axis is the one the player can see.
    //
    // It feeds `desired` — the same lerped velocity `move` uses — rather than
    // the old `sideVel` impulse. That impulse was sized for a single tap; held
    // down it accumulated against its own decay and converged on several times
    // sprint speed.
    if (intent.side !== 0 && canSteer) {
      const camFwd = this._cameraForward();
      desired.add(camFwd.multiplyScalar(
        intent.side * CIRCLE_SPEED * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.max(f.speedAmt, Math.min(1, Math.abs(intent.side)));
    }
    // Move slowly even in hitstun/attack windup — the player is "shuffling".
    if (f.state === 'hitstun') desired.multiplyScalar(0.2);

    // Lerp velocity toward desired — mass-scaled accel; heavier fighters feel weightier.
    const a = moveAccel * (1 / f.rig.config.mass);
    const k = 1 - Math.exp(-dt * a);
    f.vel.lerp(desired, k);

    // Knockback impulse. The `sideVel` term that used to sit beside it is gone:
    // circling is steering now, so it belongs in `desired` above rather than in
    // a separate decaying impulse channel.
    f.knockback.multiplyScalar(Math.max(0, 1 - dt * 8));

    // Integrate position.
    pos.x += (f.vel.x + f.knockback.x) * dt;
    pos.z += (f.vel.z + f.knockback.z) * dt;

    // ── State machine ────────────────────────────────────────────────
    switch (f.state) {
      case 'idle': {
        // Energy regenerates slowly here and fast in the 'block' case; the
        // wind-up spends it and every release costs a flat toll on top. The
        // regen itself is applied once, above the state machine.
        // A punch needs the striking (right) arm — a fighter that lost it can
        // only kick. Kick input still works with no arms.
        // The energy gate sits ahead of both: a gassed fighter throws nothing.
        const hasEnergy = this._canAttack(f);
        const canPunch = intent.punch && hasEnergy && this._canPunch(f);
        if (canPunch || (intent.kick && hasEnergy)) {
          const name = canPunch ? 'punch' : 'kick';
          this._enterCharge(f, name);
          break;
        }
        // Signature super activation: only from idle so the pose read is clean
        // ("He lines up. He fires."). No-op if the meter isn't full or this
        // fighter has no onSuper config.
        //
        // 2026-08-11: the super key and the HUD's super bar are gone — the game
        // is down to two bars, health and energy. A HUMAN fighter therefore
        // fires the instant the meter fills; there is no longer any input that
        // could spend it, so holding it back would strand the mechanic exactly
        // the way the dead E/O key used to.
        //
        // The AI deliberately keeps its own gate (see ai.js: rung-scaled chance
        // plus a 4 s cooldown) rather than auto-firing too. That pacing is a
        // DIFFICULTY knob — low rungs hoard the meter, high rungs spend it well
        // — and firing every CPU the moment it filled would make the early
        // ladder harder, which is the opposite of simplifying the game.
        if (intent.super || this._autoSuperReady(f)) this._fireSuper(f);
        if (intent.block) {
          f.state = 'block';
          // Stamp the moment the guard went up — this is what separates a read
          // from a camp when a strike lands on it. See PERFECT_GUARD_WINDOW.
          f.guardAt = this.t;
          f.animator.setBlocking(true);
        }
        break;
      }
      case 'charge': {
        // Winding up: charge accrues while the button is held (capped at
        // CHARGE_TIME; you can hold at max forever). Release throws the
        // attack scaled by the stored charge.
        const held = f.chargeName === 'punch' ? intent.punchHeld : intent.kickHeld;
        // Holding POURS the pool into the strike (2026-09-12 rework): the bar
        // drains at the same rate the coil loads, so a fighter watching their
        // own energy bar can see exactly what the swing is costing them, and a
        // full-power release is only available to someone who banked a full
        // bar by guarding for it. The drain is clamped to what is actually left,
        // so the coil simply stops growing on an empty bar rather than loading
        // power that was never paid for.
        const drain = Math.min(dt / CHARGE_TIME, f.energy);
        f.energy -= drain;
        f.chargeAmt = Math.min(1, f.chargeAmt + drain);
        f.animator.setCharge(f.chargeName, f.chargeAmt);
        // Full-charge cue: one audible snap when the coil tops out.
        if (f.chargeAmt >= 1 && !f.chargeCued) {
          f.chargeCued = true;
          this.audio.whoosh();
        }
        // Spark motes at the loaded fist/foot once the charge means something.
        f.chargeSparkT -= dt;
        if (f.chargeAmt > 0.25 && f.chargeSparkT <= 0) {
          f.chargeSparkT = 0.16 - 0.08 * f.chargeAmt;
          const anchor = f.rig.joints[f.chargeName === 'punch' ? 'fistR' : 'footR'];
          if (anchor) {
            const p = new THREE.Vector3();
            anchor.getWorldPosition(p);
            this._spawnSparks(p, 0xffd257, 2, 0.4 + 0.5 * f.chargeAmt);
          }
        }
        if (!held) {
          const amt = f.chargeAmt;
          f.animator.setCharge(null, 0);
          this._enterAttack(f, f.chargeName, amt);
        }
        break;
      }
      case 'block': {
        if (!intent.block) {
          f.state = 'idle';
          f.animator.setBlocking(false);
        }
        break;
      }
      case 'punch':
      case 'kick': {
        const a = ATTACKS[f.state];
        const inActive = f.stateT >= a.windup && f.stateT <= a.windup + a.active;
        if (inActive && !f.hasHit) this._tryHit(f, opp, a);

        // Cancel windows: if the player input another action and we're past the
        // configured stateT threshold for that target, transition immediately.
        // Attack cancels re-enter the charge state so a held follow-up charges too.
        if (intent.punch && this._canAttack(f) && this._canPunch(f) && f.stateT >= a.cancelInto.punch) this._enterCharge(f, 'punch');
        else if (intent.kick && this._canAttack(f) && f.stateT >= a.cancelInto.kick) this._enterCharge(f, 'kick');
        else if (intent.block && f.stateT >= a.cancelInto.block) {
          f.state = 'block'; f.stateT = 0; f.guardAt = this.t;
          f.animator.setBlocking(true);
          this._destroySwingPhysics(f);
        } else if (f.stateT >= a.windup + a.active + a.recover) {
          f.state = 'idle'; f.stateT = 0; f.attack = null;
          this._destroySwingPhysics(f);
        }
        break;
      }
      case 'hitstun': {
        if (f.stateT >= HITSTUN) f.state = 'idle';
        if (f.state === 'idle') this._destroySwingPhysics(f);
        break;
      }
      case 'ko':
        // KO: drop any swing physics so the ragdoll has clean state.
        this._destroySwingPhysics(f);
        break;
    }
  }

  // Start winding an attack up. The fighter is rooted until the button is
  // released (see the 'charge' case in _tickFighter), then _enterAttack
  // throws the strike scaled by the stored charge.
  _enterCharge(f, name) {
    f.state = 'charge';
    f.stateT = 0;
    f.chargeName = name;
    // Coil starts EMPTY and is filled out of the energy bar while the button is
    // held (see the 'charge' case). It used to start at the already-banked
    // power, back when the wind-up created energy rather than spending it.
    f.chargeAmt = 0;
    f.chargeCued = false;
    f.chargeSparkT = 0;
    f.animator.setBlocking(false);
    f.animator.setCharge(name, f.chargeAmt);
    this._destroySwingPhysics(f);
  }

  _enterAttack(f, name, chargeAmt = 0) {
    // A punch needs the striking (right) arm; if it was torn off mid-charge,
    // drop back to idle rather than swinging a missing limb.
    if (name === 'punch' && !this._canPunch(f)) {
      f.state = 'idle';
      f.stateT = 0;
      f.chargeName = null;
      f.animator.setCharge(null, 0);
      return;
    }
    f.state = name;
    f.stateT = 0;
    f.hasHit = false;
    f.attack = ATTACKS[name];
    f.chargeName = null;
    f.chargeMul = 1 + (CHARGE_MAX_MUL - 1) * chargeAmt;
    // Per-swing timing multipliers (Eisenhower "Operation Overlord": 1.5×
    // windup, 0.5× active; cleared at swing completion). Read by _tryHit
    // for the phase boundary check.
    f.swingWindupMul = 1.0;
    f.swingActiveMul = 1.0;
    if (f.personality?.id === 'eisenhower' && PERSONALITIES.eisenhower?.onSwingP) {
      f.swingWindupMul = PERSONALITIES.eisenhower.onSwingP.overWindupMul || 1.0;
      f.swingActiveMul = PERSONALITIES.eisenhower.onSwingP.overActiveMul || 1.0;
    }
    // The flat swing toll (2026-09-12 rework). The wind-up has already drained
    // whatever charge this strike carries; this is the additional per-swing cost
    // that makes tap-spam unsustainable, since a jab banks almost no charge but
    // still pays the toll. Scaled by the attack's own energyMul — a punch pays
    // half a kick's, which is what makes it the tempo move. Blocking and
    // standing are what refill the bar — see the ENERGY_* block and the regen
    // in _tickFighter.
    f.energy = Math.max(0, f.energy - ATTACK_ENERGY_COST * (f.attack.energyMul ?? 1));
    if (f.energy < ENERGY_ATTACK_FLOOR) f.gassed = true;
    this.hudDirty = true;
    f.animator.play(name);

    // ── On-swing personality flags (consumed at hit landing) ─────────
    // Trump "THE WALL" haymaker: 18% of swings commit to a heavy right with
    // 1.5× damage and 1.3× knockback. We tag the swing here; the hit handler
    // multiplies base damage by the mul and clears the flag.
    const per = f.personality;
    if (per?.id === 'trump' && PERSONALITIES.trump?.onSwingP
        && !per._haymakerSuppressedThisSwing
        && this.rng.random() < PERSONALITIES.trump.onSwingP.haymakerChance) {
      f._trumpHaymaker = true;
    }
    // Nixon "Tricky Dick": 25% of swings carry a dirty tag — when the hit
    // is blocked, ~40% of the time the block lets the damage slip through.
    // SUPER override: when "I Am Not a Crook" is active, ALL swings in the
    // remaining counter carry the dirty tag (decays per swing via the
    // superDirtySwingsLeft counter).
    const nixonDirtyChance = per?.id === 'nixon'
      ? (per.superDirtySwingsLeft > 0
          ? 1.0
          : PERSONALITIES.nixon.onSwingP.dirtyChance)
      : 0;
    if (per?.id === 'nixon' && PERSONALITIES.nixon?.onSwingP
        && !f._dirtySwing
        && this.rng.random() < nixonDirtyChance) {
      f._dirtySwing = true;
      if (per.superDirtySwingsLeft > 0) {
        per.superDirtySwingsLeft = Math.max(0, per.superDirtySwingsLeft - 1);
      }
    }
    // Bush Sr. "VOODOO ECONOMICS": next 3 swings after a super each carry
    // 1.4× damage on top of whatever else is going on. The flag flips off
    // one swing at a time.
    if (per?.id === 'bushsr' && per.superPumpSwingsLeft > 0) {
      f._bushsrSuperPump = true;
      per.superPumpSwingsLeft = Math.max(0, per.superPumpSwingsLeft - 1);
    }
    // Ford "Ford Stumble": 15% of swings self-stun for 0.6 s — abort the
    // committed swing mid-air and route the fighter to 'idle' briefly.
    if (per?.id === 'ford' && PERSONALITIES.ford?.onSwingP) {
      const cfg = PERSONALITIES.ford.onSwingP;
      if (this.rng.random() < cfg.stumbleChance) {
        per.stumbleUntil = this.t + cfg.stumbleSelfStunSecs;
        f.state = 'idle';
        f.stateT = 0;
        f.attack = null;
        f.animator.play('stumble');
        return;
      }
    }
    // Trail color: cool steel normally, hot gold on a charged release —
    // "charged" means wound up well past the 1/3 starting bank, so gold still
    // reads as earned bonus power rather than lighting up every tap.
    if (f.trail) f.trail.color.setHex(chargeAmt > 0.65 ? 0xffd257 : 0xcfe0ff);
    this.audio.whoosh();
    // Attack lunge: a real step into the strike, scaled by charge. This is
    // where the "reach" lives now that the hitboxes track the actual limb —
    // a charged release lunges dramatically further.
    const opp = this.fighters.find((o) => o !== f);
    if (opp) {
      const dir = new THREE.Vector3().subVectors(opp.rig.root.position, f.rig.root.position);
      dir.y = 0;
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        // FDR "Fireside Chat" reach bonus: his next swing's lunge is scaled
        // by the per-fighter fdrNextSwingReachMul (set during a chat iframe).
        const reachMul = (f.personality?.fdrNextSwingReachMul && f.personality.fdrNextSwingReachMul > 1.0) || 1.0;
        if (reachMul > 1.0) f.personality.fdrNextSwingReachMul = 1.0; // consumed
        const lunge = (name === 'kick' ? 2.2 : 1.8) * (1 + 1.4 * chargeAmt) * reachMul;
        f.knockback.add(dir.multiplyScalar(lunge));
      }
    }
    // Tear down any prior swing physics and build the new striker bodies.
    // These are the cannon-es spheres that actually register hits via
    // the `collide` event during the active window.
    if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
    f.swingPhysics = buildSwingPhysics(this._physics.world, this._physics.materials, f, name, 'active');
  }

  _destroySwingPhysics(f) {
    if (f.swingPhysics) {
      destroySwingPhysics(this._physics.world, f.swingPhysics);
      f.swingPhysics = null;
    }
  }



  // The camera's forward direction, flattened to the ground plane: the axis the
  // circle keys walk along. +1 on `intent.side` follows this vector (into the
  // screen, away from the viewer); −1 walks back against it, toward the viewer.
  //
  // Was named _sideDirection and used to aim a one-shot sidestep impulse; it is
  // now the steering axis for held circling. The fallback matters on the first
  // frame or two, before the camera has been aimed at the ring — returning a
  // zero vector there would drop the input silently instead of picking a
  // direction the player can correct.
  _cameraForward() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    return dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, -1);
  }



  // Decay the post-FX pulses and push them into the passes.
  _updateFx(dt) {
    // #2 runs on WALL-CLOCK dt, which is why it lives here rather than in
    // _tick: the cinematic's own time dilation would otherwise stretch its
    // timeline, and a beat that slows itself down never ends.
    this._tickSuperCinematic(dt);
    this.caPulse *= Math.exp(-dt * 4);
    this.bloomPulse *= Math.exp(-dt * 5);
    this.exposurePulse *= Math.exp(-dt * 5);
    this.radialPulse *= Math.exp(-dt * 7);
    // #3 speedlines decay fast — they are a stamp, not a state. The super
    // cinematic re-arms them every frame while it runs, which is what keeps
    // them up for its duration without needing a second code path.
    this._speedPulse = (this._speedPulse || 0) * Math.exp(-dt * 6.5);
    if (this._speedPulse < 0.002 || this._calm()) this._speedPulse = 0;
    this._updateImpactFrames(dt);

    // #5 — the room drops out for the length of the freeze. Driven from the
    // renderer rather than from _hitFeedback so it tracks the ACTUAL pause
    // (which _tick decrements) instead of the requested one; every path that
    // sets hitstopT — hits, clashes, supers — gets it for free.
    if (this.audio) this.audio.setHitstop(this.hitstopT > 0);

    // #9 afterimage. The pass is switched off (not just faded to 0) the moment
    // the window closes, because a damp-0 AfterimagePass still costs a full
    // screen blit and a target swap every frame; a disabled one costs nothing.
    if (this.afterimage) {
      if (this._smearT > 0) {
        this._smearT -= dt;
        this.afterimage.enabled = true;
        this.afterimage.uniforms.damp.value = this._smearAmt;
        if (this._smearT <= 0) {
          this._smearT = 0;
          this._smearAmt = 0;
          this.afterimage.enabled = false;
        }
      } else if (this.afterimage.enabled) {
        this.afterimage.enabled = false;
      }
    }

    // §GFX-2 — no-op unless a KO is running.
    if (this.rackFocus) this.rackFocus.update(dt);
    if (this.fxPass) {
      // The shared impact envelope is ADDED to this game's own pulses rather
      // than replacing them. PoBrawl's per-attack feedback is tuned to the
      // attack (a kick smears more than a jab) and that nuance is worth
      // keeping; impactBus contributes the part that is common to every game,
      // so a hit now punches the 3D image and shakes the DOM chrome on one
      // shared curve instead of two that drift apart.
      this.fxPass.uniforms.uCA.value = this.caPulse + PostFx.punchAberration(0.8);
      this.fxPass.uniforms.uRadial.value = this.radialPulse + PostFx.punchRadial(0.35);
      // KO color drain rides the lights-down blend (keeps the reds hot).
      this.fxPass.uniforms.uDesat.value = this.lightsDim * 0.55;
      // #3 / #2 — one uniform serves both the impact stamp and the super, which
      // simply keeps re-arming _speedPulse while its cinematic runs.
      this.fxPass.uniforms.uSpeed.value = this._speedPulse || 0;

      // Film grain clock (idea #10). atmoT always advances, even between
      // rounds, so the grain never freezes on a paused frame.
      this.fxPass.uniforms.uTime.value = this.atmoT;
      // Vignette breathing (idea #10): a slow ±0.04 swell around the 0.5 base,
      // tightening hard as the house lights drop for the KO so the frame
      // closes in on the fallen fighter.
      this.fxPass.uniforms.uVignette.value =
        0.5 + 0.04 * Math.sin(this.atmoT * 0.7) + this.lightsDim * 0.35;

      // ── Godrays (idea #10) — REMOVED 2026-08-07 (user request) ───────
      // This was a 16-tap radial smear from every pixel toward the overhead
      // spotlight's projected screen position, so it drew visible streaks
      // fanning out from wherever that light happened to land — usually the
      // upper-left of the frame. It ran at a constant 0.07 baseline during
      // normal play ("keeps the overhead shaft reading as volumetric") on top
      // of the KO ramp, so it never actually switched off; killing the KO
      // lights-down left the streaks behind.
      //
      // Held at 0 so the shader's `if (uGodrays > 0.003)` branch is skipped
      // outright — that also drops 16 texture samples per pixel per frame.
      // The projection maths that fed uGodraysOrig went with it; nothing else
      // reads that uniform.
      this.fxPass.uniforms.uGodrays.value = 0;
    }
    if (this.bloomPass) this.bloomPass.strength = 0.32 + this.bloomPulse;
    this.renderer.toneMappingExposure = this.exposureBase + this.exposurePulse;

    // Impact-light pool decay.
    for (const s of this._impactLights || []) {
      if (s.life > 0) {
        s.life = Math.max(0, s.life - dt);
        s.light.intensity = s.peak * (s.life / s.dur);
      }
    }
    this._updateDanger(dt);
  }

  // ══ Danger state (GFX/SOUND #4, 2026-09-23) ═══════════════════════════
  // A fighter under DANGER_HP is in the red: a heartbeat starts under the mix,
  // quickening as they drop; the music sinks under a lowpass; and the screen
  // edge on THEIR side of the frame tints red on each beat. The side is taken
  // from where the fighter actually is on screen (they swap sides), not from
  // which player they are. Wall-clock, so the beat keeps time through hitstop.
  _updateDanger(dt) {
    const side = [0, 0];
    let worst = 0;
    if (this.phase === 'fighting' && !this.training && this.fighters && this.combat) {
      for (const f of this.fighters) {
        const hp = this._hp(f) / MAX_HP;
        if (hp <= 0) continue;
        const d = THREE.MathUtils.clamp((DANGER_HP - hp) / DANGER_RAMP, 0, 1);
        if (d <= 0) continue;
        _dmgProj.copy(f.rig.root.position).project(this.camera);
        const s = _dmgProj.x < 0 ? 0 : 1;
        side[s] = Math.max(side[s], d);
        worst = Math.max(worst, d);
      }
    }
    const k = 1 - Math.exp(-dt * 3);
    this._dangerL = (this._dangerL || 0) + (side[0] - (this._dangerL || 0)) * k;
    this._dangerR = (this._dangerR || 0) + (side[1] - (this._dangerR || 0)) * k;

    // Heartbeat: 70 bpm at the threshold, 130 at the brink.
    if (worst > 0.01) {
      const period = 60 / (70 + 60 * worst);
      this._heartT = (this._heartT ?? period) + dt;
      if (this._heartT >= period) {
        this._heartT = 0;
        this._heartAge = 0;
        this.audio?.heartbeat(0.45 + 0.55 * worst);
      }
    } else {
      this._heartT = undefined;
    }
    this._heartAge = (this._heartAge ?? 9) + dt;
    const a = this._heartAge;
    // Lub-dub envelope, matching the two thumps audio.heartbeat schedules.
    let pulse = Math.exp(-a * 7) + (a > 0.17 ? 0.7 * Math.exp(-(a - 0.17) * 7) : 0);
    if (this._calm()) pulse = 0.5; // reduced motion: the tint holds still
    if (this.fxPass) {
      const u = this.fxPass.uniforms;
      u.uDangerL.value = this._dangerL < 0.003 ? 0 : this._dangerL;
      u.uDangerR.value = this._dangerR < 0.003 ? 0 : this._dangerR;
      u.uHeart.value = Math.min(1, pulse);
    }
    // The music filter: throttled like the crowd push, for the same reason.
    if (this.audio && Math.abs(worst - (this._dangerPushed ?? -1)) > 0.04) {
      this._dangerPushed = worst;
      this.audio.setDanger(worst);
    }
  }

  // ══ Mat wear (GFX/SOUND #7) ═══════════════════════════════════════════
  // Footwork scuffs the vinyl where a moving fighter plants; knockback drags
  // skid streaks; a KO'd body leaves a scrape and a puff of canvas dust.
  _updateMatWear(dt) {
    if (!this.matWear) return;
    this.matWear.update(dt);
    if (!this.fighters) return;
    if (this.phase === 'fighting' || this.phase === 'ko') {
      for (const f of this.fighters) {
        if (f.state === 'ko' || !f.vel || !f.knockback) continue;
        const root = f.rig.root.position;
        const kb = Math.hypot(f.knockback.x, f.knockback.z);
        if (kb > 1.6) {
          // Skid: two parallel streaks (one per shoe) from last frame's spot.
          if (f._skidFrom) {
            const dx = root.x - f._skidFrom.x, dz = root.z - f._skidFrom.z;
            const len = Math.hypot(dx, dz) || 1;
            const ox = (-dz / len) * 0.12, oz = (dx / len) * 0.12;
            const str = Math.min(1, kb / 4);
            this.matWear.skid(f._skidFrom.x + ox, f._skidFrom.z + oz, root.x + ox, root.z + oz, str);
            this.matWear.skid(f._skidFrom.x - ox, f._skidFrom.z - oz, root.x - ox, root.z - oz, str);
          } else {
            this._spawnDust(root.x, root.z, 0.3);
          }
          f._skidFrom = { x: root.x, z: root.z };
          continue;
        }
        f._skidFrom = null;
        const sp = Math.hypot(f.vel.x, f.vel.z);
        f._scuffT = (f._scuffT || 0) - dt;
        if (sp > 0.9 && f._scuffT <= 0) {
          f._scuffT = 0.14;
          const ang = Math.atan2(f.vel.z, f.vel.x);
          for (const name of ['footL', 'footR']) {
            const j = f.rig.joints[name];
            if (!j) continue;
            j.getWorldPosition(_blobPos);
            this.matWear.scuff(_blobPos.x, _blobPos.z, ang, Math.min(1, sp / 3));
          }
        }
      }
    }
    // The KO'd body meets the mat a beat after the blow (see the KO block in
    // hitResolution.js, which arms this): dust, a scrape and a sweat splash.
    if (this._koDust) {
      this._koDust.t -= dt;
      if (this._koDust.t <= 0) {
        const f = this._koDust.fighter;
        this._koDust = null;
        const hips = f?.rig?.joints?.hips;
        if (hips) {
          hips.getWorldPosition(_blobPos);
          if (Math.abs(_blobPos.x) < MAT_HALF && Math.abs(_blobPos.z) < MAT_HALF) {
            this._spawnDust(_blobPos.x, _blobPos.z, 1.3);
            this.matWear.bodyfall(_blobPos.x, _blobPos.z, 1);
          }
        }
      }
    }
  }

  // ══ Result package: news + clip (GFX/SOUND #9, #10) ═══════════════════
  // Called from _reportResult once the winner is known.
  _presentResult() {
    const [f1, f2] = this.fighters;
    if (this.news) {
      const ko = this.fighters.some((f) => f.state === 'ko');
      this.news.show({
        p1: f1.rig.config.name || f1.charId,
        p2: f2.rig.config.name || f2.charId,
        winner: this.winner,
        ko,
        seconds: this.clock || 0,
        stats: [f1.stats, f2.stats],
      }, () => this.rng.random());
      this.audio?.newsSting();
    }
    if (this.clip) {
      this.clip.freeze();
      // Let the fall, the banner and the first hops of a celebration make it
      // into the file before closing it.
      clearTimeout(this._clipTimer);
      this._clipTimer = setTimeout(() => {
        if (this.disposed || !this.clip) return;
        this.clip.capture().then((blob) => {
          if (!blob || this.disposed) return;
          this.news?.showClipButton(true);
          this.dotnet?.invokeMethodAsync('OnClipReady').catch(() => {});
        });
      }, 1800);
    }
  }

  /** #10 — save or share the last KO clip (the news button and the result modal). */
  saveClip() {
    return this.clip ? this.clip.save() : Promise.resolve(false);
  }

  // ══ Anime impact frames (GFX/SOUND #3) ═══════════════════════════════
  // On a heavy connect only. This used to fire three things on the frame the
  // hitstop starts — a flat-white silhouette over both fighters, a shock ring,
  // and speedlines raking in from the frame edges, plus an afterimage smear.
  //
  // 2026-09-12: everything except the shock ring is gone. The note that used to
  // close this block said the bloom/exposure pulses had been deleted because
  // "they fired on EVERY hit and overlapped into a continuous flicker; anything
  // this loud has to stay rare to stay readable" — and then failed to notice
  // that "heavy connect" is not rare. HEAVY_HIT_DMG is 13 out of 100 HP, which
  // any charged swing clears, so these ran several times a second in a normal
  // exchange and strobed the picture exactly as their predecessors had.
  //
  // The surviving ring is anchored to the contact point in world space, so it
  // marks WHERE the hit landed instead of changing the brightness of the whole
  // frame. See _impactFrame in vfx.js.


  // House-light choreography. Backlights track their fighters every frame for
  // rim separation.
  //
  // 2026-08-07 (user request): the KO "lights-down" cinematic is removed. It
  // used to ramp `lightsDim` to 1 on a KO, which cut hemi/key/fill by 75-85%,
  // pulled the vignette from 0.50 to 0.85, drained 55% of the colour and blew
  // the godrays out to a full shaft. On anything but a bright display the
  // result was a screen that simply went black for a second and came back
  // washed-out and grainy. Pinned to 0 so every consumer of `lightsDim`
  // (uDesat, uVignette, uGodrays and the four house lights below) collapses to
  // its neutral, lights-up value. The KO still reads through the flash, the
  // slow-mo fall, the replay and the banner.
  _updateLighting(dt) {
    const L = this.arena && this.arena.lights;
    if (!L) return;
    this.lightsDim = 0;
    const d = this.lightsDim;
    L.hemi.intensity = 0.22 * (1 - d * 0.85);
    L.key.intensity = 3.4 * (1 - d * 0.75);
    L.rim.intensity = 1.0 * (1 - d * 0.5);
    L.fill.intensity = 0.6 * (1 - d * 0.85);

    // ── Personality-driven rim pulses ─────────────────────────────
    // Active modes (Reagan morningInAmerica, Bush decider, FDR fourTerm, etc.)
    // tint the rim light. The key/fill stay neutral; only the rim breathes.
    // Multiple personalities can pulse — pick the strongest tint and lerp
    // toward the warm/cool midpoint so the rim never goes wild.
    let rimTint = new THREE.Color(0x6070ff);   // default cool blue rim
    let rimMul = 1.0;
    if (this.fighters) {
      for (const f of this.fighters) {
        const per = f.personality;
        if (!per) continue;
        const mode = per.activeMode;
        const t = per.modeExpiresAt ? Math.max(0, per.modeExpiresAt - this.t) : 0;
        if (mode === 'morningInAmerica' && PERSONALITIES.reagan) {
          // Pulse gold every ~0.5 s.
          const pulse = 0.5 + 0.5 * Math.sin(this.t * 6.0);
          rimTint = new THREE.Color(0xffd66b).lerp(rimTint, 1 - pulse);
          rimMul = Math.max(rimMul, 1.0 + 0.35 * pulse);
        } else if (mode === 'decider' && PERSONALITIES.bush) {
          // Magenta steady-burn — Bush's "decision moment".
          rimTint = rimTint.clone().lerp(new THREE.Color(0xff59a8), 0.65);
          rimMul = Math.max(rimMul, 1.05);
        } else if (mode === 'fourTerm' && PERSONALITIES.fdr) {
          // Warm amber for FDR's warm-up; settles back to blue at expiry.
          rimTint = rimTint.clone().lerp(new THREE.Color(0xffb056), 0.6);
        } else if (mode === 'malaiseSpeech' && PERSONALITIES.carter) {
          // Cool teal — Carter's "wake up" call.
          rimTint = rimTint.clone().lerp(new THREE.Color(0x6cd6c4), 0.5);
        } else if (mode === 'dayOfInfamy' && PERSONALITIES.fdr) {
          // Crimson — FDR rises at 30% HP. Strong + sustained, not pulsing.
          rimTint = rimTint.clone().lerp(new THREE.Color(0xff3232), 0.7);
          rimMul = Math.max(rimMul, 1.15);
        }
        // Per-fighter single-fire person pulses that aren't activeModes.
        if (f.charId === 'jfk' && per.jfkProfileIframesUntil && this.t < per.jfkProfileIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0xfff7c2), 0.55);
        }
        if (f.charId === 'eisenhower' && per.eisenhowerIframesUntil && this.t < per.eisenhowerIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0x9edcff), 0.55);
        }
        if (f.charId === 'fdr' && per.fdrIframesUntil && this.t < per.fdrIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0xfff0c0), 0.5);
        }
      }
    }
    L.rim.color.copy(rimTint);
    L.rim.intensity *= rimMul;
    L.cornerA.intensity = 1.7 * (1 - d * 0.9);
    L.cornerB.intensity = 1.7 * (1 - d * 0.9);
    L.spot.intensity = 1.6 + d * 1.6;
    // Studio rig panels dim with the house lights.
    if (L.rectA) L.rectA.intensity = 3.4 * (1 - d * 0.85);
    if (L.rectB) L.rectB.intensity = 2.6 * (1 - d * 0.85);
    // The volumetric shaft brightens as the hall goes dark — the classic
    // "single spotlight through smoky air" KO moment.
    const atmo = this.arena.atmo;
    if (atmo && atmo.cone) {
      atmo.cone.material.opacity = 0.09 + d * 0.14;
    }

    // ── Room light swing ──────────────────────────────────────────────
    // The overhead house light isn't nailed above the ring centre: it traces
    // a wide elongated ellipse up in the rig (mostly along Z, with a smaller
    // X amplitude and a strong vertical bob), aimed down at the two fighters,
    // so the pool of light, the cast shadows and the volumetric shaft all
    // sweep visibly back and forth across the canvas over the course of a
    // round instead of sitting dead still. One full cycle takes ~12 s — fast
    // enough to read as a swinging rig fixture, slow enough that it doesn't
    // feel like a strobe.
    this._houseT = (this._houseT || 0) + dt;
    const orbit = this._houseT * HOUSE_LIGHT_SPEED;
    L.spot.position.set(
      Math.cos(orbit) * HOUSE_LIGHT_RADIUS_X,
      HOUSE_LIGHT_HEIGHT + Math.sin(orbit * 1.4) * HOUSE_LIGHT_BOB,
      Math.sin(orbit) * HOUSE_LIGHT_RADIUS);

    // Spotlight target: the midpoint between the fighters normally, the loser
    // during the KO.
    const loser = this.fighters && this.fighters.find((f) => f.state === 'ko');
    if (loser && d > 0.01) {
      const lp = loser.rig.root.position;
      _spotTarget.set(lp.x, 0, lp.z);
    } else if (this.fighters && this.fighters.length === 2) {
      const a = this.fighters[0].rig.root.position;
      const b = this.fighters[1].rig.root.position;
      _spotTarget.set((a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5);
    } else {
      _spotTarget.set(0, 0, 0);
    }
    L.spot.target.position.lerp(_spotTarget, Math.min(1, dt * 3));
    L.spot.target.updateMatrixWorld();

    // Keep the fake volumetric shaft glued to the beam: the cylinder's +Y
    // points back up at the lamp, and its centre sits 5.4 units down the beam
    // — the same offset it had baked in when the lamp hung fixed at y = 11.
    if (atmo && atmo.cone) {
      _beamDir.copy(L.spot.position).sub(L.spot.target.position);
      if (_beamDir.lengthSq() < 1e-6) _beamDir.set(0, 1, 0); else _beamDir.normalize();
      atmo.cone.quaternion.setFromUnitVectors(_upY, _beamDir);
      atmo.cone.position.copy(L.spot.position).addScaledVector(_beamDir, -5.4);
    }

    // (The godray blade's screen-space origin was fed from L.spot.position
    // here. Godrays were removed 2026-08-07 — see the uGodrays note in
    // _updateFx — so nothing consumes it any more.)

    // Backlights: behind each fighter, opposite the camera.
    if (this.fighters && this._backlights) {
      for (let i = 0; i < this.fighters.length; i++) {
        const fp = this.fighters[i].rig.root.position;
        const bl = this._backlights[i];
        if (!bl) continue;
        _blDir.copy(fp).sub(this.camera.position);
        _blDir.y = 0;
        if (_blDir.lengthSq() < 1e-6) _blDir.set(0, 0, -1);
        _blDir.normalize();
        bl.position.set(fp.x + _blDir.x * 3, 3.2, fp.z + _blDir.z * 3);
        bl.target.position.set(fp.x, 1.0, fp.z);
        bl.intensity = 3.0 * (1 - d * 0.5);
      }
    }

    // ── KO Limelight ─────────────────────────────────────────────────
    // Sits above and sweeps horizontally across the loser during the KO
    // cinematic. Decreases each frame; intensity rises as house lights dim
    // so the contrast between dark hall and tight white slash is dramatic.
    if (this._limelightActive > 0 && this._limelight) {
      this._limelightActive -= dt;
      const lf = this.fighters.find((f) => f.state === 'ko');
      if (lf) {
        // Lerp the target over the body — tracks the falling hips smoothly.
        const ft = lf.rig.joints.torso.getWorldPosition(_blDir);
        _blDir.copy(ft);
        this._limelightTarget.lerp(_blDir, Math.min(1, dt * 4));
        this._limelight.target.position.copy(this._limelightTarget);
      }
      // Spotlight lives off-screen-ish, brushes the loser from above-right.
      const tx = this._limelightTarget.x;
      const tz = this._limelightTarget.z;
      this._limelight.position.set(tx + 2.5, 6.5, tz - 1.2);
      // Fades 0→6 over the first 0.4 s, holds, fades on expiring.
      const t = THREE.MathUtils.clamp(
        Math.min(this._limelightActive, 3.5 - this._limelightActive + 0.5) / 0.6, 0, 1);
      this._limelight.intensity = Math.max(0, 6.0 * t);
      // Cool the colour as we ramp — warm at start, white at peak (looks
      // cinematic vs. the warm key).
      this._limelight.color.setHex(this._limelightActive > 3.0 ? 0xfff0d0 : 0xffffff);
    } else if (this._limelight && this._limelight.intensity !== 0) {
      this._limelight.intensity = 0;
    }

    // ── KO Victor Halo ─────────────────────────────────────────────
    // Contrasting cooler spotlight follows the WINNER (not the loser). The
    // tight white-on-loser + cool halo-on-winner reads as "the audience
    // sees both fighters in their final moments" — cinematic.
    if (this.phase === 'ko' && this.winner && this.fighters) {
      const wf = this.fighters[this.winner - 1];
      if (wf && this._victorHalo) {
        const wpos = wf.rig.root.position;
        this._victorHalo.position.set(wpos.x - 1.4, 3.4, wpos.z - 0.8);
        this._victorHalo.target.position.set(wpos.x, 1.0, wpos.z);
        // Halo rises with house-dim, then fades as the result screen takes
        // over (the result modal flips cameraMode to 'result' and we drop
        // the halo there).
        const cam = this.cameraMode;
        const haloT = THREE.MathUtils.clamp(cam === 'ko' ? d * 1.4 : 0, 0, 1);
        this._victorHalo.intensity = 2.6 * haloT;
        this._victorHalo.color.setHex(0xa0c4ff);
      }
    } else if (this._victorHalo) {
      this._victorHalo.intensity = 0;
    }
  }

  // Shared radial-gradient texture for the fighters' contact-shadow blobs.
  // Override `opts.inner` / `opts.outer` to tint variants (e.g. AO discs
  // want a harder black inner).
  _makeBlobTexture(opts = {}) {
    const inner = opts.inner || 'rgba(0,0,0,0.9)';
    const mid = opts.mid || 'rgba(0,0,0,0.45)';
    const outer = opts.outer || 'rgba(0,0,0,0)';
    const cacheKey = `${inner}|${mid}|${outer}`;
    if (this._blobTexCache && this._blobTexCache.key === cacheKey) return this._blobTexCache.tex;
    if (!this._blobTexCache) this._blobTexCache = {};
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this._blobTexCache = { key: cacheKey, tex };
    return tex;
  }

  // Per-tick posture: head tracking toward the opponent, momentum lean from
  // the fighter's own velocity/acceleration, and the clinch-frame blend at
  // chest-to-chest range. All feed overlay targets on the animator.
  _updatePosture(f, opp, dt) {
    if (!opp || f.state === 'ko') return;
    const anim = f.animator;

    // ── Head tracking: look at the opponent's upper body ─────────────
    f.rig.joints.head.getWorldPosition(_lookA);
    opp.rig.joints.hips.getWorldPosition(_lookB);
    _lookB.y += 0.55; // chest height
    const dx = _lookB.x - _lookA.x, dz = _lookB.z - _lookA.z;
    const horiz = Math.hypot(dx, dz);
    let yawLocal = Math.atan2(dx, dz) - f.rig.root.rotation.y;
    while (yawLocal > Math.PI) yawLocal -= Math.PI * 2;
    while (yawLocal < -Math.PI) yawLocal += Math.PI * 2;
    // Pitch: negative x rotation looks up; a downed opponent pulls the gaze down.
    const pitch = -Math.atan2(_lookB.y - _lookA.y, Math.max(horiz, 0.4));
    anim.setLook(yawLocal, pitch);

    // ── Momentum lean: into acceleration, counter-lean when braking ──
    const vx = f.vel.x + f.knockback.x, vz = f.vel.z + f.knockback.z;
    const ax = (vx - (f._pvx ?? vx)) / dt, az = (vz - (f._pvz ?? vz)) / dt;
    f._pvx = vx; f._pvz = vz;
    const yaw = f.rig.root.rotation.y;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const lvz = vx * sin + vz * cos, lvx = vx * cos - vz * sin;   // local fwd/side vel
    const laz = ax * sin + az * cos, lax = ax * cos - az * sin;   // local fwd/side accel
    anim.setMoveLean(lvz * 0.06 + laz * 0.006, -(lvx * 0.05 + lax * 0.005));

    // ── Clinch frame: arms brace when chest-to-chest, nobody swinging ─
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const passive = (s) => s === 'idle' || s === 'block';
    anim.setClinch(dist < 1.05 && passive(f.state) && passive(opp.state));
  }

  // Track each fighter's hips; widen + darken the blob as the body drops
  // (knockdown/KO) so the lying pose still reads as grounded. The AO disc
  // is a separate, tighter patch that stays anchored under the planted
  // feet — sells "not floating".
  _updateBlobShadows() {
    if (!this.fighters) return;
    for (const f of this.fighters) {
      if (!f.blob) continue;
      f.rig.joints.hips.getWorldPosition(_blobPos);
      f.blob.position.x = _blobPos.x;
      f.blob.position.z = _blobPos.z;
      const standing = THREE.MathUtils.clamp((_blobPos.y - 0.15) / 0.85, 0, 1);
      const s = THREE.MathUtils.lerp(1.5, 1.0, standing);
      f.blob.scale.set(s, s, 1);
      f.blob.material.opacity = THREE.MathUtils.lerp(0.5, 0.34, standing);

      // AO disc: tracks the planted foot rather than the hips. While
      // standing the disc stays tight; as the body drops it slides out a
      // bit but never balloons like the contact blob.
      if (f.aoDisc) {
        f.rig.joints.footR.getWorldPosition(_blobPos);
        f.aoDisc.position.x = _blobPos.x;
        f.aoDisc.position.z = _blobPos.z;
        const aos = THREE.MathUtils.lerp(1.4, 1.0, standing);
        f.aoDisc.scale.set(aos, aos, 1);
        // AO fades when the body is upright (where the blob does the work)
        // and goes pitch-black when prone (where it sells the lie-down).
        f.aoDisc.material.opacity = THREE.MathUtils.lerp(0.8, 0.25, standing);
      }
    }
  }

  // Photosensitive-safe presentation: the app-wide reduced-motion setting
  // (user toggle OR OS preference) alone. Read live rather than cached so
  // flipping it mid-fight takes effect at once.
  _calm() {
    return motionReduced();
  }

  _triggerFlash() {
    // CSS chromatic-aberration flash on KO — DOM overlay so we don't need a
    // post-processing chain. Auto-clears on the next animation frame.
    if (!this.flash || this._calm()) return;
    this.flash.classList.remove('pb-flash-active');
    void this.flash.offsetWidth; // force reflow
    this.flash.classList.add('pb-flash-active');
  }

  // Hooks handed to props.js so the crate module can push damage / FX back
  // through the engine without importing it.
  _makePropHooks() {
    return {
      onChip: (f, dmg, dx, dz) => this._propChip(f, dmg, dx, dz),
      onImpactFx: (pos, power) => {
        this._spawnSparks(pos, 0xc8a060, 8, 1.6);
        this.audio.impact({ power: power ?? 1, worldPos: pos });
      },
    };
  }

  // Secondary "chip" damage from crashing into / getting hit by a crate
  // (chain reactions, corner turnbuckle). Capped so a crate can never land the
  // KILLING blow — HP is floored at 5 — keeping the KO strictly a fist/foot
  // event and the combat/KO pipeline untouched.
  _propChip(f, dmg, dx = 0, dz = 0) {
    if (!f || f.state === 'ko' || dmg <= 0) return;
    const player = this.combat.getPlayer(f.playerId);
    if (!player) return;
    const capped = Math.min(dmg, Math.max(0, player.health - 5));
    if (capped <= 0.1) return;
    // Online the server owns every point of HP — the crate still flies, it just costs nothing.
    if (!this.online) this.combat.damage({ playerId: f.playerId, amount: capped, sourceId: f.playerId });
    this.hudDirty = true;
    this._commentate('crate', f);
    const p = f.rig.root.position;
    this._spawnSparks(new THREE.Vector3(p.x, 1.0, p.z), 0xffd0a0, 5, 1.2);
    this.audio.grunt({ power: 0.6 });
    setExpression(f.rig, 'hurt');
    f.expressionT = Math.max(f.expressionT, 0.4);
  }

  // Remove a fighter's live-fight cannon bodies (rig root, hurt spheres,
  // constraints). Used at KO handoff (the ragdoll replaces them), respawn
  // and dispose. Never call from inside a physics step.
  _removeFighterPhysics(f) {
    if (!this._physics || !f.fighterPhysics) return;
    const world = this._physics.world;
    for (const s of f.fighterPhysics.hurtSpheres) {
      if (world.bodies.includes(s)) world.removeBody(s);
    }
    for (const c of f.fighterPhysics.constraints) {
      if (world.constraints.includes(c)) world.removeConstraint(c);
    }
    if (world.bodies.includes(f.fighterPhysics.rigRoot)) {
      world.removeBody(f.fighterPhysics.rigRoot);
    }
    f.fighterPhysics = null;
  }


  // ── Touch controls ───────────────────────────────────────────────────
  // Fixed to the bottom of the viewport (the empty strip below the canvas
  // on portrait phones). Left cluster: walk in/out plus the two circle keys.
  // Right cluster: block (hold), punch, kick (hold to charge). Synthetic key
  // events feed the normal input path, so the touch panel has no control
  // semantics of its own — rebinding a key in input.js rebinds the button.
  _buildTouchControls() {
    const panel = document.createElement('div');
    panel.className = 'pb-touch';
    const mk = (code, label, small = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (small) b.className = 'pb-touch-small';
      const down = (e) => {
        e.preventDefault();
        b.classList.add('pb-touch-held');
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        // §7 Haptic tick on press — heavier for strikes (punch/kick) than movement.
        // Bug fix (2026-08-07): skip on kiosk/demo routes — no user gesture
        // means every call below would emit a console error.
        try {
          const onKiosk = (location.search || '').indexOf('kiosk=') >= 0
            || /\/demo(\b|\/|$)/i.test(location.pathname || '');
          // The Profile haptics opt-out, not mute ("sound off, buzz on" is a real choice) —
          // this read pomini_muted until 2026-09-29, so the haptics toggle did nothing here.
          if (!onKiosk && localStorage.getItem('pomini_haptics') !== '0' && navigator.vibrate) {
            navigator.vibrate((code === 'KeyF' || code === 'KeyG') ? 16 : 8);
          }
        } catch { }
      };
      const up = () => {
        if (!b.classList.contains('pb-touch-held')) return;
        b.classList.remove('pb-touch-held');
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up); // finger slid off = release
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    // Left cluster is the movement axis: walk in/out, and the two circle keys
    // beside them. All four are hold-to-act, matching the keyboard exactly —
    // these dispatch synthetic keydown/keyup for the very same codes.
    const left = document.createElement('div');
    left.className = 'pb-touch-cluster';
    left.append(mk('KeyA', '◀'), mk('KeyD', '▶'),
      mk('KeyW', '↺', true), mk('KeyS', '↻', true));
    const right = document.createElement('div');
    right.className = 'pb-touch-cluster';
    // 2026-08-11: the ⚡ super button went with the super key it pressed, and
    // the 🛡 moved from KeyS to KeyR — S is a circle key now, so leaving the
    // shield on it would have had touch players orbiting when they meant to
    // guard, with no way to block at all.
    right.append(mk('KeyR', '🛡', true),
      mk('KeyF', '👊'), mk('KeyG', '🦵'));
    // Online has a special (full energy); the local modes fire theirs by themselves.
    if (this.options.mode === 'online') right.append(mk('KeyH', '⚡', true));
    panel.append(left, right);
    this.container.appendChild(panel);
    this.touchEl = panel;
  }

  // _syncTouchSuper removed 2026-08-11 with the touch ⚡ button it drove. It
  // mirrored the super meter onto that button the way the HUD bar mirrored it
  // for keyboard players; with the meter no longer surfaced anywhere, there is
  // nothing to mirror.

  // Should this fighter's signature super fire on its own this frame?
  //
  // True only for HUMAN-driven fighters with a full meter. Since the super key
  // was removed there is no input that can spend the meter, so a human's super
  // fires automatically — the president still does their signature thing, the
  // player just doesn't manage a third resource. AI fighters return false here
  // and keep firing through `intent.super`, which preserves ai.js's rung-scaled
  // pacing (see the note at the call site in _tickFighter).
  //
  // `_fireSuper` re-checks the meter and the onSuper config and no-ops if
  // either is missing, so BOB — who has no signature move by design — can never
  // trigger anything here.
  _autoSuperReady(f) {
    return f?.controller?.isHuman === true
      && (f.personality?.superMeter || 0) >= 1.0;
  }

  // Can this fighter still throw a punch? The engine only ever swings the RIGHT
  // arm, so a punch needs the right arm attached. (The left arm always tears off
  // first — see _severArm — so a one-armed fighter punches with its right; once
  // the right is gone too it can only kick.)
  _canPunch(f) {
    return !f.armsLost || !f.armsLost.has('R');
  }

  /**
   * The energy gate (2026-09-12). False means this fighter may not START a
   * punch or kick — not a weaker one, none at all — because they have gassed
   * themselves out. Blocking and movement are deliberately still allowed: the
   * guard is the way back up the bar, so the punishment is "you must defend
   * now", not "you are a statue".
   *
   * Checked on the three routes a fighter takes into a normal attack: the idle
   * branch and the two mid-swing cancel-into-punch/kick windows.
   *
   * Deliberately NOT checked in _enterAttack. Supers go straight there, and a
   * signature move is a rare earned payoff that should never be swallowed by
   * the stamina economy — Biden's "THE BIG GUY" in particular sets energy to
   * 1.0 and swings on the same frame, before the gassed flag has been
   * recomputed, so a flag check there would eat exactly the strike the super
   * exists to guarantee.
   */
  _canAttack(f) {
    return !f.gassed;
  }


  _updateEffects(dt) {
    this._updateParticles(dt);
    this._updateSeveredLimbs(dt);
    // The mesh-based list below carries post debris chunks + blood droplets.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      const mesh = e.mesh;
      // Blood splats on the canvas instead of fading mid-air.
      if (e.blood && mesh.position.y <= 0.07 && e.vel && e.vel.y < 0) {
        if (Math.abs(mesh.position.x) < 5.7 && Math.abs(mesh.position.z) < 5.7) {
          this._addBloodStain(mesh.position.x, mesh.position.z);
        }
        e.life = 0; // fall through to the removal branch below
      }
      if (e.vel) {
        mesh.position.x += e.vel.x * dt;
        mesh.position.y += e.vel.y * dt;
        mesh.position.z += e.vel.z * dt;
        e.vel.y += (e.gravity ?? 0) * dt;
      }
      if (e.angVel) {
        mesh.rotation.x += e.angVel.x * dt;
        mesh.rotation.y += e.angVel.y * dt;
        mesh.rotation.z += e.angVel.z * dt;
      }
      if (!e.vel) mesh.scale.multiplyScalar(1 + dt * 10);
      mesh.material.opacity = Math.max(0, e.life / 0.35);
      if (e.life <= 0) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  _updateCrowd(dt) {
    animateCrowd(this.arena.crowd, dt, this.clock, this.excited);
    this.excited = Math.max(0, this.excited - dt * 0.4);
    // #10 — the reactive hall shares the crowd's clock because it is driven by
    // the same two signals (excitement and the audio envelope).
    this._updateReactiveArena(dt);
    // #6 — the crowd you HEAR is fed the same excitement value as the crowd you
    // SEE, plus a floor that rises as the round wears on and a lift when either
    // fighter is nearly out. One signal, so the hall can never look tense and
    // sound bored.
    if (this.audio && this.fighters && this.combat) {
      const lowest = Math.min(this._hp(this.fighters[0]), this._hp(this.fighters[1])) / MAX_HP;
      const desperation = 1 - lowest;
      const late = Math.min(1, (this.clock || 0) / TIME_LIMIT);
      const want = Math.min(1, 0.18 + this.excited * 0.45 + desperation * 0.4 + late * 0.15);
      // Throttled: each call cancels and rewrites automation on three
      // AudioParams, and at 60 fps that is 180 scheduled ramps a second for a
      // value that moves slowly. Every ramp is 0.6 s long anyway, so pushing
      // more often than the change is audible only cancels the previous ramp
      // before it arrives — the level would crawl instead of gliding.
      if (Math.abs(want - (this._crowdPushed ?? -1)) > 0.03) {
        this._crowdPushed = want;
        this.audio.setCrowdIntensity(want);
      }
    }
  }

  _setBanner(text) {
    if (this.banner && this.banner.textContent !== text) this.banner.textContent = text;
  }

  // ── Hit feedback: damage numbers + combo readout ─────────────────────
  // One call per landed (unblocked) hit. Owns the three things that all key off
  // that single event: the per-round scorecard the end-of-fight recap reads, the
  // combo run length, and the floating number at the contact point. Blocked
  // hits deliberately don't come through here — they bump the DEFENDER's block
  // count at the call site instead, and a blocked blow neither extends a combo
  // nor deserves a damage number.
  _registerLandedHit(attacker, defender, dmg, point, region) {
    const s = attacker.stats;
    s.hits += 1;
    if (dmg > s.biggestHit) s.biggestHit = dmg;

    // The combo run continues while the gap since this attacker's last landed
    // hit is under COMBO_WINDOW. Measured on the sim clock (`this.t`), not
    // wall-clock, so hitstop pauses the window instead of eating into it.
    attacker.comboN = (this.t - attacker.comboT) <= COMBO_WINDOW ? attacker.comboN + 1 : 1;
    attacker.comboT = this.t;
    if (attacker.comboN > s.bestCombo) s.bestCombo = attacker.comboN;
    // Taking a hit ends YOUR run. Without this, two fighters trading blows both
    // show a climbing counter, which reads as a combo when it is the opposite.
    defender.comboN = 0;
    defender.comboT = -99;

    this._showCombo(attacker);
    this._showCombo(defender);
    this._spawnDamageNumber(point, dmg, region);
    // #3 — the run rings up the scale in the music's key.
    if (attacker.comboN >= 2) this.audio?.comboNote(attacker.comboN, point);
    this._commentOnHit(attacker, defender, dmg);

    // ── Reaction layer (GFX/SOUND #3, #5, #6) ─────────────────────────
    // Every landed hit already had a sound; what it did not have was a mix and
    // a room that reacted to it. All of it hangs off this one call site so the
    // visual stamp, the sidechain and the crowd can never disagree about what
    // counted as a hit — the bug that would follow from wiring each of them
    // into its own place in the damage path.
    //
    // `power` normalises damage against twice the heavy threshold, so a jab is
    // ~0.35 and a fully-charged head kick saturates at 1.
    const power = Math.min(1, dmg / (HEAVY_HIT_DMG * 2));
    if (this.audio) {
      this.audio.duckMusic(power);
      this.audio.crowdSwell(power);
      // The concussion is reserved for a heavy blow to the HEAD. On a torso hit
      // it makes no sense, and on every hit it would be a permanent lowpass.
      if (region === REGIONS.HEAD && dmg >= HEAVY_HIT_DMG) {
        this.audio.concussion(0.55 + 0.45 * power);
      }
    }
    // A near-KO makes the hall inhale.
    if (this.audio && this._hp(defender) <= 18 && this._hp(defender) > 0 && dmg >= HEAVY_HIT_DMG) {
      this.audio.crowdGasp();
    }
    if (dmg >= HEAVY_HIT_DMG) this._impactFrame(point, power);
    // #2 — rumble: the one hit carries the full motor, the one landing it a
    // light buzz in the hand.
    this._rumble(defender, 0.3 + 0.6 * power, 0.5, 80 + 140 * power);
    this._rumble(attacker, 0.08, 0.2 + 0.35 * power, 55);
  }

  /** #2 — dual-rumble on the pad driving `f`, if a person is driving it with one. */
  _rumble(f, strong, weak, ms) {
    if (!this.gamepads || !f || f.controller?.isHuman !== true) return;
    this.gamepads.rumble(this.fighters.indexOf(f) + 1, strong, weak, ms);
  }

  _showCombo(f) {
    const el = this._comboEls?.[this.fighters.indexOf(f)];
    if (!el) return;
    if (f.comboN < COMBO_MIN_SHOWN) { el.classList.remove('pb-combo--on'); return; }
    el.querySelector('.pb-combo__n').textContent = String(f.comboN);
    // Replay the pop on every increment. Dropping the class and reading
    // offsetWidth to force a synchronous reflow before re-adding it is the only
    // reliable way to restart a CSS animation — re-adding it in the same frame
    // without the reflow is coalesced into no change at all.
    el.classList.remove('pb-combo--on');
    void el.offsetWidth;
    el.classList.add('pb-combo--on');
  }

  // Expires stale combo runs so the badge disappears when the pressure stops,
  // rather than hanging until the next hit lands.
  _tickCombos() {
    for (const f of this.fighters) {
      if (f.comboN > 0 && (this.t - f.comboT) > COMBO_WINDOW) {
        // #3 — a run of 4+ that ends on its own terms gets its resolving chord.
        // (One broken by a counter-hit is zeroed in _registerLandedHit instead,
        // so it never gets here with a count — no reward for being interrupted.)
        if (f.comboN >= 4) this.audio?.comboFinisher(f.comboN);
        f.comboN = 0;
        this._showCombo(f);
      }
    }
  }

  // A short word at a contact point, on the same lifecycle as a damage number
  // (same layer, same rise animation, same eviction cap) — it is a damage
  // number whose text happens to be a word. Used by the perfect guard and the
  // counter it arms, which are the two events in the game that have to TEACH
  // something: a block that pays double is worthless as a lesson if nothing on
  // screen says it happened.
  _spawnCallout(point, text) {
    this._spawnFloater(point, text, 'pb-dmg--callout');
  }

  _spawnDamageNumber(point, dmg, region) {
    this._spawnFloater(point, String(Math.max(1, Math.round(dmg))),
      (region === REGIONS.HEAD ? ' pb-dmg--head' : '')
      + (dmg >= HEAVY_HIT_DMG ? ' pb-dmg--heavy' : ''));
  }

  // Project a world point to screen and float a DOM node up from it. Owns the
  // projection guard, the jitter, the node cap and the animationend cleanup —
  // all of which damage numbers and callouts have to get right identically, and
  // only one of which is obvious enough to be re-derived correctly by hand.
  _spawnFloater(point, text, extraClass) {
    if (!this.fx) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    _dmgProj.copy(point).project(this.camera);
    // A point behind the near plane projects to a mirrored on-screen position,
    // so it would draw a number somewhere the hit did not happen. Skip it.
    if (_dmgProj.z > 1) return;
    const el = document.createElement('span');
    el.className = 'pb-dmg' + (extraClass ? ' ' + extraClass.trim() : '');
    el.textContent = text;
    // Horizontal jitter so a flurry into one capsule doesn't overprint into an
    // unreadable smear. Seeded RNG, so a demo replay jitters identically.
    el.style.left = `${(_dmgProj.x * 0.5 + 0.5) * w + (this.rng.random() - 0.5) * 26}px`;
    el.style.top = `${(-_dmgProj.y * 0.5 + 0.5) * h}px`;
    this.fx.appendChild(el);
    this._dmgNodes.push(el);
    // Cap the live node count. This is also the safety net for the case where
    // `animationend` never fires (animations disabled at the OS/browser level):
    // eviction, not the listener, is what guarantees the list stays bounded.
    while (this._dmgNodes.length > MAX_DAMAGE_NUMBERS) this._dmgNodes.shift()?.remove();
    el.addEventListener('animationend', () => {
      const i = this._dmgNodes.indexOf(el);
      if (i >= 0) this._dmgNodes.splice(i, 1);
      el.remove();
    }, { once: true });
  }

  // Wipes floating feedback between rounds so a new round never opens with the
  // previous one's numbers still drifting up the screen.
  _clearFx() {
    for (const el of this._dmgNodes || []) el.remove();
    if (this._dmgNodes) this._dmgNodes.length = 0;
    for (const f of this.fighters || []) { f.comboN = 0; f.comboT = -99; }
    for (const el of this._comboEls || []) el?.classList.remove('pb-combo--on');
  }

  _pushHud(dt) {
    this.hudTimer += dt;
    if (!this.hudDirty && this.hudTimer < 0.25) return;
    this.hudTimer = 0;
    this.hudDirty = false;
    if (this.dotnet) {
      // Region damage rides along as [head, torso, arms, legs] per fighter so
      // the Blazor HUD can render the body-diagram damage readout.
      const regions = (f) => [
        Math.round(f.regionDmg.head), Math.round(f.regionDmg.torso),
        Math.round(f.regionDmg.arms), Math.round(f.regionDmg.legs),
      ];
      // ARITY CONTRACT with PoBrawlPage.OnHud — seven arguments, and both sides
      // move together or the HUD dies silently. invokeMethodAsync rejects on an
      // argument-count mismatch and this call swallows it in .catch(() => {}),
      // so a mismatch produces no console error and no exception: just a HUD
      // frozen at its C# field initializers. That has already happened once,
      // when the four super arguments below were ADDED here and not there.
      //
      // 2026-08-11: those same four (superPct/superReady per fighter) are now
      // REMOVED, in step with the C# signature, because the super bar they fed
      // is gone — the HUD is health and energy only. The meter still exists in
      // the engine and still gates the signature moves; it simply is no longer
      // a number the player is shown. Do not re-add an argument here without
      // widening OnHud in the same commit.
      // The training room has no clock; the page renders its own ∞ there, and a
      // pinned full value keeps the HUD from counting down to a limit that never fires.
      const timeLeft = this.training ? TIME_LIMIT : Math.max(0, TIME_LIMIT - (this.clock || 0));
      this.dotnet.invokeMethodAsync('OnHud',
        this._hp(this.fighters[0]), this._hp(this.fighters[1]), Math.round(timeLeft * 10) / 10,
        regions(this.fighters[0]), regions(this.fighters[1]),
        Math.round(this.fighters[0].energy * 100), Math.round(this.fighters[1].energy * 100))
        .catch(() => {});
    }
  }

  setMuted(m) {
    this.muted = !!m;
    this.audio.setMuted(this.muted);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this._splashTimer);
    clearTimeout(this._clipTimer);
    // GFX/SOUND top-10 modules. The pads first: releasing their held keys has to
    // reach the controllers before those are disposed below.
    if (this.gamepads) { this.gamepads.dispose(); this.gamepads = null; }
    if (this.clip) { this.clip.dispose(); this.clip = null; }
    if (this.news) { this.news.dispose(); this.news = null; }
    if (this.matWear) { this.matWear.dispose(); this.matWear = null; }
    if (this._pSprite) { this._pSprite.dispose(); this._pSprite = null; }
    // Drop the tier subscription before anything else is torn down — the handler
    // touches the renderer and the arena lights, and a `po-gfx-tier` firing during
    // teardown would reach both after they are gone.
    if (this._offTierChange) { this._offTierChange(); this._offTierChange = null; }
    // #8 — hand the analyser pump back. Leaving it on would keep a rAF loop
    // alive on every page the player visits afterwards, writing CSS variables
    // nothing reads.
    try { VisualRuntime.enableAudioReactive(false); } catch { /* */ }
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onMuteKey);
    this._disposeTraining();
    this._disposeNet();
    this._disposeCommentary();
    if (this.touchEl) this.touchEl.remove();
    if (this.fighters) for (const f of this.fighters) f.controller.dispose();
    if (this.audio) this.audio.close();
    // Drop any swing physics and per-fighter bodies, then dispose the world.
    if (this.props) { disposeProps(this.props); this.props = null; }
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
      }
    }
    this._physics = null;
    // Before the traverse: a Reflector's render target is invisible to a
    // geometry/material walk. See disposeArenaReflector.
    disposeArenaReflector();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) m.dispose();
        }
      });
    }
    if (this.composer) this.composer.dispose?.();
    // PMREM output target (#1) — a WebGLRenderTarget, invisible to the
    // geometry/material traverse above, exactly like the old reflector.
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this.scene) this.scene.environment = null;
    if (this._blobTex) this._blobTex.dispose();
    // #10 — the live jumbotron canvas texture. The traverse above disposes
    // materials but never their maps, and this one is ours (arena.js's cached
    // static texture, which we replaced, deliberately is not touched).
    if (this._jumboTex) { this._jumboTex.dispose(); this._jumboTex = null; }
    this._jumboCanvas = this._jumboCtx = null;
    this._rigLenses = null;
    if (this.renderer) {
      this.renderer.dispose();
      // dispose() frees the GPU objects three.js allocated; it does NOT release
      // the WebGL context itself, which stays live until the detached canvas is
      // garbage collected. This is an SPA — the player walks between the 3D
      // games without a page load — so those zombie contexts accumulate against
      // the browser's per-process ceiling (~16 in Chrome). Past it, the next
      // getContext() can come back null and GameShell's probe reports "This game
      // needs 3D graphics" on a machine that renders 3D fine.
      // forceContextLoss() is WebGL-only; the WebGPU renderer has no such method.
      try { this.renderer.forceContextLoss?.(); } catch { /* context already gone */ }
      this.renderer.domElement.remove();
    }
    if (this.banner) this.banner.remove();
    if (this.flash) this.flash.remove();
    // Removing the fx layer takes its damage numbers and combo badges with it;
    // dropping the node list too so a disposed game holds no detached elements.
    if (this.fx) this.fx.remove();
    if (this._dmgNodes) this._dmgNodes.length = 0;
    this.dotnet = null;
  }
}
// ── Subsystem composition ───────────────────────────────────────────────────
// Must run at module scope, after the class declaration and before any instance
// is constructed. index.js only ever imports BrawlGame from here, so by the time
// `new BrawlGame()` can be reached these methods are already on the prototype.
mixin(BrawlGame.prototype, SceneSetup, PersonalityEffects, Vfx, Cinematics, HitResolution, Training, Netplay, Commentary);
