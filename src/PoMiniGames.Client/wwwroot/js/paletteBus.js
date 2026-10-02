// paletteBus.js — the dynamic gradient/atmosphere contract.
//
// The app's accent colors were static CSS vars (--fx-accent / --fx-accent-2,
// read by ambientParticles' ray-marched field and gpuFx's particle tint). This
// module makes them a BUS: per-game palettes and menu/win/lose moods write the
// same two vars, so the WebGL background, the particle tints, and any CSS that
// consumes the tokens all breathe together — one writer, many readers.
//
// Win/lose `pulse()`s are transient (restored automatically) and are clamped by
// PoQuality.reduceFlashing to a single gentle step instead of a strobe.
//
// Exposed as window.PoPalette.
(function () {
    'use strict';

    // Per-game accent hues. Deliberately scheme-invariant (same policy as the
    // app.css accent hues) — these read as game identity, not as surface.
    const PALETTES = {
        menu:          ['#6366f1', '#22d3ee'],   // indigo/cyan — the catalog default
        pomarblerace:  ['#22d3ee', '#a78bfa'],   // cyan/violet — glass track
        pobrawl:       ['#f97316', '#ef4444'],   // ember
        tictactoe:     ['#34d399', '#60a5fa'],
        connectfive:   ['#f43f5e', '#38bdf8'],
        pojoker:       ['#f59e0b', '#d946ef'],
        poracer:       ['#f0abfc', '#38bdf8'],   // synthwave
        posports:      ['#4ade80', '#facc15'],
        povoxelstrike: ['#fb923c', '#38bdf8'],
        couplequiz:    ['#f472b6', '#c084fc'],
        funquiz:       ['#fbbf24', '#818cf8'],
    };

    const MOODS = {
        win:  ['#fde047', '#fb923c'],
        lose: ['#7f1d1d', '#4c1d95'],
    };

    const BIOMES = {
        dawn:      ['#fb923c', '#f472b6'], // golden sunrise
        aurora:    ['#34d399', '#a855f7'], // northern lights
        cyberpunk: ['#ec4899', '#06b6d4'], // neon rain
        ember:     ['#ea580c', '#ef4444'], // volcanic dojo
        midnight:  ['#3b82f6', '#8b5cf6'], // cosmic deep
    };

    let _activeBiome = null;

    function circadianBiome() {
        const h = new Date().getHours();
        if (h >= 5 && h < 9) return 'dawn';
        if (h >= 18 && h < 21) return 'aurora';
        if (h >= 21 || h < 5) return 'cyberpunk';
        return null;
    }

    let _context = 'menu';
    let _game = null;
    let _pulseTimer = null;

    function writeVars(a, b) {
        const root = document.documentElement.style;
        root.setProperty('--fx-accent', a);
        root.setProperty('--fx-accent-2', b);
        // Readers pick the change up on their next cadence; nudge the two we
        // know about so the shift is immediate.
        if (window.PoAmbient?.refreshTint) window.PoAmbient.refreshTint();
        // gpuFx.js exposes itself as window.PoFx — this read was `window.PoGpuFx`
        // for the module's whole life, which is a name nothing ever defined, so
        // the particle tint silently kept the accent it booted with and never
        // followed a route change. Kept optional: gpuFx is a module script and
        // may not have evaluated yet on the first palette write.
        if (window.PoFx?.invalidateTint) window.PoFx.invalidateTint();
    }

    function gameFromPath() {
        const m = /^\/po?([a-z]+)/i.exec(location.pathname);
        if (!m) return null;
        const key = location.pathname.split('/')[1].toLowerCase();
        return PALETTES[key] ? key : null;
    }

    function apply() {
        if (!_game) {
            const bio = _activeBiome || circadianBiome();
            if (bio && BIOMES[bio]) {
                writeVars(BIOMES[bio][0], BIOMES[bio][1]);
                return;
            }
        }
        const palette = PALETTES[_game || 'menu'] || PALETTES.menu;
        writeVars(palette[0], palette[1]);
    }

    // pulse(mood): transient mood tint. reduceFlashing collapses the pulse to
    // the step (no animated sweep) and lengthens nothing — one crossfade.
    function pulse(mood) {
        const m = MOODS[mood];
        if (!m) return;
        const flashGuard = window.PoQuality?.reduceFlashing?.() === true;
        writeVars(m[0], m[1]);
        clearTimeout(_pulseTimer);
        _pulseTimer = setTimeout(function () { apply(); }, flashGuard ? 2500 : 1600);
        if (window.PoMusicDirector?.verdict) window.PoMusicDirector.verdict(mood === 'win');
    }

    function setGame(gameKey) {
        _game = PALETTES[gameKey] ? gameKey : null;
        _context = _game ? 'game' : 'menu';
        apply();
    }

    // Auto-context: the catalog is '/'; every game route is '/<game>/...'.
    function autoUpdate() { setGame(gameFromPath()); }
    window.addEventListener('popstate', autoUpdate);
    autoUpdate();

    window.PoPalette = {
        setGame: setGame,
        pulse: pulse,
        paletteFor: function (k) { return PALETTES[k] || null; },
        context: function () { return _context; },
        setBiome: function (b) { _activeBiome = BIOMES[b] ? b : null; apply(); },
        activeBiome: function () { return _activeBiome || circadianBiome(); },
        BIOMES: BIOMES
    };
})();

