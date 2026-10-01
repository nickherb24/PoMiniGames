// input.js — gamepad and touch for PoVoxelStrike.
//
// Both devices are reduced to the same small per-frame record the keyboard and mouse
// already produce (a move vector, a look delta in mouse-pixel units, held fire, and
// one-shot blast / jump / pause), so game.js never learns which one it came from.
//
// Neither device can take Pointer Lock, and lock is what the engine used to mean by "in
// control". game.js therefore has a second way in — free control — entered from a pad
// button or, on a touch-only device, from the start card. Pause is then a button (Start,
// or the on-screen one) rather than the lock being lost.

const DEADZONE = 0.18;
// A full stick deflection turns at this many mouse pixels per second (x 0.0025 rad/px in
// game.js = 2.4 rad/s), before the player's own look-speed setting.
const PAD_LOOK_PX_S = 960;
const TOUCH_LOOK_GAIN = 1.7;

const shape = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

export class AltInput {
  /** @param hooks { pause() } — the touch pause button calls it directly. */
  constructor(host, hooks) {
    this.touch = !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
    this.hooks = hooks;
    this._padPrev = [];
    this._stick = { x: 0, y: 0 };
    this._drag = { x: 0, y: 0 };
    this._held = { fire: false };
    this._tap = { alt: false, jump: false };
    this.root = null;
    if (this.touch) this._buildTouch(host);
  }

  /** Show the on-screen controls only while the player is actually driving. */
  setActive(on) { if (this.root) this.root.style.display = on ? 'block' : 'none'; }

  /**
   * One frame of pad + touch.
   * @returns {{moveX:number, moveY:number, lookX:number, lookY:number, fire:boolean,
   *   alt:boolean, jump:boolean, pause:boolean, any:boolean}}
   *   moveY is +forward. look is in mouse pixels for this frame. `any` is a pad button
   *   going down this frame — what the start card and the pause dialog listen for.
   */
  poll(dt) {
    const out = {
      moveX: this._stick.x, moveY: this._stick.y,
      lookX: this._drag.x * TOUCH_LOOK_GAIN, lookY: this._drag.y * TOUCH_LOOK_GAIN,
      fire: this._held.fire, alt: this._tap.alt, jump: this._tap.jump, pause: false, any: false,
    };
    this._drag.x = this._drag.y = 0;
    this._tap.alt = this._tap.jump = false;

    // First connected pad with the standard mapping; a wheel or a flight stick is ignored.
    let pad = null;
    for (const p of navigator.getGamepads?.() ?? []) {
      if (p && p.connected && p.mapping === 'standard') { pad = p; break; }
    }
    if (!pad) { this._padPrev.length = 0; return out; }

    const down = (i) => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.35);
    const edge = (i) => down(i) && !this._padPrev[i];
    out.moveX += shape(pad.axes[0] ?? 0);
    out.moveY += -shape(pad.axes[1] ?? 0);
    out.lookX += shape(pad.axes[2] ?? 0) * PAD_LOOK_PX_S * dt;
    out.lookY += shape(pad.axes[3] ?? 0) * PAD_LOOK_PX_S * dt;
    out.fire = out.fire || down(7);                 // RT
    out.alt = out.alt || edge(6) || edge(5);        // LT or RB
    out.jump = out.jump || edge(0);                 // A
    out.pause = edge(9);                            // Start
    for (let i = 0; i < pad.buttons.length; i++) {
      if (edge(i)) out.any = true;
      this._padPrev[i] = down(i);
    }
    return out;
  }

  // ── Touch ────────────────────────────────────────────────────────────────
  // Left thumb: a stick that centres where it is first touched. Right thumb: drag anywhere
  // on the right half to look. DIG is held, BLAST and JUMP are taps. Styled in
  // PoVoxelStrikePage.razor.css through ::deep, like the engine's other injected nodes.
  _buildTouch(host) {
    const root = document.createElement('div');
    root.className = 'pvs-touch';
    root.style.display = 'none';
    root.innerHTML =
      '<div class="pvs-touch-move"><div class="pvs-touch-nub"></div></div>' +
      '<div class="pvs-touch-look"></div>' +
      '<button type="button" class="pvs-tbtn pvs-tbtn-dig">DIG</button>' +
      '<button type="button" class="pvs-tbtn pvs-tbtn-blast">BLAST</button>' +
      '<button type="button" class="pvs-tbtn pvs-tbtn-jump">JUMP</button>' +
      '<button type="button" class="pvs-tbtn pvs-tbtn-pause" aria-label="Pause">II</button>';
    host.appendChild(root);
    this.root = root;

    const move = root.querySelector('.pvs-touch-move');
    const nub = root.querySelector('.pvs-touch-nub');
    let origin = null;
    const RADIUS = 56;
    const setStick = (x, y) => {
      this._stick.x = x; this._stick.y = y;
      nub.style.transform = `translate(${x * RADIUS}px, ${-y * RADIUS}px)`;
    };
    move.addEventListener('pointerdown', (e) => {
      move.setPointerCapture(e.pointerId);
      origin = { x: e.clientX, y: e.clientY };
    });
    move.addEventListener('pointermove', (e) => {
      if (!origin) return;
      let x = (e.clientX - origin.x) / RADIUS, y = (origin.y - e.clientY) / RADIUS;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      setStick(x, y);
    });
    const release = () => { origin = null; setStick(0, 0); };
    move.addEventListener('pointerup', release);
    move.addEventListener('pointercancel', release);

    const look = root.querySelector('.pvs-touch-look');
    let last = null;
    look.addEventListener('pointerdown', (e) => {
      look.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
    });
    look.addEventListener('pointermove', (e) => {
      if (!last) return;
      this._drag.x += e.clientX - last.x;
      this._drag.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
    });
    const lookEnd = () => { last = null; };
    look.addEventListener('pointerup', lookEnd);
    look.addEventListener('pointercancel', lookEnd);

    const dig = root.querySelector('.pvs-tbtn-dig');
    dig.addEventListener('pointerdown', (e) => { dig.setPointerCapture(e.pointerId); this._held.fire = true; });
    const digEnd = () => { this._held.fire = false; };
    dig.addEventListener('pointerup', digEnd);
    dig.addEventListener('pointercancel', digEnd);
    root.querySelector('.pvs-tbtn-blast').addEventListener('pointerdown', () => { this._tap.alt = true; });
    root.querySelector('.pvs-tbtn-jump').addEventListener('pointerdown', () => { this._tap.jump = true; });
    root.querySelector('.pvs-tbtn-pause').addEventListener('click', () => this.hooks?.pause?.());
  }

  dispose() { this.root?.remove(); }
}
