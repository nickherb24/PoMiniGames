// picking.js — what the crosshair is pointing at. A ray from the camera
// through the screen centre against each creature's bounding sphere, nearest within 60 m.
// No three.js raycaster: at 400 creatures this is a few hundred dot products and it works
// on the interpolated frame data rather than on instanced geometry.
import { FRAME } from '../sim/frame.js';
import { SPECIES } from '../sim/creatures/species.js';

export const PICK = Object.freeze({
  maxDistance: 60,
  radiusPadding: 0.35,
  // Aim assist. A rabbit is a ~0.5 m sphere: at 30 m its angular size is under a degree,
  // which is unhittable with a mouse in a world where nothing stands still. The pick
  // radius therefore grows with distance (a cone), so the crosshair only has to be NEAR
  // the creature. The nearest candidate still wins, so precise aim always beats assist.
  assistRadians: 0.035,   // ≈2°, ~1 m of slack at 30 m
});

/**
 * @returns {{ index: number, handle: number, distance: number } | null}
 * `origin`/`dir` are the camera position and unit view direction; `view`/`handles` the
 * frame arrays; `count` the live creature count.
 */
export function pickCreature(origin, dir, view, handles, count, { padding = PICK.radiusPadding, maxDistance = PICK.maxDistance, assist = PICK.assistRadians } = {}) {
  let best = null;
  for (let k = 0; k < count; k++) {
    const o = k * FRAME.CREATURE_STRIDE;
    const sp = SPECIES[view[o + 5] | 0];
    const scale = (view[o + 4] || 1) * (view[o + 7] === 0 ? 0.55 : 1);
    const base = (sp?.radius ?? 0.4) * scale + padding;
    // Aim at the body centre, not the feet.
    const cx = view[o] - origin.x;
    const cy = view[o + 1] + 0.6 * scale - origin.y;
    const cz = view[o + 2] - origin.z;
    const along = cx * dir.x + cy * dir.y + cz * dir.z;
    if (along <= 0 || along > maxDistance) continue;
    const r = base + along * assist;
    const perp2 = (cx * cx + cy * cy + cz * cz) - along * along;
    if (perp2 > r * r) continue;
    if (!best || along < best.distance) best = { index: k, handle: handles[k], distance: along };
  }
  return best;
}
