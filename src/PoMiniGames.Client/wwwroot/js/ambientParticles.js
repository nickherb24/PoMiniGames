// WebGL ambient background: a full-screen ray-marched volume (see particlesCore.js)
// rather than a field of drifting points.
//
// Rendering runs in a worker + OffscreenCanvas. In Blazor WASM the main thread runs
// the .NET runtime, so a main-thread rAF loop would share a thread with game logic
// and stutter visibly during GC. Browsers without `transferControlToOffscreen` fall
// back to the in-thread renderer below — same shader, via particlesCore.js.
//
// This file keeps ownership of everything DOM-shaped (pointer, resize,
// intersection, visibility, the CSS accent tokens, the analyser read) because a
// worker cannot touch the DOM; it forwards those as messages.

import { initGl, drawFrame, disposeGl, DEFAULT_HUE_A, DEFAULT_HUE_B } from './particlesCore.js';
import * as AudioBus from './audioBus.js';

let worker = null;

// Main-thread fallback state.
let gl = null;
let uniforms = null;
let raf = 0;
let visible = true;
let inViewport = true;
let lastX = 0.5;
let lastY = 0.5;
let quality = 1;
let hueA = DEFAULT_HUE_A;
let hueB = DEFAULT_HUE_B;

// Shared DOM observers (both paths).
let resizeObs = null;
let intersectObs = null;
let boundCanvas = null;
let onPointerMove = null;
let onTierChange = null;
let onVisibilityChange = null;
let onPageHide = null;
let bandTimer = 0;

// The march costs far more per pixel than a point field would, so the
// backing store is deliberately smaller than the display. The volume has no
// hard edges — there is nothing in it that a human can see aliasing on — which
// is exactly the case where rendering under-resolution is free quality.
//
// Above 1.0 the high-tier pixel count grows (1.25 is +56%) with no visible
// quality change on the soft volume, and the home route drops to ~31 FPS.
const MAX_DPR = 1.0;

// Analyser → worker at ~15 Hz. The worker interpolates between messages, so the
// visual is smooth; posting per frame would clone a message 60×/s for 3 floats.
const BAND_INTERVAL_MS = 66;

function currentQualityScale() {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--gfx-particles');
        const n = parseFloat(v);
        return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
        return 1;
    }
}

/** Backing-store scale for a quality tier. Resolution drops before step count. */
function renderScale(q) {
    return 0.55 + 0.45 * Math.max(0, Math.min(1, q));
}

function backingSize(canvas, q) {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * renderScale(q);
    return {
        w: Math.max(1, Math.floor(canvas.clientWidth * dpr)),
        h: Math.max(1, Math.floor(canvas.clientHeight * dpr)),
    };
}

/**
 * Read a CSS colour token and return linear-ish 0..1 RGB for the shader.
 * Falls back to the built-in palette for anything that does not parse — a game
 * with an exotic accent (a gradient, a colour space the browser resolves lazily)
 * must not blank the background.
 */
function readTint(varName, fallback) {
    try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        if (!raw) return fallback;
        // getComputedStyle resolves a custom property to its authored text, not
        // to rgb(). Parsing every possible colour syntax by hand is a losing
        // game, so hand it to the engine and read back what it computed.
        const probe = document.createElement('span');
        probe.style.color = raw;
        probe.style.display = 'none';
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        const m = /rgba?\(([^)]+)\)/.exec(resolved);
        if (!m) return fallback;
        const parts = m[1].split(/[,\s/]+/).map(Number);
        if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
        return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
    } catch {
        return fallback;
    }
}

function attachDomObservers(canvas, onResize, onPointer, onVisible, onViewport, onQuality) {
    boundCanvas = canvas;

    resizeObs = new ResizeObserver(() => {
        const s = backingSize(canvas, quality);
        onResize(s.w, s.h);
    });
    resizeObs.observe(canvas);

    let lastPx = 0.5, lastPy = 0.5, lastPt = performance.now();
    let lastWhooshTime = 0;
    onPointerMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) || 0;
        const py = 1 - ((e.clientY - rect.top) / rect.height) || 0;
        const now = performance.now();
        const dt = Math.max(8, now - lastPt);
        const vx = (px - lastPx) / (dt * 0.001);
        const vy = (py - lastPy) / (dt * 0.001);
        const speed = Math.hypot(vx, vy);
        lastPx = px; lastPy = py; lastPt = now;
        onPointer(px, py, vx, vy);

        if (speed > 4.5 && now - lastWhooshTime > 1200) {
            lastWhooshTime = now;
            window.PoCue?.fire('ui', 'fluidRipple');
        }
    };
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });

    // Keep references: these must be the SAME function objects passed to
    // removeEventListener in stop(), or the listeners outlive the canvas.
    onVisibilityChange = onVisible;
    onPageHide = stop;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    // Battery guard: pause rendering when the canvas leaves the viewport.
    intersectObs = new IntersectionObserver((entries) => {
        for (const e of entries) onViewport(e.isIntersecting);
    }, { rootMargin: '50px' });
    intersectObs.observe(canvas);

    // Adaptive quality: visualRuntime.js is the single authority on how much
    // the machine can afford. A tier change also resizes the backing store,
    // not just the step count — resolution is the bigger lever for a per-pixel
    // shader, and changing only the steps would leave a slow machine rendering
    // 34-step-quality pixel counts at 10-step quality.
    onTierChange = () => {
        quality = currentQualityScale();
        onQuality(quality);
        const s = backingSize(canvas, quality);
        onResize(s.w, s.h);
    };
    window.addEventListener('po-gfx-tier', onTierChange);
    quality = currentQualityScale();
    onQuality(quality);
}

