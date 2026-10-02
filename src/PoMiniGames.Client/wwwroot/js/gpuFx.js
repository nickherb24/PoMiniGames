// gpuFx.js — one GPU particle system for the whole app.
//
// WHY ONE
// Confetti on a quiz win, sparks on a PoBrawl hit, dust when a ConnectFive chip
// lands, coins on a personal best: five games wanted the same thing and none of
// them had it, because "add a particle system" meant adding a canvas, a rAF
// loop and a pool allocator to a page that otherwise had none. This is that
// canvas, once, shared, as a fixed overlay above every game.
//
// THE INTERESTING PART: NO PER-FRAME CPU WORK
// The obvious design keeps an array of live particles and integrates them on
// the CPU each frame, re-uploading the buffer. That is a full buffer upload
// every frame plus JS integration for every particle, on the same thread as the
// .NET runtime.
//
// Instead each particle stores only its *initial conditions* — position,
// velocity, spawn time, lifetime — and the vertex shader evaluates the
// trajectory in closed form for the current time:
//
//     p(t) = p0 + v0 · (1 − e^(−k·t)) / k  +  ½ · g · t²
//
// (that middle term is exponential drag integrated analytically; as k → 0 it
// degrades to plain v0·t, which is why the shader guards the small-k case).
//
// So a burst is ONE bufferSubData of the new particles and nothing else, ever.
// The per-frame cost is a single instanced draw call regardless of how many
// particles are alive. Dead particles are collapsed to a degenerate triangle in
// the vertex shader, which the rasteriser discards before any fragment work.
//
// BLENDING: additive sparks and alpha-blended confetti in ONE pass. The canvas
// blends premultiplied (ONE, ONE_MINUS_SRC_ALPHA), so emitting rgb=c·a with
// a=0 gives pure additive, and rgb=c·a with a=a gives normal alpha. A single
// per-particle 0..1 flag interpolates between them — no second draw call, no
// sorting.

const MAX_PARTICLES = 2400;
const FLOATS_PER_PARTICLE = 14;
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4;

const VERT_SRC = `#version 300 es
// Instance attributes — see the closed-form note in the file header.
in vec2 aP0;      // spawn position, CSS px, origin top-left
in vec2 aV0;      // initial velocity, px/s
in vec3 aColor;
in vec4 aParams;  // x: size px, y: ttl s, z: spawn time s, w: seed 0..1
in vec3 aFlags;   // x: gravity px/s², y: drag k, z: additive 0..1

uniform vec2  uResolution;  // CSS px
uniform float uTime;        // s

out vec2  vCorner;
out vec3  vColor;
out float vAlpha;
out float vAdditive;
out float vSeed;

void main() {
    float age = uTime - aParams.z;
    float ttl = aParams.y;

    // Cull unborn and expired instances by emitting a degenerate position. The
    // rasteriser drops it with no fragment cost, which is what lets the ring
    // buffer stay at full size without paying for the empty slots.
    if (age < 0.0 || age > ttl) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    float k = aFlags.y;
    // (1 - e^(-kt))/k has a removable singularity at k = 0. Below this epsilon
    // the expression loses all its precision to catastrophic cancellation long
    // before it actually divides by zero, so switch to the limit early.
    float dragTerm = (k > 0.001) ? (1.0 - exp(-k * age)) / k : age;
    vec2 pos = aP0 + aV0 * dragTerm + vec2(0.0, 0.5 * aFlags.x * age * age);

    float life = age / ttl;

    // Size envelope: a fast pop in over the first 12% of life, then a slow
    // shrink. Particles that appear at full size read as "drawn"; ones that
    // scale up read as "emitted".
    float grow = smoothstep(0.0, 0.12, life);
    float shrink = 1.0 - 0.55 * life * life;
    float size = aParams.x * grow * shrink;

    // Quad corner from the vertex ID — no corner buffer is bound.
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
    vCorner = corner;

    // Spin. Seed-varied rate and direction so a burst never looks like a rigid
    // body; the sign flip is what stops confetti from all rotating the same way.
    float spin = (aParams.w - 0.5) * 12.0 * age;
    float cs = cos(spin), sn = sin(spin);
    vec2 rotated = mat2(cs, -sn, sn, cs) * corner;

    vec2 px = pos + rotated * size;
    vec2 clip = (px / uResolution) * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);   // flip Y: CSS px are top-down

    vColor = aColor;
    // Hold full opacity for the first third of life, then ease out. Fading from
    // the instant of spawn makes a burst look weak at exactly the moment it is
    // supposed to land.
    vAlpha = 1.0 - smoothstep(0.35, 1.0, life);
    vAdditive = aFlags.z;
    vSeed = aParams.w;
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;

in vec2  vCorner;
in vec3  vColor;
in float vAlpha;
in float vAdditive;
in float vSeed;

out vec4 frag;

void main() {
    float r = length(vCorner);
    if (r > 1.0) discard;

    // Two-stop falloff: a tight bright core inside a wide soft halo. A single
    // smoothstep gives a flat disc that reads as a dot; the core is what makes
    // a spark look hot.
    float halo = smoothstep(1.0, 0.0, r);
    float core = smoothstep(0.45, 0.0, r);
    vec3 c = vColor * (halo * 0.55 + core * 1.6);

    float a = vAlpha * (halo * halo);

    // Premultiplied output. a → 0 with rgb intact is pure additive; see header.
    frag = vec4(c * a, a * (1.0 - vAdditive));
}`;

