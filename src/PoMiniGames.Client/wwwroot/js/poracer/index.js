// PoRacer's browser half: a thin client for a race the server simulates. This module owns
// the lifecycle (input listeners, the animation frame, cached bitmaps, audio voices) and the
// snapshot timeline; renderer.js draws, audio.js sounds, input.js reads the driver.
//
// The page pushes each 20 Hz server snapshot in as one flat number array (push) and the
// per-car facts that never change once (setRoster), so a snapshot crosses the interop
// boundary as numbers only, with no per-car objects or strings.
import * as Render from './renderer.js';
import * as Audio from './audio.js';
import { sampleAt } from './interpolation.js';
import { startInput, stopInput, setInputEnabled, getSize, pollPad } from './input.js';
import '../weather.js';

// Rivals are drawn this far behind the newest snapshot, so there is always a pair of
// snapshots to interpolate between (two intervals, less one frame of jitter).
const RENDER_DELAY_MS = 80;
// The local car is drawn almost at "now" instead: it extrapolates a few milliseconds past the
// newest snapshot, which takes most of that 80 ms off the delay between a key press and the
// car on screen. Only this car, because it is the only one the driver can feel; a rival's
// extrapolation error would show as jitter with nothing gained.
const PLAYER_DELAY_MS = 20;
// Snapshots older than this are dropped: a tab that was backgrounded comes back
// with a stale buffer, and interpolating across that gap would slide every car
// across the map.
const STALE_MS = 1500;
// Snapshots retained for interpolation. Must comfortably exceed RENDER_DELAY_MS /
// snapshot-interval (80/50 ≈ 1.6) or the sample point falls off the back of the buffer.
// Six entries is 300 ms of history, enough to also ride out a couple of dropped packets.
const BUFFER_MAX = 6;
/** Numbers per car in a pushed snapshot: x, y, heading, speed, boost, skid, damage, sand, position, lap, finished, tow, drift, boost seconds left. */
const STRIDE = 14;

/** Ascending by `st` (server clock, ms). Newest last. */
let buf = [];
// Local→server clock offset: serverNow ≈ performance.now() + clockOffset. Both
// clocks tick at the same rate, so this is a constant plus network jitter; the
// easing in push() is what filters the jitter out.
let clockOffset = null;
let roster = [], localIdx = -1, totalLaps = 3;
let raf = 0, mainId = null, finishing = false;
let hudEls = null, chipEls = null;
let interpolatedCars = [], playerCars = [], lastAudioAt = 0, lastProfileAt = 0;
const profiling = new URLSearchParams(location.search).get('perf') === '1';
const profile = { rafFrames: 0, renderedFrames: 0, interpolationMs: 0, renderMs: 0, audioMs: 0, startedAt: performance.now() };
let lastProfile = null;

// <html data-motion> is the OS preference OR the player's own switch in the settings sheet.
const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function clock(seconds) {
    const s = Math.max(0, seconds);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (Math.floor((s % 60) * 10) / 10).toFixed(1);
}

/**
 * The three HUD readouts that change every frame. Blazor renders these spans empty and never
 * touches their text, so writing them here costs no render: the page re-renders only when a
 * position, a lap or a lap time actually changes.
 */
function hud(me, newest, ts) {
    if (!hudEls || !hudEls.every(e => e?.isConnected)) {
        hudEls = ['.race-speed', '.race-clock', '.race-lap-now'].map(s => document.querySelector(s));
    }
    const ahead = newest.running ? Math.max(0, Math.min(0.25, (ts - newest.st) / 1000)) : 0;
    const text = [
        me ? String(Math.round(Math.abs(me.v) * 1.2)) : '',
        clock(newest.elapsed + ahead),
        clock(newest.lapNow + ahead),
    ];
    hudEls.forEach((el, i) => { if (el && el.textContent !== text[i]) el.textContent = text[i]; });

    // Tow / boost / drift chips. Blazor renders them hidden and never sets the attribute again,
    // so showing one here costs no render either. The drift chip fills as the charge builds and
    // turns once letting go would pay out (0.3, PoRacerSim.ApplyControl).
    if (!chipEls || !chipEls.every(e => e?.isConnected)) {
        chipEls = ['tow', 'boost', 'drift'].map(n => document.querySelector('.race-chip--' + n));
    }
    const show = [!!me?.tow, (me?.boostT || 0) > 0, (me?.drift || 0) > 0.02];
    chipEls.forEach((el, i) => { if (el && el.hidden === show[i]) el.hidden = !show[i]; });
    const drift = chipEls[2];
    if (drift && show[2]) {
        drift.style.setProperty('--charge', me.drift.toFixed(2));
        drift.classList.toggle('is-ready', me.drift >= 0.3);
    }
}

