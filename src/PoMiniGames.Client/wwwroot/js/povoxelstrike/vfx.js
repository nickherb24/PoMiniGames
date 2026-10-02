// vfx.js — screen feel and scene polish for PoVoxelStrike.
//
// Render path (WebGL2). The scene is rendered ONCE into an HDR target that owns a
// DepthTexture; every screen-space effect after that reads depth instead of re-rendering
// geometry, because the arena now carries ~2.2 M triangles and a second geometry pass
// (which is what three's stock SSAOPass/GTAOPass do) costs more than the effect is worth.
//
//   scene ─▶ sceneTarget (HDR + depth)
//              ├─▶ aoTarget     (½ res)  depth-only SSAO
//              ├─▶ shaftTarget  (¼ res)  radial sun shafts, sky-masked
//              └─▶ composer: Combine ─▶ UnrealBloom ─▶ Output(ACES) ─▶ SMAA ─▶ screen
//
// Everything above the Combine pass is gated by the quality tier (see quality.js), and
// the whole chain is best-effort: a composer failure falls back to a plain
// renderer.render() rather than killing the game, which is how it shipped and how the
// software-rendered CI browser still gets a picture.
//
// Also here: trauma screen shake, damage vignette, pooled muzzle light, shockwave rings,
// the gradient sky dome, and the time-of-day driver that moves the sun and repaints the
// sky, fog and shaft colour together.
//
// prefers-reduced-motion turns off shake and the damage flash (the two effects that move
// or strobe the whole viewport); the static passes stay.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const SHOCK_LIFE_S = 0.45;

// One in-game day. Short enough that a single run sees the light move, long enough that
// it never reads as a strobe. Phase 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
const DAY_LENGTH_S = 360;
// Start in bright morning, not at dusk. The fortress interior is the whole point of the
// game and a dusk start left the vault, the wards and every breach in near-darkness.
const START_PHASE = 0.34;

// Key colours per phase, interpolated by dayPhase. Kept as one table so the sky, the fog,
// the sun and the shafts can never drift out of agreement.
// `hemi` and `amb` are the two that matter indoors: neither is shadowed, so together they
// are the only light that reaches a vault with a roof on it. They were tuned for an
// outdoor arena and left every interior a grey silhouette.
//
// Night is deliberately NOT dark any more. This is a fortress you have to fight your way
// through; a realistic 0.15-intensity midnight made the objective invisible for a third
// of every cycle, so the night keys are lit like a full moon over snow rather than like
// actual night.
// Calibrated against actual frames, not by eye on the numbers: the first pass at these
// values (sun 3.8 / hemi 3.0 / exposure 1.45) blew the stone and the sky to white. Direct
// sun is back near its original level and the LIFT lives in `hemi` and `amb`, which is
// where it belongs — those are the two that are not shadowed, so they are what actually
// reaches an interior, and raising them brightens the vault without flaring the exterior.
const SKY_KEYS = [
  { p: 0.00, top: 0x141a30, horizon: 0x2a3350, sun: 0x8fa3cc, sunI: 0.90, hemi: 1.05, amb: 0.45 }, // midnight
  { p: 0.22, top: 0x2a3a60, horizon: 0x8a6270, sun: 0xffb277, sunI: 1.70, hemi: 1.35, amb: 0.48 }, // dawn
  { p: 0.35, top: 0x3f74b4, horizon: 0xa9c7e0, sun: 0xfff6ea, sunI: 2.50, hemi: 1.85, amb: 0.55 }, // morning
  { p: 0.50, top: 0x4a8ad4, horizon: 0xc2d9ee, sun: 0xfffdf6, sunI: 2.80, hemi: 2.05, amb: 0.60 }, // noon
  { p: 0.68, top: 0x3a63a0, horizon: 0xdcb083, sun: 0xffe4bb, sunI: 2.35, hemi: 1.75, amb: 0.55 }, // afternoon
  { p: 0.78, top: 0x263050, horizon: 0x6d7c9a, sun: 0xfff2df, sunI: 2.05, hemi: 1.50, amb: 0.50 }, // dusk
  { p: 0.88, top: 0x1a2140, horizon: 0x424c68, sun: 0xa9a0c0, sunI: 1.20, hemi: 1.20, amb: 0.48 }, // night falls
  { p: 1.00, top: 0x141a30, horizon: 0x2a3350, sun: 0x8fa3cc, sunI: 0.90, hemi: 1.05, amb: 0.45 }, // wraps
];

