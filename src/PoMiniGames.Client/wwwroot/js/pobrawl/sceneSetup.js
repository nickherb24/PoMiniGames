// sceneSetup.js — renderer, post chain, quality tier, shadows, IBL, anisotropy and
// the ink edge. Mixin (see mixin.js). Never reads match state; the sim stays in game.js.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import * as PostFx from '../postFx.js';
import * as Quality from './quality.js';
import { CAVignetteShader } from './postShader.js';

// scene.environmentIntensity; 0 disables IBL. game.js start() derives exposureBase
// from it. Kept low so it reflects in clearcoat/sheen without lifting the shadows.
export const ENV_INTENSITY = 0.38;

// Fresnel edge darkening in the fighters' own materials — free, unlike an inverted
// hull / OutlinePass (a second draw of every fighter mesh), and identical on capsules.
const INK_BASE = 0.55;      // resting edge strength
const INK_POWER = 2.6;      // Fresnel exponent — higher = tighter line

class SceneSetupMethods {
  // Build (or rebuild) the post chain: MSAA target, GTAO, bloom, afterimage, rack focus, CA/vignette.
  _buildComposer(w, h) {
    if (this.composer) {
      // EffectComposer.dispose() only frees its own targets — passes (GTAO's
      // internal buffers, bloom's mip chain) must be disposed explicitly.
      for (const p of this.composer.passes) p.dispose?.();
      try { this.composer.dispose(); } catch { /* already gone */ }
    }
    this.bloomPass = null;
    this.fxPass = null;
    this.afterimage = null;
    this.rackFocus = null;

    const q = Quality.settings();
    const pixelRatio = Quality.pixelRatio(w, h);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h);
    // _applyQuality rebuilds only when this changes (it is a render-target property).
    this._composerSamples = q.msaaSamples;

