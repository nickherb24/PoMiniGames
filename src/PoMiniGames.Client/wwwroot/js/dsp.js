// dsp.js — main-thread front end for the AudioWorklet synthesis engine.
//
// Call sites describe a sound as data (`{wave, freq, freqEnd, dur, cutoff, …}`)
// and this module gets it onto the audio thread. One AudioWorkletNode is
// created per mix bus, lazily; every cue that bus ever plays is a postMessage
// into that one node rather than a fresh graph of AudioNodes.
//
// FALLBACK IS NOT OPTIONAL. `audioWorklet` needs a secure context, and
// addModule() is a network fetch that can fail. When either does, playNodes()
// below reproduces the same voice with ordinary AudioNodes. It is less
// accurate — the envelope is a handful of scheduled ramps rather than a
// per-sample curve, and there is no drive or LFO — but it is the same sound,
// and no call site has to care which path it took.

import * as AudioBus from './audioBus.js';

const WORKLET_URL = new URL('./worklets/poVoices.js', import.meta.url).href;

let _modulePromise = null;
let _moduleOk = false;
/** @type {Map<string, AudioWorkletNode>} */
const _nodes = new Map();

// Shared noise buffer for the fallback path. Two seconds of white noise
// generated once; every noise voice reads a random offset into it. Generating
// a fresh buffer per cue was measurable at PoBrawl's hit rate.
let _noiseBuffer = null;

/**
 * Ensure the worklet module is registered. Idempotent and safe to call from
 * anywhere; every caller awaits the same promise.
 * @returns {Promise<boolean>} whether the worklet path is available
 */
export async function ready() {
    if (_modulePromise) return _modulePromise;
    _modulePromise = (async () => {
        try {
            const ctx = await AudioBus.context();
            if (!ctx || !ctx.audioWorklet) return false;
            await ctx.audioWorklet.addModule(WORKLET_URL);
            _moduleOk = true;
            return true;
        } catch {
            // Insecure context, blocked fetch, or an engine without worklets.
            // The node path below covers all three.
            return false;
        }
    })();
    return _modulePromise;
}

export function isWorkletActive() {
    return _moduleOk;
}

/**
 * Get (or create) the worklet node feeding a named bus.
 * @param {'music'|'sfx'|'ui'} busName
 */
