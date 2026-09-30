// commentary.js — ringside commentary and captions.
//
// Captions: every line the PA speaks (countdown, "Fight!", "K O!", super names, the press
// conference, the commentary below) is also written into a caption bar at the foot of the
// arena. The wrap sits on AudioBus.announce itself, so no speaking call site can forget it —
// and it captions BEFORE the mute check, because a muted player is exactly who needs the text.
//
// Commentary: template lines on fight events — a long combo, a monster hit, a perfect guard,
// a counter, a fighter in the red, a comeback, the last ten seconds, a trip into the crates.
// Deliberately not a model call: it fires many times a fight, and the one AI line a fight gets
// is the pre-fight ring introduction (PoBrawlPage → /api/pobrawl/intro). Paced so it never talks
// over itself: one line at most every MIN_GAP seconds, a cooldown per kind, and nothing while
// the PA is mid-sentence (a "K O!" is never cut off by colour).

import { HEAVY_HIT_DMG } from './constants.js';

const MIN_GAP = 3.2;        // seconds between any two commentary lines
const KIND_COOLDOWN = 9;    // seconds before the same kind of line repeats
const CAPTION_SECS = 3.2;

const LINES = {
  combo: [
    '{A} is putting together a {N}-hit combination!',
    '{N} in a row from {A} — {B} cannot find the exit!',
    'That is a {N}-piece from {A}, and {B} is eating every bite!',
  ],
  big: [
    'What a shot from {A}!',
    'Oh, {B} felt that one in the cheap seats!',
    '{A} lands a haymaker — the whole hall heard it!',
  ],
  perfect: [
    'Perfect guard by {A}! Now make them pay!',
    '{A} read that like a morning briefing!',
    'Textbook timing from {A} — {B} is frozen!',
  ],
  counter: [
    'Counter! {A} makes {B} pay for that!',
    'And the counter punch lands for {A}!',
  ],
  danger: [
    '{A} is in serious trouble here!',
    '{A} is running on fumes!',
    'One more clean shot and {A} is done!',
  ],
  comeback: [
    'Would you look at this — {A} has turned it around!',
    '{A} takes the lead! What a comeback!',
  ],
  clock: [
    'Ten seconds left — somebody do something!',
    'Into the final ten seconds!',
  ],
  crate: [
    '{A} goes into the crates!',
    'Crates everywhere! {A} will be finding splinters for a week!',
  ],
};

class CommentaryMethods {
  _initCommentary() {
    this._cc = { lastAt: -99, kindAt: {}, clockSaid: false, danger: new Set(), leader: 0, deficitSeen: 0 };
    const el = document.createElement('div');
    el.className = 'pb-caption';
    // The page's live region already announces the milestones; this bar is for the eyes.
    el.setAttribute('aria-hidden', 'true');
    this.container.appendChild(el);
    this.captionEl = el;
    const speak = this.audio.announce.bind(this.audio);
    this.audio.announce = (text, opts) => {
      // A bare count ("3") is already the banner; caption words, not digits.
      if (text && String(text).trim().length > 1) this._caption(text);
      speak(text, opts);
    };
  }

  /** Show `text` in the caption bar for a few seconds. */
  _caption(text, secs = CAPTION_SECS) {
    const el = this.captionEl;
    if (!el || !text) return;
    el.textContent = String(text);
    el.classList.remove('pb-caption--on');
    void el.offsetWidth; // restart the fade-in
    el.classList.add('pb-caption--on');
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => el.classList.remove('pb-caption--on'), secs * 1000);
  }

  /** Say one line of `kind` about fighter `a` (and `b`), if the pacing allows. */
  _commentate(kind, a, b, n = 0) {
    const cc = this._cc;
    if (!cc || this.training || this.phase !== 'fighting' || !a) return false;
    const now = this.atmoT;
    if (now - cc.lastAt < MIN_GAP || now - (cc.kindAt[kind] ?? -99) < KIND_COOLDOWN) return false;
    if (this.audio?._speaking) return false;
    const pool = LINES[kind];
    if (!pool) return false;
    const name = (f) => (f?.rig?.config?.name || f?.charId || 'The fighter');
    const line = pool[Math.floor(this.rng.random() * pool.length)]
      .replaceAll('{A}', name(a)).replaceAll('{B}', name(b)).replaceAll('{N}', String(n));
    cc.lastAt = now;
    cc.kindAt[kind] = now;
    this.audio.announce(line, { rate: 1.08, pitch: 0.85, duckSec: 0.9 });
    return true;
  }

  /** From _registerLandedHit: combos and monster hits. */
  _commentOnHit(attacker, defender, dmg) {
    if (attacker.comboN >= 4 && this._commentate('combo', attacker, defender, attacker.comboN)) return;
    if (dmg >= HEAVY_HIT_DMG * 1.5) this._commentate('big', attacker, defender);
  }

  /** Once per sim tick while fighting: the red zone, the lead changing hands, the last ten seconds. */
  _tickCommentary() {
    const cc = this._cc;
    if (!cc || this.training || !this.fighters) return;
    const [f1, f2] = this.fighters;
    const h1 = this._hp(f1), h2 = this._hp(f2);
    for (const [f, h] of [[f1, h1], [f2, h2]]) {
      if (h > 0 && h <= 25 && !cc.danger.has(f.index) && this._commentate('danger', f)) cc.danger.add(f.index);
    }
    // A comeback: the leader changes after being down by 30 or more.
    const leader = h1 === h2 ? 0 : h1 > h2 ? 1 : 2;
    cc.deficitSeen = Math.max(cc.deficitSeen, Math.abs(h1 - h2));
    if (leader && cc.leader && leader !== cc.leader && cc.deficitSeen >= 30) {
      if (this._commentate('comeback', this.fighters[leader - 1])) cc.deficitSeen = 0;
    }
    if (leader) cc.leader = leader;
    if (!cc.clockSaid && this.clock >= 50 && this.clock < 58 && this._commentate('clock', f1)) cc.clockSaid = true;
  }

  /** A fresh round forgets the last one's story. */
  _resetCommentary() {
    if (!this._cc) return;
    this._cc.clockSaid = false;
    this._cc.danger.clear();
    this._cc.leader = 0;
    this._cc.deficitSeen = 0;
  }

  _disposeCommentary() {
    clearTimeout(this._captionTimer);
    this.captionEl?.remove();
    this.captionEl = null;
  }
}

export const Commentary = CommentaryMethods.prototype;
