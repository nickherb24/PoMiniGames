// matWear.js — the ring canvas remembers the fight.
//
// Two small 2D canvases painted in world XZ and sampled by the ring-mat shader
// (game.js _initReactiveArena injects the lookup next to the knockdown ripple):
//
//   wear — permanent for the match: footwork scuffs where fighters plant and pivot,
//          skid streaks where a heavy hit shoves someone across the vinyl, and a
//          scrape where a body lands. RGBA, composited over the mat's albedo.
//   wet  — sweat that dries: droplets flung off a rocked head darken the vinyl
//          and lower its roughness, then evaporate over ~20 s. Alpha only.
//
// Blood is NOT painted here: it has its own stain meshes (vfx.js _addBloodStain),
// gated on the no-gore switch.
//
// Painting is a few canvas arcs per event; the upload is throttled to 5 Hz and
// skipped when nothing changed, so a quiet ring costs nothing at all.

import * as THREE from 'three';

const SIZE = 512;
const UPLOAD_EVERY = 0.2;  // s
const DRY_EVERY = 0.5;     // s between evaporation passes
const DRY_ALPHA = 0.035;   // fraction of remaining wetness removed per pass

export class MatWear {
  /** @param {number} half half-width of the mat in metres (world XZ ±half) */
  constructor(half) {
    this.half = half;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const g = c.getContext('2d');
      const tex = new THREE.CanvasTexture(c);
      // Data, not colour: the wet mask must not be gamma-decoded, and the wear
      // layer is authored as the linear tint it multiplies in.
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = false;
      // Row 0 is world -Z, and the shader samples v = z/(2·half) + 0.5 — no flip.
      tex.flipY = false;
      tex.minFilter = THREE.LinearFilter;
      return { c, g, tex, dirty: false };
    };
    this.wear = mk();
    this.wet = mk();
    this._uploadT = 0;
    this._dryT = 0;
    this._wetLive = false;
  }

  // World XZ → canvas pixels (row 0 = world -Z; see flipY above).
  _px(x, z) {
    return [(x / this.half * 0.5 + 0.5) * SIZE, (z / this.half * 0.5 + 0.5) * SIZE];
  }

  _m(metres) { return metres / (this.half * 2) * SIZE; }

  /** A planted foot: a short rubber smudge along the direction of travel. */
  scuff(x, z, angle, strength = 1) {
    const [px, py] = this._px(x, z);
    const g = this.wear.g;
    g.save();
    g.translate(px, py);
    g.rotate(angle);
    g.fillStyle = `rgba(22, 20, 26, ${0.05 + 0.06 * Math.min(1, strength)})`;
    g.beginPath();
    g.ellipse(0, 0, this._m(0.13), this._m(0.05), 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
    this.wear.dirty = true;
  }

  /** A shoe dragged across the vinyl by knockback. */
  skid(x0, z0, x1, z1, strength = 1) {
    const [ax, ay] = this._px(x0, z0);
    const [bx, by] = this._px(x1, z1);
    const g = this.wear.g;
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = `rgba(16, 14, 20, ${0.10 + 0.12 * Math.min(1, strength)})`;
    g.lineWidth = this._m(0.07);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
    // A pale scrape line down the middle: vinyl scuffed back to the lighter base.
    g.strokeStyle = `rgba(200, 196, 210, ${0.05 * Math.min(1, strength)})`;
    g.lineWidth = this._m(0.018);
    g.stroke();
    g.restore();
    this.wear.dirty = true;
  }

  /** A body hitting the mat: a broad soft scrape. */
  bodyfall(x, z, strength = 1) {
    const [px, py] = this._px(x, z);
    const g = this.wear.g;
    const r = this._m(0.55);
    const grad = g.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0, `rgba(18, 16, 24, ${0.22 * Math.min(1, strength)})`);
    grad.addColorStop(1, 'rgba(18, 16, 24, 0)');
    g.fillStyle = grad;
    g.fillRect(px - r, py - r, r * 2, r * 2);
    this.wear.dirty = true;
    this.sweat(x, z, 0.5, 6);
  }

  /** Sweat spray landing around (x, z). */
  sweat(x, z, spread = 0.45, drops = 7) {
    const g = this.wet.g;
    for (let i = 0; i < drops; i++) {
      const [px, py] = this._px(x + (Math.random() - 0.5) * spread * 2, z + (Math.random() - 0.5) * spread * 2);
      g.fillStyle = `rgba(255, 255, 255, ${0.35 + Math.random() * 0.4})`;
      g.beginPath();
      g.arc(px, py, this._m(0.015 + Math.random() * 0.035), 0, Math.PI * 2);
      g.fill();
    }
    this.wet.dirty = true;
    this._wetLive = true;
    this._wetIdle = 0;
  }

  update(dt) {
    this._dryT += dt;
    if (this._wetLive && this._dryT >= DRY_EVERY) {
      this._dryT = 0;
      const g = this.wet.g;
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = `rgba(0, 0, 0, ${DRY_ALPHA})`;
      g.fillRect(0, 0, SIZE, SIZE);
      g.restore();
      this.wet.dirty = true;
      // destination-out never quite reaches zero on 8-bit alpha, so stop paying
      // for the pass (and the uploads) once enough time has passed with no new sweat.
      this._wetIdle = (this._wetIdle || 0) + DRY_EVERY;
      if (this._wetIdle > 40) this._wetLive = false;
    }
    this._uploadT += dt;
    if (this._uploadT < UPLOAD_EVERY) return;
    this._uploadT = 0;
    for (const l of [this.wear, this.wet]) {
      if (!l.dirty) continue;
      l.dirty = false;
      l.tex.needsUpdate = true;
    }
  }

  /** New match, clean mat. */
  clear() {
    for (const l of [this.wear, this.wet]) {
      l.g.clearRect(0, 0, SIZE, SIZE);
      l.tex.needsUpdate = true;
      l.dirty = false;
    }
    this._wetLive = false;
    this._wetIdle = 0;
  }

  dispose() {
    this.wear.tex.dispose();
    this.wet.tex.dispose();
  }
}
