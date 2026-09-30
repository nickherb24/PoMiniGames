// spectacle.js — shockwave, comic-book KO panel, press bursts, victory pyro, house
// light kick, rematch rewind and result-screen shatter. Mixin (see mixin.js).
// Presentation only: never touches sim state, and uses Math.random, never the
// seeded match RNG, so demo replays and online lockstep are untouched.
// Flicker rule: nothing here changes whole-frame brightness.
import * as THREE from 'three';
import { pressBurst } from './arena.js';

const _proj = new THREE.Vector3();

const SHOCK_LIFE = 0.7;        // s, wall clock
const COMIC_HOLD = 0.55;       // s at full strength, then COMIC_FADE out
const COMIC_FADE = 0.3;
const COMIC_FREEZE = 0.25;     // s the KO frame stops dead before the slow-mo fall
const WORD_LIFE = 1.4;
const REWIND_SEC = 0.75;
const SHATTER_SEC = 1.3;
const PYRO_JET_SEC = 0.8;
const PYRO_SPARK_SEC = 2.2;

const WORDS = {
  punch: ['POW!', 'BAM!', 'KRAK!', 'SMACK!'],
  kick: ['WHAM!', 'BOOM!', 'THWACK!'],
  // A third of KOs get a word from the campaign trail instead.
  flavor: ['VETOED!', 'IMPEACHED!', 'LANDSLIDE!', 'RECOUNT!', 'OVERRULED!', 'CONCEDE!'],
};

const pick = (a) => a[(Math.random() * a.length) | 0];

class SpectacleMethods {
  _initSpectacle() {
    this._shock = { t: 99, amp: 0, cx: 0.5, cy: 0.5 };
    this._comicT = 0;
    this._comicFreeze = 0;
    this._rewindT = 0;
    this._pyroT = -1;
    this._pyroAcc = 0;
    this._rigKick = { x: 0, z: 0, vx: 0, vz: 0 };
    this._phoneLevel = 0;
    this._word = null;
    this._shatterPending = false;
    this._shatterEl = null;
  }

  // ── Shockwave ────────────────────────────────────────────────────────
  /** A refraction ring out of a world point: KO, super, a fully charged hit. */
  _shockwave(worldPos, amp = 1) {
    if (this._calm() || !this.camera || !worldPos) return;
    _proj.copy(worldPos).project(this.camera);
    if (_proj.z > 1) return;                      // behind the lens
    this._shock.cx = (_proj.x + 1) * 0.5;
    this._shock.cy = (_proj.y + 1) * 0.5;
    this._shock.t = 0;
    this._shock.amp = Math.min(1.2, amp);
  }

  // ── Comic-book KO ────────────────────────────────────────────────────
  /** The killing blow: freeze, print the frame as a comic panel, slam a word in. */
  _comicKO(point, attackName) {
    this._comicT = COMIC_HOLD + COMIC_FADE;
    // The KO branch of _tick ignores hitstopT, so park timeScale; _updateSpectacle restores slow-mo.
    this._comicFreeze = COMIC_FREEZE;
    this.timeScale = 0;
    const list = Math.random() < 0.33 ? WORDS.flavor
      : attackName === 'kick' ? WORDS.kick : WORDS.punch;
    this._spawnWord(pick(list), point);
  }

