// impactBus.js — the platform's shared "game feel" layer (§GFX-8).
//
// WHY THIS EXISTS
// Every game had its own idea of what a hit felt like, or no idea at all.
// PoBrawl shook its own canvas from inside its render loop; MarbleRace punched
// the FOV; ConnectFive did nothing. Nothing was shared, so nothing was
// consistent, and the DOM-only games (TicTacToe, the quizzes, PoJoker) had no
// route to any of it because they have no render loop to hook.
//
// One bus now owns the four channels that make an interaction feel physical:
//
//   TRAUMA   → screenshake. Trauma is a 0..1 reservoir that decays; the actual
//              offset is trauma² × noise. Squaring is the whole trick — it
//              makes a small hit read as a tap and a big one as an earthquake,
//              instead of everything reading as the same rattle.
//   PUNCH    → a 0..1 envelope for chromatic aberration / radial blur. Consumed
//              by the WebGL post stacks (PoBrawl, MarbleRace, PoRacer), which
//              read getPunch() each frame rather than tracking their own.
//   FLASH    → a full-screen tint spike, for KOs and eliminations.
//   HITSTOP  → a global time scale < 1 for a few dozen ms. Games multiply their
//              dt by getTimeScale(). Freezing the frame at the moment of impact
//              is the single cheapest way to make a hit land.
//
// HOW THE DOM SIDE APPLIES
// Shake writes to the CSS `translate` and `rotate` *properties*, not `transform`.
// That matters: they compose with whatever `transform` the component already has
// (a game board mid-flip, a card mid-pop) instead of clobbering it, so shaking a
// stage can never fight a component's own animation. Both are compositor-only.
//
// The loop only runs while something is actually decaying. An idle page costs
// zero — no rAF is scheduled at all.

const HAPTICS_KEY = 'pomini_haptics';

// Per-kind presets. Tuned so `light` is felt-but-not-noticed and `heavy` is
// unmistakable without being nauseating; anything above 0.7 trauma starts to
// read as a bug rather than a hit.
const PRESETS = {
    tick:   { trauma: 0.00, punch: 0.05, flash: 0.00, stopMs: 0,  haptic: [8] },
    select: { trauma: 0.05, punch: 0.10, flash: 0.00, stopMs: 0,  haptic: [10] },
    light:  { trauma: 0.16, punch: 0.18, flash: 0.04, stopMs: 25, haptic: [12] },
    medium: { trauma: 0.34, punch: 0.38, flash: 0.10, stopMs: 55, haptic: [18, 30, 12] },
    heavy:  { trauma: 0.62, punch: 0.72, flash: 0.22, stopMs: 90, haptic: [28, 40, 22] },
    win:    { trauma: 0.30, punch: 0.45, flash: 0.28, stopMs: 60, haptic: [20, 60, 20, 60, 40] },
    lose:   { trauma: 0.45, punch: 0.30, flash: 0.16, stopMs: 80, haptic: [90] },
};

// Decay rates, per second. Trauma outlives punch on purpose: the colour spike
// should be gone before the camera has finished settling, which is how a real
// impact reads (the flash is instantaneous, the shake rings out).
const TRAUMA_DECAY = 1.9;
const PUNCH_DECAY = 4.5;
const FLASH_DECAY = 6.0;

// Shake geometry at trauma = 1. Rotation is small relative to translation —
// a stage that spins reads as broken, one that jitters reads as struck.
const MAX_OFFSET_PX = 18;
const MAX_ROTATE_DEG = 1.1;

// Independent noise frequencies per axis so the motion never looks like a
// circle or a diagonal line. Prime-ish ratios keep the pattern from repeating
// inside the ~600 ms a shake actually lasts.
const FREQ_X = 13.7;
const FREQ_Y = 17.3;
const FREQ_R = 11.1;

let _trauma = 0;
let _punch = 0;
let _flash = 0;
let _timeScale = 1;
let _stopUntil = 0;

let _rafId = 0;
let _last = 0;
let _running = false;