/**
 * Presets. `speed`/`spread` describe the emission cone, `drag` how fast it
 * bleeds off, `gravity` in px/s² (positive is down, matching CSS coordinates).
 * `additive` 1 for anything that should glow, 0 for anything made of matter.
 */
const PRESETS = {
    sparks:   { count: 26, size: 7,  ttl: 0.55, speed: 620, spread: Math.PI * 2, gravity: 1400, drag: 3.4, additive: 1, hue: 'accent' },
    confetti: { count: 64, size: 11, ttl: 2.20, speed: 520, spread: Math.PI * 2, gravity: 900,  drag: 1.5, additive: 0, hue: 'party' },
    dust:     { count: 16, size: 14, ttl: 0.70, speed: 150, spread: Math.PI,     gravity: -60,  drag: 5.0, additive: 0, hue: 'muted' },
    coins:    { count: 22, size: 10, ttl: 1.40, speed: 480, spread: Math.PI,     gravity: 1500, drag: 1.2, additive: 1, hue: 'gold' },
    smoke:    { count: 12, size: 26, ttl: 1.60, speed: 90,  spread: Math.PI,     gravity: -140, drag: 2.2, additive: 0, hue: 'muted' },
    impact:   { count: 34, size: 9,  ttl: 0.45, speed: 780, spread: Math.PI * 2, gravity: 600,  drag: 5.5, additive: 1, hue: 'accent' },
};

const PALETTES = {
    party: [[0.98, 0.30, 0.42], [0.32, 0.78, 1.00], [1.00, 0.82, 0.25], [0.55, 0.95, 0.55], [0.75, 0.45, 1.00]],
    gold:  [[1.00, 0.84, 0.32], [1.00, 0.66, 0.18], [1.00, 0.95, 0.70]],
    muted: [[0.62, 0.66, 0.72], [0.48, 0.52, 0.58], [0.74, 0.76, 0.80]],
};

let gl = null;
let prog = null;
let vao = null;
let instanceBuffer = null;
let canvas = null;
let uRes = null;
let uTime = null;

let writeIndex = 0;
let liveUntil = 0;          // performance.now() ms after which nothing is alive
let raf = 0;
let startTime = 0;
let cssW = 0;
let cssH = 0;
let dpr = 1;
let initFailed = false;
let resizeHandler = null;

// One staging array reused by every burst. Sized for the largest preset so a
// burst never allocates; bufferSubData reads only the prefix it is given.
const staging = new Float32Array(MAX_PARTICLES * FLOATS_PER_PARTICLE);

function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
    }
    return s;
}

function qualityScale() {
    try {
        const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gfx-particles'));
        return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
        return 1;
    }
}

