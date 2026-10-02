// poVoices.js — the platform's synthesis engine, running on the audio thread.
//
// WHY A WORKLET
// Every sound in this app is generated, not sampled. Building a small graph of
// OscillatorNode/GainNode/BiquadFilterNode per cue from the main thread has
// two problems in a Blazor WASM app:
//
//   1. TIMING. Node creation and the `setValueAtTime` calls that shape the
//      envelope all run on the main thread — the same thread as the .NET
//      runtime. A GC pause or a heavy render between "the hit happened" and
//      "the node was scheduled" delays the sound by however long the pause was.
//      In here, `currentTime` advances in exact 128-sample steps regardless of
//      what the main thread is doing, so a cue scheduled for t lands at t.
//
//   2. COST. A PoBrawl combo or a MarbleRace pile-up wants a dozen
//      simultaneous cues. A dozen cues was ~50 AudioNodes constructed and torn
//      down inside one frame, each one a cross-thread allocation. Here it is a
//      dozen entries in a fixed array and zero allocation.
//
// The whole engine is one processor with a fixed voice pool. Voices are
// structs-of-fields in a preallocated array — nothing is allocated in process(),
// because an allocation on the audio thread risks a GC pause that is heard as a
// click.
//
// ANTI-ALIASING: saw and square use polyBLEP. A naive `2*phase-1` saw at 4 kHz
// on a 48 kHz context folds every harmonic above Nyquist back down into the
// audible band as inharmonic grit — which is exactly the frequency range the
// arcade-style cues in this app live in, so it is very audible. polyBLEP costs
// two comparisons per sample and removes most of it.

const MAX_VOICES = 48;
const TWO_PI = Math.PI * 2;

const WAVE_SINE = 0;
const WAVE_TRIANGLE = 1;
const WAVE_SAW = 2;
const WAVE_SQUARE = 3;
const WAVE_NOISE = 4;
const WAVE_PLUCK = 5;
const WAVE_MODAL = 6;

const WAVES = {
    sine: WAVE_SINE,
    triangle: WAVE_TRIANGLE,
    saw: WAVE_SAW,
    sawtooth: WAVE_SAW,
    square: WAVE_SQUARE,
    noise: WAVE_NOISE,
    pluck: WAVE_PLUCK,
    modal: WAVE_MODAL,
};

/**
 * Correction term for the discontinuity in a naive saw/square at the wrap
 * point. `t` is the phase 0..1, `dt` the per-sample phase increment.
 * Returns a polynomial that, subtracted at the step, band-limits it.
 */
function polyBlep(t, dt) {
    if (t < dt) {
        const x = t / dt;
        return x + x - x * x - 1;
    }
    if (t > 1 - dt) {
        const x = (t - 1) / dt;
        return x * x + x + x + 1;
    }
    return 0;
}

class Voice {
    constructor() {
        this.active = false;
        this.startTime = 0;
        this.endTime = 0;

        this.wave = WAVE_SINE;
        this.phase = 0;
        this.freq = 440;
        this.freqEnd = 440;
        this.sweep = 0;          // seconds over which freq → freqEnd

        this.gain = 0.2;
        this.attack = 0.005;
        this.decay = 0.2;        // to `sustain`
        this.sustain = 0;        // 0..1 of gain; 0 makes it purely percussive
        this.release = 0.05;
        this.dur = 0.2;          // note length before release begins

        this.cutoff = 20000;
        this.cutoffEnd = 20000;
        this.q = 0.7;
        this.filterOn = false;
        // State-variable filter state.
        this.svfLow = 0;
        this.svfBand = 0;

        this.drive = 0;          // 0 = clean, 1 = hard soft-clip
        this.panL = 0.707;
        this.panR = 0.707;

        // Amplitude-modulation LFO — cheap tremolo/wobble for alarms and engines.
        this.lfoRate = 0;
        this.lfoDepth = 0;
        this.lfoPhase = 0;

        // Karplus-Strong pluck state.
        this.pluckBuf = new Float32Array(2048);
        this.pluckLen = 0;
        this.pluckIdx = 0;
        this.pluckPrev = 0;
        this.pluckDamp = 0.985;

        // Modal synthesis state (4 resonant modes).
        this.modalModes = [
            { r: 1.0, d: 12.0, a: 1.0, phase: 0 },
            { r: 2.1, d: 20.0, a: 0.6, phase: 0 },
            { r: 3.4, d: 32.0, a: 0.35, phase: 0 },
            { r: 5.2, d: 48.0, a: 0.15, phase: 0 }
        ];
    }
}

class PoVoicesProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.voices = [];
        for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
        this.nextVoice = 0;
        this.masterGain = 1;

        // Shepard-Risset continuous tension engine
        this.shepardActive = false;
        this.shepardRate = 0.06; // rising speed (cycles per second)
        this.shepardPhase = 0;
        this.shepardGain = 0;
        this.shepardOscPhases = new Float32Array(8);

        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        if (!m) return;
        if (m.type === 'note') { this.allocate(m); return; }
        if (m.type === 'notes' && Array.isArray(m.items)) {
            for (const n of m.items) this.allocate(n);
            return;
        }
        if (m.type === 'shepard') {
            this.shepardActive = !!m.active;
            if (m.rate != null) this.shepardRate = Math.max(0.01, Math.min(0.5, m.rate));
            this.shepardGain = this.shepardActive ? Math.max(0, Math.min(1, m.gain != null ? m.gain : 0.15)) : 0;
            return;
        }
        if (m.type === 'gain') { this.masterGain = Math.max(0, Math.min(2, m.value)); return; }
        if (m.type === 'stopAll') {
            for (const v of this.voices) v.active = false;
            this.shepardActive = false;
            this.shepardGain = 0;
        }
    }

    allocate(n) {
        // Round-robin steal. With 48 voices and cues under a second, the slot
        // being reused is almost always already free; when it is not, stealing
        // the oldest is the least-bad option and is inaudible in practice.
        const v = this.voices[this.nextVoice];
        this.nextVoice = (this.nextVoice + 1) % MAX_VOICES;

        const when = Number.isFinite(n.when) ? n.when : currentTime;
        v.startTime = Math.max(when, currentTime);
        v.wave = WAVES[n.wave] !== undefined ? WAVES[n.wave] : WAVE_SINE;
        // Phase randomisation: firing several voices at the same frequency from
        // phase 0 makes them sum coherently into one loud transient with a
        // comb-filtered tail. Random starts keep a chord sounding like a chord.
        v.phase = Math.random();
        v.freq = Math.max(1, n.freq || 440);
        v.freqEnd = Math.max(1, n.freqEnd || n.freq || 440);
        v.sweep = Math.max(0, n.sweep || 0);

        if (v.wave === WAVE_PLUCK) {
            const sr = sampleRate || 48000;
            v.pluckLen = Math.max(2, Math.min(2047, Math.round(sr / v.freq)));
            v.pluckIdx = 0;
            v.pluckPrev = 0;
            v.pluckDamp = Math.max(0.85, Math.min(0.999, n.damping || 0.985));
            for (let i = 0; i < v.pluckLen; i++) {
                v.pluckBuf[i] = Math.random() * 2 - 1;
            }
        } else if (v.wave === WAVE_MODAL) {
            const mat = n.material || 'ceramic';
            let ratios = [1.0, 1.95, 3.12, 4.88];
            let decays = [8.0, 14.0, 22.0, 35.0];
            let amps = [1.0, 0.75, 0.45, 0.25];
            if (mat === 'wood') {
                ratios = [1.0, 2.57, 4.64, 7.02];
                decays = [18.0, 28.0, 42.0, 60.0];
                amps = [1.0, 0.5, 0.25, 0.1];
            } else if (mat === 'metal' || mat === 'bell') {
                ratios = [1.0, 2.0, 2.76, 5.40];
                decays = [2.5, 4.0, 6.0, 9.0];
                amps = [1.0, 0.8, 0.6, 0.4];
            } else if (mat === 'glass') {
                ratios = [1.0, 2.32, 4.15, 6.45];
                decays = [1.5, 2.8, 4.5, 7.5];
                amps = [1.0, 0.85, 0.7, 0.45];
            }
            const dMul = Math.max(0.2, Math.min(5.0, n.damping ? 1 / n.damping : 1.0));
            for (let m = 0; m < 4; m++) {
                v.modalModes[m].r = ratios[m];
                v.modalModes[m].d = decays[m] * dMul;
                v.modalModes[m].a = amps[m];
                v.modalModes[m].phase = Math.random();
            }
        }
        v.gain = Math.max(0, Math.min(1, n.gain == null ? 0.2 : n.gain));
        v.attack = Math.max(0.0005, n.attack == null ? 0.005 : n.attack);
        v.decay = Math.max(0.001, n.decay == null ? 0.15 : n.decay);
        v.sustain = Math.max(0, Math.min(1, n.sustain == null ? 0 : n.sustain));
        v.release = Math.max(0.002, n.release == null ? 0.05 : n.release);
        v.dur = Math.max(0.005, n.dur == null ? 0.2 : n.dur);
        v.cutoff = n.cutoff == null ? 20000 : Math.max(20, Math.min(20000, n.cutoff));
        v.cutoffEnd = n.cutoffEnd == null ? v.cutoff : Math.max(20, Math.min(20000, n.cutoffEnd));
        v.filterOn = v.cutoff < 19000 || v.cutoffEnd < 19000;
        v.q = Math.max(0.3, Math.min(18, n.q == null ? 0.7 : n.q));
        v.svfLow = 0;
        v.svfBand = 0;
        v.drive = Math.max(0, Math.min(1, n.drive || 0));
        v.lfoRate = Math.max(0, n.lfoRate || 0);
        v.lfoDepth = Math.max(0, Math.min(1, n.lfoDepth || 0));
        v.lfoPhase = 0;

        // Constant-power pan. Linear panning dips ~3 dB in the middle, which is
        // audible as a hole when a source sweeps across the stereo field —
        // exactly what the racing and marble games do.
        const pan = Math.max(-1, Math.min(1, n.pan || 0));
        const angle = (pan + 1) * (Math.PI / 4);
        v.panL = Math.cos(angle);
        v.panR = Math.sin(angle);

        v.endTime = v.startTime + v.dur + v.release;
        v.active = true;
    }

    /**
     * Level `d` seconds into the decay segment.
     * Exponential-ish via a squared linear ramp: a true exp() per sample would
     * dominate the voice's cost for a curve difference nobody can hear.
     */
    static decayLevel(v, d) {
        if (d >= v.decay) return v.sustain;
        const k = 1 - d / v.decay;
        return v.sustain + (1 - v.sustain) * k * k;
    }

    /** ADSR value at `age` seconds into the note. */
    static envelope(v, age) {
        if (age < v.attack) return age / v.attack;
        if (age < v.dur) return PoVoicesProcessor.decayLevel(v, age - v.attack);
        // Release starts from wherever the decay had actually reached, not from
        // `sustain`. For a percussive voice (sustain 0) cut short by a `dur`
        // shorter than its decay, releasing from `sustain` would be a step
        // discontinuity straight to silence — an audible click.
        const start = PoVoicesProcessor.decayLevel(v, v.dur - v.attack);
        const r = (age - v.dur) / v.release;
        if (r >= 1) return 0;
        const k = 1 - r;
        return start * k * k;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const left = out[0];
        const right = out.length > 1 ? out[1] : out[0];
        const n = left.length;
        const sr = sampleRate;
        const invSr = 1 / sr;
        const blockStart = currentTime;

        left.fill(0);
        if (right !== left) right.fill(0);

        for (let vi = 0; vi < MAX_VOICES; vi++) {
            const v = this.voices[vi];
            if (!v.active) continue;
            if (blockStart > v.endTime) { v.active = false; continue; }
            // Scheduled for a later block — leave it armed and skip.
            if (blockStart + n * invSr < v.startTime) continue;

            for (let i = 0; i < n; i++) {
                const t = blockStart + i * invSr;
                const age = t - v.startTime;
                if (age < 0) continue;
                if (age > v.dur + v.release) { v.active = false; break; }

                // ── Pitch ──────────────────────────────────────────────
                let f = v.freq;
                if (v.sweep > 0 && v.freqEnd !== v.freq) {
                    // Exponential in pitch, not linear in Hz: a linear sweep
                    // from 800→200 Hz spends most of its time in the top
                    // octave and reads as a "thunk", not a fall.
                    const p = Math.min(1, age / v.sweep);
                    f = v.freq * Math.pow(v.freqEnd / v.freq, p);
                }

                // ── Oscillator ─────────────────────────────────────────
                const dt = f * invSr;
                let s;
                switch (v.wave) {
                    case WAVE_SINE:
                        s = Math.sin(v.phase * TWO_PI);
                        break;
                    case WAVE_TRIANGLE:
                        // Integrated square would be more correct; the folded
                        // ramp is fine because a triangle's harmonics fall off
                        // as 1/n² and alias far below audibility here.
                        s = 4 * Math.abs(v.phase - 0.5) - 1;
                        break;
                    case WAVE_SAW:
                        s = 2 * v.phase - 1 - polyBlep(v.phase, dt);
                        break;
                    case WAVE_SQUARE: {
                        s = v.phase < 0.5 ? 1 : -1;
                        s += polyBlep(v.phase, dt);
                        let t2 = v.phase + 0.5;
                        if (t2 >= 1) t2 -= 1;
                        s -= polyBlep(t2, dt);
                        break;
                    }
                    case WAVE_PLUCK: {
                        // Karplus-Strong string synthesis: read, lowpass average, write back
                        const idx = v.pluckIdx;
                        const curr = v.pluckBuf[idx];
                        const val = (curr + v.pluckPrev) * 0.5 * v.pluckDamp;
                        v.pluckPrev = curr;
                        v.pluckBuf[idx] = val;
                        v.pluckIdx = (idx + 1) % v.pluckLen;
                        s = curr;
                        break;
                    }
                    case WAVE_MODAL: {
                        // Modal physical resonance: bank of 4 damped sinusoids
                        s = 0;
                        for (let m = 0; m < 4; m++) {
                            const mm = v.modalModes[m];
                            const mEnv = Math.exp(-mm.d * age);
                            s += mm.a * mEnv * Math.sin(mm.phase * TWO_PI);
                            mm.phase += (f * mm.r) * invSr;
                            if (mm.phase >= 1) mm.phase -= Math.floor(mm.phase);
                        }
                        s *= 0.5; // normalise sum
                        break;
                    }
                    default:
                        s = Math.random() * 2 - 1;
                        break;
                }
                if (v.wave !== WAVE_NOISE && v.wave !== WAVE_PLUCK && v.wave !== WAVE_MODAL) {
                    v.phase += dt;
                    if (v.phase >= 1) v.phase -= 1;
                }

                // ── Filter ─────────────────────────────────────────────
                if (v.filterOn) {
                    const p = v.sweep > 0 ? Math.min(1, age / Math.max(v.sweep, v.dur)) : Math.min(1, age / v.dur);
                    const fc = v.cutoff * Math.pow(v.cutoffEnd / v.cutoff, p);
                    // Chamberlin SVF. Stable while f < ~1.0; clamped below
                    // Nyquist/3 because the topology blows up as f approaches 1
                    // and a self-oscillating filter on the audio thread is a
                    // very loud bug.
                    const fq = Math.min(0.98, 2 * Math.sin(Math.PI * Math.min(fc, sr / 3) * invSr));
                    const damp = 1 / v.q;
                    const high = s - v.svfLow - damp * v.svfBand;
                    v.svfBand += fq * high;
                    v.svfLow += fq * v.svfBand;
                    s = v.svfLow;
                }

                // ── Shaping ────────────────────────────────────────────
                if (v.drive > 0) {
                    // tanh-style soft clip via a rational approximation —
                    // ~8× cheaper than Math.tanh and indistinguishable here.
                    const x = s * (1 + v.drive * 6);
                    s = x / (1 + Math.abs(x));
                }

                let amp = PoVoicesProcessor.envelope(v, age) * v.gain;
                if (v.lfoDepth > 0) {
                    amp *= 1 - v.lfoDepth * (0.5 - 0.5 * Math.cos(v.lfoPhase * TWO_PI));
                    v.lfoPhase += v.lfoRate * invSr;
                    if (v.lfoPhase >= 1) v.lfoPhase -= 1;
                }

                const o = s * amp * this.masterGain;
                left[i] += o * v.panL;
                if (right !== left) right[i] += o * v.panR;
            }
        }

        // ── Shepard-Risset Continuous Climax Engine ────────────────────────
        if (this.shepardGain > 0.001) {
            const fMin = 65.41; // C2
            const fMax = 2093.0; // C7 (5 octaves)
            const octaves = 6;
            for (let i = 0; i < n; i++) {
                this.shepardPhase += (this.shepardRate * invSr);
                if (this.shepardPhase >= 1) this.shepardPhase -= 1;

                let shepSample = 0;
                for (let k = 0; k < octaves; k++) {
                    const pos = (this.shepardPhase + (k / octaves)) % 1;
                    const f = fMin * Math.pow(fMax / fMin, pos);
                    const dt = f * invSr;
                    this.shepardOscPhases[k] += dt;
                    if (this.shepardOscPhases[k] >= 1) this.shepardOscPhases[k] -= 1;

                    // Raised cosine spectral envelope: 0 at bounds, 1 at center
                    const weight = 0.5 - 0.5 * Math.cos(pos * TWO_PI);
                    shepSample += Math.sin(this.shepardOscPhases[k] * TWO_PI) * weight;
                }
                const outVal = shepSample * 0.18 * this.shepardGain * this.masterGain;
                left[i] += outVal;
                if (right !== left) right[i] += outVal;
            }
        }

        // Never return false: that permanently ends the processor, and this one
        // is a long-lived instrument, not a one-shot source.
        return true;
    }
}

registerProcessor('po-voices', PoVoicesProcessor);