/**
 * Re-read the FX accent triad (defined in app.css :root, re-pointed inside each
 * game's theme root). Call after a game changes its theme so the background
 * curtains match the UI in front of them.
 */
export function refreshTint() {
    hueA = readTint('--fx-accent', DEFAULT_HUE_A);
    hueB = readTint('--fx-accent-2', DEFAULT_HUE_B);
    if (worker) worker.postMessage({ type: 'tint', hueA, hueB });
}

export function start(canvas) {
    refreshTint();

    // ── Preferred path: render in a worker ─────────────────────────────
    if (typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function') {
        try {
            const s = backingSize(canvas, currentQualityScale());
            const off = canvas.transferControlToOffscreen();
            worker = new Worker(new URL('./particlesWorker.js', import.meta.url), { type: 'module' });

            worker.onmessage = (e) => {
                if (e.data && e.data.type === 'failed') {
                    // WebGL2 unavailable inside the worker. The canvas has
                    // already been transferred and cannot be reclaimed, so we
                    // cannot retry in-thread — leave it blank and let the CSS
                    // gradient behind it show through, same as the old
                    // no-WebGL behaviour.
                    stop();
                }
            };

            worker.postMessage({ type: 'init', canvas: off, width: s.w, height: s.h }, [off]);
            worker.postMessage({ type: 'tint', hueA, hueB });

            attachDomObservers(
                canvas,
                (w, h) => worker && worker.postMessage({ type: 'resize', width: w, height: h }),
                (x, y, vx, vy) => worker && worker.postMessage({ type: 'pointer', x, y, vx, vy }),
                () => worker && worker.postMessage({ type: 'visibility', visible: !document.hidden }),
                (iv) => worker && worker.postMessage({ type: 'viewport', inViewport: iv }),
                (scale) => worker && worker.postMessage({ type: 'quality', scale }));

            startBandPump((b) => worker && worker.postMessage({
                type: 'bands', bass: b.bass, mid: b.mid, treble: b.treble,
            }));
            return true;
        } catch {
            // Fall through to the in-thread renderer.
            worker = null;
        }
    }

    // ── Fallback: main-thread renderer ─────────────────────────────────
    gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) {
        // Leave the canvas blank. The CSS gradient behind it stays visible.
        return false;
    }
    uniforms = initGl(gl);
    if (!uniforms) { gl = null; return false; }

    let lastVx = 0, lastVy = 0;
    attachDomObservers(
        canvas,
        (w, h) => {
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
        },
        (x, y, vx, vy) => { lastX = x; lastY = y; lastVx = vx || 0; lastVy = vy || 0; },
        () => { visible = !document.hidden; },
        (iv) => { inViewport = iv; },
        () => { /* quality is read straight off the module-level `quality` */ });

    // Reused across frames — see the same note in particlesWorker.js.
    const state = { quality: 1, bass: 0, mid: 0, treble: 0, hueA, hueB, mouseVx: 0, mouseVy: 0 };
    const startTime = performance.now();
    function tick(now) {
        if (!gl) return;
        if (visible && inViewport) {
            // No message hop on this path, so the analyser can be read directly
            // each frame — getLevels() is a single getByteFrequencyData plus a
            // 256-element reduce, which is cheaper than a postMessage would be.
            const l = AudioBus.getLevels();
            state.quality = quality;
            state.bass = l.bass;
            state.mid = l.mid;
            state.treble = l.treble;
            state.hueA = hueA;
            state.hueB = hueB;
            state.mouseVx = lastVx;
            state.mouseVy = lastVy;
            lastVx *= 0.9;
            lastVy *= 0.9;
            drawFrame(gl, uniforms, canvas.width, canvas.height, now - startTime, lastX, lastY, state);
        }
        raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return true;
}

/**
 * Poll the analyser on a timer and hand the bands to the worker.
 * A timer rather than rAF: this is a data feed at a deliberately low rate, and
 * rAF would tie it to the display refresh (240 Hz on some panels) for no gain.
 */
function startBandPump(send) {
    stopBandPump();
    bandTimer = setInterval(() => {
        if (document.hidden || !inViewport) return;
        send(AudioBus.getLevels());
    }, BAND_INTERVAL_MS);
}

function stopBandPump() {
    if (bandTimer) clearInterval(bandTimer);
    bandTimer = 0;
}

export function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stopBandPump();

    if (worker) {
        try { worker.postMessage({ type: 'stop' }); } catch { /* already dead */ }
        worker = null;
    }

    if (onVisibilityChange) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        onVisibilityChange = null;
    }
    if (onPageHide) {
        window.removeEventListener('pagehide', onPageHide);
        onPageHide = null;
    }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (intersectObs) { intersectObs.disconnect(); intersectObs = null; }
    if (onTierChange) { window.removeEventListener('po-gfx-tier', onTierChange); onTierChange = null; }
    if (boundCanvas && onPointerMove) {
        boundCanvas.removeEventListener('pointermove', onPointerMove);
    }
    onPointerMove = null;
    boundCanvas = null;

    disposeGl(gl, uniforms);
    // disposeGl only deletes the program and VAO. Drop the context itself as
    // well: the home page mounts and unmounts on every navigation, so without
    // this each round trip to a game and back strands another live context, and
    // the pool it is drawing from (~16 per renderer process in Chrome) is the
    // same one the three.js games need. See engineLoader's isWebGlAvailable().
    if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
    uniforms = null;
    gl = null;
}

if (typeof window !== 'undefined') {
    window.PoAmbient = { start, stop, refreshTint };
}
