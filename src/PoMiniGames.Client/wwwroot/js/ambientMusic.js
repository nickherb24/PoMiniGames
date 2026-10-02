// ambientMusic.js — generative, layered, adaptive score. Zero bytes of audio ship.
//
// Every other music system on the web downloads a loop. This one composes one.
//
// WHAT CHANGED (§GFX-9)
// The previous version was a single drone plus occasional random plucks. It was
// atmospheric but it could not respond to anything: "intensity" only opened a
// filter, so a game at its most desperate moment sounded like the same pad,
// brighter. There was also no pulse at all, which is why nothing in the app
// ever felt like it was building.
//
// It is now a four-layer arrangement on a shared tempo grid:
//
//   PAD    always on. Continuous detuned oscillators through a breathing
//          lowpass — the old drone, kept, because it is what makes silence
//          between events feel intentional.
//   BASS   root movement on beats 1 and 3. Enters at intensity ≳ 0.15.
//   PERC   kick and hat on the grid. Enters at ≳ 0.30. This is the layer that
//          turns "ambience" into "a track".
//   ARP    sixteenth-note figure through the active scale. Enters at ≳ 0.50 —
//          deliberately last, so arrival of the arp reads as an escalation.
//
// Layers do not switch on and off; each has a level that CHASES its target
// every scheduler tick. A layer appearing mid-bar at full volume is jarring, and
// the whole point of an adaptive score is that the player notices the change in
// mood without noticing the mechanism.
//
// TWO CLOCKS. The scheduler is a setTimeout loop that runs ahead of the audio
// clock and books notes into the future by ABSOLUTE AudioContext time. A
// setTimeout that fired the note directly would put every note's timing at the
// mercy of main-thread jitter — in a Blazor WASM app, that means the groove
// stutters whenever .NET runs a GC. Nothing here plays a note "now"; it only
// ever books notes for a moment that has not arrived yet.
//
// SIDECHAIN. Each kick dips the pad's gain and recovers. This is what stops the
// low end turning to mud when the pad and the kick occupy the same octave, and
// it is most of why the loop breathes rather than drones.
//
// It rides the shared 'music' bus from audioBus.js, so global mute silences it,
// duck() dips it under foreground cues, and the analyser meters it for the
// audio-reactive visuals.

import * as AudioBus from './audioBus.js';
import * as Dsp from './dsp.js';

