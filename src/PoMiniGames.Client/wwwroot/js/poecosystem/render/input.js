// input.js — keyboard + mouse (drag-look and pointer-lock free-look, with a touch
// fallback) feeding the player controller. Keeps no three.js or sim state: it only
// produces the { forward, right, run, jump, up } intent and calls back for one-shot
// actions (inspect, fly, dashboard, speed).
//
// Mouse look has TWO paths on purpose. Pointer lock is the good one (infinite travel, no
// cursor), but it only exists after a click the browser accepts as a gesture, and it is
// dropped by every Esc — closing the dashboard, closing a panel — after
// which Chrome refuses to re-lock for about a second. With lock as the only path, a player
// who simply moved the mouse, or clicked during the re-lock cooldown, would see a camera
// that ignored them entirely. So left-drag looks as well: it needs no lock, no gesture
// budget and no permission, and a press that never travels past DRAG_SLOP still falls
// through to the lock request (click-to-free-look).
//
// Keys are bindings, not literals — every held and one-shot action maps to one
// or more KeyboardEvent.code values (Settings → Controls rebinds the first of each), and a
// gamepad is polled in consume() (left stick moves, right stick looks). Tab, Escape
// and the speed digits stay fixed: they are the HUD's own shortcuts and the page's docs.
export const DEFAULT_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'], rise: ['Space'], sink: ['ControlLeft', 'ControlRight'],
  fly: ['KeyF'], inspect: ['KeyE'], follow: ['KeyT'], director: ['KeyC'], pip: ['KeyP'],
});
export const BINDABLE = Object.freeze(Object.keys(DEFAULT_BINDINGS));
const ONE_SHOT = Object.freeze(['fly', 'inspect', 'follow', 'director', 'pip']);
// More fixed keys, all the HUD's own — `/` (and Ctrl/Cmd+K) opens the finder, L steps
// through the lenses, H holds the key legend up.
const FIXED = new Set(['Tab', 'Escape', 'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Slash', 'KeyL', 'KeyH']);

/** Defaults with the player's overrides laid over them (unknown actions and fixed keys ignored). */
export function mergeBindings(overrides) {
  const out = {};
  for (const a of BINDABLE) out[a] = DEFAULT_BINDINGS[a].slice();
  if (overrides && typeof overrides === 'object') {
    for (const [a, codes] of Object.entries(overrides)) {
      if (!out[a] || !Array.isArray(codes)) continue;
      const clean = codes.filter(c => typeof c === 'string' && c && !FIXED.has(c)).slice(0, 3);
      if (clean.length) out[a] = clean;
    }
  }
  return out;
}

// Gamepad (standard mapping): A inspect, B float/walk, X follow, Y dashboard, LB/RB sink/rise,
// triggers run, Start cinematic.
const PAD = Object.freeze({ A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, START: 9, UP: 12, DOWN: 13 });
const PAD_DEADZONE = 0.18;
const PAD_LOOK_PX = 13;   // pixels of mouse-look per frame at full stick deflection

