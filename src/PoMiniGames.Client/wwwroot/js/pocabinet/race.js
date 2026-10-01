// pocabinet/race.js
//
// The per-frame race driver. Runs on the scene's frame loop for every mode:
//
//   solo      — the whole race simulates here (physics.js, the same model the
//               server runs), fixed 30 Hz ticks, rendered interpolated at the
//               display rate. A HUD snapshot goes to Blazor every tick. The field
//               is 100 cars (2026-09-30): the player in grid slot 50 and the 99
//               rivals of physics.soloField(). Everything per-car below is sized
//               for that: only the nearest cars are drawn in full (the rest are one
//               instanced mesh, cars.js CarCrowd) or heard, and the HUD snapshot
//               carries the whole field only when it has to.
//   demo      — as solo, with the local car on autopilot and the camera
//               cycling chase → far chase → TV.
//
// The camera is third person at all times (2026-09-23): 'chase', 'far' (the
// camera button toggles them) and, in the demo and replays, 'tv'.
//   net       — the server is authoritative. The local car is PREDICTED here:
//               each tick samples input, steps the car, sends the numbered
//               input (via Blazor → SignalR) and remembers it. Each server
//               snapshot resets the car to the server's state and replays the
//               inputs the server has not acknowledged yet; the visible
//               difference is folded into a render offset that decays over
//               ~100 ms instead of snapping. Remote cars are drawn 100 ms in
//               the past, interpolated between snapshots.
//
// Every mode records the race (all car poses + the local car's pedals) for the
// post-race telemetry chart (telemetry.js) and the replay / clip export below.
//
// Input comes from input.js (keyboard ramp, gamepad, touch, tilt); driver aids
// (physics.assistControls) are applied to the input before it is stepped or
// sent, so online they need no server support and change nobody else's physics.
//
// Feel layer (render + audio only — never the sim): each frame feeds fx.js
// (smoke, sparks, skid marks) and scene.fx (speed blur, FOV kick, shake), places
// the audio listener and every rival's engine, and runs the moments — the start
// gantry, launch smoke at GO, kerb buzz/rumble, barrier slapback, flashbulbs on a
// personal-best lap, and in solo races a photo-finish slow motion. Slow motion
// scales how much sim time each frame feeds the fixed-tick accumulator, so lap
// times (sim clock) are unaffected; online the server owns time and it never runs.
//
// 2026-09-29 additions, same rule (render + audio only): every exhaust pop audio.js
// reports becomes a flame on that car; barrier hits and contacts dent the cars
// involved and throw debris; the grandstand crowd murmurs, cheers a pass-by, an
// overtake, a PB and the finish (confetti on a podium); music.js follows the battle
// (another car within a few lengths) and the final lap; wet-road reflections
// (reflections.js) track every light; and the glass gauge (#pocabinetGauge, the
// page's markup) gets speed, gear and RPM written straight to the DOM each frame —
// never through Blazor, so it costs no re-render.

import { Vector3 } from 'three';
import { buildTrack, wrapAngle } from './track.js';
import * as ph from './physics.js';
import { attachInput } from './input.js';
import { mountCar, unmountCar, CarCrowd } from './cars.js';
import * as audio from './audio.js';
import { currentEnvironment } from './environment.js';
import { lapTraces, bestTrace, loadPbTrace, savePbTrace, renderTelemetry, debriefFacts } from './telemetry.js';
import { createFx } from './fx.js';
import { computeKerbs, onKerb } from './kerbs.js';
import { getRecords } from './settings.js';
import * as music from './music.js';
import { WetReflections } from './reflections.js';

const TICK = ph.TICK_SECONDS;
const COUNTDOWN = 3;
const FINISH_GRACE = 15;
const MAX_RECORD_FRAMES = 30 * 60 * 8;
const INTERP_DELAY_MS = 100;
const SNAP_DISTANCE = 40;
const FULL_CARS = 10;             // rivals drawn in full (the nearest); the rest are the instanced crowd
const RIVAL_VOICES = 6;          // engines heard at once (each is an oscillator through an HRTF panner)
const SLOW_MO_SCALE = 0.28;
const GANTRY_PODS = 5;
const BATTLE_NEAR = 25;          // sim units between centres: side by side
const BATTLE_FAR = 95;           // …fading out by here (about six car lengths)
const STAND_PASS = 24;           // world units from the grandstand that count as a pass-by
const AXLE = 14;                 // sim units from a car's centre to each axle (height sampling)
// What a wrecked car loses, at worst: a steady pull on the wheel, a share of its lock and of
// its throttle. Subtle on purpose (a bent car is slower, not undriveable) and meant to be tuned.
const WEAR_PULL = 0.06;
const WEAR_LOCK = 0.15;
const WEAR_POWER = 0.15;
const WEAR_FLOOR = 0.3;          // a hit weaker than this only marks the paint
const WEAR_GAIN = 0.6;           // a flat-out hit into a wall costs about 0.4 of the worst

let race = null;

// ──────────────────────────────────────────────────────────────────────────
//  Public API (re-exported on window.PoCabinet by index.js)
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param dotnetRef  DotNetObjectReference to the page
 * @param sceneHandle / minimapHandle  mounted by the page
 * @param opts { mode: 'solo'|'demo'|'net', world, playerName, color,
 *               localCarId (net), initialSnapshot (net), settings }
 */
export function startRace(dotnetRef, sceneHandle, minimapHandle, opts) {
    stopRace();
    race = new Race(dotnetRef, sceneHandle, minimapHandle, opts || {});
    return true;
}

export function stopRace() {
    if (race) race.dispose();
    race = null;
}

export function pauseRace() { race?.setPaused(true); }
export function resumeRace() { race?.setPaused(false); }
export function pushServerSnapshot(snap) { race?.onServerSnapshot(snap); }
export function updateRaceSettings(settings) { race?.applySettings(settings); }
export function cycleCamera() { race?.cycleCamera(); }

/** Draw the post-race chart into a canvas; returns the text summary. */
export function showTelemetry(canvasId) {
    return race ? race.telemetry(canvasId) : { summary: 'No race recorded.', hasReference: false };
}

export function startReplay() { return race ? race.startReplay() : false; }
export function replayCommand(cmd, value) { race?.replayCommand(cmd, value); }
export function stopReplay() { race?.stopReplay(); }
export function recordClip() { return race ? race.recordClip() : Promise.resolve('unavailable'); }
/** The officials' line pool for this track (GET /api/pocabinet/banter), when it arrives. */
export function setBanter(lines) { race?.setBanter(lines); }
/** Solo lap proof for the score submit: { inputs: base64 | null, wet }. */
export function lapProof() { return race ? race.lapProof() : { inputs: null, wet: false }; }

// ──────────────────────────────────────────────────────────────────────────