function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (profiling) profile.rafFrames++;
    if (!buf.length || document.hidden) return;
    pollPad();

    const newest = buf[buf.length - 1];
    // Connection stalled: hold the last frame. The finish pull-back is the exception; the
    // server has stopped sending by then and the camera still has somewhere to go.
    if (!finishing && now - newest.t > STALE_MS) return;

    // Where in server time this frame should show. The delay is FIXED — deriving
    // it from the buffer's current span instead makes it grow as the buffer fills,
    // which walks the sample point backwards during warm-up and reintroduces the
    // very stutter this is here to remove.
    const ts = now + clockOffset;
    const interpolationStart = profiling ? performance.now() : 0;
    let cars = sampleAt(buf, ts - RENDER_DELAY_MS, interpolatedCars);
    if (!cars) return;
    if (localIdx >= 0) {
        const mine = sampleAt(buf, ts - PLAYER_DELAY_MS, playerCars);
        if (mine?.[localIdx]) cars[localIdx] = mine[localIdx];
    }
    if (profiling) profile.interpolationMs += performance.now() - interpolationStart;

    const { w, h } = getSize();
    const renderStart = profiling ? performance.now() : 0;
    Render.draw(cars, w, h);
    if (profiling) profile.renderMs += performance.now() - renderStart;

    const me = localIdx >= 0 ? cars[localIdx] : cars.reduce((a, c) => c.position < a.position ? c : a, cars[0]);
    if (now - lastAudioAt >= 100) {
        const audioStart = profiling ? performance.now() : 0;
        Audio.frame(cars, me, localIdx < 0);
        if (profiling) profile.audioMs += performance.now() - audioStart;
        lastAudioAt = now;
    }
    hud(localIdx >= 0 ? me : null, newest, ts);
    if (profiling) {
        profile.renderedFrames++;
        if (now - lastProfileAt >= 2000) {
            const duration = now - profile.startedAt;
            const renderer = Render.takeDrawProfile();
            lastProfile = {
                rafFps: Math.round(profile.rafFrames * 1000 / duration),
                renderedFps: Math.round(profile.renderedFrames * 1000 / duration),
                cars: cars.length,
                canvasDpr: mainId ? (document.getElementById(mainId)?.width || 0) / Math.max(1, w) : 0,
                interpolationMs: profile.interpolationMs / profile.renderedFrames,
                rendererMs: profile.renderMs / profile.renderedFrames,
                backgroundMs: renderer?.backgroundMs,
                trackMs: renderer?.trackMs,
                effectsMs: renderer?.effectsMs,
                carsMs: renderer?.carsMs,
                audioMs: profile.audioMs / profile.renderedFrames,
            };
            console.info('[PoRacer perf]', lastProfile);
            profile.rafFrames = profile.renderedFrames = profile.interpolationMs = profile.renderMs = profile.audioMs = 0;
            profile.startedAt = now;
            lastProfileAt = now;
        }
    }
}

function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stopInput();
    Audio.stop();
    Render.dispose();
    window.PoWeather?.stop();
    buf = []; clockOffset = null; roster = []; localIdx = -1;
    finishing = false; hudEls = chipEls = null; mainId = null;
    interpolatedCars = []; playerCars = []; lastAudioAt = lastProfileAt = 0;
    profile.rafFrames = profile.renderedFrames = profile.interpolationMs = profile.renderMs = profile.audioMs = 0;
    profile.startedAt = performance.now();
    lastProfile = null;
}

