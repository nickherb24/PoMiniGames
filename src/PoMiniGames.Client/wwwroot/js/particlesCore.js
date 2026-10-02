// particlesCore.js — the ambient background renderer, shared by the worker and
// the main-thread fallback. Keeping one copy means the two render paths can
// never drift visually.
//
// It draws a single full-screen ray-marched volume rather than a field of point
// quads. The reasons are both quality and cost:
//
//   COST   — 200 quads is 1,200 vertices and 200 overlapping alpha-blended
//            fragments' worth of overdraw, and every one of them would run a
//            fragment shader that computes a soft circle. One full-screen
//            triangle has 3 vertices and zero overdraw. The march is more
//            expensive *per pixel*, which is why the backing store is
//            downscaled by tier (see ambientParticles.js) — but it is bounded
//            and predictable, where overdraw was neither.
//
//   QUALITY — points drift; they cannot occlude, self-shadow, or have depth.
//            Marching a domain-warped FBM volume gives real parallax and a
//            soft accumulated interior that reads as atmosphere instead of
//            as dots on glass.
//
// ONE TRIANGLE, NOT TWO: a single oversized triangle covering the viewport
// avoids the diagonal seam where two triangles meet, along which the GPU
// rasterises a duplicated quad of pixels. Standard full-screen-pass practice.

/** Vertex count for the full-screen triangle. */
export const VERTEX_COUNT = 3;

export const VERT_SRC = `#version 300 es
// Positions are generated from gl_VertexID — no vertex buffer is bound at all.
// (0,0) (2,0) (0,2) in UV space maps to a triangle that covers the whole clip
// volume with room to spare.
out vec2 vUv;
void main() {
    vec2 uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUv = uv;
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG_SRC = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;        // seconds since start
uniform vec2  uMouse;       // 0..1, origin bottom-left
uniform vec2  uMouseVel;    // velocity, normalized/smoothed
uniform int   uSteps;       // march resolution, set from the quality tier
uniform vec3  uBands;       // bass, mid, treble — each 0..1, pre-smoothed
uniform vec3  uHueA;        // near/low colour  (linear-ish sRGB)
uniform vec3  uHueB;        // far/high colour

out vec4 frag;

// ── Value noise ────────────────────────────────────────────────────────────
// A hash-based value noise rather than gradient/simplex: one hash per corner
// instead of a gradient dot product, which at 30 samples per pixel per frame is
// a measurable difference, and the volume is soft enough that the extra
// isotropy of simplex would not be visible.
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);           // smoothstep interpolant
    return mix(
        mix(mix(hash13(i + vec3(0, 0, 0)), hash13(i + vec3(1, 0, 0)), f.x),
            mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
            mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
}

// Rotate between octaves. Without this, doubling the frequency on axis-aligned
// lattices stacks the grid artefacts of every octave in the same places and the
// result shows a visible square weave.
const mat3 OCT_ROT = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64);

float fbm3(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 3; i++) {
        s += a * vnoise(p);
        p = OCT_ROT * p * 2.03;
        a *= 0.5;
    }
    return s;
}

// ── Volume ─────────────────────────────────────────────────────────────────
// Domain warping is what turns "clouds" into "aurora": offsetting the sample
// point by another noise field stretches the isosurfaces into filaments and
// curtains instead of blobs.
float density(vec3 p, float t) {
    vec3 warp = vec3(
        fbm3(p * 0.55 + vec3(0.0, t * 0.05, 0.0)),
        fbm3(p * 0.50 + vec3(4.7, 1.3, t * 0.04)),
        fbm3(p * 0.60 + vec3(9.2, t * 0.03, 2.1)));

    // Bass widens the warp — the curtains visibly billow on a kick without the
    // brightness jumping, which is far less fatiguing than a straight flash.
    vec3 q = p + (warp - 0.5) * (1.15 + uBands.x * 0.9);

    float d = fbm3(q * 1.05 + vec3(0.0, -t * 0.10, t * 0.025));

    // Vertical envelope: fade in from below, out above, so the volume reads as
    // a band of atmosphere rather than filling the frame edge to edge.
    float env = smoothstep(-1.5, -0.1, p.y) * smoothstep(1.7, 0.25, p.y);

    // The threshold is what separates wisps from fog. Mid energy lowers it,
    // so busier music genuinely thickens the sky.
    return smoothstep(0.50 - uBands.y * 0.10, 0.92, d * env);
}

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / max(uResolution.y, 1.0);

    // Camera. The mouse gives a small parallax push rather than a full orbit —
    // this is background, and anything that tracks the cursor closely pulls
    // attention away from the game in front of it.
    vec2 par = (uMouse - 0.5) * 0.35;
    vec3 ro = vec3(par.x, par.y * 0.6, -2.6);
    vec3 rd = normalize(vec3(uv, 1.5));

    // Per-pixel march offset. Without this the fixed step size quantises the
    // volume into visible concentric shells; jittering the start by a fraction
    // of one step converts that banding into fine noise the eye integrates away.
    float dither = hash13(vec3(gl_FragCoord.xy, uTime * 60.0));

    int steps = uSteps;
    float span = 3.4;
    float dt = span / float(steps);

    vec3 col = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < 64; i++) {
        if (i >= steps) break;
        vec3 p = ro + rd * (1.0 + (float(i) + dither) * dt);
        float d = density(p, uTime);
        if (d > 0.002) {
            // Colour by height through the volume, so the top of a curtain is a
            // different hue from its base — the single strongest cue that the
            // thing has vertical extent.
            vec3 c = mix(uHueA, uHueB, clamp(p.y * 0.45 + 0.5, 0.0, 1.0));
            // Treble rides the highlights only. Putting it on the whole volume
            // makes the background strobe with the hi-hats.
            c += uHueB * uBands.z * 0.35 * d;
            float a = d * 0.17;
            col += c * a * trans;          // premultiplied accumulation
            trans *= (1.0 - a);
            if (trans < 0.02) break;       // fully occluded — stop early
        }
    }

    // Soft pointer bloom + interactive fluid curl wake & dye swirl
    vec2 mNorm = gl_FragCoord.xy / uResolution;
    float md = distance(mNorm, uMouse);
    float speed = length(uMouseVel);
    float swirl = sin(atan(mNorm.y - uMouse.y, mNorm.x - uMouse.x) * 3.0 - uTime * 3.5 + md * 14.0);
    float wake = exp(-md * 5.5) * (0.05 + speed * 0.45);
    vec3 dye = mix(uHueA, uHueB, clamp(0.5 + 0.5 * swirl, 0.0, 1.0));
    col += dye * wake;

    float alpha = clamp(1.0 - trans, 0.0, 1.0);
    // Canvas is created with premultipliedAlpha:true and \`col\` was accumulated
    // premultiplied, so it is emitted as-is. Multiplying by alpha here would
    // darken the volume twice.
    frag = vec4(col, alpha * 0.85);
}`;

