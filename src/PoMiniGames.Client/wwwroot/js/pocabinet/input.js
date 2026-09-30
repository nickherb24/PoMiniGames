// pocabinet/input.js
//
// Every way to drive a PoCabinet car, folded into one analog reading per tick:
// { throttle 0..1, brake 0..1, steer -1..1 (+ = right) }.
//
//   • keyboard  — WASD / arrows. Digital keys, so steering RAMPS toward full
//                 lock (and faster back to centre) instead of snapping: a
//                 snapped ±1 at 130 u/s is instant understeer.
//                 C cycles the camera, Esc / P pause.
//   • gamepad   — Gamepad API, standard mapping: left stick steers (deadzone +
//                 response curve), RT/LT or A/B are gas/brake, Start pauses.
//                 Wall hits rumble through vibrationActuator when present.
//   • touch     — on-screen controls rendered by the page (#pocabinetTouch):
//                 a steer pad on the left (drag), gas + brake on the right.
//                 "Tilt" mode steers with DeviceOrientation instead; iOS needs
//                 a permission tap, which the overlay's enable button provides.
//
// The page owns the overlay markup (so its scoped CSS applies); this module only
// attaches listeners and flips data-* attributes Blazor never renders, so a
// re-render can't wipe them.

const KEY_STEER_RATE = 4.5;     // lock per second while a steer key is held
const KEY_CENTER_RATE = 7.5;    // lock per second back to centre
const PAD_DEADZONE = 0.12;
const TILT_FULL_LOCK_DEG = 24;

