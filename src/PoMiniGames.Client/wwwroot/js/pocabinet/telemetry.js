// pocabinet/telemetry.js
//
// Post-race telemetry. race.js records the local car every tick (race time,
// lap distance, speed, throttle, brake, steer); this module resamples each
// completed lap onto BINS equal slices of lap distance, so two laps line up
// by WHERE on the track, not when — which is what a delta trace needs.
//
//   lapTraces(rec)             → one trace per completed local lap
//   loadPbTrace / savePbTrace  → personal-best trace per track (localStorage)
//   renderTelemetry(canvas, current, reference) → draws speed / delta / pedals,
//                                returns a one-line text summary (the canvas's
//                                accessible description; the chart is visual).
//
// Colours come from the app's design tokens so the chart follows light/dark;
// only the semantic gain/loss green/red are fixed, matching the sector chips.

const BINS = 200;
const TRACE_KEY = 'pocabinet.traces.v1';

/**
 * Resample every completed lap of the local car.
 * @returns {Array<{ lap, time, speed: number[], thr: number[], brk: number[], t: number[] }>}
 */
export function lapTraces(rec) {
    if (!rec || !Array.isArray(rec.laps) || rec.local.dist.length < 2) return [];
    const L = rec.trackLength;
    return rec.laps.map(lap => {
        const speed = new Array(BINS).fill(NaN), thr = new Array(BINS).fill(NaN);
        const brk = new Array(BINS).fill(NaN), t = new Array(BINS).fill(NaN);
        const lapStartDist = (lap.lap - 1) * L;
        for (let i = 0; i < rec.t.length; i++) {
            const time = rec.t[i];
            if (time < lap.startT || time > lap.endT) continue;
            const frac = (rec.local.dist[i] - lapStartDist) / L;
            if (frac < 0 || frac >= 1) continue;
            const b = Math.floor(frac * BINS);
            if (Number.isNaN(t[b])) {
                t[b] = time - lap.startT;
                speed[b] = rec.local.kmh[i];
                thr[b] = rec.local.thr[i];
                brk[b] = rec.local.brk[i];
            }
        }
        fillGaps(t); fillGaps(speed); fillGaps(thr); fillGaps(brk);
        return { lap: lap.lap, time: lap.time, speed, thr, brk, t };
    }).filter(tr => tr.t.every(Number.isFinite));
}

function fillGaps(arr) {
    let last = NaN;
    for (let i = 0; i < arr.length; i++) {
        if (Number.isFinite(arr[i])) last = arr[i];
        else if (Number.isFinite(last)) arr[i] = last;
    }
    // Leading gap (first bin skipped at speed): back-fill from the first value.
    const first = arr.find(Number.isFinite);
    for (let i = 0; i < arr.length && !Number.isFinite(arr[i]); i++) arr[i] = first ?? 0;
}

/**
 * The numbers the post-race debrief is written from (the page posts them to
 * /api/pocabinet/debrief; the server writes every word). `reference` may be null.
 *   sectorDeltas   seconds vs the reference per third of the lap (+ = slower), or []
 *   worstPointPct  where on the lap the most time went vs the reference (-1 = none)
 *   fullThrottlePct / brakePct   share of the lap flat out / on the brakes
 *   topKmh / slowestKmh          ignoring the first few bins (a standing start)
 */
export function debriefFacts(current, reference) {
    if (!current) return null;
    const n = BINS, third = Math.floor(n / 3);
    const ends = tr => [tr.t[third], tr.t[third * 2], tr.time];
    let sectorDeltas = [], worstPointPct = -1;
    if (reference) {
        const c = ends(current), r = ends(reference);
        let pc = 0, pr = 0;
        for (let i = 0; i < 3; i++) {
            sectorDeltas.push(Math.round(((c[i] - pc) - (r[i] - pr)) * 100) / 100);
            pc = c[i]; pr = r[i];
        }
        // The steepest 10-bin growth of the running delta is where the lap was lost.
        let worst = 0;
        for (let i = 0; i + 10 < n; i++) {
            const loss = (current.t[i + 10] - reference.t[i + 10]) - (current.t[i] - reference.t[i]);
            if (loss > worst) { worst = loss; worstPointPct = Math.round((i + 5) / n * 100); }
        }
    }
    const pct = f => Math.round(current.thr.filter(f).length / n * 100);
    const moving = current.speed.slice(5);
    return {
        sectorDeltas,
        worstPointPct,
        fullThrottlePct: pct(v => v > 0.95),
        brakePct: Math.round(current.brk.filter(v => v > 0.05).length / n * 100),
        topKmh: Math.round(Math.max(...moving)),
        slowestKmh: Math.round(Math.min(...moving)),
    };
}

