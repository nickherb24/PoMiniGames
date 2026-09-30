// pojevarena/postfx.js — one WebGL2 pass over the finished Canvas 2D frame.
//
// The arena is drawn in Canvas 2D (SPEC §3: no three.js); this pass only grades the picture:
// a cheap single-pass glow on bright pixels (projectiles, heals, confetti), a chromatic split
// that follows the hit shake, a vignette that tints and pulses as units panic, and a warm
// desaturated grade for slow motion. The 2D canvas stays underneath as the input and the pointer
// target (it is made transparent, not hidden, so layout, picking and glassFx's capture of the
// largest canvas all still use it); the GL canvas sits over it with pointer-events off.
//
// It is optional by design: no WebGL2, the low quality tier, reduced motion, or a lost context
// all return null / false, and the caller simply shows the 2D canvas.

const VERT = `#version 300 es
out vec2 v;
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    v = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v;
out vec4 o;
uniform sampler2D tex;
uniform vec2 px;
uniform float punch, panic, grade, time;
void main() {
    vec2 c = v - 0.5;
    float ca = punch * 0.006;
    vec3 col = vec3(texture(tex, v + c * ca).r, texture(tex, v).g, texture(tex, v - c * ca).b);
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5236;
        vec2 d = vec2(cos(a), sin(a)) * px;
        glow += max(texture(tex, v + d * 6.0).rgb - 0.62, 0.0) + max(texture(tex, v + d * 14.0).rgb - 0.62, 0.0) * 0.6;
    }
    col += glow * 0.09;
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l) * vec3(1.08, 1.0, 0.9), grade * 0.55);
    float vig = smoothstep(0.85, 0.25, length(c * vec2(1.1, 1.0)));
    col *= mix(1.0, vig, 0.3 + panic * 0.25);
    col += vec3(0.1, 0.35, 0.6) * panic * (1.0 - vig) * 0.35 * (0.6 + 0.4 * sin(time * 6.0));
    o = vec4(col, 1.0);
}`;

function build(gl) {
    const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const u = (n) => gl.getUniformLocation(prog, n);
    return { prog, tex, loc: { px: u('px'), punch: u('punch'), panic: u('panic'), grade: u('grade'), time: u('time') } };
}

/**
 * Wraps `source` (the 2D canvas) with the pass drawn into `target` (a canvas over it). The GL
 * state is cached on the target element, because a WebGL context cannot be recreated on the same
 * canvas once lost, and the page keeps the element across matches.
 */
export function createPostFx(target, source, { reduced = false } = {}) {
    if (!target || reduced) return null;
    if ((document.documentElement.getAttribute('data-gfx') || 'high') === 'low') return null;
    let state = target.__jevPost;
    if (!state) {
        const gl = target.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
        const built = gl && build(gl);
        if (!built) return null;
        state = target.__jevPost = { gl, ...built };
    }
    const { gl, prog, tex, loc } = state;
    if (gl.isContextLost()) return null;

    target.hidden = false;
    source.classList.add('is-composited');

    return {
        /** Draws one frame; false means the pass is unusable now and the 2D canvas must show. */
        render({ punch = 0, panic = 0, grade = 0, time = 0 }) {
            if (gl.isContextLost() || !source.width) return false;
            if (target.width !== source.width || target.height !== source.height) {
                target.width = source.width;
                target.height = source.height;
            }
            gl.viewport(0, 0, target.width, target.height);
            gl.useProgram(prog);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.uniform2f(loc.px, 1 / target.width, 1 / target.height);
            gl.uniform1f(loc.punch, punch);
            gl.uniform1f(loc.panic, panic);
            gl.uniform1f(loc.grade, grade);
            gl.uniform1f(loc.time, time);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            return true;
        },
        /** Hands the screen back to the 2D canvas (match stopped, or the pass failed). */
        hide() {
            target.hidden = true;
            source.classList.remove('is-composited');
        },
    };
}
