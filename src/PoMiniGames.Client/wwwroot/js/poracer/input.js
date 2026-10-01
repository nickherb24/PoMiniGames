// Route-scoped input and canvas sizing. AbortController releases every listener.
//
// Three sources, one packet: the keyboard and the touch buttons are the five booleans, a
// gamepad adds an analog steer / throttle / brake. The server lets a non-zero analog value
// win over its key, so the two never have to be reconciled here.
import * as Render from './renderer.js';

let canvas = null, reference = null, listeners = null, enabled = false;
let input = { up: false, down: false, left: false, right: false, space: false, steer: 0, throttle: 0, brake: 0 };
const pressedKeys = new Set();
const pointers = new Map();
const keyMap = { arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', ' ': 'space' };
const KEYS = ['up', 'down', 'left', 'right', 'space'];
const PAD_DEADZONE = 0.12;
let pad = { steer: 0, throttle: 0, brake: 0, space: false }, padStartWas = false, lastRumble = 0;

function emit(next) {
    if (Object.keys(input).every(key => input[key] === next[key])) return;
    input = next;
    if (reference) reference.invokeMethodAsync('OnInputChange', input.up, input.down, input.left, input.right, input.space,
        input.steer, input.throttle, input.brake).catch(() => {});
}
function update() {
    const active = new Set([...pressedKeys].map(key => keyMap[key]));
    for (const { key } of pointers.values()) active.add(key);
    const next = Object.fromEntries(KEYS.map(key => [key, enabled && active.has(key)]));
    next.space = next.space || (enabled && pad.space);
    next.steer = enabled ? pad.steer : 0;
    next.throttle = enabled ? pad.throttle : 0;
    next.brake = enabled ? pad.brake : 0;
    emit(next);
}
function reset() {
    pressedKeys.clear();
    for (const { element } of pointers.values()) element.classList.remove('is-pressed');
    pointers.clear();
    pad = { steer: 0, throttle: 0, brake: 0, space: false };
    update();
}
function keyboard(event, down) {
    const key = event.key.toLowerCase();
    // Escape and P ask the page for the pause menu. They work with input disabled too, because
    // "disabled" is exactly the state the menu leaves the car in.
    if (down && !event.repeat && (key === 'escape' || key === 'p') && !event.target.closest?.('input,select,textarea,[contenteditable]')) {
        event.preventDefault();
        reference?.invokeMethodAsync('OnPauseKey').catch(() => {});
        return;
    }
    if (!enabled || !keyMap[key] || event.target.closest?.('input,select,textarea,summary,button,a,[contenteditable]')) return;
    event.preventDefault();
    if (down) pressedKeys.add(key); else pressedKeys.delete(key);
    update();
}
function pointerDown(event) {
    const element = event.target.closest?.('[data-po-input]');
    const key = element?.dataset.poInput;
    if (!enabled || !KEYS.includes(key)) return;
    event.preventDefault();
    try { element.setPointerCapture(event.pointerId); } catch { /* synthetic pointer or released contact */ }
    pointers.set(event.pointerId, { key, element });
    element.classList.add('is-pressed');
    update();
}
function pointerUp(event) {
    const pressed = pointers.get(event.pointerId);
    if (!pressed) return;
    pointers.delete(event.pointerId);
    if (![...pointers.values()].some(p => p.element === pressed.element)) pressed.element.classList.remove('is-pressed');
    update();
}

/**
 * Read the first connected gamepad (standard mapping: left stick steers, RT / A accelerate,
 * LT / B brake, X drifts, Start pauses). Called once per rendered frame by index.js; a pad
 * has no events for its axes, so somebody has to ask.
 *
 * Values are quantized (steer to tenths, pedals to fifths) because every change is a hub
 * call: an unquantized stick would send sixty packets a second to say almost nothing.
 */
export function pollPad() {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let next = null;
    for (const gp of pads || []) {
        if (!gp || !gp.connected) continue;
        const ax = Number(gp.axes?.[0]) || 0;
        const mag = Math.abs(ax) < PAD_DEADZONE ? 0 : (Math.abs(ax) - PAD_DEADZONE) / (1 - PAD_DEADZONE);
        const b = gp.buttons || [];
        const val = i => Number(b[i]?.value) || (b[i]?.pressed ? 1 : 0);
        const start = !!b[9]?.pressed;
        if (start && !padStartWas) reference?.invokeMethodAsync('OnPauseKey').catch(() => {});
        padStartWas = start;
        next = {
            steer: Math.round(Math.sign(ax) * Math.pow(mag, 1.4) * 10) / 10,
            throttle: Math.round(Math.max(val(7), val(0)) * 5) / 5,
            brake: Math.round(Math.max(val(6), val(1)) * 5) / 5,
            space: !!b[2]?.pressed,
        };
        break;
    }
    next ??= { steer: 0, throttle: 0, brake: 0, space: false };
    if (next.steer === pad.steer && next.throttle === pad.throttle && next.brake === pad.brake && next.space === pad.space) return;
    pad = next;
    update();
}

/** Controller rumble for a hit or a rough surface, rate-limited. Phones buzz through the cue's own haptic. */
export function rumble(strength) {
    const now = performance.now();
    if (now - lastRumble < 180) return;
    lastRumble = now;
    const s = Math.max(0.1, Math.min(1, strength));
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const gp of pads || []) {
        try {
            gp?.vibrationActuator?.playEffect?.('dual-rumble', { startDelay: 0, duration: 90 + s * 140, weakMagnitude: s * 0.6, strongMagnitude: s });
        } catch { /* unsupported */ }
    }
}

export function startInput(canvasId, dotnetReference) {
    stopInput();
    canvas = document.getElementById(canvasId);
    reference = dotnetReference;
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    window.addEventListener('keydown', event => keyboard(event, true), options);
    window.addEventListener('keyup', event => keyboard(event, false), options);
    window.addEventListener('blur', reset, options);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); }, options);
    document.addEventListener('pointerdown', pointerDown, { ...options, passive: false });
    document.addEventListener('pointerup', pointerUp, options);
    document.addEventListener('pointercancel', pointerUp, options);
    document.addEventListener('lostpointercapture', pointerUp, options);
    getSize();
}
export function setInputEnabled(value) {
    enabled = value;
    reset();
    if (value) canvas?.focus({ preventScroll: true });
}
export function stopInput() {
    enabled = false;
    reset();
    listeners?.abort();
    listeners = reference = canvas = null;
}
export function getSize() {
    if (!canvas) return { w: 0, h: 0 };
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = window.PoCanvasDpr.resolve(w, h);
    const width = Math.max(1, Math.floor(w * dpr)), height = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
        Render.invalidateBitmaps();
    }
    return { w, h };
}
