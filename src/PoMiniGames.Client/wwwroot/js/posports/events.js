// events.js — the field events: long jump, javelin, 4x100 relay.
//
// Solo events beside the ranked meet. They reuse the meet's stride model for the
// run-up (type the four keys in order to build speed), its renderer and sprites,
// and add one decision each on the fifth key:
//   long jump  press it as close to the board as you dare — past it is a foul
//   javelin    press it at the line while the angle gauge sweeps; 45 degrees flies furthest
//   relay      press it inside each exchange zone to pass the baton cleanly
//
// Results are local bests (records.js), not leaderboard rows: there is no server
// model of these, so nothing here could be verified the way a meet time is.
import { CONSTANTS, createLane, resetLane, applyImpulse, tickLane } from './physics.js';
import { SequenceTracker, attachKeyboard, setLayout, keyLabel, pollGamepads } from './input.js';
import { AiTypist, makeRng } from './ai.js';
import { TrackRenderer } from './track.js';
import * as sprites from './sprites.js';
import { TouchPad, isTouchDevice } from './touch.js';
import * as records from './records.js';
import { Fx, CrowdBed, say, hush } from './fx.js';

function cue(name, opts) {
    try { window.PoCue?.fire('posports', name, opts); } catch { /* feedback is never fatal */ }
}

const FIXED_DT = CONSTANTS.TICK;
const ATTEMPTS = 3;
const RUNWAY = 40;            // long jump: metres to the take-off board
const THROW_LINE = 30;        // javelin: metres to the foul line
const RELAY_LEG = 100;
const RELAY_ZONE = 12;        // metres before each changeover in which a pass is clean
const ANIMS = ['idle', 'walk', 'run', 'jump', 'punch', 'kick', 'dance'];

/**
 * What the CPU field puts up, by difficulty: [mean, spread]. Tuned against what the
 * run-up allows: the meet's own medium typist (10 keys a second) reaches ~11.5 m/s
 * by the board, which is a ~5.8 m jump or a ~63 m throw at 45 degrees.
 */
const RIVALS = {
  longjump: { easy: [4.9, 0.4], medium: [5.7, 0.4], hard: [6.5, 0.4] },
  javelin: { easy: [50, 5], medium: [58, 5], hard: [66, 5] },
};

const TITLES = { longjump: 'Long Jump', javelin: 'Javelin', relay: '4 x 100m Relay' };

export class FieldGame {
  /**
   * @param {HTMLElement} container
   * @param {any} dotnetRef Blazor reference (OnPhase, OnEventDone)
   * @param {{event: 'longjump'|'javelin'|'relay', players: Array<{character: string, name: string, human: boolean}>,
   *          difficulty?: string, keymaps?: object, night?: boolean, roster?: string[]}} options
   */
  constructor(container, dotnetRef, options) {
    this.container = container;
    this.dotnet = dotnetRef;
    this.options = options;
    this.event = options.event;
    this.relay = this.event === 'relay';
    this.difficulty = options.difficulty ?? 'medium';
    this.rng = makeRng((Math.random() * 2 ** 31) | 0);
    if (options.keymaps?.[1]) setLayout(1, options.keymaps[1]);

    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const hour = new Date().getHours();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ps-canvas';
    container.appendChild(this.canvas);
    this.renderer = new TrackRenderer(this.canvas, { night: options.night ?? (hour >= 19 || hour < 6) });
    this.fx = new Fx();
    this.crowd = new CrowdBed();

    const me = (options.players ?? [])[0] ?? { character: 'kim', name: 'Player' };
    this.name = me.name;
    this.character = me.character;
    // Relay teams run the roster in order, each team starting from a different member.
    this.roster = options.roster?.length ? options.roster : [me.character];
    this.state = createLane();
    this.tracker = new SequenceTracker(1, {
      onImpulse: () => { if (this.phase === 'runup') { applyImpulse(this.state); this.dust(this.state.position, 0); cue('stride', { pitch: 0.9 + this.state.speed / 55 }); } },
      onJump: () => this.onAction(),
      onKey: (kind, step, result) => { if (kind === 'seq' && this.phase === 'runup') cue(result === 'reset' ? 'kick' : 'bounce', { gain: 0.45, pitch: result === 'reset' ? 0.55 : [0.84, 0.94, 1.06, 1.26][step] }); },
    });

    this.phase = 'loading';
    this.disposed = false;
    this._raf = 0;
    this.reset();
  }

