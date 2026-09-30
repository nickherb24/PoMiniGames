// input.js — keyboard → fight intents for the two local layouts.
// Intent shape (shared with ai.js): { move: -1|0|1 (+1 = toward opponent),
// side: -1|0|1 (held), punch: bool (press edge), kick: bool
// (press edge), punchHeld: bool, kickHeld: bool, block: bool, super: bool }.
// The press edge starts a charge; the engine releases the attack when the
// matching *Held flag drops — hold longer for a more powerful strike.
//
// Layout 1 (P1): A/D move · W away / S toward camera · R block (hold) · F punch · G kick
// Layout 2 (P2): ←/→ move · ↑ away / ↓ toward camera · ; block (hold) · K punch · L kick
//
// No super key: a human's signature move fires by itself when the meter fills
// (game.js `_autoSuperReady`). `super` stays in the intent shape for ai.js,
// which paces its own activation.
//
// `left`/`right` are SCREEN-relative: the left key always walks the fighter
// toward the left edge of the screen, the right key toward the right edge,
// no matter which side of the ring the fighter is standing on. update() folds
// the fighter's facing back in to produce the engine's opponent-relative
// `move` (+1 = toward opponent).
// `depthAway` / `depthToward` publish `side` = +1 / −1, which the engine applies
// along the CAMERA's forward axis: +1 walks into the screen, −1 walks out toward
// the viewer. Because the fighters stand side-on to the camera, that axis is
// also the one that carries you around your opponent — this is the circle
// control, expressed in the frame the player actually sees.
//
// Camera-relative is the point: an axis derived from the line between the
// fighters would flip on screen whenever they swap sides.
//
// Exported because the touch panel (below) and gamepad.js press these same codes.
export const LAYOUTS = {
  1: {
    left: 'KeyA', right: 'KeyD',
    depthAway: 'KeyW', depthToward: 'KeyS',
    block: 'KeyR', punch: 'KeyF', kick: 'KeyG',
  },
  2: {
    left: 'ArrowLeft', right: 'ArrowRight',
    depthAway: 'ArrowUp', depthToward: 'ArrowDown',
    block: 'Semicolon', punch: 'KeyK', kick: 'KeyL',
  },
};

export class KeyboardController {
  // game.js `_autoSuperReady` reads this: humans get an automatic super, AI
  // fighters do not (ai.js paces its own activation as a difficulty knob).
  isHuman = true;

  constructor(layout) {
    this.map = LAYOUTS[layout];
    this.down = new Set();
    this.punchQueued = false;
    this.kickQueued = false;

    this._onDown = (e) => {
      // Let any modified chord through untouched: Ctrl+R / Cmd+R is reload, and
      // no binding in either layout uses a modifier.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (Object.values(this.map).includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === this.map.punch) this._pressAttack('punch');
      else if (e.code === this.map.kick) this._pressAttack('kick');
    };
    this._onUp = (e) => {
      this.down.delete(e.code);
    };
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
  }

  update(ctx) {
    // Screen-relative intent: +1 = right key, −1 = left key.
    const worldDir = (this.down.has(this.map.right) ? 1 : 0) - (this.down.has(this.map.left) ? 1 : 0);
    // Fold in facing so the keys stay screen-relative. towardX is the sign of
    // (opponent.x − self.x); multiplying maps screen-left/right onto the
    // engine's toward/away `move`. Defaults to +1 when facing is unknown.
    const towardX = (ctx && ctx.towardX) || 1;
    const move = worldDir * towardX;
    // Deliberately NOT folded through towardX: this axis is screen-relative, so W
    // walks into the screen whichever side of the ring the fighter stands on.
    const circle = (this.down.has(this.map.depthAway) ? 1 : 0)
      - (this.down.has(this.map.depthToward) ? 1 : 0);
    const block = this.down.has(this.map.block);
    const intent = {
      move,
      side: circle,
      punch: this.punchQueued,
      kick: this.kickQueued,
      // Held flags keep a charge alive; the `|| queued` term guarantees a
      // sub-tick tap still reads as held for one update (then releases).
      punchHeld: this.down.has(this.map.punch) || this.punchQueued,
      kickHeld: this.down.has(this.map.kick) || this.kickQueued,
      block,
      // Always false for a human; published explicitly because `intent.super`
      // is read unguarded in _tickFighter.
      super: false,
    };
    this.punchQueued = false;
    this.kickQueued = false;
    return intent;
  }

