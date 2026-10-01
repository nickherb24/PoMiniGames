// pocabinet/minimap.js
//
// Track minimap for PoCabinet — a small 2D canvas overlay in the race HUD.
// The track outline is drawn once (cached to an offscreen canvas); each
// snapshot update only clears, blits the cached path and stamps car markers,
// so 30 Hz redraws stay cheap even at 8 cars.
//
// Data sources:
//   • world — the static world the scene mounts against (centerXY, flat
//     [x0, y0, ...] in sim units, from PoCabinetTrackGeometry). A bare point
//     array ([x, y] or {X, Y}) is still accepted.
//   • cars — rows from race.js (x, y, isPlayer = the local car, color,
//     officialId, finished), pushed ~15 Hz.
//
// Accessibility: the canvas is aria-hidden (decorative); the HUD position
// readout remains the accessible source of truth. When colorSafe is on, the
// markers use the Okabe-Ito colorblind-safe palette in a fixed per-official
// order so hue alone is never the only signal.

const MARGIN = 14;           // px padding around the track path
const OKABE_ITO = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'];
const OFFICIAL_ORDER = ['sean-s', 'steve-b', 'bill-b', 'mike-p', 'player'];

function pointOf(p) {
    if (Array.isArray(p)) return { x: Number(p[0]) || 0, y: Number(p[1]) || 0 };
    return { x: Number(p?.X) || 0, y: Number(p?.Y) || 0 };
}

