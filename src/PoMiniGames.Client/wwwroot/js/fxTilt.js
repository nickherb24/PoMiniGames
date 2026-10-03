// fxTilt.js — pointer-tracked 3D tilt for glass surfaces.
//
// Opt in from markup with `data-fx-tilt` (optionally `data-fx-tilt="10"` for a
// maximum angle in degrees). No per-element registration, no cleanup for
// components to remember: one delegated listener covers every element that
// ever exists, including ones Blazor renders later.
//
// WHY IT WRITES `rotate` AND NOT `transform`
// Nearly every card in this app already animates `transform` on hover — a 2 px
// lift, a scale. Writing the tilt into `transform` would clobber that, and
// reconstructing the lift here would mean this file knowing each card's hover
// style. CSS's independent `rotate` property composes with `transform` instead
// of replacing it, so the lift and the tilt coexist and neither has to know
// about the other. (Same reason impactBus.js shakes with `translate`.)
//
// The pointer position is also published as --fx-mx/--fx-my in -1..1 so CSS can
// move a glare highlight to match; that part is declarative in fx.css.
//
// COST: one pointerover listener at rest. While a pointer is over a tilt
// surface, one pointermove listener coalesced into a single rAF write. Nothing
// runs when nothing is hovered.

const DEFAULT_MAX_DEG = 8;

let active = null;          // the element currently being tracked
let maxDeg = DEFAULT_MAX_DEG;
let pendingX = 0;
let pendingY = 0;
let rafId = 0;

