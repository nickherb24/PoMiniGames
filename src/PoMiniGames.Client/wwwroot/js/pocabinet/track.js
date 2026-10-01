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
const HALF_PI = Math.PI / 2;

// ── Trig the sim can rely on ────────────────────────────────────────────────
// sin, cos and atan2 built from + − × ÷, floor and sqrt only, which IEEE 754 pins to the
// last bit, so Chrome, Firefox, node and .NET all get the SAME double. Math.sin and
// friends are not pinned: Chrome and node differed by one ulp sixteen ticks into a race,
// and a 100-car field is chaotic enough to turn that into a different race by the first
// corner, which the lap verifier then times as a crash. Everything that feeds the
// simulation (physics.js, the curvature table below) uses these; rendering may use Math.
// MIRRORED: PoCabinetTrack.Sin / Cos / Atan2, same operations in the same order.

/** sin(a + quarter·π/2): reduce to within π/4 of a multiple of π/2, then the Taylor series. */
function sinShifted(a, quarter) {
    const k = Math.floor(a / HALF_PI + 0.5);
    const r = a - k * HALF_PI;
    const r2 = r * r;
    const q = (((k + quarter) % 4) + 4) % 4;
    if (q === 0 || q === 2) {
        const s = r * (1 - r2 / 6 * (1 - r2 / 20 * (1 - r2 / 42 * (1 - r2 / 72 * (1 - r2 / 110 * (1 - r2 / 156 * (1 - r2 / 210)))))));
        return q === 0 ? s : -s;
    }
    const c = 1 - r2 / 2 * (1 - r2 / 12 * (1 - r2 / 30 * (1 - r2 / 56 * (1 - r2 / 90 * (1 - r2 / 132 * (1 - r2 / 182 * (1 - r2 / 240)))))));
    return q === 1 ? c : -c;
}

export function sin(a) { return sinShifted(a, 0); }
export function cos(a) { return sinShifted(a, 1); }

/** atan z for |z| ≤ 1: halve the angle three times (atan z = 2·atan(z / (1 + √(1 + z²)))), then the series. */
function atanUnit(z) {
    let t = z / (1 + Math.sqrt(1 + z * z));
    t = t / (1 + Math.sqrt(1 + t * t));
    t = t / (1 + Math.sqrt(1 + t * t));
    const t2 = t * t;
    return 8 * t * (1 - t2 * (1 / 3 - t2 * (1 / 5 - t2 * (1 / 7 - t2 * (1 / 9 - t2 * (1 / 11 - t2 * (1 / 13 - t2 / 15)))))));
}

export function atan2(y, x) {
    const ax = Math.abs(x), ay = Math.abs(y);
    if (ax >= ay) {
        if (ax === 0) return 0;
        const a = atanUnit(y / x);
        return x > 0 ? a : y >= 0 ? a + Math.PI : a - Math.PI;
    }
    const a = atanUnit(x / y);
    return y > 0 ? HALF_PI - a : -HALF_PI - a;
}

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
        const d = wrapAngle(atan2(ty[i], tx[i]) - atan2(ty[p], tx[p]));
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

        // Point-to-point (world.finishIndex > 0, the Playground run): the lap ends at that
        // centerline sample instead of back at the line, and a finished car rolls on into the
        // run-out and parks half way down it instead of taking a cool-down lap. The loop still
        // closes — through a return link nobody drives — so every wrap in here keeps working.
        // MIRRORED: PoCabinetTrack.LapLength / CoolDownAt.
        const finish = Number(world?.finishIndex) || 0;
        this.hiddenFrom = Number(world?.hiddenFrom) || 0;
        this.hiddenTo = Number(world?.hiddenTo) || 0;
        this.pointToPoint = finish > 0 && finish < this.count;
        this.lapLength = this.pointToPoint ? cum[finish] : length;
        this.parkAt = this.pointToPoint ? (cum[finish] + cum[this.hiddenFrom]) / 2 : 0;

        // Render-only (no physics reads these): road height per sample in sim units, the
        // road's cross slope (tan of the bank, + = right side higher), the stretch of the
        // loop that is not drawn (the return link), and where the tarmac starts — before it
        // the scene lays an open chute in place of the model's gutter.
        const perSample = (a) => Array.isArray(a) && a.length === this.count ? Float64Array.from(a, Number) : null;
        this.z = perSample(world?.centerZ);
        this.bank = perSample(world?.centerBank);
        this.roadFrom = Number(world?.roadFrom) || 0;
    }

    /** Share of its top speed a finished car at race distance `distance` holds. Mirrors PoCabinetTrack.CoolDownAt. */
    coolDownAt(distance) {
        return this.parked(distance) ? 0 : 0.6;
    }

    /**
     * True once a car has rolled to the parking point of a point-to-point track's run-out
     * (never on a circuit). A parked car is out of the race for good: it no longer collides
     * and the AI no longer sees it, or the first two dozen finishers would fill the run-out
     * and everyone behind would queue back over the finish line. Mirrors PoCabinetTrack.Parked.
     */
    parked(distance) {
        return this.pointToPoint && distance >= this.parkAt;
    }

    /** False for the segments from sample `i` that belong to the undrawn return link. */
    drawn(i) {
        return !(i >= this.hiddenFrom && i < this.hiddenTo);
    }

    /** True where the scene lays tarmac (everywhere, unless the track starts on a chute: see roadFrom). */
    built(i) {
        return this.drawn(i) && (this.roadFrom <= 0 || (i >= this.roadFrom && i < this.hiddenFrom));
    }

    /** Cross slope (tan of the bank) at a distance along the loop; 0 on an unbanked track. */
    bankAt(distance) {
        if (!this.bank) return 0;
        const i = this.indexAt(distance);
        const f = this.segLen[i] > 1e-9 ? (this.wrap(distance) - this.cum[i]) / this.segLen[i] : 0;
        const a = this.bank[i], b = this.bank[(i + 1) % this.count];
        return a + (b - a) * f;
    }

    /** Road height (sim units) at a distance along the loop; 0 on a flat track. */
    heightAt(distance) {
        if (!this.z) return 0;
        const i = this.indexAt(distance);
        const f = this.segLen[i] > 1e-9 ? (this.wrap(distance) - this.cum[i]) / this.segLen[i] : 0;
        const a = this.z[i], b = this.z[(i + 1) % this.count];
        return a + (b - a) * f;
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
