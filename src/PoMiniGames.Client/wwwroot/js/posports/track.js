// track.js — Canvas 2D renderer for the PoSports meet: sky, stadium, the lanes,
// meter marks, hurdles, finish tape, podium, and a leader-following camera. Pure
// drawing — it reads lane state, never mutates it.
import { CONSTANTS, HURDLE_POSITIONS } from './physics.js';

export const PX_PER_METER = 28;
/** Extra meters of track shown behind the start / past the finish. */
const APRON_METERS = 6;
/** Camera smoothing: fraction of the gap closed per second. */
const CAM_LERP = 4;

const LANE_COLORS = ['#b5533c', '#c05e43', '#b5533c', '#c05e43'];
/** Crowd shirt colours; one is picked per seat from a position hash, so the stand is stable across frames. */
const CROWD_COLORS = ['#e9c46a', '#e76f51', '#8ecae6', '#f1faee', '#b5e48c', '#c77dff', '#ffafcc'];
const STAND_TILE = 360;   // px: the stands repeat on this period
const TOWER_TILE = 420;   // px: one floodlight tower per period

const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

export class TrackRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{night?: boolean}} [opts] an evening meet: dark sky, lit towers
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.night = !!opts.night;
    this.cameraX = -APRON_METERS; // meters at the left screen edge
    this.dpr = 1;
    this.zoom = 1;                 // photo-finish push-in, eased by the game
    this.shake = 0;                // px of shake left, decays in drawScene
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
  }

  resize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    // audit #8: shared resolution policy — see js/canvasDpr.js. This also picks
    // up the backing-store budget, which a bare min(dpr, 2) did not have.
    this.dpr = window.PoCanvasDpr ? window.PoCanvasDpr.resolve(rect.width, rect.height) : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.buildBackdrop();
  }

  /**
   * Pre-render everything that depends only on the view size: the sky, one period
   * of the stands and one floodlight tower. Per frame they cost a handful of
   * drawImage calls; the parallax is a source/destination offset, not a redraw.
   */
  buildBackdrop() {
    const w = this.viewW; const h = this.viewH;
    if (w === 0 || h === 0) return;
    const night = this.night;

    const make = (width, height, paint) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(width * this.dpr));
      c.height = Math.max(1, Math.round(height * this.dpr));
      const cx = c.getContext('2d');
      cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      paint(cx);
      return c;
    };

    const skyH = h * 0.22;
    this._sky = make(w, skyH, (cx) => {
      const sky = cx.createLinearGradient(0, 0, 0, skyH);
      if (night) { sky.addColorStop(0, '#070b1c'); sky.addColorStop(1, '#1d2a4d'); }
      else { sky.addColorStop(0, '#5fb4ea'); sky.addColorStop(1, '#d5edfb'); }
      cx.fillStyle = sky;
      cx.fillRect(0, 0, w, skyH);
      if (night) {
        cx.fillStyle = '#fff';
        for (let i = 0; i < 70; i++) {
          cx.globalAlpha = 0.25 + hash(i + 3) * 0.6;
          cx.fillRect(hash(i) * w, hash(i + 91) * skyH * 0.55, 1.2, 1.2);
        }
        cx.globalAlpha = 1;
      }
    });

    // The stand: a roof, then four stepped rows of spectators.
    const standH = h * 0.135;
    this._standH = standH;
    this._stand = make(STAND_TILE, standH + 8, (cx) => {
      cx.translate(0, 8); // headroom so the wave can lift a row without clipping
      cx.fillStyle = night ? '#232c44' : '#55708f';
      cx.fillRect(0, 0, STAND_TILE, standH);
      cx.fillStyle = night ? '#141a2c' : '#3d5470';
      cx.fillRect(0, 0, STAND_TILE, standH * 0.14);
      for (let x = 0; x < STAND_TILE; x += 60) cx.fillRect(x, 0, 3, standH); // roof stanchions
      const rows = 4;
      for (let r = 0; r < rows; r++) {
        const y = standH * (0.3 + r * 0.175);
        const size = 2.6 + r * 0.55;
        cx.fillStyle = night ? '#1a2238' : '#465f7c';
        cx.fillRect(0, y + size * 1.2, STAND_TILE, 2); // the step they sit on
        for (let x = 6 + (r % 2) * 6; x < STAND_TILE; x += 12) {
          const seat = r * 97 + x;
          if (hash(seat + 0.5) < 0.12) continue; // empty seat
          cx.fillStyle = CROWD_COLORS[(hash(seat) * CROWD_COLORS.length) | 0];
          cx.globalAlpha = night ? 0.75 : 1;
          cx.fillRect(x - size * 0.8, y, size * 1.6, size * 1.5);              // shirt
          cx.fillStyle = ['#f2c9a0', '#d9a070', '#8d5a3b'][(hash(seat + 7) * 3) | 0];
          cx.beginPath(); cx.arc(x, y - size * 0.35, size * 0.75, 0, Math.PI * 2); cx.fill(); // head
        }
      }
      cx.globalAlpha = 1;
    });

    // One floodlight tower. At night its lamp head glows; by day it is a silhouette.
    const towerH = h * 0.2;
    this._tower = make(120, towerH, (cx) => {
      const x = 60;
      if (night) {
        const g = cx.createRadialGradient(x, towerH * 0.12, 2, x, towerH * 0.12, 58);
        g.addColorStop(0, 'rgba(255,250,220,0.95)');
        g.addColorStop(0.25, 'rgba(255,244,190,0.35)');
        g.addColorStop(1, 'rgba(255,244,190,0)');
        cx.fillStyle = g;
        cx.fillRect(0, 0, 120, towerH);
      }
      cx.fillStyle = night ? '#0b1020' : '#6d8298';
      cx.fillRect(x - 1.5, towerH * 0.12, 3, towerH);
      cx.fillRect(x - 13, towerH * 0.06, 26, towerH * 0.1);
      cx.fillStyle = night ? '#fffbe0' : '#e8eef4';
      for (let i = 0; i < 4; i++) cx.fillRect(x - 11 + i * 6, towerH * 0.075, 4, towerH * 0.07);
    });
  }

  /** Logical (CSS px) view size. */
  get viewW() { return this.canvas.width / this.dpr; }
  get viewH() { return this.canvas.height / this.dpr; }

  /** meters → screen x. */
  toX(m) { return (m - this.cameraX) * PX_PER_METER; }

  /** The y of a lane's ground line. Lanes stack from 26% down to the bottom apron. */
  laneY(lane, laneCount) {
    const top = this.viewH * 0.26;
    const bottom = this.viewH * 0.94;
    return top + ((lane + 1) / laneCount) * (bottom - top);
  }

  /** Sprite height for a lane row — nearer (lower) lanes draw slightly larger. */
  spriteHeight(lane, laneCount) {
    return this.viewH * (0.325 + 0.052 * (lane / Math.max(1, laneCount - 1)));
  }

  /** Follow the leading runner, keeping ~35% of the view behind the leader. */
  updateCamera(dt, lanes, legLength) {
    const leader = Math.max(0, ...lanes.map((l) => l.position));
    const target = Math.max(-APRON_METERS,
      Math.min(leader - (this.viewW * 0.35) / PX_PER_METER,
        legLength + APRON_METERS - this.viewW / PX_PER_METER));
    const k = 1 - Math.exp(-CAM_LERP * dt);
    this.cameraX += (target - this.cameraX) * k;
  }

  /**
   * Draw the full scene background + track for the current leg.
   * @param {'sprint'|'hurdles'} leg
   * @param {number} laneCount
   * @param {{legLength?: number, hurdles?: number[], knocked?: Array<Map<number, number>>,
   *          tape?: {broken: boolean, age: number}, waveX?: number, focusX?: number,
   *          pit?: {from: number, to: number}}} [extra]
   *   knocked[lane] maps hurdle index → seconds since it was clipped (it topples);
   *   waveX is the screen x the crowd is rising around; focusX is where a zoom pushes in.
   */
  drawScene(leg, laneCount, extra = {}) {
    const { ctx } = this;
    const w = this.viewW; const h = this.viewH;

    // Zoom about the action and shake, as one transform over the whole scene.
    this.shake *= 0.86;
    if (this.shake < 0.3) this.shake = 0;
    const z = this.zoom;
    const fx = extra.focusX ?? w * 0.5;
    const fy = h * 0.6;
    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z,
      this.dpr * (fx * (1 - z) + sx), this.dpr * (fy * (1 - z) + sy));

    if (!this._sky) this.buildBackdrop();
    if (this._sky) ctx.drawImage(this._sky, 0, 0, w, h * 0.22);

    // Floodlight towers behind the stand (slow parallax).
    if (this._tower) {
      const th = h * 0.2;
      const off = ((this.cameraX * PX_PER_METER * 0.18) % TOWER_TILE + TOWER_TILE) % TOWER_TILE;
      for (let x = -off - 60; x < w + 60; x += TOWER_TILE) ctx.drawImage(this._tower, x, h * 0.005, 120, th);
    }

    // The stand, tiled; the section nearest the leader is on its feet.
    if (this._stand) {
      const sh = this._standH + 8;
      const top = h * 0.085 - 8;
      const off = ((this.cameraX * PX_PER_METER * 0.4) % STAND_TILE + STAND_TILE) % STAND_TILE;
      for (let x = -off; x < w; x += STAND_TILE) ctx.drawImage(this._stand, x, top, STAND_TILE, sh);
      if (extra.waveX !== undefined) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(extra.waveX - 90, top, 180, sh);
        ctx.clip();
        for (let x = -off; x < w; x += STAND_TILE) ctx.drawImage(this._stand, x, top - 5, STAND_TILE, sh);
        ctx.restore();
      }
    }

    // Track bed.
    ctx.fillStyle = this.night ? '#7a3828' : '#a04a35';
    ctx.fillRect(-20, h * 0.22, w + 40, h * 0.78 + 20);

    const legLength = extra.legLength ?? (leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH);

    // Hoardings along the back straight (track-fixed, so they scroll with the lanes).
    const boards = ['PO SPORTS', 'FAMILY MEET', `${legLength} M`, 'GO GO GO'];
    for (let m = -6; m <= legLength + 12; m += 12) {
      const x = this.toX(m);
      if (x < -340 || x > w + 10) continue;
      const i = ((m / 12) % boards.length + boards.length) % boards.length | 0;
      ctx.fillStyle = ['#1d3557', '#2a9d8f', '#e76f51', '#6d597a'][i];
      ctx.fillRect(x, h * 0.222, 12 * PX_PER_METER - 6, h * 0.036);
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.font = `700 ${Math.max(9, h * 0.022)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(boards[i], x + (12 * PX_PER_METER - 6) / 2, h * 0.222 + h * 0.027);
    }

    // Lane bands + lines.
    for (let i = 0; i < laneCount; i++) {
      const yTop = this.laneY(i - 1, laneCount);
      const yBot = this.laneY(i, laneCount);
      ctx.fillStyle = LANE_COLORS[i % LANE_COLORS.length];
      if (this.night) ctx.fillStyle = i % 2 ? '#93442f' : '#8a3d2a';
      ctx.fillRect(-20, yTop, w + 40, yBot - yTop);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-20, yBot);
      ctx.lineTo(w + 20, yBot);
      ctx.stroke();
    }

    // A landing pit (long jump): sand between two marks, across every lane.
    if (extra.pit) {
      const x0 = this.toX(extra.pit.from), x1 = this.toX(extra.pit.to);
      ctx.fillStyle = '#e3c98a';
      ctx.fillRect(x0, h * 0.262, x1 - x0, h * 0.678);
      ctx.fillStyle = 'rgba(160,120,60,0.25)';
      for (let i = 0; i < 60; i++) ctx.fillRect(x0 + hash(i) * (x1 - x0), h * 0.27 + hash(i + 40) * h * 0.66, 2, 1);
    }

    // Meter marks every 10 m + start/finish.
    ctx.textAlign = 'center';
    ctx.font = `${Math.max(10, h * 0.02)}px system-ui, sans-serif`;
    for (let m = 0; m <= legLength; m += 10) {
      const x = this.toX(m);
      if (x < -40 || x > w + 40) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = m === 0 || m === legLength ? 4 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.262);
      ctx.lineTo(x, h * 0.94);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(`${m}`, x, h * 0.955 + Math.max(10, h * 0.02));
    }

    // Finish: chequered line on the ground, and a tape until someone breaks it.
    const fxl = this.toX(legLength);
    if (extra.tape !== null && fxl > -20 && fxl < w + 20) {
      for (let y = h * 0.262, i = 0; y < h * 0.94; y += 6, i++) {
        ctx.fillStyle = i % 2 ? '#222' : '#fff';
        ctx.fillRect(fxl - 3, y, 6, 6);
      }
      const tape = extra.tape;
      if (tape && !tape.broken) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(fxl, h * 0.33);
        ctx.lineTo(fxl, h * 0.9);
        ctx.stroke();
      } else if (tape && tape.age < 1.2) {
        // Two halves whip away from the break.
        ctx.strokeStyle = `rgba(255,255,255,${1 - tape.age / 1.2})`;
        ctx.lineWidth = 3;
        const fly = tape.age * 90;
        ctx.beginPath();
        ctx.moveTo(fxl, h * 0.33);
        ctx.quadraticCurveTo(fxl + fly, h * 0.45, fxl + fly * 1.4, h * 0.42 + tape.age * 40);
        ctx.moveTo(fxl, h * 0.9);
        ctx.quadraticCurveTo(fxl + fly, h * 0.8, fxl + fly * 1.4, h * 0.86 + tape.age * 30);
        ctx.stroke();
      }
    }

    // Hurdles. A clipped one topples forward over ~0.35 s and stays down.
    const hurdles = extra.hurdles ?? (leg === 'hurdles' ? HURDLE_POSITIONS : []);
    hurdles.forEach((hm, hi) => {
      const x = this.toX(hm);
      if (x < -30 || x > w + 30) return;
      for (let i = 0; i < laneCount; i++) {
        const y = this.laneY(i, laneCount);
        const hh = this.spriteHeight(i, laneCount) * 0.42;
        const since = extra.knocked?.[i]?.get(hi);
        const tilt = since === undefined ? 0 : Math.min(1, since / 0.35) * 1.45;
        ctx.save();
        ctx.translate(x + 9, y);      // pivot on the leading foot
        ctx.rotate(tilt);
        ctx.strokeStyle = '#f5f5f5';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-14, 0);
        ctx.lineTo(-11, -hh);
        ctx.lineTo(-3, -hh);
        ctx.lineTo(0, 0);
        ctx.stroke();
        ctx.strokeStyle = since === undefined ? '#d9d9d9' : '#ffb4a2';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-11, -hh);
        ctx.lineTo(-3, -hh);
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  /** A soft contact shadow under a runner; it shrinks and fades as they leave the ground. */
  drawShadow(x, y, height, lift) {
    const { ctx } = this;
    const k = 1 - Math.min(1, lift / (height * 0.5)) * 0.55;
    ctx.fillStyle = `rgba(0,0,0,${0.3 * k})`;
    ctx.beginPath();
    // The sheets carry ~11% of empty frame under the feet, so the shadow sits that far up.
    ctx.ellipse(x, y - height * 0.115, height * 0.15 * k, height * 0.032 * k, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Streaks trailing a runner at full tilt. */
  drawSpeedLines(x, y, height, amount, t) {
    const { ctx } = this;
    ctx.strokeStyle = `rgba(255,255,255,${0.35 * amount})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const yy = y - height * (0.2 + 0.18 * i);
      const len = height * (0.25 + 0.3 * hash(i + Math.floor(t * 14)));
      const x0 = x - height * 0.22 - hash(i * 3 + Math.floor(t * 9)) * 14;
      ctx.moveTo(x0, yy);
      ctx.lineTo(x0 - len, yy);
    }
    ctx.stroke();
  }

  /**
   * The player's keys, floating over their own runner: typed ones go green, the
   * next one is ringed. Eyes stay on the race instead of a strip above it.
   */
  drawKeycaps(x, y, labels, progress, jumpLabel, alpha = 1) {
    const { ctx } = this;
    const s = Math.max(15, this.viewH * 0.034);
    const gap = 3;
    const total = labels.length * (s + gap) + s * 0.5 + s * 1.5;
    let cx = x - total / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${s * 0.6}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cap = (label, w, fill, stroke) => {
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(cx, y - s, w, s, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, cx + w / 2, y - s / 2 + 1);
      cx += w + gap;
    };
    labels.forEach((l, i) => cap(l, s,
      i < progress ? '#2f9e44' : 'rgba(15,20,32,0.72)',
      i === progress ? '#ffd166' : 'rgba(255,255,255,0.3)'));
    cx += s * 0.5;
    cap(jumpLabel, s * 1.5, 'rgba(15,20,32,0.72)', 'rgba(255,209,102,0.6)');
    ctx.restore();
  }

  /** Reset to screen space (after drawScene's zoom/shake transform) for overlays. */
  screenSpace() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Stadium light: a soft wash by day, hard pools from the towers at night. */
  drawLighting() {
    const { ctx } = this;
    const w = this.viewW; const h = this.viewH;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    if (this.night) {
      g.addColorStop(0, 'rgba(255, 250, 215, 0.10)');
      g.addColorStop(0.3, 'rgba(10, 16, 40, 0.10)');
      g.addColorStop(1, 'rgba(5, 8, 24, 0.42)');
    } else {
      g.addColorStop(0, 'rgba(255, 255, 230, 0.12)');
      g.addColorStop(0.35, 'rgba(255, 255, 255, 0.04)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0.08)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (this.night) {
      const off = ((this.cameraX * PX_PER_METER * 0.18) % TOWER_TILE + TOWER_TILE) % TOWER_TILE;
      for (let x = -off; x < w + 200; x += TOWER_TILE) {
        const pool = ctx.createRadialGradient(x, h * 0.62, 10, x, h * 0.62, h * 0.55);
        pool.addColorStop(0, 'rgba(255,246,205,0.16)');
        pool.addColorStop(1, 'rgba(255,246,205,0)');
        ctx.fillStyle = pool;
        ctx.fillRect(x - h * 0.6, 0, h * 1.2, h);
      }
    }
  }

  /**
   * The three podium blocks, centred. Returns where each placing stands
   * ({x, y} of the block top), so the game can put the runners on them.
   */
  drawPodium(rise) {
    const { ctx } = this;
    const w = this.viewW; const h = this.viewH;
    const bw = Math.min(w * 0.16, 150);
    const base = h * 0.9;
    const heights = [h * 0.2, h * 0.14, h * 0.1]; // 1st, 2nd, 3rd
    const xs = [w / 2, w / 2 - bw, w / 2 + bw];
    const spots = [];
    ctx.fillStyle = 'rgba(6, 10, 22, 0.55)';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 3; i++) {
      const bh = heights[i] * rise;
      ctx.fillStyle = ['#ffd166', '#cfd8e3', '#d99a6c'][i];
      ctx.fillRect(xs[i] - bw / 2, base - bh, bw, bh);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(xs[i] - bw / 2, base - bh, bw, 6);
      ctx.fillStyle = 'rgba(20,24,34,0.85)';
      ctx.font = `800 ${Math.max(16, heights[i] * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      if (rise > 0.6) ctx.fillText(`${i + 1}`, xs[i], base - bh * 0.25);
      spots.push({ x: xs[i], y: base - bh });
    }
    spots.push({ x: w / 2 + bw * 2.1, y: base }); // 4th stands beside the blocks
    return spots;
  }
}