function motionReduced() {
    try {
        if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/** Resolve a colour token to 0..1 RGB, cached per token per resolution pass. */
const _tintCache = new Map();
function accentRgb(varName, fallback) {
    if (_tintCache.has(varName)) return _tintCache.get(varName);
    let out = fallback;
    try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        if (raw) {
            const probe = document.createElement('span');
            probe.style.color = raw;
            probe.style.display = 'none';
            document.body.appendChild(probe);
            const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
            probe.remove();
            if (m) {
                const p = m[1].split(/[,\s/]+/).map(Number);
                if (p.length >= 3 && p.every((n) => Number.isFinite(n))) {
                    out = [p[0] / 255, p[1] / 255, p[2] / 255];
                }
            }
        }
    } catch { /* keep fallback */ }
    _tintCache.set(varName, out);
    return out;
}

/** Themes change on route transitions; drop the resolved-colour cache then. */
export function invalidateTint() {
    _tintCache.clear();
}

function resize() {
    if (!canvas) return;
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    // Particles are small bright shapes with hard-ish edges, so unlike the
    // background volume they do benefit from real resolution — but 2 is the
    // point of diminishing returns for a 7 px sprite.
    dpr = window.PoCanvasDpr.ceiling();   // audit #8: shared policy, js/canvasDpr.js
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}

function init() {
    if (gl || initFailed) return !!gl;
    if (typeof document === 'undefined' || !document.body) return false;

    canvas = document.createElement('canvas');
    canvas.className = 'po-gpufx';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);

    gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        // The overlay is fully redrawn every frame it is active, so preserving
        // the buffer between frames would only cost a copy.
        preserveDrawingBuffer: false,
        // Bursts are short and bright; on a laptop this should not be a reason
        // to spin up the discrete GPU.
        powerPreference: 'low-power',
    });
    if (!gl) { teardown(); initFailed = true; return false; }

    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) { teardown(); initFailed = true; return false; }

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { teardown(); initFailed = true; return false; }

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    // DYNAMIC_DRAW: written in sparse bursts, read every frame. Orphaning the
    // whole store once up front means a burst's bufferSubData never has to wait
    // on the GPU still reading the previous frame's contents.
    gl.bufferData(gl.ARRAY_BUFFER, MAX_PARTICLES * BYTES_PER_PARTICLE, gl.DYNAMIC_DRAW);

    const stride = BYTES_PER_PARTICLE;
    const attrs = [
        ['aP0', 2, 0],
        ['aV0', 2, 8],
        ['aColor', 3, 16],
        ['aParams', 4, 28],
        ['aFlags', 3, 44],
    ];
    for (const [name, size, offset] of attrs) {
        const loc = gl.getAttribLocation(prog, name);
        if (loc < 0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(loc, 1);   // one value per instance, not per vertex
    }

    gl.useProgram(prog);
    uRes = gl.getUniformLocation(prog, 'uResolution');
    uTime = gl.getUniformLocation(prog, 'uTime');

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied — see header

    resize();
    resizeHandler = () => resize();
    window.addEventListener('resize', resizeHandler, { passive: true });
    startTime = performance.now();
    return true;
}

function teardown() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    if (gl) {
        if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
        if (vao) gl.deleteVertexArray(vao);
        if (prog) gl.deleteProgram(prog);
        // Give the context back too, not just its objects. Removing the canvas
        // below detaches it but leaves the context live until GC, and the
        // browser's live-context pool (~16 per renderer process in Chrome) is
        // shared with every 3D game in this SPA — a leaked slot here is a
        // getContext() that returns null in PoBrawl later. See engineLoader's
        // isWebGlAvailable().
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    gl = null; prog = null; vao = null; instanceBuffer = null; canvas = null;
}

function frame(now) {
    if (!gl) return;
    if (now > liveUntil) {
        // Nothing alive. Clear once so the last frame does not linger, drop the
        // canvas out of the compositor, and stop scheduling entirely.
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        canvas.style.opacity = '0';
        raf = 0;
        return;
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(uRes, cssW, cssH);
    gl.uniform1f(uTime, (now - startTime) / 1000);
    // Every slot is drawn; expired ones self-cull in the vertex shader. Tracking
    // a live range on the CPU would mean sorting the ring, which costs more than
    // the degenerate vertices do.
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, MAX_PARTICLES);
    raf = requestAnimationFrame(frame);
}

