/** Shortest-arc angle interpolation. Plain lerp spins a car the long way round
 *  whenever its heading crosses ±π, which is once per lap on most corners. */
function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
}

/**
 * Build the car array for a point in time between two snapshots.
 * Identity is by array index, checked against the car id: the server sends a stable
 * ordering, and searching for each car on every frame would allocate.
 */
function interpolate(a, b, t) {
    const out = new Array(b.cars.length);
    for (let i = 0; i < b.cars.length; i++) {
        const cb = b.cars[i];
        const ca = a && a.cars[i] && a.cars[i].id === cb.id ? a.cars[i] : cb;
        out[i] = {
            ...cb,
            x: ca.x + (cb.x - ca.x) * t,
            y: ca.y + (cb.y - ca.y) * t,
            h: lerpAngle(ca.h, cb.h, t),
            v: ca.v + (cb.v - ca.v) * t,
            boost: (ca.boost || 0) + ((cb.boost || 0) - (ca.boost || 0)) * t,
            skid: (ca.skid || 0) + ((cb.skid || 0) - (ca.skid || 0)) * t,
            // Shedding more than ~30 units/s² between two snapshots: the brake lights are on.
            braking: cb.v < ca.v - 1.5 && cb.v > 8,
        };
    }
    return out;
}

/**
 * Car positions at server-clock instant `ts`.
 *
 * Every branch returns a value that is CONTINUOUS with its neighbours: clamped
 * to the oldest sample when we are behind the buffer, interpolated inside it,
 * and briefly extrapolated past the newest. The bug this replaced broke exactly
 * that property — its "behind the buffer" branch returned the NEWEST sample, so
 * falling off the back of the buffer teleported every car forward.
 */
export function sampleAt(buf, ts) {
    const n = buf.length;
    if (n === 0) return null;
    if (n === 1) return buf[0].cars;

    if (ts <= buf[0].st) return buf[0].cars;

    const last = buf[n - 1];
    if (ts >= last.st) {
        // Past the newest snapshot — a packet is late, or this is the local car, which is
        // sampled ahead on purpose. Extrapolate along the last known trajectory, but only
        // briefly: beyond about one interval the guess diverges badly on corners, and a car
        // that visibly drives through a wall and snaps back is worse than one that pauses.
        const before = buf[n - 2];
        const span = last.st - before.st;
        if (span <= 0) return last.cars;
        return interpolate(before, last, 1 + Math.min(ts - last.st, 60) / span);
    }

    for (let i = n - 1; i > 0; i--) {
        const a = buf[i - 1], b = buf[i];
        if (ts >= a.st) return interpolate(a, b, (ts - a.st) / (b.st - a.st));
    }
    return buf[0].cars;
}