  reset() {
    this.attempt = 0;
    this.marks = [];            // this player's attempts (metres; -1 = foul)
    this.msg = '';
    this.flight = null;
    this.clock = 0;
    this.time = 0;
    this.angleT = 0;
    this.legIndex = 0;
    this.passNote = null;
    if (this.relay) {
      // Three CPU teams: one lane state and one typist each, on the same stride model.
      this.teams = [0, 1, 2, 3].map((i) => ({
        state: createLane(), human: i === 0, leg: 0, finishedAt: -1, animTime: 0, anim: 'idle',
        ai: i === 0 ? null : new AiTypist(this.difficulty, (this.rng() * 2 ** 31) | 0),
        tracker: null, name: i === 0 ? this.name : `Team ${['Red', 'Blue', 'Green'][i - 1]}`,
      }));
      this.teams[0].state = this.state;
      for (const t of this.teams) {
        if (!t.ai) continue;
        t.tracker = new SequenceTracker(1, { onImpulse: () => applyImpulse(t.state) });
      }
    }
    resetLane(this.state);
    this.tracker.reset();
    this.renderer.cameraX = -6;
    this.fx.clear();
  }

  async start() {
    this.setPhase('loading');
    await Promise.all([...new Set(this.relay ? this.roster : [this.character])].map((c) => sprites.loadCharacter(c, ANIMS)));
    if (this.disposed) return;
    this._detachKeys = attachKeyboard([this.tracker]);
    if (isTouchDevice()) this._touchPad = new TouchPad(this.container, 1);
    this.begin();

    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      if (this.disposed) return;
      const real = Math.min((now - last) / 1000, 0.25);
      last = now;
      pollGamepads();
      acc += real;
      while (acc >= FIXED_DT) { this.tick(FIXED_DT); acc -= FIXED_DT; }
      this.fx.update(real);
      this.render(now);
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    this._detachKeys?.();
    this._touchPad?.dispose();
    this.renderer.dispose();
    this.crowd.dispose();
    hush();
    this.canvas.remove();
    sprites.unloadAll();
  }

  /** Same name as SportsGame's, so the page's "Again" button works for either. */
  restartMeet() {
    this.reset();
    this.begin();
  }

  setPhase(phase) {
    this.phase = phase;
    try { this.dotnet?.invokeMethodAsync('OnPhase', phase === 'done' ? 'podium' : 'racing', this.event); } catch { /* page gone */ }
  }

  /** Start an attempt (or the relay): a short "ready" beat, then the run-up is live. */
  begin() {
    resetLane(this.state);
    this.tracker.reset();
    this.flight = null;
    this.animTime = 0;
    this.clock = 1.4;
    this.renderer.cameraX = -6;
    this.msg = this.relay ? 'Take your marks' : `Attempt ${this.attempt + 1} of ${ATTEMPTS}`;
    this.setPhase('ready');
    if (this.attempt === 0) say(TITLES[this.event]);
  }

  // ── The fifth key ─────────────────────────────────────────────────────

  onAction() {
    if (this.phase !== 'runup') return;
    const s = this.state;
    if (this.relay) { this.pass(); return; }
    const v = s.speed / CONSTANTS.MAX_SPEED;
    if (this.event === 'longjump') {
      const air = 1.0 + v * 8.0;
      this.launch({ from: s.position, travel: air, mark: s.position + air - RUNWAY, duration: 0.85, height: 0.5 });
      cue('bounce', { pitch: 1.2 });
    } else {
      // 45 degrees flies furthest; the gauge sweeps 15..75 so both edges cost distance.
      const range = v * 105 * Math.sin(2 * this.angle());
      this.launch({ from: s.position, travel: range, mark: s.position + range - THROW_LINE, duration: 1.7, height: Math.sin(this.angle()), angle: this.angle() });
      cue('kick', { pitch: 1.4, gain: 1.2 });
    }
  }