let _flashEl = null;
let _shockwaveCanvas = null;
const _shockwaves = [];
/** @type {Set<HTMLElement>} */
const _stages = new Set();

const _root = typeof document !== 'undefined' ? document.documentElement : null;

/**
 * Motion sensitivity. Read live rather than cached: the Profile toggle and the
 * OS setting can both change mid-session, and a stale read would keep shaking
 * the screen for someone who just asked it to stop.
 */
function motionReduced() {
    try {
        if (document.querySelector('.racer-root[data-reduced-effects="true"]')) return true;
        if (_root && _root.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/**
 * Global amplitude scale. Weak hardware gets less shake for the same reason it
 * gets less blur — the effect is the first thing to cost a frame, and a hitch
 * during a hit is worse than a smaller hit.
 */
function tierScale() {
    if (!_root) return 1;
    switch (_root.getAttribute('data-gfx')) {
        case 'low': return 0.35;
        case 'medium': return 0.7;
        default: return 1;
    }
}

/**
 * Deterministic smooth noise in -1..1. Two incommensurable sines beat a
 * Math.random() jitter here: random reads as static/tearing, this reads as
 * a body oscillating and settling.
 */
function noise(t, freq) {
    return Math.sin(t * freq) * 0.62 + Math.sin(t * freq * 2.37 + 1.7) * 0.38;
}

function ensureShockwaveLayer() {
    if (_shockwaveCanvas || typeof document === 'undefined' || !document.body) return _shockwaveCanvas;
    const c = document.createElement('canvas');
    c.className = 'po-impact-shockwave';
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9988;opacity:0;';
    c.setAttribute('aria-hidden', 'true');
    c.width = window.innerWidth || 800;
    c.height = window.innerHeight || 600;
    document.body.appendChild(c);
    _shockwaveCanvas = c;
    return c;
}

/**
 * Screen-space radial shockwave refraction ring.
 * @param {number} [x] Center X in px
 * @param {number} [y] Center Y in px
 * @param {number} [strength=1.0] Amplitude scale
 */
export function shockwave(x, y, strength = 1.0) {
    if (motionReduced() || tierScale() < 0.5) return;
    const cx = x != null ? x : (typeof window !== 'undefined' ? window.innerWidth / 2 : 300);
    const cy = y != null ? y : (typeof window !== 'undefined' ? window.innerHeight / 2 : 300);
    const maxR = Math.min(window.innerWidth, window.innerHeight) * (0.35 + strength * 0.25);
    _shockwaves.push({
        x: cx,
        y: cy,
        maxR: maxR,
        start: performance.now(),
        dur: 460,
        strength: Math.min(2.0, strength)
    });
    ensureRunning();
}

/**
 * Damped harmonic spring physics animation on DOM elements.
 * @param {HTMLElement} el
 * @param {number} [targetScale=1.35] Peak overshoot scale
 * @param {number} [stiffness=240]
 * @param {number} [damping=16]
 */
export function spring(el, targetScale = 1.35, stiffness = 240, damping = 16) {
    if (!el || motionReduced()) return;
    let pos = 1.0;
    let vel = (targetScale - 1.0) * 14.0;
    const target = 1.0;
    let lastT = performance.now();
    function springStep(now) {
        const dt = Math.min(0.032, (now - lastT) * 0.001);
        lastT = now;
        const f = -stiffness * (pos - target) - damping * vel;
        vel += f * dt;
        pos += vel * dt;
        el.style.scale = pos.toFixed(3);
        if (Math.abs(pos - target) > 0.002 || Math.abs(vel) > 0.02) {
            requestAnimationFrame(springStep);
        } else {
            el.style.scale = '';
        }
    }
    requestAnimationFrame(springStep);
}

function ensureFlashLayer() {
    if (_flashEl || typeof document === 'undefined' || !document.body) return _flashEl;
    const el = document.createElement('div');
    el.className = 'po-impact-flash';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    _flashEl = el;
    return el;
}

function step(now) {
    if (!_running) return;
    // First frame after an idle period has no meaningful delta; clamp so a
    // backgrounded tab returning does not instantly decay everything to zero.
    const dt = _last ? Math.min((now - _last) / 1000, 0.05) : 0.016;
    _last = now;

    _trauma = Math.max(0, _trauma - TRAUMA_DECAY * dt);
    _punch = Math.max(0, _punch - PUNCH_DECAY * dt);
    _flash = Math.max(0, _flash - FLASH_DECAY * dt);
    _timeScale = now < _stopUntil ? 0.12 : 1;

    const shake = _trauma * _trauma * tierScale();
    const t = now / 1000;

    if (_stages.size) {
        const x = (noise(t, FREQ_X) * shake * MAX_OFFSET_PX).toFixed(2);
        const y = (noise(t, FREQ_Y) * shake * MAX_OFFSET_PX).toFixed(2);
        const r = (noise(t, FREQ_R) * shake * MAX_ROTATE_DEG).toFixed(3);
        for (const el of _stages) {
            // `translate`/`rotate` rather than `transform` — see header note.
            el.style.translate = `${x}px ${y}px`;
            el.style.rotate = `${r}deg`;
        }
    }

    if (_flashEl) _flashEl.style.opacity = _flash.toFixed(3);

    // Radial shockwaves rendering
    if (_shockwaves.length > 0) {
        const c = ensureShockwaveLayer();
        if (c) {
            c.style.opacity = '1';
            const ctx = c.getContext('2d');
            if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
                c.width = window.innerWidth;
                c.height = window.innerHeight;
            }
            ctx.clearRect(0, 0, c.width, c.height);

            for (let i = _shockwaves.length - 1; i >= 0; i--) {
                const sw = _shockwaves[i];
                const p = (now - sw.start) / sw.dur;
                if (p >= 1.0) {
                    _shockwaves.splice(i, 1);
                    continue;
                }
                const rad = sw.maxR * Math.sqrt(p);
                const alpha = (1.0 - p) * sw.strength * 0.7;

                // Outer cyan refraction wave
                ctx.strokeStyle = `rgba(34, 211, 238, ${(alpha * 0.75).toFixed(3)})`;
                ctx.lineWidth = 4.5 * (1.0 - p);
                ctx.beginPath();
                ctx.arc(sw.x, sw.y, rad, 0, Math.PI * 2);
                ctx.stroke();

                // Inner magenta chromatic split wave
                ctx.strokeStyle = `rgba(244, 63, 94, ${(alpha * 0.55).toFixed(3)})`;
                ctx.lineWidth = 3.0 * (1.0 - p);
                ctx.beginPath();
                ctx.arc(sw.x, sw.y, Math.max(0, rad - 3.5), 0, Math.PI * 2);
                ctx.stroke();
            }

            if (_shockwaves.length === 0) {
                ctx.clearRect(0, 0, c.width, c.height);
                c.style.opacity = '0';
            }
        }
    }

    if (_root) {
        _root.style.setProperty('--po-punch', _punch.toFixed(3));
        _root.style.setProperty('--po-shake', shake.toFixed(3));
    }

    if (_trauma > 0.001 || _punch > 0.001 || _flash > 0.001 || _timeScale !== 1 || _shockwaves.length > 0) {
        _rafId = requestAnimationFrame(step);
    } else {
        // Settle exactly on zero. Leaving a 0.0004px translate behind pins a
        // compositor layer on every registered stage for the rest of the session.
        for (const el of _stages) { el.style.translate = ''; el.style.rotate = ''; }
        if (_flashEl) _flashEl.style.opacity = '0';
        if (_shockwaveCanvas) _shockwaveCanvas.style.opacity = '0';
        if (_root) {
            _root.style.setProperty('--po-punch', '0');
            _root.style.setProperty('--po-shake', '0');
        }
        _running = false;
        _rafId = 0;
    }
}

function ensureRunning() {
    if (_running || typeof requestAnimationFrame !== 'function') return;
    _running = true;
    _last = 0;
    _rafId = requestAnimationFrame(step);
}

/**
 * Register an element as a shake target. Usually the game's stage/canvas
 * wrapper rather than <body>, so fixed chrome (top bar, modals) stays still —
 * shaking the UI along with the playfield reads as a broken page.
 * @param {HTMLElement} el
 * @returns {() => void} unregister
 */
export function registerStage(el) {
    if (!el) return () => {};
    _stages.add(el);
    return () => unregisterStage(el);
}

export function unregisterStage(el) {
    if (!el) return;
    _stages.delete(el);
    el.style.translate = '';
    el.style.rotate = '';
}

/**
 * Fire an impact.
 * @param {'tick'|'select'|'light'|'medium'|'heavy'|'win'|'lose'} kind
 * @param {number} [scale=1] multiplier, for hits that vary continuously
 *   (damage dealt, collision speed). Clamped so a runaway value can't lock the
 *   screen into a permanent earthquake.
 */
export function impact(kind, scale) {
    const p = PRESETS[kind] || PRESETS.light;
    const s = Math.max(0, Math.min(2.5, scale == null ? 1 : scale));
    const reduced = motionReduced();

    // Trauma accumulates rather than overwrites, so a flurry of hits builds —
    // but it saturates at 1, so it can never run away.
    if (!reduced) _trauma = Math.min(1, _trauma + p.trauma * s);
    _punch = Math.min(1, _punch + p.punch * s * (reduced ? 0.35 : 1));
    _flash = Math.min(1, _flash + p.flash * s * (reduced ? 0.4 : 1));

    if (p.stopMs > 0 && !reduced) {
        const until = (typeof performance !== 'undefined' ? performance.now() : 0) + p.stopMs * Math.min(s, 1.5);
        if (until > _stopUntil) _stopUntil = until;
    }

    if ((kind === 'heavy' || kind === 'win' || kind === 'lose') && !reduced) {
        shockwave(typeof window !== 'undefined' ? window.innerWidth / 2 : 300, typeof window !== 'undefined' ? window.innerHeight / 2 : 300, s);
    }

    if (p.haptic) vibrate(p.haptic);
    ensureRunning();
}

/** Add trauma directly, for engines that already compute their own hit weight. */
export function addTrauma(amount) {
    if (motionReduced()) return;
    _trauma = Math.min(1, _trauma + Math.max(0, amount));
    ensureRunning();
}

/**
 * Freeze time for a moment. Callers must actually consult getTimeScale() in
 * their integration step — this sets the value, it cannot pause anyone's loop.
 */
export function hitstop(ms) {
    if (motionReduced()) return;
    const until = (typeof performance !== 'undefined' ? performance.now() : 0) + Math.max(0, ms);
    if (until > _stopUntil) _stopUntil = until;
    ensureRunning();
}

/** 0..1 aberration/blur envelope for the WebGL post stacks. */
export function getPunch() { return _punch; }

/** 0..1 shake magnitude, for engines that shake their own camera in 3D. */
export function getShake() { return _trauma * _trauma * tierScale(); }

/** Multiply your per-frame dt by this. 1 normally, ~0.12 during hitstop. */
export function getTimeScale() { return _timeScale; }

/**
 * Haptics. Gated on the Profile opt-out (mute is the wrong lever — "sound yes,
 * buzzing no" is the common case on a phone held in the hand) and on the same
 * reduced-motion preference that suppresses shake.
 * @param {number[]} pattern
 */
export function vibrate(pattern) {
    try {
        if (localStorage.getItem(HAPTICS_KEY) === '0') return;
        if (motionReduced()) return;
        // Bug fix (2026-08-07): kiosk/demo runs without a user gesture, so
        // every browser vibrate call below would emit a console error. Skip
        // the call entirely on any /{game}/demo or ?kiosk=N route — the
        // attract reel has no one to vibrate.
        if (isOnKioskRoute()) return;
        // The kiosk guard above covers the attract reel but not every
        // gesture-less caller. /login fires a cue while the sign-in gate is
        // still mounting, and this — not uiAudio.js — was the call site still
        // logging "Blocked call to navigator.vibrate because user hasn't tapped
        // on the frame" on the app's entry page after the uiAudio fix.
        // Same sticky-activation test, applied here too. 2026-09-11 UI audit.
        if (!hasUserGestured()) return;
        if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch { /* unsupported or storage blocked */ }
}

/**
 * True once the user has interacted with the document in a way that satisfies
 * the browser's sticky-activation requirement for navigator.vibrate. Mirrors
 * the helper in uiAudio.js — the two modules are loaded independently (one is
 * imported by UiFeedbackService, this one by index.html), so each carries its
 * own copy rather than either taking a dependency on the other for six lines.
 */
let _gestured = false;
function hasUserGestured() {
    if (_gestured) return true;
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
        _gestured = true;
    }
    return _gestured;
}
if (typeof document !== 'undefined') {
    for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
        document.addEventListener(evt, () => { _gestured = true; },
            { once: true, capture: true, passive: true });
    }
}

// Cheap URL probe — kiosk coordinator decides whether the reel is running
// but every demo also shares the same "no human in front of the screen" surface.
function isOnKioskRoute() {
    try {
        if ((location.search || '').indexOf('kiosk=') >= 0) return true;
        return /\/demo(\b|\/|$)/i.test(location.pathname || '');
    } catch {
        return false;
    }
}

/**
 * One-shot pop on an element — the HUD-number bump. Re-adding a class that is
 * already present does not restart a CSS animation, so the class is removed and
 * a reflow forced between; that is the only reliable cross-browser restart.
 * @param {HTMLElement} el
 */
export function pop(el) {
    if (!el || motionReduced()) return;
    el.classList.remove('fx-pop');
    void el.offsetWidth;
    el.classList.add('fx-pop');
}

/**
 * Pop an element addressed by CSS selector. Blazor JS interop cannot hand an
 * ElementReference to a non-module global without a per-call dynamic import, so
 * C# callers (ScreenFxService) address the target the only way they cheaply can.
 * A selector that matches nothing is a no-op, same as a null element.
 * @param {string} selector
 */
export function popSelector(selector) {
    if (typeof selector !== 'string' || !selector) return;
    try {
        pop(document.querySelector(selector));
    } catch {
        // An invalid selector is a caller bug, not a reason to throw into a
        // feedback path.
    }
}

/**
 * Roll the plain-number stats under `root` up from zero, a tick per step with the pitch
 * climbing an octave — the end-of-game modal's score count. Only a cell whose whole text is
 * an integer is touched: a lap time, a "3/5" or a name stays exactly as rendered. Under
 * reduced motion nothing rolls and the numbers are simply there.
 * @param {HTMLElement} root
 */
export function countUp(root) {
    if (!root || !root.querySelectorAll || motionReduced()) return;
    let order = 0;
    for (const el of root.querySelectorAll('.gps-stat-value')) {
        const node = el.firstChild;
        const final = (el.textContent || '').trim();
        const m = /^(\d{1,3}(?:,\d{3})+|\d+)$/.exec(final);
        if (!m || !node || node.nodeType !== 3 || el.childNodes.length !== 1) continue;
        const target = parseInt(final.replace(/,/g, ''), 10);
        if (!(target >= 2)) continue;
        const grouped = final.includes(',');
        const steps = Math.min(target, 14);
        const t0 = performance.now() + (order++) * 160;
        const dur = 340 + steps * 42;
        let shown = 0;
        // Written into Blazor's own text node. Replacing the node (textContent) would orphan
        // the one its diff still holds, and a later re-render would update a detached node.
        node.nodeValue = '0';
        const frame = (now) => {
            if (!el.isConnected) return;
            const p = Math.max(0, Math.min(1, (now - t0) / dur));
            const step = Math.floor((1 - Math.pow(1 - p, 3)) * steps);
            if (step !== shown) {
                shown = step;
                const val = Math.round(target * step / steps);
                node.nodeValue = step >= steps ? final : (grouped ? val.toLocaleString('en-US') : String(val));
                // `focus` is the one ui voice with no detune and no screen feel, so the
                // run reads as a single rising scale rather than fourteen separate taps.
                try { window.PoCue?.fire('ui', 'focus', { pitch: 0.5 + 0.5 * (step / steps), gain: 1.6 }); } catch { /* never fatal */ }
            }
            if (p < 1) requestAnimationFrame(frame);
            else { node.nodeValue = final; pop(el); }
        };
        requestAnimationFrame(frame);
    }
}

/** Cancel everything immediately — used on game teardown and route change. */
export function reset() {
    _shockwaves.length = 0;
    if (_shockwaveCanvas) _shockwaveCanvas.style.opacity = '0';
    _trauma = _punch = _flash = 0;
    _stopUntil = 0;
    _timeScale = 1;
    for (const el of _stages) { el.style.translate = ''; el.style.rotate = ''; }
    if (_flashEl) _flashEl.style.opacity = '0';
    if (_root) {
        _root.style.setProperty('--po-punch', '0');
        _root.style.setProperty('--po-shake', '0');
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureFlashLayer, { once: true });
    } else {
        ensureFlashLayer();
    }
    // A shake that survives a route change looks like a rendering bug. Blazor
    // does not fire a DOM event for navigation, so the stage set emptying on
    // dispose is the real guard; this covers full reloads and bfcache returns.
    window.addEventListener('pagehide', reset);
}

