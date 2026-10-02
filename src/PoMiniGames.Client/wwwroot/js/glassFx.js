// glassFx.js — scene-composited glass for HUD panels.
//
// CSS backdrop-filter blurs whatever is *behind the element in DOM order*,
// which over a canvas reads as a flat smear. This module composites the actual
// game canvas: a small offscreen thumbnail of the live frame is blurred and
// handed to the panel as `--glass-capture`, so the panel's blur and tint land
// ON the scene content behind it — real glassmorphism, at thumbnail cost.
//
// Cost model: one 128px-wide drawImage + blur per interval per panel, gated by
// PoQuality (low tier and reduced-motion keep the plain backdrop-filter).
//
// Exposed as window.PoGlass.
(function () {
    'use strict';

    const CAPTURE_W = 128;
    let _timers = new Map();   // panel -> intervalId
    let _ripples = [];

    function allowed() {
        const q = window.PoQuality;
        if (!q) return false;
        if (q.tier() === 'low') return false;
        if (q.reduceFlashing()) return false; // motion-heavy live captures out
        return true;
    }

    function captureOnce(sourceCanvas, panel) {
        try {
            if (!sourceCanvas.width || !sourceCanvas.height) return;
            const w = CAPTURE_W;
            const h = Math.max(24, Math.round(CAPTURE_W * sourceCanvas.height / sourceCanvas.width));
            const off = glassFx._off || (glassFx._off = document.createElement('canvas'));
            off.width = w; off.height = h;
            const g = off.getContext('2d');
            g.filter = 'blur(5px) saturate(1.28) brightness(1.10)';
            g.drawImage(sourceCanvas, 0, 0, w, h);
            g.filter = 'none';

            // High-tier Chromatic Dispersion & Caustic Refraction Sheen
            const q = window.PoQuality;
            if (q && q.tier() !== 'low') {
                const t = performance.now() * 0.0012;
                g.save();
                g.globalCompositeOperation = 'screen';

                // Prismatic chromatic dispersion on edges
                g.filter = 'blur(3px)';
                g.drawImage(sourceCanvas, -1.8, 0, w, h);
                g.drawImage(sourceCanvas, 1.8, 0, w, h);
                g.filter = 'none';

                const grad = g.createLinearGradient(0, 0, w, h);
                const wave1 = 0.5 + 0.5 * Math.sin(t * 1.6);
                const wave2 = 0.5 + 0.5 * Math.cos(t * 1.3);
                grad.addColorStop(0, 'rgba(120, 190, 255, 0.16)');
                grad.addColorStop(Math.min(0.85, Math.max(0.15, 0.35 + 0.25 * wave1)), 'rgba(255, 255, 255, 0.22)');
                grad.addColorStop(Math.min(0.95, Math.max(0.25, 0.70 + 0.18 * wave2)), 'rgba(100, 240, 210, 0.14)');
                grad.addColorStop(1, 'rgba(170, 130, 255, 0.10)');
                g.fillStyle = grad;
                g.fillRect(0, 0, w, h);

                // Concentric liquid ripple waves on glass tap
                for (let ri = _ripples.length - 1; ri >= 0; ri--) {
                    const rip = _ripples[ri];
                    if (rip.panel !== panel) continue;
                    const age = (performance.now() - rip.created) * 0.001;
                    if (age > 0.75) { _ripples.splice(ri, 1); continue; }
                    const r = rip.maxR * (age / 0.75);
                    const alpha = (1.0 - (age / 0.75)) * 0.38;
                    g.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
                    g.lineWidth = 2.5;
                    g.beginPath();
                    g.arc(rip.x, rip.y, r, 0, Math.PI * 2);
                    g.stroke();
                }

                g.restore();
            }

            const url = 'url("' + off.toDataURL('image/webp', 0.6) + '")';
            show(panel, url);
            return url;
        } catch { return null; /* tainted canvas or gone — the CSS fallback still applies */ }
    }

    function show(panel, url) {
        panel.style.setProperty('--glass-capture', url);
        if (!panel.hasAttribute('data-glass-live')) {
            panel.setAttribute('data-glass-live', '');
            // Subtle crystalline resonance stinger on first live attachment
            if (window.PoUiAudio && window.PoUiAudio.glassResonate) {
                window.PoUiAudio.glassResonate();
            }
        }
    }

    function rippling(panel) {
        for (const r of _ripples) if (r.panel === panel) return true;
        return false;
    }

    function attachPanel(panel, opts) {
        const o = opts || {};
        const source = o.source || document.querySelector('canvas');
        if (!panel || !source) return function () { };
        if (!allowed() || _timers.has(panel)) return function () { };

        captureOnce(source, panel);
        const id = setInterval(function () {
            if (!panel.isConnected) { clearInterval(id); _timers.delete(panel); return; }
            if (!allowed()) { panel.removeAttribute('data-glass-live'); return; }
            captureOnce(source, panel);
        }, o.intervalMs || 220);
        _timers.set(panel, id);
        return function () { clearInterval(id); _timers.delete(panel); panel.removeAttribute('data-glass-live'); };
    }

    // Attach every element matching `selector` to a source canvas
    function attachHud(sourceCanvas, selector) {
        const sel = selector || '[data-glass]';
        const tracked = new Set();

        function sweep() {
            if (!allowed()) return;
            // One capture per sweep, shared by every panel: the blur and the WebP encode are
            // the whole cost, and they used to be paid once per panel. A panel with a tap
            // ripple in flight still gets its own, since the ripple is drawn into the capture.
            let shared = null;
            document.querySelectorAll(sel).forEach(function (p) {
                if (!p.isConnected) { tracked.delete(p); return; }
                tracked.add(p);
                if (shared && !rippling(p)) show(p, shared);
                else shared = captureOnce(sourceCanvas, p) || shared;
            });
        }

        // Captured inside an animation frame, not straight from the timer. A WebGL canvas
        // without preserveDrawingBuffer (every three.js game here but PoCabinet) is only
        // readable in the frame it was drawn in; from a timer drawImage copied an empty
        // buffer. A frame requested here runs after the game's own, which was requested
        // during its previous frame, so the buffer is still this frame's picture.
        const sweepSoon = function () { requestAnimationFrame(sweep); };
        sweepSoon();
        const id = setInterval(function () {
            if (sourceCanvas && !sourceCanvas.isConnected) { clearInterval(id); return; }
            sweepSoon();
        }, o_intervalMs);
        return function () {
            clearInterval(id);
            tracked.forEach(function (p) { p.removeAttribute('data-glass-live'); });
            tracked.clear();
        };
    }

    // Auto-attach. attachHud above needs the game to remember to call it with its
    // own canvas; a HUD whose game forgets falls back to the plain backdrop-filter,
    // which over a canvas blurs whatever is behind the element in DOM order and
    // reads as a flat smear rather than as glass.
    //
    // So a panel opts in by carrying data-glass, and the source canvas is
    // discovered. A new game gets scene-composited glass by
    // adding an attribute, with nothing to wire and nothing to tear down.
    let _autoStop = null;
    let _autoObserver = null;

    function currentCanvas() {
        // Largest canvas on the page, not the first: games mount minimaps, sprite
        // atlases and offscreen scratch canvases alongside the scene, and the first
        // in DOM order is regularly one of those. Area is a reliable proxy for
        // "the one the player is looking at".
        let best = null;
        let bestArea = 0;
        document.querySelectorAll('canvas').forEach(function (c) {
            const area = (c.width || 0) * (c.height || 0);
            if (area > bestArea) { bestArea = area; best = c; }
        });
        return best;
    }

    function syncAuto() {
        const hasPanels = document.querySelector('[data-glass]') !== null;
        const canvas = hasPanels ? currentCanvas() : null;

        // Nothing to do, or the scene is gone (route change): release.
        if (!canvas || !allowed()) {
            if (_autoStop) { _autoStop(); _autoStop = null; }
            return;
        }
        if (_autoStop) return;   // already running against a live canvas
        _autoStop = attachHud(canvas, '[data-glass]');
    }

    /**
     * Start watching the document for glass panels and a scene canvas. Idempotent —
     * safe to call on every route change, and called once from fxBootstrap.
     */
    function auto() {
        if (_autoObserver) { syncAuto(); return; }
        syncAuto();
        // Blazor swaps the page's DOM without a navigation event the module can
        // hear, so the observer is what notices a new game's canvas and HUD
        // mounting (and the old one leaving).
        //
        // Throttled, and that is not optional: a running game rewrites its HUD text
        // every frame, so an unthrottled subtree observer would run syncAuto —
        // two document-wide queries, one of them over every canvas — at frame rate,
        // on the main thread, to discover nothing had changed. The work this module
        // exists to do costs one 128px drawImage every 220 ms; paying more than
        // that to decide whether to do it would make the effect a net loss.
        let pending = 0;
        _autoObserver = new MutationObserver(function () {
            if (pending) return;
            pending = setTimeout(function () { pending = 0; syncAuto(); }, 400);
        });
        _autoObserver.observe(document.body, { childList: true, subtree: true });
    }

    const o_intervalMs = 220;

    if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', function (e) {
            if (!allowed()) return;
            const panel = e.target && e.target.closest ? e.target.closest('[data-glass]') : null;
            if (!panel) return;
            const r = panel.getBoundingClientRect();
            if (!r.width || !r.height) return;
            const px = (e.clientX - r.left) / r.width * CAPTURE_W;
            const py = (e.clientY - r.top) / r.height * Math.max(24, Math.round(CAPTURE_W * r.height / r.width));
            _ripples.push({ panel, x: px, y: py, maxR: CAPTURE_W * 0.7, created: performance.now() });
            if (window.PoCues && window.PoCues.play) {
                window.PoCues.play('ui.fluidRipple');
            }
        }, { passive: true });
    }

    const glassFx = {
        attachPanel: attachPanel,
        attachHud: attachHud,
        auto: auto,
        stopAll: function () {
            _timers.forEach(function (id) { clearInterval(id); });
            _timers.clear();
            if (_autoStop) { _autoStop(); _autoStop = null; }
        }
    };

    window.PoGlass = glassFx;
})();
