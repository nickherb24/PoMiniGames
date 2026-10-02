// audio.js — synthesized SFX for PoVoxelStrike.
// No audio files: everything is OscillatorNode + filtered noise, following the
// pobrawl/audio.js recipe. All output rides the platform's shared AudioContext and
// mix graph (js/audioBus.js) through window.PoAudioBus on the 'sfx' bus, so global
// mute/volume/ducking apply for free.
//
// There is no music in here: a drone would play UNDER the platform soundtrack, which
// every game page already has. The siege steers that soundtrack instead, through
// PoMusicDirector.tension (see setTension).
//
// Every public method is throttle-guarded and mute-safe, so the engine can call them
// from hot paths (collapse spawns, debris collide events) without its own bookkeeping.
//
// Two layers of spatial sound:
//   * True 3D positional audio. Every cue takes a world position (or a stereo pan scalar
//     on the low tier) and routes through an HRTF PannerNode, so a brute behind you is
//     behind you and a tower collapsing overhead is overhead. setListener() feeds the
//     camera transform to the AudioContext listener once per frame.
//   * Convolution reverb zones. Two procedurally-generated impulse responses (open field,
//     stone interior) run in parallel on a send from the SFX bus; setSpace() crossfades
//     between them, so stepping through a castle gate audibly changes the room.
// Both are tier-gated by quality.js -- a low-end machine keeps the stereo path, which
// is why _pan() still accepts a plain number.

const NOISE_SECONDS = 2;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.18 * white) / 1.18; // low-passed: "rubble", not hiss
    data[i] = last;
  }
  return buf;
}

/**
 * Procedural impulse response: exponentially-decaying noise run through a one-pole
 * lowpass whose coefficient sets how dark the tail is. Cheap, deterministic in shape, and
 * no IR file to ship - which matters because this game deliberately loads no audio
 * assets at all. `decay` is seconds, `curve` how fast the tail falls, `dark` is 0..1 tone.
 */
function makeImpulse(ctx, decay, curve, dark) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const a = Math.max(0.001, 1 - dark); // one-pole coefficient: smaller = darker
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      last = last * (1 - a) + (Math.random() * 2 - 1) * a;
      d[i] = last * Math.pow(1 - t, curve);
    }
  }
  return buf;
}

