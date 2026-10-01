// gameCues.js — the app's sound vocabulary (§GFX-11).
//
// WHY A TABLE AND NOT CALL SITES
// Before this, "the sound a game makes" was 900 Hz here, a triangle burst
// there, and `playTone(660, 50, 0.06)` in a click handler. Ten games all
// sounded like the same three oscillators because they all *were* the same
// three oscillators, and nothing carried a game's identity.
//
// A cue is now data: a list of voices (see dsp.js) plus what should happen to
// the screen at the same instant. That last part is the important one. A hit is
// not a sound and separately a shake and separately some sparks — it is ONE
// event, and describing it in one place is what keeps the three in sync. Fire a
// cue and the audio, the impact envelope and the particles all leave together.
//
// EVERY GAME HAS A TIMBRE FAMILY, chosen so you could identify the game blind:
//
//   tictactoe   struck wood — fast attack, short pitched decay, no sustain
//   connectfive hard plastic on plastic, low body, high click
//   pobrawl     heavy, driven, low-mid; everything has weight and grit
//   pomarblerace glass and steel — bright, ringing, clean
//   poracer     motorised — saws, filter sweeps, no pitched melody at all
//   posports    rubber and air — bouncy sine blips, whistle
//   pojoker     courtly brass and bells; square waves, dotted rhythms
//   quiz        bright bell-tones, unambiguous right/wrong
//
// PITCH JITTER: every cue is detuned by a small random amount on each play.
// Without it, a rapid sequence of identical cues (a combo, a fast quiz round,
// twelve marbles landing) sounds like a machine gun firing one sample. This is
// the single cheapest thing that makes generated audio stop sounding generated.

import * as Dsp from './dsp.js';
import * as AudioBus from './audioBus.js';
import * as Impact from './impactBus.js';
import * as Fx from './gpuFx.js';

/** Semitone → frequency ratio. */
const R = (s) => Math.pow(2, s / 12);

/**
 * Shorthand for a voice. Keeps the table below readable — the alternative is
 * 400 lines of object literals in which the actual musical content is invisible.
 */
function v(wave, freq, dur, gain, extra) {
    return { wave, freq, dur, gain, ...(extra || {}) };
}

/**
 * The vocabulary.
 *
 *   voices — dsp.js descriptors; `delay` staggers them within the cue
 *   feel   — impactBus kind, or null for silent-on-screen cues
 *   scale  — impact strength multiplier
 *   fx     — { preset, scale } for a gpuFx burst at the event position
 *   jitter — semitones of random detune (default 0.35)
 *   bus    — 'ui' | 'sfx' | 'music' (default 'sfx', 'ui' for the ui scope)
 *   duck   — dip the music under this cue by this much
 */
