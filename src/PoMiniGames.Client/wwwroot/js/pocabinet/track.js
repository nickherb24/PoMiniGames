// pocabinet/track.js
//
// Runtime track: arc-length tables, projection and curvature over the centerline
// the page hands us (PoCabinetTrackGeometry.BuildStaticWorld — the ONE source of
// track geometry; client and server resample the same knots).
//
// MIRROR CONTRACT: this is a line-for-line port of
// src/PoMiniGames.API/Features/PoCabinet/PoCabinetTrack.cs. Multiplayer prediction
// runs this projection against the server's; change the search window, the
// smoothing or the sample step on one side and predicted cars drift on the other.

const CURVATURE_SAMPLE_STEP = 8;

/** Signed angle normalised to (-π, π]. Same operation order as the C# WrapAngle. */
export function wrapAngle(a) {
    a %= 2 * Math.PI;
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a <= -Math.PI) a += 2 * Math.PI;
    return a;
}

/**
 * Build a track from the static world ({ centerXY: number[], trackWidth, trackId }).
 * centerXY is flat [x0, y0, x1, y1, …] in sim units.
 */
export function buildTrack(world) {
    const xy = Array.isArray(world?.centerXY) ? world.centerXY : [];
    const count = Math.floor(xy.length / 2);
    if (count < 3) throw new Error('pocabinet/track: centerline is required');

    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        x[i] = Number(xy[i * 2]);
        y[i] = Number(xy[i * 2 + 1]);
    }

    const segLen = new Float64Array(count);
    const cum = new Float64Array(count + 1);
    const tx = new Float64Array(count);
    const ty = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const dx = x[j] - x[i], dy = y[j] - y[i];
        const len = Math.sqrt(dx * dx + dy * dy);
        segLen[i] = len;
        cum[i + 1] = cum[i] + len;
        tx[i] = len > 1e-9 ? dx / len : 1;
        ty[i] = len > 1e-9 ? dy / len : 0;
    }
    const length = cum[count];

    const raw = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const p = (i - 1 + count) % count;
        const d = wrapAngle(Math.atan2(ty[i], tx[i]) - Math.atan2(ty[p], tx[p]));
        const span = Math.max(1e-6, (segLen[p] + segLen[i]) * 0.5);
        raw[i] = Math.abs(d) / span;
    }
    const curv = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        curv[i] = (raw[(i - 1 + count) % count] + raw[i] + raw[(i + 1) % count]) / 3.0;
    }

    return new Track(world, x, y, segLen, cum, tx, ty, curv, length, Number(world.trackWidth) * 0.5);
}

class Track {
    constructor(world, x, y, segLen, cum, tx, ty, curv, length, halfWidth) {
        this.id = String(world?.trackId || 'capitol');
        this.x = x; this.y = y;
        this.segLen = segLen; this.cum = cum;
        this.tx = tx; this.ty = ty; this.curv = curv;
        this.count = x.length;
        this.length = length;
        this.halfWidth = halfWidth;
    }

    /** Closest centerline point. Returns { index, along, lateral, tx, ty } (lateral + = right). */
    project(px, py, hint) {
        let best = -1, bestD2 = Number.MAX_VALUE, bestT = 0;
        const consider = (i) => {
            const len = this.segLen[i];
            let t = len > 1e-9 ? ((px - this.x[i]) * this.tx[i] + (py - this.y[i]) * this.ty[i]) / len : 0;
            t = Math.min(1, Math.max(0, t));
            const qx = this.x[i] + this.tx[i] * t * len;
            const qy = this.y[i] + this.ty[i] * t * len;
            const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
            if (d2 < bestD2) { bestD2 = d2; best = i; bestT = t; }
        };
        if (hint >= 0 && hint < this.count) {
            for (let k = -6; k <= 10; k++) {
                consider((((hint + k) % this.count) + this.count) % this.count);
            }
            const limit = this.halfWidth * 3;
            if (bestD2 > limit * limit) best = -1;
        }
        if (best < 0) {
            bestD2 = Number.MAX_VALUE;
            for (let i = 0; i < this.count; i++) consider(i);
        }
        const qx = this.x[best] + this.tx[best] * bestT * this.segLen[best];
        const qy = this.y[best] + this.ty[best] * bestT * this.segLen[best];
        const lateral = (px - qx) * -this.ty[best] + (py - qy) * this.tx[best];
        return {
            index: best,
            along: this.cum[best] + bestT * this.segLen[best],
            lateral,
            tx: this.tx[best],
            ty: this.ty[best],
        };
    }

    /** Point at a distance along the loop: { x, y, tx, ty }. */
    pointAt(distance) {
        const i = this.indexAt(distance);
        const d = this.wrap(distance) - this.cum[i];
        return { x: this.x[i] + this.tx[i] * d, y: this.y[i] + this.ty[i] * d, tx: this.tx[i], ty: this.ty[i] };
    }

    /** Tightest smoothed curvature between two distances. */
    maxCurvature(fromDistance, toDistance) {
        let max = 0;
        for (let d = fromDistance; d <= toDistance; d += CURVATURE_SAMPLE_STEP) {
            const c = this.curv[this.indexAt(d)];
            if (c > max) max = c;
        }
        return max;
    }

    indexAt(distance) {
        const d = this.wrap(distance);
        let lo = 0, hi = this.count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.cum[mid] <= d) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Smoothed curvature at a point index — the racing-line overlay colours by it. */
    curvatureAt(index) {
        return this.curv[index] || 0;
    }

    wrap(distance) {
        const d = distance % this.length;
        return d < 0 ? d + this.length : d;
    }
}
