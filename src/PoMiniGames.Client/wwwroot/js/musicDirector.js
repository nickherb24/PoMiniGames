// musicDirector.js — one reactive soundtrack brain.
//
// ambientMusic.js already synthesises layered music with an intensity-driven
// layer mixer — but nothing ever STARTED it, and nothing moved its intensity.
// This module is the missing conductor:
//
//   menu   (0.35, 96 bpm)  — the catalog's default presence
//   lobby  (0.55, 102 bpm) — waiting rooms; slightly forward
//   match  (0.80, 112 bpm) — play; intensity rides match events
//   verdict(0.95→rest)     — win/lose pulse, then falls back to previous state
//
// States arrive from PoPalette (route change → menu/game) and PoPalette.pulse
// (win/lose). Games can call PoMusicDirector.match(true/false) directly for
// finer control. Audio starts lazily on the first user gesture — browsers lock
// the AudioContext before one, and the audio engine treats that as a hard
// contract.
//
// Exposed as window.PoMusicDirector.
(function () {
    'use strict';

    const STATES = {
        menu:    { intensity: 0.35, tempo: 96 },
        lobby:   { intensity: 0.55, tempo: 102 },
        match:   { intensity: 0.80, tempo: 112 },
    };

    let _state = 'menu';
    let _gestureBound = false;
    let _unlocked = false;   // a gesture has happened: the context may start from now on
    let _starting = false;

    // Games that play a score of their own. The shared soundtrack stands down on their
    // routes: two arrangements in two keys at once is noise. (PoEcosystem also stops and
    // restarts PoAmbientMusic itself; this keeps the director from starting it there.)
    const OWN_SCORE = ['pobrawl', 'pocabinet', 'poecosystem'];
    function ownScore() {
        return OWN_SCORE.indexOf((location.pathname.split('/')[1] || '').toLowerCase()) >= 0;
    }
    let _verdictUntil = 0;

    // Continuous tension, 0..1, riding on top of the current state's base
    // intensity. The three states are a coarse instrument: a match is
    // 'match' whether it is the first lap or the last corner, so on their own
    // they would say the same thing for the whole of every game. ambientMusic
    // has a live intensity mixer, and anything that drives it directly is
    // overwritten by the next apply(), hence this separate term.
    let _tension = 0;

    // How much of the remaining headroom tension can claim. Capped well under 1
    // so the verdict stinger is still audibly above a maxed-out tense moment —
    // if tension could reach the verdict level, winning would sound like playing.
    const TENSION_CEILING = 0.85;

    function ensureGesture() {
        if (_gestureBound) return;
        _gestureBound = true;
        const kick = function () {
            document.removeEventListener('pointerdown', kick);
            document.removeEventListener('keydown', kick);
            _unlocked = true;
            apply(true);
        };
        document.addEventListener('pointerdown', kick, { once: true });
        document.addEventListener('keydown', kick, { once: true });
    }

    function apply(forceStart) {
        const am = window.PoAmbientMusic;
        if (!am) return;
        if (ownScore()) {
            try { if (am.isPlaying()) am.stop(0.8); } catch { /* never load-bearing */ }
            return;
        }
        const cfg = STATES[_state] || STATES.menu;
        // A verdict window overrides the resting intensity briefly.
        const inVerdict = Date.now() < _verdictUntil;
        // Tension lifts the base toward the ceiling rather than replacing it, so a
        // tense menu still sounds like a menu and a calm match still sounds like a
        // match. A verdict overrides both — the result is the loudest thing that can
        // happen.
        const tense = cfg.intensity + ((TENSION_CEILING - cfg.intensity) * _tension);
        const intensity = inVerdict ? 0.95 : Math.max(cfg.intensity, tense);

        try {
            if (!am.isPlaying()) {
                // Wait for the gesture kick. After it, any apply() may (re)start the
                // score: leaving an own-score game for the catalog has to bring it back.
                if (!forceStart && !_unlocked) return;
                if (_starting) return;
                _starting = true;
                Promise.resolve(am.start('default', 0.12)).catch(function () { }).finally(function () { _starting = false; });
            }
            am.setIntensity ? am.setIntensity(intensity) : null;
            // Tempo follows tension as well as intensity: a mix that gets denser
            // without getting faster reads as "more music", not as "more pressure".
            const tempo = inVerdict ? cfg.tempo + 8 : Math.round(cfg.tempo + (_tension * 10));
            am.setTempo ? am.setTempo(tempo) : null;
        } catch { /* the soundtrack must never be the thing that breaks */ }

        // Shepard tone climax engine
        try {
            if (window.PoDsp && window.PoDsp.setShepard) {
                if (_tension > 0.45 && !inVerdict) {
                    const gain = (_tension - 0.45) * 0.42;
                    const rate = 0.04 + _tension * 0.08;
                    window.PoDsp.setShepard(true, rate, gain, 'music');
                } else {
                    window.PoDsp.setShepard(false, 0.06, 0, 'music');
                }
            }
        } catch { /* ignore */ }

        // Publish tension tokens on <html> for CSS heartbeat animations
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.style.setProperty('--fx-tension', _tension.toFixed(2));
            const pulseRate = (1.0 + _tension * 1.5).toFixed(2);
            document.documentElement.style.setProperty('--fx-pulse-rate', pulseRate);
        }
    }

    function setState(s) {
        if (!STATES[s]) return;
        // Tension belongs to the situation that produced it. Carrying it across a
        // state change would leave the catalog humming at last-lap intensity after
        // the player quit the race.
        if (s !== _state) {
            _tension = 0;
            if (window.PoDsp && window.PoDsp.setShepard) {
                window.PoDsp.setShepard(false, 0.06, 0, 'music');
            }
        }
        _state = s;
        apply(false);
    }

    /**
     * Set the continuous tension, 0..1 — how close this moment is to the edge.
     * Low health, the final lap, a countdown running out, a one-point deficit.
     *
     * Cheap to call often: a value that has not moved meaningfully is dropped
     * without touching the audio graph, so a game may push this every frame.
     * @param {number} v
     */
    function tension(v) {
        const next = Math.max(0, Math.min(1, Number(v) || 0));
        // 0.02 deadband: the layer mixer crossfades gain nodes, and nudging them
        // on every frame for an inaudible delta is pure cost.
        if (Math.abs(next - _tension) < 0.02) return;
        _tension = next;
        apply(false);
    }

    // Verdict stinger: brief intensity spike; the palette pulse already shifted
    // the visuals — this is its audio twin.
    function verdict(win) {
        _verdictUntil = Date.now() + (win ? 2200 : 1600);
        apply(true);
        setTimeout(function () { apply(false); }, _verdictUntil - Date.now() + 50);
    }

    // Route changes flow through PoPalette; piggyback its context signal.
    const paletteWatch = setInterval(function () {
        const ctx = window.PoPalette?.context?.();
        const want = ctx === 'game' ? 'match' : 'menu';
        // A lobby is a room inside a game route: LobbyPanel asks for 'lobby' when it
        // mounts and for 'match' when it goes. Without this the watch put every lobby
        // back to 'match' within its next tick, so the lobby state was never heard.
        if (_state === 'lobby' && ctx === 'game') return;
        if (want !== _state) setState(want);
    }, 1200);

    ensureGesture();

    window.PoMusicDirector = {
        setState: setState,
        match: function (on) { setState(on ? 'match' : 'menu'); },
        lobby: function () { setState('lobby'); },
        verdict: verdict,
        tension: tension,
        state: function () { return _state; },
        currentTension: function () { return _tension; }
    };
})();
