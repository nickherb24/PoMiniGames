// minimap.js — a 2D canvas map: the island's biomes drawn once, then species dots, huts,
// fire and the player's arrow on top each frame. Cheap enough to redraw at render rate.
//
// DATA LAYERS. One optional overlay between the ground and the dots: a small
// grid of values (deaths, kills, sick-seconds from the sim's heat book; grazing pressure
// from the tile sync; foot traffic from trails.js) drawn as a heat ramp. The grid is
// painted into its own tiny canvas when it arrives and scaled up with the browser's own
// filtering each frame, so a layer costs one drawImage.
import { TILE, TILE_STATE } from '../sim/terrain/tiles.js';
import { FRAME } from '../sim/frame.js';

export const BIOME = {
  [TILE.OCEAN]: '#0c4a6e', [TILE.BEACH]: '#d8c48f', [TILE.GRASS]: '#4e7f2f', [TILE.FOREST]: '#1f5c2a',
  [TILE.HILL]: '#6b7a4a', [TILE.MOUNTAIN]: '#7a736b', [TILE.LAKE]: '#0ea5e9', [TILE.VOLCANO]: '#44403c',
};
const SPECIES_DOT = ['#fbbf24', '#34d399', '#f87171', '#c7d2fe'];

const STATE_HEX = {
  [TILE_STATE.FIRE]: '#f97316', [TILE_STATE.LAVA]: '#ef4444',
  [TILE_STATE.BURNT]: '#2a2724', [TILE_STATE.HUT]: '#e2e8f0',
  [TILE_STATE.CAMPFIRE]: '#fb923c', [TILE_STATE.FENCE]: '#a16207', [TILE_STATE.FIELD]: '#a3e635', [TILE_STATE.TOWER]: '#f8fafc',
};
export const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

// One ramp per layer: [cool rgb, hot rgb]. Alpha follows the value, so empty ground stays
// the map it was.
// `curve` is the exponent the normalised value is raised to: the three event layers are
// sparse counts, so a square root keeps one death on a quiet hillside visible beside a
// watering hole that has seen forty; the two continuous fields read better nearly linear.
const LAYER_RAMP = {
  deaths: { lo: [239, 68, 68], hi: [254, 226, 226], curve: 0.5 },
  predation: { lo: [249, 115, 22], hi: [254, 240, 138], curve: 0.5 },
  sickness: { lo: [192, 38, 211], hi: [250, 232, 255], curve: 0.5 },
  grazing: { lo: [161, 98, 7], hi: [254, 240, 138], curve: 1.4 },
  traffic: { lo: [8, 145, 178], hi: [236, 254, 255], curve: 0.85 },
};
export const MAP_LAYERS = Object.freeze(Object.keys(LAYER_RAMP));

export function createMinimap(canvas, terrain) {
  const size = terrain.size;
  const base = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const bctx = base.getContext('2d');
  const ctx = canvas.getContext('2d');

  // Palettes and the image buffer are built once: parsing 120 000 hex substrings per
  // repaint cost ~4 ms of the main thread every second.
  const biomePalette = new Uint8Array(8 * 3);
  for (let t = 0; t < 8; t++) biomePalette.set(rgb(BIOME[t] ?? '#555555'), t * 3);
  const statePalette = new Uint8Array(16 * 3).fill(0);
  const stateHas = new Uint8Array(16);
  for (const [state, hex] of Object.entries(STATE_HEX)) { statePalette.set(rgb(hex), state * 3); stateHas[state] = 1; }
  const img = bctx.createImageData(size, size);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;   // opaque, once

  function paintBase(tileState) {
    const data = img.data;
    for (let i = 0; i < size * size; i++) {
      const state = tileState?.[i] ?? 0;
      const src = stateHas[state] ? statePalette : biomePalette;
      const s = (stateHas[state] ? state : terrain.type[i]) * 3;
      const o = i * 4;
      data[o] = src[s]; data[o + 1] = src[s + 1]; data[o + 2] = src[s + 2];
    }
    bctx.putImageData(img, 0, 0);
  }
  paintBase(null);

  let layer = null;   // a small canvas holding the current overlay, or null

  return {
    setTiles: (msg) => paintBase(msg.tileState),
    /**
     * Show a data layer: `values` is a side × side grid (any numeric array), normalised here
     * against its own peak. Pass a null name (or no values) to clear it.
     */
    setLayer(name, values, side) {
      const ramp = LAYER_RAMP[name];
      if (!ramp || !values || !side) { layer = null; return; }
      let peak = 0;
      for (let i = 0; i < values.length; i++) if (values[i] > peak) peak = values[i];
      const c = layer && layer.width === side ? layer : Object.assign(document.createElement('canvas'), { width: side, height: side });
      const lctx = c.getContext('2d');
      const out = lctx.createImageData(side, side);
      const { lo, hi, curve } = ramp;
      for (let i = 0; i < side * side; i++) {
        const v = peak > 0 && values[i] > 0 ? Math.pow(values[i] / peak, curve) : 0;
        const o = i * 4;
        out.data[o] = lo[0] + (hi[0] - lo[0]) * v;
        out.data[o + 1] = lo[1] + (hi[1] - lo[1]) * v;
        out.data[o + 2] = lo[2] + (hi[2] - lo[2]) * v;
        out.data[o + 3] = v <= 0.02 ? 0 : 110 + v * 145;
      }
      lctx.putImageData(out, 0, 0);
      layer = c;
    },
    get hasLayer() { return !!layer; },
    draw(view, count, player) {
      const w = canvas.width; const h = canvas.height;
      const s = w / size;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(base, 0, 0, w, h);
      if (layer) {
        // Dim the ground a little so the ramp reads against forest and beach alike.
        ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(layer, 0, 0, w, h);
      }
      for (let k = 0; k < count; k++) {
        const o = k * FRAME.CREATURE_STRIDE;
        ctx.fillStyle = SPECIES_DOT[view[o + 5] | 0] ?? '#ffffff';
        ctx.fillRect(view[o] * s - 1, view[o + 2] * s - 1, layer ? 1.5 : 2.5, layer ? 1.5 : 2.5);
      }
      // Player marker: a big white triangle pointing along the view direction, large enough
      // not to be lost among the species dots.
      const px = player.x * s; const pz = player.z * s;
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(-player.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(6.5, 7.5); ctx.lineTo(0, 3.5); ctx.lineTo(-6.5, 7.5);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },
    dispose() {},
  };
}