const CUES = {
    // ── Shared UI ──────────────────────────────────────────────────────
    ui: {
        tap: { voices: [v('sine', 880, 0.045, 0.055, { decay: 0.04, attack: 0.001 })], feel: 'tick' },
        confirm: {
            voices: [
                v('triangle', 660, 0.05, 0.06, { decay: 0.045 }),
                v('triangle', 990, 0.07, 0.05, { decay: 0.06, delay: 0.045 }),
            ],
            feel: 'select',
        },
        back: {
            // A downward sweep for "leaving". Direction is the whole message —
            // players read rising as forward and falling as backward without
            // ever being told.
            voices: [v('triangle', 620, 0.13, 0.055, { freqEnd: 300, sweep: 0.12, decay: 0.12 })],
            feel: 'tick',
        },
        error: {
            voices: [
                v('square', 190, 0.16, 0.07, { decay: 0.14, cutoff: 1200, q: 2, drive: 0.3 }),
                v('square', 179, 0.18, 0.05, { decay: 0.16, cutoff: 1000, q: 2, delay: 0.02 }),
            ],
            // The two voices are 11 Hz apart on purpose: the beating between
            // them is dissonant in a way a single detuned tone is not.
            feel: 'light', scale: 0.7,
        },
        toggle: { voices: [v('square', 1200, 0.03, 0.04, { decay: 0.025, cutoff: 4000 })], feel: 'tick' },
        open: { voices: [v('sine', 320, 0.22, 0.05, { freqEnd: 720, sweep: 0.2, decay: 0.2 })], feel: null },
        close: { voices: [v('sine', 720, 0.18, 0.045, { freqEnd: 300, sweep: 0.16, decay: 0.16 })], feel: null },
        focus: { voices: [v('sine', 1320, 0.025, 0.028, { decay: 0.02 })], feel: null, jitter: 0 },
        subdrop: {
            voices: [
                v('sine', 110, 0.70, 0.42, { freqEnd: 36, sweep: 0.65, decay: 0.65 }),
                v('noise', 0, 0.20, 0.12, { decay: 0.18, cutoff: 600, cutoffEnd: 80, q: 2 }),
            ],
            feel: 'heavy', scale: 1.5, fx: { preset: 'impact', scale: 1.3 }, duck: 0.5,
        },
        chime: {
            voices: [
                v('sine', 1046, 0.15, 0.12, { decay: 0.14 }),
                v('sine', 1318, 0.15, 0.12, { decay: 0.14, delay: 0.06 }),
                v('sine', 1567, 0.35, 0.14, { decay: 0.32, delay: 0.12 }),
            ],
            feel: 'select', fx: { preset: 'sparks', scale: 0.7 },
        },
        crystalPing: {
            voices: [
                v('sine', 1760, 0.10, 0.16, { decay: 0.08 }),
                v('sine', 3520, 0.06, 0.08, { decay: 0.04, delay: 0.002 }),
            ],
            feel: 'tick', jitter: 0.5,
        },
        magneticSnap: {
            voices: [
                v('square', 1400, 0.02, 0.04, { decay: 0.015, cutoff: 4000 }),
                v('square', 1800, 0.02, 0.03, { decay: 0.015, cutoff: 5000, delay: 0.012 }),
            ],
            feel: 'tick', scale: 0.5,
        },
        fluidRipple: {
            voices: [v('sine', 640, 0.06, 0.08, { freqEnd: 420, sweep: 0.05, decay: 0.05 })],
            feel: 'tick', jitter: 1.0,
        },
        glassResonate: {
            voices: [
                v('sine', 523.25, 0.28, 0.12, { freqEnd: 526, sweep: 0.25, decay: 0.26 }),
                v('sine', 1046.5, 0.20, 0.06, { decay: 0.18, delay: 0.01 }),
            ],
            feel: null, jitter: 0.2,
        },
        holoShimmer: {
            voices: [
                v('modal', 1760, 0.22, 0.08, { material: 'glass', damping: 0.8 }),
                v('sine', 2640, 0.16, 0.05, { decay: 0.14, delay: 0.025 }),
                v('sine', 3520, 0.12, 0.04, { decay: 0.10, delay: 0.05 }),
            ],
            feel: null, jitter: 0.3, bus: 'ui',
        },
        vortexImplosion: {
            voices: [
                v('noise', 0, 0.35, 0.18, { cutoff: 6500, cutoffEnd: 60, q: 3.5, sweep: 0.35, decay: 0.35 }),
                v('sine', 160, 0.32, 0.22, { freqEnd: 42, sweep: 0.32, decay: 0.32, delay: 0.05 }),
            ],
            feel: 'heavy', scale: 0.9, bus: 'ui',
        },
    },

    // ── TicTacToe — struck wood & neon laser ───────────────────────────
    tictactoe: {
        placeX: {
            // Hand-struck solid maple wood peg modal resonance
            voices: [
                v('modal', 480, 0.18, 0.22, { material: 'wood', damping: 1.2 }),
                v('pluck', 523, 0.14, 0.14, { damping: 0.95 }),
                v('noise', 0, 0.015, 0.08, { decay: 0.012, cutoff: 4200, q: 1.5 }),
            ],
            feel: 'light', fx: { preset: 'dust', scale: 0.6 },
        },
        placeO: {
            voices: [
                v('modal', 400, 0.20, 0.22, { material: 'wood', damping: 1.1 }),
                v('pluck', 440, 0.16, 0.14, { damping: 0.94 }),
                v('noise', 0, 0.015, 0.08, { decay: 0.012, cutoff: 3800, q: 1.5 }),
            ],
            feel: 'light', fx: { preset: 'dust', scale: 0.6 },
        },
        laserLine: {
            voices: [
                v('saw', 440, 0.40, 0.16, { freqEnd: 1760, sweep: 0.35, decay: 0.35, cutoff: 3600, q: 4, drive: 0.3 }),
                v('sine', 880, 0.35, 0.14, { freqEnd: 2640, sweep: 0.32, decay: 0.32 }),
            ],
            feel: 'select', fx: { preset: 'sparks', scale: 1.2 },
        },
        win: {
            voices: [
                v('triangle', 523, 0.16, 0.16, { decay: 0.14 }),
                v('triangle', 659, 0.16, 0.16, { decay: 0.14, delay: 0.11 }),
                v('triangle', 784, 0.16, 0.16, { decay: 0.14, delay: 0.22 }),
                v('triangle', 1046, 0.55, 0.18, { decay: 0.5, delay: 0.33 }),
            ],
            feel: 'win', fx: { preset: 'confetti', scale: 1 }, duck: 0.4,
        },
        draw: {
            voices: [
                v('triangle', 466, 0.30, 0.12, { decay: 0.28 }),
                v('triangle', 415, 0.40, 0.12, { decay: 0.38, delay: 0.16 }),
            ],
            feel: 'select',
        },
    },

    // ── ConnectFive — hard plastic & resonant drops ─────────────────────
    connectfive: {
        hover: { voices: [v('sine', 700, 0.03, 0.03, { decay: 0.025 })], feel: null, bus: 'ui' },
        drop: {
            voices: [v('noise', 0, 0.30, 0.10, { decay: 0.28, cutoff: 1600, cutoffEnd: 420, q: 1.2, sweep: 0.3 })],
            feel: null,
        },
        land: {
            // Hollow ceramic chip clatter: resonant modal body + multi-bounce click
            voices: [
                v('modal', 520, 0.18, 0.24, { material: 'ceramic', damping: 1.3 }),
                v('sine', 160, 0.12, 0.20, { freqEnd: 110, sweep: 0.1, decay: 0.11 }),
                v('modal', 780, 0.08, 0.12, { material: 'ceramic', damping: 2.0, delay: 0.015 }),
                v('noise', 0, 0.03, 0.08, { decay: 0.025, cutoff: 4200, q: 1.8 }),
            ],
            feel: 'light', scale: 0.8, fx: { preset: 'dust', scale: 0.5 },
        },
        laserLine: {
            voices: [
                v('saw', 523, 0.45, 0.18, { freqEnd: 2093, sweep: 0.40, decay: 0.40, cutoff: 4000, q: 5, drive: 0.35 }),
                v('sine', 1046, 0.40, 0.15, { freqEnd: 3136, sweep: 0.38, decay: 0.38 }),
            ],
            feel: 'select', fx: { preset: 'sparks', scale: 1.4 },
        },
        win: {
            voices: [
                v('square', 392, 0.10, 0.11, { decay: 0.09, cutoff: 2600 }),
                v('square', 523, 0.10, 0.11, { decay: 0.09, cutoff: 2800, delay: 0.08 }),
                v('square', 659, 0.10, 0.11, { decay: 0.09, cutoff: 3000, delay: 0.16 }),
                v('square', 784, 0.50, 0.13, { decay: 0.46, cutoff: 3400, delay: 0.24 }),
            ],
            feel: 'win', fx: { preset: 'confetti', scale: 1 }, duck: 0.4,
        },
    },

    // ── PoBrawl — heavy and driven ─────────────────────────────────────
    pobrawl: {
        hitLight: {
            voices: [
                v('sine', 180, 0.09, 0.26, { freqEnd: 90, sweep: 0.07, decay: 0.08, drive: 0.5 }),
                v('noise', 0, 0.05, 0.14, { decay: 0.04, cutoff: 3400, cutoffEnd: 1200, q: 1.6 }),
            ],
            feel: 'light', fx: { preset: 'impact', scale: 0.7 },
        },
        hitHeavy: {
            voices: [
                v('sine', 130, 0.20, 0.34, { freqEnd: 48, sweep: 0.16, decay: 0.18, drive: 0.75 }),
                v('noise', 0, 0.13, 0.20, { decay: 0.11, cutoff: 2200, cutoffEnd: 500, q: 2.2 }),
                v('square', 92, 0.16, 0.12, { decay: 0.14, cutoff: 700, q: 3, drive: 0.6, delay: 0.008 }),
            ],
            feel: 'heavy', fx: { preset: 'impact', scale: 1.4 }, duck: 0.35,
        },
        shockwave: {
            voices: [
                v('sine', 90, 0.50, 0.38, { freqEnd: 32, sweep: 0.45, decay: 0.45, drive: 0.8 }),
                v('noise', 0, 0.30, 0.22, { decay: 0.28, cutoff: 1800, cutoffEnd: 120, q: 3 }),
            ],
            feel: 'heavy', scale: 1.5, fx: { preset: 'impact', scale: 1.8 }, duck: 0.5,
        },
        block: {
            voices: [v('noise', 0, 0.16, 0.16, { decay: 0.15, cutoff: 2800, cutoffEnd: 2200, q: 12 })],
            feel: 'light', scale: 0.6, fx: { preset: 'sparks', scale: 0.8 },
        },
        ko: {
            voices: [
                v('sine', 110, 0.55, 0.40, { freqEnd: 32, sweep: 0.5, decay: 0.5, drive: 0.6 }),
                v('noise', 0, 0.40, 0.18, { decay: 0.38, cutoff: 1600, cutoffEnd: 200, q: 1.4 }),
                v('square', 220, 0.30, 0.10, { freqEnd: 55, sweep: 0.28, decay: 0.28, cutoff: 900, drive: 0.8, delay: 0.05 }),
            ],
            feel: 'heavy', scale: 1.6, fx: { preset: 'impact', scale: 2 }, duck: 0.6,
        },
    },

    // ── PoMarbleRace — glass and steel ─────────────────────────────────
    pomarblerace: {
        click: {
            voices: [
                v('sine', 2400, 0.03, 0.09, { decay: 0.025 }),
                v('sine', 3600, 0.02, 0.05, { decay: 0.015, delay: 0.002 }),
            ],
            feel: null, jitter: 1.6,
        },
        collide: {
            // Tempered steel ball-bearing impact: ringing modal metal modes
            voices: [
                v('modal', 1650, 0.16, 0.18, { material: 'metal', damping: 0.85 }),
                v('modal', 3300, 0.10, 0.09, { material: 'metal', damping: 1.2, delay: 0.002 }),
                v('noise', 0, 0.02, 0.08, { decay: 0.015, cutoff: 8000, q: 2.5 }),
            ],
            feel: 'tick', jitter: 2.2, fx: { preset: 'sparks', scale: 0.4 },
        },
        finish: {
            voices: [
                v('sine', 1319, 0.12, 0.14, { decay: 0.11 }),
                v('sine', 1760, 0.12, 0.14, { decay: 0.11, delay: 0.09 }),
                v('sine', 2637, 0.70, 0.16, { decay: 0.65, delay: 0.18 }),
            ],
            feel: 'win', fx: { preset: 'confetti', scale: 1.2 }, duck: 0.45,
        },
    },

    // ── PoRacer — motorised, synthwave engine ───────────────────────────
    // fx particle bursts removed 2026-09-17 (user request): every cue fired
    // mid-rake bursts at the viewport centre, which is exactly where the
    // camera keeps your car, so the sparks/smoke read as effects around the
    // cars. Sounds and screen feel are unchanged.
    poracer: {
        shift: {
            voices: [v('saw', 220, 0.09, 0.10, { freqEnd: 340, sweep: 0.08, decay: 0.08, cutoff: 1400, q: 3, drive: 0.4 })],
            feel: 'tick',
        },
        rev: {
            voices: [
                v('saw', 90, 0.25, 0.16, { freqEnd: 240, sweep: 0.22, decay: 0.22, cutoff: 1800, q: 2, drive: 0.5 }),
            ],
            feel: null,
        },
        turbo: {
            voices: [
                v('noise', 0, 0.25, 0.12, { decay: 0.22, cutoff: 4000, cutoffEnd: 8000, q: 4, sweep: 0.2 }),
                v('sine', 880, 0.20, 0.08, { freqEnd: 1760, sweep: 0.18, decay: 0.18 }),
            ],
            feel: 'tick',
        },
        skid: {
            voices: [v('noise', 0, 0.42, 0.13, { decay: 0.40, cutoff: 2600, cutoffEnd: 900, q: 6, sweep: 0.4 })],
            feel: null,
        },
        boost: {
            voices: [
                v('saw', 140, 0.45, 0.15, { freqEnd: 620, sweep: 0.42, decay: 0.42, cutoff: 700, cutoffEnd: 5200, q: 4, drive: 0.5 }),
                v('noise', 0, 0.45, 0.09, { decay: 0.42, cutoff: 900, cutoffEnd: 6000, q: 1.5, sweep: 0.42 }),
            ],
            feel: 'medium', duck: 0.3,
        },
        crash: {
            voices: [
                v('noise', 0, 0.50, 0.26, { decay: 0.48, cutoff: 4200, cutoffEnd: 260, q: 1.1, sweep: 0.45 }),
                v('sine', 96, 0.30, 0.26, { freqEnd: 40, sweep: 0.28, decay: 0.28, drive: 0.7 }),
            ],
            // 'medium', not 'heavy': heavy throws a shockwave from the centre of the viewport,
            // which is where the camera keeps your car. Same reasoning as the fx note above.
            feel: 'medium', duck: 0.5,
        },
        // Start gantry: one of these per lamp as it comes on (js/poracer/audio.js `lights`).
        light: {
            voices: [v('square', 520, 0.11, 0.09, { decay: 0.10, cutoff: 2600 })],
            feel: null, jitter: 0,
        },
        checkpoint: {
            voices: [
                v('square', 1046, 0.06, 0.09, { decay: 0.05, cutoff: 4000 }),
                v('square', 1568, 0.10, 0.09, { decay: 0.09, cutoff: 5000, delay: 0.06 }),
            ],
            feel: 'select',
        },
        speedDemon: {
            voices: [
                v('saw', 320, 0.35, 0.16, { freqEnd: 980, sweep: 0.32, decay: 0.32, cutoff: 3500, q: 4, drive: 0.5 }),
                v('sine', 1400, 0.25, 0.08, { freqEnd: 2800, sweep: 0.22, decay: 0.22 }),
            ],
            feel: 'select', duck: 0.3,
        },
        dopplerPass: {
            voices: [
                v('saw', 480, 0.40, 0.14, { freqEnd: 220, sweep: 0.35, decay: 0.38, cutoff: 2400, q: 3 }),
            ],
            feel: 'tick', jitter: 0.8,
        },
        boostPad: {
            voices: [
                v('saw', 160, 0.50, 0.18, { freqEnd: 740, sweep: 0.45, decay: 0.45, cutoff: 800, cutoffEnd: 6000, q: 4.5, drive: 0.6 }),
                v('sine', 440, 0.35, 0.12, { freqEnd: 1320, sweep: 0.30, decay: 0.30 }),
                v('noise', 0, 0.40, 0.10, { decay: 0.38, cutoff: 1200, cutoffEnd: 7000, q: 2, sweep: 0.38 }),
            ],
            feel: 'medium', duck: 0.35,
        },
        sandDrift: {
            voices: [
                v('noise', 0, 0.45, 0.15, { decay: 0.42, cutoff: 1400, cutoffEnd: 400, q: 2.5, sweep: 0.38 }),
                v('saw', 65, 0.35, 0.08, { freqEnd: 45, sweep: 0.30, decay: 0.30, cutoff: 400 }),
            ],
            feel: 'tick',
        },
    },

    // ── PoSports — rubber, air & stadium crowd ─────────────────────────
    posports: {
        kick: {
            voices: [
                v('sine', 420, 0.07, 0.20, { freqEnd: 180, sweep: 0.06, decay: 0.06 }),
                v('noise', 0, 0.03, 0.08, { decay: 0.025, cutoff: 2600, q: 1.2 }),
            ],
            feel: 'light', jitter: 1.2,
        },
        stride: {
            voices: [
                v('noise', 0, 0.04, 0.06, { decay: 0.035, cutoff: 1400, q: 1.2 }),
                v('sine', 160, 0.04, 0.08, { decay: 0.035 }),
            ],
            feel: null, fx: { preset: 'dust', scale: 0.3 },
        },
        crowdCheer: {
            voices: [
                v('noise', 0, 0.65, 0.16, { decay: 0.60, cutoff: 1800, cutoffEnd: 3200, q: 1.8, sweep: 0.55 }),
                v('triangle', 330, 0.40, 0.08, { decay: 0.35, delay: 0.1 }),
            ],
            feel: 'select', duck: 0.2,
        },
        bounce: {
            voices: [v('sine', 620, 0.05, 0.12, { freqEnd: 380, sweep: 0.045, decay: 0.045 })],
            feel: 'tick', jitter: 2,
        },
        goal: {
            voices: [
                v('square', 523, 0.09, 0.12, { decay: 0.08, cutoff: 3000 }),
                v('square', 784, 0.09, 0.12, { decay: 0.08, cutoff: 3200, delay: 0.07 }),
                v('square', 1046, 0.45, 0.14, { decay: 0.42, cutoff: 3600, delay: 0.14 }),
            ],
            feel: 'win', fx: { preset: 'confetti', scale: 0.9 }, duck: 0.4,
        },
        whistle: {
            voices: [
                v('sine', 2100, 0.35, 0.09, { decay: 0.33, lfoRate: 26, lfoDepth: 0.5 }),
                v('sine', 2640, 0.35, 0.06, { decay: 0.33, lfoRate: 26, lfoDepth: 0.5 }),
            ],
            feel: 'select',
        },
    },

    // ── PoJoker — comedy stage & responsive crowd ──────────────────────
    pojoker: {
        deal: {
            voices: [v('noise', 0, 0.06, 0.08, { decay: 0.05, cutoff: 4200, cutoffEnd: 2200, q: 1.6, sweep: 0.05 })],
            feel: 'tick', jitter: 1.5,
        },
        select: {
            voices: [v('square', 784, 0.05, 0.07, { decay: 0.04, cutoff: 3000 })],
            feel: 'select', bus: 'ui',
        },
        giggle: {
            voices: [
                v('sine', 600, 0.08, 0.08, { decay: 0.07, lfoRate: 14, lfoDepth: 0.6 }),
                v('sine', 750, 0.08, 0.08, { decay: 0.07, delay: 0.09, lfoRate: 16, lfoDepth: 0.6 }),
                v('sine', 900, 0.12, 0.09, { decay: 0.10, delay: 0.18, lfoRate: 18, lfoDepth: 0.6 }),
            ],
            feel: null,
        },
        laugh: {
            voices: [
                v('noise', 0, 0.55, 0.14, { decay: 0.50, cutoff: 1400, cutoffEnd: 2600, q: 2 }),
                v('triangle', 440, 0.35, 0.09, { decay: 0.32, lfoRate: 12, lfoDepth: 0.7, delay: 0.05 }),
            ],
            feel: 'select', fx: { preset: 'coins', scale: 0.8 },
        },
        rimshot: {
            voices: [
                v('noise', 0, 0.08, 0.22, { decay: 0.07, cutoff: 4800, q: 1.2 }),
                v('sine', 280, 0.09, 0.20, { freqEnd: 120, sweep: 0.07, decay: 0.08 }),
                v('noise', 0, 0.35, 0.16, { decay: 0.32, cutoff: 7200, q: 2, delay: 0.12 }),
            ],
            feel: 'tick', fx: { preset: 'sparks', scale: 0.6 },
        },
        coin: {
            voices: [
                v('sine', 2093, 0.09, 0.10, { decay: 0.08 }),
                v('sine', 3136, 0.13, 0.07, { decay: 0.12, delay: 0.03 }),
            ],
            feel: 'tick', jitter: 2.4, fx: { preset: 'coins', scale: 0.7 },
        },
        fanfare: {
            voices: [
                v('square', 523, 0.14, 0.11, { decay: 0.12, cutoff: 2600, drive: 0.25 }),
                v('square', 523, 0.07, 0.11, { decay: 0.06, cutoff: 2600, drive: 0.25, delay: 0.16 }),
                v('square', 659, 0.14, 0.11, { decay: 0.12, cutoff: 2800, drive: 0.25, delay: 0.24 }),
                v('square', 784, 0.55, 0.13, { decay: 0.5, cutoff: 3200, drive: 0.25, delay: 0.40 }),
            ],
            feel: 'win', fx: { preset: 'coins', scale: 1.4 }, duck: 0.5,
        },
        bust: {
            voices: [
                v('square', 330, 0.35, 0.11, { freqEnd: 110, sweep: 0.33, decay: 0.32, cutoff: 1400, q: 2, drive: 0.4 }),
            ],
            feel: 'lose', duck: 0.4,
        },
    },

    // ── Quizzes — unambiguous bells & harmonic streaks ──────────────────
    quiz: {
        tick: { voices: [v('sine', 1400, 0.02, 0.035, { decay: 0.015 })], feel: null, jitter: 0 },
        streakChime: {
            voices: [
                v('sine', 523, 0.08, 0.10, { decay: 0.07 }),
                v('sine', 659, 0.08, 0.10, { decay: 0.07, delay: 0.05 }),
                v('sine', 784, 0.08, 0.10, { decay: 0.07, delay: 0.10 }),
                v('sine', 1046, 0.35, 0.12, { decay: 0.32, delay: 0.15 }),
            ],
            feel: 'select', fx: { preset: 'sparks', scale: 1.1 },
        },
        correct: {
            voices: [
                v('sine', 880, 0.10, 0.11, { decay: 0.09 }),
                v('sine', 1109, 0.10, 0.11, { decay: 0.09, delay: 0.07 }),
                v('sine', 1319, 0.40, 0.12, { decay: 0.38, delay: 0.14 }),
            ],
            feel: 'select', fx: { preset: 'sparks', scale: 0.8 },
        },
        wrong: {
            voices: [
                v('square', 220, 0.22, 0.09, { freqEnd: 165, sweep: 0.2, decay: 0.2, cutoff: 1100, q: 2 }),
            ],
            feel: 'light', scale: 0.8,
        },
        timeout: {
            voices: [
                v('triangle', 392, 0.18, 0.10, { decay: 0.16 }),
                v('triangle', 311, 0.45, 0.10, { decay: 0.42, delay: 0.16 }),
            ],
            feel: 'lose', scale: 0.6,
        },
        reveal: {
            voices: [v('sine', 660, 0.30, 0.08, { freqEnd: 1320, sweep: 0.28, decay: 0.27 })],
            feel: null,
        },
    },

    // ── PoEcosystem — living biome, geopolitics & divine presence ─────
    poecosystem: {
        shockwave: {
            voices: [
                v('sine', 140, 0.55, 0.42, { freqEnd: 28, sweep: 0.5, decay: 0.5, drive: 0.8 }),
                v('noise', 0, 0.28, 0.18, { decay: 0.25, cutoff: 1400, cutoffEnd: 100, q: 2.5 }),
            ],
            feel: 'heavy', scale: 1.6, fx: { preset: 'dust', scale: 1.5 }, duck: 0.45,
        },
        godFinger: {
            voices: [
                v('sine', 880, 0.12, 0.18, { freqEnd: 1760, sweep: 0.1, decay: 0.12 }),
                v('triangle', 440, 0.22, 0.15, { decay: 0.2 }),
            ],
            feel: 'select', scale: 0.9, fx: { preset: 'sparks', scale: 1.1 },
        },
        diplomacyWar: {
            voices: [
                v('saw', 110, 0.65, 0.24, { freqEnd: 82, sweep: 0.6, decay: 0.6, cutoff: 900, q: 3, drive: 0.6 }),
                v('sine', 77.78, 0.65, 0.28, { decay: 0.6, drive: 0.4 }),
                v('noise', 0, 0.25, 0.12, { decay: 0.22, cutoff: 1200, q: 2 }),
            ],
            feel: 'heavy', scale: 1.4, fx: { preset: 'impact', scale: 1.4 }, duck: 0.5,
        },
        diplomacyAllied: {
            voices: [
                v('sine', 523.25, 0.25, 0.14, { decay: 0.22 }),
                v('sine', 659.25, 0.35, 0.14, { decay: 0.32, delay: 0.06 }),
                v('sine', 783.99, 0.55, 0.16, { decay: 0.50, delay: 0.12 }),
                v('triangle', 1046.5, 0.70, 0.12, { decay: 0.65, delay: 0.18 }),
            ],
            feel: 'select', fx: { preset: 'confetti', scale: 0.9 }, duck: 0.25,
        },
        diplomacyTrade: {
            voices: [
                v('triangle', 880, 0.08, 0.12, { decay: 0.07 }),
                v('triangle', 1174.66, 0.12, 0.12, { decay: 0.10, delay: 0.05 }),
                v('sine', 1760, 0.35, 0.14, { decay: 0.32, delay: 0.10 }),
            ],
            feel: 'tick', fx: { preset: 'coins', scale: 0.8 },
        },
        caravanTransit: {
            voices: [
                v('sine', 1318.5, 0.06, 0.08, { decay: 0.05 }),
                v('noise', 0, 0.03, 0.04, { decay: 0.025, cutoff: 3500 }),
            ],
            feel: 'tick', jitter: 1.2,
        },
        milestoneGong: {
            voices: [
                v('noise', 0, 0.09, 0.16, { decay: 0.08, cutoff: 5500, cutoffEnd: 800, q: 2 }),
                v('sine', 110, 0.85, 0.35, { freqEnd: 105, sweep: 0.8, decay: 0.85, drive: 0.3 }),
                v('sine', 303.6, 0.65, 0.22, { decay: 0.60, delay: 0.002 }),
                v('sine', 595.1, 0.45, 0.15, { decay: 0.40, delay: 0.004 }),
            ],
            feel: 'win', fx: { preset: 'coins', scale: 1.3 }, duck: 0.45,
        },
        nightFall: {
            voices: [
                v('sine', 320, 0.80, 0.10, { freqEnd: 160, sweep: 0.75, decay: 0.75 }),
                v('noise', 0, 0.80, 0.08, { decay: 0.75, cutoff: 800, cutoffEnd: 250, q: 1.5 }),
            ],
            feel: null, duck: 0.2,
        },
        sporePulse: {
            voices: [
                v('sine', 987.77, 0.18, 0.06, { decay: 0.16 }),
                v('sine', 1479.98, 0.25, 0.05, { decay: 0.22, delay: 0.04 }),
            ],
            feel: null, jitter: 1.8,
        },
    },

    // ── Dynasty — ancestral harp & genetic lineage ─────────────────────
    dynasty: {
        pluckAncestor: {
            voices: [
                v('triangle', 440, 0.45, 0.18, { decay: 0.42 }),
                v('saw', 880, 0.18, 0.10, { decay: 0.14, cutoff: 3200, cutoffEnd: 600, q: 2 }),
            ],
            feel: 'select', scale: 0.6,
        },
        ancestorPass: {
            voices: [
                v('sine', 220, 0.75, 0.18, { freqEnd: 180, sweep: 0.7, decay: 0.72 }),
                v('sine', 330, 0.65, 0.12, { decay: 0.60, delay: 0.05 }),
            ],
            feel: 'light', scale: 0.5, duck: 0.25,
        },
        geneMutate: {
            voices: [
                v('sine', 784, 0.08, 0.10, { decay: 0.07 }),
                v('sine', 987, 0.08, 0.10, { decay: 0.07, delay: 0.05 }),
                v('sine', 1318, 0.25, 0.12, { decay: 0.22, delay: 0.10 }),
            ],
            feel: 'select', fx: { preset: 'sparks', scale: 0.7 },
        },
    },

    // ── SandPlayground — fluid bubbles, boiling steam & incandescence ──
    sandplayground: {
        bubble: {
            voices: [v('sine', 1600, 0.05, 0.12, { freqEnd: 550, sweep: 0.045, decay: 0.045 })],
            feel: 'tick', jitter: 2.2,
        },
        steamHiss: {
            voices: [v('noise', 0, 0.22, 0.12, { decay: 0.20, cutoff: 4500, cutoffEnd: 2200, q: 1.8 })],
            feel: null, fx: { preset: 'smoke', scale: 0.6 },
        },
        acidSizzle: {
            voices: [v('noise', 0, 0.15, 0.14, { decay: 0.14, cutoff: 6200, q: 3.5, lfoRate: 35, lfoDepth: 0.6 })],
            feel: 'tick', fx: { preset: 'sparks', scale: 0.5 },
        },
        ignite: {
            voices: [
                v('noise', 0, 0.18, 0.18, { decay: 0.16, cutoff: 2400, cutoffEnd: 600, q: 2 }),
                v('sine', 180, 0.16, 0.22, { freqEnd: 65, sweep: 0.14, decay: 0.15 }),
            ],
            feel: 'light', fx: { preset: 'sparks', scale: 1.0 },
        },
    },

    // ── PoVoxelStrike — kinetic destruction & granular scatter ────────
    povoxelstrike: {
        wallShatter: {
            voices: [
                v('noise', 0, 0.38, 0.35, { decay: 0.35, cutoff: 2800, cutoffEnd: 350, q: 2 }),
                v('sine', 90, 0.30, 0.40, { freqEnd: 26, sweep: 0.25, decay: 0.28, drive: 0.8 }),
                v('noise', 0, 0.20, 0.18, { decay: 0.18, cutoff: 5200, q: 1.5, delay: 0.04 }),
            ],
            feel: 'heavy', scale: 1.6, fx: { preset: 'impact', scale: 1.6 }, duck: 0.45,
        },
        voxelClusterCollapse: {
            voices: [
                v('noise', 0, 0.45, 0.25, { decay: 0.40, cutoff: 1800, cutoffEnd: 220, q: 1.8 }),
                v('sine', 75, 0.40, 0.30, { freqEnd: 30, sweep: 0.35, decay: 0.38, drive: 0.6 }),
            ],
            feel: 'heavy', scale: 1.3, fx: { preset: 'dust', scale: 1.2 }, duck: 0.35,
        },
        granulateDebris: {
            voices: [
                v('noise', 0, 0.12, 0.16, { decay: 0.10, cutoff: 3800, q: 2.2 }),
                v('noise', 0, 0.12, 0.12, { decay: 0.10, cutoff: 2600, q: 1.8, delay: 0.02 }),
            ],
            feel: 'light', scale: 0.7, fx: { preset: 'dust', scale: 0.5 },
        },
    },

    // ── PoEcosystem — living geopolitical diplomacy & tribal trade ──
    poecosystem: {
        diplomacyWar: {
            voices: [
                v('sawtooth', 110, 0.45, 0.28, { freqEnd: 82, sweep: 0.35, decay: 0.40, drive: 0.5 }),
                v('sine', 55, 0.50, 0.35, { decay: 0.45, drive: 0.7 }),
                v('noise', 0, 0.25, 0.20, { decay: 0.20, cutoff: 1400, cutoffEnd: 200, q: 2 }),
            ],
            feel: 'heavy', scale: 1.2, fx: { preset: 'sparks', scale: 0.8 }, duck: 0.3,
        },
        diplomacyAllied: {
            voices: [
                v('sine', 523.25, 0.35, 0.22, { decay: 0.32 }),
                v('sine', 659.25, 0.40, 0.20, { delay: 0.08, decay: 0.35 }),
                v('sine', 783.99, 0.50, 0.18, { delay: 0.16, decay: 0.45 }),
            ],
            feel: 'light', scale: 0.8, fx: { preset: 'sparkle', scale: 0.8 },
        },
        diplomacyTrade: {
            voices: [
                v('sine', 880, 0.12, 0.20, { freqEnd: 440, sweep: 0.08, decay: 0.10 }),
                v('sine', 1320, 0.15, 0.16, { delay: 0.05, decay: 0.12 }),
            ],
            feel: 'tick', scale: 0.6,
        },
    },

    // ── DynastyTree — lineage, ancestral remembrance & genetics ──────
    dynasty: {
        ancestorPass: {
            voices: [
                v('sine', 220, 0.60, 0.22, { decay: 0.55 }),
                v('sine', 329.63, 0.70, 0.18, { delay: 0.06, decay: 0.65 }),
                v('sine', 110, 0.80, 0.25, { delay: 0.12, decay: 0.75, drive: 0.2 }),
            ],
            feel: 'light', scale: 0.7, fx: { preset: 'dust', scale: 0.6 },
        },
    },
};