  /** The javelin's angle gauge: a slow sweep the player has to read on the run. */
  angle() {
    const t = (Math.sin(this.angleT * 2.4) + 1) / 2;
    return (15 + t * 60) * Math.PI / 180;
  }

  launch(flight) {
    this.flight = { ...flight, t: 0 };
    this.state.speed = this.event === 'javelin' ? this.state.speed * 0.3 : 0;
    this.animTime = 0;
    this.setPhase('flight');
  }

  /** Relay: the baton changes hands. Inside the zone it keeps the runner's speed. */
  pass() {
    const t = this.teams[0];
    const into = this.state.position - t.leg * RELAY_LEG;
    if (t.leg >= 3 || into < RELAY_LEG - RELAY_ZONE) return; // not in a zone: nothing to pass to
    this.handover(t, 0.92, 'Clean pass');
    cue('bounce', { pitch: 1.5 });
  }

  handover(team, keep, note) {
    team.leg++;
    team.state.speed *= keep;
    team.animTime = 0;
    if (team.human) this.passNote = { text: note, until: performance.now() + 1100, good: keep > 0.5 };
  }

  // ── Simulation ────────────────────────────────────────────────────────

  tick(dt) {
    this.time += dt;
    this.animTime += dt;
    this.angleT += dt;
    switch (this.phase) {
      case 'ready':
        this.clock -= dt;
        if (this.clock <= 0) { this.msg = ''; this.setPhase('runup'); cue('whistle'); }
        return;
      case 'runup':
        if (this.relay) this.tickRelay(dt); else this.tickRunup(dt);
        return;
      case 'flight': {
        const f = this.flight;
        f.t += dt;
        if (f.t >= f.duration) this.land();
        return;
      }
      case 'landed':
        this.clock -= dt;
        if (this.clock <= 0) {
          this.attempt++;
          if (this.attempt >= ATTEMPTS) this.finish(); else this.begin();
        }
        return;
      default:
    }
  }

  tickRunup(dt) {
    const s = this.state;
    const line = this.event === 'longjump' ? RUNWAY : THROW_LINE;
    tickLane(s, dt, [], 9999);
    this.renderer.updateCamera(dt, [s], line + 30);
    this.crowd.set(Math.min(1, s.position / line) * 0.7);
    if (s.position > line + 0.4) this.foul(this.event === 'longjump' ? 'Ran through the board' : 'Over the line');
  }

  tickRelay(dt) {
    for (const t of this.teams) {
      if (t.finishedAt >= 0) continue;
      const s = t.state;
      if (t.ai) {
        t.ai.update(dt, { position: s.position, airborne: 0, seqProgress: t.tracker.progress, onHurdlesLeg: false },
          { seqStep: (step) => t.tracker.injectKey(t.tracker.map.sequence[step]), jump: () => { } });
      }
      tickLane(s, dt, [], RELAY_LEG * 4);
      t.animTime += dt;
      // The changeover line: a CPU team passes cleanly most of the time; a human who
      // never pressed the key fumbles it there.
      if (t.leg < 3 && s.position >= (t.leg + 1) * RELAY_LEG) {
        if (t.human) { this.handover(t, 0.25, 'Fumbled!'); s.legTime += 0.6; cue('kick', { pitch: 0.5 }); }
        else this.handover(t, this.rng() < 0.8 ? 0.92 : 0.4, '');
      }
      if (s.finished) t.finishedAt = s.legTime;
    }
    this.clock = this.state.legTime;
    this.renderer.updateCamera(dt, this.teams.map((t) => t.state), RELAY_LEG * 4);
    const lead = Math.max(...this.teams.map((t) => t.state.position));
    this.crowd.set(lead / (RELAY_LEG * 4));
    if (this.teams.every((t) => t.finishedAt >= 0)) this.finish();
  }

