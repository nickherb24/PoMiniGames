// quality.js — renderer creation and the one place that decides how much GPU work the
// arena is allowed to spend (GFX pass, 2026-08-19).
//
// Two jobs:
//   1. createRenderer() — WebGPU first, WebGL2 fallback. WebGPU is opt-in per the notes
//      on WEBGPU_STATUS below; the fallback is the shipping default and both return the
//      same { renderer, api } shape so nothing downstream branches on it.
//   2. resolveQuality() — a tier (low/medium/high/ultra) that gates every expensive
//      feature added in the polish pass. Callers read booleans off the returned object;
//      they never sniff the GPU themselves, so one edit here retunes the whole game.
//
// The tier can be forced with ?gfx=low|medium|high|ultra on the page URL, which is how
// you A/B a pass without editing code. Auto-detection is deliberately crude — a device
// memory / core-count / mobile check — because the only alternative is a frame-time
// probe, and a probe that runs during world build measures the build, not the frame.

import { loadSettings } from './settings.js';

const TIERS = ['low', 'medium', 'high', 'ultra'];

// WebGPU status, honestly stated so nobody re-litigates it from the ticket title:
// three r165 (pinned in the app's import map) ships WebGPURenderer, but its post chain
// is the WebGL-only EffectComposer and the sky dome is raw GLSL — neither survives the
// move to WGSL. So WebGPU renders the arena correctly but with NO bloom, SSAO, shafts,
// or SMAA, which is a downgrade, not an upgrade. It is therefore probe-only and opt-in
// (?gpu=webgpu) until three is upgraded to a build that ships three/webgpu + TSL post.
export const WEBGPU_STATUS = Object.freeze({
  supported: typeof navigator !== 'undefined' && 'gpu' in navigator,
  usable: false,     // set true by createRenderer when a WebGPU context actually came up
  reason: 'three r165 post-processing is WebGL-only; WebGPU path renders unpostprocessed',
});

function urlFlag(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** Crude device class → tier. Never throws; unknown hardware lands on 'high'. */
export function detectTier() {
  const forced = (urlFlag('gfx') || '').toLowerCase();
  if (TIERS.includes(forced)) return forced;
  // The player's own choice (pause dialog → Graphics) beats the guess below.
  const chosen = loadSettings().gfx;
  if (TIERS.includes(chosen)) return chosen;

  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  if (mobile) return 'low';

  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4; // GB, Chromium-only; undefined elsewhere
  if (cores <= 4 || memory <= 4) return 'medium';
  if (cores >= 12 && memory >= 8) return 'ultra';
  return 'high';
}

/**
 * Feature switches per tier. Everything the polish pass added is listed here, so the
 * cost of a tier is readable in one screen instead of scattered across five modules.
 */
export function resolveQuality(tier = detectTier()) {
  const at = (min) => TIERS.indexOf(tier) >= TIERS.indexOf(min);
  const reducedMotion = !!(window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return {
    tier,
    reducedMotion,
    // Post chain
    bloom: true,                    // cheap and already shipped; never gated off
    smaa: at('medium'),             // edge shimmer is worst at high voxel density
    ssao: at('medium'),
    ssaoHalfRes: !at('ultra'),      // AO at half resolution below ultra
    godRays: at('high'),
    // Scene
    pbr: at('medium'),              // MeshStandardMaterial + env map vs MeshLambert
    envMap: at('high'),
    shadowMapSize: at('ultra') ? 4096 : at('high') ? 2048 : 1024,
    timeOfDay: true,                // pure uniform updates; free at every tier
    // Renders fewer pixels when frames run long, then hands them back when they do not.
    // Off at ultra: a machine on that tier asked for the picture, not the frame rate.
    dynamicResolution: !at('ultra'),
    // Content
    particles: at('low') ? (at('high') ? 4000 : 1200) : 0,
    decals: at('medium') ? (at('ultra') ? 120 : 48) : 0,
    // Simulated voxels in flight. These are real rigid bodies, so this is the single
    // most CPU-expensive setting in the file: every one of them is a broadphase entry
    // and a contact solve. Low tier keeps the old vanish-with-a-puff behaviour.
    // MEASURED against the physics step, not guessed. Every one of these is a rigid body
    // in cannon, and cannon costs roughly 0.15 ms per dynamic body per step in JS: 180 of
    // them measured 28 ms of an 81 ms step, on their own. These counts keep the effect —
    // stone visibly leaving the wall — at a price the simulation can pay.
    shrapnel: at('medium') ? (at('ultra') ? 140 : at('high') ? 90 : 48) : 0,
    // 2026-09-30 pass. All three are fragment/vertex-shader work with no CPU cost per
    // frame; the clip recorder is the exception (a canvas readback while it runs), so it
    // is the only one held back to the tiers that have the headroom.
    hotCarve: at('medium'),          // glowing rim on fresh cuts (materials.js)
    rainDrops: at('high') ? 1600 : at('medium') ? 800 : 0,
    collapseClip: at('high'),
    // Audio (cost is CPU on the audio thread, not GPU, but it tiers the same way)
    spatialAudio: true,
    convolutionReverb: at('medium'),
  };
}

/**
 * Build the renderer. Returns { renderer, api: 'webgpu' | 'webgl2' }.
 * WebGPU is only attempted when ?gpu=webgpu is present — see WEBGPU_STATUS.
 */
export async function createRenderer({ antialias = true } = {}) {
  if ((urlFlag('gpu') || '').toLowerCase() === 'webgpu' && WEBGPU_STATUS.supported) {
    try {
      const { default: WebGPURenderer } =
        await import('three/addons/renderers/webgpu/WebGPURenderer.js');
      const renderer = new WebGPURenderer({ antialias });
      await renderer.init();
      WEBGPU_STATUS.usable = true;
      console.info('[povoxelstrike/quality] WebGPU renderer active — post-processing is '
        + 'disabled on this path (' + WEBGPU_STATUS.reason + ').');
      return { renderer, api: 'webgpu' };
    } catch (e) {
      console.warn('[povoxelstrike/quality] WebGPU requested but unavailable; '
        + 'falling back to WebGL2:', e);
    }
  }
  const THREE = await import('three');
  return { renderer: new THREE.WebGLRenderer({ antialias }), api: 'webgl2' };
}