/** Cues that should also fire a personal-best celebration. */
const CELEBRATE = new Set(['win', 'goal', 'finish', 'fanfare']);

/**
 * Fire a cue: sound, screen feel and particles, together.
 *
 * @param {string} scope game key ('pobrawl', 'quiz', 'ui', …)
 * @param {string} name  cue name within that scope
 * @param {object} [opts]
 * @param {number} [opts.x] viewport CSS px for the particle burst
 * @param {number} [opts.y]
 * @param {Element|string} [opts.el] element to burst from, instead of x/y
 * @param {number} [opts.pan=0] -1..1
 * @param {number} [opts.pitch=1] frequency multiplier, e.g. doppler or row index
 * @param {number} [opts.gain=1] level multiplier
 * @param {number} [opts.scale=1] impact/particle strength multiplier
 * @param {boolean} [opts.silent] skip audio, keep the visual (for muted replays)
 */
export function fire(scope, name, opts) {
    const o = opts || {};
    const table = CUES[scope] || CUES.ui;
    const cue = table[name] || CUES.ui[name];
    if (!cue) return;

    if (!o.silent && !AudioBus.isMuted()) {
        const jitter = cue.jitter == null ? 0.35 : cue.jitter;
        // One detune value for the whole cue, not per voice: detuning voices
        // independently would break the intervals the cue is built from.
        const detune = jitter ? R((Math.random() * 2 - 1) * jitter) : 1;
        const pitch = (o.pitch || 1) * detune;
        const gainMul = o.gain == null ? 1 : o.gain;

        const voices = cue.voices.map((base) => {
            const n = { ...base, gain: base.gain * gainMul, pan: o.pan || base.pan || 0 };
            // Noise has no pitch to shift; scaling freq on it would be a no-op
            // that only confuses the filter sweep below.
            if (n.wave !== 'noise') {
                if (n.freq) n.freq *= pitch;
                if (n.freqEnd) n.freqEnd *= pitch;
            } else if (pitch !== 1) {
                // For noise, "pitch" means brightness — shift the filter instead.
                if (n.cutoff) n.cutoff = Math.min(20000, n.cutoff * pitch);
                if (n.cutoffEnd) n.cutoffEnd = Math.min(20000, n.cutoffEnd * pitch);
            }
            return n;
        });

        Dsp.playAll(voices, cue.bus || (scope === 'ui' ? 'ui' : 'sfx'));
        if (cue.duck) AudioBus.duck(1 - cue.duck, 500);
    }

    const strength = (o.scale == null ? 1 : o.scale) * (cue.scale == null ? 1 : cue.scale);
    if (cue.feel) Impact.impact(cue.feel, strength);

    if (cue.fx) {
        const fxOpts = { preset: cue.fx.preset, scale: (cue.fx.scale || 1) * strength };
        if (CELEBRATE.has(name) && cue.fx.preset === 'confetti') {
            Fx.celebrate(fxOpts.scale);
        } else if (o.el) {
            Fx.burstAt(o.el, fxOpts);
        } else if (o.x != null && o.y != null) {
            Fx.burst({ ...fxOpts, x: o.x, y: o.y });
        } else {
            // No position given: burst from the centre of the viewport rather
            // than silently dropping the visual half of the cue.
            Fx.burst({ ...fxOpts, x: window.innerWidth / 2, y: window.innerHeight / 2 });
        }
    }
}

/**
 * Bind a scope once so a game does not repeat its own name on every call.
 * @param {string} scope
 * @returns {(name: string, opts?: object) => void}
 */
export function scoped(scope) {
    return (name, opts) => fire(scope, name, opts);
}

/** True if a cue exists — lets call sites degrade rather than fire nothing. */
export function has(scope, name) {
    return !!((CUES[scope] && CUES[scope][name]) || CUES.ui[name]);
}

if (typeof window !== 'undefined') {
    window.PoCue = { fire, scoped, has };
}