function ensureFrame() {
    if (!raf && gl) {
        canvas.style.opacity = '1';
        raf = requestAnimationFrame(frame);
    }
}

function pickColor(hue) {
    if (hue === 'accent') return accentRgb('--fx-accent', [0.4, 0.68, 1.0]);
    if (hue === 'accent2') return accentRgb('--fx-accent-2', [0.0, 0.9, 1.0]);
    const pal = PALETTES[hue] || PALETTES.party;
    return pal[(Math.random() * pal.length) | 0];
}

/**
 * Emit a burst.
 * @param {object} o
 * @param {number} o.x            viewport CSS px
 * @param {number} o.y            viewport CSS px
 * @param {string} [o.preset]     one of PRESETS; defaults to 'sparks'
 * @param {number} [o.count]      overrides the preset count (before tier scaling)
 * @param {number} [o.scale=1]    scales count, speed and size together
 * @param {number[]} [o.color]    explicit 0..1 RGB, overriding the preset palette
 * @param {number} [o.angle]      centre of the emission cone, radians, 0 = right
 * @param {number} [o.spread]     cone width, radians
 */
export function burst(o) {
    if (!o || !init()) return;

    const p = PRESETS[o.preset] || PRESETS.sparks;
    const scale = o.scale == null ? 1 : Math.max(0.1, Math.min(3, o.scale));
    // Reduced motion keeps a token burst rather than nothing: the particle is
    // feedback about what just happened, and removing it entirely loses
    // information. A quarter of the count and no spin-heavy confetti is enough.
    const reduce = motionReduced();
    const q = qualityScale() * (reduce ? 0.25 : 1);
    const count = Math.max(1, Math.round((o.count || p.count) * scale * q));

    const t0 = (performance.now() - startTime) / 1000;
    const baseAngle = o.angle == null ? -Math.PI / 2 : o.angle;
    const spread = o.spread == null ? p.spread : o.spread;

    let n = 0;
    for (let i = 0; i < count; i++) {
        // Wrapping the write index rather than tracking free slots is what keeps
        // a burst O(count): the oldest particles are overwritten, which at 2400
        // slots means nothing visible is ever cut short in practice.
        const slot = writeIndex;
        writeIndex = (writeIndex + 1) % MAX_PARTICLES;

        const a = baseAngle + (Math.random() - 0.5) * spread;
        // sqrt of a uniform gives an even *area* distribution inside the cone;
        // a plain uniform bunches everything near the maximum speed and the
        // burst looks like a hollow shell.
        const sp = p.speed * scale * (0.35 + 0.65 * Math.sqrt(Math.random()));
        const col = o.color || pickColor(p.hue);

        const base = slot * FLOATS_PER_PARTICLE;
        staging[base + 0] = o.x + (Math.random() - 0.5) * 6;
        staging[base + 1] = o.y + (Math.random() - 0.5) * 6;
        staging[base + 2] = Math.cos(a) * sp;
        staging[base + 3] = Math.sin(a) * sp;
        staging[base + 4] = col[0];
        staging[base + 5] = col[1];
        staging[base + 6] = col[2];
        staging[base + 7] = p.size * scale * (0.7 + Math.random() * 0.6);
        staging[base + 8] = p.ttl * (0.75 + Math.random() * 0.5);
        staging[base + 9] = t0;
        staging[base + 10] = Math.random();
        staging[base + 11] = p.gravity;
        staging[base + 12] = p.drag;
        staging[base + 13] = p.additive;

        // Upload immediately when the ring wraps mid-burst, so the two halves
        // land in the right places; otherwise batch the contiguous run below.
        if (writeIndex === 0) {
            uploadRange(slot - n, n + 1);
            n = 0;
        } else {
            n++;
        }
    }
    if (n > 0) uploadRange(writeIndex - n, n);

    liveUntil = performance.now() + (p.ttl * 1.5) * 1000;
    ensureFrame();
}