export function createInput(canvas, { onAction = () => {}, onLook = () => {}, bindings = null } = {}) {
  const keys = new Set();
  let binds = mergeBindings(bindings);
  let codeToAction = new Map();
  const reindex = () => { codeToAction = new Map(); for (const a of BINDABLE) for (const c of binds[a]) codeToAction.set(c, a); };
  reindex();
  const held = (action) => binds[action].some(c => keys.has(c));
  const pad = { buttons: [], look: false };
  const intent = { forward: 0, right: 0, run: false, jump: false, up: 0 };
  const touch = { active: false, moveId: null, lookId: null, mx: 0, mz: 0, lastX: 0, lastY: 0 };
  // Left-button drag-look. `moved` latches once the press travels past the slop, which is
  // what separates a look-drag from a click: a drag must NOT end by grabbing the pointer.
  const drag = { active: false, moved: false, originX: 0, originY: 0, lastX: 0, lastY: 0 };
  const DRAG_SLOP = 4;   // px of travel before a press is a look rather than a click
  let locked = false;
  let disposed = false;

  const code = (e) => e.code || e.key;
  const isTyping = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  function refresh() {
    intent.forward = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0);
    intent.right = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
    intent.run = held('run');
    intent.up = (held('rise') ? 1 : 0) - (held('sink') ? 1 : 0);
    if (touch.active) { intent.forward = touch.mz; intent.right = touch.mx; }
  }

  /**
   * Poll the first connected gamepad. Folded into the intent only while a stick or button is
   * actually in use, so a pad resting on the desk never fights the keyboard.
   */
  function pollPad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    let gp = null;
    if (pads) for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) return;
    const axis = (k) => { const v = gp.axes[k] ?? 0; return Math.abs(v) < PAD_DEADZONE ? 0 : v; };
    const btn = (k) => { const b = gp.buttons[k]; return !!b && (b.pressed || b.value > 0.5); };
    const edge = (k) => { const now = btn(k); const was = !!pad.buttons[k]; pad.buttons[k] = now; return now && !was; };
    const lx = axis(0); const ly = axis(1); const rx = axis(2); const ry = axis(3);
    if (lx || ly) { intent.right = lx; intent.forward = -ly; }
    if (btn(PAD.LT) || btn(PAD.RT)) intent.run = true;
    const up = (btn(PAD.RB) || btn(PAD.UP) ? 1 : 0) - (btn(PAD.LB) || btn(PAD.DOWN) ? 1 : 0);
    if (up) intent.up = up;
    if (rx || ry) onLook(rx * PAD_LOOK_PX, ry * PAD_LOOK_PX);
    if (edge(PAD.A)) onAction('inspect');
    if (edge(PAD.B)) onAction('fly');
    if (edge(PAD.X)) onAction('follow');
    if (edge(PAD.Y)) onAction('dashboard');
    if (edge(PAD.START)) onAction('director');
  }

  // Digit keys map to the speed ladder; note 3 selects 4×.
  const SPEED_KEYS = { Digit0: 0, Digit1: 1, Digit2: 2, Digit3: 4 };

  const onKeyDown = (e) => {
    if (isTyping(e) || disposed) return;
    const c = code(e);
    if (c === 'Tab') { e.preventDefault(); onAction('dashboard'); return; }
    if (c === 'Escape') { onAction('escape'); return; }
    // The finder's key is swallowed so the `/` that opened it is not typed into it.
    if (c === 'Slash' || (c === 'KeyK' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); onAction('find'); return; }
    if (keys.has(c)) return;
    keys.add(c);
    // Ctrl is "sink" by default, so only these two letters check for a held modifier.
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (c === 'KeyL' && plain) onAction('lens');
    if (c === 'KeyH' && plain) onAction('keys', true);
    const action = codeToAction.get(c);
    if (action === 'rise') { e.preventDefault(); intent.jump = true; }
    if (action && ONE_SHOT.includes(action)) onAction(action);
    if (c === 'KeyM' && !action) onAction('map');
    if (c in SPEED_KEYS) onAction('speed', SPEED_KEYS[c]);
    refresh();
  };
  const onKeyUp = (e) => {
    if (code(e) === 'KeyH' && keys.has('KeyH')) onAction('keys', false);
    keys.delete(code(e)); if (codeToAction.get(code(e)) === 'rise') intent.jump = false; refresh();
  };
  const onBlur = () => { keys.clear(); drag.active = false; drag.moved = false; refresh(); };

  // Both mouse paths land here. While locked the browser hands us movementX/Y directly;
  // while dragging we difference the client position ourselves. Listening on `window`
  // rather than the canvas is what keeps a drag alive once it leaves the viewport edge.
  const onMouseMove = (e) => {
    if (locked) { onLook(e.movementX ?? 0, e.movementY ?? 0); return; }
    if (!drag.active) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.originX) + Math.abs(e.clientY - drag.originY) < DRAG_SLOP) return;
      drag.moved = true;
    }
    onLook(dx, dy);
  };
  const requestLock = () => {
    // Rejects on the post-Esc cooldown and whenever the document has lost focus; an
    // unhandled rejection there would be the only sign anything happened, so swallow it.
    const p = canvas.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };
  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    onAction('pointerLock', locked);
    if (!locked) { keys.clear(); refresh(); }
    // A lock that begins mid-drag would double-count the motion (movementX *and* our own
    // difference), and one that ends leaves a stale origin behind.
    drag.active = false; drag.moved = false;
  };
  const onMouseDown = (e) => {
    if (disposed || e.button !== 0) return;
    if (locked) { onAction('inspect'); return; }
    drag.active = true; drag.moved = false;
    drag.originX = e.clientX; drag.originY = e.clientY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    e.preventDefault();   // a mouse drag over a canvas otherwise starts a text selection
  };
  const onMouseUp = (e) => {
    if (!drag.active || e.button !== 0) return;
    const wasClick = !drag.moved;
    drag.active = false; drag.moved = false;
    // A press that never travelled is still the click-to-free-look gesture.
    if (wasClick && !locked) requestLock();
  };

  // Touch: left half drags the move pad, right half looks.
  const onTouchStart = (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < canvas.clientWidth / 2 && touch.moveId === null) { touch.moveId = t.identifier; touch.originX = t.clientX; touch.originY = t.clientY; touch.active = true; }
      else if (touch.lookId === null) { touch.lookId = t.identifier; touch.lastX = t.clientX; touch.lastY = t.clientY; }
    }
  };
  const onTouchMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) {
        const dx = t.clientX - touch.originX; const dy = t.clientY - touch.originY;
        const len = Math.max(1, Math.hypot(dx, dy));
        const s = Math.min(1, len / 60);
        touch.mx = (dx / len) * s; touch.mz = (-dy / len) * s;
        refresh();
      } else if (t.identifier === touch.lookId) {
        onLook((t.clientX - touch.lastX) * 2, (t.clientY - touch.lastY) * 2);
        touch.lastX = t.clientX; touch.lastY = t.clientY;
      }
    }
    e.preventDefault();
  };
  const onTouchEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) { touch.moveId = null; touch.active = false; touch.mx = 0; touch.mz = 0; refresh(); }
      if (t.identifier === touch.lookId) touch.lookId = null;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onLockChange);
  // move/up on window, down on the canvas: the press must start on the world, but the
  // drag has to survive leaving it (and a release over the HUD must still end the drag).
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: true });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return {
    intent,
    get locked() { return locked; },
    /** Jump is edge-triggered: the controller consumes it once. The gamepad is read here. */
    consume() {
      refresh();
      pollPad();
      const snapshot = { ...intent };
      intent.jump = false;
      return snapshot;
    },
    get bindings() { return mergeBindings(binds); },
    setBindings(b) { binds = mergeBindings(b); reindex(); keys.clear(); refresh(); },
    setTouchVector(x, z) { touch.active = true; touch.mx = x; touch.mz = z; refresh(); },
    releaseTouch() { touch.active = false; touch.mx = 0; touch.mz = 0; refresh(); },
    dispose() {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      if (locked && document.exitPointerLock) document.exitPointerLock();
    },
  };
}
