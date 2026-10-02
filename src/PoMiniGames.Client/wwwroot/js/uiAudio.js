// Native Web Audio feedback — zero-asset micro-cues.
// Generates triangle/sine oscillator bursts at the call site; no MP3/WAV to
// ship. Lazy AudioContext init on first user gesture (mobile autoplay rules).
//
// This module does not own an AudioContext: a private one would mean no global
// mix and a mute flag re-checked independently at every call site. Context, mute
// and the output bus come from audioBus.js; voices connect to the 'ui' bus rather
// than ctx.destination so they can be ducked and metered with everything else.

import * as AudioBus from './audioBus.js';
import * as Cue from './gameCues.js';
import * as Dsp from './dsp.js';

/**
 * Fire a named cue from the shared vocabulary (gameCues.js).
 *
 * This is the bridge the Blazor UiFeedbackService now calls. Before it existed
 * the app had two parallel audio stacks: gameCues.js — a full per-game timbre
 * table wired to impact and particles — and the hand-rolled oscillator bursts
 * below, which is what C# actually reached. The cue table was loaded on every
 * page and fired by nothing, so every game shared the same three oscillators
 * while the vocabulary written to give them identities sat unused.
 *
 * The playTone/playChord/playSweep/playArpeggio primitives are kept: they are
 * what dsp.js-free call sites (and playChipDrop below) still use, and a cue
 * that does not exist should degrade to a primitive rather than to silence.
 *
 * @param {string} scope game key ('tictactoe', 'quiz', 'ui', …)
 * @param {string} name  cue name within that scope
 * @param {object} [opts] see gameCues.fire — { el, x, y, pan, pitch, gain, scale }
 * @returns {boolean} true if a cue was fired, false if the name is unknown
 */
export function cue(scope, name, opts) {
    try {
        if (!Cue.has(scope, name)) return false;
        Cue.fire(scope, name, opts);
        return true;
    } catch {
        // Feedback is best-effort — never throw into a game loop.
        return false;
    }
}

async function getCtx() {
    return AudioBus.context();
}

/** Output node for every voice in this module. Null when audio is unavailable. */
async function out() {
    return AudioBus.bus('ui');
}

/**
 * Where a voice group lands in the stereo field. A board game passes the column a piece was
 * played in; 0 (or no StereoPannerNode) is the bus itself, so nothing else pays for a node.
 */
function placed(ctx, dest, pan, holdMs) {
    if (!pan || !ctx.createStereoPanner) return dest;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(dest);
    setTimeout(() => { try { p.disconnect(); } catch { /* context closed */ } }, holdMs + 250);
    return p;
}

/**
 * Play a single tone.
 * @param {number} freq  - Frequency in Hz (e.g. 880 = A5)
 * @param {number} ms    - Duration in milliseconds
 * @param {number} gain  - Peak gain (0..1)
 * @param {string} type  - Oscillator type (triangle/sine/square/sawtooth)
 * @param {number} [pan] - -1 (left) .. 1 (right)
 */
export async function playTone(freq, ms, gain, type, pan) {
    try {
        // Global master mute (settings gear in the top bar; see SettingsService).
        if (AudioBus.isMuted()) return;
        const ctx = await getCtx();
        const bus = await out();
        if (!ctx || !bus) return;
        const dest = placed(ctx, bus, pan, ms);
        const t0 = ctx.currentTime;
        const dur = ms / 1000;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type || 'triangle';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(dest);
        osc.start(t0);
        osc.stop(t0 + dur);
    } catch { /* AudioContext unavailable — fail silently. */ }
}

/**
 * Play a chord (multiple tones fired simultaneously).
 * @param {number[]} freqs
 * @param {number} ms
 * @param {number} gain
 */
export async function playChord(freqs, ms, gain) {
    for (const f of freqs) {
        playTone(f, ms, gain, 'triangle');
    }
}

/**
 * Play a frequency sweep from fromHz → toHz over ms milliseconds.
 * Used for swipe-back feedback (downsweep = leaving the page).
 * @param {number} fromHz
 * @param {number} toHz
 * @param {number} ms
 * @param {number} gain
 * @param {string} type
 */
export async function playSweep(fromHz, toHz, ms, gain, type) {
    try {
        const ctx = await getCtx();
        const dest = await out();
        if (!ctx || !dest) return;
        const t0 = ctx.currentTime;
        const dur = ms / 1000;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type || 'triangle';
        osc.frequency.setValueAtTime(fromHz, t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(toHz, 20), t0 + dur);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(dest);
        osc.start(t0);
        osc.stop(t0 + dur);
    } catch { /* fail silently */ }
}

/**
 * Play an arpeggio (sequential notes with individual durations).
 * Used for personal-best celebration.
 * @param {number[]} freqs
 * @param {number[]} durationsMs
 * @param {number} gain
 */