// Scales as semitone offsets from the root. The character difference between
// these is most of what makes the games sound distinct from one another.
const SCALES = {
    minorPentatonic: [0, 3, 5, 7, 10],
    majorPentatonic: [0, 2, 4, 7, 9],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    wholeTone: [0, 2, 4, 6, 8, 10],
    // Harmonic minor's augmented second between ♭6 and 7 is the most unstable
    // interval available inside a diatonic scale. Reserved for defeat states.
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

/**
 * MODES are what a *state change* does to the harmony. A game switching to
 * 'defeat' does not switch tracks — it re-points the scale and drops the root,
 * so the arrangement continues and the mood underneath it turns.
 */
const MODES = {
    neutral: { scale: null, transpose: 0, tempoScale: 1.00 },
    bright:  { scale: 'majorPentatonic', transpose: 0, tempoScale: 1.04 },
    tense:   { scale: 'aeolian', transpose: 0, tempoScale: 1.10 },
    defeat:  { scale: 'harmonicMinor', transpose: -3, tempoScale: 0.88 },
    triumph: { scale: 'lydian', transpose: 5, tempoScale: 1.06 },
};

// Per-game presets. Add a key here to give a game its own arrangement.
const PRESETS = {
    pojoker:      { root: 65.41, scale: 'dorian',          cutoff: 760, drift: 0.070, pluck: 0.85, wave: 'triangle', space: 'hall',     bpm: 96,  bassWave: 'triangle', arpWave: 'square' },
    poracer:      { root: 73.42, scale: 'wholeTone',       cutoff: 940, drift: 0.110, pluck: 0.25, wave: 'sawtooth', space: 'outdoor',  bpm: 132, bassWave: 'saw',      arpWave: 'square' },
    pomarblerace: { root: 49.00, scale: 'lydian',          cutoff: 640, drift: 0.050, pluck: 0.65, wave: 'triangle', space: 'tunnel',   bpm: 104, bassWave: 'triangle', arpWave: 'triangle' },
    pobrawl:      { root: 61.74, scale: 'aeolian',         cutoff: 720, drift: 0.080, pluck: 0.30, wave: 'sawtooth', space: 'arena',    bpm: 116, bassWave: 'saw',      arpWave: 'square' },
    posports:     { root: 65.41, scale: 'majorPentatonic', cutoff: 860, drift: 0.060, pluck: 0.50, wave: 'triangle', space: 'outdoor',  bpm: 124, bassWave: 'triangle', arpWave: 'sine' },
    tictactoe:    { root: 55.00, scale: 'majorPentatonic', cutoff: 780, drift: 0.040, pluck: 0.70, wave: 'triangle', space: 'tabletop', bpm: 92,  bassWave: 'triangle', arpWave: 'square' },
    connectfive:  { root: 52.00, scale: 'lydian',          cutoff: 720, drift: 0.040, pluck: 0.60, wave: 'triangle', space: 'tabletop', bpm: 88,  bassWave: 'square',   arpWave: 'triangle' },
    quiz:         { root: 58.27, scale: 'majorPentatonic', cutoff: 820, drift: 0.060, pluck: 0.70, wave: 'triangle', space: 'hall',     bpm: 98,  bassWave: 'triangle', arpWave: 'triangle' },
    board:        { root: 55.00, scale: 'lydian',          cutoff: 700, drift: 0.040, pluck: 0.60, wave: 'triangle', space: 'tabletop', bpm: 84,  bassWave: 'triangle', arpWave: 'triangle' },
    default:      { root: 58.27, scale: 'lydian',          cutoff: 680, drift: 0.055, pluck: 0.45, wave: 'triangle', space: 'room',     bpm: 88,  bassWave: 'triangle', arpWave: 'triangle' },
};

// Scheduler constants. LOOKAHEAD must comfortably exceed TICK_MS or a late
// timer callback lands after the note it was supposed to book.
const TICK_MS = 25;
const LOOKAHEAD = 0.14;      // seconds of music booked in advance
const STEPS_PER_BEAT = 4;    // sixteenth-note grid

// Layer entry points, as intensity thresholds, and the width of the ramp above
// each one. Staggered so layers arrive one at a time rather than all at 0.5.
const LAYER_CURVE = {
    pad:  { at: 0.00, width: 0.20, max: 1.00 },
    bass: { at: 0.15, width: 0.25, max: 0.90 },
    perc: { at: 0.30, width: 0.25, max: 0.85 },
    arp:  { at: 0.50, width: 0.30, max: 0.70 },
};

const LEVEL_CHASE = 0.035;   // per tick; ~1.5 s to cross a layer's full range

let _state = null;
let _tickTimer = null;
let _pluckTimer = null;

function midiRatio(semitones) {
    return Math.pow(2, semitones / 12);
}

/** Target level for a layer at a given intensity. */
function layerTarget(name, intensity) {
    const c = LAYER_CURVE[name];
    const t = (intensity - c.at) / c.width;
    return c.max * Math.max(0, Math.min(1, t));
}

/**
 * Start (or switch to) an arrangement.
 * @param {string} presetName key of PRESETS, e.g. 'pobrawl'
 * @param {number} [gain=0.14] overall level on the music bus (kept low on purpose)
 */
export async function start(presetName, gain) {
    const ctx = await AudioBus.context();
    const musicBus = await AudioBus.bus('music');
    if (!ctx || !musicBus) return false;

    // Switching arrangements crossfades rather than cutting.
    if (_state) await stop(1.2);

    // Warm the worklet before the first note is booked. If this is left to the
    // first play() call, that call falls back to the node path while the module
    // loads and the very first bar is synthesised differently from the rest.
    await Dsp.ready();

    const preset = PRESETS[presetName] || PRESETS.default;
    const level = gain == null ? 0.14 : gain;
    const t0 = ctx.currentTime;

    const bedGain = ctx.createGain();
    bedGain.gain.setValueAtTime(0, t0);
    bedGain.gain.linearRampToValueAtTime(level, t0 + 3.0); // slow fade-in, never a jump
    bedGain.connect(musicBus);

    // ── PAD ────────────────────────────────────────────────────────────
    // The one layer that stays as real, continuous AudioNodes. A drone is not a
    // sequence of notes, and re-triggering it on a grid would be audible as a
    // seam every bar no matter how long the release.
    const padGain = ctx.createGain();
    padGain.gain.value = 1;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = preset.cutoff;
    filter.Q.value = 1.4;
    filter.connect(padGain).connect(bedGain);

    // Three voices, slightly detuned so they beat against each other. Perfect
    // unison sounds synthetic and dead; a few cents of spread reads as "warm".
    const voices = [];
    const detunes = [-7, 0, 5];
    for (let i = 0; i < detunes.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = preset.wave;
        osc.frequency.value = preset.root * (i === 2 ? 2 : 1); // one voice an octave up
        osc.detune.value = detunes[i];
        const vg = ctx.createGain();
        vg.gain.value = i === 2 ? 0.28 : 0.5;
        osc.connect(vg).connect(filter);
        osc.start(t0);
        voices.push(osc);
    }

    // Cutoff LFO — the whole reason the pad doesn't sound static.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = preset.drift;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = preset.cutoff * 0.55;
    lfo.connect(lfoDepth).connect(filter.frequency);
    lfo.start(t0);

    _state = {
        ctx, preset, bedGain, padGain, filter, lfoDepth, voices, lfo, level,
        intensity: 0.35,
        mode: 'neutral',
        scaleName: preset.scale,
        transpose: 0,
        bpm: preset.bpm,
        step: 0,                       // sixteenth counter, monotonically rising
        nextStepTime: t0 + 0.12,
        levels: { pad: 1, bass: 0, perc: 0, arp: 0 },
        // Chosen per bar so the arp has a shape instead of being a random walk.
        arpDirection: 1,
        arpIndex: 0,
    };

    // The arrangement layers all target the music bus through dsp.js, so they
    // reach the same convolver as everything else; the space just needs setting.
    if (typeof window !== 'undefined' && window.PoAcoustics) {
        try { await window.PoAcoustics.setSpace(preset.space); } catch { /* optional */ }
    }

    startScheduler();
    schedulePluck();
    return true;
}

// ── Scheduler ──────────────────────────────────────────────────────────────

function startScheduler() {
    stopScheduler();
    _tickTimer = setInterval(tick, TICK_MS);
    tick();
}

function stopScheduler() {
    if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

function tick() {
    const s = _state;
    if (!s) return;
    const ctx = s.ctx;

    // Chase layer levels toward their intensity targets. Done here rather than
    // per note so a level is continuous across the bar line.
    for (const name of ['bass', 'perc', 'arp']) {
        const target = layerTarget(name, s.intensity);
        s.levels[name] += (target - s.levels[name]) * LEVEL_CHASE;
    }

    // The context can be suspended (tab backgrounded before a gesture, or the
    // browser throttling). currentTime stops advancing, and without this guard
    // the loop would book thousands of notes for the moment it resumes.
    if (ctx.state !== 'running') {
        s.nextStepTime = Math.max(s.nextStepTime, ctx.currentTime + 0.1);
        return;
    }

    // If the tab was hidden the timer stops firing and nextStepTime falls far
    // behind. Catching up note-by-note would dump the whole missed passage at
    // once, so skip forward to the grid instead.
    const stepDur = () => 60 / (s.bpm * MODES[s.mode].tempoScale) / STEPS_PER_BEAT;
    if (s.nextStepTime < ctx.currentTime - 0.5) {
        const missed = Math.floor((ctx.currentTime - s.nextStepTime) / stepDur());
        s.step += missed;
        s.nextStepTime += missed * stepDur();
    }

    while (s.nextStepTime < ctx.currentTime + LOOKAHEAD) {
        scheduleStep(s, s.step, s.nextStepTime);
        s.nextStepTime += stepDur();
        s.step++;
    }
}

/**
 * Book everything that happens on one sixteenth.
 * @param {object} s state
 * @param {number} step monotonic sixteenth index
 * @param {number} when absolute AudioContext time
 */
function scheduleStep(s, step, when) {
    if (AudioBus.isMuted()) return;
    const { preset } = s;
    const scale = SCALES[s.scaleName] || SCALES.lydian;
    const root = preset.root * midiRatio(s.transpose);

    const stepInBar = step % 16;
    const beat = Math.floor(stepInBar / STEPS_PER_BEAT);
    const onBeat = stepInBar % STEPS_PER_BEAT === 0;

    if (stepInBar === 0) {
        // New bar: occasionally reverse the arp so a long passage does not turn
        // into a hypnotic one-directional run.
        if (Math.random() < 0.35) s.arpDirection *= -1;
    }

    const notes = [];

    // ── PERC ───────────────────────────────────────────────────────────
    const percLevel = s.levels.perc;
    if (percLevel > 0.02) {
        // Kick on 1 and 3. Pitch sweeping 130 → 45 Hz over 90 ms IS the kick —
        // a fixed-pitch sine at 50 Hz is a hum, and the drop is what the ear
        // reads as a struck membrane.
        if (onBeat && (beat === 0 || beat === 2)) {
            notes.push({
                wave: 'sine', freq: 130, freqEnd: 45, sweep: 0.09,
                dur: 0.11, attack: 0.001, decay: 0.10, release: 0.05,
                gain: 0.42 * percLevel, drive: 0.35, at: when,
            });
            sidechain(s, when);
        }
        // Hat on the offbeat eighths. Highpassed noise: a lowpass would leave
        // the body of the noise in, which reads as a snare, not a hat. There is
        // no highpass in the voice model, so a short, bright, fast-decaying
        // noise burst with a high resonant cutoff stands in for one.
        if (stepInBar % 4 === 2) {
            notes.push({
                wave: 'noise', dur: 0.035, attack: 0.001, decay: 0.03, release: 0.02,
                cutoff: 9000, cutoffEnd: 6500, q: 1.2,
                gain: 0.10 * percLevel, pan: (step % 8 === 2 ? -0.25 : 0.25), at: when,
            });
        }
        // Backbeat clap on 2 and 4, only once the track is really running.
        if (onBeat && (beat === 1 || beat === 3) && percLevel > 0.5) {
            notes.push({
                wave: 'noise', dur: 0.09, attack: 0.002, decay: 0.08, release: 0.06,
                cutoff: 2600, cutoffEnd: 1400, q: 2.4,
                gain: 0.16 * percLevel, at: when,
            });
        }
    }

    // ── BASS ───────────────────────────────────────────────────────────
    const bassLevel = s.levels.bass;
    if (bassLevel > 0.02 && onBeat && (beat === 0 || beat === 2)) {
        // Root on 1, fifth on 3 — the minimum movement that still counts as a
        // bass line rather than a pedal tone.
        const degree = beat === 0 ? 0 : scale[Math.min(2, scale.length - 1)];
        notes.push({
            wave: preset.bassWave,
            freq: root * midiRatio(degree),
            dur: 0.34, attack: 0.008, decay: 0.30, sustain: 0.25, release: 0.14,
            cutoff: 340 + s.intensity * 520, cutoffEnd: 190, q: 3.2,
            gain: 0.20 * bassLevel, drive: 0.22, at: when,
        });
    }

    // ── ARP ────────────────────────────────────────────────────────────
    const arpLevel = s.levels.arp;
    if (arpLevel > 0.02) {
        s.arpIndex += s.arpDirection;
        const idx = ((s.arpIndex % scale.length) + scale.length) % scale.length;
        const octave = 3 + (step % 8 < 4 ? 0 : 1);
        notes.push({
            wave: preset.arpWave,
            freq: root * Math.pow(2, octave) * midiRatio(scale[idx]),
            dur: 0.07, attack: 0.003, decay: 0.06, release: 0.05,
            cutoff: 1800 + s.intensity * 3200, q: 2.0,
            // Ping-pong the pan across the grid. A static arp sits in the
            // middle and fights the pad for the same space.
            pan: (step % 2 === 0 ? -0.4 : 0.4),
            gain: 0.075 * arpLevel, at: when,
        });
    }

    if (notes.length) Dsp.playAll(notes, 'music');
}

/**
 * Dip the pad under the kick and let it recover — a real sidechain, not a
 * volume automation curve. The recovery is slower than the dip, which is what
 * produces the "pump" rather than a click.
 */
function sidechain(s, when) {
    try {
        const g = s.padGain.gain;
        g.cancelScheduledValues(when);
        g.setValueAtTime(g.value, when);
        g.linearRampToValueAtTime(1 - 0.45 * s.levels.perc, when + 0.012);
        g.linearRampToValueAtTime(1, when + 0.24);
    } catch { /* node torn down mid-schedule */ }
}

/**
 * Occasional single notes over the arrangement, at irregular intervals so the
 * ear never locks onto a loop. Unlike the sequenced layers this is deliberately
 * NOT on the grid — it is the one element that floats free of the tempo, which
 * is what keeps the whole thing from sounding mechanical.
 */
function schedulePluck() {
    if (!_state) return;
    const base = 2600 - _state.intensity * 1500;
    const wait = base + Math.random() * base * 0.8;
    _pluckTimer = setTimeout(() => {
        pluck();
        schedulePluck();
    }, wait);
}

function pluck() {
    const s = _state;
    if (!s || AudioBus.isMuted()) return;
    const { preset, intensity } = s;
    if (Math.random() > preset.pluck) return;

    const scale = SCALES[s.scaleName] || SCALES.lydian;
    const octave = 2 + Math.floor(Math.random() * 2) + (intensity > 0.7 ? 1 : 0);
    const degree = scale[Math.floor(Math.random() * scale.length)];
    const root = preset.root * midiRatio(s.transpose);

    Dsp.play({
        wave: 'triangle',
        freq: root * Math.pow(2, octave) * midiRatio(degree),
        dur: 1.6 + Math.random() * 1.8,
        attack: 0.02, decay: 1.4, release: 0.6,
        cutoff: 2600, q: 1.1,
        gain: 0.13,
        pan: (Math.random() * 2 - 1) * 0.7,
    }, 'music');
}

/**
 * Steer the arrangement from game state. A game drives this from
 * agents-remaining, so the music thickens as the battle thins out. It is also the handle
 * the music director rides for its menu / lobby / match / verdict states: the layer mixer's
 * per-tick chase picks the new value up on its own.
 *
 * There must be exactly one of these. A second `export function setIntensity` further down
 * (2026-10-01: found and removed) made the whole module a SyntaxError, so nothing could
 * import it and the app had no shared soundtrack at all.
 * @param {number} value 0 (calm) .. 1 (tense)
 */
export async function setIntensity(value) {
    if (!_state) return;
    const v = Math.max(0, Math.min(1, value));
    _state.intensity = v;
    const { ctx, preset, filter, lfoDepth } = _state;
    const t = ctx.currentTime;
    // Open the pad's filter and widen its sweep as things get tense. The layer
    // levels are handled by the scheduler's chase, not here.
    filter.frequency.setTargetAtTime(preset.cutoff * (1 + v * 1.6), t, 1.5);
    lfoDepth.gain.setTargetAtTime(preset.cutoff * (0.55 + v * 0.5), t, 1.5);
}

/**
 * Change the harmonic mode — the score's response to a *state*, as opposed to
 * intensity's response to a *level*. Call this on winning/losing/final-round,
 * not on every score change.
 * @param {'neutral'|'bright'|'tense'|'defeat'|'triumph'} name
 */
export async function setMode(name) {
    const s = _state;
    if (!s) return;
    const mode = MODES[name];
    if (!mode) return;
    s.mode = name;
    s.scaleName = mode.scale || s.preset.scale;
    s.transpose = mode.transpose;

    // Slide the pad to the new root rather than jumping. The pad is continuous,
    // so a step change in its frequency is an audible glitch — the sequenced
    // layers just start using the new root on their next note.
    const t = s.ctx.currentTime;
    const ratio = midiRatio(mode.transpose);
    for (let i = 0; i < s.voices.length; i++) {
        const base = s.preset.root * (i === 2 ? 2 : 1);
        try { s.voices[i].frequency.setTargetAtTime(base * ratio, t, 0.9); } catch { /* stopped */ }
    }
}

/** Override the tempo. Omit to return to the preset's own. */
export function setTempo(bpm) {
    if (!_state) return;
    _state.bpm = bpm == null ? _state.preset.bpm : Math.max(40, Math.min(200, bpm));
}

/**
 * Fade out and tear down. Always call on page teardown — an orphaned oscillator
 * keeps the audio thread alive for the life of the tab.
 * @param {number} [fadeSec=1.5]
 */
export async function stop(fadeSec) {
    if (!_state) return;
    const s = _state;
    _state = null;
    stopScheduler();
    if (_pluckTimer) { clearTimeout(_pluckTimer); _pluckTimer = null; }

    const { ctx, voices, lfo, bedGain } = s;
    const t = ctx.currentTime;
    const fade = fadeSec == null ? 1.5 : fadeSec;
    try {
        bedGain.gain.cancelScheduledValues(t);
        bedGain.gain.setValueAtTime(bedGain.gain.value, t);
        bedGain.gain.linearRampToValueAtTime(0.0001, t + fade);
    } catch { /* node may already be gone */ }

    setTimeout(() => {
        try { for (const v of voices) v.stop(); } catch { /* already stopped */ }
        try { lfo.stop(); } catch { /* already stopped */ }
        try {
            s.filter.disconnect();
            s.padGain.disconnect();
            s.bedGain.disconnect();
        } catch { /* already detached */ }
    }, (fade + 0.1) * 1000);
}

export function isPlaying() {
    return !!_state;
}

/** Current sixteenth-note index — for visuals that want to pulse on the grid. */
export function currentStep() {
    return _state ? _state.step : 0;
}

if (typeof window !== 'undefined') {
    window.PoAmbientMusic = {
        start, stop, setIntensity, setMode, setTempo, isPlaying, currentStep,
    };
}
