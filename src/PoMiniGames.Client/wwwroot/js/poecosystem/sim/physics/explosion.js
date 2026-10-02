// explosion.js — radial impulse ∝ 1/r (lightning / eruption).

/** Impulse magnitude at distance d from the centre; 0 beyond the radius, capped near 0. */
export function explosionImpulse(d, radius, strength) {
  if (d >= radius) return 0;
  return strength / Math.max(d, 0.5);
}

/** Apply the impulse to every dynamic body in `bodies` (a lift component keeps it visual). */
export function applyExplosion(CANNON, bodies, { x, y, z, radius, strength }) {
  const dir = new CANNON.Vec3();
  let hit = 0;
  for (const body of bodies) {
    if (body.mass === 0 || body.type !== CANNON.Body.DYNAMIC) continue;
    dir.set(body.position.x - x, body.position.y - y, body.position.z - z);
    const d = dir.length();
    const mag = explosionImpulse(d, radius, strength);
    if (mag === 0) continue;
    if (d < 1e-6) dir.set(0, 1, 0); else dir.scale(1 / d, dir);
    dir.y += 0.6;
    dir.normalize();
    body.wakeUp();
    body.applyImpulse(dir.scale(mag * body.mass), body.position);
    hit++;
  }
  return hit;
}
