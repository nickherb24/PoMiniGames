// Canvas scene renderer for PoRacer: a flat top-down drawing of the race the server is
// running. Lifecycle is owned by index.js; nothing in here listens, schedules or fetches.

let centerXY = null;
let centerN = 0, wallsXY = null, wallsM = 0, trackWidth = 0;
let currentTheme = 'circuit';
let boostPadsData = [];
let surfaceZonesData = [];
let parallaxTheme = null;
let grassTheme = null;

let grassTex = null, grassW = 0, grassH = 0, grassDpr = 0;
// Track is cached in WORLD space (origin = bbox min) at a given scale, then
// blitted with a camera offset each frame. trackOriginX/Y is the world
// coordinate that maps to the bitmap's TRACK_MARGIN,TRACK_MARGIN pixel.
const TRACK_MARGIN = 64;
let trackTex = null;
let trackOriginX = 0, trackOriginY = 0, trackScale = 1;
// trackTexCssW/H: the bitmap's size in CSS pixels, which is what the blit needs
// now that its backing store is trackDpr times that. trackReqDpr is the dpr draw()
// last asked for — the rebuild key, kept separate from the trackDpr actually
// granted, because the area budget can hand back less and a key that never
// matches would rebuild the whole track every frame.
let trackTexCssW = 0, trackTexCssH = 0, trackDpr = 0, trackReqDpr = 0;
// World bounding box of the track, for the finish zoom-out.
let boxMinX = 0, boxMinY = 0, boxMaxX = 0, boxMaxY = 0;

let mainCanvas = null, mainCtx = null;
let vignetteTex = null, vignetteW = 0, vignetteH = 0, vignetteDpr = 0;
let parallaxFar = null, parallaxMid = null, parallaxW = 0, parallaxH = 0, parallaxDpr = 0;

// Spectator follow-cam smoothing (demo/no-local-player). Tracks the race
// leader; lerped so leadership changes and marshal rescues pan smoothly
// instead of snapping. Reset to null on setStatic (new race geometry).
let specCamX = null, specCamY = null;
// Finish sequence: performance.now() when the camera started pulling back to frame the
// whole circuit, and where it was looking at that moment. 0 = live camera.
let finishAt = 0, finishFrom = null;

// ── Track-side effects ──────────────────────────────────────────────────────
// Skid marks, impact sparks and sand dust, all in world space and all derived from the cars
// this module is already handed: no extra wire field, no pool fed from elsewhere. They are
// drawn where the thing happened, not at the middle of the screen.
const SKID_MAX = 900;
const skids = new Float32Array(SKID_MAX * 5);   // x1, y1, x2, y2, alpha
const activeSkidIndices = new Uint16Array(SKID_MAX);
let activeSkidCount = 0;
let skidHead = 0;
const wheelWas = [];                            // per car index: { lx, ly, rx, ry, t }
const sparks = [], dust = [];
let fxAt = 0;
const carSprites = new Map();
const profiled = new URLSearchParams(location.search).get('perf') === '1';
const drawProfile = { count: 0, backgroundMs: 0, trackMs: 0, effectsMs: 0, carsMs: 0, totalMs: 0 };
// <html data-motion> is the OS preference OR the player's own switch in the settings sheet.
const calm = () => document.documentElement.dataset.motion === 'reduce'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function clearFx() {
    skids.fill(0); activeSkidCount = 0; skidHead = 0; wheelWas.length = 0; sparks.length = 0; dust.length = 0; fxAt = 0;
}

/** Sparks at a car that just hit something: thrown back along its travel, a third of a second. */
export function impact(x, y, heading, strength) {
    if (calm()) return;
    const n = 5 + Math.round(strength * 9);
    for (let i = 0; i < n && sparks.length < 80; i++) {
        const a = heading + Math.PI + (Math.random() - 0.5) * 2.2, v = 90 + Math.random() * 200;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.2 + Math.random() * 0.25 });
    }
}

function stepFx(cars, now) {
    const dt = fxAt ? Math.min(0.05, (now - fxAt) / 1000) : 0;
    fxAt = now;
    // Marks fade over about twenty seconds, so a lap later the line you slid is still there.
    const fade = 1 - 0.06 * dt;
    let active = 0;
    for (let i = 0; i < activeSkidCount; i++) {
        const index = activeSkidIndices[i], alpha = index * 5 + 4;
        skids[alpha] *= fade;
        if (skids[alpha] < 0.03) skids[alpha] = 0;
        else activeSkidIndices[active++] = index;
    }
    activeSkidCount = active;
    const quiet = calm();
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i], cos = Math.cos(c.h), sin = Math.sin(c.h);
        // Rear wheels, in the car's frame (-11, +-7).
        const lx = c.x - cos * 11 + sin * 7, ly = c.y - sin * 11 - cos * 7;
        const rx = c.x - cos * 11 - sin * 7, ry = c.y - sin * 11 + cos * 7;
        const was = wheelWas[i];
        const sliding = (c.skid || 0) > 0.5 && Math.abs(c.v) > 70;
        if (sliding && was && now - was.t < 200 && Math.hypot(lx - was.lx, ly - was.ly) < 40) {
            const a = Math.min(0.5, 0.2 + (c.skid - 0.5) * 0.6);
            for (const seg of [[was.lx, was.ly, lx, ly], [was.rx, was.ry, rx, ry]]) {
                const o = (skidHead++ % SKID_MAX) * 5;
                if (skids[o + 4] <= 0) activeSkidIndices[activeSkidCount++] = o / 5;
                skids[o] = seg[0]; skids[o + 1] = seg[1]; skids[o + 2] = seg[2]; skids[o + 3] = seg[3]; skids[o + 4] = a;
            }
        }
        wheelWas[i] = sliding ? { lx, ly, rx, ry, t: now } : null;
        if (!quiet && c.sand && Math.abs(c.v) > 50 && dust.length < 90 && Math.random() < dt * 22) {
            dust.push({ x: (lx + rx) / 2, y: (ly + ry) / 2, r: 5 + Math.random() * 4, life: 0.7, max: 0.7 });
        }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - 3 * dt; p.vy *= 1 - 3 * dt;
        if (p.life <= 0) sparks.splice(i, 1);
    }
    for (let i = dust.length - 1; i >= 0; i--) {
        const p = dust[i];
        p.life -= dt; p.r += 26 * dt;
        if (p.life <= 0) dust.splice(i, 1);
    }
}