  foul(reason) {
    this.marks.push(-1);
    this.msg = `FOUL — ${reason}`;
    this.state.speed = 0;
    cue('whistle', { pitch: 0.5 });
    this.clock = 1.8;
    this.setPhase('landed');
  }

  land() {
    const f = this.flight;
    const mark = Math.max(0, f.mark);
    this.marks.push(mark);
    const best = Math.max(...this.marks);
    this.msg = `${mark.toFixed(2)} m${mark >= best && this.marks.length > 1 ? ' — best so far' : ''}`;
    const y = this.groundY();
    this.fx.burst(f.from + f.travel, y - 4, this.event === 'longjump' ? 18 : 6, this.event === 'longjump' ? '227,201,138' : '200,200,200', 80);
    cue(this.event === 'longjump' ? 'stride' : 'kick', { gain: 1.3 });
    this.crowd.swell();
    this.clock = 2;
    this.setPhase('landed');
  }

  finish() {
    let value, lowerIsBetter = false, board;
    if (this.relay) {
      lowerIsBetter = true;
      value = this.teams[0].finishedAt;
      board = this.teams.map((t) => ({ name: t.name, value: t.finishedAt, human: t.human }));
    } else {
      value = Math.max(0, ...this.marks);
      const [mean, spread] = RIVALS[this.event][this.difficulty] ?? RIVALS[this.event].medium;
      board = [{ name: this.name, value, human: true }];
      for (const n of ['Matt', 'Nick', 'Tong', 'Kim'].filter((x) => x !== this.name).slice(0, 3)) {
        // Best of three draws around the difficulty's mean (sum of uniforms ~ a bell).
        let best = 0;
        for (let i = 0; i < ATTEMPTS; i++) best = Math.max(best, mean + (this.rng() + this.rng() + this.rng() - 1.5) * spread);
        board.push({ name: n, value: best, human: false });
      }
    }
    board.sort((a, b) => (lowerIsBetter ? a.value - b.value : b.value - a.value));
    const placing = board.findIndex((b) => b.human) + 1;
    const fouledOut = !this.relay && value <= 0;
    const rec = fouledOut ? { record: false, prev: records.all().events?.[this.event] ?? 0 } : records.recordEvent(this.event, value, lowerIsBetter);
    this.placing = placing;
    this.board = board;
    this.msg = '';
    this.animTime = 0;
    cue('crowdCheer');
    if (placing === 1) cue('goal');
    say(placing === 1 ? `${this.name} wins the ${TITLES[this.event]}` : `${board[0].name} wins the ${TITLES[this.event]}`);
    this.setPhase('done');
    try {
      this.dotnet?.invokeMethodAsync('OnEventDone', {
        event: this.event, title: TITLES[this.event], value, unit: this.relay ? 's' : 'm', placing,
        record: rec.record, prev: rec.prev, attempts: this.marks, board,
      });
    } catch { /* page gone */ }
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /** Where a lone athlete's feet are: mid-track, rather than the single lane's bottom edge. */
  groundY() {
    return this.renderer.viewH * 0.76;
  }

  dust(meters, lane) {
    this.fx.dust(meters, this.relay ? this.renderer.laneY(lane, 4) : this.groundY(), 3);
  }

  render(now) {
    const r = this.renderer;
    const { ctx } = r;
    const lanes = this.relay ? 4 : 1;
    const length = this.relay ? RELAY_LEG * 4 : (this.event === 'longjump' ? RUNWAY + 10 : THROW_LINE + 95);
    r.drawScene('sprint', lanes, {
      legLength: length, hurdles: [], tape: this.relay ? { broken: this.teams[0].finishedAt >= 0, age: 9 } : null,
      pit: this.event === 'longjump' ? { from: RUNWAY + 0.6, to: RUNWAY + 9.6 } : undefined,
      waveX: this.phase === 'runup' ? r.toX(this.state.position) : undefined,
    });
    const h = r.viewH;
    // The line that matters: the board, the throw line, or the exchange zones.
    if (this.relay) {
      ctx.fillStyle = 'rgba(255,209,102,0.22)';
      for (let k = 1; k <= 3; k++) {
        const x0 = r.toX(k * RELAY_LEG - RELAY_ZONE), x1 = r.toX(k * RELAY_LEG);
        ctx.fillRect(x0, h * 0.262, x1 - x0, h * 0.678);
      }
    } else {
      const x = r.toX(this.event === 'longjump' ? RUNWAY : THROW_LINE);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 3, h * 0.262, 6, h * 0.678);
      ctx.fillStyle = '#d7263d';
      ctx.fillRect(x + 3, h * 0.262, 4, h * 0.678); // the plasticine: touch it and it is a foul
    }
    this.fx.draw(ctx, (m) => r.toX(m), true);

    if (this.relay) this.drawRelay(now); else this.drawAthlete(now);

    r.drawLighting();
    r.screenSpace();
    this.fx.draw(ctx, null, false);
    this.drawHud(now);
  }