export async function playArpeggio(freqs, durationsMs, gain) {
    let delay = 0;
    for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i];
        const ms = durationsMs[i] || 80;
        setTimeout(() => playTone(f, ms, gain, 'triangle'), delay);
        delay += ms - 10; // small overlap so notes blend
    }
}

/**
 * Realistic Connect-style chip drop — plastic disc sliding down a wooden slot
 * and *thunking* on the stack. Synthesised from noise (scrape) + low filtered
 * tone (thud). Two audio events fire on the same call:
 *
 *   1. SLIDE  — ~400 ms filtered noise envelope, pitched down via a lowpass
 *               sweep so it reads as "moving along a surface", not static hiss.
 *               Cheap on the CPU; uses one BufferSource + one BiquadFilter.
 *   2. THUD   — fires after `slideMs`. Short, damped sine + a tighter noise
 *               burst. Frequency scales mildly with `rowIndex` so a chip landing
 *               high on the stack sounds slightly thinner than one landing at
 *               the bottom (more material between it and the wood — same idea
 *               as a higher-up domino tap reading lighter).
 *
 * All gain stays under 0.25 to keep the demo loop pleasant during 850ms
 * bursts. Best-effort: any failure inside try/catch is swallowed (see caller
 * contract — feedback paths never throw).
 *
 * @param {object} [opts]
 * @param {number} [opts.rowIndex=8]   0..8 landing row (8 = bottom of board).
 * @param {number} [opts.slideMs=400]  duration of the slide.
 * @param {number} [opts.thudMs=110]   duration of the impact.
 * @param {number} [opts.masterGain=0.22] peak amplitude cap (0..1).
 * @param {number} [opts.pan=0]        -1..1, the column the chip fell in.
 */
export async function playChipDrop(opts) {
    try {
        if (AudioBus.isMuted()) return;
        const ctx = await getCtx();
        const bus = await out();
        if (!ctx || !bus) return;
        const o = opts || {};
        const dest = placed(ctx, bus, o.pan, (o.slideMs ?? 400) + (o.thudMs ?? 110));
        const row = Math.max(0, Math.min(8, o.rowIndex ?? 8));
        const slideMs = o.slideMs ?? 400;
        const thudMs = o.thudMs ?? 110;
        const masterGain = o.masterGain ?? 0.22;
        const t0 = ctx.currentTime;

        // ── Build a short white-noise buffer (reused for slide + thud) ──
        const noiseDur = Math.max(slideMs, thudMs) / 1000 + 0.05;
        const noiseBuf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * noiseDur)), ctx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

        // ── 1. SLIDE — band-passed noise with a slow filter sweep ───────
        // Start narrow-ish (high-Q bandpass ~1.6 kHz) so it reads as a
        // "scrape", then sweep down + widen so it dissipates into room tone.
        const slideSrc = ctx.createBufferSource();
        slideSrc.buffer = noiseBuf;
        const slideFilter = ctx.createBiquadFilter();
        slideFilter.type = 'bandpass';
        slideFilter.Q.value = 1.2;
        slideFilter.frequency.setValueAtTime(1600, t0);
        slideFilter.frequency.exponentialRampToValueAtTime(420, t0 + slideMs / 1000);
        const slideGain = ctx.createGain();
        slideGain.gain.setValueAtTime(0, t0);
        slideGain.gain.linearRampToValueAtTime(masterGain * 0.45, t0 + 0.04);
        slideGain.gain.exponentialRampToValueAtTime(0.0001, t0 + slideMs / 1000);
        slideSrc.connect(slideFilter).connect(slideGain).connect(dest);
        slideSrc.start(t0);
        slideSrc.stop(t0 + slideMs / 1000 + 0.02);

        // ── 2. THUD — fires after the slide lands on the stack ─────────
        // Bottom of board = lowest thud (heavier mass between disc and wood).
        // Top of board = a touch brighter and tighter (closer to bare plastic
        // meeting plastic). The shift is small (≈ 80 Hz over 9 rows) so it
        // reads as "row variation", not as two different sound effects.
        const thudStart = t0 + slideMs / 1000;
        const thudFreq = 110 + (8 - row) * 9; // ~110 Hz at row 0, ~182 Hz at row 8
        const thudDecay = thudMs / 1000;
        const thudOsc = ctx.createOscillator();
        thudOsc.type = 'sine';
        thudOsc.frequency.setValueAtTime(thudFreq, thudStart);
        // Pitch drops ~30 Hz as the chip settles — sells the "weight".
        thudOsc.frequency.exponentialRampToValueAtTime(Math.max(thudFreq - 30, 40), thudStart + thudDecay);
        const thudGain = ctx.createGain();
        thudGain.gain.setValueAtTime(0, thudStart);
        thudGain.gain.linearRampToValueAtTime(masterGain * 0.95, thudStart + 0.006);
        thudGain.gain.exponentialRampToValueAtTime(0.0001, thudStart + thudDecay);
        thudOsc.connect(thudGain).connect(dest);
        thudOsc.start(thudStart);
        thudOsc.stop(thudStart + thudDecay + 0.02);

        // Tight noise click on top of the thud — the chip-on-chip plastic
        // contact transient. ~30 ms, very short, bandpassed ~3 kHz.
        const clickSrc = ctx.createBufferSource();
        clickSrc.buffer = noiseBuf;
        const clickFilter = ctx.createBiquadFilter();
        clickFilter.type = 'bandpass';
        clickFilter.frequency.value = 3000;
        clickFilter.Q.value = 0.9;
        const clickGain = ctx.createGain();
        clickGain.gain.setValueAtTime(0, thudStart);
        clickGain.gain.linearRampToValueAtTime(masterGain * 0.5, thudStart + 0.004);
        clickGain.gain.exponentialRampToValueAtTime(0.0001, thudStart + 0.06);
        clickSrc.connect(clickFilter).connect(clickGain).connect(dest);
        clickSrc.start(thudStart);
        clickSrc.stop(thudStart + 0.08);
    } catch { /* fail silently — feedback is best-effort */ }
}

