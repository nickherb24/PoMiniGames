// pojevarena/audio.js — synthesized arena sound: one voice per sim event, and creature voices.
//
// No audio files: every sound is an oscillator or filtered noise, shaped by an envelope. It rides
// the platform's one AudioContext and its `sfx` bus (audioBus.js), so the app's mute and volume
// apply without a line here, and when the bus is missing it is silent. The music is not here:
// the page's soundtrack is PoMusicDirector's, which index.js drives with the fight's tension.
//
// Readability over realism, as with the art: each ability has its own timbre, sounds
// pan with the arena x, loudness follows damage, and at most MAX_VOICES play at once, so a
// 20-unit brawl thickens instead of clipping. Creature voices are built from the creature's own
// data — pitch from mass, waveform, vibrato and formant from temperament — so the same creature
// always sounds the same, and a berserker's snarl is never mistaken for a medic's chirp.

import { ARENA_W } from './sim.js';

const MAX_VOICES = 16;
const VOICE_GAP_S = 0.6;                 // per creature, so one unit can't chatter
const GAP_S = { melee: 0.035, glob: 0.04, boulder: 0.05, heal: 0.07, block: 0.05, dodge: 0.06, stone: 0.05, brace: 0.25 };

const TEMPERAMENT_VOICE = {
    reckless_berserker: { wave: 'sawtooth', pitch: 0.8, vib: 18, formant: 700 },
    disciplined_anchor: { wave: 'triangle', pitch: 0.75, vib: 3, formant: 500 },
    skirmisher: { wave: 'square', pitch: 1.35, vib: 8, formant: 1400 },
    cautious_sniper: { wave: 'square', pitch: 1.1, vib: 2, formant: 1100 },
    loyal_guardian: { wave: 'sine', pitch: 1.25, vib: 5, formant: 900 },
    opportunist: { wave: 'triangle', pitch: 1.1, vib: 12, formant: 1000 },
};

// kind → [duration s, start pitch ×, end pitch ×, gain]
const VOICE_SHAPES = {
    grunt: [0.18, 1.1, 0.85, 0.22],
    cry: [0.5, 1.6, 0.6, 0.3],
    squeal: [0.35, 2.0, 2.8, 0.2],
    chirp: [0.15, 2.0, 2.6, 0.16],
};

const SILENT = {
    onEvents() { }, fanfare() { }, sting() { }, setRate() { }, stream: () => null, dispose() { },
};