class Race {
    constructor(dotnet, scene, minimap, opts) {
        this.dotnet = dotnet;
        this.scene = scene;
        this.minimap = minimap;
        this.mode = opts.mode || 'solo';
        this.world = opts.world;
        this.track = buildTrack(opts.world);
        this.totalLaps = Number(opts.world?.totalLaps) || 3;
        // Rain grip is a solo-only effect: online, prediction must run the server's numbers.
        this.grip = this.mode === 'net' ? 1 : (currentEnvironment().raining ? 0.85 : 1);
        this.settings = {};
        this.cameraMode = 'chase';   // third person only: 'chase' | 'far'
        this.demoCameraAt = 0;
        this.paused = false;
        this.disposed = false;
        this.clock = 0;
        this.acc = 0;
        this.lastFrame = null;
        this.finishOrder = 0;
        this.firstFinishAt = -1;
        this.simDone = false;
        this.hudFinishedSent = false;
        this.lastControls = { throttle: 0, brake: 0, steer: 0 };
        this.minimapAt = 0;
        this.replay = null;
        this.rec = null;
        // Lap proof (2026-09-29): the player's quantized controls, one [thr, brk, str] triple
        // per race tick, for PoCabinetLapVerifier to re-run server-side. Solo only — online
        // laps are timed by the server's own sim.
        this.proof = this.mode === 'solo' ? [] : null;
        // Sector splits (thirds of the lap) for the page's HUD: next boundary index, last crossing time.
        this.sectors = { next: 1, lastT: 0 };
        // Officials' radio (solo/demo; online the server's sim speaks): the pool arrives
        // asynchronously (setBanter), lines are rate-limited and ride the HUD snapshot.
        this.banter = null;
        this.line = null;
        this.lineSeq = 0;
        this.lastLineAt = 0;
        this.saidPreRace = false;
        this.saidFinish = false;
        this.prevLeader = null;
        this.prevLocalPos = 0;
        this.wallHits = 0;
        this.lastWallAt = 0;
        // What the hits have cost the player's car, each 0..1 of the worst (pull is signed,
        // + = right). It shapes the INPUT in tick(), like the driver aids, before the input
        // is recorded or sent: both physics copies and the lap verifier are untouched, the lap
        // proof replays as driven, and online it needs no server support or snapshot field.
        // ponytail: the rivals only dent. Their controls come from aiControls, which the lap
        // verifier re-runs, so wearing them down needs a deterministic damage state in all
        // three sim mirrors. Do that if the field should limp too.
        this.wear = { pull: 0, lock: 0, power: 0 };

        this.input = attachInput({
            touchRoot: 'pocabinetTouch',
            onPause: () => { try { this.dotnet.invokeMethodAsync('OnTogglePause'); } catch { /* disposed */ } },
            onCamera: () => this.cycleCamera(),
        });

        this.cars = this.mode === 'net' ? this.buildNetCars(opts) : this.buildSoloCars(opts);
        this.local = this.cars.find(c => c.isLocal) || null;
        this.crowd = null;
        if (this.cars.length > FULL_CARS + 1) {
            try { this.crowd = new CarCrowd(this.scene.scene, this.cars.length); } catch { this.crowd = null; }
        }
        this.byRange = [];
        if (this.mode === 'net' && opts.initialSnapshot) this.onServerSnapshot(opts.initialSnapshot);
        this.startRecording();
        this.applySettings(opts.settings || {});

        // Feel layer.
        this.kerbs = computeKerbs(this.track);
        try {
            this.fx = createFx(this.scene, this.track, {
                grip: this.grip, raining: currentEnvironment().raining, groundHex: this.world?.atmosphere?.groundHex,
            });
        } catch { this.fx = null; }
        const pb = getRecords(this.track.id).bestLap;
        this.pbLap = pb > 0 ? pb : -1;
        this.timeScale = 1;
        this.photo = { state: 'idle', endAt: 0, startedAt: 0 };
        this.lights = { lit: -1, go: false };
        this.cam = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, init: false };
        this.camFwd = new Vector3();
        if (this.scene.scenery) {
            this.scene.scenery.onFlash = (pos) => audio.shutter(pos, 0.8);
        }

        // Wet-road light streaks: rain only (dry tarmac has nothing to mirror them in), and
        // only on a flat track: the streaks are drawn on the ground plane.
        this.reflections = null;
        if (currentEnvironment().raining && !this.track.z) {
            try { this.reflections = new WetReflections(this.scene); } catch { this.reflections = null; }
        }
        this.moments = { lastPos: this.local?.position ?? 0, overtakeAt: 0, standAt: 0, finished: false, raceStart: 0 };
        this.gauge = null;