window.PoRacer = {
    start(canvasId, reference) {
        stop();
        mainId = canvasId;
        startInput(canvasId, reference);
        Render.mount(canvasId);
        // Outdoors: almost no early reflections and a short, dark tail. See
        // acoustics.js — the default "generic room" made the track sound indoors.
        try { window.PoAcoustics?.setSpace('outdoor'); } catch { /* optional */ }
    },
    stop,
    setInputEnabled,
    getSize,
    getPerformanceProfile: () => profiling ? lastProfile : null,

    /** Track geometry, once per race. */
    setStatic(center, width, walls, boostPads, surfaceZones, theme, laps) {
        Render.setStatic(center, width, walls, boostPads, surfaceZones, theme);
        totalLaps = laps || 3;
        Audio.start();
        // Weather of the day (weather.js): one seed per track and UTC day, so everyone on a track
        // drives under the same sky. A 2D overlay directly above the track canvas, under the HUD;
        // it changes nothing the server simulates.
        const track = document.getElementById(mainId);
        if (track && !reducedMotion()) {
            window.PoWeather?.apply({ seed: JSON.stringify(theme) + new Date().toISOString().slice(0, 10), after: track });
        }
    },

    /** Names and paint, on join and again whenever a driver's paint arrives. */
    setRoster(cars, localId) {
        roster = (cars || []).map(c => ({ ...c, isPlayer: c.id === localId }));
        localIdx = roster.findIndex(c => c.isPlayer);
    },

    /**
     * One server snapshot. `flat` is STRIDE numbers per car in roster order; `running` is
     * "started and neither paused nor over", which is when the clocks may run ahead of it.
     */
    push(st, elapsed, lapNow, countdownMs, running, flat) {
        if (!mainId || !roster.length || !flat || flat.length < roster.length * STRIDE) return;
        const cars = roster.map((r, i) => {
            const o = i * STRIDE;
            return {
                ...r,
                x: flat[o], y: flat[o + 1], h: flat[o + 2], v: flat[o + 3],
                boost: flat[o + 4], skid: flat[o + 5], damage: flat[o + 6], sand: flat[o + 7] > 0,
                position: flat[o + 8], lap: flat[o + 9], finished: flat[o + 10] > 0,
                tow: flat[o + 11] > 0, drift: flat[o + 12], boostT: flat[o + 13],
            };
        });

        const t = performance.now();
        // Re-seed on the first snapshot, on a race restart (the sim's stopwatch
        // is per-race, so `st` walks backwards), and after a stall — in each case
        // the old buffer describes a different world and interpolating into it
        // would slide every car across the map.
        const offsetNow = st - t;
        if (clockOffset === null || !buf.length
            || st < buf[buf.length - 1].st
            || Math.abs(offsetNow - clockOffset) > STALE_MS) {
            buf = [];
            clockOffset = offsetNow;
        } else {
            // Same rate on both clocks, so this only ever chases network jitter.
            // Ease rather than track: a single late packet must not shove the
            // playback clock, which is what would make the whole field lurch.
            clockOffset += (offsetNow - clockOffset) * 0.05;
        }

        const prev = buf.length ? buf[buf.length - 1].cars : null;
        // Sparks where a car just took a hit: any car, so a rival clipping the barrier ahead
        // shows too. Damage only rises on a real impact (PoRacerSim), so this is the contact.
        if (prev && running) {
            for (let i = 0; i < cars.length; i++) {
                const hit = prev[i] ? cars[i].damage - prev[i].damage : 0;
                if (hit >= 0.02) Render.impact(cars[i].x, cars[i].y, cars[i].h, Math.min(1, hit / 0.1));
            }
        }
        buf.push({ st, t, elapsed, lapNow, running, cars });
        if (buf.length > BUFFER_MAX) buf.shift();

        Audio.lights(countdownMs > 0 ? Math.min(5, Math.floor((3000 - countdownMs) / 500)) : 0);
        if (running) Audio.events(prev, cars, localIdx, totalLaps);
        if (!raf) raf = requestAnimationFrame(frame);
    },

    /**
     * The race is over: silence the engines and pull the camera back over the whole circuit.
     * Returns how long the page should hold the results for (0 when motion is reduced).
     */
    finish() {
        Audio.stop();
        if (reducedMotion() || !buf.length) return 0;
        finishing = true;
        Render.finish(true);
        return 2600;
    },

    /**
     * Bring the results in on a View Transition. The callback is the page's own state change;
     * the short wait after it lets the results dialog open before the browser takes its "after"
     * picture, so it is the dialog that arrives, not an empty track that then gains one.
     */
    async reveal(reference) {
        const show = () => reference.invokeMethodAsync('RevealResults');
        if (!document.startViewTransition || reducedMotion()) { await show(); return; }
        document.documentElement.classList.add('racer-vt');
        try {
            await document.startViewTransition(async () => { await show(); await new Promise(r => setTimeout(r, 60)); }).finished;
        } catch { /* a skipped transition still ran the callback */ }
        finally { document.documentElement.classList.remove('racer-vt'); }
    },

    /** The paint-shop swatch. Works before a race is mounted. */
    preview: Render.preview,

    /**
     * Share a result line: the system share sheet where there is one, the clipboard otherwise
     * (and also when the sheet exists but refuses, which desktop browsers do for some targets).
     * Returns 'shared', 'copied' or 'failed'; closing the sheet without sending is 'failed', quietly.
     */
    async share(text) {
        const url = location.origin + '/poracer';
        if (navigator.share) {
            try { await navigator.share({ text, url }); return 'shared'; }
            catch (e) { if (e?.name === 'AbortError') return 'failed'; }
        }
        try { await navigator.clipboard.writeText(text + ' ' + url); return 'copied'; }
        catch { return 'failed'; }
    },
};