// ── Depth-only SSAO ────────────────────────────────────────────────────────
// Normals are reconstructed from neighbouring depth samples rather than a normal buffer:
// the arena is axis-aligned voxels, so finite differences give exact face normals almost
// everywhere, and skipping the normal pre-pass pays for the extra taps many times over.
//
// `sceneProjection` / `sceneProjectionInverse` are passed as explicit uniforms. The
// automatic `projectionMatrix` a ShaderMaterial receives belongs to the orthographic
// camera the full-screen quad is drawn with, NOT the scene camera — using it silently
// projects every AO sample into the wrong place and the effect degenerates into noise.
const SSAO_SHADER = {
  uniforms: {
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2() },
    sceneProjection: { value: new THREE.Matrix4() },
    sceneProjectionInverse: { value: new THREE.Matrix4() },
    radius: { value: 1.4 },
    intensity: { value: 1.0 },
    bias: { value: 0.035 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float radius, intensity, bias;
    uniform mat4 sceneProjection;
    uniform mat4 sceneProjectionInverse;
    varying vec2 vUv;

    float readDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

    vec3 viewPos(vec2 uv, float d) {
      vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 view = sceneProjectionInverse * clip;
      return view.xyz / view.w;
    }

    void main() {
      float d = readDepth(vUv);
      if (d >= 1.0) { gl_FragColor = vec4(1.0); return; } // sky is never occluded
      vec2 texel = 1.0 / resolution;
      vec3 p = viewPos(vUv, d);

      // Pick the closer horizontal/vertical neighbour on each axis so the normal is not
      // smeared across a silhouette edge (the classic depth-normal halo).
      vec3 pR = viewPos(vUv + vec2(texel.x, 0.0), readDepth(vUv + vec2(texel.x, 0.0)));
      vec3 pL = viewPos(vUv - vec2(texel.x, 0.0), readDepth(vUv - vec2(texel.x, 0.0)));
      vec3 pU = viewPos(vUv + vec2(0.0, texel.y), readDepth(vUv + vec2(0.0, texel.y)));
      vec3 pD = viewPos(vUv - vec2(0.0, texel.y), readDepth(vUv - vec2(0.0, texel.y)));
      vec3 dx = abs(pR.z - p.z) < abs(p.z - pL.z) ? (pR - p) : (p - pL);
      vec3 dy = abs(pU.z - p.z) < abs(p.z - pD.z) ? (pU - p) : (p - pD);
      vec3 n = normalize(cross(dx, dy));

      // Interleaved gradient noise: one rotation per pixel, no random texture to bind.
      float rot = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float ca = cos(rot * 6.2831853), sa = sin(rot * 6.2831853);

      const int SAMPLES = 12;
      float occlusion = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float fi = float(i);
        float ang = fi * 2.3999632 + rot * 6.2831853;           // golden-angle spiral
        float rad = radius * sqrt((fi + 0.5) / float(SAMPLES));
        vec3 dir = vec3(cos(ang), sin(ang), 0.0);
        dir.xy = vec2(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
        // Bias the disc along the normal so samples land in the hemisphere above the
        // surface instead of half of them starting inside it.
        vec3 s = p + (dir + n * 0.6) * rad;

        vec4 offset = sceneProjection * vec4(s, 1.0);
        vec2 sUv = (offset.xy / offset.w) * 0.5 + 0.5;
        if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;

        float sd = readDepth(sUv);
        if (sd >= 1.0) continue;
        vec3 sp = viewPos(sUv, sd);
        if (sp.z - s.z > bias) {                                 // view-space z is negative
          // Range check kills haloing where a far object sits behind a near one.
          occlusion += clamp(radius / max(0.0001, abs(p.z - sp.z)), 0.0, 1.0);
        }
      }
      float ao = 1.0 - (occlusion / float(SAMPLES)) * intensity;
      gl_FragColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
    }`,
};

// ── Sun shafts ─────────────────────────────────────────────────────────────
// Radial blur of a sky-only mask toward the sun's screen position. Runs at quarter
// resolution: shafts are low-frequency by nature, so the 24 taps land on 1/16th of the
// pixels and nobody has ever spotted the difference.
const SHAFT_SHADER = {
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    sunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    sunColor: { value: new THREE.Color(0xffe6c0) },
    density: { value: 0.85 },
    weight: { value: 0.24 },
    decay: { value: 0.94 },
    strength: { value: 0.0 }, // driven by sun elevation + whether it is on screen
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform vec2 sunScreen;
    uniform vec3 sunColor;
    uniform float density, weight, decay, strength;
    varying vec2 vUv;

    void main() {
      if (strength <= 0.001) { gl_FragColor = vec4(0.0); return; }
      const int STEPS = 24;
      vec2 delta = (vUv - sunScreen) * (density / float(STEPS));
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        uv -= delta;
        // Only unoccluded sky contributes — that is what makes a shaft a shaft.
        float d = texture2D(tDepth, uv).x;
        vec3 c = d >= 1.0 ? texture2D(tColor, uv).rgb : vec3(0.0);
        acc += c * illum * weight;
        illum *= decay;
      }
      gl_FragColor = vec4(acc * sunColor * strength / float(STEPS), 1.0);
    }`,
};

// ── Combine ────────────────────────────────────────────────────────────────
// One pass folds AO and shafts into the scene colour, so the chain never pays for a
// separate multiply and a separate add.
class CombinePass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tAo: { value: null },
        tShaft: { value: null },
        aoEnabled: { value: 0 },
        shaftEnabled: { value: 0 },
        // Four screen-feel terms folded into this pass rather than given
        // passes of their own — each is a few instructions on a fetch that already happens.
        uTime: { value: 0 },
        heat: { value: 0 },    // 0..1 gun heat above 70%: shimmer off the barrel
        dust: { value: 0 },    // 0..1 grit on the lens after a collapse nearby
        desat: { value: 0 },   // 0..1 the colour draining out at low HP
        flash: { value: 0 },   // 0..1 lightning
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene, tAo, tShaft;
        uniform float aoEnabled, shaftEnabled;
        uniform float uTime, heat, dust, desat, flash;
        varying vec2 vUv;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float valueNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
                     mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
        }

        void main() {
          vec2 uv = vUv;
          if (heat > 0.001) {
            // Strongest low and centre, where the gun is; gone by the screen edge.
            float m = heat * smoothstep(0.7, 0.0, distance(uv, vec2(0.5, 0.34)));
            uv += vec2(sin(uv.y * 95.0 + uTime * 9.0), cos(uv.x * 70.0 + uTime * 7.0)) * 0.0024 * m;
          }
          vec4 c = texture2D(tScene, uv);
          if (aoEnabled > 0.5) {
            float ao = texture2D(tAo, uv).r;
            // AO darkens ambient, not direct light, so keep a floor — a hard multiply
            // turns every voxel crease into a black seam at this density.
            c.rgb *= mix(0.55, 1.0, ao);
          }
          if (shaftEnabled > 0.5) c.rgb += texture2D(tShaft, vUv).rgb;
          if (dust > 0.001) {
            // Blotches of grit, thicker toward the edge of the glass. Screen-fixed on
            // purpose: it is on the lens, so it must not move with the world.
            float n = valueNoise(vUv * 6.0) * 0.6 + valueNoise(vUv * 19.0) * 0.4;
            n = smoothstep(0.5, 0.86, n) * (0.35 + 0.65 * smoothstep(0.12, 0.72, distance(vUv, vec2(0.5))));
            float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            c.rgb = mix(c.rgb, vec3(0.62, 0.55, 0.45) * (0.45 + luma), n * dust * 0.6);
          }
          if (desat > 0.001) {
            float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            c.rgb = mix(c.rgb, vec3(luma) * vec3(1.0, 0.93, 0.92), desat);
          }
          c.rgb *= 1.0 + flash * 1.5;
          gl_FragColor = c;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

export class Vfx {
  constructor(renderer, scene, camera, host, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.host = host;
    this.q = quality;
    this.reducedMotion = quality.reducedMotion;

    this.trauma = 0;
    this.time = 0;
    this.dayPhase = START_PHASE;
    this.shocks = [];
    // Combine-pass terms (see the uniforms there). Targets are eased in update().
    this._heat = 0;
    this._dust = 0;
    this._desat = 0;
    this._desatTarget = 0;
    this._flash = 0;
    this.overcast = 0;   // 0..1 from weather.js: greys the sky and takes the edge off the sun
    this.sun = null; // set by attachSun()
    this._sunDir = new THREE.Vector3(0.4, 0.8, 0.25).normalize();

    const size = renderer.getSize(new THREE.Vector2());
    const w = Math.max(1, Math.floor(size.x));
    const h = Math.max(1, Math.floor(size.y));
    this._buildTargets(w, h);

    // Offscreen quads for the two reduced-resolution effects. Rendered by hand before
    // composer.render() so they never interleave with the composer's buffer swapping.
    this.ssaoMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SSAO_SHADER.uniforms),
      vertexShader: SSAO_SHADER.vertexShader,
      fragmentShader: SSAO_SHADER.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.ssaoQuad = new FullScreenQuad(this.ssaoMaterial);
    this.shaftMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SHAFT_SHADER.uniforms),
      vertexShader: SHAFT_SHADER.vertexShader,
      fragmentShader: SHAFT_SHADER.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.shaftQuad = new FullScreenQuad(this.shaftMaterial);
    this.ssaoMaterial.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.shaftMaterial.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.shaftMaterial.uniforms.tColor.value = this.sceneTarget.texture;

    // Composer is best-effort: SwiftShader/odd drivers can refuse float targets, and the
    // game must render either way.
    this.composer = null;
    try {
      const ldr = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
      });
      this.composer = new EffectComposer(renderer, ldr);
      this.combinePass = new CombinePass();
      this.combinePass.material.uniforms.tScene.value = this.sceneTarget.texture;
      this.combinePass.material.uniforms.tAo.value = this.aoTarget.texture;
      this.combinePass.material.uniforms.tShaft.value = this.shaftTarget.texture;
      this.combinePass.material.uniforms.aoEnabled.value = this.q.ssao ? 1 : 0;
      this.combinePass.material.uniforms.shaftEnabled.value = this.q.godRays ? 1 : 0;
      this.composer.addPass(this.combinePass);

      // Bloom at HALF resolution. Its mip chain is the most expensive thing in the
      // chain, it is a low-frequency effect by definition, and at half res nobody has
      // ever picked it out of a line-up.
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(Math.max(1, w >> 1), Math.max(1, h >> 1)), 0.35, 0.5, 0.82);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
      if (this.q.smaa) {
        this.smaaPass = new SMAAPass(w, h); // after OutputPass: SMAA wants LDR input
        this.composer.addPass(this.smaaPass);
      }
    } catch (e) {
      console.warn('[povoxelstrike/vfx] post-processing unavailable, rendering plain:', e);
      this.composer = null;
    }

    // Damage vignette overlay (styled in PoVoxelStrikePage.razor.css via ::deep).
    this.hitOverlay = document.createElement('div');
    this.hitOverlay.className = 'pvs-hit';
    this.hitOverlay.style.opacity = '0';
    host.appendChild(this.hitOverlay);
    this._hitOpacity = 0;

    // Pooled muzzle light.
    this.muzzleLight = new THREE.PointLight(0xffc46b, 0, 14, 1.8);
    this.muzzleLight.visible = false;
    scene.add(this.muzzleLight);
    this._muzzleT = 0;

    this.shockGeometry = new THREE.RingGeometry(0.55, 1, 28);
    this.shockMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc27a, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });

    this._sunWorld = new THREE.Vector3();
    this._sunProjected = new THREE.Vector3();
  }

  _buildTargets(width, height) {
    const depth = new THREE.DepthTexture(width, height);
    depth.type = THREE.UnsignedIntType;
    this.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, depthTexture: depth, depthBuffer: true, stencilBuffer: false,
    });
    const aoDiv = this.q.ssaoHalfRes ? 2 : 1;
    this.aoTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(width / aoDiv)), Math.max(1, Math.floor(height / aoDiv)),
      { depthBuffer: false, stencilBuffer: false });
    this.shaftTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(width / 4)), Math.max(1, Math.floor(height / 4)),
      { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
  }

  /** Hand the sun + hemisphere lights over so time-of-day can drive them. */
  attachSun(sun, hemi, ambient = null) {
    this.sun = sun;
    this.hemi = hemi;
    // Ambient is the interior fill. Hemisphere light alone leans strongly on the up
    // vector, so a voxel wall's vertical faces inside a roofed room got almost nothing.
    this.ambient = ambient;
    this._applyDayPhase();
  }

  /** Gradient sky dome; call once after the scene exists. Returns the dome mesh. */
  buildSky() {
    const geometry = new THREE.SphereGeometry(430, 24, 14);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x151b2c) },
        horizonColor: { value: new THREE.Color(0x46536e) },
        sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.25).normalize() },
        sunColor: { value: new THREE.Color(0xfff2df) },
        sunIntensity: { value: 1 },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 sunDir;
        uniform vec3 sunColor;
        uniform float sunIntensity;
        varying vec3 vWorld;
        void main() {
          vec3 v = normalize(vWorld);
          float h = clamp(v.y, 0.0, 1.0);
          vec3 c = mix(horizonColor, topColor, pow(h, 0.55));
          // Sun disc + broad glow. The disc has to actually exist in the sky for the
          // shaft pass to have anything to mask against — a light rig alone gives none.
          float d = max(0.0, dot(v, normalize(sunDir)));
          c += sunColor * sunIntensity * (pow(d, 2200.0) * 6.0 + pow(d, 24.0) * 0.35);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geometry, material);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.background = null; // the dome is the background now
    this._applyDayPhase();
    return this.sky;
  }

  // ── Time of day ──────────────────────────────────────────────────────────

  /** Set the day phase directly, 0..1 (0 = midnight, 0.5 = noon). */
  setDayPhase(phase) {
    this.dayPhase = ((phase % 1) + 1) % 1;
    this._applyDayPhase();
  }

  _sample(phase) {
    let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
    for (let i = 0; i < SKY_KEYS.length - 1; i++) {
      if (phase >= SKY_KEYS[i].p && phase <= SKY_KEYS[i + 1].p) {
        a = SKY_KEYS[i]; b = SKY_KEYS[i + 1]; break;
      }
    }
    const t = b.p === a.p ? 0 : (phase - a.p) / (b.p - a.p);
    const k = {
      top: new THREE.Color(a.top).lerp(new THREE.Color(b.top), t),
      horizon: new THREE.Color(a.horizon).lerp(new THREE.Color(b.horizon), t),
      sun: new THREE.Color(a.sun).lerp(new THREE.Color(b.sun), t),
      sunI: a.sunI + (b.sunI - a.sunI) * t,
      hemi: a.hemi + (b.hemi - a.hemi) * t,
      amb: a.amb + (b.amb - a.amb) * t,
    };
    if (this.overcast > 0) {
      // Cloud cover: the sky greys toward its own luminance and the sun loses its edge.
      // The unshadowed fills (hemi, amb) keep most of their level — overcast light is
      // flat, not dark, and the vault still has to be readable in a storm.
      const o = this.overcast;
      const grey = new THREE.Color(0x66707f).multiplyScalar(0.35 + 0.65 * Math.min(1, k.sunI / 2.8));
      k.top.lerp(grey, o * 0.8);
      k.horizon.lerp(grey, o * 0.6);
      k.sunI *= 1 - 0.6 * o;
      k.hemi *= 1 - 0.12 * o;
    }
    return k;
  }

  _applyDayPhase() {
    const k = this._sample(this.dayPhase);
    // Sun arc: rises in +x, sets in −x, tilted on z so it never sits exactly overhead —
    // an overhead sun flattens every voxel face into the same shade.
    const ang = (this.dayPhase - 0.25) * Math.PI * 2;
    this._sunDir.set(Math.cos(ang), Math.sin(ang), 0.32).normalize();

    if (this.sun) {
      this.sun.position.copy(this._sunDir).multiplyScalar(140);
      this.sun.color.copy(k.sun);
      this.sun.intensity = k.sunI;
      this.sun.target.position.set(0, 0, 0);
      this.sun.target.updateMatrixWorld();
    }
    if (this.hemi) {
      this.hemi.intensity = k.hemi;
      this.hemi.color.copy(k.horizon).lerp(new THREE.Color(0xffffff), 0.55);
      this.hemi.groundColor.copy(k.horizon).multiplyScalar(0.45);
    }
    if (this.ambient) {
      this.ambient.intensity = k.amb;
      this.ambient.color.copy(k.horizon).lerp(new THREE.Color(0xffffff), 0.6);
    }
    if (this.sky) {
      const u = this.sky.material.uniforms;
      u.topColor.value.copy(k.top);
      u.horizonColor.value.copy(k.horizon);
      u.sunDir.value.copy(this._sunDir);
      u.sunColor.value.copy(k.sun);
      u.sunIntensity.value = Math.max(0, k.sunI / 3);
    }
    if (this.scene.fog) this.scene.fog.color.copy(k.horizon);
    this.shaftMaterial?.uniforms.sunColor.value.copy(k.sun);
    this.skyKey = k;
  }

  resize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.sceneTarget.setSize(w, h);
    const aoDiv = this.q.ssaoHalfRes ? 2 : 1;
    this.aoTarget.setSize(Math.max(1, Math.floor(w / aoDiv)), Math.max(1, Math.floor(h / aoDiv)));
    this.shaftTarget.setSize(Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
    this.composer?.setSize(w, h);
    this.smaaPass?.setSize(w, h);
  }

  /** Add shake trauma, 0..1 per event. Shake amplitude is trauma², so small events whisper. */
  addShake(amount) {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Red vignette pulse; intensity 0..1. */
  flashDamage(intensity) {
    if (this.reducedMotion) return;
    this._hitOpacity = Math.min(0.85, this._hitOpacity + intensity);
  }

  muzzleFlash(position) {
    this.muzzleLight.position.copy(position);
    this.muzzleLight.intensity = 55;
    this.muzzleLight.visible = true;
    this._muzzleT = 0.06;
  }

  shockwave(position) {
    const mesh = new THREE.Mesh(this.shockGeometry, this.shockMaterial.clone());
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.shocks.push({ mesh, life: SHOCK_LIFE_S, total: SHOCK_LIFE_S, grow: 14 });
  }

  /**
   * The dust front of a big collapse: the same ring, laid flat on the ground, slower,
   * wider and the colour of masonry. `groundY` keeps it on the surface rather than at the
   * height the mass detached from.
   */
  groundRing(position, groundY) {
    const material = this.shockMaterial.clone();
    material.color.set(0xb9ab95);
    material.blending = THREE.NormalBlending;
    const mesh = new THREE.Mesh(this.shockGeometry, material);
    mesh.position.set(position.x, groundY + 0.25, position.z);
    mesh.rotation.x = -Math.PI / 2;
    this.scene.add(mesh);
    this.shocks.push({ mesh, life: 1.1, total: 1.1, grow: 30, flat: true });
  }

  /** Gun heat, 0..1. Only the top 30% shimmers; reduced motion gets none (it moves the frame). */
  setHeat(heat) {
    this._heat = this.reducedMotion ? 0 : THREE.MathUtils.clamp((heat - 0.7) / 0.3, 0, 1);
  }

  /** Throw grit at the lens, 0..1. It settles over a few seconds. */
  lensDust(amount) { this._dust = Math.min(1, this._dust + amount); }

  /** How washed-out the picture should be, 0..1. Eased, so it never snaps. */
  setDesat(target) { this._desatTarget = target; }

  /** Lightning: a full-frame exposure spike that dies in a fraction of a second. */
  flash(amount) { this._flash = Math.min(1, this._flash + amount); }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);

    // Pin the dome to the camera. A world-pinned dome of radius R needs a far plane of
    // R + (camera distance from origin); riding the camera keeps it at exactly R, so the
    // sky can never clip no matter how far the player walks.
    if (this.sky) this.sky.position.copy(this.camera.position);

    if (this.q.timeOfDay) {
      this.dayPhase = (this.dayPhase + dt / DAY_LENGTH_S) % 1;
      this._applyDayPhase();
    }

    if (this._muzzleT > 0) {
      this._muzzleT -= dt;
      this.muzzleLight.intensity *= Math.exp(-dt * 40);
      if (this._muzzleT <= 0) this.muzzleLight.visible = false;
    }

    if (this._hitOpacity > 0.005) {
      this._hitOpacity *= Math.exp(-dt * 4.5);
      this.hitOverlay.style.opacity = this._hitOpacity.toFixed(3);
    } else if (this.hitOverlay.style.opacity !== '0') {
      this.hitOverlay.style.opacity = '0';
      this._hitOpacity = 0;
    }

    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.material.dispose();
        this.shocks.splice(i, 1);
        continue;
      }
      const t = 1 - s.life / s.total;
      s.mesh.scale.setScalar(1 + t * s.grow);
      s.mesh.material.opacity = (s.flat ? 0.5 : 0.8) * (1 - t);
      if (!s.flat) s.mesh.quaternion.copy(this.camera.quaternion); // billboard toward the camera
    }

    this._dust = Math.max(0, this._dust - dt * 0.28);
    this._flash *= Math.exp(-dt * 9);
    this._desat += (this._desatTarget - this._desat) * Math.min(1, dt * 2.5);
    if (this.combinePass) {
      const u = this.combinePass.material.uniforms;
      u.uTime.value = this.time;
      u.heat.value = this._heat;
      u.dust.value = this._dust;
      u.desat.value = this._desat;
      u.flash.value = this._flash < 0.004 ? 0 : this._flash;
    }
  }

  /**
   * Apply shake to the camera. Call AFTER the follow/lookAt has oriented it.
   * Layered sines at incommensurate frequencies read as noise without allocating one.
   */
  applyShake() {
    if (this.trauma <= 0) return;
    const a = this.trauma * this.trauma;
    const t = this.time;
    const yaw = a * 0.05 * (Math.sin(t * 31.7) + 0.6 * Math.sin(t * 47.3));
    const pitch = a * 0.04 * (Math.sin(t * 37.1) + 0.6 * Math.sin(t * 53.9));
    const roll = a * 0.025 * Math.sin(t * 41.3);
    this.camera.rotateY(yaw);
    this.camera.rotateX(pitch);
    this.camera.rotateZ(roll);
  }

  _renderAo() {
    const u = this.ssaoMaterial.uniforms;
    u.resolution.value.set(this.aoTarget.width, this.aoTarget.height);
    u.sceneProjection.value.copy(this.camera.projectionMatrix);
    u.sceneProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    this.renderer.setRenderTarget(this.aoTarget);
    this.renderer.clear();
    this.ssaoQuad.render(this.renderer);
  }

  _renderShafts() {
    const u = this.shaftMaterial.uniforms;
    // Sun screen position: a point far along the sun direction, projected. Shafts fade
    // out as the sun leaves the frustum or drops toward the horizon.
    this._sunWorld.copy(this._sunDir).multiplyScalar(400).add(this.camera.position);
    this._sunProjected.copy(this._sunWorld).project(this.camera);
    const sx = this._sunProjected.x * 0.5 + 0.5;
    const sy = this._sunProjected.y * 0.5 + 0.5;
    u.sunScreen.value.set(sx, sy);

    const behind = this._sunProjected.z > 1;
    const offscreen = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) - 0.5;
    const edgeFade = THREE.MathUtils.clamp(1 - offscreen / 0.35, 0, 1);
    const elevation = THREE.MathUtils.clamp(this._sunDir.y * 3, 0, 1);
    u.strength.value = behind ? 0 : edgeFade * elevation;

    this.renderer.setRenderTarget(this.shaftTarget);
    this.renderer.clear();
    this.shaftQuad.render(this.renderer);
  }

  render() {
    if (!this.composer) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    if (this.q.ssao) this._renderAo();
    if (this.q.godRays) this._renderShafts();

    this.renderer.setRenderTarget(null);
    this.composer.render();
  }

  dispose() {
    for (const s of this.shocks) { this.scene.remove(s.mesh); s.mesh.material.dispose(); }
    this.shocks.length = 0;
    this.shockGeometry.dispose();
    this.shockMaterial.dispose();
    this.scene.remove(this.muzzleLight);
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      this.sky.material.dispose();
    }
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    this.aoTarget.dispose();
    this.shaftTarget.dispose();
    this.ssaoQuad.dispose(); this.ssaoMaterial.dispose();
    this.shaftQuad.dispose(); this.shaftMaterial.dispose();
    // Composer render targets hold GPU memory; passes hold their own (bloom's mips).
    this.bloomPass?.dispose?.();
    this.smaaPass?.dispose?.();
    this.combinePass?.dispose?.();
    this.composer?.dispose?.();
    this.hitOverlay.remove();
  }
}
