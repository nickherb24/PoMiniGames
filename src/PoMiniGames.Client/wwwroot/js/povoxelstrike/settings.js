// settings.js — the player's Voxel Strike preferences, kept in localStorage.
//
// Four of them, and only four: look speed, invert-Y, field of view and the graphics tier.
// The tier used to be reachable only through ?gfx= on the URL; that flag still wins (it is
// how a pass is A/B'd), and 'auto' here means "let quality.js decide".

const KEY = 'pvs:settings';
const TIERS = ['auto', 'low', 'medium', 'high', 'ultra'];

function clean(s) {
  const num = (v, lo, hi, fallback) =>
    (v !== null && v !== '' && Number.isFinite(+v)) ? Math.min(hi, Math.max(lo, +v)) : fallback;
  return {
    sens: num(s?.sens, 0.3, 2.5, 1),
    invertY: !!s?.invertY,
    fov: num(s?.fov, 55, 100, 70),
    gfx: TIERS.includes(s?.gfx) ? s.gfx : 'auto',
  };
}

/** Never throws: private mode or a corrupt entry reads as the defaults. */
export function loadSettings() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return clean({}); }
}

/** Clamps, persists (best effort) and returns what was actually stored. */
export function saveSettings(settings) {
  const s = clean(settings);
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* blocked storage: live for this run only */ }
  return s;
}
