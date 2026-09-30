// pocabinet/music.js
//
// Adaptive race score (2026-09-29). Synthesized like everything in audio.js — no
// assets — and routed into audio.js's bus, so the master volume, mute, pause duck
// and the photo-finish slow-mo lowpass all apply to it for free.
//
// A 16th-note step sequencer (lookahead scheduling on the AudioContext clock)
// plays four layers over an Am–F–C–G loop at 132 BPM. Each layer has its own gain,
// and race.js only moves targets:
//
//   pad    — always under the race (and alone on the grid)
//   bass   — eighth-note root pulse once the lights go out
//   drums  — hats alone when running free; kick + snare come in with a battle
//   arp    — sixteenth arpeggio for a close battle and the final lap
//
// Battle = another car within a few lengths (race.js measures it from the drawn
// poses, so it works the same solo, online and spectating). The final lap also
// modulates the loop up a whole tone at the next bar. Layer changes land on the
// sequencer clock, so nothing ever cuts in mid-note.

import { graph } from './audio.js';

const BPM = 132;
const STEP = 60 / BPM / 4;                 // one sixteenth
const LOOKAHEAD = 0.14;
const CHORDS = [                           // midi, root first: Am F C G
    [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
];
const LEVEL = 0.55;                        // the whole score, under the engine

let g = null;          // { ctx, out, layers: { pad, bass, drums, arp }, noise }
let timer = null;
let step = 0;
let nextAt = 0;
let transpose = 0;
let wantTranspose = 0;
let enabled = true;
const target = { pad: 0, bass: 0, drums: 0, arp: 0, kick: 0 };

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function ensure() {
    if (g) return g;
    const a = graph();
    if (!a) return null;
    const { ctx, bus } = a;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(bus);
    const layer = () => { const n = ctx.createGain(); n.gain.value = 0; n.connect(out); return n; };
    const len = ctx.sampleRate;
    const noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    g = { ctx, out, noise, layers: { pad: layer(), bass: layer(), drums: layer(), arp: layer() } };
    return g;
}

/**
 * Drive the score from the race. phase 'grid' | 'race' | 'off'; battle 0..1;
 * finalLap bool. Cheap to call every frame — it only moves targets.
 */
export function setState({ phase = 'off', battle = 0, finalLap = false } = {}) {
    const on = enabled && phase !== 'off';
    const b = Math.min(1, Math.max(0, Number(battle) || 0));
    target.pad = on ? (phase === 'grid' ? 0.9 : 0.55) : 0;
    target.bass = on && phase === 'race' ? 0.8 : 0;
    target.drums = on && phase === 'race' ? 0.55 + 0.45 * Math.max(b, finalLap ? 0.7 : 0) : 0;
    target.kick = on && phase === 'race' && (b > 0.35 || finalLap) ? 1 : 0;
    target.arp = on && phase === 'race' ? Math.max(b > 0.35 ? b : 0, finalLap ? 0.75 : 0) : 0;
    wantTranspose = finalLap ? 2 : 0;
    if (on) start();
}

/** Music on/off from the settings panel. Off fades out and stops the sequencer. */
export function setEnabled(on) {
    enabled = on !== false;
    if (!enabled) setState({ phase: 'off' });
}

function start() {
    if (timer !== null || !ensure()) return;
    const ctx = g.ctx;
    g.out.gain.setTargetAtTime(LEVEL, ctx.currentTime, 0.4);
    step = 0;
    nextAt = ctx.currentTime + 0.05;
    timer = window.setInterval(schedule, 25);
}

function stop() {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
}

function schedule() {
    const ctx = g.ctx;
    const now = ctx.currentTime;
    // A throttled background tab stalls the interval: skip ahead instead of machine-gunning.
    if (nextAt < now - 0.2) nextAt = now + 0.02;
    for (const [k, node] of Object.entries(g.layers)) {
        node.gain.setTargetAtTime(target[k], now, k === 'pad' ? 0.8 : 0.25);
    }
    const silent = Object.values(target).every(v => v === 0);
    if (silent) {
        g.out.gain.setTargetAtTime(0, now, 0.4);
        if (g.layers.pad.gain.value < 0.01) stop();
    }
    while (nextAt < now + LOOKAHEAD) {
        play(step, nextAt);
        nextAt += STEP;
        step = (step + 1) % (16 * CHORDS.length);
    }
}

function play(s, t) {
    const inBar = s % 16;
    if (inBar === 0 && transpose !== wantTranspose) transpose = wantTranspose;
    const chord = CHORDS[Math.floor(s / 16)].map(n => n + transpose);
    const L = g.layers;
    if (inBar === 0) pad(chord, t, STEP * 16);
    if (inBar % 2 === 0) bass(chord[0] - 12 + (inBar % 8 === 6 ? 12 : 0), t);
    if (inBar % 2 === 0 || target.drums > 0.8) hat(t, inBar % 4 === 2 ? 0.06 : 0.035);
    if (target.kick > 0) {
        if (inBar % 4 === 0) kick(t);
        if (inBar === 4 || inBar === 12) snare(t);
    }
    if (L.arp.gain.value > 0.01 || target.arp > 0) {
        const n = chord[[0, 1, 2, 1][inBar % 4]] + 12 + (inBar >= 8 ? 12 : 0);
        arp(n, t);
    }
}

// ── Voices ───────────────────────────────────────────────────────────────────

function env(gain, t, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function pad(chord, t, dur) {
    const ctx = g.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(800, t + dur);
    const v = ctx.createGain();
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(0.05, t + 0.35);
    v.gain.setValueAtTime(0.05, t + dur - 0.2);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    lp.connect(v); v.connect(g.layers.pad);
    for (const n of chord) {
        for (const det of [-7, 7]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = hz(n);
            o.detune.value = det;
            o.connect(lp);
            o.start(t);
            o.stop(t + dur + 0.3);
        }
    }
}

function bass(n, t) {
    const ctx = g.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = hz(n);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + STEP * 1.6);
    const v = ctx.createGain();
    env(v, t, 0.13, 0.005, STEP * 1.8);
    o.connect(lp); lp.connect(v); v.connect(g.layers.bass);
    o.start(t);
    o.stop(t + STEP * 2);
}

function arp(n, t) {
    const ctx = g.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = hz(n);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const v = ctx.createGain();
    env(v, t, 0.035, 0.004, STEP * 0.9);
    o.connect(lp); lp.connect(v); v.connect(g.layers.arp);
    o.start(t);
    o.stop(t + STEP);
}

function noiseHit(t, type, freq, q, peak, decay) {
    const ctx = g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const v = ctx.createGain();
    env(v, t, peak, 0.002, decay);
    src.connect(f); f.connect(v); v.connect(g.layers.drums);
    src.start(t, Math.random() * 0.5, decay + 0.05);
}

function hat(t, peak) { noiseHit(t, 'highpass', 8000, 0.7, peak, 0.035); }

function snare(t) {
    noiseHit(t, 'bandpass', 1900, 0.9, 0.12, 0.16);
    const ctx = g.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    const v = ctx.createGain();
    env(v, t, 0.08, 0.002, 0.1);
    o.connect(v); v.connect(g.layers.drums);
    o.start(t);
    o.stop(t + 0.14);
}

function kick(t) {
    const ctx = g.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.18);
    const v = ctx.createGain();
    env(v, t, 0.32, 0.003, 0.26);
    o.connect(v); v.connect(g.layers.drums);
    o.start(t);
    o.stop(t + 0.3);
}