export function bestTrace(traces) {
    let best = null;
    for (const tr of traces) if (!best || tr.time < best.time) best = tr;
    return best;
}

export function loadPbTrace(trackId) {
    try {
        const raw = window.localStorage.getItem(TRACE_KEY);
        const all = raw ? JSON.parse(raw) : {};
        const tr = all && all[trackId];
        if (!tr || !Array.isArray(tr.t) || tr.t.length !== BINS) return null;
        return {
            lap: 0,
            time: Number(tr.time),
            t: tr.t.map(Number),
            speed: tr.speed.map(Number),
            thr: tr.thr.map(v => Number(v) / 100),
            brk: tr.brk.map(v => Number(v) / 100),
        };
    } catch {
        return null;
    }
}

/** Persist the trace when it beats the stored one. Returns true when saved. */
export function savePbTrace(trackId, trace) {
    if (!trace) return false;
    try {
        const raw = window.localStorage.getItem(TRACE_KEY);
        const all = raw ? JSON.parse(raw) : {};
        const prev = all[trackId];
        if (prev && Number(prev.time) > 0 && Number(prev.time) <= trace.time) return false;
        all[trackId] = {
            time: Math.round(trace.time * 1000) / 1000,
            t: trace.t.map(v => Math.round(v * 100) / 100),
            speed: trace.speed.map(v => Math.round(v)),
            thr: trace.thr.map(v => Math.round(v * 100)),
            brk: trace.brk.map(v => Math.round(v * 100)),
        };
        window.localStorage.setItem(TRACE_KEY, JSON.stringify(all));
        return true;
    } catch {
        return false;
    }
}

function token(name, fallback) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch {
        return fallback;
    }
}