        this.frameCb = (now) => this.frame(now);
        this.scene.onFrame(this.frameCb);
    }

    // ── Setup ────────────────────────────────────────────────────────────

    buildSoloCars(opts) {
        const cars = [];
        const player = this.makeCar({
            id: 0, name: opts.playerName || 'Player', officialId: 'player',
            color: opts.color || '#3a7d44', isPlayer: true, isLocal: true,
        });
        if (this.mode === 'demo') {
            player.persona = ph.AUTOPILOT;
            player.maxSpeed = ph.MAX_SPEED * 0.97;
            player.corneringSkill = 0.8;
        }
        ph.gridSlot(this.track, player.body, ph.PLAYER_SLOT);
        cars.push(player);
        // MIRRORED by PoCabinetLapVerifier.Replay: the rivals in soloField order, each in its
        // own index's slot (one further back from the player's slot on), in this car order.
        ph.soloField().forEach((o, i) => {
            const car = this.makeCar({ id: i + 1, name: o.name, officialId: o.id, color: o.color, isPlayer: false, isLocal: false });
            car.persona = o.persona;
            car.maxSpeed = o.maxSpeed;
            car.corneringSkill = o.corneringSkill;
            ph.gridSlot(this.track, car.body, i < ph.PLAYER_SLOT ? i : i + 1);
            cars.push(car);
        });
        for (const c of cars) this.savePrev(c);
        // Grid order is race order until the lights go out.
        [...cars].sort((a, b) => b.body.distance - a.body.distance).forEach((c, i) => { c.position = i + 1; });
        return cars;
    }

    buildNetCars(opts) {
        this.net = {
            localId: Number.isInteger(opts.localCarId) ? opts.localCarId : null,
            seq: 0,
            history: [],
            snaps: [],
            offsets: [],
            offset: null,
            started: false,
            finished: false,
            renderOffset: { x: 0, y: 0, h: 0 },
        };
        const snap = opts.initialSnapshot || { cars: [] };
        const cars = (snap.cars || []).map(s => {
            const car = this.makeCar({
                id: s.id, name: s.name, officialId: s.officialId, color: s.color,
                isPlayer: !!s.isPlayer, isLocal: s.id === this.net.localId,
            });
            this.setBodyFromState(car.body, s);
            this.savePrev(car);
            return car;
        });
        return cars;
    }

    makeCar(meta) {
        const car = {
            ...meta,
            body: ph.createBody(),
            prev: { x: 0, y: 0, heading: 0, along: 0 },
            render: { x: 0, y: 0, heading: 0, speed: 0, along: 0, h: 0, pitch: 0, roll: 0 },
            persona: null, maxSpeed: ph.MAX_SPEED, corneringSkill: 0.7,
            lapsDone: 0, lapStart: 0, lastLap: 0, bestLap: 0,
            finished: false, finishTime: 0, finishOrder: 0, position: meta.id + 1,
            prevDistance: 0,
            mesh: null,
        };
        try {
            // Body style by car id: the player's (0) is the coupe, the field takes the styles in turn.
            car.mesh = mountCar(this.scene.scene, { id: meta.officialId === 'player' ? undefined : meta.officialId, name: meta.name, color: meta.color, style: meta.id });
            car.mesh.group.visible = !meta.isLocal;
        } catch { car.mesh = null; }
        return car;
    }

    setBodyFromState(body, s) {
        body.x = Number(s.x) || 0;
        body.y = Number(s.y) || 0;
        body.heading = Number(s.heading) || 0;
        body.speed = (Number(s.speedKmh) || 0) / ph.KMH_PER_UNIT;
        // A body with no hint yet takes the server's lap fraction as one: the Playground run
        // crosses over itself, and a blind nearest-point search can land on the wrong level.
        if (body.segHint < 0) body.segHint = this.track.indexAt((Number(s.lapProgress) || 0) * this.track.length);
        const proj = this.track.project(body.x, body.y, body.segHint);
        body.segHint = proj.index;
        body.along = proj.along;
        body.lateral = proj.lateral;
        body.onGrass = Math.abs(proj.lateral) > this.track.halfWidth;
    }

    savePrev(car) {
        car.prev.x = car.body.x;
        car.prev.y = car.body.y;
        car.prev.heading = car.body.heading;
        car.prev.along = car.body.along;
    }

    /**
     * Road height, pitch and roll under a pose whose `along` is set (render-only; flat
     * tracks read 0). Sampled under both axles, so the car bridges a crest instead of
     * sinking into it. A banked road tilts about its centerline: a car off-centre sits
     * higher or lower, and how far it points along or across the road splits the slope
     * and the bank between its pitch and roll.
     */
    place(r) {
        const t = this.track;
        if (!t.z) { r.h = 0; r.pitch = 0; r.roll = 0; return; }
        const p = t.pointAt(r.along);
        const c = Math.cos(r.heading) * p.tx + Math.sin(r.heading) * p.ty;      // along the road
        const s = Math.sin(r.heading) * p.tx - Math.cos(r.heading) * p.ty;      // across it
        const front = t.heightAt(r.along + AXLE * c), rear = t.heightAt(r.along - AXLE * c);
        const slope = (front - rear) / (AXLE * 2 * (Math.abs(c) > 0.2 ? c : 1));
        const bank = t.bankAt(r.along);
        const lateral = (r.x - p.x) * -p.ty + (r.y - p.y) * p.tx;
        r.h = ((front + rear) / 2 + lateral * bank) / 10;
        r.pitch = Math.atan(slope * c + bank * s);
        r.roll = Math.atan(bank * c - slope * s);
    }

    applySettings(settings) {
        this.settings = { ...this.settings, ...(settings || {}) };
        this.input.setOptions(this.settings);
        music.setEnabled(this.settings.music !== false);
        this.scene.setRacingLine?.(!!this.settings.racingLine && !this.replay);
    }

    setPaused(p) {
        // Only solo races pause; the server owns multiplayer time.
        if (this.mode === 'net') return;
        this.paused = !!p;
        if (!this.paused) this.lastFrame = null;
    }

    cycleCamera() {
        if (this.replay) {
            const order = ['chase', 'far', 'tv'];
            this.replay.camera = order[(order.indexOf(this.replay.camera) + 1) % order.length];
            this.pushReplayState(true);
            return;
        }
        this.cameraMode = this.cameraMode === 'chase' ? 'far' : 'chase';
    }

    // ── Frame loop ───────────────────────────────────────────────────────

    frame(now) {
        if (this.disposed) return;
        const dt = this.lastFrame === null ? 0 : Math.min(0.1, (now - this.lastFrame) / 1000);
        this.lastFrame = now;

        if (this.replay) {
            this.updateReplay(dt, now);
            return;
        }
        if (!this.paused) {
            this.acc += dt * this.timeScale;
            let steps = 0;
            while (this.acc >= TICK && steps < 5) {
                this.tick();
                this.acc -= TICK;
                steps++;
            }
            if (steps === 5) this.acc = 0;
        }
        this.render(dt, now);
    }

    tick() {
        const raw = this.input.read(TICK);
        let controls = raw;
        if (this.local && this.mode !== 'demo') {
            controls = ph.assistControls(this.track, this.local.body, raw,
                { steering: this.settings.steeringAssist, autoBrake: !!this.settings.autoBrake }, this.grip);
            const w = this.wear;
            controls = {
                throttle: controls.throttle * (1 - WEAR_POWER * w.power),
                brake: controls.brake,
                steer: Math.min(1, Math.max(-1, controls.steer * (1 - WEAR_LOCK * w.lock) + WEAR_PULL * w.pull)),
            };
        }
        if (this.proof) {
            // Quantize BEFORE stepping, so what is recorded is exactly what was simulated:
            // n / 1000 is the same double here and in PoCabinetLapVerifier.Decode.
            const t = Math.round(controls.throttle * 1000), b = Math.round(controls.brake * 1000), s = Math.round(controls.steer * 1000);
            controls = { throttle: t / 1000, brake: b / 1000, steer: s / 1000, q: [t, b, s] };
        }
        this.lastControls = controls;
        if (this.mode === 'net') this.netTick(controls);
        else this.soloTick(controls);
    }

    soloTick(controls) {
        this.clock += TICK;
        const elapsed = this.clock - COUNTDOWN;
        if (!this.saidPreRace && this.clock > 0.8 && this.banter) {
            this.saidPreRace = this.say(ph.OFFICIALS[Math.floor(Math.random() * ph.OFFICIALS.length)].id, 'preRace', true);
        }
        if (elapsed < 0) {
            this.pushHud(elapsed);
            return;
        }
        const tickStart = Math.max(0, elapsed - TICK);
        const stepDt = elapsed - tickStart;
        const bodies = this.cars.map(c => c.body);
        if (this.proof && this.local && !this.local.finished && this.proof.length < MAX_RECORD_FRAMES) {
            this.proof.push(controls.q);
        }
        for (const car of this.cars) {
            this.savePrev(car);
            car.prevDistance = car.body.distance;
            let c;
            if (car.isLocal && !car.finished && this.mode !== 'demo') c = controls;
            else {
                const persona = car.persona || ph.AUTOPILOT;
                c = ph.aiControls(this.track, car.body, persona, car.finished ? car.maxSpeed * this.track.coolDownAt(car.body.distance) : car.maxSpeed,
                    car.corneringSkill, bodies, this.grip);
                if (car.isLocal) this.lastControls = c;
            }
            ph.step(this.track, car.body, c, stepDt, this.grip);
        }
        ph.resolveContacts(this.track, bodies);
        this.lapBookkeeping(tickStart, stepDt, elapsed);
        this.checkPhotoFinish();
        this.feedback();
        this.record(elapsed);
        this.pushHud(elapsed);
    }

    lapBookkeeping(tickStart, stepDt, elapsed) {
        const L = this.track.lapLength;
        for (const car of this.cars) {
            if (car.finished) continue;
            if (car.isLocal) this.checkSectors(car.prevDistance, car.body.distance, tickStart, stepDt);
            while (car.body.distance >= (car.lapsDone + 1) * L) {
                const boundary = (car.lapsDone + 1) * L;
                const span = car.body.distance - car.prevDistance;
                const frac = span > 1e-9 ? Math.min(1, Math.max(0, (boundary - car.prevDistance) / span)) : 1;
                const crossedAt = tickStart + frac * stepDt;
                const lapTime = crossedAt - car.lapStart;
                if (car.isLocal && this.rec) {
                    this.rec.laps.push({ lap: car.lapsDone + 1, startT: car.lapStart, endT: crossedAt, time: lapTime });
                }
                car.lapStart = crossedAt;
                car.lastLap = lapTime;
                const raceBest = car.bestLap <= 0 || lapTime < car.bestLap;
                if (raceBest) car.bestLap = lapTime;
                car.lapsDone++;
                if (car.isLocal && this.mode !== 'demo') this.onLocalLap(lapTime, raceBest && car.lapsDone > 1);
                if (car.lapsDone >= this.totalLaps) {
                    car.finished = true;
                    car.finishTime = crossedAt;
                    car.finishOrder = ++this.finishOrder;
                    if (this.firstFinishAt < 0) this.firstFinishAt = elapsed;
                    break;
                }
            }
        }
        const order = [...this.cars].sort((a, b) => {
            if (a.finished !== b.finished) return a.finished ? -1 : 1;
            if (a.finished) return a.finishOrder - b.finishOrder;
            return b.body.distance - a.body.distance;
        });
        order.forEach((c, i) => { c.position = i + 1; });
        this.banterEvents(order, elapsed);
        const everyone = this.cars.every(c => c.finished);
        const grace = this.firstFinishAt >= 0 && elapsed - this.firstFinishAt > FINISH_GRACE;
        if (!this.simDone && (everyone || grace || (this.local?.finished && elapsed - this.local.finishTime > 6))) {
            this.simDone = true;
        }
    }

    netTick(controls) {
        const n = this.net;
        if (!this.local) {
            // Spectating: no car, no inputs — just keep the recording for the replay.
            if (!n.finished) this.record(this.estServerMs() / 1000 - COUNTDOWN);
            return;
        }
        n.seq++;
        const moving = n.started || this.estServerMs() >= COUNTDOWN * 1000;
        const entry = { seq: n.seq, c: controls, moving };
        n.history.push(entry);
        if (n.history.length > 120) n.history.shift();
        try {
            this.dotnet.invokeMethodAsync('OnNetInputAsync', n.seq,
                round3(controls.throttle), round3(controls.brake), round3(controls.steer));
        } catch { /* disposed */ }
        if (moving && !this.local.finished) {
            this.savePrev(this.local);
            const before = this.local.body.distance;
            ph.step(this.track, this.local.body, controls, TICK, 1);
            const raceT = this.estServerMs() / 1000 - COUNTDOWN;
            this.checkSectors(before, this.local.body.distance, raceT - TICK, TICK);
            this.feedback();
        }
        if (!n.finished) this.record(this.estServerMs() / 1000 - COUNTDOWN);
    }

    /**
     * The local car crossed one or more sector boundaries (every third of the lap) this tick:
     * report each with its crossing instant interpolated inside the tick, like the lap line.
     * Online the distance is the predicted car's, so a split can be off by a snapshot
     * correction — the HUD's splits are guidance; the server's lap times are the record.
     */
    checkSectors(prev, dist, tickStart, stepDt) {
        const s = this.sectors;
        const third = this.track.lapLength / 3;
        while (dist >= s.next * third) {
            const boundary = s.next * third;
            const span = dist - prev;
            const frac = span > 1e-9 ? Math.min(1, Math.max(0, (boundary - prev) / span)) : 1;
            const t = tickStart + frac * stepDt;
            const sector = (s.next - 1) % 3;
            const seconds = t - s.lastT;
            s.lastT = t;
            s.next++;
            try { this.dotnet.invokeMethodAsync('OnSectorAsync', sector, seconds, t); } catch { /* disposed */ }
        }
    }

    setBanter(lines) {
        this.banter = lines && typeof lines === 'object' ? lines : null;
    }

    /** One radio line from `officialId`; false when there is no line or it is too soon after the last. */
    say(officialId, kind, force = false) {
        const pool = this.banter?.[officialId]?.[kind];
        if (!Array.isArray(pool) || !pool.length) return false;
        const now = performance.now();
        if (!force && now - this.lastLineAt < 6000) return false;
        this.lastLineAt = now;
        this.line = { officialId, kind, text: pool[Math.floor(Math.random() * pool.length)], raceTick: ++this.lineSeq };
        return true;
    }

    /** Race moments that make an official key the radio: being passed, taking the lead, the finish. */
    banterEvents(order, elapsed) {
        if (!this.banter || !this.local || this.mode === 'net') return;
        const me = this.local;
        const leader = order[0];
        if (elapsed > 2) {
            if (me.position < this.prevLocalPos) {
                const passed = order[me.position];   // the car now directly behind
                if (passed && !passed.isLocal) this.say(passed.officialId, 'passed');
            }
            if (this.prevLeader && leader !== this.prevLeader && !leader.isLocal) this.say(leader.officialId, 'lead');
        }
        if (me.finished && !this.saidFinish) {
            this.saidFinish = true;
            // The best-placed official: the field racers have no radio.
            const winner = order.find(c => !c.isLocal && this.banter[c.officialId]) || order[0];
            this.say(winner.officialId, 'finish', true);
        }
        this.prevLocalPos = me.position;
        this.prevLeader = leader;
    }

    feedback() {
        const car = this.local;
        if (!car) return;
        if (car.body.wallImpact > 6 && performance.now() - this.lastWallAt > 500) {
            this.wallHits++;
            this.lastWallAt = performance.now();
        }
        if (car.body.wallImpact > 6) {
            const s = Math.min(1, car.body.wallImpact / 60);
            this.input.rumble(s);
            audio.impact(s, 'wall');
            this.scene.fx.shake = Math.max(this.scene.fx.shake, 0.35 + s * 0.65);
        }
    }

    // ── Moments ──────────────────────────────────────────────────────────

    /**
     * A lap by the player. A personal best (against the stored record, then against
     * this session's own laps) sets the whole press pen off; a race-best lap that is
     * not a PB gets a smaller volley.
     */
    onLocalLap(lapTime, raceBest) {
        if (!(lapTime > 0)) return;
        const scenery = this.scene.scenery;
        if (this.pbLap < 0 || lapTime < this.pbLap) {
            this.pbLap = lapTime;
            scenery?.flashBurst(1);
            scenery?.exciteCrowd(1);
            audio.cheer(0.8);
            this.scene.fx.flash = Math.max(this.scene.fx.flash, this.scene.fx.reduced ? 0.12 : 0.3);
        } else if (raceBest) {
            scenery?.flashBurst(0.35);
        }
    }

    /**
     * Solo only: on the final lap, when the player is about a second from the line
     * with a rival alongside, slow time until just after they cross it.
     */
    checkPhotoFinish() {
        const p = this.photo, me = this.local;
        if (!me || this.mode === 'net' || p.state === 'done') return;
        const L = this.track.lapLength;
        if (p.state === 'idle') {
            if (me.finished || me.lapsDone !== this.totalLaps - 1) return;
            const toGo = this.totalLaps * L - me.body.distance;
            if (toGo <= 0 || toGo > Math.max(45, me.body.speed * 1.05)) return;
            const close = this.cars.some(c => c !== me && Math.abs(c.body.distance - me.body.distance) < 30
                && (c.finished ? c.finishTime > this.clock - COUNTDOWN - 0.25 : c.lapsDone === this.totalLaps - 1));
            if (!close) return;
            p.state = 'slow';
            p.endAt = Infinity;
            p.startedAt = this.clock;
            return;
        }
        if (me.finished && p.endAt === Infinity) {
            p.endAt = this.clock + 0.4;
            this.scene.fx.flash = Math.max(this.scene.fx.flash, this.scene.fx.reduced ? 0.15 : 0.55);
            this.scene.scenery?.flashBurst(1);
            audio.shutter(null, 1);
        }
        if (this.clock >= p.endAt || this.clock - p.startedAt > 3) p.state = 'done';
    }

    // ── Multiplayer ──────────────────────────────────────────────────────

    estServerMs() {
        const n = this.net;
        if (!n || n.offset === null) return 0;
        return performance.now() - n.offset;
    }

    onServerSnapshot(snap) {
        const n = this.net;
        if (!n || !snap) return;
        const now = performance.now();
        // Clock mapping: the smallest (receive − server) gap seen recently is the
        // least-delayed packet — the best estimate of the one-way offset.
        n.offsets.push(now - Number(snap.serverTimeMs || 0));
        if (n.offsets.length > 40) n.offsets.shift();
        n.offset = Math.min(...n.offsets);
        n.started = !!snap.started;
        n.snaps.push({ t: Number(snap.serverTimeMs || 0), cars: snap.cars || [] });
        if (n.snaps.length > 60) n.snaps.shift();

        for (const s of snap.cars || []) {
            const car = this.cars.find(c => c.id === s.id);
            if (!car) continue;
            car.position = s.position;
            car.finished = !!s.finished;
            car.lapsDone = Math.max(0, (s.lap || 1) - 1);
        }
        if (snap.finished) n.finished = true;
        if (this.local) this.reconcile(snap);
    }

    reconcile(snap) {
        const n = this.net;
        const s = (snap.cars || []).find(c => c.id === n.localId);
        if (!s) return;
        const ack = Number(s.ackSeq) || 0;
        while (n.history.length && n.history[0].seq <= ack) n.history.shift();

        const server = ph.createBody();
        server.segHint = this.local.body.segHint;
        this.setBodyFromState(server, s);
        // Race distance at the SERVER's position: the predicted car's distance minus how far
        // along it is ahead of the server's. Copying the predicted distance straight across
        // double-counted that gap on every snapshot, and online telemetry "laps" came out
        // four seconds long.
        let ahead = this.local.body.along - server.along;
        const half = this.track.length / 2;
        if (ahead > half) ahead -= this.track.length;
        else if (ahead < -half) ahead += this.track.length;
        server.distance = this.local.body.distance - ahead;
        if (snap.started && !s.finished) {
            for (const h of n.history) if (h.moving) ph.step(this.track, server, h.c, TICK, 1);
        }

        const cur = this.local.body;
        const dx = cur.x - server.x, dy = cur.y - server.y;
        if (Math.hypot(dx, dy) > SNAP_DISTANCE) {
            n.renderOffset.x = 0; n.renderOffset.y = 0; n.renderOffset.h = 0;
        } else {
            n.renderOffset.x += dx;
            n.renderOffset.y += dy;
            n.renderOffset.h += wrapAngle(cur.heading - server.heading);
        }
        ph.copyBody(server, cur);
        this.savePrev(this.local);
    }

    /** Remote pose at render time: 100 ms behind the server, interpolated. */
    remotePose(car, renderMs) {
        const snaps = this.net.snaps;
        if (!snaps.length) return null;
        let a = null, b = null;
        for (let i = snaps.length - 1; i >= 0; i--) {
            if (snaps[i].t <= renderMs) { a = snaps[i]; b = snaps[i + 1] || null; break; }
        }
        if (!a) a = snaps[0];
        const sa = a.cars.find(c => c.id === car.id);
        if (!sa) return null;
        const sb = b ? b.cars.find(c => c.id === car.id) : null;
        // Where along the loop (for the road height): the server's lap fraction, not a projection.
        const L = this.track.length;
        const alongA = (Number(sa.lapProgress) || 0) * L;
        if (!sb) {
            // Past the newest snapshot: extrapolate briefly along the heading.
            const ahead = Math.min(0.1, Math.max(0, (renderMs - a.t) / 1000));
            const v = (Number(sa.speedKmh) || 0) / ph.KMH_PER_UNIT;
            return { x: sa.x + Math.cos(sa.heading) * v * ahead, y: sa.y + Math.sin(sa.heading) * v * ahead, heading: sa.heading, speed: v, along: alongA + v * ahead };
        }
        const f = b.t > a.t ? Math.min(1, Math.max(0, (renderMs - a.t) / (b.t - a.t))) : 1;
        return {
            along: alongA + wrapHalf((Number(sb.lapProgress) || 0) * L - alongA, L) * f,
            x: sa.x + (sb.x - sa.x) * f,
            y: sa.y + (sb.y - sa.y) * f,
            heading: sa.heading + wrapAngle(sb.heading - sa.heading) * f,
            speed: ((Number(sa.speedKmh) || 0) + ((Number(sb.speedKmh) || 0) - (Number(sa.speedKmh) || 0)) * f) / ph.KMH_PER_UNIT,
        };
    }

    // ── Rendering ────────────────────────────────────────────────────────

    render(dt, now) {
        const alpha = Math.min(1, this.acc / TICK);
        const isNet = this.mode === 'net';
        const renderMs = isNet ? this.estServerMs() - INTERP_DELAY_MS : 0;
        if (isNet) {
            const k = Math.exp(-dt / 0.1);
            const o = this.net.renderOffset;
            o.x *= k; o.y *= k; o.h *= k;
        }

        for (const car of this.cars) {
            let pose;
            if (isNet && !car.isLocal) {
                pose = this.remotePose(car, renderMs);
                if (!pose) continue;
            } else {
                const b = car.body;
                pose = {
                    x: car.prev.x + (b.x - car.prev.x) * alpha,
                    y: car.prev.y + (b.y - car.prev.y) * alpha,
                    heading: car.prev.heading + wrapAngle(b.heading - car.prev.heading) * alpha,
                    speed: b.speed,
                    along: car.prev.along + wrapHalf(b.along - car.prev.along, this.track.length) * alpha,
                };
                if (isNet && car.isLocal) {
                    pose.x += this.net.renderOffset.x;
                    pose.y += this.net.renderOffset.y;
                    pose.heading += this.net.renderOffset.h;
                }
            }
            car.render.x = pose.x;
            car.render.y = pose.y;
            car.render.heading = pose.heading;
            car.render.speed = pose.speed;
            car.render.along = pose.along;
            this.place(car.render);
            car.mesh?.update({ x: pose.x, y: pose.y, heading: pose.heading, speedKmh: pose.speed * ph.KMH_PER_UNIT, h: car.render.h, pitch: car.render.pitch, roll: car.render.roll });
        }
        this.cull();

        // Camera: the local car, or the race leader when spectating.
        let mode = this.cameraMode;
        if (this.mode === 'demo') {
            if (now - this.demoCameraAt > 7000) {
                this.demoCameraAt = now;
                const order = ['chase', 'far', 'tv'];
                this.demoCamera = order[(order.indexOf(this.demoCamera || 'tv') + 1) % order.length];
            }
            mode = this.demoCamera || 'chase';
        }
        const focus = this.local || [...this.cars].sort((a, b) => a.position - b.position)[0];
        if (!this.local) mode = 'chase';
        if (focus) {
            this.scene.setView({ ...focus.render, mode, dt });
            if (focus.mesh) focus.mesh.group.visible = true;
        }
        this.effects(dt, mode, focus);

        if (this.minimap && now - this.minimapAt > 66) {
            this.minimapAt = now;
            try {
                this.minimap.update(this.cars.map(c => ({
                    x: c.render.x, y: c.render.y, color: c.color, officialId: c.officialId,
                    isPlayer: c.isLocal, finished: c.finished,
                })));
            } catch { /* decorative */ }
        }
    }

    /**
     * A hundred cars at fourteen draw calls each, all casting shadows, is more than the
     * frame has: only the rivals nearest the camera's car are drawn in full, the rest go
     * into the instanced crowd. A rival that has parked in a point-to-point run-out is not
     * drawn at all (the physics stops colliding it there, so they stack). A field small
     * enough to draw whole (online) has no crowd and is left alone.
     */
    cull() {
        const crowd = this.crowd;
        const focus = this.local || this.cars[0];
        if (!crowd || !focus) return;
        const live = this.mode !== 'net' && !this.replay;
        const order = this.byRange;
        order.length = 0;
        for (const car of this.cars) {
            if (!car.mesh || car === focus) continue;
            if (live && this.track.parked(car.body.distance) && Math.abs(car.body.speed) < 1) {
                car.mesh.group.visible = false;
                continue;
            }
            const dx = car.render.x - focus.render.x, dy = car.render.y - focus.render.y;
            car.range = dx * dx + dy * dy;
            order.push(car);
        }
        order.sort((a, b) => a.range - b.range);
        crowd.begin();
        order.forEach((car, i) => {
            const full = i < FULL_CARS;
            car.mesh.group.visible = full;
            if (!full) crowd.add(car.mesh);
        });
        crowd.end();
    }

    // ── Feel layer: particles, post inputs, audio, gantry ────────────────

    effects(dt, mode, focus) {
        const fx = this.scene.fx;
        const isNet = this.mode === 'net';

        // Slow motion eases in and out on real time.
        const target = this.photo.state === 'slow' ? SLOW_MO_SCALE : 1;
        if (dt > 0) this.timeScale += (target - this.timeScale) * (1 - Math.exp(-dt * 6));
        if (Math.abs(this.timeScale - target) < 0.005) this.timeScale = target;
        const slow = (1 - this.timeScale) / (1 - SLOW_MO_SCALE);
        fx.slow = slow;
        audio.setSlowMo(slow);

        const serverS = isNet ? this.estServerMs() / 1000 : this.clock;
        const preStart = isNet ? !this.net.started && serverS < COUNTDOWN : this.clock < COUNTDOWN;
        const racing = isNet ? (this.net.started && !this.net.finished) : (this.clock > COUNTDOWN && !this.simDone);
        this.updateLights(serverS);

        const speed01 = focus ? Math.min(1, Math.abs(focus.render.speed) / ph.MAX_SPEED) : 0;
        // Speed blur belongs to a camera that moves with the car, not a trackside one.
        fx.speed = racing && mode !== 'tv' ? speed01 : 0;
        fx.focus = focus ? { x: focus.render.x / 10, y: focus.render.h, z: focus.render.y / 10, speed01 } : null;

        const events = this.fx?.update(this.paused ? 0 : dt * this.timeScale, this.fxCars(), { skids: true });

        if (this.local) {
            const b = this.local.body;
            const kmh = Math.abs(this.local.render.speed) * ph.KMH_PER_UNIT;
            const throttle = this.mode === 'demo' && preStart ? 0 : this.lastControls.throttle;
            audio.updateEngine(racing ? kmh : 0, throttle, racing ? 'race' : preStart ? 'grid' : 'off');
            const es = audio.engineState();
            audio.setSqueal(racing && b.sliding ? 1 : 0, kmh);

            const kerbOn = racing && Math.abs(b.speed) > 15 && onKerb(this.kerbs, this.track, b.segHint, b.lateral);
            audio.setKerb(kerbOn, kmh);
            fx.rumble = kerbOn ? 0.3 + 0.7 * Math.min(1, Math.abs(b.speed) / ph.MAX_SPEED) : 0;
            if (kerbOn && this.mode !== 'demo') this.input.rumble(0.2 + 0.3 * fx.rumble);

            const gap = ph.wallLateral(this.track) - Math.abs(b.lateral);
            const near = racing ? Math.max(0, 1 - gap / 45) * Math.min(1, Math.abs(b.speed) / 60) : 0;
            audio.setWallProximity(near, b.lateral > 0 ? 1 : -1);
            audio.setScrape(racing ? (events?.scraping.get(this.local.id) || 0) : 0);
        } else {
            fx.rumble = 0;
        }

        for (const c of events?.contacts || []) {
            if (this.local && c.ids.includes(this.local.id)) {
                audio.impact(c.strength, 'car');
                if (this.mode !== 'demo') this.input.rumble(c.strength);
                fx.shake = Math.max(fx.shake, 0.3 + 0.5 * c.strength);
            } else {
                audio.impact(c.strength * 0.8, 'car', { x: c.x, y: 0.5, z: c.z });
            }
            for (const id of c.ids) this.damage(id, c.x, c.z, c.strength * 0.8);
        }
        for (const w of events?.walls || []) this.damage(w.id, w.x, w.z, w.strength);

        // Exhaust pops → flames (the player's id is the local car's).
        for (const pop of audio.takePops()) {
            const id = pop.id === 'player' ? this.local?.id : pop.id;
            if (id !== undefined && id !== null) this.fx?.backfire(id, pop.strength);
        }

        this.crowdAndMusic(focus, racing, preStart, speed01);
        this.updateGauge(racing || preStart);
        this.reflections?.update(performance.now() / 1000, this.cars.map(c => c.mesh));
        this.updateAudioScene(dt, racing || preStart);
    }

    /** A hit on car `id` at world (x, z): dent it, throw debris off a real one, and wear the player's. */
    damage(id, x, z, strength) {
        const car = this.cars.find(c => c.id === id);
        if (!car || !(strength > 0.12)) return;
        if (car === this.local && this.mode !== 'demo' && !car.finished) this.wearFrom(car.render, x, z, strength);
        if (car.mesh?.addDamage(x, z, strength) && strength > 0.3) this.fx?.debris(x, z, car.mesh.paintHex, strength, car.render.h);
    }

    /**
     * What a hit at world (x, z) costs the car at pose `r`. Where it landed decides what broke:
     * a front corner bends the steering (the car pulls toward the hit and loses lock) and can
     * hole the radiator; a hit further back mostly knocks the tracking out a little.
     */
    wearFrom(r, x, z, strength) {
        const s = (strength - WEAR_FLOOR) * WEAR_GAIN;
        if (s <= 0) return;
        const dx = x * 10 - r.x, dy = z * 10 - r.y;
        const ch = Math.cos(r.heading), sh = Math.sin(r.heading);
        const front = dx * ch + dy * sh > 6;                                       // the hull is 39 long
        const side = Math.min(1, Math.max(-1, (dy * ch - dx * sh) / ph.HULL_RADIUS));
        const w = this.wear;
        w.pull = Math.min(1, Math.max(-1, w.pull + side * s * (front ? 1 : 0.4)));
        if (front) w.lock = Math.min(1, w.lock + s);
        w.power = Math.min(1, w.power + s * (front ? 0.8 : 0.3));
    }

    /** Grandstand, overtakes, the finish, and the score's battle/final-lap state. */
    crowdAndMusic(focus, racing, preStart, speed01) {
        const scenery = this.scene.scenery;
        const stand = scenery?.crowd;
        const now = performance.now();
        const m = this.moments;
        const me = this.local;

        if (stand) {
            if (racing && focus) {
                const d = Math.hypot(focus.render.x / 10 - stand.center.x, focus.render.y / 10 - stand.center.z);
                if (d < STAND_PASS && speed01 > 0.35 && now - m.standAt > 8000) {
                    m.standAt = now;
                    scenery.exciteCrowd(0.6 + speed01 * 0.4);
                    audio.cheer(0.45 + speed01 * 0.35, { x: stand.center.x, y: 2, z: stand.center.z });
                }
            }
            audio.setCrowd(racing || preStart ? 0.2 + stand.level * 0.8 : 0, stand.center);
        }

        if (me && racing) {
            if (!m.raceStart) m.raceStart = now;
            // Places gained, once the start has shaken out; rate-limited so a side-by-side
            // tussle flipping positions every tick does not become a cheer machine.
            if (me.position < m.lastPos && now - m.raceStart > 2500 && now - m.overtakeAt > 3000) {
                m.overtakeAt = now;
                audio.cheer(0.5);
                scenery?.exciteCrowd(0.8);
                scenery?.flashBurst(0.25);
            }
            m.lastPos = me.position;
        }
        if (me && me.finished && !m.finished) {
            m.finished = true;
            scenery?.exciteCrowd(1);
            // The podium, or the top ten of the 100-car solo field (PoCabinetCatalog.SoloFrontRunners).
            const front = me.position <= (this.cars.length > 8 ? 10 : 3);
            audio.cheer(front ? 1 : 0.5);
            if (front && !this.scene.fx.reduced) this.fx?.confetti(me.render.x / 10, me.render.y / 10, 160, me.render.h);
        }

        let battle = 0;
        if (me && racing) {
            for (const c of this.cars) {
                if (c === me) continue;
                const d = Math.hypot(c.render.x - me.render.x, c.render.y - me.render.y);
                battle = Math.max(battle, Math.min(1, Math.max(0, 1 - (d - BATTLE_NEAR) / (BATTLE_FAR - BATTLE_NEAR))));
            }
        }
        const finalLap = !!me && !me.finished && me.lapsDone === this.totalLaps - 1;
        music.setState({ phase: racing && !(me && me.finished) ? 'race' : preStart ? 'grid' : 'off', battle, finalLap });
    }

    /** The glass gauge: speed, gear and RPM written straight into the page's markup. */
    updateGauge(live) {
        // Blazor renders the gauge with the racing phase, which can land after startRace,
        // and drops it for the results — so look it up whenever the cached one is gone.
        if (!this.gauge?.isConnected) {
            this.gauge = document.getElementById('pocabinetGauge');
            this.gaugeSpeed = this.gauge?.querySelector('[data-gauge="speed"]') || null;
            this.gaugeGear = this.gauge?.querySelector('[data-gauge="gear"]') || null;
        }
        const g = this.gauge;
        if (!g) return;
        const car = this.local;
        const es = audio.engineState();
        const kmh = live && car ? Math.abs(car.render.speed) * ph.KMH_PER_UNIT : 0;
        const r01 = Math.max(0, Math.min(1, (es.rpm - es.idle) / (es.redline - es.idle)));
        g.style.setProperty('--rpm', r01.toFixed(3));
        g.dataset.redline = r01 > 0.9 ? 'on' : 'off';
        const speed = String(Math.round(kmh));
        if (this.gaugeSpeed && this.gaugeSpeed.textContent !== speed) this.gaugeSpeed.textContent = speed;
        const gear = kmh < 1 && !live ? 'N' : String(es.gear);
        if (this.gaugeGear && this.gaugeGear.textContent !== gear) this.gaugeGear.textContent = gear;
    }

    /** Car poses for fx.js, in sim units. Locally simulated cars report their exact slide flag. */
    fxCars() {
        const exact = this.mode !== 'net';
        return this.cars.map(c => ({
            id: c.id, x: c.render.x, y: c.render.y, h: c.render.h, heading: c.render.heading, speed: c.render.speed,
            sliding: (exact || c.isLocal) ? !!c.body.sliding : false,
            // Where the sim has the car on the road, when it knows (fx.js would otherwise
            // search blind, and on a course that crosses itself find the wrong level).
            hint: (exact || c.isLocal) ? c.body.segHint : -1,
        }));
    }

    /** Listener on the camera (with its velocity, for Doppler) and every rival's engine. */
    updateAudioScene(dt, live) {
        const cam = this.scene.camera;
        const c = this.cam;
        const p = cam.position;
        if (c.init && dt > 0) {
            const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
            if (dx * dx + dy * dy + dz * dz > 9) {
                c.vx = c.vy = c.vz = 0;   // camera cut, not motion
            } else {
                const k = 1 - Math.exp(-dt * 8);
                c.vx += (dx / dt - c.vx) * k;
                c.vy += (dy / dt - c.vy) * k;
                c.vz += (dz / dt - c.vz) * k;
            }
        }
        c.x = p.x; c.y = p.y; c.z = p.z; c.init = true;
        cam.getWorldDirection(this.camFwd);
        audio.updateListener({ x: p.x, y: p.y, z: p.z }, this.camFwd, { x: 0, y: 1, z: 0 }, { x: c.vx, y: c.vy, z: c.vz });
        if (!live) { audio.updateRivals([]); return; }
        const list = [];
        for (const car of this.cars) {
            if (car.isLocal) continue;
            const h = car.render.heading, v = car.render.speed;
            list.push({
                id: car.id, x: car.render.x / 10, y: car.render.h + 0.5, z: car.render.y / 10,
                vx: Math.cos(h) * v / 10, vz: Math.sin(h) * v / 10, kmh: Math.abs(v) * ph.KMH_PER_UNIT,
            });
        }
        // The nearest few: a voice per car was fine for four rivals, not for ninety-nine.
        if (list.length > RIVAL_VOICES) {
            for (const r of list) r.d2 = (r.x - p.x) ** 2 + (r.z - p.z) ** 2;
            list.sort((a, b) => a.d2 - b.d2);
            list.length = RIVAL_VOICES;
        }
        audio.updateRivals(list);
    }

    /** Start gantry: pods light red one by one through the countdown, all green at GO. */
    updateLights(elapsedS) {
        const remaining = COUNTDOWN - elapsedS;
        let lit = 0, go = false;
        if (remaining > 0) lit = Math.min(GANTRY_PODS, Math.floor((COUNTDOWN - remaining) / COUNTDOWN * GANTRY_PODS) + 1);
        else if (remaining > -2.5) go = true;
        if (lit === this.lights.lit && go === this.lights.go) return;
        const wentGreen = go && !this.lights.go && this.lights.lit > 0;
        this.lights.lit = lit;
        this.lights.go = go;
        this.scene.setStartLights?.(lit, go);
        if (wentGreen) this.onGo();
    }

    /** GO: a jolt, and every car lights its rear tyres (the player's by how hard they launch). */
    onGo() {
        this.scene.fx.shake = Math.max(this.scene.fx.shake, 0.45);
        for (const car of this.cars) {
            const mine = car.isLocal && this.mode !== 'demo';
            this.fx?.launch(car.id, mine ? 0.9 : 0.6, mine ? Math.max(0.35, this.lastControls.throttle) : 0.55);
        }
    }

    // ── HUD bridge (solo modes) ──────────────────────────────────────────

    pushHud(elapsed) {
        if (this.hudFinishedSent) return;
        const local = this.local;
        const finished = !!local?.finished;
        // The page needs the whole field twice: once to count it, and at the finish for the
        // standings. In between it only reads the local car, and marshalling a hundred rows
        // into .NET thirty times a second costs more than the race does.
        const whole = finished || !this.hudFieldSent || !local;
        this.hudFieldSent = true;
        const snap = {
            gameCode: 'SOLO',
            serverTimeMs: Math.round(this.clock * 1000),
            elapsedRaceTime: Math.max(0, elapsed),
            started: elapsed >= 0,
            countdownSeconds: elapsed < 0 ? Math.ceil(-elapsed) : 0,
            finished,
            localCarId: local ? local.id : null,
            cars: (whole ? this.cars : [local]).map(c => ({
                id: c.id, name: c.name, officialId: c.officialId, color: c.color,
                x: round2(c.body.x), y: round2(c.body.y), heading: round3(c.body.heading),
                speedKmh: Math.round(Math.abs(c.body.speed) * ph.KMH_PER_UNIT),
                lap: c.lapsDone + 1,
                lapProgress: fraction(c.body.distance / this.track.length),
                position: c.position, isPlayer: c.isLocal, finished: c.finished, ackSeq: 0,
            })),
            latestDialogue: this.line,
            static: null,
            bestLapSeconds: local && local.bestLap > 0 ? local.bestLap : null,
        };
        if (finished) this.hudFinishedSent = true;
        try { this.dotnet.invokeMethodAsync('OnSoloSnapshotAsync', snap); } catch { /* disposed */ }
    }

    // ── Recording ────────────────────────────────────────────────────────

    startRecording() {
        this.rec = {
            trackId: this.track.id,
            trackLength: this.track.lapLength,
            cars: this.cars.map(c => ({ id: c.id, isLocal: c.isLocal })),
            t: [],
            poses: [],   // per frame: flat [x, y, heading, speed, along] × cars
            local: { dist: [], kmh: [], thr: [], brk: [], str: [] },
            laps: [],
        };
    }

    record(raceTime) {
        const r = this.rec;
        if (!r || this.simDone || r.t.length >= MAX_RECORD_FRAMES || raceTime < 0) return;
        const isNet = this.mode === 'net';
        const renderMs = isNet ? this.estServerMs() - INTERP_DELAY_MS : 0;
        // Float32: a hundred cars for a three-minute run is over three million numbers.
        const frame = new Float32Array(this.cars.length * 5);
        this.cars.forEach((car, k) => {
            let p = car.body;
            if (isNet && !car.isLocal) p = this.remotePose(car, renderMs) || car.render;
            frame[k * 5] = p.x; frame[k * 5 + 1] = p.y; frame[k * 5 + 2] = p.heading; frame[k * 5 + 3] = p.speed; frame[k * 5 + 4] = p.along;
        });
        r.t.push(raceTime);
        r.poses.push(frame);
        const l = this.local;
        r.local.dist.push(l ? l.body.distance : 0);
        r.local.kmh.push(l ? Math.abs(l.body.speed) * ph.KMH_PER_UNIT : 0);
        r.local.thr.push(this.lastControls.throttle);
        r.local.brk.push(this.lastControls.brake);
        r.local.str.push(this.lastControls.steer);

        // Online lap boundaries come from the local car's own distance (the server
        // counts the official laps; this only slices the telemetry).
        if (isNet && l) {
            const L = this.track.lapLength;
            const done = r.laps.length;
            if (l.body.distance >= (done + 1) * L && done < this.totalLaps) {
                const startT = done === 0 ? 0 : r.laps[done - 1].endT;
                const time = raceTime - startT;
                const raceBest = done > 0 && r.laps.every(x => time < x.time);
                r.laps.push({ lap: done + 1, startT, endT: raceTime, time });
                this.onLocalLap(time, raceBest);
            }
        }
    }

    /**
     * Draw the chart. The comparison is fixed the first time: the reference is the PB
     * trace stored BEFORE this race, then this race's best is saved if it beat it —
     * so redrawing (e.g. after the replay) never ends up comparing the lap to itself.
     */
    telemetry(canvasId) {
        if (!this.telemetryPair) {
            const best = bestTrace(lapTraces(this.rec));
            if (!best) return { summary: 'No complete lap was recorded, so there is no telemetry for this race.', hasReference: false };
            const reference = loadPbTrace(this.track.id);
            savePbTrace(this.track.id, best);
            this.telemetryPair = { best, reference };
        }
        const { best, reference } = this.telemetryPair;
        const facts = debriefFacts(best, reference);
        if (facts) facts.wallHits = this.wallHits;
        return { summary: renderTelemetry(canvasId, best, reference), hasReference: !!reference, facts };
    }

    lapProof() {
        const wet = this.grip < 1;
        const p = this.proof;
        if (!p || !p.length) return { inputs: null, wet };
        const bytes = new Uint8Array(p.length * 6);
        const view = new DataView(bytes.buffer);
        p.forEach((q, i) => {
            view.setInt16(i * 6, q[0], true);
            view.setInt16(i * 6 + 2, q[1], true);
            view.setInt16(i * 6 + 4, q[2], true);
        });
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { inputs: btoa(bin), wet };
    }

    // ── Replay ───────────────────────────────────────────────────────────

    startReplay(fromT) {
        const r = this.rec;
        if (!r || r.t.length < 2) return false;
        const t0 = r.t[0], t1 = r.t[r.t.length - 1];
        this.replay = {
            t: Number.isFinite(fromT) ? Math.max(t0, Math.min(t1, fromT)) : t0,
            t0, t1, playing: true, speed: 1, camera: 'chase', pushedAt: 0, endAt: null,
        };
        this.scene.setRacingLine?.(false);
        this.photo.state = 'done';
        this.timeScale = 1;
        audio.silenceRace();
        music.setState({ phase: 'off' });
        this.scene.fx.slow = 0;
        this.scene.fx.rumble = 0;
        this.pushReplayState(true);
        return true;
    }

    stopReplay() {
        this.replay = null;
        for (const car of this.cars) if (car.mesh) car.mesh.group.visible = !car.isLocal;
        this.scene.setRacingLine?.(!!this.settings.racingLine);
    }

    replayCommand(cmd, value) {
        const rp = this.replay;
        if (!rp) return;
        if (cmd === 'toggle') {
            if (!rp.playing && rp.t >= rp.t1) rp.t = rp.t0;
            rp.playing = !rp.playing;
        } else if (cmd === 'seek') {
            rp.t = rp.t0 + Math.min(1, Math.max(0, Number(value) || 0)) * (rp.t1 - rp.t0);
        } else if (cmd === 'speed') {
            rp.speed = [0.5, 1, 2].includes(Number(value)) ? Number(value) : 1;
        } else if (cmd === 'camera') {
            rp.camera = ['chase', 'far', 'tv'].includes(value) ? value : 'chase';
        }
        this.pushReplayState(true);
    }

    updateReplay(dt, now) {
        const rp = this.replay, r = this.rec;
        if (rp.playing) {
            rp.t += dt * rp.speed;
            if (rp.endAt !== null && rp.t >= rp.endAt) { rp.t = rp.endAt; rp.playing = false; rp.onEnd?.(); }
            if (rp.t >= rp.t1) { rp.t = rp.t1; rp.playing = false; rp.onEnd?.(); }
        }
        const fi = (rp.t - r.t[0]) / TICK;
        const i0 = Math.max(0, Math.min(r.poses.length - 1, Math.floor(fi)));
        const i1 = Math.min(r.poses.length - 1, i0 + 1);
        const f = Math.min(1, Math.max(0, fi - i0));
        let focus = null;
        this.cars.forEach((car, k) => {
            const a = r.poses[i0], b = r.poses[i1], o = k * 5;
            const x = a[o] + (b[o] - a[o]) * f;
            const y = a[o + 1] + (b[o + 1] - a[o + 1]) * f;
            const heading = a[o + 2] + wrapAngle(b[o + 2] - a[o + 2]) * f;
            const speed = a[o + 3];
            car.render.x = x; car.render.y = y; car.render.heading = heading; car.render.speed = speed;
            car.render.along = a[o + 4] + wrapHalf(b[o + 4] - a[o + 4], this.track.length) * f;
            this.place(car.render);
            car.mesh?.update({ x, y, heading, speedKmh: speed * ph.KMH_PER_UNIT, h: car.render.h, pitch: car.render.pitch, roll: car.render.roll });
            if (car.mesh) car.mesh.group.visible = true;
            if (car.isLocal) focus = car;
        });
        this.cull();
        focus = focus || this.cars[0];
        this.scene.setView({ ...focus.render, mode: rp.camera, dt });
        if (focus.mesh) focus.mesh.group.visible = true;
        // The replay gets the same smoke, sparks and speed blur; its skid marks are already down.
        const fx = this.scene.fx;
        fx.speed = rp.camera === 'tv' ? 0 : Math.min(1, Math.abs(focus.render.speed) / ph.MAX_SPEED);
        fx.focus = null;
        this.fx?.update(rp.playing ? dt * rp.speed : 0, this.fxCars(), { skids: false });
        this.reflections?.update(now / 1000, this.cars.map(c => c.mesh));
        this.pushReplayState(false, now);
    }

    pushReplayState(force, now) {
        const rp = this.replay;
        if (!rp) return;
        const t = now ?? performance.now();
        if (!force && t - rp.pushedAt < 250) return;
        rp.pushedAt = t;
        try {
            this.dotnet.invokeMethodAsync('OnReplayStateAsync', rp.t - rp.t0, rp.t1 - rp.t0, rp.playing, rp.camera, rp.speed);
        } catch { /* disposed */ }
    }

    /**
     * Record the local car's best lap (chase cam, real time) to a video file via
     * MediaRecorder on the canvas stream, then share it or download it.
     * Resolves 'shared' | 'downloaded' | 'unavailable'.
     */
    async recordClip() {
        const canvas = this.scene.canvas;
        if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return 'unavailable';
        const lap = [...(this.rec?.laps || [])].sort((a, b) => a.time - b.time)[0];
        const from = lap ? lap.startT : this.rec?.t[0];
        const to = lap ? lap.endT : this.rec?.t[this.rec.t.length - 1];
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'unavailable';

        const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
            .find(m => MediaRecorder.isTypeSupported?.(m)) || '';
        let recorder;
        const chunks = [];
        try {
            recorder = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
        } catch {
            return 'unavailable';
        }
        recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise(resolve => { recorder.onstop = resolve; });

        if (!this.replay) this.startReplay(from);
        const rp = this.replay;
        rp.t = from; rp.speed = 1; rp.playing = true; rp.endAt = to;
        if (rp.camera !== 'far') rp.camera = 'chase';
        rp.onEnd = () => { rp.onEnd = null; rp.endAt = null; try { recorder.stop(); } catch { /* already stopped */ } };
        recorder.start(250);
        this.pushReplayState(true);
        await stopped;

        const type = recorder.mimeType || mime || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) return 'unavailable';
        const file = new File([blob], `pocabinet-${this.track.id}-lap.${ext}`, { type });
        try {
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Cabinet — my best lap' });
                return 'shared';
            }
        } catch (e) {
            if (e && e.name === 'AbortError') return 'shared';
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        return 'downloaded';
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.scene.offFrame?.(this.frameCb);
        this.input.detach();
        for (const car of this.cars) if (car.mesh) unmountCar(car.mesh);
        this.crowd?.dispose();
        this.fx?.dispose();
        this.reflections?.dispose();
        audio.silenceRace();
        music.setState({ phase: 'off' });
        const fx = this.scene.fx;
        if (fx) { fx.speed = 0; fx.rumble = 0; fx.slow = 0; fx.shake = 0; fx.focus = null; }
        this.scene.setStartLights?.(0, false);
        if (this.scene.scenery) this.scene.scenery.onFlash = null;
    }
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function round3(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }
function fraction(v) { const f = v % 1; return f < 0 ? f + 1 : f; }
/** A difference of two loop positions, taken the short way round a loop of length L. */
function wrapHalf(d, L) { return d > L / 2 ? d - L : d < -L / 2 ? d + L : d; }