function drawFx(g, camX, camY, scale, w, h) {
    const hw = w * 0.5, hh = h * 0.5;
    // Skids: three alpha bands, one path each.
    g.lineCap = 'round'; g.lineWidth = Math.max(1.5, 3.2 * scale);
    for (let band = 0; band < 3; band++) {
        const lo = band * 0.17, hi = band === 2 ? 1 : lo + 0.17;
        let any = false;
        g.beginPath();
        for (let i = 0; i < activeSkidCount; i++) {
            const o = activeSkidIndices[i] * 5, a = skids[o + 4];
            if (a <= lo || a > hi) continue;
            const x1 = hw + (skids[o] - camX) * scale, y1 = hh + (skids[o + 1] - camY) * scale;
            if (x1 < -40 || x1 > w + 40 || y1 < -40 || y1 > h + 40) continue;
            const x2 = hw + (skids[o + 2] - camX) * scale, y2 = hh + (skids[o + 3] - camY) * scale;
            if (x2 < -40 || x2 > w + 40 || y2 < -40 || y2 > h + 40) continue;
            g.moveTo(x1, y1); g.lineTo(x2, y2);
            any = true;
        }
        if (any) { g.strokeStyle = 'rgba(10,10,12,' + (lo + 0.12).toFixed(2) + ')'; g.stroke(); }
    }
    for (const p of dust) {
        const x = hw + (p.x - camX) * scale, y = hh + (p.y - camY) * scale, r = p.r * scale;
        if (x + r < 0 || x - r > w || y + r < 0 || y - r > h) continue;
        g.fillStyle = 'rgba(214,178,120,' + (0.38 * p.life / p.max).toFixed(3) + ')';
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // Sparks are flat flecks, not lights: no glow, no additive blend.
    for (const p of sparks) {
        const x = hw + (p.x - camX) * scale, y = hh + (p.y - camY) * scale;
        if (x < -3 || x > w + 3 || y < -3 || y > h + 3) continue;
        g.fillStyle = p.life > 0.2 ? '#ffe28a' : '#ff9a3c';
        const s = Math.max(1.5, 2.6 * scale);
        g.fillRect(x - s / 2, y - s / 2, s, s);
    }
}

/**
 * The live half of a boost pad: the arrows are baked into the track bitmap, this is one bright
 * chevron running down each pad and a flash while a car is on it.
 */
function drawPads(g, cars, camX, camY, scale, w, h, now) {
    if (!boostPadsData.length) return;
    const still = calm();
    for (const pad of boostPadsData) {
        const px = w * 0.5 + (pad.x - camX) * scale, py = h * 0.5 + (pad.y - camY) * scale;
        const pr = pad.radius || 45;
        if (px < -pr * scale * 2 || px > w + pr * scale * 2 || py < -pr * scale * 2 || py > h + pr * scale * 2) continue;
        const lit = cars.some(c => (c.x - pad.x) ** 2 + (c.y - pad.y) ** 2 < pr * pr);
        g.save();
        g.translate(px, py); g.rotate(pad.directionAngle || 0); g.scale(scale, scale);
        if (lit) { g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.roundRect(-pr, -pr * 0.5, pr * 2, pr, 8); g.fill(); }
        if (!still) {
            const phase = (now / 700) % 1, x = -pr + phase * pr * 2;
            g.strokeStyle = 'rgba(255,255,255,' + (Math.sin(phase * Math.PI) * 0.85).toFixed(2) + ')';
            g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
            g.beginPath(); g.moveTo(x - 8, -pr * 0.32); g.lineTo(x + 8, 0); g.lineTo(x - 8, pr * 0.32); g.stroke();
        }
        g.restore();
    }
}

function project(x, y, camX, camY, scale, w, h) {
    return [w * 0.5 + (x - camX) * scale, h * 0.5 + (y - camY) * scale];
}
function createOffscreen(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// Full-screen layers (grass, both parallax planes, fog, vignette)
// are cached as offscreen bitmaps and blitted with drawImage(tex, 0, 0, w, h).
// `w`/`h` are CSS pixels — draw() takes them from PoRacer.getSize(), which
// returns clientWidth/clientHeight — while the destination context carries a
// setTransform(dpr, ...). A bitmap built at the CSS size would be stretched over
// w*dpr x h*dpr device pixels and the browser would upscale it. Those layers cover
// essentially the whole frame, so on any HiDPI screen the picture would read as out
// of focus even though the track and cars (vector-drawn straight into the
// scaled context) stay sharp. It would be worst where it is most visible: the
// spectator camera frames mostly background.
//
// So build them at the BACKING-STORE size and pre-apply the same dpr transform,
// so every drawing call below still works in CSS units and the blit lands 1:1
// on device pixels. dpr belongs in each layer's cache key too — a window
// dragged between monitors of different scaling changes it without changing
// the CSS size, which would otherwise keep a stale, wrong-resolution bitmap.
function createLayer(w, h, dpr) {
    const c = createOffscreen(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas: c, ctx: ctx };
}

/** Backing-store pixels per CSS pixel for the context being drawn into. The
 *  canvas element is the single source of truth here, so this cannot drift
 *  from whatever resize() last decided (see PoCanvasDpr). */
function dprOf(g, w) {
    const c = g && g.canvas;
    return (c && w > 0 && c.width > 0) ? c.width / w : 1;
}

function mulberry32(seed) {
    let a = seed;
    return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ── Parallax layers ────────────────────────────────────────────────────────
function ensureParallaxLayers(w, h, dpr) {
    if (parallaxW === w && parallaxH === h && parallaxDpr === dpr && parallaxFar && parallaxMid && parallaxTheme === currentTheme) return;
    parallaxW = w; parallaxH = h; parallaxDpr = dpr; parallaxTheme = currentTheme;
    const farLayer = createLayer(w, h, dpr);
    const farOff = farLayer.canvas;
    const farCtx = farLayer.ctx;

    if (currentTheme === 'neonskyline') {
        const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
        farGrad.addColorStop(0, 'rgba(6, 8, 16, 0.9)'); farGrad.addColorStop(1, 'rgba(22, 10, 36, 0.95)');
        farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
        const rng = mulberry32(101);
        for (let i = 0; i < 26; i++) {
            const bw = 24 + rng() * 50, bx = rng() * (w + 40) - 20, bh = 60 + rng() * 120, by = h - bh;
            farCtx.fillStyle = 'rgba(12, 16, 28, 0.85)'; farCtx.fillRect(bx, by, bw, bh);
            const neonCol = rng() > 0.5 ? 'rgba(0, 240, 255, 0.7)' : 'rgba(255, 0, 128, 0.7)';
            farCtx.fillStyle = neonCol; farCtx.fillRect(bx + bw * 0.45, by - 10, 3, 10);
            for (let wy = by + 8; wy < h - 10; wy += 12) {
                for (let wx = bx + 4; wx < bx + bw - 4; wx += 9) {
                    if (rng() > 0.65) {
                        farCtx.fillStyle = rng() > 0.4 ? 'rgba(0, 240, 255, 0.4)' : 'rgba(255, 230, 100, 0.45)';
                        farCtx.fillRect(wx, wy, 3, 5);
                    }
                }
            }
        }
        parallaxFar = farOff;

        const midLayer = createLayer(w, h, dpr);
        const midOff = midLayer.canvas;
        const midCtx = midLayer.ctx;
        const rng2 = mulberry32(202);
        for (let i = 0; i < 18; i++) {
            const mx = rng2() * w, my = h * 0.35 + rng2() * (h * 0.45), mw = 30 + rng2() * 50, mh = 12 + rng2() * 18;
            midCtx.fillStyle = 'rgba(18, 22, 38, 0.7)'; midCtx.fillRect(mx, my, mw, mh);
            midCtx.strokeStyle = rng2() > 0.5 ? 'rgba(0, 240, 255, 0.6)' : 'rgba(255, 0, 128, 0.6)';
            midCtx.lineWidth = 1.5; midCtx.strokeRect(mx, my, mw, mh);
        }
        parallaxMid = midOff;
    } else if (currentTheme === 'desertdustway') {
        const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
        farGrad.addColorStop(0, 'rgba(90, 48, 20, 0.5)'); farGrad.addColorStop(0.5, 'rgba(145, 85, 38, 0.6)'); farGrad.addColorStop(1, 'rgba(185, 115, 55, 0.7)');
        farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
        farCtx.fillStyle = 'rgba(100, 52, 22, 0.65)';
        const rng = mulberry32(303);
        for (let i = 0; i < 16; i++) {
            const tx = rng() * (w + 100) - 50, ty = h * 0.35 + rng() * (h * 0.35), tw = 60 + rng() * 100;
            farCtx.beginPath(); farCtx.moveTo(tx - tw * 0.5, h); farCtx.lineTo(tx - tw * 0.32, ty); farCtx.lineTo(tx + tw * 0.32, ty); farCtx.lineTo(tx + tw * 0.5, h); farCtx.closePath(); farCtx.fill();
        }
        parallaxFar = farOff;

        const midLayer = createLayer(w, h, dpr);
        const midOff = midLayer.canvas;
        const midCtx = midLayer.ctx;
        midCtx.fillStyle = 'rgba(125, 70, 30, 0.45)';
        const rng2 = mulberry32(404);
        for (let i = 0; i < 40; i++) { midCtx.beginPath(); midCtx.arc(rng2() * w, rng2() * h, 5 + rng2() * 15, 0, Math.PI * 2); midCtx.fill(); }
        parallaxMid = midOff;
    } else {
        const farGrad = farCtx.createLinearGradient(0, 0, 0, h);
        farGrad.addColorStop(0, 'rgba(8,20,12,0.3)'); farGrad.addColorStop(1, 'rgba(4,10,6,0.5)');
        farCtx.fillStyle = farGrad; farCtx.fillRect(0, 0, w, h);
        farCtx.fillStyle = 'rgba(15,35,20,0.4)';
        const rng = mulberry32(42);
        for (let i = 0; i < 40; i++) { const tx = rng() * w, ty = rng() * h * 0.6 + h * 0.2, th = 20 + rng() * 40, tw = 10 + rng() * 15; farCtx.beginPath(); farCtx.moveTo(tx, ty); farCtx.lineTo(tx - tw, ty + th); farCtx.lineTo(tx + tw, ty + th); farCtx.closePath(); farCtx.fill(); }
        parallaxFar = farOff;

        const midLayer = createLayer(w, h, dpr);
        const midOff = midLayer.canvas;
        const midCtx = midLayer.ctx;
        midCtx.fillStyle = 'rgba(20,50,30,0.25)';
        const rng2 = mulberry32(99);
        for (let i = 0; i < 60; i++) { midCtx.beginPath(); midCtx.arc(rng2() * w, rng2() * h, 4 + rng2() * 12, 0, Math.PI * 2); midCtx.fill(); }
        midCtx.fillStyle = 'rgba(60,65,70,0.2)';
        for (let i = 0; i < 25; i++) { midCtx.fillRect(rng2() * w, rng2() * h, 3 + rng2() * 5, 2 + rng2() * 3); }
        parallaxMid = midOff;
    }
}

function drawVignette(g, w, h, dpr) {
    if (!vignetteTex || vignetteW !== w || vignetteH !== h || vignetteDpr !== dpr) {
        vignetteW = w; vignetteH = h; vignetteDpr = dpr;
        const layer = createLayer(w, h, dpr);
        vignetteTex = layer.canvas;
        const vc = layer.ctx;
        const vg = vc.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
        vc.fillStyle = vg; vc.fillRect(0, 0, w, h);
    }
    g.drawImage(vignetteTex, 0, 0, w, h);
}

// ── Ground ─────────────────────────────────────────────────────────────────
function ensureGrass(w, h, dpr) {
    if (grassTex && grassW === w && grassH === h && grassDpr === dpr && grassTheme === currentTheme) return;
    const layer = createLayer(w, h, dpr), off = layer.canvas, g = layer.ctx;
    grassDpr = dpr; grassTheme = currentTheme;

    if (currentTheme === 'neonskyline') {
        const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
        grad.addColorStop(0, '#0c0e18'); grad.addColorStop(0.5, '#07080f'); grad.addColorStop(1, '#030408');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);

        g.strokeStyle = 'rgba(0, 240, 255, 0.08)'; g.lineWidth = 1;
        for (let x = 0; x < w; x += 36) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
        for (let y = 0; y < h; y += 36) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

        g.fillStyle = 'rgba(255, 0, 128, 0.14)';
        for (let y = 0; y < h; y += 72) {
            for (let x = 0; x < w; x += 72) { g.fillRect(x - 1.5, y - 1.5, 3, 3); }
        }
    } else if (currentTheme === 'desertdustway') {
        const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
        grad.addColorStop(0, '#a3713f'); grad.addColorStop(0.5, '#82542a'); grad.addColorStop(1, '#573315');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);

        g.fillStyle = 'rgba(240, 195, 130, 0.14)';
        for (let y = 0; y < h; y += 20) {
            for (let x = (y % 40 === 0 ? 0 : 10); x < w; x += 20) { g.fillRect(x, y, 2.5, 2.5); }
        }
    } else {
        const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
        grad.addColorStop(0, '#1f5a2f'); grad.addColorStop(0.5, '#163f20'); grad.addColorStop(1, '#0c2412');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(140,200,120,0.08)';
        for (let y = 0; y < h; y += 22) for (let x = 0; x < w; x += 22) g.fillRect(x, y, 2, 2);
    }
    grassTex = off; grassW = w; grassH = h;
}

function getTrackHeadingAt(x, y) {
    if (!centerXY || centerN < 2) return 0;
    let bestDist = 1e9, bestIdx = 0;
    for (let i = 0; i < centerN; i++) {
        const dx = centerXY[i * 2] - x, dy = centerXY[i * 2 + 1] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
    }
    const prev = (bestIdx - 1 + centerN) % centerN;
    const next = (bestIdx + 1) % centerN;
    return Math.atan2(centerXY[next * 2 + 1] - centerXY[prev * 2 + 1], centerXY[next * 2] - centerXY[prev * 2]);
}

// ── Track bitmap ───────────────────────────────────────────────────────────
//
// PERF: The track is rasterized ONCE into a world-space offscreen bitmap
// (sized to the track bounding box + margin, at the current `scale`). The
// camera no longer invalidates it; each frame we just blit the bitmap with
// a camera-relative offset (see draw()). Previously this redrew ~156-point
// polylines every frame because the follow-camera pans continuously, which
// defeated the cache entirely. Now it only rebuilds when geometry or zoom
// (scale) changes.
function trackTx(x, y) {
    // World -> track-texture pixel space (fixed origin at the bbox min).
    return [(x - trackOriginX) * trackScale + TRACK_MARGIN, (y - trackOriginY) * trackScale + TRACK_MARGIN];
}
function buildTrackBitmap(scale, dpr) {
    if (!centerXY) return;

    // World bounding box of the centerline (+0.92 inset used by patches).
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < centerN; i++) {
        const x = centerXY[i * 2], y = centerXY[i * 2 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    // Pad by half track width so curbs/rumble strips fit inside the bitmap.
    const pad = trackWidth;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    trackOriginX = minX; trackOriginY = minY; trackScale = scale;
    boxMinX = minX; boxMinY = minY; boxMaxX = maxX; boxMaxY = maxY;
    const texW = Math.max(1, Math.ceil((maxX - minX) * scale + TRACK_MARGIN * 2));
    const texH = Math.max(1, Math.ceil((maxY - minY) * scale + TRACK_MARGIN * 2));

    // Same CSS-vs-device mismatch as the full-screen layers, and the one that hurt
    // most: the asphalt, curbs and rumble strips ARE the subject of the frame. The
    // blit below (see draw()) had no destination size, so one bitmap pixel became
    // one CSS pixel and the whole track was upscaled by dpr.
    //
    // Unlike those layers this bitmap is sized to the track's bounding box at the
    // current zoom, not to the viewport, so it can be far larger than the screen —
    // squaring dpr into it without a limit risks a canvas the browser refuses to
    // allocate, and a failed allocation here means no track at all. Cap the extra
    // resolution by area and fall back toward 1x rather than overshooting; the
    // texture keeps its CSS-space coordinate system either way, so nothing below
    // this line needs to know which happened.
    const TRACK_TEX_BUDGET = 24e6;   // ~24 Mpx, comfortably inside browser limits
    const reqDpr = Math.max(1, dpr || 1);
    let texDpr = reqDpr;
    const over = (texW * texH * texDpr * texDpr) / TRACK_TEX_BUDGET;
    if (over > 1) texDpr = Math.max(1, texDpr / Math.sqrt(over));
    trackDpr = texDpr;          // what we actually got
    trackReqDpr = reqDpr;       // what draw() asked for; the rebuild key
    trackTexCssW = texW; trackTexCssH = texH;

    const off = createOffscreen(Math.max(1, Math.round(texW * texDpr)), Math.max(1, Math.round(texH * texDpr)));
    const g = off.getContext('2d');
    g.setTransform(texDpr, 0, 0, texDpr, 0, 0);
    const wpx = trackWidth * scale;

    // The road is the centerline stroked at track width; its edges are the kerbs peeking out
    // from under it. Filling the centerline polygon instead would make the infield asphalt
    // and the road nothing but the kerb strokes: white and red, which reads as a pink track
    // around a grey lake. The gradient is built here and laid down after the kerbs below.
    const grad = g.createLinearGradient(0, 0, texW, texH);
    if (currentTheme === 'neonskyline') {
        grad.addColorStop(0, '#161922'); grad.addColorStop(0.5, '#10121a'); grad.addColorStop(1, '#090b10');
    } else if (currentTheme === 'desertdustway') {
        grad.addColorStop(0, '#554230'); grad.addColorStop(0.5, '#423324'); grad.addColorStop(1, '#2f2216');
    } else {
        grad.addColorStop(0, '#3d424a'); grad.addColorStop(0.5, '#2a2e36'); grad.addColorStop(1, '#1f242c');
    }

    // Rumble strips + kerbs, then the road over them
    g.save();
    g.beginPath();
    for (let i = 0; i <= centerN; i++) { const [sx, sy] = trackTx(centerXY[(i % centerN) * 2], centerXY[(i % centerN) * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
    g.closePath();
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (currentTheme === 'neonskyline') {
        g.strokeStyle = '#ff007f'; g.lineWidth = wpx + 14; g.stroke();
        g.strokeStyle = '#00f0ff'; g.lineWidth = wpx + 10; g.stroke();
        g.lineCap = 'butt'; g.setLineDash([16, 16]); g.strokeStyle = '#ff007f'; g.lineWidth = wpx + 10; g.stroke(); g.setLineDash([]);
    } else if (currentTheme === 'desertdustway') {
        g.strokeStyle = '#b85d19'; g.lineWidth = wpx + 14; g.stroke();
        g.strokeStyle = '#f3cf7a'; g.lineWidth = wpx + 10; g.stroke();
        g.lineCap = 'butt'; g.setLineDash([16, 16]); g.strokeStyle = '#b85d19'; g.lineWidth = wpx + 10; g.stroke(); g.setLineDash([]);
    } else {
        g.strokeStyle = '#cc2222'; g.lineWidth = wpx + 14; g.stroke();
        g.strokeStyle = '#ffffff'; g.lineWidth = wpx + 10; g.stroke();
        g.lineCap = 'butt'; g.setLineDash([16, 16]); g.strokeStyle = '#cc2222'; g.lineWidth = wpx + 10; g.stroke(); g.setLineDash([]);
    }
    g.strokeStyle = grad; g.lineWidth = wpx; g.stroke();
    g.restore();

    // Barrier lines: static, so they are baked here instead of stroked every frame. A wall
    // segment that lies on another stretch of road is left out: on the figure-8 each loop's
    // barriers run straight across the other loop at the crossing, where the sim has no wall
    // (it only keeps a car within the width of the stretch it is on) and the lines drew an X.
    if (wallsM > 0) {
        const reach = (trackWidth * 0.5 - 6) ** 2;
        const onOtherRoad = (x, y, own) => {
            for (let j = 0; j < centerN; j++) {
                const apart = Math.abs(j - own);
                if (Math.min(apart, centerN - apart) < 12) continue;
                const dx = centerXY[j * 2] - x, dy = centerXY[j * 2 + 1] - y;
                if (dx * dx + dy * dy < reach) return true;
            }
            return false;
        };
        g.strokeStyle = 'rgba(255,80,80,0.3)'; g.lineWidth = 2; g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i < wallsM; i++) {
            // Two walls per centerline segment, in order (PoRacerTrackRegistry.GenerateWalls).
            if (onOtherRoad((wallsXY[i * 4] + wallsXY[i * 4 + 2]) / 2, (wallsXY[i * 4 + 1] + wallsXY[i * 4 + 3]) / 2, i >> 1)) continue;
            const [x1, y1] = trackTx(wallsXY[i * 4], wallsXY[i * 4 + 1]);
            const [x2, y2] = trackTx(wallsXY[i * 4 + 2], wallsXY[i * 4 + 3]);
            g.moveTo(x1, y1); g.lineTo(x2, y2);
        }
        g.stroke();
    }

    // Surface Zones (e.g. sand drift zones)
    if (surfaceZonesData && surfaceZonesData.length > 0) {
        for (let i = 0; i < surfaceZonesData.length; i++) {
            const zone = surfaceZonesData[i];
            if (!zone || !zone.radius) continue;
            const isSand = zone.surfaceType === 'sand' || (zone.name && zone.name.toLowerCase().includes('sand')) || (zone.name && zone.name.toLowerCase().includes('dune'));
            if (isSand) {
                const [zx, zy] = trackTx(zone.x, zone.y);
                const zr = zone.radius * scale;
                const sandGrad = g.createRadialGradient(zx, zy, zr * 0.15, zx, zy, zr);
                sandGrad.addColorStop(0, 'rgba(224, 182, 114, 0.85)');
                sandGrad.addColorStop(0.65, 'rgba(196, 149, 82, 0.7)');
                sandGrad.addColorStop(0.9, 'rgba(168, 122, 58, 0.35)');
                sandGrad.addColorStop(1, 'rgba(140, 96, 40, 0)');
                g.save();
                g.fillStyle = sandGrad;
                g.beginPath();
                g.arc(zx, zy, zr, 0, Math.PI * 2);
                g.fill();
                g.strokeStyle = 'rgba(245, 210, 150, 0.3)';
                g.lineWidth = 2.5;
                for (let r = zr * 0.25; r < zr * 0.8; r += 16) {
                    g.beginPath();
                    g.arc(zx, zy, r, 0.2, Math.PI * 1.6);
                    g.stroke();
                }
                g.restore();
            }
        }
    }

    // Boost Pads
    if (boostPadsData && boostPadsData.length > 0) {
        for (let i = 0; i < boostPadsData.length; i++) {
            const pad = boostPadsData[i];
            if (!pad) continue;
            const [px, py] = trackTx(pad.x, pad.y);
            const pr = (pad.radius || 45) * scale;
            const angle = (pad.directionAngle && Math.abs(pad.directionAngle) > 0.001)
                ? pad.directionAngle
                : getTrackHeadingAt(pad.x, pad.y);

            g.save();
            g.translate(px, py);
            g.rotate(angle);

            const padGrad = g.createRadialGradient(0, 0, 2, 0, 0, pr);
            if (currentTheme === 'neonskyline') {
                padGrad.addColorStop(0, 'rgba(0, 240, 255, 0.95)');
                padGrad.addColorStop(0.6, 'rgba(0, 150, 255, 0.65)');
                padGrad.addColorStop(1, 'rgba(0, 50, 120, 0)');
            } else if (currentTheme === 'desertdustway') {
                padGrad.addColorStop(0, 'rgba(255, 180, 0, 0.95)');
                padGrad.addColorStop(0.6, 'rgba(255, 120, 0, 0.65)');
                padGrad.addColorStop(1, 'rgba(180, 50, 0, 0)');
            } else {
                padGrad.addColorStop(0, 'rgba(0, 255, 180, 0.95)');
                padGrad.addColorStop(0.6, 'rgba(0, 180, 220, 0.65)');
                padGrad.addColorStop(1, 'rgba(0, 80, 100, 0)');
            }
            g.fillStyle = padGrad;
            g.beginPath();
            g.roundRect(-pr, -pr * 0.5, pr * 2, pr, 8);
            g.fill();

            const arrowCol = currentTheme === 'neonskyline' ? '#00ffff' : currentTheme === 'desertdustway' ? '#ffe066' : '#55ffff';
            g.strokeStyle = arrowCol;
            g.shadowColor = arrowCol;
            g.shadowBlur = 8;
            g.lineWidth = 3.5;
            g.lineCap = 'round';
            g.lineJoin = 'round';
            for (let c = -1; c <= 1; c++) {
                const cx = c * (pr * 0.45);
                g.beginPath();
                g.moveTo(cx - 8, -pr * 0.32);
                g.lineTo(cx + 8, 0);
                g.lineTo(cx - 8, pr * 0.32);
                g.stroke();
            }
            g.restore();
        }
    }

    // Apex markers
    for (let i = 0; i < centerN; i += Math.max(1, Math.floor(centerN / 12))) {
        const prev = { x: centerXY[((i - 1 + centerN) % centerN) * 2], y: centerXY[((i - 1 + centerN) % centerN) * 2 + 1] };
        const curr = { x: centerXY[i * 2], y: centerXY[i * 2 + 1] };
        const next = { x: centerXY[((i + 1) % centerN) * 2], y: centerXY[((i + 1) % centerN) * 2 + 1] };
        const a1 = Math.atan2(curr.y - prev.y, curr.x - prev.x), a2 = Math.atan2(next.y - curr.y, next.x - curr.x);
        let curv = Math.abs(a2 - a1); if (curv > Math.PI) curv = 2 * Math.PI - curv;
        if (curv > 0.15) {
            const [mx, my] = trackTx(curr.x, curr.y);
            const ms = 4 * scale * 0.1;
            g.fillStyle = 'rgba(255,200,50,0.6)';
            g.beginPath(); g.moveTo(mx + Math.cos(a1) * ms * 3, my + Math.sin(a1) * ms * 3); g.lineTo(mx - Math.cos(a1 + 0.5) * ms, my - Math.sin(a1 + 0.5) * ms); g.lineTo(mx - Math.cos(a1 - 0.5) * ms, my - Math.sin(a1 - 0.5) * ms); g.closePath(); g.fill();
        }
    }

    // Centerline
    g.setLineDash([14, 14]);
    if (currentTheme === 'neonskyline') {
        g.strokeStyle = 'rgba(0,240,255,0.7)'; g.shadowColor = '#00f0ff'; g.shadowBlur = 6; g.lineWidth = 2.5;
    } else if (currentTheme === 'desertdustway') {
        g.strokeStyle = 'rgba(240,225,180,0.5)'; g.shadowBlur = 0; g.lineWidth = 2;
    } else {
        g.strokeStyle = 'rgba(255,255,255,0.55)'; g.shadowBlur = 0; g.lineWidth = 2;
    }
    g.beginPath();
    for (let i = 0; i < centerN; i++) { const [sx, sy] = trackTx(centerXY[i * 2], centerXY[i * 2 + 1]); if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
    g.closePath(); g.stroke(); g.setLineDash([]); g.shadowBlur = 0;

    // Start/finish
    const [ax, ay] = trackTx(centerXY[0], centerXY[1]);
    const [bx, by] = trackTx(centerXY[2], centerXY[3]);
    const ddx = bx - ax, ddy = by - ay, llen = Math.hypot(ddx, ddy) || 1;
    const nx = -ddy / llen, ny = ddx / llen, half = wpx * 0.5;
    for (let i = 0; i < 10; i++) { const t0 = i / 10, t1 = (i + 1) / 10; g.fillStyle = (i % 2 === 0) ? '#fff' : '#111'; g.beginPath(); g.moveTo(ax + nx * (-half + t0 * wpx), ay + ny * (-half + t0 * wpx)); g.lineTo(bx + nx * (-half + t0 * wpx), by + ny * (-half + t0 * wpx)); g.lineTo(bx + nx * (-half + t1 * wpx), by + ny * (-half + t1 * wpx)); g.lineTo(ax + nx * (-half + t1 * wpx), ay + ny * (-half + t1 * wpx)); g.closePath(); g.fill(); }

    trackTex = off;
}

// ── Cars ───────────────────────────────────────────────────────────────────

// Scuff positions, as fractions of the body. Fixed, and offset per car id, so a car's damage
// stays where it was instead of crawling around the bodywork from frame to frame.
const SCUFFS = [[-0.7, -0.6], [0.55, 0.5], [-0.2, 0.7], [0.75, -0.45], [-0.85, 0.25], [0.2, -0.75], [0.9, 0.1], [-0.45, -0.2]];

/**
 * One car, in its own frame (nose toward +x, 32 x 18 units). `g` is already translated,
 * rotated and scaled, which is what lets the paint-shop preview reuse this as it is: there
 * is one copy of the livery art, not a canvas one and an SVG one.
 */
function paintCar(g, car) {
    // Soft shadow
    g.save(); g.translate(4, 6); g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(0, 0, 20, 12, 0, 0, Math.PI * 2); g.fill(); g.restore();

    // Body: flat fill + dark overlay on the nose half
    g.fillStyle = car.color; g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.fill();
    g.fillStyle = car.colorDark || '#222'; g.globalAlpha = 0.4; g.beginPath(); g.roundRect(0, -9, 16, 18, [0, 5, 5, 0]); g.fill(); g.globalAlpha = 1;
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1.2;
    g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.stroke();

    // Livery
    const liv = car.livery || 'stripe';
    if (liv === 'dual') {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillRect(-14, -4.5, 28, 1.8);
        g.fillRect(-14, 2.7, 28, 1.8);
    } else if (liv === 'carbon') {
        g.fillStyle = 'rgba(25,25,30,0.7)';
        g.fillRect(-14, -7, 10, 14);
        g.fillRect(8, -8, 6, 16);
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.fillRect(-14, -1, 28, 2);
    } else if (liv === 'neon') {
        g.strokeStyle = '#00ffff'; g.lineWidth = 1.5;
        g.strokeRect(-12, -7, 24, 14);
        g.fillStyle = '#ff007f';
        g.fillRect(-14, -1.2, 28, 2.4);
    } else {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillRect(-14, -1.2, 28, 2.4);
    }

    // Windshield
    g.fillStyle = 'rgba(20,30,45,0.85)'; g.beginPath(); g.roundRect(2, -7, 8, 14, 2); g.fill();

    // Damage: the sim adds up to 0.12 for a wall hit and 0.06 for a car contact, by how hard,
    // and sends the total every snapshot (it also costs top speed). The paint dulls with it
    // and scuffs appear one by one; past 0.6 the windshield cracks.
    const dmg = car.damage || 0;
    if (dmg > 0.02) {
        g.fillStyle = 'rgba(60,60,64,' + (dmg * 0.3).toFixed(3) + ')';
        g.beginPath(); g.roundRect(-16, -9, 32, 18, 5); g.fill();
        const n = Math.min(SCUFFS.length, Math.ceil(dmg * SCUFFS.length));
        g.strokeStyle = 'rgba(18,18,20,0.75)'; g.lineWidth = 1.1; g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i < n; i++) {
            const s = SCUFFS[(i + (car.id || 0) * 3) % SCUFFS.length];
            const x = s[0] * 14, y = s[1] * 7.5;
            g.moveTo(x - 2.4, y - 1); g.lineTo(x + 2.4, y + 1);
            g.moveTo(x - 1.2, y + 1.4); g.lineTo(x + 1.8, y - 0.2);
        }
        g.stroke();
        if (dmg > 0.6) {
            g.strokeStyle = 'rgba(220,235,255,0.7)'; g.lineWidth = 0.7;
            g.beginPath(); g.moveTo(3, -5); g.lineTo(6, -1); g.lineTo(4.5, 2); g.moveTo(6, -1); g.lineTo(9, 1.5); g.stroke();
        }
    }

    // Lamps. Tail lights are always there and flare while the car is slowing; headlight beams
    // are drawn on the night track only. Cars are flat shapes, not light sources, so
    // this block is the only glow.
    const braking = !!car.braking;
    g.fillStyle = braking ? '#ff2a2a' : '#7a1414';
    if (braking) { g.shadowColor = '#ff2a2a'; g.shadowBlur = 10; }
    g.fillRect(-16.5, -7.5, 2, 3.4); g.fillRect(-16.5, 4.1, 2, 3.4);
    g.shadowBlur = 0;
    g.fillStyle = '#fff6cf';
    g.fillRect(14.6, -7, 1.6, 2.8); g.fillRect(14.6, 4.2, 1.6, 2.8);
    if (currentTheme === 'neonskyline') {
        const beam = g.createLinearGradient(16, 0, 96, 0);
        beam.addColorStop(0, 'rgba(255,244,200,0.34)'); beam.addColorStop(1, 'rgba(255,244,200,0)');
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = beam;
        g.beginPath(); g.moveTo(16, -6); g.lineTo(96, -30); g.lineTo(96, 30); g.lineTo(16, 6); g.closePath(); g.fill();
        g.globalCompositeOperation = 'source-over';
    }
}

function spriteFor(car) {
    const damage = Math.round((car.damage || 0) * 10) / 10;
    const key = `${currentTheme}|${car.color}|${car.colorDark}|${car.livery}|${damage}|${!!car.braking}`;
    let sprite = carSprites.get(key);
    if (sprite) return sprite;
    const canvas = createOffscreen(96, 80), ctx = canvas.getContext('2d');
    ctx.scale(2, 2); ctx.translate(24, 20);
    paintCar(ctx, { ...car, damage, braking: !!car.braking });
    sprite = canvas;
    carSprites.set(key, sprite);
    if (carSprites.size > 256) carSprites.delete(carSprites.keys().next().value);
    return sprite;
}

function drawSimpleCar(g, car, x, y, scale) {
    g.save();
    g.translate(x, y);
    g.rotate(car.h);
    g.scale(scale, scale);
    g.fillStyle = car.color;
    g.fillRect(-15, -8, 30, 16);
    g.fillStyle = car.colorDark || '#222';
    g.fillRect(1, -7, 12, 14);
    g.fillStyle = car.braking ? '#ff2a2a' : '#7a1414';
    g.fillRect(-15, -7, 2, 3);
    g.fillRect(-15, 4, 2, 3);
    g.restore();
}

function drawCar(g, car, camX, camY, scale, w, h, detailed) {
    const x = w * 0.5 + (car.x - camX) * scale, y = h * 0.5 + (car.y - camY) * scale;
    if (!detailed) {
        drawSimpleCar(g, car, x, y, scale);
        return;
    }
    g.save();
    g.translate(x, y);
    g.rotate(car.h);
    g.scale(scale, scale);
    g.drawImage(spriteFor(car), -24, -20, 48, 40);
    g.restore();
}

function drawPlayerMarker(g, c, camX, camY, scale, w, h) {
    const [x, y] = project(c.x, c.y, camX, camY, scale, w, h);
    g.save();
    // No decorative ring: the label is the only thing that identifies your car in a
    // full grid.
    g.fillStyle = '#06111f'; g.beginPath(); g.roundRect(x - 25, y - 53, 50, 24, 7); g.fill();
    g.fillStyle = '#ffffff'; g.font = 'bold 13px system-ui'; g.textAlign = 'center';
    g.fillText('YOU', x, y - 36);
    g.beginPath(); g.moveTo(x - 5, y - 27); g.lineTo(x + 5, y - 27); g.lineTo(x, y - 22); g.fill();
    g.restore();
}

// ── Public API (index.js is the only caller) ───────────────────────────────

/** Bind the race canvas. */
export function mount(mainId) {
    mainCanvas = document.getElementById(mainId);
    mainCtx = mainCanvas ? mainCanvas.getContext('2d') : null;
}

export function dispose() {
    // Wipe the last frame: the start card is drawn over this canvas, and a frozen race under it
    // reads as one still running.
    if (mainCtx && mainCanvas) { mainCtx.save(); mainCtx.setTransform(1, 0, 0, 1, 0, 0); mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height); mainCtx.restore(); }
    centerXY = wallsXY = null;
    mainCanvas = mainCtx = null;
    trackTex = grassTex = parallaxFar = parallaxMid = vignetteTex = null;
    carSprites.clear();
    specCamX = specCamY = null;
    finishAt = 0; finishFrom = null;
    clearFx();
}

export function setStatic(center, width, walls, boostPads, surfaceZones, theme) {
    centerXY = new Float32Array(center); centerN = centerXY.length / 2;
    wallsXY = new Float32Array(walls); wallsM = wallsXY.length / 4;
    trackWidth = width;
    boostPadsData = Array.isArray(boostPads) ? boostPads : [];
    surfaceZonesData = Array.isArray(surfaceZones) ? surfaceZones : [];
    currentTheme = (typeof theme === 'string' && theme) ? theme.toLowerCase() : 'circuit';
    trackTex = null;
    carSprites.clear();
    grassTex = null; parallaxFar = null; parallaxMid = null;
    grassTheme = null; parallaxTheme = null;
    specCamX = null; specCamY = null;
    finishAt = 0; finishFrom = null;
    clearFx();
}

/** 'circuit' | 'neonskyline' | 'desertdustway'. */
export function theme() { return currentTheme; }

// Also clears the per-layer dpr keys. input.js calls this when the backing
// store changes, which is exactly when those keys are stale.
export function invalidateBitmaps() {
    grassTex = null; trackTex = null; trackReqDpr = 0; trackDpr = 0;
    parallaxFar = null; parallaxMid = null; vignetteTex = null;
    grassDpr = 0; parallaxDpr = 0; vignetteDpr = 0; grassTheme = null; parallaxTheme = null;
    if (mainCanvas) mainCtx = mainCanvas.getContext('2d');
}

export function takeDrawProfile() {
    if (!drawProfile.count) return null;
    const count = drawProfile.count;
    const result = {
        backgroundMs: drawProfile.backgroundMs / count,
        trackMs: drawProfile.trackMs / count,
        effectsMs: drawProfile.effectsMs / count,
        carsMs: drawProfile.carsMs / count,
        totalMs: drawProfile.totalMs / count,
        frames: count,
    };
    drawProfile.count = 0;
    drawProfile.backgroundMs = drawProfile.trackMs = drawProfile.effectsMs = drawProfile.carsMs = drawProfile.totalMs = 0;
    return result;
}

/** Start (or cancel) the finish pull-back: the camera eases out until the whole circuit is in frame. */
export function finish(on) {
    finishAt = on ? performance.now() : 0;
    finishFrom = null;
}

/** The paint-shop preview: the same paintCar the race uses, on a small canvas of its own. */
export function preview(canvasId, color, colorDark, livery) {
    const c = document.getElementById(canvasId);
    const g = c && c.getContext('2d');
    if (!g) return;
    const saved = currentTheme;
    currentTheme = 'circuit';   // no headlight beam on the swatch
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    const k = c.width / 48; g.scale(k, k);
    paintCar(g, { id: 0, color, colorDark, livery, damage: 0, braking: false });
    g.setTransform(1, 0, 0, 1, 0, 0);
    currentTheme = saved;
}

const FINISH_MS = 2200;

/**
 * Draw one frame. `cars` is the roster merged with an interpolated snapshot:
 * { id, x, y, h, v, color, colorDark, livery, isPlayer, position, damage, braking }.
 * `w`/`h` are CSS pixels (input.js getSize()).
 */
export function draw(cars, w, h) {
    const g = mainCtx;
    if (!g || !cars || cars.length === 0 || !w || !h) return;
    const totalStart = profiled ? performance.now() : 0;

    const player = cars.find(c => c.isPlayer);
    const base = Math.min(w, h) / 900;
    let camX, camY, scale;
    if (!player && centerXY && centerN > 0) {
        // Spectator / demo view: follow the leader, eased.
        const lead = cars.reduce((a, c) => c.position < a.position ? c : a, cars[0]);
        const tx = lead.x + Math.cos(lead.h) * 80, ty = lead.y + Math.sin(lead.h) * 80;
        if (specCamX === null || Math.hypot(tx - specCamX, ty - specCamY) > 3000) { specCamX = tx; specCamY = ty; }
        else { specCamX += (tx - specCamX) * 0.18; specCamY += (ty - specCamY) * 0.18; }
        camX = specCamX; camY = specCamY;
        scale = Math.max(0.35, Math.min(1.2, base * 1.1));
    } else {
        // Follow-cam on the local player: zoom in so their car and the cars
        // around them (for collisions) are clearly visible.
        const target = player || cars[0];
        camX = target.x + Math.cos(target.h) * 80;
        camY = target.y + Math.sin(target.h) * 80;
        scale = Math.max(0.25, Math.min(1.2, base));
    }

    // Finish pull-back. The live camera above is where it starts from; the end is the track's
    // bounding box, fitted. Captured once so the start point does not drift under the ease.
    let zooming = false;
    if (finishAt && centerXY) {
        if (!finishFrom) finishFrom = { camX, camY, scale };
        const t = Math.min(1, (performance.now() - finishAt) / FINISH_MS);
        const e = t * t * (3 - 2 * t);
        const fit = Math.min(w / (boxMaxX - boxMinX || 1), h / (boxMaxY - boxMinY || 1)) * 0.82;
        camX = finishFrom.camX + ((boxMinX + boxMaxX) / 2 - finishFrom.camX) * e;
        camY = finishFrom.camY + ((boxMinY + boxMaxY) / 2 - finishFrom.camY) * e;
        scale = finishFrom.scale + (fit - finishFrom.scale) * e;
        zooming = true;
    }

    // Resolution of the cached full-screen layers below. Read off the canvas
    // rather than window.devicePixelRatio: resize() derives the backing store
    // through PoCanvasDpr, which lowers the ratio once the pixel budget is hit,
    // so the two are NOT the same number on a large window.
    const layerDpr = dprOf(g, w);

    // Parallax backgrounds
    const backgroundStart = profiled ? performance.now() : 0;
    ensureParallaxLayers(w, h, layerDpr); ensureGrass(w, h, layerDpr);
    g.drawImage(grassTex, 0, 0, w, h);
    const farOffX = ((camX * 0.3) % w + w) % w, farOffY = ((camY * 0.3) % h + h) % h;
    g.globalAlpha = 0.5;
    g.drawImage(parallaxFar, -farOffX, -farOffY, w, h); g.drawImage(parallaxFar, w - farOffX, -farOffY, w, h);
    g.drawImage(parallaxFar, -farOffX, h - farOffY, w, h); g.drawImage(parallaxFar, w - farOffX, h - farOffY, w, h);
    const midOffX = ((camX * 0.6) % w + w) % w, midOffY = ((camY * 0.6) % h + h) % h;
    g.globalAlpha = 0.6;
    g.drawImage(parallaxMid, -midOffX, -midOffY, w, h); g.drawImage(parallaxMid, w - midOffX, -midOffY, w, h);
    g.drawImage(parallaxMid, -midOffX, h - midOffY, w, h); g.drawImage(parallaxMid, w - midOffX, h - midOffY, w, h);
    g.globalAlpha = 1.0;
    const backgroundMs = profiled ? performance.now() - backgroundStart : 0;

    if (!centerXY) return;

    // Track — cached in world space, rebuilt only when zoom (scale) changes (not when the
    // camera pans). The finish pull-back changes the zoom every frame, so it scales the
    // bitmap it already has instead of rasterising the circuit sixty times a second.
    const trackStart = profiled ? performance.now() : 0;
    if (!trackTex || trackReqDpr !== layerDpr || (!zooming && Math.abs(trackScale - scale) > 0.001))
        buildTrackBitmap(scale, layerDpr);
    const k = scale / trackScale;
    const [tox, toy] = project(trackOriginX, trackOriginY, camX, camY, scale, w, h);
    // Explicit destination size: the bitmap is backed by texDpr device pixels per CSS pixel.
    g.drawImage(trackTex, tox - TRACK_MARGIN * k, toy - TRACK_MARGIN * k, trackTexCssW * k, trackTexCssH * k);
    const trackMs = profiled ? performance.now() - trackStart : 0;

    // On the road, under the cars: pads, skid marks, dust, sparks.
    const effectsStart = profiled ? performance.now() : 0;
    const now = performance.now();
    stepFx(cars, now);
    drawPads(g, cars, camX, camY, scale, w, h, now);
    drawFx(g, camX, camY, scale, w, h);
    const effectsMs = profiled ? performance.now() - effectsStart : 0;

    const hw = w * 0.5, hh = h * 0.5;
    const carMargin = (currentTheme === 'neonskyline' ? 100 : 40) * scale;
    const carStart = profiled ? performance.now() : 0;
    const detailedBelow = 18;
    for (const c of cars) {
        const x = (c.x - camX) * scale, y = (c.y - camY) * scale;
        if (x < -hw - carMargin || x > hw + carMargin || y < -hh - carMargin || y > hh + carMargin) continue;
        const detailed = c.isPlayer || 32 * scale * layerDpr >= detailedBelow;
        drawCar(g, c, camX, camY, scale, w, h, detailed);
    }
    const carsMs = profiled ? performance.now() - carStart : 0;

    // A constant 10% dusk tint, then the vignette. Both were the "ambient" and "post" steps
    // of the old pipeline at their fixed midday settings; this is what they always drew.
    g.fillStyle = 'rgba(0,0,0,0.105)'; g.fillRect(0, 0, w, h);
    drawVignette(g, w, h, layerDpr);

    if (player && !zooming) drawPlayerMarker(g, player, camX, camY, scale, w, h);
    if (profiled) {
        drawProfile.count++;
        drawProfile.backgroundMs += backgroundMs;
        drawProfile.trackMs += trackMs;
        drawProfile.effectsMs += effectsMs;
        drawProfile.carsMs += carsMs;
        drawProfile.totalMs += performance.now() - totalStart;
    }
}
