// routeFx.js — the route-transition wipe.
//
// Navigating between the catalog and a game is an instant DOM swap: one frame
// the gallery, the next frame a game. Nothing tells the player the app has moved,
// or connects the accent they are about to be surrounded by to the card they
// just pressed.
//
// This is a ~260 ms wipe tinted to the DESTINATION's palette, so the transition
// is also the introduction to where you are going. paletteBus already owns the
// per-game palettes (it re-points --fx-accent on every route change) — this
// reads the same table rather than keeping a second copy that could disagree.
//
// Why a DOM overlay and not a shader: postFx.js is three.js-only (it imports
// BokehPass and hands numbers to the games' own shaders), so it has nothing to
// say about a page transition. A single compositor-friendly element animating
// opacity and transform is also the only version of this that cannot drop a
// frame on the low tier — which matters, because this effect runs on the one
// frame the app is already busiest.
//
// Exposed as window.PoRouteFx.
(function () {
    'use strict';

    const DURATION_MS = 260;
    let _el = null;
    let _timer = 0;

    function motionReduced() {
        if (document.documentElement.dataset.motion === 'reduce') return true;
        try {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
            return false;
        }
    }

    function ensureLayer() {
        if (_el && _el.isConnected) return _el;
        _el = document.createElement('div');
        _el.className = 'po-route-wipe';
        // aria-hidden + inert: this sits above the whole page for a quarter of a
        // second, and a screen reader announcing it — or a tab stop landing in it —
        // would make a decoration into an obstacle.
        _el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(_el);
        return _el;
    }

    /**
     * Resolve a path to the accent pair paletteBus would use for it, so the wipe
     * and the page it reveals are the same colour.
     * @param {string} path
     * @returns {[string, string] | null}
     */
    function accentsFor(path) {
        const p = window.PoPalette;
        if (!p || !p.paletteFor) return null;
        const segment = (path || '/').split('/')[1];
        // A non-game route has no entry in the table; 'menu' is the catalog's own
        // pair and the correct colour to return TO the gallery with.
        return p.paletteFor(segment ? segment.toLowerCase() : 'menu') || p.paletteFor('menu');
    }

    /**
     * Play the wipe for a navigation to `path`.
     * Safe to call on every route change — a no-op under reduced motion, and a
     * second call during a wipe restarts it rather than stacking overlays.
     * @param {string} path destination pathname
     */
    function play(path) {
        if (motionReduced()) return;

        const accents = accentsFor(path);
        const el = ensureLayer();
        if (accents) {
            el.style.setProperty('--wipe-a', accents[0]);
            el.style.setProperty('--wipe-b', accents[1]);
        }

        // Restart rather than stack: removing the class and forcing a reflow is the
        // only reliable cross-browser way to replay a CSS animation, the same trick
        // impactBus.pop uses.
        el.classList.remove('is-wiping');
        void el.offsetWidth;
        el.classList.add('is-wiping');

        // Gravitational particle vortex transition for game launches
        const seg = (path || '').replace(/^\//, '').split('/')[0].toLowerCase();
        if (window.PoFx && window.PoFx.vortex && seg && seg !== 'leaderboards' && seg !== 'profile') {
            window.PoFx.vortex({ radius: Math.min(window.innerWidth, window.innerHeight) * 0.45 });
            window.PoCue?.fire('ui', 'vortexImplosion');
        }

        clearTimeout(_timer);
        _timer = setTimeout(function () {
            el.classList.remove('is-wiping');
        }, DURATION_MS + 60);
    }

    window.PoRouteFx = { play: play, durationMs: DURATION_MS };
})();
