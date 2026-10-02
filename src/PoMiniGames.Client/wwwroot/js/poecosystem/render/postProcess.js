// postProcess.js — the PoEcosystem composer (GFX options 1, 2 and 6).
//
// Until this existed the game rendered straight to the canvas: no bloom, no shafts, no
// reaction to anything the island did. The chain is
//
//   RenderPass → UnrealBloomPass → AtmospherePass → BokehPass → OutputPass → SMAAPass
//
// and every link past the first is optional, so a low-tier machine still gets the plain
// `renderer.render()` path it had before (see the null facade in createPostProcess).
//
// WHY ONE "ATMOSPHERE" PASS RATHER THAN THREE
// God rays, chromatic aberration, radial blur and the vignette all work from the same
// radial basis (a screen-space vector from the pixel to either the sun or the centre), and
// all four are cheap per tap and expensive per pass. Merged, they cost one full-screen
// draw instead of four and — more importantly — stay coherent: a lightning strike smears,
// fringes and darkens the frame on one curve rather than on three that drift apart.
//
// TONE MAPPING
// three skips the tone-mapping chunk when a material renders into a render target, so the
// whole chain runs in linear HDR and OutputPass applies `renderer.toneMapping` at the end.
// That is the designed flow, and it is why the composer target is HalfFloat: clipping the
// scene to [0,1] before the bloom bright-pass would flatten exactly the highlights bloom
// exists to find.
//
// GFX PASS 2 — REFRACTION AND MOOD, STILL ONE PASS
// Everything below bends or tints the SAME full-screen draw, so it costs a few ALU ops
// per pixel and no extra render target:
//
//   HEAT       up to four screen-space heat sources (fires, lava — projected by the
//              renderer) shimmer the air ABOVE them; a drought adds a faint whole-frame
//              haze. Implemented as a UV offset applied before every texture read, so the
//              shafts, the fringe and the blur all see the same bent image.
//   SHOCKWAVE  two ring slots. An eruption or a near strike sends a refracting ring out
//              from its screen position; it is the one effect that tells you WHERE an
//              off-centre blast was before the sound arrives.
//   MOOD       a second grade on top of the day/night one: season, weather and sickness
//              tint the frame (warm summer, cold winter, a sickly green in an epidemic),
//              plus a saturation control the chronicle uses to drain the colour out of
//              the frame when a species dies.
//
// Importing ../../postFx.js has a side effect worth stating: that module publishes
// `window.PoThreeFx`, which impactFx.js needs to drive its punch envelope. Before this
// file, PoEcosystem never loaded postFx.js, so every app-wide impact preset silently
// no-opped inside this game.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { punchAberration, punchRadial } from '../../postFx.js';

// Shaft taps per tier. The cost of the atmosphere pass is dominated by this loop, so it is
// the first thing to give way — the aberration/blur/vignette terms are a handful of taps
// and stay on at every tier that runs the pass at all.
const SHAFT_TAPS = { high: 28, medium: 14 };

