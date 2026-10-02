// pocabinet/kerbs.js
//
// Apex kerbs: which centerline points carry a red/white kerb, and on which side.
// Pure function of the track, so the scene (mesh) and race.js (the "am I on it"
// test that drives the buzz, shake and rumble) derive the same map independently.
//
// Kerbs are FEEL, not physics: nothing here reaches physics.js or the C# mirror.
// Running over one changes no grip and no speed, online or off.
//
// Side convention matches track.project: +1 = right of travel. A right-hander
// (heading increasing — steer +1) has its apex on the right, so the kerb goes there.

import { wrapAngle } from './track.js';

/** How far the kerb reaches onto the tarmac, and out past the edge line (sim units). */
export const KERB_INNER = 5;
export const KERB_OUTER = 12;

/**
 * Smoothed curvature (rad per sim unit) above which a point counts as a corner:
 * a radius of ~220 sim units, about two road widths. Measured on the three tracks
 * this kerbs roughly the tightest fifth of each lap. A corner-speed
 * cutoff kerbed a single bend on Capitol, whose corners are nearly flat out.
 */
const KERB_CURVATURE = 0.0045;
/** Keep the start line, gantry and grid clean: spline kinks there are not corners. */
const START_CLEAR_AHEAD = 70;
const START_CLEAR_BEHIND = 140;
const DILATE = 3;
const MIN_RUN = 5;

/** Int8Array, one entry per centerline point: 0 = no kerb, ±1 = kerb side. */
export function computeKerbs(track) {
    const n = track.count;
    const raw = new Int8Array(n);
    for (let i = 0; i < n; i++) {
        if (track.curvatureAt(i) <= KERB_CURVATURE) continue;
        const p = (i - 1 + n) % n;
        const turn = wrapAngle(Math.atan2(track.ty[i], track.tx[i]) - Math.atan2(track.ty[p], track.tx[p]));
        raw[i] = turn > 0 ? 1 : -1;
    }
    // Grow each corner a few points either way so the kerb runs into and out of the apex.
    const side = new Int8Array(n);
    for (let i = 0; i < n; i++) {
        if (!raw[i]) continue;
        for (let k = -DILATE; k <= DILATE; k++) {
            const j = ((i + k) % n + n) % n;
            if (!side[j]) side[j] = raw[i];
        }
    }
    for (let i = 0; i < n; i++) {
        const d = track.cum[i];
        if (d < START_CLEAR_AHEAD || d > track.length - START_CLEAR_BEHIND || !track.drawn(i)) side[i] = 0;
    }
    // Drop slivers: a run shorter than MIN_RUN reads as a glitch, not a kerb.
    let i = 0;
    while (i < n) {
        if (!side[i]) { i++; continue; }
        let j = i;
        while (j < n && side[j] === side[i]) j++;
        if (j - i < MIN_RUN && !(i === 0 || j === n)) side.fill(0, i, j);
        i = j;
    }
    return side;
}

/** True when a car at centerline index `index` with signed `lateral` sits on a kerb. */
export function onKerb(kerbs, track, index, lateral) {
    if (!kerbs || index < 0 || index >= kerbs.length) return false;
    const s = kerbs[index];
    if (!s) return false;
    const l = lateral * s;
    return l > track.halfWidth - KERB_INNER && l < track.halfWidth + KERB_OUTER;
}