async function nodeFor(busName) {
    if (_nodes.has(busName)) return _nodes.get(busName);
    const ok = await ready();
    if (!ok) return null;
    const ctx = await AudioBus.context();
    const dest = await AudioBus.bus(busName);
    if (!ctx || !dest) return null;
    // Re-check after the awaits: two concurrent first-cues on the same bus would
    // otherwise each construct a node and the second would orphan the first.
    if (_nodes.has(busName)) return _nodes.get(busName);
    try {
        const node = new AudioWorkletNode(ctx, 'po-voices', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        node.connect(dest);
        _nodes.set(busName, node);
        return node;
    } catch {
        _moduleOk = false;
        return null;
    }
}

/**
 * Play one voice.
 *
 * @param {object} v voice description
 * @param {'sine'|'triangle'|'saw'|'square'|'noise'} [v.wave='sine']
 * @param {number} [v.freq=440]      start frequency, Hz
 * @param {number} [v.freqEnd]       end of the pitch sweep (exponential)
 * @param {number} [v.sweep]         sweep duration, s (defaults to dur)
 * @param {number} [v.dur=0.2]       note length before release, s
 * @param {number} [v.attack=0.005]
 * @param {number} [v.decay=0.15]
 * @param {number} [v.sustain=0]     0..1 of gain; 0 = purely percussive
 * @param {number} [v.release=0.05]
 * @param {number} [v.gain=0.2]      peak amplitude 0..1
 * @param {number} [v.cutoff]        lowpass, Hz; omit for none
 * @param {number} [v.cutoffEnd]     filter sweep target
 * @param {number} [v.q=0.7]         resonance
 * @param {number} [v.drive=0]       0..1 soft clip (worklet path only)
 * @param {number} [v.lfoRate=0]     tremolo Hz (worklet path only)
 * @param {number} [v.lfoDepth=0]    0..1 (worklet path only)
 * @param {number} [v.pan=0]         -1..1, constant power
 * @param {number} [v.delay=0]       seconds from now
 * @param {number} [v.at]            ABSOLUTE AudioContext time; wins over
 *   `delay`. Sequencers must use this: `delay` is measured from whenever this
 *   call happens to run, so a scheduler using it would accumulate the jitter of
 *   its own timer into the groove.
 * @param {'music'|'sfx'|'ui'} [bus='sfx']
 */
export async function play(v, bus) {
    if (!v || AudioBus.isMuted()) return;
    const busName = bus || 'sfx';
    const ctx = await AudioBus.context();
    if (!ctx) return;
    const when = v.at != null ? v.at : ctx.currentTime + Math.max(0, v.delay || 0);

    const node = await nodeFor(busName);
    if (node) {
        node.port.postMessage({ type: 'note', ...v, when });
        return;
    }
    playNodes(ctx, await AudioBus.bus(busName), v, when);
}

/**
 * Play several voices as one message. Use this for chords, arpeggios and
 * layered one-shots: it is a single postMessage instead of N, and — more
 * importantly — every voice in the batch is scheduled against the same
 * `currentTime`, so their relative timing is exact rather than depending on how
 * long the loop of individual calls took.
 *
 * @param {object[]} items voice descriptions; each may carry its own `delay`
 * @param {'music'|'sfx'|'ui'} [bus='sfx']
 */
export async function playAll(items, bus) {
    if (!items || !items.length || AudioBus.isMuted()) return;
    const busName = bus || 'sfx';
    const ctx = await AudioBus.context();
    if (!ctx) return;
    const t0 = ctx.currentTime;

    const node = await nodeFor(busName);
    if (node) {
        node.port.postMessage({
            type: 'notes',
            items: items.map((v) => ({
                ...v,
                when: v.at != null ? v.at : t0 + Math.max(0, v.delay || 0),
            })),
        });
        return;
    }
    const dest = await AudioBus.bus(busName);
    for (const v of items) {
        playNodes(ctx, dest, v, v.at != null ? v.at : t0 + Math.max(0, v.delay || 0));
    }
}

/** Silence every voice immediately — teardown, route change, panic. */
export async function stopAll() {
    for (const node of _nodes.values()) {
        try { node.port.postMessage({ type: 'stopAll' }); } catch { /* node is gone */ }
    }
}

function noiseBuffer(ctx) {
    if (_noiseBuffer && _noiseBuffer.sampleRate === ctx.sampleRate) return _noiseBuffer;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    _noiseBuffer = buf;
    return buf;
}

/**
 * Fallback voice built from ordinary AudioNodes.
 * Deliberately kept to one source + one filter + one gain + one panner: the
 * point of this path is that it always works, not that it matches the worklet
 * sample for sample.
 */
function playNodes(ctx, dest, v, when) {
    if (!ctx || !dest) return;
    try {
        const dur = Math.max(0.005, v.dur == null ? 0.2 : v.dur);
        const release = Math.max(0.002, v.release == null ? 0.05 : v.release);
        const attack = Math.max(0.0005, v.attack == null ? 0.005 : v.attack);
        const gain = Math.max(0, Math.min(1, v.gain == null ? 0.2 : v.gain));
        const end = when + dur + release;

        let src;
        if (v.wave === 'noise') {
            src = ctx.createBufferSource();
            src.buffer = noiseBuffer(ctx);
            src.loop = true;
            // Random read offset — starting every noise burst at sample 0 makes
            // repeated hits sound identical, which reads as a looping sample
            // rather than as noise.
            src.loopStart = Math.random() * 1.5;
            src.loopEnd = src.loopStart + 0.4;
        } else {
            src = ctx.createOscillator();
            src.type = v.wave === 'saw' ? 'sawtooth' : (v.wave || 'sine');
            const f0 = Math.max(1, v.freq || 440);
            const f1 = Math.max(1, v.freqEnd || f0);
            src.frequency.setValueAtTime(f0, when);
            if (f1 !== f0) {
                src.frequency.exponentialRampToValueAtTime(f1, when + Math.max(0.01, v.sweep || dur));
            }
        }

        let head = src;
        if (v.cutoff != null && v.cutoff < 19000) {
            const filt = ctx.createBiquadFilter();
            filt.type = 'lowpass';
            filt.Q.value = Math.max(0.3, Math.min(18, v.q == null ? 0.7 : v.q));
            filt.frequency.setValueAtTime(v.cutoff, when);
            if (v.cutoffEnd != null && v.cutoffEnd !== v.cutoff) {
                filt.frequency.exponentialRampToValueAtTime(
                    Math.max(20, v.cutoffEnd), when + Math.max(0.01, v.sweep || dur));
            }
            head.connect(filt);
            head = filt;
        }

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(gain, when + attack);
        // exponentialRampToValueAtTime cannot reach 0 — it is undefined for a
        // zero target — so the floor is a value below audibility instead.
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        head.connect(g);
        head = g;

        if (v.pan && ctx.createStereoPanner) {
            const p = ctx.createStereoPanner();
            p.pan.value = Math.max(-1, Math.min(1, v.pan));
            head.connect(p);
            head = p;
        }

        head.connect(dest);
        src.start(when);
        src.stop(end + 0.02);
    } catch { /* best-effort: feedback paths never throw */ }
}

/**
 * Karplus-Strong / physical modeling plucked string emulation.
 * Bright harmonic attack decaying into a warm sinusoidal fundamental.
 * @param {number} freq  Frequency in Hz (e.g. 220, 440, 660)
 * @param {number} [dur=0.8]  Ring duration in seconds
 * @param {number} [gain=0.25] Amplitude 0..1
 * @param {number} [damp=0.7]  Damping factor: higher = faster harmonic bleed
 * @param {'music'|'sfx'|'ui'} [busName='ui']
 */
export async function playPluck(freq, dur = 0.8, gain = 0.25, damp = 0.7, busName = 'ui') {
    const f = Math.max(40, freq || 440);
    if (_moduleOk) {
        return play({
            wave: 'pluck',
            freq: f,
            dur: dur,
            gain: gain,
            damping: Math.max(0.85, Math.min(0.995, 0.99 - damp * 0.08)),
            attack: 0.001,
            decay: dur * 0.9,
        }, busName);
    }
    const voices = [
        // Fallback fundamental body
        { wave: 'triangle', freq: f, dur: dur, gain: gain * 0.7, attack: 0.002, decay: dur * 0.85 },
        // High harmonic pluck transient with rapid filter sweep
        { wave: 'saw', freq: f * 2, dur: Math.min(dur * 0.4, 0.25), gain: gain * 0.45, attack: 0.001, decay: 0.12 * (1 - damp * 0.5), cutoff: 4800, cutoffEnd: f * 1.5, q: 2 },
        // Subtle resonant 3rd harmonic
        { wave: 'sine', freq: f * 3, dur: Math.min(dur * 0.3, 0.18), gain: gain * 0.25, attack: 0.001, decay: 0.08 },
    ];
    return playAll(voices, busName);
}

/**
 * Modal physical resonance synthesizer (wood, ceramic, bell, glass, metal).
 * Zero audio samples — evaluates resonant eigenvalue modes in real-time.
 * @param {number} [freq=440] Fundamental frequency in Hz
 * @param {'ceramic'|'wood'|'metal'|'bell'|'glass'} [material='ceramic']
 * @param {number} [dur=0.6] Ring-out duration in seconds
 * @param {number} [gain=0.25] Amplitude 0..1
 * @param {number} [damp=1.0] Damping factor multiplier
 * @param {'music'|'sfx'|'ui'} [busName='sfx']
 */
export async function playModal(freq = 440, material = 'ceramic', dur = 0.6, gain = 0.25, damp = 1.0, busName = 'sfx') {
    const f = Math.max(40, freq);
    if (_moduleOk) {
        return play({
            wave: 'modal',
            freq: f,
            material: material,
            dur: dur,
            gain: gain,
            damping: damp,
            attack: 0.002,
            decay: dur * 0.9,
        }, busName);
    }
    // Node-fallback: multi-oscillator approximation
    return playGong(f, dur, gain, busName);
}

/**
 * Inharmonic ceremonial gong / bronze bell using multi-voice inharmonic ratios.
 * @param {number} [freq=110] Base fundamental Hz
 * @param {number} [dur=3.5] Tail duration in seconds
 * @param {number} [gain=0.35] Amplitude 0..1
 * @param {'music'|'sfx'|'ui'} [busName='sfx']
 */
export async function playGong(freq = 110, dur = 3.5, gain = 0.35, busName = 'sfx') {
    const f = Math.max(50, freq);
    const voices = [
        // Metallic attack clang
        { wave: 'noise', freq: 0, dur: 0.08, gain: gain * 0.4, attack: 0.001, decay: 0.07, cutoff: 5500, cutoffEnd: 800, q: 2.5 },
        // Deep fundamental boom
        { wave: 'sine', freq: f, freqEnd: f * 0.98, dur: dur, gain: gain * 0.65, attack: 0.004, decay: dur * 0.9 },
        // Inharmonic partial 1 (ratio 1 : 2.76)
        { wave: 'sine', freq: f * 2.76, dur: dur * 0.7, gain: gain * 0.4, attack: 0.002, decay: dur * 0.65, delay: 0.002 },
        // Inharmonic partial 2 (ratio 1 : 5.41)
        { wave: 'sine', freq: f * 5.41, dur: dur * 0.45, gain: gain * 0.25, attack: 0.002, decay: dur * 0.4, delay: 0.004 },
    ];
    return playAll(voices, busName);
}

/**
 * Granular noise cluster for structural fracture, rubble, and concrete shattering.
 * @param {number} [freqBase=1200] Center frequency in Hz
 * @param {number} [count=8] Number of micro-grains
 * @param {number} [dur=0.35] Total burst duration
 * @param {number} [gain=0.25] Master gain
 * @param {'music'|'sfx'|'ui'} [busName='sfx']
 */
export async function playGranular(freqBase = 1200, count = 8, dur = 0.35, gain = 0.25, busName = 'sfx') {
    const voices = [];
    for (let i = 0; i < count; i++) {
        const grainDur = 0.03 + Math.random() * 0.06;
        const delay = Math.random() * Math.max(0.01, dur - grainDur);
        const f = freqBase * (0.6 + Math.random() * 0.8);
        voices.push({
            wave: 'noise',
            freq: 0,
            dur: grainDur,
            gain: (gain / Math.sqrt(count)) * (0.7 + Math.random() * 0.6),
            attack: 0.002,
            decay: grainDur * 0.85,
            cutoff: f,
            cutoffEnd: f * 0.5,
            q: 2 + Math.random() * 4,
            delay: delay,
            pan: (Math.random() * 2 - 1) * 0.6,
        });
    }
    return playAll(voices, busName);
}

/**
 * Rapid frequency chirp for bubbles, liquid drops, and crystalline pings.
 * @param {number} freqStart Start frequency Hz
 * @param {number} freqEnd   Target frequency Hz
 * @param {number} [dur=0.05] Duration in seconds
 * @param {number} [gain=0.15] Gain 0..1
 * @param {'music'|'sfx'|'ui'} [busName='ui']
 */
export async function playChirp(freqStart, freqEnd, dur = 0.05, gain = 0.15, busName = 'ui') {
    return play({
        wave: 'sine',
        freq: freqStart,
        freqEnd: freqEnd,
        dur: dur,
        sweep: dur,
        gain: gain,
        attack: 0.001,
        decay: dur * 0.9,
    }, busName);
}

/**
 * Control the continuous Shepard-Risset rising tension engine.
 * @param {boolean} active
 * @param {number} [rate=0.06]
 * @param {number} [gain=0.15]
 * @param {'music'|'sfx'|'ui'} [busName='music']
 */
export async function setShepard(active, rate = 0.06, gain = 0.15, busName = 'music') {
    const node = await nodeFor(busName);
    if (node) {
        node.port.postMessage({
            type: 'shepard',
            active: !!active,
            rate: rate,
            gain: gain
        });
    }
}

if (typeof window !== 'undefined') {
    window.PoDsp = {
        play,
        playAll,
        stopAll,
        ready,
        isWorkletActive,
        playPluck,
        playModal,
        playGong,
        playGranular,
        playChirp,
        setShepard
    };
}