  // An attack press.
  _pressAttack(name) {
    this[name + 'Queued'] = true;
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
  }
}

// ── Touch controls ───────────────────────────────────────────────────
// Docked along the bottom of the arena. Left cluster: walk in/out plus the two
// circle keys. Right cluster: block (hold), punch, kick (hold to charge). Each
// cluster stacks its small keys over its big ones, so the pad fits a 360px
// phone. The host
// gets .pb-has-pad so the page's bottom-docked chrome (training bar, caption,
// news package) can lift clear of it. Synthetic key events feed the normal
// input path, so the touch panel has no control semantics of its own —
// rebinding a key in LAYOUTS rebinds the button. Returns the panel; the caller
// removes it (and .pb-has-pad) on dispose.
export function buildTouchControls(container, online) {
  const K = LAYOUTS[1];
  const panel = document.createElement('div');
  panel.className = 'pb-touch';
  const mk = (code, label, name, small = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', name); // the glyphs alone read as "black left-pointing triangle"
    if (small) b.className = 'pb-touch-small';
    const down = (e) => {
      e.preventDefault();
      b.classList.add('pb-touch-held');
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      // Haptic tick on press, heavier for strikes. Skipped on kiosk/demo routes:
      // with no user gesture every call would emit a console error.
      try {
        const onKiosk = (location.search || '').indexOf('kiosk=') >= 0
          || /\/demo(\b|\/|$)/i.test(location.pathname || '');
        // The Profile haptics opt-out, not mute ("sound off, buzz on" is a real choice).
        if (!onKiosk && localStorage.getItem('pomini_haptics') !== '0' && navigator.vibrate) {
          navigator.vibrate((code === K.punch || code === K.kick) ? 16 : 8);
        }
      } catch { }
    };
    const up = () => {
      if (!b.classList.contains('pb-touch-held')) return;
      b.classList.remove('pb-touch-held');
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up); // finger slid off = release
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  };
  // Left cluster is the movement axis: walk in/out, and the two circle keys
  // beside them. All four are hold-to-act, matching the keyboard exactly —
  // these dispatch synthetic keydown/keyup for the very same codes.
  const cluster = (small, big) => {
    const c = document.createElement('div');
    c.className = 'pb-touch-cluster';
    const top = document.createElement('div');
    top.className = 'pb-touch-row pb-touch-row--small';
    top.append(...small);
    const bottom = document.createElement('div');
    bottom.className = 'pb-touch-row';
    bottom.append(...big);
    c.append(top, bottom);
    return c;
  };
  const left = cluster(
    [mk(K.depthAway, '↺', 'Circle counter-clockwise', true), mk(K.depthToward, '↻', 'Circle clockwise', true)],
    [mk(K.left, '◀', 'Move left'), mk(K.right, '▶', 'Move right')]);
  const guard = [mk(K.block, '🛡', 'Block (hold)', true)];
  // Online has a special (full energy); the local modes fire theirs by themselves.
  if (online) guard.push(mk('KeyH', '⚡', 'Special', true));
  const right = cluster(guard,
    [mk(K.punch, '👊', 'Punch (hold to charge)'), mk(K.kick, '🦵', 'Kick (hold to charge)')]);
  panel.append(left, right);
  container.appendChild(panel);
  container.classList.add('pb-has-pad');
  return panel;
}