function fmt(s) {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${r.toFixed(2).padStart(5, '0')}`;
}

/**
 * Draw the chart. `reference` may be null (first lap on this track): the speed
 * panel then shows the lap alone and the delta panel is omitted.
 * @returns {string} plain-language summary for the page's accessible description
 */
export function renderTelemetry(canvas, current, reference) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    if (!canvas || !current) return 'No completed lap to analyse.';
    const g = canvas.getContext('2d');
    if (!g) return 'Telemetry unavailable.';

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(260, canvas.clientWidth || 600);
    const cssH = Math.max(180, canvas.clientHeight || 240);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const text = token('--color-text-secondary', '#94a3b8');
    const grid = token('--color-border', 'rgba(148,163,184,0.25)');
    const accent = token('--color-accent-solid', '#6366f1');
    const gain = '#2ecc71', loss = '#e74c3c';

    const padL = 38, padR = 8, padT = 8;
    const w = cssW - padL - padR;
    const hasRef = !!reference;
    const speedH = cssH * (hasRef ? 0.52 : 0.72);
    const deltaH = hasRef ? cssH * 0.22 : 0;
    const pedalH = cssH * 0.16;
    const gap = 8;
    const speedTop = padT, deltaTop = speedTop + speedH + gap, pedalTop = deltaTop + deltaH + (hasRef ? gap : 0);
    const xAt = i => padL + (i / (BINS - 1)) * w;

    g.font = '11px system-ui, sans-serif';
    g.lineWidth = 1;

    // Sector dividers (the HUD's sectors are thirds of the lap).
    g.strokeStyle = grid;
    g.setLineDash([3, 3]);
    for (const f of [1 / 3, 2 / 3]) {
        g.beginPath();
        g.moveTo(padL + f * w, speedTop);
        g.lineTo(padL + f * w, pedalTop + pedalH);
        g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = text;
    ['S1', 'S2', 'S3'].forEach((s, i) => g.fillText(s, padL + (i / 3) * w + 4, speedTop + 11));

    // Speed panel.
    const all = current.speed.concat(hasRef ? reference.speed : []);
    const vMax = Math.max(60, ...all) * 1.05, vMin = Math.max(0, Math.min(...all) - 20);
    const yV = v => speedTop + speedH - ((v - vMin) / (vMax - vMin)) * speedH;
    g.fillText(`${Math.round(vMax)}`, 4, speedTop + 10);
    g.fillText(`${Math.round(vMin)}`, 4, speedTop + speedH);
    g.fillText('km/h', 4, speedTop + speedH / 2);
    const line = (arr, y, color, width, dash) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.setLineDash(dash || []);
        g.beginPath();
        arr.forEach((v, i) => (i === 0 ? g.moveTo(xAt(i), y(v)) : g.lineTo(xAt(i), y(v))));
        g.stroke();
        g.setLineDash([]);
    };
    if (hasRef) line(reference.speed, yV, text, 1.2, [4, 3]);
    line(current.speed, yV, accent, 2);

    // Delta panel: time gained (below zero, green) or lost (above, red) by distance.
    let summary;
    if (hasRef) {
        const delta = current.t.map((t, i) => t - reference.t[i]);
        const dMax = Math.max(0.25, ...delta.map(Math.abs));
        const yD = d => deltaTop + deltaH / 2 - (d / dMax) * (deltaH / 2);
        g.strokeStyle = grid;
        g.beginPath();
        g.moveTo(padL, yD(0));
        g.lineTo(padL + w, yD(0));
        g.stroke();
        g.fillStyle = text;
        g.fillText('Δ s', 4, deltaTop + deltaH / 2 + 4);
        for (let i = 1; i < BINS; i++) {
            g.strokeStyle = delta[i] <= 0 ? gain : loss;
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(xAt(i - 1), yD(delta[i - 1]));
            g.lineTo(xAt(i), yD(delta[i]));
            g.stroke();
        }
        const total = current.time - reference.time;
        const sectorAt = f => Math.min(BINS - 1, Math.floor(f * BINS));
        const s1 = delta[sectorAt(1 / 3)];
        const s2 = delta[sectorAt(2 / 3)] - s1;
        const s3 = total - s1 - s2;
        const sectors = [s1, s2, s3];
        const bestIdx = sectors.indexOf(Math.min(...sectors));
        const worstIdx = sectors.indexOf(Math.max(...sectors));
        const verdict = total < 0 ? `${Math.abs(total).toFixed(2)} s faster than` : `${total.toFixed(2)} s slower than`;
        summary = `Best lap ${fmt(current.time)}, ${verdict} your personal best ${fmt(reference.time)}. `
            + (sectors[bestIdx] < 0 ? `Biggest gain in sector ${bestIdx + 1} (${Math.abs(sectors[bestIdx]).toFixed(2)} s). ` : '')
            + (sectors[worstIdx] > 0 ? `Most time lost in sector ${worstIdx + 1} (${sectors[worstIdx].toFixed(2)} s).` : '');
    } else {
        summary = `Best lap ${fmt(current.time)}. It is now your reference lap on this track — race again to see where you gain and lose time.`;
    }

    // Pedals: throttle up, brake down, one strip.
    const mid = pedalTop + pedalH / 2;
    g.fillStyle = text;
    g.fillText('pedal', 4, mid + 4);
    for (let i = 0; i < BINS; i++) {
        const x = xAt(i), bw = Math.max(1, w / BINS);
        if (current.thr[i] > 0.02) {
            g.fillStyle = gain;
            g.fillRect(x, mid - current.thr[i] * (pedalH / 2), bw, current.thr[i] * (pedalH / 2));
        }
        if (current.brk[i] > 0.02) {
            g.fillStyle = loss;
            g.fillRect(x, mid, bw, current.brk[i] * (pedalH / 2));
        }
    }
    return summary.trim();
}
