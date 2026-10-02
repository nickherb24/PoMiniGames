// game.js — the PoSports meet orchestrator for the LOCAL modes (1p, 2p, demo).
// Owns the canvas, the fixed-step 60 Hz sim loop, lane state (via physics.js — the
// same stride model the server runs for online races), AI rivals, animation
// selection, and the Blazor interop callbacks. Online races replace this loop with
// server snapshots (remote mode, driven through applySnapshot).
import {
  CONSTANTS, HURDLE_POSITIONS, createLane, resetLane,
  applyImpulse, applyFalseStart, startJump, tickLane,
} from './physics.js';
import { SequenceTracker, attachKeyboard, LAYOUTS, setLayout, keyLabel, pollGamepads } from './input.js';
import { AiTypist, makeRng } from './ai.js';
import { TrackRenderer } from './track.js';
import * as sprites from './sprites.js';
import { TouchPad, isTouchDevice } from './touch.js';
import { RunLog, decode as decodeLog } from './runlog.js';
import * as records from './records.js';
import { Fx, CrowdBed, say, hush } from './fx.js';
import { createPostFx } from './postfx.js';
import '../weather.js';

// ── Audio (§GFX) ────────────────────────────────────────────────────────────
// PoSports shipped silent: there was no AudioContext anywhere under posports/,
// even though gameCues.js has carried a full 'posports' timbre table (rubber,
// air and stadium crowd) since it was written. These are the call sites that
// table was designed for. Going through PoCue rather than a local oscillator is
// what keeps the meet on the shared mix — master mute, ducking and the sfx bus
// all come for free, and a second AudioContext here would fight the first.
//
// Deliberately fire-and-forget and deliberately optional: PoCue is a module
// global that may not have evaluated yet, and fxBootstrap prunes the motion-heavy
// half of the stack entirely under reduced motion. A missing cue must cost the
// meet nothing.
function cue(name, opts) {
    try { window.PoCue?.fire('posports', name, opts); } catch { /* feedback is never fatal */ }
}

// Strides fire per impulse, which at full typing speed is several per second per
// lane. Two guards keep that from turning into a buzzsaw: only the nearest lanes
// are audible at all (see laneGain) and a per-lane cooldown thins the rest.
const STRIDE_COOLDOWN_MS = 110;

const COUNTDOWN_SECONDS = 3;
const PODIUM_SECONDS = 6;      // how long the podium holds before demo auto-restart
const HUD_THROTTLE_MS = 250;
const FIXED_DT = CONSTANTS.TICK;

/** The starter's calls, as seconds left on the pre-gun clock. */
const CALL_MARKS = 2.9;
const CALL_SET = 1.3;
/** Each sequence key is a note; a clean cadence climbs, a wrong key scuffs. */
const KEY_PITCH = [0.84, 0.94, 1.06, 1.26];

/** Anims every meet needs; punch/kick belong to the field events (events.js). */
const MEET_ANIMS = ['idle', 'walk', 'run', 'jump', 'hitreact', 'dance'];

export class SportsGame {
  /**
   * @param {HTMLElement} container
   * @param {any} dotnetRef Blazor object reference (OnHud/OnLegDone/OnMeetDone/OnPhase)
   * @param {{
   *   mode: '1p'|'2p'|'demo',
   *   players: Array<{character: string, name: string, human: boolean, layout?: 1|2}>,
   *   difficulty?: 'easy'|'medium'|'hard',
   *   seed?: number,
   *   daily?: boolean,            // the day's seeded meet: counts toward the streak
   *   ghost?: boolean,            // race your best meet's key log (1p; default on)
   *   keymaps?: Record<number, {sequence: string[], jump: string}>,
   *   night?: boolean,            // floodlit evening meet (default: by the local clock)
   *   lane?: number,              // online: the lane the server bound to this connection
   *   watch?: boolean,            // online spectator: no keys are forwarded
   * }} options
   */
  constructor(container, dotnetRef, options) {
    this.container = container;
    this.dotnet = dotnetRef;
    this.options = options;
    this.mode = options.mode ?? '1p';
    const seed = options.seed ?? ((Math.random() * 2 ** 31) | 0);
    this.rng = makeRng(seed);
    // Rebinds land before any tracker is built: a tracker captures its layout once.
    for (const n of [1, 2]) if (options.keymaps?.[n]) setLayout(n, options.keymaps[n]);

    // <html data-motion> is the OS preference OR the player's own switch in the settings sheet.
    this.reduced = document.documentElement.dataset.motion === 'reduce'
      || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    const hour = new Date().getHours();
    this.night = options.night ?? (hour >= 19 || hour < 6);
    this.touch = isTouchDevice();

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ps-canvas';
    container.appendChild(this.canvas);
    this.renderer = new TrackRenderer(this.canvas, { night: this.night });
    // The post pass draws into a second canvas ABOVE the 2D one; the 2D canvas stays
    // first in the DOM (it is the input, and what anything sampling the game finds).
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'ps-postfx';
    this.glCanvas.hidden = true;
    container.appendChild(this.glCanvas);
    this.post = null;
    // Weather from the meet's seed (weather.js), so a daily meet or an online heat is the same
    // sky for everyone. Rain and snow only: fog is a blur over the whole track, and this game
    // is read off its hurdles. Drawn over both canvases, never part of the sim.
    if (!this.reduced) {
      const sky = window.PoWeather?.weatherForSeed(seed);
      if (sky === 'rain' || sky === 'snow') window.PoWeather.apply({ type: sky, after: this.glCanvas });
    }

    this.fx = new Fx();
    this.crowd = new CrowdBed();

    this.remote = false;        // flips true when applySnapshot drives the meet
    this.myLane = options.lane ?? -1;
    this.phase = 'loading';
    this.phaseClock = 0;
    this.lastHudAt = 0;
    this.disposed = false;
    this._raf = 0;
    this._detachKeys = null;
    this._touchPads = [];

    this.lanes = (options.players ?? []).map((p, i) => this.buildLane(p, i));
    this.resetLegState();
    this.armGhost();
  }