export function createAudio(creatures) {
    const bus = typeof window !== 'undefined' ? window.PoAudioBus : null;
    let ctx = null;
    try { ctx = bus?.contextSync?.() ?? null; } catch { ctx = null; }
    if (!ctx) return SILENT;
    try { bus.resume?.(); } catch { /* resumes on the next gesture instead */ }

    const out = ctx.createGain();
    out.gain.value = 0.7;
    out.connect(bus.busSync?.('sfx') || ctx.destination);

    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const voices = creatures.map(c => ({
        base: 260 / Math.sqrt(Math.max(1, c.mass || 1)),
        ...(TEMPERAMENT_VOICE[c.temperament] || TEMPERAMENT_VOICE.opportunist),
    }));
    const voiceAt = new Float64Array(creatures.length).fill(-9);
    const grunts = new Uint16Array(creatures.length);
    const lastAt = {};
    let active = 0;
    let rate = 1;           // pitch multiplier: the kill cam's slow motion drops everything a fifth
    let dest = null;

    const now = () => ctx.currentTime;
    const running = () => ctx.state === 'running';
    const panFor = (x) => Math.max(-0.8, Math.min(0.8, ((x ?? ARENA_W / 2) / ARENA_W) * 2 - 1));
    function gap(key) {
        const t = now();
        if (t - (lastAt[key] ?? -9) < (GAP_S[key] ?? 0.04)) return false;
        lastAt[key] = t;
        return true;
    }

    /** gain → panner → out, released when `dur` has passed; null when the voice budget is spent. */
    function chain(dur, pan) {
        if (!running() || active >= MAX_VOICES) return null;
        active++;
        const g = ctx.createGain();
        g.gain.value = 0;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p).connect(out);
        setTimeout(() => { active--; try { p.disconnect(); } catch { /* gone */ } }, (dur + 0.1) * 1000);
        return g;
    }

    function envelope(g, t, attack, peak, dur) {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }

    function tone(type, f0, f1, dur, peak, pan, attack = 0.005) {
        const g = chain(dur, pan);
        if (!g) return;
        const t = now();
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f0 * rate, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * rate), t + dur);
        o.connect(g);
        envelope(g, t, attack, peak, dur);
        o.start(t);
        o.stop(t + dur + 0.02);
    }

    function hiss(dur, peak, pan, f0, f1, q = 1.2, type = 'bandpass') {
        const g = chain(dur, pan);
        if (!g) return;
        const t = now();
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.Q.value = q;
        f.frequency.setValueAtTime(f0 * rate, t);
        f.frequency.exponentialRampToValueAtTime(Math.max(40, f1 * rate), t + dur);
        src.connect(f).connect(g);
        envelope(g, t, 0.004, peak, dur);
        src.start(t, Math.random() * 0.5);
        src.stop(t + dur + 0.02);
    }

    function voice(idx, kind, pan) {
        const v = voices[idx];
        const shape = VOICE_SHAPES[kind];
        if (!v || !shape || now() - voiceAt[idx] < VOICE_GAP_S) return;
        const [dur, from, to, peak] = shape;
        const g = chain(dur, pan);
        if (!g) return;
        voiceAt[idx] = now();
        const t = now(), f = v.base * v.pitch * rate;
        const o = ctx.createOscillator();
        o.type = v.wave;
        o.frequency.setValueAtTime(f * from, t);
        o.frequency.exponentialRampToValueAtTime(f * to, t + dur);
        const lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = v.vib;
        depth.gain.value = f * 0.04;
        lfo.connect(depth).connect(o.frequency);
        const formant = ctx.createBiquadFilter();
        formant.type = 'bandpass';
        formant.frequency.value = v.formant;
        formant.Q.value = 2.5;
        o.connect(formant).connect(g);
        envelope(g, t, 0.02, peak, dur);
        for (const n of [o, lfo]) { n.start(t); n.stop(t + dur + 0.02); }
    }

    function metal(pan, peak) {
        // Inharmonic partials read as struck metal, where a harmonic stack reads as a note.
        for (const [mul, gain] of [[1, 1], [2.76, 0.5], [5.4, 0.25]]) tone('sine', 523 * mul, 510 * mul, 0.4, peak * gain, pan, 0.002);
        hiss(0.03, peak * 0.6, pan, 6000, 5000, 0.8, 'highpass');
    }

    return {
        /** One sim tick's events; `views` locate them (metres). */
        onEvents(events, views) {
            for (const e of events) {
                const u = e.u !== undefined ? views[e.u] : null;
                const pan = panFor(u ? u.x : e.x);
                switch (e.type) {
                    case 'hit': {
                        const loud = Math.min(1, 0.35 + (e.amount || 0) / 30);
                        if (e.kind === 'melee' && gap('melee')) {
                            tone('sine', 150, 55, 0.14, 0.45 * loud, pan);
                            hiss(0.06, 0.25 * loud, pan, 1400, 600);
                        } else if (e.kind === 'glob' && gap('glob')) {
                            hiss(0.16, 0.3 * loud, pan, 2200, 380, 3);
                            tone('sine', 300, 120, 0.1, 0.15, pan);
                        } else if (e.kind === 'boulder' && gap('boulder')) {
                            tone('sine', 95, 38, 0.38, 0.6, pan);
                            hiss(0.28, 0.35, pan, 900, 120, 0.7, 'lowpass');
                        }
                        break;
                    }
                    case 'block':
                        if (gap('block')) metal(pan, 0.18);
                        break;
                    case 'heal':
                        if (e.amount >= 0.5 && gap('heal')) [1046, 1318, 1568].forEach((f, i) => setTimeout(() => tone('sine', f, f, 0.18, 0.1, pan), i * 45));
                        break;
                    case 'dodge':
                        if (gap('dodge')) hiss(0.12, 0.14, pan, 3500, 6000, 1.5);
                        break;
                    case 'death':
                        tone('sine', 120, 40, 0.5, 0.5, pan);
                        if (u) voice(e.u, 'cry', pan);
                        break;
                    case 'panic':
                        if (e.on && u) voice(e.u, 'squeal', pan);
                        break;
                    case 'windup':
                        // Every third swing gets a grunt, so a scrum is voiced, not a choir.
                        if (u && grunts[e.u]++ % 3 === 0) voice(e.u, 'grunt', pan);
                        break;
                    case 'cast':
                        if (e.ability === 'spit_glob') hiss(0.14, 0.2, pan, 500, 1800, 2);
                        else if (e.ability === 'hurl_boulder' && u) voice(e.u, 'grunt', pan);
                        else if (e.ability === 'mend_bolt') { tone('sine', 880, 880, 0.6, 0.12, pan, 0.01); tone('sine', 1320, 1320, 0.5, 0.07, pan, 0.01); if (u) voice(e.u, 'chirp', pan); }
                        break;
                    case 'ability':
                        if (e.ability === 'dodge_dash') hiss(0.25, 0.22, pan, 400, 3000, 1.2);
                        else if (e.ability === 'hard_shell') { hiss(0.03, 0.3, pan, 3000, 2500, 1, 'highpass'); setTimeout(() => hiss(0.03, 0.25, pan, 2400, 2000, 1, 'highpass'), 60); }
                        else if (e.ability === 'shield_brace' && gap('brace')) tone('triangle', 180, 140, 0.2, 0.2, pan);
                        break;
                    case 'fizzle':
                        if (e.pillar && gap('stone')) { hiss(0.05, 0.25, pan, 2500, 1500, 1); tone('sine', 700, 400, 0.05, 0.08, pan); }
                        break;
                }
            }
        },

        /** Victory: a rising major arpeggio that lands on a held octave. */
        fanfare() {
            [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => {
                const last = i === 3;
                tone('triangle', f, f, last ? 0.9 : 0.16, last ? 0.22 : 0.18, 0, 0.01);
                tone('sawtooth', f / 2, f / 2, last ? 0.9 : 0.16, 0.05, 0, 0.01);
            }, i * 120));
        },

        /** Last creature standing on a side: a low hit under a rising tone. */
        sting() {
            tone('sine', 70, 45, 0.8, 0.5, 0);
            tone('sine', 200, 620, 0.9, 0.12, 0, 0.3);
        },

        setRate(r) { rate = r; },

        /** A MediaStream of the arena's sound, for the kill-cam clip (created on first ask). */
        stream() {
            try {
                if (!dest) { dest = ctx.createMediaStreamDestination(); out.connect(dest); }
                return dest.stream;
            } catch { return null; }
        },

        dispose() {
            try { out.disconnect(); } catch { /* already gone */ }
        },
    };
}