    // The composer's default target has no MSAA. Tiered 4 → 2 → 0.
    const composerRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: q.msaaSamples,
    });
    this.composer = new EffectComposer(this.renderer, composerRT);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // GTAO is by far the most expensive pass; 'high' tier only, at reduced samples.
    this.gtaoPass = null;
    try {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      // Guarded: the parameter name is three-version-specific.
      try { gtao.updateGtaoMaterial({ samples: q.gtaoSamples }); } catch { /* stock samples */ }
      gtao.enabled = q.gtao;
      this.gtaoPass = gtao;
      this.composer.addPass(gtao);
    } catch { /* AO is a nicety — never block the game on it */ }
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.55, 0.8);
    // EffectComposer skips a disabled pass entirely, so toggling `enabled` is a real saving.
    this.bloomPass.enabled = q.bloom;
    this.composer.addPass(this.bloomPass);
    // Frame-feedback smear for dashes/launches/super: one quad instead of ghost rig
    // copies. After bloom so the trail carries the glow. Off (free) until needed.
    this.afterimage = new AfterimagePass(0.0);
    this.afterimage.enabled = false;
    this.composer.addPass(this.afterimage);
    // KO-only DoF (see postFx.js). After bloom, so highlights defocus like a real lens.
    this.rackFocus = PostFx.createRackFocus(this.scene, this.camera, w, h);
    this.composer.addPass(this.rackFocus.pass);
    this.fxPass = new ShaderPass(CAVignetteShader);
    this.composer.addPass(this.fxPass);
    this.composer.addPass(new OutputPass());
  }

  /**
   * Re-apply the quality tier to the live renderer. `liveOnly` (a tier change
   * mid-match) applies just the pixel ratio and marks the rest dirty: toggling
   * bloom/GTAO, rebuilding the MSAA composer or flipping a shadow caster all
   * compile shaders, a 0.3-2 s freeze in a fight. resetMatch applies the rest
   * ahead of its warm-up.
   */
  _applyQuality(liveOnly = false) {
    const q = Quality.settings();
    const cw = this.container.clientWidth || 800;
    const ch = this.container.clientHeight || 540;

    const dpr = Quality.pixelRatio(cw, ch);
    if (this.renderer.getPixelRatio() !== dpr) {
      this.renderer.setPixelRatio(dpr);
      this.composer?.setPixelRatio(dpr);
      this.composer?.setSize(cw, ch);
      this.rackFocus?.setSize(cw, ch);
    }

    if (liveOnly) { this._qualityDirty = true; return; }
    this._qualityDirty = false;

    if (this.gtaoPass) this.gtaoPass.enabled = q.gtao;
    if (this.bloomPass) this.bloomPass.enabled = q.bloom;

    // MSAA samples live on the render target: the one post setting that needs a rebuild.
    if (this.composer && this._composerSamples !== q.msaaSamples) {
      this._buildComposer(cw, ch);
    }

    const L = this.arena?.lights;
    if (L) {
      this._setShadowSize(L.key, q.keyShadow);
      // spotShadow 0 = stop casting entirely (drops a whole shadow pass).
      if (q.spotShadow > 0) {
        L.spot.castShadow = true;
        this._setShadowSize(L.spot, q.spotShadow);
      } else if (L.spot.castShadow) {
        L.spot.castShadow = false;
        L.spot.shadow.map?.dispose();
        L.spot.shadow.map = null;
      }
    }
  }

  /** Resize one light's shadow map; three never frees the old target, so dispose it here. */
  _setShadowSize(light, size) {
    if (!light || light.shadow.mapSize.width === size) return;
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
    light.shadow.needsUpdate = true;
  }

  // Injects the Fresnel ink edge into one fighter rig's materials; returns the
  // uniforms so the super cinematic can drive them. Injected at `opaque_fragment`
  // (before OutputPass tone mapping) so the line survives AgX's shoulder.
  _applyInkEdge(rig) {
    if (INK_BASE <= 0) return [];
    const uniforms = [];
    const seen = new Set();
    rig.root.traverse((obj) => {
      const mats = obj.material
        ? (Array.isArray(obj.material) ? obj.material : [obj.material])
        : [];
      for (const m of mats) {
        // Materials are shared across meshes; injecting twice would leave half the rig on stale uniforms.
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        // Basic materials have no `normal` in scope for the chunk below.
        if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;

        const u = {
          uInk: { value: INK_BASE },
          uInkPower: { value: INK_POWER },
          // Navy, not black: pure black reads as a hole once bloom lights around it.
          uInkColor: { value: new THREE.Color(0x05070f) },
        };
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uInk = u.uInk;
          shader.uniforms.uInkPower = u.uInkPower;
          shader.uniforms.uInkColor = u.uInkColor;
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', /* glsl */`
              uniform float uInk;
              uniform float uInkPower;
              uniform vec3 uInkColor;
              void main() {`)
            .replace('#include <opaque_fragment>', /* glsl */`
              #include <opaque_fragment>
              {
                // vViewPosition is fragment→camera in view space; \`normal\` is
                // the shaded view-space normal (post normal-map). Their dot
                // falling toward 0 IS the silhouette.
                float _facing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
                float _ink = pow(1.0 - _facing, uInkPower) * uInk;
                gl_FragColor.rgb = mix(gl_FragColor.rgb, uInkColor, clamp(_ink, 0.0, 1.0));
                // The flat-white impact fill that used to close this block is
                // gone (2026-09-12) — see _impactFrame in vfx.js for why.
              }`);
        };
        m.needsUpdate = true;
        uniforms.push(u);
      }
    });
    return uniforms;
  }

  // IBL from a painted 512×256 equirect caricature of the arena through PMREM —
  // cheaper than a live cubemap, which would need re-rendering every round.
  _buildEnvironment() {
    if (ENV_INTENSITY <= 0) return;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');

    // v=0 is +Y (up) in three's equirect convention, v=1 is −Y (down).
    const sky = g.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0.00, '#39406e');   // ceiling / truss haze
    sky.addColorStop(0.42, '#161a2e');   // the dark upper hall
    sky.addColorStop(0.58, '#121526');   // horizon — darkest band
    sky.addColorStop(1.00, '#3d4680');   // ring canvas bounce (matches arena.js)
    g.fillStyle = sky;
    g.fillRect(0, 0, 512, 256);

    // Overhead house light: the highlight clearcoat lobes actually show.
    const pool = g.createRadialGradient(256, 26, 4, 256, 26, 120);
    pool.addColorStop(0, 'rgba(255, 246, 222, 1)');
    pool.addColorStop(0.35, 'rgba(255, 232, 186, 0.5)');
    pool.addColorStop(1, 'rgba(255, 232, 186, 0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, 512, 160);

    // Truss lenses: a moving fighter catches a sequence of highlights.
    const lens = ['#fff2d0', '#bcd0ff', '#fff2d0', '#ffd0d0'];
    for (let i = 0; i < 8; i++) {
      const x = 32 + i * 64;
      const lg = g.createRadialGradient(x, 58, 2, x, 58, 34);
      lg.addColorStop(0, lens[i % lens.length]);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.5;
      g.fillStyle = lg;
      g.fillRect(x - 34, 24, 68, 68);
    }
    g.globalAlpha = 1;

    // Red/blue corner lights 180° apart: opposing warm/cool rims.
    for (const [x, col] of [[96, 'rgba(255, 92, 92, 0.55)'], [352, 'rgba(96, 140, 255, 0.55)']]) {
      const cg = g.createRadialGradient(x, 148, 3, x, 148, 90);
      cg.addColorStop(0, col);
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = cg;
      g.fillRect(x - 90, 58, 180, 180);
    }

    // Crowd band: breaks up the horizon in reflections.
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * 512;
      const y = 132 + Math.random() * 34;
      g.fillStyle = `rgba(${120 + Math.random() * 60 | 0}, ${130 + Math.random() * 60 | 0}, 190, ${0.05 + Math.random() * 0.13})`;
      g.fillRect(x, y, 3 + Math.random() * 5, 2 + Math.random() * 3);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    // We own this render target; dispose() releases it (scene.traverse can't reach it).
    this._envRT = pmrem.fromEquirectangular(tex);
    this.scene.environment = this._envRT.texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    tex.dispose();
    pmrem.dispose();
  }

  // Anisotropic filtering for every scene texture (mainly the grazing-angle ring mat).
  _applyTextureAnisotropy() {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    if (!maxAniso || maxAniso <= 1) return;
    const aniso = Math.min(maxAniso, 8); // 8 is where the returns flatten
    const seen = new Set();
    const MAPS = ['map', 'roughnessMap', 'normalMap', 'bumpMap', 'aoMap',
                  'metalnessMap', 'emissiveMap', 'alphaMap'];
    this.scene.traverse((o) => {
      if (!o.isMesh && !o.isPoints) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!mat) continue;
        for (const slot of MAPS) {
          const tex = mat[slot];
          if (!tex || seen.has(tex.uuid) || tex.anisotropy === aniso) continue;
          seen.add(tex.uuid);
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }
    });
  }
}

export const SceneSetup = SceneSetupMethods.prototype;
