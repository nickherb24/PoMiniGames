// particlesWorker.js — the ambient background, rendered off the main thread.
//
// In Blazor WASM the main thread runs the .NET runtime, so a main-thread rAF
// loop competes with game logic and with GC pauses: the field visibly hitches
// during a collection even though the GPU is idle. Rendering from a worker with
// an OffscreenCanvas decouples the two entirely — the background keeps flowing
// at full rate while the runtime is busy.
//
// The main thread stays responsible for anything DOM-shaped (pointer position,
// element size, viewport intersection, the analyser bands) and forwards it as
// messages; this file never touches the DOM because a worker cannot.

import { initGl, drawFrame, disposeGl, DEFAULT_HUE_A, DEFAULT_HUE_B } from './particlesCore.js';

let gl = null;
let u = null;
let canvas = null;
let raf = 0;
let startTime = 0;

let mouseX = 0.5;
let mouseY = 0.5;
let visible = true;
let inViewport = true;
let quality = 1;

let hueA = DEFAULT_HUE_A;
let hueB = DEFAULT_HUE_B;

// Analyser bands arrive at ~15 Hz (see ambientParticles.js — posting them every
// frame would cost a structured clone per frame for three floats). Rendering
// straight off that would make the volume update in visible 66 ms steps, so the
// live values chase the targets exponentially and the motion stays smooth
// between messages.
const bands = { bass: 0, mid: 0, treble: 0 };
const target = { bass: 0, mid: 0, treble: 0 };
const BAND_CHASE = 0.12;

let targetVx = 0;
let targetVy = 0;
let currentVx = 0;
let currentVy = 0;

// Passed to drawFrame every tick. Allocated once: a fresh object literal per
// frame is exactly the kind of garbage this worker exists to avoid.
const state = { quality: 1, bass: 0, mid: 0, treble: 0, hueA, hueB, mouseVx: 0, mouseVy: 0 };

function tick(now) {
    if (!gl) return;
    if (visible && inViewport) {
        bands.bass += (target.bass - bands.bass) * BAND_CHASE;
        bands.mid += (target.mid - bands.mid) * BAND_CHASE;
        bands.treble += (target.treble - bands.treble) * BAND_CHASE;

        currentVx += ((targetVx - currentVx) * 0.20);
        currentVy += ((targetVy - currentVy) * 0.20);
        targetVx *= 0.90;
        targetVy *= 0.90;

        state.quality = quality;
        state.bass = bands.bass;
        state.mid = bands.mid;
        state.treble = bands.treble;
        state.hueA = hueA;
        state.hueB = hueB;
        state.mouseVx = currentVx;
        state.mouseVy = currentVy;

        drawFrame(gl, u, canvas.width, canvas.height, now - startTime, mouseX, mouseY, state);
    }
    raf = requestAnimationFrame(tick);
}

self.onmessage = (e) => {
    const m = e.data || {};
    switch (m.type) {
        case 'init': {
            canvas = m.canvas;
            gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true });
            // antialias is off deliberately: this is a full-screen shader with no
            // geometric edges to alias, so MSAA would allocate a multisampled
            // buffer and resolve it every frame for no visual difference.
            if (!gl) { self.postMessage({ type: 'failed' }); return; }
            u = initGl(gl);
            if (!u) { self.postMessage({ type: 'failed' }); return; }
            canvas.width = m.width;
            canvas.height = m.height;
            startTime = performance.now();
            raf = requestAnimationFrame(tick);
            self.postMessage({ type: 'started' });
            break;
        }
        case 'resize': {
            if (!gl || !canvas) return;
            canvas.width = m.width;
            canvas.height = m.height;
            break;
        }
        case 'pointer':
            mouseX = m.x;
            mouseY = m.y;
            targetVx = m.vx || 0;
            targetVy = m.vy || 0;
            break;
        case 'visibility':
            visible = m.visible;
            break;
        case 'viewport':
            inViewport = m.inViewport;
            break;
        case 'quality':
            // Driven by visualRuntime.js's adaptive tier. One authority for
            // quality beats two that can disagree.
            quality = Math.max(0.05, Math.min(1, m.scale));
            break;
        case 'bands':
            target.bass = m.bass || 0;
            target.mid = m.mid || 0;
            target.treble = m.treble || 0;
            break;
        case 'tint':
            if (Array.isArray(m.hueA) && m.hueA.length === 3) hueA = m.hueA;
            if (Array.isArray(m.hueB) && m.hueB.length === 3) hueB = m.hueB;
            break;
        case 'stop':
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            disposeGl(gl, u);
            gl = null;
            u = null;
            canvas = null;
            self.close();
            break;
    }
};
