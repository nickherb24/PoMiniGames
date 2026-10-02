// posports/postfx.js — one WebGL2 pass over the finished Canvas 2D frame.
//
// Same arrangement as pojevarena/postfx.js: the meet is drawn in Canvas 2D and this
// pass only grades the picture: a glow on the bright pixels (floodlights, chalk,
// confetti), a chromatic kick on a stumble and a vignette. The 2D canvas stays
// underneath as the input (made transparent, not hidden), and must stay first in
// the DOM so anything that samples "the game's canvas" still finds it.
//
// Nothing here may move a pixel sideways by where it sits in the frame. A heat
// shimmer (a sine of y added to x across the band 20-50% down the frame) would hit
// the top lane: its hurdles and runner would be drawn wavy while every lane below
// stayed straight.
//
// Optional by design: no WebGL2, the low quality tier, reduced motion, or a lost
// context all return null / false, and the caller simply shows the 2D canvas.

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
uniform float punch, night;
void main() {
    vec2 uv = v;
    vec2 c = uv - 0.5;
    float ca = punch * 0.006;
    vec3 col = vec3(texture(tex, uv + c * ca).r, texture(tex, uv).g, texture(tex, uv - c * ca).b);
    float knee = mix(0.80, 0.72, night);
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 10; i++) {
        float a = float(i) * 0.6283;
        vec2 d = vec2(cos(a), sin(a)) * px;
        glow += max(texture(tex, uv + d * 6.0).rgb - knee, 0.0) + max(texture(tex, uv + d * 15.0).rgb - knee, 0.0) * 0.6;
    }
    col += glow * mix(0.035, 0.06, night);
    float vig = smoothstep(0.9, 0.3, length(c * vec2(1.1, 1.0)));
    col *= mix(1.0, vig, 0.22);
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
  return { prog, tex, loc: { px: u('px'), punch: u('punch'), night: u('night') } };
}

/**
 * Wraps `source` (the 2D canvas) with the pass drawn into `target` (a canvas over it).
 * Returns null when the pass is unavailable; the 2D canvas is then simply what shows.
 */
export function createPostFx(target, source, { reduced = false } = {}) {
  if (!target || reduced) return null;
  if ((document.documentElement.getAttribute('data-gfx') || 'high') === 'low') return null;
  const gl = target.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
  const built = gl && build(gl);
  if (!built) return null;
  const { prog, tex, loc } = built;

  target.hidden = false;
  source.classList.add('is-composited');

  return {
    /** Draws one frame; false means the pass is unusable now and the 2D canvas must show. */
    render({ punch = 0, night = 0 }) {
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
      gl.uniform1f(loc.night, night);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
    /** Hands the screen back to the 2D canvas and frees the context. */
    dispose() {
      target.hidden = true;
      source.classList.remove('is-composited');
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already lost */ }
    },
  };
}