  _spawnWord(text, point) {
    this._disposeWord();
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.translate(256, 128);
    g.rotate(-0.08 + Math.random() * 0.06);
    g.beginPath();
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const r = i % 2 ? 78 : 118 + Math.random() * 14;
      g.lineTo(Math.cos(a) * r * 2, Math.sin(a) * r * 0.95);
    }
    g.closePath();
    g.fillStyle = '#ffd23f';
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = '#140d10';
    g.stroke();
    const size = text.length > 7 ? 64 : 88;
    g.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 16;
    g.strokeStyle = '#140d10';
    g.strokeText(text, 0, 4);
    g.fillStyle = '#e8262d';
    g.fillText(text, 0, 4);
    g.lineWidth = 3;
    g.strokeStyle = '#fff4d6';
    g.strokeText(text, -3, 1);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      toneMapped: false, fog: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(point.x, point.y + 0.5, point.z);
    s.renderOrder = 10;
    this.scene.add(s);
    this._word = { sprite: s, t: 0 };
  }

  _disposeWord() {
    if (!this._word) return;
    const s = this._word.sprite;
    s.parent?.remove(s);
    s.material.map?.dispose();
    s.material.dispose();
    this._word = null;
  }

  // ── Press row ────────────────────────────────────────────────────────
  _pressBurst(n) {
    if (!this.arena) return;
    pressBurst(this.arena, n);
    this.audio?.shutter(Math.min(6, Math.ceil(n * 0.6)));
  }

  // ── House light kick ─────────────────────────────────────────────────
  /** Knock the overhead light away from a world XZ point (bodyfall, crates, turnbuckle). */
  _kickRig(amount, x = 0, z = 0) {
    if (this._calm()) return;
    const d = Math.hypot(x, z);
    const nx = d > 0.1 ? x / d : Math.random() - 0.5;
    const nz = d > 0.1 ? z / d : Math.random() - 0.5;
    this._rigKick.vx += nx * amount * 1.2;
    this._rigKick.vz += nz * amount * 1.2;
  }

  // ── Pyro ─────────────────────────────────────────────────────────────
  _startPyro() {
    this._pyroT = 0;
    this._pyroAcc = 0;
    for (const post of this.arena?.posts || []) {
      this.audio?.pyro(post.userData.basePos || post.position);
    }
  }

  _tickPyro(dt) {
    if (this._pyroT < 0) return;
    this._pyroT += dt;
    if (this._pyroT > PYRO_SPARK_SEC) { this._pyroT = -1; return; }
    const jets = this._pyroT < PYRO_JET_SEC;
    // Rate-based so a 144 Hz display does not triple the particle count.
    this._pyroAcc += dt * (jets ? 110 : 50);
    let n = Math.floor(this._pyroAcc);
    this._pyroAcc -= n;
    const posts = this.arena?.posts || [];
    while (n-- > 0) {
      for (const post of posts) {
        const b = post.userData.basePos || post.position;
        const x = b.x, z = b.z, y = 1.6;
        if (jets) {
          // CO2 column: fat white puffs, straight up, braking hard.
          this._spawnParticle(x, y, z,
            (Math.random() - 0.5) * 0.8, 9 + Math.random() * 4, (Math.random() - 0.5) * 0.8,
            0x6f7885, 0.55 + Math.random() * 0.3, -2, 0.55 + Math.random() * 0.35, 3.2);
        }
        // Gold sparkler fountain: arcs inward over the ring and falls.
        this._spawnParticle(x, y, z,
          -x * 0.28 + (Math.random() - 0.5) * 1.6, 4 + Math.random() * 3, -z * 0.28 + (Math.random() - 0.5) * 1.6,
          Math.random() < 0.7 ? 0xffc04a : 0xfff3c4, 0.9 + Math.random() * 0.6, -9, 0.07, 0.4);
      }
    }
  }

  // ── Result shatter ───────────────────────────────────────────────────
  // Must run straight after composer.render() in the same task (no
  // preserveDrawingBuffer), which is why _presentResult only arms a flag.
  _shatterNow() {
    this._shatterPending = false;
    if (this._calm() || !this.renderer || !this.container) return;
    const host = this.container;
    const src = this.renderer.domElement;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const snap = document.createElement('canvas');
    snap.width = Math.round(w * dpr); snap.height = Math.round(h * dpr);
    snap.getContext('2d').drawImage(src, 0, 0, snap.width, snap.height);

    this._shatterEl?.remove();
    const cv = document.createElement('canvas');
    cv.className = 'pb-shatter';
    cv.width = snap.width; cv.height = snap.height;
    cv.setAttribute('aria-hidden', 'true');
    src.after(cv);   // over the 3D view, under the banner and the news desk
    this._shatterEl = cv;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;

    const loser = this.fighters?.find((f) => f.state === 'ko');
    let ox = W / 2, oy = H / 2;
    if (loser) {
      loser.rig.joints?.hips?.getWorldPosition(_proj) ?? _proj.copy(loser.rig.root.position);
      _proj.project(this.camera);
      if (_proj.z < 1) { ox = (_proj.x + 1) * 0.5 * W; oy = (1 - _proj.y) * 0.5 * H; }
    }

    // Radial + concentric cracks, like struck glass.
    const RAYS = 12, RINGS = 4, reach = Math.hypot(W, H);
    const pts = [];
    for (let r = 1; r <= RINGS; r++) {
      const row = [];
      for (let i = 0; i < RAYS; i++) {
        const a = (i + (r === RINGS ? 0 : (Math.random() - 0.5) * 0.4)) / RAYS * Math.PI * 2;
        const rad = r === RINGS ? reach : reach * Math.pow(r / RINGS, 1.6) * (0.8 + Math.random() * 0.4);
        row.push([ox + Math.cos(a) * rad, oy + Math.sin(a) * rad]);
      }
      pts.push(row);
    }
    const shards = [];
    const add = (tri) => {
      const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
      const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
      const dx = cx - ox, dy = cy - oy, d = Math.hypot(dx, dy) || 1;
      shards.push({
        tri, cx, cy,
        vx: (dx / d) * (120 + Math.random() * 260) * dpr,
        vy: ((dy / d) * 160 - 120 - Math.random() * 160) * dpr,
        va: (Math.random() - 0.5) * 4,
        delay: Math.min(0.25, d / reach * 0.35),
      });
    };
    for (let i = 0; i < RAYS; i++) {
      const j = (i + 1) % RAYS;
      add([[ox, oy], pts[0][i], pts[0][j]]);
      for (let r = 1; r < RINGS; r++) {
        add([pts[r - 1][i], pts[r][i], pts[r][j]]);
        add([pts[r - 1][i], pts[r][j], pts[r - 1][j]]);
      }
    }
    this.audio?.shatter();

    const t0 = performance.now();
    const G = 1800 * dpr;
    const frame = (now) => {
      if (this.disposed || this._shatterEl !== cv) return;
      const t = (now - t0) / 1000;
      if (t >= SHATTER_SEC) { cv.remove(); if (this._shatterEl === cv) this._shatterEl = null; return; }
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = `rgba(4,6,14,${0.55 * Math.max(0, 1 - t / 0.9)})`;
      ctx.fillRect(0, 0, W, H);
      for (const s of shards) {
        const k = Math.max(0, t - s.delay);
        ctx.save();
        ctx.translate(s.cx + s.vx * k, s.cy + s.vy * k + 0.5 * G * k * k);
        ctx.rotate(s.va * k);
        ctx.translate(-s.cx, -s.cy);
        ctx.beginPath();
        ctx.moveTo(s.tri[0][0], s.tri[0][1]);
        ctx.lineTo(s.tri[1][0], s.tri[1][1]);
        ctx.lineTo(s.tri[2][0], s.tri[2][1]);
        ctx.closePath();
        ctx.save();
        ctx.clip();
        ctx.drawImage(snap, 0, 0);
        ctx.restore();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = 'rgba(235,245,255,0.75)';
        ctx.stroke();
        ctx.restore();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ── Per-frame (wall clock, from _updateFx) ───────────────────────────
  _updateSpectacle(dt) {
    const u = this.fxPass?.uniforms;

    const sh = this._shock;
    let shock = 0;
    if (sh.amp > 0) {
      sh.t += dt;
      shock = sh.amp * Math.exp(-sh.t * 3.5) * Math.min(1, sh.t * 30);
      if (sh.t > SHOCK_LIFE) sh.amp = 0;
    }

    if (this._comicFreeze > 0) {
      this._comicFreeze -= dt;
      // Hand the slow-mo back only if the KO still owns the clock (a reset
      // inside the freeze has already set its own timeScale).
      if (this._comicFreeze <= 0 && this.phase === 'ko' && this.timeScale === 0) this.timeScale = 0.35;
    }
    let comic = 0;
    if (this._comicT > 0) {
      this._comicT = Math.max(0, this._comicT - dt);
      comic = Math.min(1, this._comicT / COMIC_FADE);
    }

    if (this._word) {
      const w = this._word;
      w.t += dt;
      const t = w.t;
      const pop = this._calm() ? 1 : t < 0.12 ? 0.3 + (t / 0.12) * 0.9 : t < 0.22 ? 1.2 - ((t - 0.12) / 0.1) * 0.2 : 1;
      w.sprite.scale.set(2.3 * pop, 1.15 * pop, 1);
      w.sprite.material.opacity = t < WORD_LIFE - 0.3 ? 1 : Math.max(0, (WORD_LIFE - t) / 0.3);
      if (t >= WORD_LIFE) this._disposeWord();
    }

    let rewind = 0;
    if (this._rewindT > 0) {
      this._rewindT = Math.max(0, this._rewindT - dt);
      const k = this._rewindT / REWIND_SEC;
      rewind = Math.min(1, k * 3);
    }

    // House-light pendulum, added onto the orbit in _updateLighting.
    const rk = this._rigKick;
    rk.vx += (-rk.x * 6 - rk.vx * 0.9) * dt;
    rk.vz += (-rk.z * 6 - rk.vz * 0.9) * dt;
    rk.x = THREE.MathUtils.clamp(rk.x + rk.vx * dt, -1, 1);
    rk.z = THREE.MathUtils.clamp(rk.z + rk.vz * dt, -1, 1);

    this._tickPyro(dt);

    if (u) {
      u.uShock.value = shock;
      u.uShockC.value[0] = sh.cx;
      u.uShockC.value[1] = sh.cy;
      u.uShockR.value = sh.t * 1.7;
      u.uComic.value = comic;
      u.uRewind.value = this._calm() ? 0 : rewind;
      const el = this.renderer?.domElement;
      if (el && el.height) {
        u.uAspect.value = el.width / el.height;
        u.uRes.value[0] = el.width;
        u.uRes.value[1] = el.height;
      }
    }
  }

  _clearSpectacle() {
    this._disposeWord();
    this._shatterEl?.remove();
    this._shatterEl = null;
    this._shatterPending = false;
    this._comicT = 0;
    this._comicFreeze = 0;
    this._pyroT = -1;
    this._shock.amp = 0;
  }
}

export const Spectacle = SpectacleMethods.prototype;
export { REWIND_SEC };