const ATMOSPHERE_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const atmosphereFrag = (taps) => `
#define SHAFT_TAPS ${taps}
uniform sampler2D tDiffuse;
uniform vec2 uSun;          // sun in screen UV; only read while uShaft > 0
uniform vec3 uShaftTint;
uniform float uShaft;       // 0..1 — visibility x facing x elevation, all decided on the CPU
uniform float uThreshold;   // luminance above which a pixel is treated as a light source
uniform float uAberration;  // radial RGB split at the frame edge, in UV units
uniform float uRadial;      // 0..1 zoom blur
uniform float uVignette;
uniform vec3 uGrade;        // per-channel multiplier: cool at night, warm at dusk
uniform float uGrain;       // film grain amplitude, 0 = off
uniform float uTime;
uniform float uAspect;
uniform vec4 uHeat[4];      // uv.x, uv.y, radius (uv, vertical), strength
uniform float uHaze;        // drought shimmer, 0..1
uniform vec4 uShock[2];     // uv.x, uv.y, radius (uv, aspect-corrected), strength
uniform vec3 uMood;         // per-channel mood grade
uniform float uSaturation;  // 1 = unchanged
uniform float uUnder;       // 0..1 the camera is below the waterline
varying vec2 vUv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  // ── refraction: every term bends the UV that all the reads below use ──
  vec2 uv = vUv;
  vec2 bend = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 h = uHeat[i];
    if (h.w <= 0.001) continue;
    vec2 rel = (vUv - h.xy) / vec2(h.z * 0.7 / uAspect, h.z * 2.4);
    // Above the source only: heat rises. Strongest just over the flame.
    float above = smoothstep(-0.15, 0.1, rel.y) * (1.0 - smoothstep(0.4, 1.0, rel.y));
    float m = above * (1.0 - smoothstep(0.35, 1.0, abs(rel.x))) * h.w;
    bend += vec2(sin(vUv.y * 160.0 - uTime * 9.0 + sin(vUv.x * 70.0) * 2.0),
                 cos(vUv.x * 130.0 + uTime * 7.0)) * 0.0024 * m;
  }
  if (uHaze > 0.001) {
    float low = 1.0 - smoothstep(0.2, 0.62, vUv.y);
    bend += vec2(sin(vUv.y * 220.0 - uTime * 6.0), 0.0) * 0.0009 * uHaze * low;
  }
  for (int i = 0; i < 2; i++) {
    vec4 s = uShock[i];
    if (s.w <= 0.001) continue;
    vec2 away = (vUv - s.xy) * vec2(uAspect, 1.0);
    float dist = length(away);
    float k = (dist - s.z) / 0.045;
    float ring = exp(-k * k) * s.w;
    bend += (away / max(dist, 1e-4)) * vec2(1.0 / uAspect, 1.0) * ring * 0.028;
  }
  // Underwater: the whole frame sways on a slow swell.
  if (uUnder > 0.01) {
    bend += vec2(sin(vUv.y * 22.0 + uTime * 2.1), cos(vUv.x * 18.0 + uTime * 1.7)) * 0.0038 * uUnder;
  }
  uv += bend;

  vec2 toCentre = uv - 0.5;
  float r = length(toCentre);

  // Zoom blur first: it defines the base colour the fringe is split from, so a hit that
  // triggers both reads as one smeared image rather than a blur with a sharp ghost in it.
  vec3 col;
  if (uRadial > 0.001) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float t = float(i) / 5.0;
      acc += texture2D(tDiffuse, uv - toCentre * t * uRadial * 0.06).rgb;
    }
    col = acc * (1.0 / 6.0);
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  // Chromatic aberration scales with r, so the centre of the frame — where the player is
  // actually looking — stays clean however hard the island is shaking.
  if (uAberration > 0.0001) {
    vec2 off = toCentre * uAberration * r;
    col.r = texture2D(tDiffuse, uv + off).r;
    col.b = texture2D(tDiffuse, uv - off).b;
  }

  // Light shafts: march toward the sun accumulating whatever is bright enough to be sky.
  // There is no occlusion buffer — the threshold IS the occlusion test, which is why the
  // terrain (dark, and darker still under its own shadow) silhouettes correctly for free.
  if (uShaft > 0.001) {
    vec2 delta = (uv - uSun) * (0.92 / float(SHAFT_TAPS));
    vec2 p = uv;
    float decay = 1.0;
    vec3 shaft = vec3(0.0);
    for (int i = 0; i < SHAFT_TAPS; i++) {
      p -= delta;
      vec3 s = texture2D(tDiffuse, p).rgb;
      shaft += s * smoothstep(uThreshold, uThreshold + 0.4, luma(s)) * decay;
      decay *= 0.955;
    }
    col += shaft * uShaftTint * (uShaft / float(SHAFT_TAPS));
  }

  col *= 1.0 - uVignette * smoothstep(0.34, 0.92, r);

  // Grade, then grain. The grade is a plain per-channel multiply — enough to make night
  // read cool and dusk warm without a LUT. The grain is a per-pixel hash reseeded every
  // frame, scaled down in the highlights so the sky does not sizzle.
  col *= uGrade * uMood;
  col = mix(vec3(luma(col)), col, uSaturation);
  // Water takes the red first and the edges of the frame with it.
  if (uUnder > 0.01) {
    col = mix(col, col * vec3(0.3, 0.8, 0.92) + vec3(0.0, 0.025, 0.045), uUnder * 0.88);
    col *= 1.0 - uUnder * 0.4 * smoothstep(0.18, 0.85, r);
  }
  if (uGrain > 0.0001) {
    float gr = fract(sin(dot(vUv * vec2(1213.0, 819.0) + fract(uTime) * 7.31, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    col += gr * uGrain * (1.0 - smoothstep(0.6, 1.4, luma(col)) * 0.7);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function atmosphereShader(taps) {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uSun: { value: new THREE.Vector2(0.5, 0.8) },
      uShaftTint: { value: new THREE.Color(1, 0.94, 0.82) },
      uShaft: { value: 0 },
      uThreshold: { value: 0.55 },
      uAberration: { value: 0 },
      uRadial: { value: 0 },
      uVignette: { value: 0.26 },
      uGrade: { value: new THREE.Color(1, 1, 1) },
      uGrain: { value: 0 },
      uTime: { value: 0 },
      uAspect: { value: 1 },
      uHeat: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 0)) },
      uHaze: { value: 0 },
      uShock: { value: [0, 1].map(() => new THREE.Vector4(0, 0, 0, 0)) },
      uMood: { value: new THREE.Color(1, 1, 1) },
      uSaturation: { value: 1 },
      uUnder: { value: 0 },
    },
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: atmosphereFrag(taps),
  };
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 * @param {{ tier?: string, width?: number, height?: number, pixelRatio?: number }} opts
 * @returns a composer facade; on the low tier, a null facade that draws directly.
 */
export function createPostProcess(renderer, scene, camera, { tier = 'high', width = 1, height = 1, pixelRatio = 1 } = {}) {
  // The null facade exists so renderer.js has exactly one code path. `render()` falling
  // back to a direct draw is the whole of the low-tier story.
  if (tier === 'low') {
    return {
      enabled: false,
      render: () => renderer.render(scene, camera),
      setSize: () => {}, setPixelRatio: () => {}, update: () => {},
      setSun: () => {}, setNight: () => {}, rack: () => {}, dispose: () => {},
      setHeat: () => {}, setHaze: () => {}, shockwave: () => {},
      setMood: () => {}, dip: () => {}, setUnderwater: () => {},
    };
  }

  const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType,
    samples: tier === 'high' ? 4 : 0,     // MSAA in the composer target; SMAA cleans up the rest
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);

  composer.addPass(new RenderPass(scene, camera));

  // Bloom strength is driven from setNight(): daylight needs almost none (the sky is
  // already the brightest thing on screen, and blooming it just fogs the frame), while at
  // night lava, fire and the selection outline are the only bright pixels and should glow.
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.32, 0.72, 0.85);
  composer.addPass(bloom);

  const atmosphere = new ShaderPass(atmosphereShader(SHAFT_TAPS[tier] ?? 14));
  composer.addPass(atmosphere);

  // Keep the island sharp during events and automatic camera shots.

  composer.addPass(new OutputPass());

  // SMAA after OutputPass: edge detection wants display-space luminance, not linear HDR.
  const smaa = tier === 'high' ? new SMAAPass(width, height) : null;
  if (smaa) composer.addPass(smaa);

  const u = atmosphere.uniforms;
  u.uGrain.value = tier === 'high' ? 0.004 : 0.0;
  u.uAspect.value = Math.max(0.1, width / Math.max(1, height));
  // Shockwaves in flight: { x, y, age, strength }. Two slots; a third replaces the oldest.
  const shocks = [];
  const SHOCK_SECONDS = 1.1;
  // The mood grade eases toward its target so a season turning, or an outbreak taking
  // hold, reads as a drift rather than a cut; the saturation dip is the one fast move.
  const moodTarget = new THREE.Color(1, 1, 1);
  let satTarget = 1; let dipAmount = 0; let dipHold = 0;
  const NIGHT_GRADE = new THREE.Color(0.84, 0.9, 1.1);
  const DUSK_GRADE = new THREE.Color(1.08, 0.97, 0.9);
  const DAY_GRADE = new THREE.Color(1, 1, 1);

  return {
    enabled: true,
    composer,
    bloom,
    render: () => composer.render(),

    /**
     * Per-frame. Folds the shared impact envelope (impactBus, via postFx) into the
     * atmosphere uniforms. The values are recomputed from scratch every frame rather than
     * accumulated, so there is never anything to unwind.
     */
    update(dt) {
      u.uAberration.value = punchAberration(1);
      u.uRadial.value = punchRadial(0.5);
      u.uTime.value += dt;
      for (let i = shocks.length - 1; i >= 0; i--) {
        shocks[i].age += dt;
        if (shocks[i].age >= SHOCK_SECONDS) shocks.splice(i, 1);
      }
      for (let i = 0; i < 2; i++) {
        const s = shocks[i]; const v = u.uShock.value[i];
        if (!s) { v.w = 0; continue; }
        const t = s.age / SHOCK_SECONDS;
        v.set(s.x, s.y, 0.04 + t * 0.9, s.strength * (1 - t) * (1 - t));
      }
      const k = Math.min(1, dt * 0.35);
      u.uMood.value.lerp(moodTarget, k);
      if (dipHold > 0) dipHold -= dt; else dipAmount = Math.max(0, dipAmount - dt * 0.12);
      const sat = satTarget * (1 - dipAmount * 0.85);
      u.uSaturation.value += (sat - u.uSaturation.value) * Math.min(1, dt * (dipHold > 0 ? 3 : 0.8));
    },

    /** Up to four heat sources: [{ x, y, radius, strength }] in screen UV; the rest cleared. */
    setHeat(list) {
      for (let i = 0; i < 4; i++) {
        const h = list?.[i]; const v = u.uHeat.value[i];
        if (!h) v.w = 0; else v.set(h.x, h.y, h.radius, h.strength);
      }
    },
    setHaze(v) { u.uHaze.value = Math.max(0, Math.min(1, v)); },
    /** A refracting ring from a screen-UV point; strength 0..1. */
    shockwave(x, y, strength) {
      if (strength <= 0.02) return;
      if (shocks.length >= 2) shocks.shift();
      shocks.push({ x, y, age: 0, strength: Math.min(1, strength) });
    },
    /** 0..1: how far under the waterline the camera is (the renderer eases it). */
    setUnderwater(v) { u.uUnder.value = Math.max(0, Math.min(1, v)); },
    /**
     * Mood grade (a THREE.Color multiplier) and saturation, eased toward. `snap` jumps
     * there: a lens being switched is the viewer's own act and should answer at once.
     */
    setMood(grade, saturation = 1, snap = false) {
      moodTarget.copy(grade); satTarget = saturation;
      if (snap) { u.uMood.value.copy(grade); u.uSaturation.value = saturation; }
    },
    /** Drain the colour out of the frame for `seconds`, then let it come back slowly. */
    dip(amount = 1, seconds = 4) { dipAmount = Math.max(dipAmount, Math.min(1, amount)); dipHold = Math.max(dipHold, seconds); },

    /**
     * @param {THREE.Vector2|null} screenUv sun position in UV, or null when it is behind
     *   the camera / off screen — shafts are then skipped rather than marched to a point
     *   that is not there.
     * @param {number} strength 0..1
     * @param {THREE.Color} [tint]
     */
    setSun(screenUv, strength, tint) {
      if (!screenUv || strength <= 0) { u.uShaft.value = 0; return; }
      u.uSun.value.copy(screenUv);
      u.uShaft.value = strength;
      if (tint) u.uShaftTint.value.copy(tint);
    },

    /** dayFraction-driven look: bloom, vignette and the colour grade all lean on the hour. */
    setNight(night, dusk = 0) {
      const n = Math.max(0, Math.min(1, night));
      const d = Math.max(0, Math.min(1, dusk));
      bloom.strength = 0.32 + n * 0.5;
      bloom.threshold = 0.85 - n * 0.42;     // at night, far less has to be bright to glow
      u.uVignette.value = 0.22 + n * 0.2;
      u.uGrade.value.copy(DAY_GRADE).lerp(NIGHT_GRADE, n).lerp(DUSK_GRADE, d * 0.6);
    },

    // Keep the event facade compatible without changing camera focus.
    rack() {},

    setSize(w, h) {
      u.uAspect.value = Math.max(0.1, w / Math.max(1, h));
      composer.setSize(w, h);
      bloom.setSize(w, h);
      smaa?.setSize(w, h);
    },
    setPixelRatio(dpr) { composer.setPixelRatio(dpr); },
    dispose() {
      bloom.dispose?.();
      smaa?.dispose?.();
      composer.dispose();
      target.dispose();
    },
  };
}
