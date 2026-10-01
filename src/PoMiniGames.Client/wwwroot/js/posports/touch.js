// touch.js — on-screen sequence pad for touch devices.
//
// Five buttons: the player's four sequence keys plus jump. Each tap dispatches a
// synthetic window keydown with the real key code, so the pad drives the exact
// same input paths a keyboard does — attachKeyboard (local) and the remote key
// forwarder (online) — with zero special-casing.
//
// Local 2P on one tablet gets two pads, one per bottom corner (`side`), each
// emitting its own layout's codes.
import { LAYOUTS, keyLabel } from './input.js';

/** True when the primary pointer is a finger. */
export function isTouchDevice() {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

export class TouchPad {
  /**
   * @param {HTMLElement} container the canvas host — the pad overlays its bottom edge
   * @param {1|2} layout which key layout to emit
   * @param {''|'left'|'right'} [side] corner to sit in when two pads share the screen
   */
  constructor(container, layout = 1, side = '') {
    const map = LAYOUTS[layout] ?? LAYOUTS[1];
    this.root = document.createElement('div');
    this.root.className = 'ps-touchpad' + (side ? ` ps-touchpad--${side}` : '');
    this.root.setAttribute('aria-label', 'Sequence keys');
    this.buttons = [];
    this.next = -1;

    for (const code of [...map.sequence, map.jump]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ps-touchpad-btn' + (code === map.jump ? ' ps-touchpad-btn--jump' : '');
      btn.textContent = code === map.jump ? 'JUMP' : keyLabel(code);
      // pointerdown, not click: a race is lost in the 300 ms a click can lag.
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
        btn.classList.add('ps-touchpad-btn--active');
        try { navigator.vibrate?.(6); } catch { /* unsupported */ }
      });
      // Release emits the matching keyup so the pad is a faithful keyboard stand-in.
      // PoSports itself only listens for keydown, but a synthetic press with no release
      // is a trap for any future listener that tracks held keys.
      const clear = () => {
        if (!btn.classList.contains('ps-touchpad-btn--active')) return;
        btn.classList.remove('ps-touchpad-btn--active');
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      };
      btn.addEventListener('pointerup', clear);
      btn.addEventListener('pointercancel', clear);
      btn.addEventListener('pointerleave', clear);
      this.root.appendChild(btn);
      this.buttons.push(btn);
    }
    container.appendChild(this.root);
  }

  /**
   * Ring the button the sequence expects next. On a touch screen the pad IS the key
   * display, so the canvas keycaps are not drawn and this replaces them.
   */
  setNext(index) {
    if (index === this.next) return;
    this.next = index;
    this.buttons.forEach((b, i) => {
      b.classList.toggle('ps-touchpad-btn--next', i === index);
      b.classList.toggle('ps-touchpad-btn--hit', i < index && i < 4);
    });
  }

  dispose() {
    this.root.remove();
  }
}