  buildLane(p, index) {
    const lane = {
      index,
      name: p.name,
      character: p.character,
      human: !!p.human,
      layout: p.layout ?? 1,
      state: createLane(),
      animTime: 0,
      currentAnim: 'idle',
      sprintSeconds: -1,
      hurdlesSeconds: -1,
      placing: 0,
      tracker: null,
      ai: null,
      ticks: 0,                 // fixed steps run on the current leg (the run log's clock)
      knocked: new Map(),       // hurdle index → seconds since it was clipped
      log: p.human ? new RunLog() : null,
      stats: { reaction: -1, topSpeed: 0, clipped: 0, falseStarts: 0 },
    };
    // Every lane — human or AI — runs its sequence through one SequenceTracker, so the
    // rules live only in input.js. (The AI used to keep its own inline copy of them.)
    lane.tracker = new SequenceTracker(lane.layout, {
      onImpulse: () => this.onSequenceComplete(lane),
      onJump: lane.human ? () => this.onJump(lane) : undefined,
      isGated: () => !this.remote && (this.phase === 'countdown' || this.phase === 'interstitial'),
      onGatedKey: () => applyFalseStart(lane.state),
      onKey: lane.human ? (kind, step, result) => this.onHumanKey(lane, kind, step, result) : undefined,
    });
    if (!lane.human) {
      lane.ai = new AiTypist(this.options.difficulty ?? 'medium', (this.rng() * 2 ** 31) | 0);
    }
    return lane;
  }

  /** Everything that belongs to one leg's presentation rather than its physics. */
  resetLegState() {
    this.legTicks = 0;
    this.finishOrder = [];
    this.tape = { broken: false, age: 0 };
    this.freeze = 0;
    this.banner = null;
    this.startCall = '';
    for (const l of this.lanes) { l.ticks = 0; l.knocked.clear(); }
  }