export function attachInput(opts) {
    const o = opts || {};
    const state = {
        keys: { up: false, down: false, left: false, right: false },
        kbSteer: 0,
        touch: { steer: 0, gas: 0, brake: 0, used: false },
        tilt: { steer: 0, enabled: false },
        padStartWas: false,
        padConnected: false,
        options: { steerMode: 'pad', touch: 'auto', sensitivity: 1 },
        lastRumble: 0,
    };
    const cleanups = [];
    const on = (target, type, fn, opt) => {
        target.addEventListener(type, fn, opt);
        cleanups.push(() => target.removeEventListener(type, fn, opt));
    };

    // ── Keyboard ──────────────────────────────────────────────────────────
    const isTyping = (e) => {
        const t = e.target;
        return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const onKey = (e, down) => {
        const k = (e.key || '').toLowerCase();
        // Esc toggles pause even from a form control: the pause menu is a modal dialog whose
        // focus lands on its volume slider, and its own Esc-close is cancelled (index.js
        // showModal) so this stays the one handler. "p" still types into fields.
        if (k !== 'escape' && isTyping(e)) return;
        if (k === 'escape' || k === 'p') {
            if (down && !e.repeat) { e.preventDefault(); o.onPause?.(); }
            return;
        }
        if (k === 'c') {
            if (down && !e.repeat) o.onCamera?.();
            return;
        }
        if (k === 'w' || k === 'arrowup') state.keys.up = down;
        else if (k === 's' || k === 'arrowdown') state.keys.down = down;
        else if (k === 'a' || k === 'arrowleft') state.keys.left = down;
        else if (k === 'd' || k === 'arrowright') state.keys.right = down;
        else return;
        e.preventDefault();
    };
    on(document, 'keydown', e => onKey(e, true));
    on(document, 'keyup', e => onKey(e, false));
    // A key held while the tab loses focus would otherwise stay "down" forever.
    on(window, 'blur', () => { state.keys = { up: false, down: false, left: false, right: false }; });

    // ── Touch overlay ─────────────────────────────────────────────────────
    const root = typeof o.touchRoot === 'string' ? document.getElementById(o.touchRoot) : o.touchRoot;
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const setTouchActive = (active) => {
        if (root) root.dataset.active = active ? 'true' : 'false';
    };
    const refreshTouchVisibility = () => {
        const mode = state.options.touch;
        setTouchActive(mode === 'on' || (mode === 'auto' && (coarse || state.touch.used)));
        if (root) root.dataset.steer = state.options.steerMode === 'tilt' ? 'tilt' : 'pad';
    };
    if (root) {
        const pad = root.querySelector('[data-ctl="steer"]');
        const gas = root.querySelector('[data-ctl="gas"]');
        const brake = root.querySelector('[data-ctl="brake"]');
        const tiltBtn = root.querySelector('[data-ctl="tilt-enable"]');

        if (pad) {
            let pointer = null;
            const move = (e) => {
                const r = pad.getBoundingClientRect();
                const s = ((e.clientX - (r.left + r.width / 2)) / (r.width * 0.4));
                state.touch.steer = Math.max(-1, Math.min(1, s));
                pad.style.setProperty('--pocabinet-steer', state.touch.steer.toFixed(3));
            };
            on(pad, 'pointerdown', e => {
                pointer = e.pointerId;
                state.touch.used = true;
                try { pad.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
                move(e);
                e.preventDefault();
            });
            on(pad, 'pointermove', e => { if (e.pointerId === pointer) move(e); });
            const release = e => {
                if (e.pointerId !== pointer) return;
                pointer = null;
                state.touch.steer = 0;
                pad.style.setProperty('--pocabinet-steer', '0');
            };
            on(pad, 'pointerup', release);
            on(pad, 'pointercancel', release);
        }
        const pedal = (el, key) => {
            if (!el) return;
            on(el, 'pointerdown', e => {
                state.touch[key] = 1;
                state.touch.used = true;
                el.dataset.pressed = 'true';
                try { el.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
                e.preventDefault();
            });
            const up = () => { state.touch[key] = 0; el.dataset.pressed = 'false'; };
            on(el, 'pointerup', up);
            on(el, 'pointercancel', up);
        };
        pedal(gas, 'gas');
        pedal(brake, 'brake');

        if (tiltBtn) {
            on(tiltBtn, 'click', async () => {
                try {
                    const D = window.DeviceOrientationEvent;
                    if (D && typeof D.requestPermission === 'function') {
                        const res = await D.requestPermission();
                        state.tilt.enabled = res === 'granted';
                    } else {
                        state.tilt.enabled = true;
                    }
                } catch { state.tilt.enabled = false; }
                root.dataset.tilt = state.tilt.enabled ? 'on' : 'denied';
            });
        }
        // Any touch on the race area reveals the controls in 'auto' mode.
        on(window, 'touchstart', () => { if (!state.touch.used) { state.touch.used = true; refreshTouchVisibility(); } }, { passive: true });
    }

    // ── Tilt ──────────────────────────────────────────────────────────────
    on(window, 'deviceorientation', e => {
        if (state.options.steerMode !== 'tilt') return;
        state.tilt.enabled = true;
        const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
            ? screen.orientation.angle
            : (typeof window.orientation === 'number' ? window.orientation : 0);
        let deg;
        if (angle === 90) deg = Number(e.beta) || 0;
        else if (angle === 270 || angle === -90) deg = -(Number(e.beta) || 0);
        else deg = Number(e.gamma) || 0;
        if (Math.abs(deg) < 2) deg = 0;
        state.tilt.steer = Math.max(-1, Math.min(1, deg / TILT_FULL_LOCK_DEG));
    });

    // ── Gamepad ───────────────────────────────────────────────────────────
    const readPad = () => {
        const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
        for (const gp of pads || []) {
            if (!gp || !gp.connected) continue;
            const ax = Number(gp.axes?.[0]) || 0;
            const mag = Math.abs(ax) < PAD_DEADZONE ? 0 : (Math.abs(ax) - PAD_DEADZONE) / (1 - PAD_DEADZONE);
            const steer = Math.sign(ax) * Math.pow(mag, 1.4);
            const b = gp.buttons || [];
            const val = (i) => Number(b[i]?.value) || (b[i]?.pressed ? 1 : 0);
            const throttle = Math.max(val(7), val(0));
            const brake = Math.max(val(6), val(1));
            const start = !!b[9]?.pressed;
            if (start && !state.padStartWas) o.onPause?.();
            state.padStartWas = start;
            if (b[3]?.pressed && !state.padCamWas) o.onCamera?.();
            state.padCamWas = !!b[3]?.pressed;
            state.padConnected = true;
            return { gp, throttle, brake, steer };
        }
        state.padConnected = false;
        return null;
    };

    refreshTouchVisibility();

    return {
        /** One analog reading; dt advances the keyboard steering ramp. */
        read(dt) {
            const k = state.keys;
            const target = (k.right ? 1 : 0) - (k.left ? 1 : 0);
            if (target !== 0) {
                const rate = Math.sign(target) !== Math.sign(state.kbSteer) && state.kbSteer !== 0 ? KEY_CENTER_RATE : KEY_STEER_RATE;
                state.kbSteer += Math.sign(target - state.kbSteer) * Math.min(Math.abs(target - state.kbSteer), rate * dt);
            } else {
                state.kbSteer -= Math.sign(state.kbSteer) * Math.min(Math.abs(state.kbSteer), KEY_CENTER_RATE * dt);
            }

            const pad = readPad();
            const touchSteer = state.options.steerMode === 'tilt' ? state.tilt.steer : state.touch.steer;
            let throttle = Math.max(k.up ? 1 : 0, pad?.throttle || 0, state.touch.gas);
            let brake = Math.max(k.down ? 1 : 0, pad?.brake || 0, state.touch.brake);
            let steer = state.kbSteer;
            for (const s of [pad?.steer || 0, touchSteer]) if (Math.abs(s) > Math.abs(steer)) steer = s;
            steer = Math.max(-1, Math.min(1, steer * state.options.sensitivity));
            return { throttle, brake, steer };
        },

        /** Wall-hit feedback: gamepad rumble or a phone buzz, rate-limited. */
        rumble(strength) {
            const now = performance.now();
            if (now - state.lastRumble < 180) return;
            state.lastRumble = now;
            const s = Math.max(0.1, Math.min(1, strength));
            const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
            for (const gp of pads || []) {
                try {
                    gp?.vibrationActuator?.playEffect?.('dual-rumble', {
                        startDelay: 0, duration: 90 + s * 120, weakMagnitude: s * 0.6, strongMagnitude: s,
                    });
                } catch { /* unsupported */ }
            }
            if (state.touch.used && typeof navigator.vibrate === 'function') {
                try { navigator.vibrate(Math.round(20 + s * 40)); } catch { /* unsupported */ }
            }
        },

        /** Settings: { steerMode: 'pad'|'tilt', touch: 'auto'|'on'|'off', steerSensitivity }. */
        setOptions(settings) {
            const s = settings || {};
            state.options.steerMode = s.steerMode === 'tilt' ? 'tilt' : 'pad';
            state.options.touch = ['on', 'off'].includes(s.touchControls) ? s.touchControls : 'auto';
            state.options.sensitivity = Math.min(1.5, Math.max(0.5, Number(s.steerSensitivity) || 1));
            refreshTouchVisibility();
        },

        get gamepadConnected() { return state.padConnected; },

        detach() {
            for (const c of cleanups.splice(0)) { try { c(); } catch { /* ignore */ } }
            setTouchActive(false);
        },
    };
}