/**
 * Vibration helper — gated on navigator.vibrate availability.
 * @param {number[]} pattern - alternating vibrate/pause ms, e.g. [12, 40, 18]
 */
export async function vibrate(pattern) {
    try {
        // Honour the global master-mute as audio does — a muted player wants
        // silence and stillness, not a buzzing pocket.
        if (AudioBus.isMuted()) return;
        // Haptics also have their own opt-out (Profile → Preferences), because
        // mute is the wrong lever for "sound yes, buzzing no" — which is the
        // common case on a phone held in the hand rather than pocketed.
        // Read straight from storage rather than caching: this fires at most
        // once per interaction, and a stale cache would ignore the toggle until
        // the next reload.
        if (localStorage.getItem('pomini_haptics') === '0') return;
        // The kiosk attract reel runs without a user gesture, so every
        // navigator.vibrate call below this guard would emit "Blocked call to
        // navigator.vibrate because user hasn't tapped" to the console — a dozen
        // or so per second on Connect Five, drowning the real errors. No one is
        // holding a kiosk screen, so skip entirely on any ?kiosk=N or /{game}/demo
        // route.
        if (isOnKioskRoute()) return;
        // The kiosk guard above catches the attract reel, but not every
        // gesture-less caller: /login fires a UI cue while the sign-in gate is
        // still mounting, which would produce "Blocked call to navigator.vibrate
        // because user hasn't tapped on the frame" on the app's own entry page
        // — one guaranteed console error for every visitor. The browser's rule
        // is about a gesture having happened AT ALL, so track that directly
        // rather than enumerating the routes where one has not.
        if (!hasUserGestured()) return;
        if (navigator && typeof navigator.vibrate === 'function') {
            navigator.vibrate(pattern);
        }
    } catch { /* fail silently */ }
}

/**
 * True once the user has interacted with the document in a way that satisfies
 * the browser's sticky-activation requirement for navigator.vibrate.
 * `navigator.userActivation` is the direct answer where it exists; elsewhere a
 * set of one-shot listeners records the first real input.
 */
let _gestured = false;
function hasUserGestured() {
    if (_gestured) return true;
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
        _gestured = true;
    }
    return _gestured;
}
if (typeof document !== 'undefined') {
    // `once` so each listener detaches itself; capture so a handler that stops
    // propagation cannot hide the gesture from us.
    for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
        document.addEventListener(evt, () => { _gestured = true; },
            { once: true, capture: true, passive: true });
    }
}

// Cheap URL probe — the kiosk coordinator decides whether the reel is running
// but every demo also shares the same "no human in front of the screen" surface,
// so we treat both as kiosk.
function isOnKioskRoute() {
    try {
        const path = location.pathname || '';
        const search = location.search || '';
        if (search.indexOf('kiosk=') >= 0) return true;
        return /\/demo(\b|\/|$)/i.test(path);
    } catch {
        return false;
    }
}

export function crystalPing(opts) {
    return cue('ui', 'crystalPing', opts);
}

export function magneticSnap(opts) {
    return cue('ui', 'magneticSnap', opts);
}

export function fluidRipple(opts) {
    return cue('ui', 'fluidRipple', opts);
}

export function glassResonate(opts) {
    return cue('ui', 'glassResonate', opts);
}

export async function pluck(freq, opts) {
    const o = opts || {};
    return Dsp.playPluck(freq, o.dur || 0.8, o.gain || 0.25, o.damp || 0.7, 'ui');
}

export async function gong(freq, opts) {
    const o = opts || {};
    return Dsp.playGong(freq || 110, o.dur || 3.5, o.gain || 0.35, 'sfx');
}

if (typeof window !== 'undefined') {
    window.PoUiAudio = {
        cue,
        playTone,
        playChord,
        playSweep,
        playArpeggio,
        crystalPing,
        magneticSnap,
        fluidRipple,
        glassResonate,
        pluck,
        gong,
    };
}