  drawAthlete(now) {
    const r = this.renderer;
    const { ctx } = r;
    const s = this.state;
    const y = this.groundY();
    const hh = r.viewH * 0.36;
    let x = r.toX(s.position), lift = 0, anim = s.speed > 3 ? 'run' : s.speed > 0.3 ? 'walk' : 'idle';
    const f = this.flight;
    if (f && this.event === 'longjump') {
      const k = Math.min(1, f.t / f.duration);
      x = r.toX(f.from + f.travel * k);
      lift = Math.sin(k * Math.PI) * hh * f.height;
      anim = k < 1 ? 'jump' : 'idle';
      r.updateCamera(FIXED_DT, [{ position: f.from + f.travel * k }], RUNWAY + 30);
    } else if (f) {
      anim = f.t < 0.5 ? 'punch' : 'idle';
      // The javelin: a shaft along its own tangent, on a parabola to the mark.
      const k = Math.min(1, f.t / f.duration);
      const jx = f.from + f.travel * k;
      const arc = Math.sin(k * Math.PI) * hh * 1.5 * f.height;
      const tilt = Math.atan2(Math.cos(k * Math.PI) * f.height * 1.5, 1.6);
      r.updateCamera(FIXED_DT, [{ position: jx }], THROW_LINE + 110);
      ctx.save();
      ctx.translate(r.toX(jx), y - hh * 0.6 - arc);
      ctx.rotate(-tilt);
      ctx.strokeStyle = '#f1f1f1';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-26, 0); ctx.lineTo(26, 0); ctx.stroke();
      ctx.restore();
    }
    if (this.phase === 'done') anim = this.placing === 1 ? 'dance' : 'idle';
    r.drawShadow(x, y, hh, lift);
    if (s.speed > 13 && this.phase === 'runup') r.drawSpeedLines(x, y, hh, Math.min(1, (s.speed - 13) / 6), now / 1000);
    sprites.draw(ctx, this.character, anim, this.animTime, x, y - lift, hh, { loop: anim !== 'jump' && anim !== 'punch' });