function uploadRange(start, count) {
    if (count <= 0 || start < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferSubData(
        gl.ARRAY_BUFFER,
        start * BYTES_PER_PARTICLE,
        staging,
        start * FLOATS_PER_PARTICLE,
        count * FLOATS_PER_PARTICLE);
}

/**
 * Burst from the centre of an element — the common case, since callers almost
 * always mean "where that button/tile/cell is".
 * @param {Element|string} target element or CSS selector
 * @param {object} [opts] same shape as burst(), minus x/y
 */
export function burstAt(target, opts) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;   // detached or display:none
    burst({ ...(opts || {}), x: r.left + r.width / 2, y: r.top + r.height / 2 });
}

/**
 * Gravitational particle vortex implosion towards a target center.
 * @param {object} [opts]
 * @param {number} [opts.x] Viewport CSS px
 * @param {number} [opts.y] Viewport CSS px
 * @param {number} [opts.radius=160] Initial ring radius
 * @param {number[]} [opts.color] Explicit RGB
 */
export function vortex(opts) {
    if (!init()) return;
    const o = opts || {};
    const cx = o.x != null ? o.x : window.innerWidth / 2;
    const cy = o.y != null ? o.y : window.innerHeight / 2;
    const count = Math.min(180, Math.round(75 * qualityScale()));
    const t0 = (performance.now() - startTime) / 1000;
    const col = o.color || pickColor('accent');
    const radius = o.radius || 180;

    let n = 0;
    for (let i = 0; i < count; i++) {
        const slot = writeIndex;
        writeIndex = (writeIndex + 1) % MAX_PARTICLES;

        const theta = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        const r = radius * (0.6 + Math.random() * 0.6);
        const p0x = cx + Math.cos(theta) * r;
        const p0y = cy + Math.sin(theta) * r;

        // Inward velocity towards center + tangential spiral
        const speed = r / 0.55;
        const tangent = theta + Math.PI / 2;
        const vx = -Math.cos(theta) * speed + Math.cos(tangent) * (speed * 0.7);
        const vy = -Math.sin(theta) * speed + Math.sin(tangent) * (speed * 0.7);

        const base = slot * FLOATS_PER_PARTICLE;
        staging[base + 0] = p0x;
        staging[base + 1] = p0y;
        staging[base + 2] = vx;
        staging[base + 3] = vy;
        staging[base + 4] = col[0];
        staging[base + 5] = col[1];
        staging[base + 6] = col[2];
        staging[base + 7] = 8.5 * (0.8 + Math.random() * 0.6);
        staging[base + 8] = 0.55;
        staging[base + 9] = t0;
        staging[base + 10] = Math.random();
        staging[base + 11] = 0; // zero gravity
        staging[base + 12] = 1.8; // drag
        staging[base + 13] = 1.0; // additive glow

        if (writeIndex === 0) {
            uploadRange(slot - n, n + 1);
            n = 0;
        } else {
            n++;
        }
    }
    if (n > 0) uploadRange(writeIndex - n, n);

    liveUntil = Math.max(liveUntil, performance.now() + 650);
    ensureFrame();
}

/**
 * Confetti across the top of the viewport — the win celebration. Emitted from
 * a line rather than a point so it rains rather than explodes.
 * @param {number} [scale=1]
 */
export function celebrate(scale) {
    if (!init()) return;
    const s = scale == null ? 1 : scale;
    const jets = 7;
    for (let i = 0; i < jets; i++) {
        burst({
            x: (window.innerWidth * (i + 0.5)) / jets,
            y: -20,
            preset: 'confetti',
            scale: s,
            angle: Math.PI / 2,          // downward
            spread: Math.PI * 0.55,
        });
    }
}

/** Drop everything immediately — game teardown, route change. */
export function clear() {
    liveUntil = 0;
    if (gl && canvas) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        canvas.style.opacity = '0';
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', clear);
    // Non-module access for the plain-script engines and Blazor JS interop.
    window.PoFx = { burst, burstAt, vortex, celebrate, clear, invalidateTint };
}