  /**
   * The ghost: your best meet, replayed from its key log through the same tracker
   * and stride model. It is a lane state of its own, never one of `lanes`, so it
   * cannot place, block or be recorded.
   */
  armGhost() {
    this.ghost = null;
    if (this.mode !== '1p' || this.options.ghost === false) return;
    const log = decodeLog(records.ghost());
    const me = this.lanes.find((l) => l.human);
    if (!log || !me) return;
    const state = createLane();
    this.ghost = {
      log, state, lane: me, idx: 0, ticks: 0, animTime: 0, anim: 'idle',
      tracker: new SequenceTracker(1, { onImpulse: () => applyImpulse(state), onJump: () => startJump(state) }),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start() {
    const chars = [...new Set(this.lanes.map((l) => l.character))];
    this.setPhase('loading');
    await Promise.all(chars.map((c) => sprites.loadCharacter(c, MEET_ANIMS)));
    if (this.disposed) return;

    this.post = createPostFx(this.glCanvas, this.canvas, { reduced: this.reduced });

    // Only HUMAN lanes listen to the keyboard — AI lanes carry a tracker too now, and
    // attaching theirs would let a player's keys drive the CPU runners.
    const humans = this.lanes.filter((l) => l.human && l.tracker);
    if (humans.length) this._detachKeys = attachKeyboard(humans.map((l) => l.tracker));

    // Touch pads. One human (1P local, online): a single pad along the bottom. Two
    // humans on one tablet: a pad in each bottom corner. A spectator gets none.
    if (this.touch && !this.options.watch) {
      if (this.remote || humans.length === 1) {
        this._touchPads = [new TouchPad(this.container, this.remote ? 1 : humans[0].layout)];
      } else if (humans.length === 2) {
        this._touchPads = [new TouchPad(this.container, 1, 'left'), new TouchPad(this.container, 2, 'right')];
      }
    }

    this.leg = 'sprint';
    this.setPhase('countdown');
    this.phaseClock = COUNTDOWN_SECONDS;

    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      if (this.disposed) return;
      const real = Math.min((now - last) / 1000, 0.25); // clamp tab-switch spikes
      last = now;
      pollGamepads();
      // Hit-stop holds the simulation for a beat by withholding real time from the
      // fixed-step accumulator, so leg times stay on the sim clock. Nothing else may
      // scale what feeds it: the meet runs at one speed, finish included.
      if (this.freeze > 0) this.freeze -= real;
      else acc += real;
      while (acc >= FIXED_DT) {
        if (!this.remote) this.tick(FIXED_DT);
        else this.tickRemoteClock(FIXED_DT);
        acc -= FIXED_DT;
      }
      this.render(now, real);
      this.pushHud(now);
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    this._detachKeys?.();
    if (this._onRemoteKey) window.removeEventListener('keydown', this._onRemoteKey);
    for (const pad of this._touchPads) pad.dispose();
    this.renderer.dispose();
    this.post?.dispose();
    this.crowd.dispose();
    window.PoWeather?.stop();
    hush();
    try { window.PoMusicDirector?.tension(0); } catch { /* optional */ }
    // Release the context, not just the GPU objects — see the note in
    // pobrawl/game.js dispose(). Without this the context outlives the game and
    // eats a slot in the browser's small live-context pool for the rest of the
    // SPA session. Optional-call: WebGPURenderer has no forceContextLoss.
    try { this.renderer.forceContextLoss?.(); } catch { /* context already gone */ }
    this.canvas.remove();
    this.glCanvas.remove();
    sprites.unloadAll();
  }

  // ── Input events (human lanes) ────────────────────────────────────────

  /**
   * Cue options for a lane: panned to its position across the track and quieter
   * for the lanes the camera is not following. Without this every runner's stride
   * lands dead centre at full level and eight lanes read as one very loud runner.
   * @param {{index: number, human: boolean}} lane
   * @param {number} [gain=1] extra level multiplier for the specific cue
   */
  laneOpts(lane, gain = 1) {
    const n = Math.max(1, this.lanes.length - 1);
    // -0.8..0.8 rather than the full width: hard-panned mono cues vanish for
    // anyone listening on a single speaker.
    const pan = n === 0 ? 0 : ((lane.index / n) * 1.6) - 0.8;
    // A human's own runner is the one they are listening for; rivals sit back.
    const mine = this.remote ? lane.index === this.myLane : lane.human;
    return { pan, gain: gain * (mine ? 1 : 0.45) };
  }

  /**
   * Every press on a human's layout, with what it did. Three jobs: the run log (the
   * ghost and the server both replay it), the per-key note, and the stats the
   * results card shows.
   */
  onHumanKey(lane, kind, step, result) {
    if (this.remote) return;
    if (this.phase === 'racing') {
      lane.log.key(this.leg, lane.ticks, kind === 'jump' ? 4 : step);
      if (lane.stats.reaction < 0 && this.leg === 'sprint') lane.stats.reaction = lane.ticks * FIXED_DT * 1000;
    } else if (kind === 'seq' && this.phase === 'countdown') {
      // The interstitial's false starts are cleared when the hurdles lane resets, here
      // and on the server alike, so only the sprint countdown is worth recording.
      lane.log.falseStart('sprint');
    }
    if (kind !== 'seq') return;
    if (result === 'gated') {
      lane.stats.falseStarts++;
      this.red = 1;
      this.startCall = 'FALSE START';
      cue('whistle', { ...this.laneOpts(lane), pitch: 0.5 });
      say('False start', { minGapMs: 1500 });
    } else if (result === 'reset') {
      cue('kick', { ...this.laneOpts(lane, 0.5), pitch: 0.55 });
    } else {
      cue('bounce', { ...this.laneOpts(lane, 0.45), pitch: KEY_PITCH[step] });
    }
  }

  onSequenceComplete(lane) {
    // Pre-gun presses never reach here — the tracker's gate turns each one into a false
    // start (see buildLane / SequenceTracker.injectKey).
    if (this.remote || this.phase !== 'racing') return;
    applyImpulse(lane.state);
    this.strideCue(lane, lane.state.speed, lane.state.position);
  }

  /**
   * A footfall for one impulse, thinned by STRIDE_COOLDOWN_MS. The cooldown is
   * per lane rather than global so a close race still sounds like several runners
   * instead of one stuttering one.
   */
  strideCue(lane, speed, position) {
    const now = performance.now();
    if (now < (lane.nextStrideAt || 0)) return;
    lane.nextStrideAt = now + STRIDE_COOLDOWN_MS;
    // Pitch rises with speed: the same footfall sample at 0 m/s and at top speed
    // is the single biggest tell that a sound is canned.
    const k = speed / Math.max(1, CONSTANTS.MAX_SPEED);
    cue('stride', { ...this.laneOpts(lane, 0.9), pitch: 0.9 + (k * 0.35) });
    this.fx.dust(position, this.renderer.laneY(lane.index, this.lanes.length), 2 + Math.round(k * 2));
  }

  onJump(lane) {
    if (this.remote || this.phase !== 'racing') return;
    // Only voice a jump that actually started — startJump refuses mid-air and in
    // the air is exactly where a player mashes the key.
    if (startJump(lane.state)) {
      cue('bounce', this.laneOpts(lane));
    }
  }

  // ── Local simulation ──────────────────────────────────────────────────

  setPhase(phase) {
    this.phase = phase;
    try { this.dotnet?.invokeMethodAsync('OnPhase', phase, this.leg ?? 'sprint'); } catch { /* page gone */ }
  }

  /** The starter: "On your marks", "Set" — spoken once each as the pre-gun clock passes them. */
  callStart(before, after) {
    const crossed = (t) => before > t && after <= t;
    if (crossed(CALL_MARKS)) { this.startCall = 'On your marks'; this.announce('On your marks'); }
    if (crossed(CALL_SET)) {
      this.startCall = 'Set';
      this.announce('Set', { pitch: 1.1 });
      // The hush: music and crowd drop away under the last second before the gun.
      this.crowd.set(0);
      try { window.PoAudioBus?.duck?.(0.3, 1400); } catch { /* optional */ }
    }
  }

  /** The announcer stays out of the attract loop: nobody asked a kiosk to talk. */
  announce(text, opts) {
    if (this.mode !== 'demo') say(text, opts);
  }

  /** The gun. Shared by both legs' starts and by the online phase change. */
  fireGun() {
    cue('whistle');
    cue('kick', { gain: 1.3, pitch: 0.45 }); // the report under the whistle
    this.flash = 1;
    this.startCall = '';
    this.resetLegState();
    const g = this.ghost;
    if (g) {
      resetLane(g.state);
      g.tracker.reset();
      g.idx = 0;
      g.ticks = 0;
      if (this.leg === 'sprint' && g.log.sprint.falseStart) applyFalseStart(g.state);
    }
  }

  tick(dt) {
    switch (this.phase) {
      case 'countdown':
      case 'interstitial': {
        const before = this.phaseClock;
        this.phaseClock -= dt;
        this.callStart(before, this.phaseClock);
        if (this.phaseClock <= 0) {
          if (this.phase === 'interstitial') {
            this.leg = 'hurdles';
            for (const l of this.lanes) { resetLane(l.state); l.tracker?.reset(); l.animTime = 0; }
          }
          // Fired on the transition rather than in setPhase, which is also reached
          // from the remote snapshot path — a gun on every phase write would sound twice.
          this.fireGun();
          this.setPhase('racing');
        }
        return;
      }
      case 'podium': {
        this.phaseClock -= dt;
        this.podiumClock += dt;
        for (const l of this.lanes) l.animTime += dt;
        if (this.phaseClock <= 0 && this.mode === 'demo') this.restartMeet();
        return;
      }
      case 'racing': break;
      default: return;
    }

    const hurdles = this.leg === 'hurdles' ? HURDLE_POSITIONS : [];
    const legLength = this.leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH;

    for (const l of this.lanes) {
      if (l.ai && !l.state.finished) {
        l.ai.update(dt, {
          position: l.state.position,
          airborne: l.state.airborne,
          seqProgress: l.tracker.progress,
          onHurdlesLeg: this.leg === 'hurdles',
        }, {
          // Straight into the shared state machine: the AI faces exactly the rules a
          // human does, with no second implementation to drift.
          seqStep: (step) => l.tracker.injectKey(l.tracker.map.sequence[step]),
          jump: () => startJump(l.state),
        });
      }
      const events = tickLane(l.state, dt, hurdles, legLength);
      l.ticks++;
      if (l.state.speed > l.stats.topSpeed) l.stats.topSpeed = l.state.speed;
      if (events.stumbled) this.onStumble(l, l.state.nextHurdle - 1);
      if (events.finished) {
        if (this.leg === 'sprint') l.sprintSeconds = l.state.legTime;
        else l.hurdlesSeconds = l.state.legTime;
        this.onCrossedLine(l, l.state.legTime);
      }
    }
    this.legTicks++;
    this.tickGhost(dt, hurdles, legLength);

    this.renderer.updateCamera(dt, this.lanes.map((l) => l.state), legLength);
    this.driveTension(this.lanes.map((l) => l.state), legLength);

    if (this.lanes.every((l) => l.state.finished)) {
      if (this.leg === 'sprint') {
        this.setPhase('interstitial');
        this.phaseClock = CONSTANTS.INTERSTITIAL_SECONDS;
        const winner = [...this.lanes].sort((a, b) => a.sprintSeconds - b.sprintSeconds)[0];
        this.announce(`${winner.name} takes the sprint in ${winner.sprintSeconds.toFixed(1)} seconds`);
        try { this.dotnet?.invokeMethodAsync('OnLegDone', 'sprint', this.lanes.map((l) => l.sprintSeconds)); } catch { }
      } else {
        this.finishMeet();
      }
    }
  }

  tickGhost(dt, hurdles, legLength) {
    const g = this.ghost;
    if (!g || g.state.finished) return;
    const events = g.log[this.leg].events;
    while (g.idx < events.length && events[g.idx].tick <= g.ticks) {
      const code = events[g.idx++].code;
      g.tracker.injectKey(code === 4 ? g.tracker.map.jump : g.tracker.map.sequence[code]);
    }
    tickLane(g.state, dt, hurdles, legLength);
    g.ticks++;
  }

  /** A clipped hurdle: it goes over, the frame holds for a beat, the camera kicks. */
  onStumble(lane, hurdleIndex) {
    lane.animTime = 0;
    lane.stats.clipped++;
    lane.knocked.set(hurdleIndex, 0);
    // Clipping a hurdle is the meet's only real collision — 'kick' is the
    // table's rubber-on-air thud and reads as a shin hitting the bar.
    cue('kick', this.laneOpts(lane, 1.15));
    const y = this.renderer.laneY(lane.index, this.lanes.length);
    this.fx.burst(HURDLE_POSITIONS[hurdleIndex] ?? 0, y - 20, 8, '245,245,245', 70);
    const mine = this.remote ? lane.index === this.myLane : lane.human;
    if (mine && !this.reduced) {
      this.freeze = Math.max(this.freeze, 0.06);
      this.renderer.shake = 9;
      this.punch = 1;
    }
  }

  /** Crossing the line, per lane, so a photo finish sounds like one. */
  onCrossedLine(lane, legTime) {
    cue('bounce', { ...this.laneOpts(lane, 0.8), pitch: 1.35 });
    const at = this.legTicks * FIXED_DT;
    this.finishOrder.push({ lane, at, time: legTime });
    if (this.finishOrder.length === 1) {
      this.tape.broken = true;
      this.crowd.swell();
    } else if (this.finishOrder.length === 2 && at - this.finishOrder[0].at < 0.3) {
      const [a, b] = this.finishOrder;
      this.banner = {
        title: 'PHOTO FINISH',
        lines: [`${a.lane.name}  ${a.time.toFixed(2)}`, `${b.lane.name}  +${(b.at - a.at).toFixed(2)}`],
        until: performance.now() + 2600,
      };
    }
  }

  /**
   * Push the meet's tension into the soundtrack and the crowd (§GFX).
   *
   * The music director only knew 'menu' / 'lobby' / 'match', so a meet sounded the
   * same on the blocks as on the line. Two signals combine here: how far the
   * leader has run, and how tight the race is behind them — a runaway win should
   * relax as it resolves, a photo finish should not.
   *
   * The director deadbands small changes internally, so calling this every tick is
   * cheap and deliberately unthrottled.
   */
  driveTension(states, legLength) {
    let lead = 0;
    let second = 0;
    for (const s of states) {
      const p = s.position;
      if (p > lead) { second = lead; lead = p; }
      else if (p > second) { second = p; }
    }

    const progress = Math.max(0, Math.min(1, lead / Math.max(1, legLength)));
    // Gap as a fraction of the track, inverted: shoulder-to-shoulder = 1.
    const closeness = 1 - Math.max(0, Math.min(1, (lead - second) / (legLength * 0.12)));

    // Progress dominates; closeness sharpens the end of a tight race. The hurdles
    // leg carries a floor because it is the second half of the meet — the standings
    // matter more there even early on.
    const floor = this.leg === 'hurdles' ? 0.25 : 0;
    const tension = Math.max(floor, (progress * 0.65) + (closeness * progress * 0.35));
    try { window.PoMusicDirector?.tension?.(tension); } catch { /* optional */ }
    this.crowd.set(tension);
  }

  finishMeet() {
    const ranked = [...this.lanes].sort((a, b) =>
      (a.sprintSeconds + a.hurdlesSeconds) - (b.sprintSeconds + b.hurdlesSeconds) || a.index - b.index);
    ranked.forEach((l, i) => { l.placing = i + 1; });
    for (const l of this.lanes) l.animTime = 0;

    // The crowd always reacts; the victory cue is reserved for a human winning,
    // because 'goal' carries confetti and a demo-mode AI win throwing confetti
    // on the attract loop would celebrate nothing.
    cue('crowdCheer');
    if (ranked[0]?.human) {
        cue('goal');
    }
    this.announce(`${ranked[0].name} wins the meet`);

    // Personal bests live with the engine (records.js): the page used to start its
    // "best" at zero on every visit, so the first meet of each one was a record.
    const me = this.mode === '1p' ? this.lanes.find((l) => l.human) : null;
    let pb = null;
    let daily = null;
    if (me) {
      const total = me.sprintSeconds + me.hurdlesSeconds;
      pb = records.recordMeet({ sprint: me.sprintSeconds, hurdles: me.hurdlesSeconds, total, inputs: me.log.encode() });
      if (this.options.daily) daily = records.recordDaily(total);
    }
    this.newRecord = !!pb?.newTotal;
    this.humanWon = !!ranked[0]?.human && this.mode !== 'demo';

    this.setPhase('podium');
    this.phaseClock = PODIUM_SECONDS;
    this.podiumClock = 0;
    const results = {
      lanes: this.lanes.map((l) => ({
        lane: l.index, name: l.name, character: l.character, human: l.human,
        sprintSeconds: l.sprintSeconds, hurdlesSeconds: l.hurdlesSeconds,
        totalSeconds: l.sprintSeconds + l.hurdlesSeconds, placing: l.placing,
        reactionMs: l.stats.reaction, topSpeed: l.stats.topSpeed, clipped: l.stats.clipped,
        falseStarts: l.stats.falseStarts,
        inputs: l.log ? l.log.encode() : null,
      })),
      pb,
      daily,
    };
    try { this.dotnet?.invokeMethodAsync('OnMeetDone', results); } catch { }
  }

  restartMeet() {
    if (this.remote) return;
    this.leg = 'sprint';
    for (const l of this.lanes) {
      resetLane(l.state);
      l.tracker?.reset();
      l.log?.reset();
      l.stats = { reaction: -1, topSpeed: 0, clipped: 0, falseStarts: 0 };
      l.sprintSeconds = -1; l.hurdlesSeconds = -1; l.placing = 0; l.animTime = 0;
    }
    this.resetLegState();
    this.armGhost(); // the run just finished may be the new ghost
    this.fx.clear();
    this.renderer.cameraX = -6;
    this.setPhase('countdown');
    this.phaseClock = COUNTDOWN_SECONDS;
  }

  // ── Remote (online) mode — completed by the race-mode slice ──────────

  /**
   * Switch to server-driven rendering: local physics stops, snapshots rule.
   * Key presses are forwarded RAW to Blazor (OnRemoteKey) as layout ordinals —
   * the server sim owns the sequence rules, so the client must not interpret them.
   */
  enterRemoteMode(layout = 1) {
    this.remote = true;
    this.snapPrev = null;
    this.snapNext = null;
    this.snapClock = 0;
    if (this.options.watch) return; // a spectator sends nothing
    const map = LAYOUTS[layout] ?? LAYOUTS[1];
    this._onRemoteKey = (e) => {
      if (e.repeat) return;
      if (e.code === map.jump) {
        e.preventDefault();
        try { this.dotnet?.invokeMethodAsync('OnRemoteKey', 'jump', 0); } catch { }
        return;
      }
      const step = map.sequence.indexOf(e.code);
      if (step < 0) return;
      e.preventDefault();
      // The note for the key you pressed is immediate; whether it counted is the server's call.
      cue('bounce', { gain: 0.45, pitch: KEY_PITCH[step] });
      try { this.dotnet?.invokeMethodAsync('OnRemoteKey', 'seq', step); } catch { }
    };
    window.addEventListener('keydown', this._onRemoteKey);
  }

  tickRemoteClock(dt) {
    this.snapClock += dt;
    this.legTicks++;
    if (this.phase === 'podium') this.podiumClock += dt;
    for (const l of this.lanes) l.animTime += dt;
  }

  /** Feed a server snapshot (~15 Hz). Rendering interpolates between the last two. */
  applySnapshot(snapshot) {
    if (!this.remote) return;
    const prev = this.snapNext;
    this.snapPrev = prev;
    this.snapNext = snapshot;
    this.snapClock = 0;
    const phase = snapshot.phase;
    const wasLeg = this.leg;
    this.leg = phase === 'hurdles' ? 'hurdles' : phase === 'sprint' ? 'sprint' : (this.leg ?? 'sprint');
    const mapped = phase === 'sprint' || phase === 'hurdles' ? 'racing' : phase;
    this.phaseClock = snapshot.clock;
    if (mapped !== this.phase) {
      // The same moments the local loop voices, driven here by the phase the server reports.
      if (mapped === 'racing') this.fireGun();
      else if (mapped === 'podium') {
        cue('crowdCheer');
        this.podiumClock = 0;
        const mine = snapshot.lanes.find((l) => l.lane === this.myLane);
        this.humanWon = mine?.placing === 1;
        if (this.humanWon) cue('goal');
      }
      this.setPhase(mapped);
    } else if (mapped === 'countdown' || mapped === 'interstitial') {
      this.callStart(prev?.clock ?? 99, snapshot.clock);
    }
    const legLength = this.leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH;
    for (const n of snapshot.lanes) {
      const l = this.lanes[n.lane];
      if (!l) continue;
      l.placing = n.placing;
      l.sprintSeconds = n.sprintSeconds;
      l.hurdlesSeconds = n.hurdlesSeconds;
      // Sound and dressing from what changed between two snapshots. The server sends
      // state, not events, so each cue is an edge: a jump in speed is a stride, a
      // lane that was grounded and is now airborne jumped, and so on.
      const p = prev?.lanes[n.lane];
      if (!p || wasLeg !== this.leg || mapped !== 'racing') continue;
      if (n.speed > p.speed + 1) this.strideCue(l, n.speed, n.position);
      if (n.airborne && !p.airborne) cue('bounce', this.laneOpts(l));
      if (n.stumbling && !p.stumbling) {
        // The hurdle just behind the runner is the one they clipped.
        let hit = -1;
        HURDLE_POSITIONS.forEach((h, i) => { if (h <= n.position + 0.5) hit = i; });
        if (hit >= 0) this.onStumble(l, hit);
      }
      if (n.finished && !p.finished) this.onCrossedLine(l, n.legTime);
    }
    if (mapped === 'racing') this.driveTension(snapshot.lanes, legLength);
  }

  /** Interpolated lane states for rendering in remote mode. */
  remoteLaneStates() {
    const next = this.snapNext;
    if (!next) return this.lanes.map(() => ({ position: 0, speed: 0, airborne: 0, stumbling: 0, finished: false }));
    const prev = this.snapPrev ?? next;
    // 15 Hz broadcast → interpolate across ~66 ms.
    const t = Math.min(this.snapClock / (1 / 15), 1);
    return next.lanes.map((n) => {
      const p = prev.lanes[n.lane] ?? n;
      return {
        position: p.position + (n.position - p.position) * t,
        speed: n.speed,
        airborne: n.airborne ? 1 : 0,
        stumbling: n.stumbling ? 1 : 0,
        finished: n.finished,
      };
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  pickAnim(l, s) {
    if (this.phase === 'podium') return l.placing === this.lanes.length && this.lanes.length > 1 ? 'idle' : 'dance';
    // Waiting to race — between legs, in the countdown, or already across the line while
    // the rest of the field comes in. tickLane freezes a finished lane's speed at its
    // crossing value and resetLane only runs when the next leg starts, so without this
    // the speed-based picks below would keep the run cycle going on a standing runner.
    if (this.phase !== 'racing' || s.finished) return 'idle';
    if (s.stumbling > 0) return 'hitreact';
    if (s.airborne > 0) return 'jump';
    if (s.speed > 3) return 'run';
    if (s.speed > 0.3) return 'walk';
    return 'idle';
  }

  /** The lanes whose keys this screen shows: local humans, or your own lane online. */
  keyLanes() {
    if (this.options.watch) return [];
    if (!this.remote) return this.lanes.filter((l) => l.human);
    const mine = this.lanes[this.myLane];
    return mine ? [mine] : [];
  }

  render(now, real) {
    const r = this.renderer;
    const { ctx } = r;
    const laneCount = this.lanes.length || 4;
    const states = this.remote
      ? this.remoteLaneStates()
      : this.lanes.map((l) => l.state);
    const legLength = this.leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH;

    if (this.remote) r.updateCamera(FIXED_DT, states, legLength);

    // Presentation clocks run on real time: a toppling hurdle or a fading flash
    // should not stall with the hit-stop.
    this.fx.update(real);
    this.flash = Math.max(0, (this.flash || 0) - real * 3.2);
    this.red = Math.max(0, (this.red || 0) - real * 1.6);
    this.punch = Math.max(0, (this.punch || 0) - real * 3.5);
    if (this.tape.broken) this.tape.age += real;
    for (const l of this.lanes) for (const [k, v] of l.knocked) l.knocked.set(k, v + real);

    const leader = Math.max(0, ...states.map((s) => s.position));
    r.drawScene(this.leg === 'hurdles' ? 'hurdles' : 'sprint', laneCount, {
      knocked: this.lanes.map((l) => l.knocked),
      tape: this.tape,
      waveX: this.phase === 'racing' ? r.toX(leader) : undefined,
    });
    this.fx.draw(ctx, (m) => r.toX(m), true);

    // On the podium the runners leave their lanes for the blocks (drawn below).
    const onPodium = this.phase === 'podium';
    const dt = 1 / 60;
    if (!onPodium) {
      this.drawGhost(laneCount, real);
      this.lanes.forEach((l, i) => {
        const s = states[i];
        const anim = this.pickAnim(l, s);
        if (anim !== l.currentAnim) { l.currentAnim = anim; l.animTime = 0; }
        else if (!this.remote) l.animTime += dt;

        const x = r.toX(s.position);
        const y = r.laneY(i, laneCount);
        const h = r.spriteHeight(i, laneCount);
        // Airborne lift: a simple arc peaking mid-jump.
        const jumpT = s.airborne > 0 ? 1 - s.airborne / CONSTANTS.JUMP_DURATION : 0;
        const lift = jumpT > 0 ? Math.sin(jumpT * Math.PI) * h * 0.45 : 0;
        r.drawShadow(x, y, h, lift);
        const fast = (s.speed - 13) / 6;
        if (fast > 0 && this.phase === 'racing' && !s.finished) r.drawSpeedLines(x, y - lift, h, Math.min(1, fast), now / 1000);
        sprites.draw(ctx, l.character, anim, l.animTime, x, y - lift, h,
          { loop: anim !== 'jump' && anim !== 'hitreact' });
      });
      this.drawKeys(states, laneCount);
    }

    r.drawLighting();
    r.screenSpace();
    if (onPodium) this.drawPodium(laneCount, real);
    this.fx.draw(ctx, null, false);
    this.drawOverlay(now);

    if (this.post && !this.post.render({ punch: this.punch, night: this.night ? 1 : 0 })) {
      this.post.dispose();
      this.post = null;
    }
  }

  /** The ghost runs in your lane, drawn first and faint so your own runner reads on top. */
  drawGhost(laneCount, real) {
    const g = this.ghost;
    if (!g || this.phase !== 'racing') return;
    const r = this.renderer;
    const s = g.state;
    const anim = s.finished ? 'idle' : s.stumbling > 0 ? 'hitreact' : s.airborne > 0 ? 'jump' : s.speed > 3 ? 'run' : s.speed > 0.3 ? 'walk' : 'idle';
    if (anim !== g.anim) { g.anim = anim; g.animTime = 0; } else g.animTime += real;
    const i = g.lane.index;
    const h = r.spriteHeight(i, laneCount);
    const jumpT = s.airborne > 0 ? 1 - s.airborne / CONSTANTS.JUMP_DURATION : 0;
    const lift = jumpT > 0 ? Math.sin(jumpT * Math.PI) * h * 0.45 : 0;
    r.ctx.save();
    r.ctx.globalAlpha = 0.33;
    sprites.draw(r.ctx, g.lane.character, anim, g.animTime, r.toX(s.position), r.laneY(i, laneCount) - lift, h,
      { loop: anim !== 'jump' && anim !== 'hitreact' });
    r.ctx.restore();
  }

  /**
   * Your keys ride above your own runner. On a touch screen the pad already shows
   * them, so the canvas draws none and the pad's next button is ringed instead.
   */
  drawKeys(states, laneCount) {
    const live = this.phase === 'racing' || this.phase === 'countdown' || this.phase === 'interstitial';
    const lanes = this.keyLanes();
    lanes.forEach((l, n) => {
      const progress = this.remote
        ? (this.snapNext?.lanes[l.index]?.seqProgress ?? 0)
        : l.tracker.progress;
      if (this.touch) { this._touchPads[n]?.setNext(live ? progress : -1); return; }
      if (!live || states[l.index]?.finished) return;
      const map = this.remote ? LAYOUTS[1] : l.tracker.map;
      const r = this.renderer;
      const h = r.spriteHeight(l.index, laneCount);
      // Clamp to the view: at the gun the runner stands near the left edge.
      const x = Math.max(r.viewW * 0.12, Math.min(r.viewW * 0.88, r.toX(states[l.index].position)));
      r.drawKeycaps(x, r.laneY(l.index, laneCount) - h * 0.93, map.sequence.map(keyLabel), progress, keyLabel(map.jump));
    });
  }

  drawPodium(laneCount, real) {
    const r = this.renderer;
    const { ctx } = r;
    const t = this.podiumClock || 0;
    const rise = Math.min(1, t / 0.6);
    const spots = r.drawPodium(rise);
    const ranked = [...this.lanes].sort((a, b) => (a.placing || 9) - (b.placing || 9));
    const h = r.viewH * 0.3;
    ranked.forEach((l, i) => {
      const spot = spots[Math.min(i, 3)];
      const anim = i === 3 ? 'idle' : 'dance';
      if (anim !== l.currentAnim) { l.currentAnim = anim; l.animTime = 0; }
      // The sheets leave ~11% of the frame empty under the feet; drop the sprite by that
      // much so the runner stands ON the block rather than hovering over it.
      sprites.draw(ctx, l.character, anim, l.animTime, spot.x, spot.y + h * 0.11, h, { loop: true });
      if (i < 3 && rise >= 1) {
        // The medal, on its ribbon.
        ctx.strokeStyle = '#d7263d';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(spot.x - 7, spot.y - h * 0.6);
        ctx.lineTo(spot.x, spot.y - h * 0.4);
        ctx.lineTo(spot.x + 7, spot.y - h * 0.6);
        ctx.stroke();
        ctx.fillStyle = ['#ffd166', '#dfe7ef', '#d99a6c'][i];
        ctx.beginPath();
        ctx.arc(spot.x, spot.y - h * 0.38, Math.max(6, h * 0.045), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `700 ${Math.max(11, r.viewH * 0.026)}px system-ui, sans-serif`;
      // Two short lines per block: a long display name must not run into its neighbour's.
      const total = l.sprintSeconds + l.hurdlesSeconds;
      const name = l.name.length > 12 ? l.name.slice(0, 11) + '…' : l.name;
      ctx.fillText(name, spot.x, r.viewH * 0.94);
      ctx.fillStyle = '#ffd166';
      if (total > 0) ctx.fillText(total.toFixed(2), spot.x, r.viewH * 0.975);
    });
    // Confetti for a human on the top step; fireworks when it is also a record.
    if (this.humanWon && t < 3.5 && !this.reduced) this.fx.confetti(r.viewW, 3);
    if (this.newRecord && !this.reduced && t < 4 && Math.floor(t / 0.55) !== Math.floor((t - real) / 0.55)) {
      this.fx.firework(r.viewW * (0.2 + Math.random() * 0.6), r.viewH * (0.12 + Math.random() * 0.25));
    }
  }

  drawOverlay(now) {
    const { ctx } = this.renderer;
    const w = this.renderer.viewW; const h = this.renderer.viewH;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (this.phase === 'countdown' || this.phase === 'interstitial') {
      const n = Math.ceil(this.phaseClock);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      if (this.phase === 'interstitial' && this.phaseClock > CALL_MARKS) {
        // The break between legs is where the sprint result is read out.
        const ranked = [...this.lanes].filter((l) => l.sprintSeconds > 0).sort((a, b) => a.sprintSeconds - b.sprintSeconds);
        ctx.font = `800 ${h * 0.06}px system-ui, sans-serif`;
        ctx.fillText('100m Sprint', w / 2, h * 0.3);
        ctx.font = `600 ${h * 0.045}px system-ui, sans-serif`;
        ranked.forEach((l, i) => {
          const mine = this.remote ? l.index === this.myLane : l.human;
          ctx.fillStyle = mine ? '#ffd166' : '#fff';
          ctx.fillText(`${i + 1}.  ${l.name}   ${l.sprintSeconds.toFixed(2)}s`, w / 2, h * (0.4 + i * 0.065));
        });
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = `600 ${h * 0.04}px system-ui, sans-serif`;
        ctx.fillText(`110m Hurdles in ${n}`, w / 2, h * 0.74);
      } else {
        ctx.font = `800 ${h * 0.18}px system-ui, sans-serif`;
        ctx.fillText(`${n}`, w / 2, h / 2);
        if (this.startCall) {
          ctx.fillStyle = this.startCall === 'FALSE START' ? '#ff6b6b' : '#fff';
          ctx.font = `700 ${h * 0.055}px system-ui, sans-serif`;
          ctx.fillText(this.startCall, w / 2, h * 0.63);
        }
      }
    }
    if (this.banner) {
      if (now > this.banner.until) this.banner = null;
      else {
        ctx.fillStyle = 'rgba(10,14,24,0.78)';
        ctx.fillRect(0, h * 0.36, w, h * 0.26);
        ctx.fillStyle = '#ffd166';
        ctx.font = `800 ${h * 0.075}px system-ui, sans-serif`;
        ctx.fillText(this.banner.title, w / 2, h * 0.455);
        ctx.fillStyle = '#fff';
        ctx.font = `600 ${h * 0.04}px system-ui, sans-serif`;
        this.banner.lines.forEach((ln, i) => ctx.fillText(ln, w / 2, h * (0.52 + i * 0.05)));
      }
    }
    // The gun's muzzle flash, and red for a false start.
    if (this.flash > 0.01 && !this.reduced) { ctx.fillStyle = `rgba(255,252,235,${this.flash * 0.6})`; ctx.fillRect(0, 0, w, h); }
    if (this.red > 0.01) { ctx.fillStyle = `rgba(220,40,40,${this.red * (this.reduced ? 0.15 : 0.35)})`; ctx.fillRect(0, 0, w, h); }
  }

  // ── HUD ───────────────────────────────────────────────────────────────

  pushHud(now) {
    // Local modes only. Online, the page drives its HUD straight from the server snapshot
    // (which knows WHICH lane is yours); pushing lanes in snapshot order made a second
    // writer that mapped lane 0 onto the local player's HUD row and fought the first one.
    if (this.remote) return;
    if (now - this.lastHudAt < HUD_THROTTLE_MS) return;
    this.lastHudAt = now;
    const g = this.ghost;
    const hud = {
      phase: this.phase,
      leg: this.leg ?? 'sprint',
      clock: this.phase === 'racing'
        ? Math.max(0, ...this.lanes.map((l) => l.state.legTime))
        : this.phaseClock,
      // Meters ahead of (+) or behind (-) your ghost; null when there is none to race.
      ghostGap: g && this.phase === 'racing' ? g.lane.state.position - g.state.position : null,
    };
    try { this.dotnet?.invokeMethodAsync('OnHud', hud); } catch { /* page gone */ }
  }
}