if (typeof window !== 'undefined') {
    // Non-module access for the game engines that are plain scripts
    // (racingInterop.js, pojoker-*) and for Blazor JS interop,
    // which cannot import an ES module without a dynamic import per call.
    window.PoImpact = {
        impact, shockwave, spring, addTrauma, hitstop, getPunch, getShake, getTimeScale,
        registerStage, unregisterStage, vibrate, pop, popSelector, reset, countUp,
    };

    // Consolidated PoImpactFx layer (§GFX-14)
    (function () {
        const MIN_GAP_MS = 90;
        let _lastHit = 0;
        let _armed = null;

        function gate(scale) {
            const q = window.PoQuality;
            if (!q) return true;
            if (q.tier() === 'low') return false;
            if (q.reduceFlashing()) return false;
            if (q.tier() === 'medium' && scale < 0.6) return false;
            return true;
        }

        function hit(kind, scale) {
            const s = Math.max(0, Math.min(1.5, scale || 1));
            const now = performance.now();
            if (now - _lastHit < MIN_GAP_MS) return;
            _lastHit = now;

            if (window.PoImpact?.impact) window.PoImpact.impact(kind || 'hit', s);
            if (window.PoPalette?.pulse && kind === 'win') window.PoPalette.pulse('win');

            if (!gate(s)) return;

            _armed = {
                until: now + (kind === 'win' ? 900 : 450),
                aberration: (kind === 'win' ? 0.5 : 1.1) * s,
                radial: (kind === 'win' ? 0.35 : 0.8) * s
            };
        }

        function frame(nowSec) {
            if (!_armed) return false;
            const fx = window.PoThreeFx;
            const now = performance.now();
            if (now > _armed.until || !fx) { _armed = null; return false; }
            const t = (_armed.until - now) / (_armed.until - (now - 450));
            if (fx.punchAberration) fx.punchAberration(_armed.aberration * Math.max(0.15, t));
            if (fx.punchRadial) fx.punchRadial(_armed.radial * Math.max(0.15, t));
            return true;
        }

        window.PoImpactFx = {
            hit: hit,
            win: function (scale) { hit('win', scale == null ? 1 : scale); },
            lose: function (scale) { hit('hit', scale == null ? 0.8 : scale); },
            frame: frame,
            armed: function () { return _armed !== null; }
        };
    })();
}
