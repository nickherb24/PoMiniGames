// quality.js — PoBrawl's adaptive-quality policy: per-tier renderer settings for
// visualRuntime's <html data-gfx> tier. game.js applies them at boot and again
// whenever the tier moves.
//
// Settings that force a material recompile must never change on a live renderer
// (a multi-frame hitch on a machine already dropping frames):
//   DYNAMIC (re-applied on every tier change): pixelRatio, pass.enabled,
//     shadow.mapSize, msaaSamples (rebuilds composer targets, so applied only
//     when the value moves). None of these touch a shader.
//   STATIC: rectAreaLights — light counts are #defines, fixed at the boot tier.
//     physicalMaterials — read per fighter build, so it picks up a tier change
//     at the next spawn.

import * as VisualRuntime from '../visualRuntime.js';

/**
 * Per-tier renderer settings.
 *
 * `maxDpr` is a CEILING applied on top of PoCanvasDpr.resolve(), never instead of
 * it — resolve() already enforces the shared ~1.44 Mpx backing-store budget that
 * protects large desktop windows, and this only tightens it further.
 */
const PRESETS = {
  high: {
    maxDpr: 2,
    msaaSamples: 4,
    // GTAO is the costliest pass (prepass + AO + denoise at full res). At this
    // camera distance 8 samples is indistinguishable from the stock 16.
    gtao: true,
    gtaoSamples: 8,
    bloom: true,
    // ~157 texels/m over the ±6.5 shadow frustum — past what PCFSoft resolves.
    keyShadow: 2048,
    // The overhead spot's shadow only reads during the KO push-in.
    spotShadow: 1024,
    rectAreaLights: 2,
    physicalMaterials: true,
  },
  medium: {
    maxDpr: 1.5,
    msaaSamples: 2,
    gtao: false,
    gtaoSamples: 8,
    bloom: true,
    keyShadow: 1024,
    // The key light already grounds the fighters; saves a second shadow render.
    spotShadow: 0,
    rectAreaLights: 1,
    // Sheen/clearcoat make the wardrobe read as fabric. See buildFighter's `dress`.
    physicalMaterials: true,
  },
  low: {
    maxDpr: 1,
    msaaSamples: 0,
    gtao: false,
    gtaoSamples: 8,
    bloom: false,
    keyShadow: 512,
    spotShadow: 0,
    // RectAreaLight adds an LTC lookup to every lit physical-material fragment.
    rectAreaLights: 0,
    // Dropping the extra BRDF lobes is the largest per-pixel saving at this tier.
    physicalMaterials: false,
  },
};

/** Current tier name. */
export function tier() {
  try {
    const t = VisualRuntime.getTier();
    return PRESETS[t] ? t : 'high';
  } catch {
    // visualRuntime is chrome; never let it decide whether the game runs.
    return 'high';
  }
}

/** Settings for the current tier. Always a valid preset. */
export function settings() {
  return PRESETS[tier()];
}

/**
 * Device pixel ratio for the given CSS size at the current tier.
 *
 * Uses PoCanvasDpr.resolve(), NOT .ceiling(): ceiling() has no total-pixel cap,
 * so a maximised DPR-2 window would allocate a ~14.7 Mpx backing store.
 */
export function pixelRatio(cssWidth, cssHeight) {
  const cap = settings().maxDpr;
  try {
    return window.PoCanvasDpr.resolve(cssWidth, cssHeight, { maxDpr: cap });
  } catch {
    return Math.min(window.devicePixelRatio || 1, cap);
  }
}

/**
 * Subscribe to tier changes. Returns an unsubscribe function.
 * visualRuntime dispatches `po-gfx-tier` on window when the measured tier moves.
 */
export function onTierChange(handler) {
  const fn = () => handler(tier(), settings());
  window.addEventListener('po-gfx-tier', fn);
  return () => window.removeEventListener('po-gfx-tier', fn);
}