function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
    }
    return s;
}

/**
 * Compile, link and cache uniform locations. Works against a real canvas or an
 * OffscreenCanvas — the GL calls are identical either way, which is the whole
 * reason the worker port is cheap.
 *
 * A VAO is still created and bound even though no attributes are used: WebGL2
 * treats drawing with the default VAO as valid but some drivers warn, and a
 * bound empty VAO is the portable way to say "this pass is vertex-ID driven".
 * @returns {{program:WebGLProgram, vao:WebGLVertexArrayObject}|null}
 */
export function initGl(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // The shader objects are reference-counted by the program once attached;
    // deleting them here frees the compiler's copy immediately.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return null;
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.useProgram(program);

    // No depth, no blend: one opaque-ordered pass writing straight to a cleared
    // transparent target. Blending here would only cost fill rate.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    return {
        program,
        vao,
        uRes: gl.getUniformLocation(program, 'uResolution'),
        uTime: gl.getUniformLocation(program, 'uTime'),
        uMouse: gl.getUniformLocation(program, 'uMouse'),
        uMouseVel: gl.getUniformLocation(program, 'uMouseVel'),
        uSteps: gl.getUniformLocation(program, 'uSteps'),
        uBands: gl.getUniformLocation(program, 'uBands'),
        uHueA: gl.getUniformLocation(program, 'uHueA'),
        uHueB: gl.getUniformLocation(program, 'uHueB'),
    };
}

/** Default palette — the app's blue/violet, used until a game tints the field. */
export const DEFAULT_HUE_A = [0.24, 0.52, 0.95];
export const DEFAULT_HUE_B = [0.62, 0.32, 0.90];

/**
 * One frame.
 * @param {WebGL2RenderingContext} gl
 * @param {object} u        result of initGl
 * @param {number} w        drawing-buffer width
 * @param {number} h        drawing-buffer height
 * @param {number} elapsedMs
 * @param {number} mouseX   0..1
 * @param {number} mouseY   0..1
 * @param {object} s        {quality, bass, mid, treble, hueA, hueB, mouseVx, mouseVy}
 */
export function drawFrame(gl, u, w, h, elapsedMs, mouseX, mouseY, s) {
    const q = s && Number.isFinite(s.quality) ? Math.max(0, Math.min(1, s.quality)) : 1;
    // 10 steps still resolves the large-scale curtains; below that the volume
    // starts to look like flat gradient bands and the effect is lost.
    //
    // The ceiling is `10 + q*14` (24 at high tier), not `10 + q*24`. The volume
    // is a soft FBM field; the extra 10 steps at the top end buy
    // depth-resolution past the point the eye can resolve the difference but
    // cost ~40% of the per-pixel budget.
    const steps = Math.round(10 + q * 14);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(u.program);
    gl.bindVertexArray(u.vao);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, elapsedMs / 1000);
    gl.uniform2f(u.uMouse, mouseX, mouseY);
    if (u.uMouseVel) gl.uniform2f(u.uMouseVel, (s && s.mouseVx) || 0, (s && s.mouseVy) || 0);
    gl.uniform1i(u.uSteps, steps);
    gl.uniform3f(u.uBands, (s && s.bass) || 0, (s && s.mid) || 0, (s && s.treble) || 0);
    const a = (s && s.hueA) || DEFAULT_HUE_A;
    const b = (s && s.hueB) || DEFAULT_HUE_B;
    gl.uniform3f(u.uHueA, a[0], a[1], a[2]);
    gl.uniform3f(u.uHueB, b[0], b[1], b[2]);
    gl.drawArrays(gl.TRIANGLES, 0, VERTEX_COUNT);
}

/** Release GL objects. Safe to call with a partially-initialised handle. */
export function disposeGl(gl, u) {
    if (!gl || !u) return;
    if (u.vao) gl.deleteVertexArray(u.vao);
    if (u.program) gl.deleteProgram(u.program);
}
