// gamepad.js — controllers in, rumble out.
//
// A pad is not a new input path. Each poll turns the pad's state into the set of
// KEY CODES it is holding and dispatches synthetic keydown/keyup for the
// difference, exactly as the touch panel does (input.js buildTouchControls). So
// KeyboardController — hold-to-charge, toggle holds, the lot — drives a pad with
// no code of its own, and rebinding a key in input.js LAYOUTS rebinds the button too.
//
// A pad only ever RELEASES codes it pressed itself, so a player on the keyboard
// and a pad on the same layout do not cancel each other's held keys (the one
// overlap: a pad lifting a key the keyboard is also holding — rare, harmless).

import { LAYOUTS } from './input.js';

// Stick deadzone. 0.4 rather than a tight 0.15: a worn stick resting at 0.25
// would otherwise walk the fighter on its own, and nothing here is analogue —
// the keyboard model is on/off, so there is no precision to buy with a small one.
const DEADZONE = 0.4;

// Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping).
const B = { south: 0, east: 1, west: 2, north: 3, lb: 4, rb: 5, lt: 6, rt: 7, up: 12, down: 13, left: 14, right: 15 };

const pressed = (pad, i) => {
  const b = pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
};

export class GamepadBridge {
  /** @param {number[]} layouts layout per pad slot: [1] in 1P, [1, 2] in 2P. */
  constructor(layouts) {
    this.layouts = layouts;
    this.held = layouts.map(() => new Set());
    this.padIndex = layouts.map(() => -1); // navigator index currently driving each slot
    this.supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  }

  poll() {
    if (!this.supported) return;
    let pads;
    try { pads = navigator.getGamepads(); } catch { return; }
    // Connected pads in navigator order: the first drives slot 0 (P1), the second
    // slot 1 (P2). Re-derived every poll so a pad plugged in mid-fight just works.
    const live = [];
    for (const p of pads || []) if (p && p.connected) live.push(p);
    for (let slot = 0; slot < this.layouts.length; slot++) {
      const pad = live[slot] || null;
      this.padIndex[slot] = pad ? pad.index : -1;
      this._apply(slot, pad ? this._codes(pad, LAYOUTS[this.layouts[slot]]) : null);
    }
  }

  _codes(pad, k) {
    const want = new Set();
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    if (ax < -DEADZONE || pressed(pad, B.left)) want.add(k.left);
    if (ax > DEADZONE || pressed(pad, B.right)) want.add(k.right);
    if (ay < -DEADZONE || pressed(pad, B.up)) want.add(k.depthAway);
    if (ay > DEADZONE || pressed(pad, B.down)) want.add(k.depthToward);
    // Face buttons: south/west punch, east/north kick — so both the "A punches"
    // and the "square punches" instincts land on the same move.
    if (pressed(pad, B.south) || pressed(pad, B.west)) want.add(k.punch);
    if (pressed(pad, B.east) || pressed(pad, B.north)) want.add(k.kick);
    // Any shoulder or trigger guards: it is a HOLD, and a trigger is the natural
    // thing to hold down.
    if (pressed(pad, B.lb) || pressed(pad, B.rb) || pressed(pad, B.lt) || pressed(pad, B.rt)) want.add(k.block);
    return want;
  }

  _apply(slot, want) {
    const held = this.held[slot];
    for (const code of [...held]) {
      if (want && want.has(code)) continue;
      held.delete(code);
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    }
    if (!want) return;
    for (const code of want) {
      if (held.has(code)) continue;
      held.add(code);
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
    }
  }

  /**
   * Dual-rumble on the pad driving `layout`. Magnitudes 0..1. A no-op without a pad,
   * or on a browser without vibrationActuator (Firefox, Safari) — rumble is garnish.
   */
  rumble(layout, strong, weak, ms) {
    const slot = this.layouts.indexOf(layout);
    if (slot < 0 || this.padIndex[slot] < 0) return;
    let pad;
    try { pad = navigator.getGamepads()[this.padIndex[slot]]; } catch { return; }
    const act = pad && pad.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return;
    act.playEffect('dual-rumble', {
      startDelay: 0,
      duration: Math.round(ms),
      strongMagnitude: Math.min(1, Math.max(0, strong)),
      weakMagnitude: Math.min(1, Math.max(0, weak)),
    }).catch(() => { /* a pad unplugged mid-effect */ });
  }

  dispose() {
    // Release everything so a fighter disposed mid-hold does not leave a key
    // stuck down in the next engine's KeyboardController.
    for (let slot = 0; slot < this.held.length; slot++) this._apply(slot, null);
  }
}
