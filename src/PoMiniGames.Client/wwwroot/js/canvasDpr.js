// =============================================================
//  Shared canvas resolution policy
//
//  If every canvas game picked its own device-pixel-ratio cap, the same phone
//  (say 390x844 at devicePixelRatio 3) would get a crisp board game at 2.00x
//  (682px backing for 341 css) and a visibly soft racer at 1.25x (487px backing
//  for 390 css). The cap is a quality decision and belongs in ONE place; games
//  differ in what they draw, not in how sharp they deserve to be.
//
//  Two separate limits, and conflating them lets the caps drift apart:
//
//    MAX_DPR      — the sharpness ceiling. 2 is the point past which more
//                   backing pixels stop being perceptible on phone-class
//                   screens while continuing to cost fill rate linearly.
//    MAX_PIXELS   — a total backing-store budget, which is what actually
//                   protects a big desktop window. The budget alone handles
//                   large windows, so the DPR ceiling need not be lower than 2.
//
//  Applying the budget through the DPR (rather than clamping width or height)
//  scales both axes by the same factor, so the frame stays correctly
//  proportioned — clamping one axis stretches the image, which is a distortion
//  rather than a cap.
//
//  Loaded as a classic script (window.PoCanvasDpr) rather than an ES module
//  because racingInterop.js is a classic script and cannot import; the ES
//  modules read the same global, so there is still exactly one policy.
// =============================================================
(function () {
    'use strict';

    var MAX_DPR = 2;
    var MAX_PIXELS = 1600 * 900;   // ~1.44 Mpx backing-store budget

    /**
     * Resolve the device-pixel-ratio to render a canvas of the given CSS size at.
     * @param {number} cssWidth   CSS pixel width of the canvas box.
     * @param {number} cssHeight  CSS pixel height of the canvas box.
     * @param {{maxDpr?: number, maxPixels?: number}} [opts] Per-game overrides.
     *        Pass maxPixels only when a game's fragment cost genuinely differs;
     *        do not lower maxDpr to "help performance" — that trades sharpness
     *        everywhere for a win only on the largest windows, which is exactly
     *        what the budget below already handles.
     * @returns {number} The ratio to multiply CSS size by for the backing store.
     */
    function resolve(cssWidth, cssHeight, opts) {
        var o = opts || {};
        var maxDpr = o.maxDpr || MAX_DPR;
        var maxPixels = o.maxPixels || MAX_PIXELS;
        var dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
        var w = Math.max(1, cssWidth || 1);
        var h = Math.max(1, cssHeight || 1);
        var over = (w * h * dpr * dpr) / maxPixels;
        if (over > 1) dpr /= Math.sqrt(over);
        return dpr;
    }

    /** Ceiling only — for three.js `renderer.setPixelRatio`, which owns its own sizing. */
    function ceiling(maxDpr) {
        return Math.min(window.devicePixelRatio || 1, maxDpr || MAX_DPR);
    }

    window.PoCanvasDpr = { resolve: resolve, ceiling: ceiling, MAX_DPR: MAX_DPR, MAX_PIXELS: MAX_PIXELS };
})();