    // The angle gauge rides above the thrower through the run-up.
    if (this.event === 'javelin' && this.phase === 'runup') {
      const a = this.angle();
      const gx = x + hh * 0.2, gy = y - hh * 1.02, len = hh * 0.42;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(gx, gy, len, -75 * Math.PI / 180, -15 * Math.PI / 180); ctx.stroke();
      const sweet = Math.abs(a - Math.PI / 4) < 0.14;
      ctx.strokeStyle = sweet ? '#7dff9b' : '#ffd166';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + Math.cos(a) * len, gy - Math.sin(a) * len); ctx.stroke();
    }
    if (!isTouchDevice() && (this.phase === 'runup' || this.phase === 'ready')) {
      const cx = Math.max(r.viewW * 0.14, Math.min(r.viewW * 0.86, x));
      r.drawKeycaps(cx, y - hh * (this.event === 'javelin' ? 1.5 : 1.04), this.tracker.map.sequence.map(keyLabel),
        this.tracker.progress, keyLabel(this.tracker.map.jump));
    } else {
      this._touchPad?.setNext(this.phase === 'runup' ? this.tracker.progress : -1);
    }
  }

  drawRelay(now) {
    const r = this.renderer;
    const { ctx } = r;
    this.teams.forEach((t, i) => {
      const s = t.state;
      const y = r.laneY(i, 4);
      const hh = r.spriteHeight(i, 4);
      const x = r.toX(s.position);
      const runner = this.roster[(i + t.leg) % this.roster.length];
      const anim = this.phase === 'done' ? (i === 0 && this.placing === 1 ? 'dance' : 'idle')
        : s.finished ? 'idle' : s.speed > 3 ? 'run' : s.speed > 0.3 ? 'walk' : 'idle';
      if (anim !== t.anim) { t.anim = anim; t.animTime = 0; }
      r.drawShadow(x, y, hh, 0);
      if (s.speed > 13 && !s.finished) r.drawSpeedLines(x, y, hh, Math.min(1, (s.speed - 13) / 6), now / 1000);
      sprites.draw(ctx, runner, anim, t.animTime, x, y, hh, { loop: true });
      // The baton.
      ctx.fillStyle = i === 0 ? '#ffd166' : '#e9ecef';
      ctx.fillRect(x + hh * 0.08, y - hh * 0.5, hh * 0.12, 4);
    });
    const me = this.teams[0];
    if (!isTouchDevice() && this.phase !== 'done' && !me.state.finished) {
      const hh = r.spriteHeight(0, 4);
      const cx = Math.max(r.viewW * 0.14, Math.min(r.viewW * 0.86, r.toX(me.state.position)));
      r.drawKeycaps(cx, r.laneY(0, 4) - hh * 1.02, this.tracker.map.sequence.map(keyLabel), this.tracker.progress, keyLabel(this.tracker.map.jump));
    } else {
      this._touchPad?.setNext(this.phase === 'runup' ? this.tracker.progress : -1);
    }
  }

  drawHud(now) {
    const { ctx } = this.renderer;
    const w = this.renderer.viewW; const h = this.renderer.viewH;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(10,14,24,0.6)';
    ctx.fillRect(0, 0, w, h * 0.075);
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${h * 0.036}px system-ui, sans-serif`;
    const best = Math.max(0, ...this.marks);
    const line = this.relay
      ? `${TITLES.relay}   ·   leg ${Math.min(4, this.teams[0].leg + 1)} of 4   ·   ${this.clock.toFixed(1)}s`
      : `${TITLES[this.event]}   ·   attempt ${Math.min(ATTEMPTS, this.attempt + 1)}/${ATTEMPTS}   ·   best ${best > 0 ? best.toFixed(2) + ' m' : '—'}`;
    ctx.fillText(line, w / 2, h * 0.052);
    if (this.msg) {
      ctx.fillStyle = 'rgba(10,14,24,0.72)';
      ctx.fillRect(0, h * 0.42, w, h * 0.16);
      ctx.fillStyle = this.msg.startsWith('FOUL') ? '#ff6b6b' : '#ffd166';
      ctx.font = `800 ${h * 0.07}px system-ui, sans-serif`;
      ctx.fillText(this.msg, w / 2, h * 0.525);
    }
    if (this.passNote) {
      if (now > this.passNote.until) this.passNote = null;
      else {
        ctx.fillStyle = this.passNote.good ? '#7dff9b' : '#ff6b6b';
        ctx.font = `800 ${h * 0.06}px system-ui, sans-serif`;
        ctx.fillText(this.passNote.text, w / 2, h * 0.2);
      }
    }
  }
}