// Release the node chain once the source ends — a long firefight otherwise piles up
// hundreds of live nodes on the audio thread (same leak pobrawl fixed).
function autoDisconnect(source, nodes) {
  source.onended = () => {
    for (const n of nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  };
}

export class VoxelAudio {
  constructor() {
    this.ctx = null;
    this._failed = false;
    this.master = null;
    this.sfx = null;
    this.filter = null;   // concussion lowpass, in-line on the whole SFX path
    this.noise = null;
    this._paused = false;
    this.spatial = true;      // cleared by setQuality() on the low tier
    this.reverbZones = true;
    this._space = 0;          // 0 = open field, 1 = stone interior
    // Where the SFX lowpass rests: wide open, or pulled in while the player is nearly dead.
    this._openCorner = 20000;
    this.rain = null;         // { src, gain, tone } once setRain() has built the bed
    // Per-category throttles (seconds of ctx.currentTime).
    this._next = { collapse: 0, impact: 0, cue: 0, crush: 0, turret: 0, whiz: 0, step: 0 };
  }

  _ensure() {
    if (this.ctx) return !this._failed;
    if (this._failed) return false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { this._failed = true; return false; }
      const bus = window.PoAudioBus;
      const ctx = (bus && bus.contextSync()) || new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master.connect(comp).connect((bus && bus.busSync('sfx')) || ctx.destination);

      // 20 kHz open corner (transparent), swept down by concussion().
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 20000;
      this.filter.Q.value = 0.0001;
      this.filter.connect(this.master);

      this.sfx = ctx.createGain();
      this.sfx.gain.value = 1.0;
      this.sfx.connect(this.filter);

      this.noise = makeNoiseBuffer(ctx);

      // Reverb zones. The platform bus reverb is turned OFF here rather than layered
      // under these: it is one global tail with no notion of where the player is
      // standing, and running both smears each other. This graph owns the space.
      //   sfx --+--------------------------------> filter (dry)
      //         +-- send --+-- convolver(open)  --> wetOpen  --+
      //                    +-- convolver(stone) --> wetStone --+--> filter
      bus?.setReverb?.(0.0);
      if (this.reverbZones && ctx.createConvolver) {
        this.revSend = ctx.createGain();
        this.revSend.gain.value = 1;
        this.sfx.connect(this.revSend);

        this.convOpen = ctx.createConvolver();
        this.convOpen.buffer = makeImpulse(ctx, 0.55, 5.2, 0.35);   // short, bright slap
        this.wetOpen = ctx.createGain();
        this.wetOpen.gain.value = 0.16;
        this.revSend.connect(this.convOpen).connect(this.wetOpen).connect(this.filter);

        this.convStone = ctx.createConvolver();
        this.convStone.buffer = makeImpulse(ctx, 2.3, 1.6, 0.75);   // long, dark stone tail
        this.wetStone = ctx.createGain();
        this.wetStone.gain.value = 0;
        this.revSend.connect(this.convStone).connect(this.wetStone).connect(this.filter);
      }
      return true;
    } catch (e) {
      this._failed = true;
      try { console.error('[povoxelstrike/audio] setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  _muted() {
    const bus = window.PoAudioBus;
    return !!(bus && bus.isMuted && bus.isMuted());
  }

  _ready() { return this._ensure() && !this._muted(); }

  _gate(kind, interval) {
    const now = this.ctx.currentTime;
    if (now < this._next[kind]) return false;
    this._next[kind] = now + interval;
    return true;
  }

  /**
   * Destination node for one cue, already wired into the SFX chain.
   * @param where a world position ({x,y,z}) for HRTF 3D placement, or a -1..1 stereo pan
   *   scalar for the fallback path. A number always gets stereo, so the low tier and any
   *   caller that only knows a pan keep working unchanged.
   */
  _pan(where) {
    if (this.spatial && where && typeof where === 'object' && this.ctx.createPanner) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      // refDistance is deliberately large: the arena is 180 units across, and a realistic
      // 1-unit reference makes everything past the courtyard inaudible.
      p.refDistance = 8;
      p.maxDistance = 220;
      p.rolloffFactor = 0.9;
      if (p.positionX) {
        p.positionX.value = where.x; p.positionY.value = where.y; p.positionZ.value = where.z;
      } else {
        p.setPosition(where.x, where.y, where.z); // Safari < 16
      }
      p.connect(this.sfx);
      return p;
    }
    const pan = typeof where === 'number' ? where : 0;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1) * 0.8; // never hard-panned into one ear
      p.connect(this.sfx);
      return p;
    }
    const g = this.ctx.createGain();
    g.connect(this.sfx);
    return g;
  }

  /** Apply the resolved GFX/SFX tier. Call before the first cue. */
  setQuality(quality) {
    this.spatial = !!quality.spatialAudio;
    this.reverbZones = !!quality.convolutionReverb;
  }

  /**
   * Move the AudioContext listener onto the camera. Call once per frame - a listener left
   * at the origin makes HRTF place every sound relative to the arena centre, which is
   * worse than no HRTF at all.
   */
  setListener(camera) {
    if (!this.spatial || !this._ready()) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const m = camera.matrixWorld.elements;
    const fx = -m[8], fy = -m[9], fz = -m[10];   // -Z column: the camera forward axis
    const ux = m[4], uy = m[5], uz = m[6];
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /**
   * Crossfade the reverb between open field (0) and stone interior (1). Smoothed over
   * 250 ms: an instant swap at a doorway clicks, and the player straddles the threshold
   * for several frames while walking through it.
   */
  setSpace(indoorness) {
    if (!this._ready() || !this.wetOpen) return;
    const t = clamp(indoorness, 0, 1);
    if (Math.abs(t - this._space) < 0.02) return;
    this._space = t;
    const now = this.ctx.currentTime, ramp = now + 0.25;
    for (const g of [this.wetOpen.gain, this.wetStone.gain]) {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
    }
    this.wetOpen.gain.linearRampToValueAtTime(0.16 * (1 - t), ramp);
    this.wetStone.gain.linearRampToValueAtTime(0.42 * t, ramp);
  }

  _noiseSrc(playSeconds) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src._offset = Math.random() * Math.max(0, this.noise.duration - playSeconds - 0.01);
    return src;
  }

  /** One enveloped oscillator into `dest`. Returns nothing; cleans itself up. */
  _tone(dest, { type = 'sine', from, to = null, dur, gain, attack = 0.005, delay = 0 }) {
    const ctx = this.ctx, now = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, now);
    if (to !== null) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + dur * 0.85);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(g).connect(dest);
    o.start(now); o.stop(now + dur + 0.03);
    autoDisconnect(o, [o, g]);
  }

  /** Enveloped filtered-noise burst into `dest`. */
  _burst(dest, { filterType = 'bandpass', freq, sweepTo = null, q = 1, dur, gain, attack = 0.006, delay = 0 }) {
    const ctx = this.ctx, now = ctx.currentTime + delay;
    const src = this._noiseSrc(dur);
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, now);
    if (sweepTo !== null) f.frequency.linearRampToValueAtTime(sweepTo, now + dur * 0.8);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, f, g]);
  }

  // ── Weapon ─────────────────────────────────────────────────────────────

  /** Primary carve shot: short zap + dig click. Fires ~7/s, so it stays tiny. */
  shot() {
    if (!this._ready()) return;
    this._tone(this.sfx, { type: 'square', from: rand(1100, 1500), to: 320, dur: 0.07, gain: 0.035 });
    this._burst(this.sfx, { freq: rand(2600, 3600), q: 1.2, dur: 0.05, gain: 0.03 });
  }

  /** Alt-fire launch: rising whoosh as the blast ball leaves. */
  altLaunch() {
    if (!this._ready()) return;
    this._burst(this.sfx, { freq: 420, sweepTo: 1500, q: 1.4, dur: 0.3, gain: 0.09 });
  }

  /**
   * Alt-fire detonation. WebAudio has no true sidechain, so the bus duck IS the
   * sidechain; its depth now tracks proximity, and a blast across the arena no longer
   * flattens the score as hard as one at your feet.
   */
  explosion(where = 0, proximity = 1) {
    if (!this._ready()) return;
    const dest = this._pan(where);
    this._tone(dest, { from: rand(110, 135), to: 30, dur: 0.75, gain: 0.5, attack: 0.008 });
    this._burst(dest, { filterType: 'lowpass', freq: 950, dur: 0.6, gain: 0.4 });
    this._burst(dest, { filterType: 'highpass', freq: 3000, dur: 0.35, gain: 0.08 });
    const p = clamp(proximity, 0, 1);
    window.PoAudioBus?.duck?.(0.25 + 0.35 * p, 250 + 350 * p);
  }

  /** Weapon overheated: a steam vent while it cools. */
  lockout() {
    if (!this._ready()) return;
    this._burst(this.sfx, { filterType: 'highpass', freq: 1900, dur: 0.7, gain: 0.09, attack: 0.02 });
  }

  // ── The fortress ───────────────────────────────────────────────────────

  /**
   * A wall gun firing. It used to borrow shot() — the player's own zap, unpositioned — so
   * the fortress sounded like you. This is a heavier report, and it comes from the gun.
   */
  turretShot(where) {
    if (!this._ready() || !this._gate('turret', 0.05)) return;
    const dest = this._pan(where);
    this._tone(dest, { type: 'square', from: rand(200, 240), to: 62, dur: 0.14, gain: 0.2 });
    this._burst(dest, { filterType: 'highpass', freq: 1700, dur: 0.08, gain: 0.12 });
  }

  /** A bolt passing close: the falling whistle of a near miss. */
  whiz(where) {
    if (!this._ready() || !this._gate('whiz', 0.12)) return;
    this._burst(this._pan(where), { freq: 2600, sweepTo: 650, q: 2.4, dur: 0.2, gain: 0.16 });
  }

  /** The chalice is taken: a rising triad that lands on an open fifth. */
  fanfare() {
    if (!this._ready()) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this._tone(this.sfx, {
      type: 'triangle', from: f, dur: 0.5, gain: 0.2, attack: 0.012, delay: i * 0.14,
    }));
    for (const f of [523.25, 783.99, 1046.5, 1567.98]) {
      this._tone(this.sfx, { type: 'triangle', from: f, dur: 1.9, gain: 0.13, attack: 0.03, delay: 0.62 });
    }
    this._burst(this.sfx, { filterType: 'highpass', freq: 5200, dur: 1.4, gain: 0.035, attack: 0.2, delay: 0.62 });
  }

  // ── Destruction ────────────────────────────────────────────────────────

  /** The floor dropping out of the mix under a really big fall. */
  subDrop(where, strength = 1) {
    if (!this._ready()) return;
    const s = clamp(strength, 0.2, 1);
    this._tone(this._pan(where), { from: 88, to: 24, dur: 0.9 + 0.5 * s, gain: 0.5 * s, attack: 0.02 });
  }

  /**
   * A cluster detached from a structure. Gain and length scale with voxel count so a
   * cornice tick is a pebble and a tower fall is a landslide. Throttled: a cascade of
   * clusters in one carve merges into one rumble.
   */
  collapse(voxels, pan = 0) {
    if (!this._ready() || !this._gate('collapse', 0.14)) return;
    const s = clamp(voxels / 350, 0.12, 1);
    const dest = this._pan(pan);
    this._burst(dest, {
      filterType: 'lowpass', freq: 260 + 140 * s, dur: 0.4 + 1.0 * s,
      gain: 0.1 + 0.42 * s, attack: 0.02,
    });
    this._tone(dest, { from: 60, to: 32, dur: 0.35 + 0.6 * s, gain: 0.1 + 0.3 * s, attack: 0.015 });
    if (s > 0.35 && window.PoDsp?.playGranular) {
      window.PoDsp.playGranular(1400, Math.round(8 * s), 0.35 * s, 0.25 * s, 'sfx');
    }
    // A tower coming down deserves the room in the mix an explosion gets.
    if (s > 0.55) window.PoAudioBus?.duck?.(0.3 * s, 500 * s);
  }

  /** A debris chunk landed hard. Throttled — a rockslide is not 40 thuds. */
  debrisHit(mass, pan = 0) {
    if (!this._ready() || !this._gate('impact', 0.09)) return;
    // Recalibrated for real masses (physics.js): a chunk that used to report 7 kg now
    // reports 750, so the old /300 saturated on every single impact.
    const s = clamp(mass / 2500, 0.12, 1);
    const dest = this._pan(pan);
    this._tone(dest, { from: rand(80, 105), to: 42, dur: 0.16 + 0.1 * s, gain: 0.1 + 0.2 * s });
    if (s > 0.4 && window.PoDsp?.playGranular) {
      window.PoDsp.playGranular(2200, 4, 0.15, 0.18 * s, 'sfx');
    }
  }

  /** Something got crushed under debris. */
  crush(pan = 0) {
    if (!this._ready() || !this._gate('crush', 0.15)) return;
    const dest = this._pan(pan);
    this._tone(dest, { from: 70, to: 34, dur: 0.3, gain: 0.32 });
    this._burst(dest, { freq: rand(1400, 2000), q: 1.5, dur: 0.09, gain: 0.14 });
  }

  // ── Enemies ────────────────────────────────────────────────────────────

  /** Ambient presence cue, panned/attenuated by the caller. Throttled globally. */
  enemyCue(type, pan = 0, gain = 1) {
    if (!this._ready() || gain < 0.05 || !this._gate('cue', 0.28)) return;
    const dest = this._pan(pan);
    if (type === 'swarmer') {
      // Chitter: three fast detuned blips.
      const base = rand(850, 1250);
      const now = this.ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = base * (1 + i * 0.12) * rand(0.95, 1.05);
        const g = this.ctx.createGain();
        const t0 = now + i * 0.055;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.02 * gain, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
        o.connect(g).connect(dest);
        o.start(t0); o.stop(t0 + 0.07);
        autoDisconnect(o, i === 2 ? [o, g, dest] : [o, g]);
      }
      return;
    }
    if (type === 'brute') {
      this._tone(dest, { from: rand(58, 70), to: 40, dur: 0.28, gain: 0.16 * gain, attack: 0.01 });
      return;
    }
    // Spitter: wet hiss.
    this._burst(dest, { freq: rand(2200, 3000), q: 2.2, dur: 0.22, gain: 0.05 * gain });
  }

  /** Spitter projectile leaving. */
  spit(pan = 0, gain = 1) {
    if (!this._ready()) return;
    this._burst(this._pan(pan), { freq: 1600, sweepTo: 700, q: 3, dur: 0.16, gain: 0.05 * gain });
  }

  enemyDeath(type, pan = 0) {
    if (!this._ready()) return;
    const dest = this._pan(pan);
    if (type === 'brute') {
      this._tone(dest, { from: 90, to: 30, dur: 0.5, gain: 0.3 });
      this._burst(dest, { filterType: 'lowpass', freq: 700, dur: 0.4, gain: 0.2 });
    } else {
      this._tone(dest, { type: 'sawtooth', from: rand(500, 700), to: 90, dur: 0.22, gain: 0.07 });
      this._burst(dest, { freq: rand(1200, 1800), q: 1.3, dur: 0.12, gain: 0.08 });
    }
  }

  // ── Player ─────────────────────────────────────────────────────────────

  playerHit() {
    if (!this._ready()) return;
    this._tone(this.sfx, { from: 130, to: 55, dur: 0.22, gain: 0.28 });
    this._burst(this.sfx, { filterType: 'highpass', freq: 2600, dur: 0.1, gain: 0.05 });
  }

  /** Death: long down-sweep, then the world muffles out. */
  death() {
    if (!this._ready()) return;
    this._tone(this.sfx, { type: 'sawtooth', from: 380, to: 38, dur: 1.3, gain: 0.16, attack: 0.02 });
    this.concussion(1);
  }

  /**
   * "Ears ringing": sweep the SFX lowpass down, hold, recover — plus a music duck.
   * Frequency ramps are exponential; a linear ramp from 20 kHz is inaudible for most
   * of its travel (perception is logarithmic).
   */
  concussion(strength = 1) {
    if (!this._ready() || !this.filter) return;
    const s = clamp(strength, 0, 1);
    const now = this.ctx.currentTime;
    const hold = 0.2 + 0.5 * s;
    const corner = Math.max(300, 20000 - 19500 * s);
    const f = this.filter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(Math.max(300, f.value), now);
    f.exponentialRampToValueAtTime(corner, now + 0.06);
    f.setValueAtTime(corner, now + 0.06 + hold);
    // Back to wherever the corner rests, which is not 20 kHz while the player is nearly dead.
    f.exponentialRampToValueAtTime(this._openCorner, now + 0.06 + hold + 0.6 + 0.5 * s);
    window.PoAudioBus?.duck?.(0.2, (hold + 0.4) * 1000);
  }

  /**
   * Nearly dead: the world goes dull. Pulls the SFX lowpass in and leaves it there until
   * the player heals or dies; heartbeat() supplies the pulse over the top.
   */
  setLowHp(on) {
    const corner = on ? 2400 : 20000;
    if (corner === this._openCorner) return;
    this._openCorner = corner;
    if (!this._ready() || !this.filter) return;
    const f = this.filter.frequency, now = this.ctx.currentTime;
    f.cancelScheduledValues(now);
    f.setValueAtTime(Math.max(300, f.value), now);
    f.exponentialRampToValueAtTime(corner, now + 0.5);
  }

  /** One lub-dub. Straight to the master: it is inside your head, not in the room. */
  heartbeat() {
    if (!this._ready() || !this.master) return;
    this._tone(this.master, { from: 64, to: 40, dur: 0.14, gain: 0.3 });
    this._tone(this.master, { from: 56, to: 36, dur: 0.16, gain: 0.2, delay: 0.17 });
  }

  /** A footfall. `surface` is 'grass' (turf and dug earth) or 'stone' (masonry and rubble). */
  footstep(surface) {
    if (!this._ready() || !this._gate('step', 0.16)) return;
    if (surface === 'stone') {
      this._burst(this.sfx, { freq: rand(1700, 2300), q: 2, dur: 0.05, gain: 0.05 });
      this._tone(this.sfx, { from: rand(140, 170), to: 90, dur: 0.05, gain: 0.035 });
    } else {
      this._burst(this.sfx, { filterType: 'lowpass', freq: rand(560, 760), dur: 0.08, gain: 0.06 });
    }
  }

  // ── Weather ────────────────────────────────────────────────────────────

  /**
   * The rain bed: one looping noise source, started on first use. `level` 0 stops it being
   * heard; `indoors` (0..1) is the same roof probe the reverb uses, and closes the tone
   * down so a vault sounds like rain on the roof rather than rain on your head.
   */
  setRain(level, indoors) {
    if (!this.rain && (level <= 0 || !this._ready())) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (!this.rain) {
      // White, not the low-passed rubble buffer the impacts use: rain is all hiss.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(tone).connect(gain).connect(this.filter);
      src.start();
      this.rain = { src, tone, gain };
    }
    const quiet = this._paused || this._muted() ? 0 : level;
    this.rain.gain.gain.setTargetAtTime(0.05 * quiet * (1 - 0.55 * indoors), now, 0.4);
    this.rain.tone.frequency.setTargetAtTime(5200 - 4500 * indoors, now, 0.4);
  }

  /** Thunder, `delay` seconds after the flash — light is faster than sound. */
  thunder(delay = 0.8) {
    if (!this._ready()) return;
    // 1.9 s, not longer: the shared noise buffer is 2 s and a one-shot cannot outlast it.
    this._burst(this.sfx, { filterType: 'lowpass', freq: 190, dur: 1.9, gain: 0.5, attack: 0.06, delay });
    this._tone(this.sfx, { from: 58, to: 27, dur: 2.0, gain: 0.26, attack: 0.05, delay });
    this._burst(this.sfx, { filterType: 'highpass', freq: 2400, dur: 0.25, gain: 0.06, delay });
  }

  // ── Music ──────────────────────────────────────────────────────────────

  /**
   * 0 = an empty field, 1 = in the vault under every gun. The platform soundtrack's own
   * layer mixer does the rest: it thickens and speeds up with tension, and fades back to
   * its resting level when this is released.
   */
  setTension(t) {
    window.PoMusicDirector?.tension?.(this._paused ? 0 : clamp(t, 0, 1));
  }

  setPaused(paused) {
    this._paused = paused;
    if (paused) window.PoMusicDirector?.tension?.(0);
    if (this.rain && this.ctx) this.rain.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  dispose() {
    // Tension belongs to the run: leave it up and the catalog hums at siege pitch.
    window.PoMusicDirector?.tension?.(0);
    if (this.rain) {
      try { this.rain.src.stop(); } catch { /* never started */ }
      for (const n of Object.values(this.rain)) { try { n.disconnect(); } catch { /* */ } }
      this.rain = null;
    }
    // Let one-shot tails ring out through the shared graph, then detach our chain.
    const master = this.master;
    if (master) setTimeout(() => { try { master.disconnect(); } catch { /* */ } }, 1500);
    this.master = null;
    this.sfx = null;
    this.filter = null;
  }
}