function motionReduced() {
    try {
        if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/** Low-tier hardware skips the tilt entirely; it is pure polish. */
function tierAllows() {
    return document.documentElement.getAttribute('data-gfx') !== 'low';
}

let isMagnetic = false;
let _lastShimmerTime = 0;

function apply() {
    rafId = 0;
    if (!active) return;
    // Axis is perpendicular to the pointer offset: pushing the cursor right
    // should tip the right edge away, which is a rotation about the Y axis;
    // pushing it down tips about X. Expressing it as one axis-angle rotation
    // keeps this to a single `rotate` value.
    const mag = Math.min(1, Math.hypot(pendingX, pendingY));
    active.style.rotate = `${-pendingY} ${pendingX} 0 ${(mag * maxDeg).toFixed(2)}deg`;
    if (isMagnetic) {
        const pull = 5.0; // px magnetic spring translation
        active.style.translate = `${(pendingX * pull).toFixed(1)}px ${(pendingY * pull).toFixed(1)}px`;
    }
    active.style.setProperty('--fx-mx', pendingX.toFixed(3));
    active.style.setProperty('--fx-my', pendingY.toFixed(3));

    // Holographic foil properties
    const angleDeg = (Math.atan2(pendingY, pendingX) * 180 / Math.PI + 180).toFixed(1);
    active.style.setProperty('--holo-angle', `${angleDeg}deg`);
    active.style.setProperty('--holo-glare', mag.toFixed(2));
    active.style.setProperty('--holo-x', `${((pendingX + 1) * 50).toFixed(1)}%`);
    active.style.setProperty('--holo-y', `${((pendingY + 1) * 50).toFixed(1)}%`);

    const now = performance.now();
    if (active.hasAttribute('data-fx-holo') || active.classList.contains('fx-holo-card') || active.classList.contains('player-card')) {
        const dAngle = Math.abs(parseFloat(angleDeg) - (active._lastHoloAngle || parseFloat(angleDeg)));
        active._lastHoloAngle = parseFloat(angleDeg);
        if (dAngle > 40 && now - _lastShimmerTime > 1500) {
            _lastShimmerTime = now;
            window.PoCue?.fire('ui', 'holoShimmer');
        }
    }
}

function schedule() {
    if (!rafId) rafId = requestAnimationFrame(apply);
}

function release(el) {
    if (!el) return;
    el.style.rotate = '';
    el.style.translate = '';
    el.style.removeProperty('--fx-mx');
    el.style.removeProperty('--fx-my');
    el.style.removeProperty('--holo-angle');
    el.style.removeProperty('--holo-glare');
    el.style.removeProperty('--holo-x');
    el.style.removeProperty('--holo-y');
}

function onMove(e) {
    if (!active) return;
    const r = active.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // -1..1 from the element's centre, clamped: a pointer can be a few pixels
    // outside the box during the frame the leave event is still in flight, and
    // an unclamped value there produces a visible over-rotation snap.
    pendingX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    pendingY = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    schedule();
}

function detach() {
    if (!active) return;
    window.removeEventListener('pointermove', onMove);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    release(active);
    active = null;
    isMagnetic = false;
}

function onOver(e) {
    const el = e.target && e.target.closest
        ? e.target.closest('[data-fx-tilt], [data-fx-holo], [data-magnetic], .fx-holo-card, .player-card, .poeco-btn, .poeco-pill, .poeco-tab')
        : null;
    if (el === active) return;
    detach();
    if (!el) return;
    // A coarse pointer has no hover state — on touch the "tilt" would only
    // appear at the moment of the tap and read as a rendering glitch.
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (motionReduced() || !tierAllows()) return;

    active = el;
    isMagnetic = el.hasAttribute('data-magnetic') ||
                 el.classList.contains('poeco-btn') ||
                 el.classList.contains('poeco-pill') ||
                 el.classList.contains('poeco-tab');

    const attr = parseFloat(el.getAttribute('data-fx-tilt') || el.getAttribute('data-fx-holo'));
    maxDeg = Number.isFinite(attr) && attr > 0 ? Math.min(20, attr) : (isMagnetic ? 4 : DEFAULT_MAX_DEG);
    window.addEventListener('pointermove', onMove, { passive: true });
}

function onDeviceOrientation(e) {
    if (motionReduced() || !tierAllows()) return;
    if (e.gamma == null || e.beta == null) return;
    const holoCards = document.querySelectorAll('[data-fx-holo], .fx-holo-card, .player-card');
    if (!holoCards.length) return;
    const gx = Math.max(-1, Math.min(1, e.gamma / 30));
    const gy = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
    const mag = Math.min(1, Math.hypot(gx, gy));
    const angleDeg = (Math.atan2(gy, gx) * 180 / Math.PI + 180).toFixed(1);
    for (const card of holoCards) {
        card.style.setProperty('--fx-mx', gx.toFixed(3));
        card.style.setProperty('--fx-my', gy.toFixed(3));
        card.style.setProperty('--holo-angle', `${angleDeg}deg`);
        card.style.setProperty('--holo-glare', mag.toFixed(2));
        card.style.setProperty('--holo-x', `${((gx + 1) * 50).toFixed(1)}%`);
        card.style.setProperty('--holo-y', `${((gy + 1) * 50).toFixed(1)}%`);
    }
}

if (typeof document !== 'undefined') {
    // pointerover/pointerout rather than enter/leave: those do not bubble, and
    // delegation is the entire point of this module.
    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerout', (e) => {
        if (!active) return;
        // relatedTarget is where the pointer went. Still inside the tilt
        // element (moving between its children) means this is not a real exit.
        if (e.relatedTarget && active.contains(e.relatedTarget)) return;
        detach();
    }, { passive: true });

    // Tactile micro-click feedback on magnetic/tilt elements
    document.addEventListener('pointerdown', (e) => {
        const el = e.target && e.target.closest
            ? e.target.closest('[data-fx-tilt], [data-magnetic], .poeco-btn, .poeco-pill, .poeco-tab')
            : null;
        if (el && window.PoUiAudio && window.PoUiAudio.magneticSnap) {
            window.PoUiAudio.magneticSnap();
        }
    }, { passive: true });

    // Blazor can remove the hovered element mid-navigation without ever firing
    // pointerout, which would leave `active` pointing at a detached node and
    // the pointermove listener running forever.
    window.addEventListener('pagehide', detach);

    // Mobile gyroscope tilt for holographic foils
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
    }
}

if (typeof window !== 'undefined') {
    window.PoTilt = { detach };
}