class MinimapHandle {
    constructor(canvas, centerline, opts) {
        this.canvas = canvas;
        this.ctx2d = canvas.getContext('2d');
        this.colorSafe = !!(opts && opts.colorSafe);
        this.accent = (opts && opts.accent) || '#d4af37';
        // Point-to-point: the centerline handed in is start → finish, not a loop.
        this.open = !!(opts && opts.open);
        this.disposed = false;

        // Bounds in server units.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of centerline) {
            const { x, y } = pointOf(p);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
        this.minX = minX; this.minY = minY;
        const spanX = Math.max(1, maxX - minX);
        const spanY = Math.max(1, maxY - minY);

        // Fit the path into the canvas box preserving aspect.
        const cssW = Math.max(80, canvas.clientWidth || 170);
        const cssH = Math.max(60, canvas.clientHeight || 120);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        const pad = MARGIN * dpr;
        const scale = Math.min((canvas.width - pad * 2) / spanX, (canvas.height - pad * 2) / spanY);
        this.scale = scale;
        this.offX = (canvas.width - spanX * scale) / 2;
        this.offY = (canvas.height - spanY * scale) / 2;

        // Pre-render the track path once.
        this.trackLayer = document.createElement('canvas');
        this.trackLayer.width = canvas.width;
        this.trackLayer.height = canvas.height;
        const tctx = this.trackLayer.getContext('2d');
        this.tracePath(tctx, centerline);
        tctx.lineWidth = Math.max(3, 5 * dpr);
        tctx.strokeStyle = 'rgba(0,0,0,0.55)';
        tctx.stroke();
        tctx.lineWidth = Math.max(1.5, 2.5 * dpr);
        tctx.strokeStyle = this.accent;
        tctx.stroke();

        // Sector ticks + start line at path fractions 0, 1/3, 2/3.
        this.sectorPoints = [0, 1 / 3, 2 / 3].map(f => this.pointAtFraction(centerline, f));
        tctx.setLineDash([]);
        for (let i = 0; i < this.sectorPoints.length; i++) {
            const pt = this.sectorPoints[i];
            const { x, y } = this.toCanvas(pt.x, pt.y);
            tctx.beginPath();
            tctx.fillStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.6)';
            tctx.arc(x, y, (i === 0 ? 3.4 : 2.2) * dpr, 0, Math.PI * 2);
            tctx.fill();
        }
    }

    toCanvas(x, y) {
        return { x: this.offX + (x - this.minX) * this.scale, y: this.offY + (y - this.minY) * this.scale };
    }

    tracePath(ctx2d, centerline) {
        ctx2d.beginPath();
        for (let i = 0; i < centerline.length; i++) {
            const { x, y } = pointOf(centerline[i]);
            const c = this.toCanvas(x, y);
            if (i === 0) ctx2d.moveTo(c.x, c.y);
            else ctx2d.lineTo(c.x, c.y);
        }
        if (!this.open) ctx2d.closePath();
    }

    /** Walk the polyline (closed, unless open) and return the point at fraction f (0..1) of total length. */
    pointAtFraction(centerline, f) {
        const pts = centerline.map(pointOf);
        let total = 0;
        const segLens = [];
        for (let i = 0; i < pts.length - (this.open ? 1 : 0); i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            segLens.push(len);
            total += len;
        }
        let target = Math.min(1, Math.max(0, f)) * total;
        for (let i = 0; i < pts.length; i++) {
            if (i < segLens.length && target <= segLens[i]) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                const t = segLens[i] > 0 ? target / segLens[i] : 0;
                return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            }
            target -= segLens[i];
        }
        return pts[0];
    }

    markerColor(car, index) {
        if (this.colorSafe) {
            const order = OFFICIAL_ORDER.indexOf(car.officialId);
            return OKABE_ITO[(order >= 0 ? order : index) % OKABE_ITO.length];
        }
        return car.color || '#cccccc';
    }

    update(cars) {
        if (this.disposed || !this.ctx2d || !Array.isArray(cars)) return;
        const ctx2d = this.ctx2d;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx2d.drawImage(this.trackLayer, 0, 0);

        const rows = cars.filter(c => c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y)));
        // Player drawn last (on top).
        rows.sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0));
        for (let i = 0; i < rows.length; i++) {
            const car = rows[i];
            const { x, y } = this.toCanvas(Number(car.x), Number(car.y));
            ctx2d.beginPath();
            ctx2d.globalAlpha = car.finished ? 0.45 : 1;
            ctx2d.fillStyle = this.markerColor(car, i);
            // A 100-car field gets smaller rival dots, or the pack is one blob.
            ctx2d.arc(x, y, (car.isPlayer ? 4.6 : rows.length > 20 ? 2.2 : 3.4) * dpr, 0, Math.PI * 2);
            ctx2d.fill();
            if (car.isPlayer) {
                ctx2d.lineWidth = 1.6 * dpr;
                ctx2d.strokeStyle = '#ffffff';
                ctx2d.stroke();
            }
        }
        ctx2d.globalAlpha = 1;
    }

    dispose() {
        this.disposed = true;
        this.trackLayer = null;
        this.ctx2d = null;
    }
}

/**
 * Mount a minimap onto a canvas element.
 * @param {HTMLCanvasElement|string} canvas the element or its DOM id
 * @param {{centerXY:number[]}|Array<[number,number]|{X:number,Y:number}>} worldOrCenterline
 * @param {{ accent?: string, colorSafe?: boolean }} opts
 */
export function mountMinimap(canvas, worldOrCenterline, opts) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    if (!canvas) throw new Error('pocabinet/minimap: canvas element is required');
    let centerline = worldOrCenterline;
    if (worldOrCenterline && Array.isArray(worldOrCenterline.centerXY)) {
        const xy = worldOrCenterline.centerXY;
        // A point-to-point track shows the run itself, not the return link behind it.
        const finish = Number(worldOrCenterline.finishIndex) || 0;
        const end = finish > 0 ? Math.min(xy.length, (finish + 1) * 2) : xy.length;
        centerline = [];
        for (let i = 0; i + 1 < end; i += 2) centerline.push([xy[i], xy[i + 1]]);
        if (finish > 0) opts = { ...(opts || {}), open: true };
    }
    if (!Array.isArray(centerline) || centerline.length < 3) {
        throw new Error('pocabinet/minimap: centerline is required');
    }
    return new MinimapHandle(canvas, centerline, opts);
}

export function unmountMinimap(handle) {
    if (!handle) return;
    handle.dispose();
}
