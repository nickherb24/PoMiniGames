// fx.js — the meet's dressing: particles, the stadium announcer, the crowd bed.
// None of it feeds the simulation; a meet with this file missing would time the same.

/**
 * Canvas particles. `world` ones are positioned in track meters (x) and screen px
 * (y), so dust stays where it was kicked up as the camera pans; `screen` ones
 * (confetti, fireworks) ignore the camera.
 */
export class Fx {
  constructor() {
    this.p = [];
  }

  clear() {
    this.p.length = 0;
  }

  /** A stride's puff of track dust behind a runner. */
  dust(meters, y, n = 3, color = '214,170,140') {
    for (let i = 0; i < n; i++) {
      this.p.push({
        world: true, x: meters - 0.2 - Math.random() * 0.3, y: y - 2 - Math.random() * 4,
        vx: -0.6 - Math.random() * 1.2, vy: -12 - Math.random() * 16, g: 26,
        life: 0.35 + Math.random() * 0.25, age: 0, size: 2.5 + Math.random() * 3, color, fade: 0.5,
      });
    }
  }

  /** Splinters / sand thrown up at one spot. */
  burst(meters, y, n, color, speed = 60) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * Math.random();
      this.p.push({
        world: true, x: meters, y, vx: Math.cos(a) * speed / 28 * Math.random(), vy: Math.sin(a) * speed * (0.4 + Math.random()), g: 220,
        life: 0.5 + Math.random() * 0.4, age: 0, size: 2 + Math.random() * 2.5, color, fade: 0.9,
      });
    }
  }

  /** Confetti falling from above the frame. */
  confetti(w, n = 6) {
    const colors = ['255,209,102', '239,71,111', '6,214,160', '17,138,178', '255,255,255'];
    for (let i = 0; i < n; i++) {
      this.p.push({
        world: false, x: Math.random() * w, y: -8, vx: (Math.random() - 0.5) * 60, vy: 60 + Math.random() * 90, g: 40,
        life: 3.2, age: 0, size: 3 + Math.random() * 3, color: colors[(Math.random() * colors.length) | 0], fade: 0.95,
        spin: Math.random() * 6,
      });
    }
  }

  /** One firework shell bursting at (x, y). */
  firework(x, y) {
    const color = ['255,209,102', '239,71,111', '6,214,160', '160,196,255'][(Math.random() * 4) | 0];
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2;
      const s = 90 + Math.random() * 70;
      this.p.push({
        world: false, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g: 70,
        life: 1.1 + Math.random() * 0.4, age: 0, size: 2.4, color, fade: 0.9, glow: true,
      });
    }
  }

  update(dt) {
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i];
      q.age += dt;
      if (q.age >= q.life) { this.p.splice(i, 1); continue; }
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
    if (this.p.length > 600) this.p.splice(0, this.p.length - 600);
  }

  /** @param {(m: number) => number} toX meters → screen x, for the world particles */
  draw(ctx, toX, world) {
    for (const q of this.p) {
      if (q.world !== world) continue;
      const k = 1 - q.age / q.life;
      ctx.fillStyle = `rgba(${q.color},${q.fade * k})`;
      const x = q.world ? toX(q.x) : q.x;
      if (q.spin !== undefined) {
        ctx.save();
        ctx.translate(x, q.y);
        ctx.rotate(q.spin + q.age * 7);
        ctx.fillRect(-q.size, -q.size * 0.4, q.size * 2, q.size * 0.8);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, q.y, q.size * (q.glow ? 0.5 + k : 1.4 - k * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// ── Announcer ─────────────────────────────────────────────────────────────
// The browser's own speech synthesis: no asset, no model call. It is muted with
// the app (it does not run through the audio bus, so it asks the bus instead).

let lastSaid = 0;

export function say(text, { rate = 1.05, pitch = 1, minGapMs = 0 } = {}) {
  try {
    if (!('speechSynthesis' in window) || window.PoAudioBus?.isMuted?.()) return;
    const now = performance.now();
    if (now - lastSaid < minGapMs) return;
    lastSaid = now;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.pitch = pitch;
    u.volume = Math.min(1, 0.9 * (window.PoAudioBus?.getVolume?.() ?? 1));
    window.speechSynthesis.cancel(); // a new call replaces a stale one rather than queueing behind it
    window.speechSynthesis.speak(u);
  } catch { /* speech is decoration */ }
}

export function hush() {
  try { window.speechSynthesis?.cancel(); } catch { /* nothing queued */ }
}

// ── Crowd bed ─────────────────────────────────────────────────────────────

/**
 * A continuous stadium murmur on the app's shared audio graph. The level follows
 * how tight and how far along the race is; a finish swells it. Built lazily: the
 * shared AudioContext only exists after the first user gesture.
 */
export class CrowdBed {
  constructor() {
    this.nodes = null;
  }

  build() {
    const bus = window.PoAudioBus;
    const ctx = bus?.contextSync?.();
    if (!ctx) return false;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown-ish noise: a crowd is mostly low rumble with a breathy top.
    for (let i = 0, acc = 0; i < len; i++) {
      acc = (acc + (Math.random() * 2 - 1) * 0.06) * 0.985;
      d[i] = acc * 3 + (Math.random() * 2 - 1) * 0.08;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // A slow wobble so the murmur breathes instead of sitting flat.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(band.frequency);
    src.connect(band).connect(gain).connect(bus.busSync?.('sfx') || ctx.destination);
    src.start();
    lfo.start();
    this.nodes = { ctx, src, lfo, band, gain };
    return true;
  }

  /** @param {number} level 0..1 */
  set(level) {
    if (!this.nodes && !this.build()) return;
    const { ctx, gain, band } = this.nodes;
    const v = Math.max(0, Math.min(1, level));
    gain.gain.setTargetAtTime(0.018 + v * 0.085, ctx.currentTime, 0.4);
    band.frequency.setTargetAtTime(600 + v * 600, ctx.currentTime, 0.5);
  }

  /** The roar at the line. */
  swell() {
    if (!this.nodes && !this.build()) return;
    const { ctx, gain } = this.nodes;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0.2, t, 0.08);
    gain.gain.setTargetAtTime(0.03, t + 1.6, 0.9);
  }

  /** Stops this module's own sources. The AudioContext is the app's and stays open. */
  dispose() {
    if (!this.nodes) return;
    const { src, lfo, gain } = this.nodes;
    try { src.stop(); lfo.stop(); gain.disconnect(); } catch { /* already stopped */ }
    this.nodes = null;
  }
}
