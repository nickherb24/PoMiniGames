// pojevarena/render.js — Canvas 2D composition of one arena frame.
//
// Layers, bottom to top: cached floor (with tar and brush beds) → stains → tar bubbles → team
// base markers → target lines → creatures (y-sorted) → walls and pillars → brush tufts → projectiles →
// particles → Jev blooms → overlay (HP bars, intent glyphs, slot badges, stale bubbles,
// selection) → popups → MVP spotlight → kill-cam letterbox. The renderer never reads the sim: it
// draws "views" (plain unit snapshots, see viewOf) so live play and Black Box replay are drawn by
// exactly the same code. The hazards are static map data (sim.arenaFor), not per-frame state.
//
// Camera: frame.camera = { x, y, zoom } in metres, applied as one transform around everything
// but the letterbox; pick() inverts it, so click-to-inspect works zoomed in.
//
// Colours come from CSS custom properties on the canvas (--jev-*), read once at mount; team hues
// are scheme-invariant canvas tokens, and team is never shown by colour alone (Blue stands on a
// ring, Red on a diamond).

import { FLAGS, lookFor, newMemory, noteEvent, drawCreature, releaseLook } from './creatures.js';
import { PPM, ARENA_W, ARENA_H, arenaFor } from './sim.js';

const TAU = Math.PI * 2;
const ARENA_PX_W = ARENA_W * PPM;   // 800
const ARENA_PX_H = ARENA_H * PPM;   // 600

/** Builds the drawable view of a live unit (the Black Box decodes to the same shape). */
export function viewOf(u, w, staleSeconds = 0) {
    let flags = 0;
    if (u.intent.panicked) flags |= FLAGS.PANIC;
    if (u.shell > 0) flags |= FLAGS.SHELL;
    if (u.braced) flags |= FLAGS.BRACE;
    if (u.invuln > 0) flags |= FLAGS.INVULN;
    if (u.poison > 0) flags |= FLAGS.POISON;
    if (staleSeconds > 1.5) flags |= FLAGS.STALE;
    if (u.dash > 0) flags |= FLAGS.DASH;
    if (u.cast) flags |= FLAGS.CAST;
    if (u.strike.phase === 1) flags |= FLAGS.WINDUP;
    if (u.strike.phase === 2) flags |= FLAGS.LUNGE;
    if (u.stagger > 0) flags |= FLAGS.REEL;
    return {
        idx: u.idx, team: u.team, slot: u.slot, label: u.label, name: u.name,
        alive: u.alive, deathAge: u.alive ? -1 : w.time - u.deathTime,
        x: u.x, y: u.y, vx: u.vx, vy: u.vy, facing: u.facing,
        hp: u.hp, maxHp: u.maxHp, flags,
        ax: u.ax, ay: u.ay, stamina: u.reserve / u.reserveMax,
        castId: u.cast ? u.cast.id : null, castT: u.cast ? u.cast.t : 0,
        strikeT: u.strike.t,
        action: u.intent.decided ? u.intent.action : 'idle',
        target: u.intent.target,
        focus: u.intent.focus,
        stale: staleSeconds,
    };
}

function readPalette(el) {
    const css = getComputedStyle(el);
    const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    return {
        blue: v('--jev-blue', '#3d7bff'),
        blueDark: v('--jev-blue-dark', '#1b3f99'),
        red: v('--jev-red', '#f0524f'),
        redDark: v('--jev-red-dark', '#8f1f1d'),
        floor: v('--jev-floor', '#2b3a2f'),
        floorLine: v('--jev-floor-line', '#324536'),
        wall: v('--jev-wall', '#141a15'),
        ink: v('--jev-ink', '#f4f6f8'),
        heal: v('--jev-heal', '#5fe07f'),
    };
}

export function createRenderer(canvas, { creatures, fx, reduced = false, seed = 0 }) {
    const ctx = canvas.getContext('2d');
    const palette = readPalette(canvas);
    const looks = creatures.map((c, i) => lookFor(c, i < creatures.length / 2 ? 'blue' : 'red', palette));
    const memory = creatures.map(() => newMemory());
    const arena = arenaFor(seed);
    // Grass tufts per brush patch, placed once from the patch index so every frame agrees. A wall
    // may stand in a patch; nothing grows on top of it.
    const tufts = arena.brush.flatMap((b, bi) => Array.from({ length: Math.round(b.r * 11) }, (_, i) => {
        const a = (i * 2.399963 + bi) % TAU, d = b.r * Math.sqrt(((i * 7919 + bi * 31) % 97) / 97) * 0.92;
        return { x: b.x + Math.cos(a) * d, y: b.y + Math.sin(a) * d, s: 0.8 + ((i * 13) % 5) / 10, ph: i * 1.7 };
    })).filter(t => !arena.walls.some(b => Math.abs(t.x - b.x) < b.hw + 0.15 && Math.abs(t.y - b.y) < b.hh + 0.3));
    let floor = null;
    let map = null;
    let dpr = 1;
    let cam = null;          // the transform this frame used, for pick()

    function resize() {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const s = Math.min(canvas.width / ARENA_PX_W, canvas.height / ARENA_PX_H);   // canvas px per arena px
        const ox = (canvas.width - ARENA_PX_W * s) / 2, oy = (canvas.height - ARENA_PX_H * s) / 2;
        map = {
            s: s * PPM,                                   // canvas px per metre
            ox, oy, k: s,
            px: (x) => ox + x * PPM * s,
            py: (y) => oy + y * PPM * s,
        };
        floor = null;
        for (const l of looks) releaseLook(l);
    }

    function buildFloor() {
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(canvas.width, canvas.height) : Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
        const g = c.getContext('2d');
        g.fillStyle = palette.wall;
        g.fillRect(0, 0, c.width, c.height);
        const x0 = map.px(0), y0 = map.py(0), w = ARENA_PX_W * map.k, h = ARENA_PX_H * map.k;

        g.fillStyle = palette.floor;
        g.fillRect(x0, y0, w, h);
        // A 1 m tile grid, then seeded pebbles, so motion reads against the ground.
        g.strokeStyle = palette.floorLine;
        g.lineWidth = Math.max(1, map.k);
        for (let i = 1; i < ARENA_W; i++) { g.beginPath(); g.moveTo(map.px(i), y0); g.lineTo(map.px(i), y0 + h); g.stroke(); }
        for (let j = 1; j < ARENA_H; j++) { g.beginPath(); g.moveTo(x0, map.py(j)); g.lineTo(x0 + w, map.py(j)); g.stroke(); }
        let s = 12345;
        const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        for (let i = 0; i < 260; i++) { g.beginPath(); g.arc(x0 + r() * w, y0 + r() * h, (0.5 + r() * 1.6) * map.k, 0, TAU); g.fill(); }

        // Start zones: faint team-tinted circles.
        for (const [cx, col] of [[130 / PPM, palette.blue], [670 / PPM, palette.red]]) {
            g.globalAlpha = 0.12;
            g.fillStyle = col;
            g.beginPath(); g.arc(map.px(cx), map.py(7.5), 2.6 * map.s, 0, TAU); g.fill();
            g.globalAlpha = 0.35;
            g.strokeStyle = col;
            g.setLineDash([6 * map.k, 6 * map.k]);
            g.lineWidth = 2 * map.k;
            g.stroke();
            g.setLineDash([]);
            g.globalAlpha = 1;
        }
        // Centre line.
        g.strokeStyle = 'rgba(255,255,255,0.08)';
        g.lineWidth = 3 * map.k;
        g.beginPath(); g.moveTo(map.px(ARENA_W / 2), y0); g.lineTo(map.px(ARENA_W / 2), y0 + h); g.stroke();
        // Hazard beds: brush ground, tar pits (glossy, with a crusted rim), pillar shadows.
        for (const b of arena.brush) {
            g.fillStyle = 'rgba(20,60,24,0.55)';
            g.beginPath(); g.arc(map.px(b.x), map.py(b.y), b.r * map.s, 0, TAU); g.fill();
        }
        for (const t of arena.tar) {
            const x = map.px(t.x), y = map.py(t.y), r = t.r * map.s;
            const tg = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
            tg.addColorStop(0, '#3a3128'); tg.addColorStop(0.6, '#17120e'); tg.addColorStop(1, '#0b0907');
            g.fillStyle = tg;
            g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
            g.strokeStyle = 'rgba(70,52,34,0.8)';
            g.lineWidth = Math.max(2, r * 0.08);
            g.stroke();
        }
        g.fillStyle = 'rgba(0,0,0,0.35)';
        for (const p of arena.pillars) {
            g.beginPath(); g.ellipse(map.px(p.x + 0.12), map.py(p.y + 0.18), p.r * map.s * 1.1, p.r * map.s, 0, 0, TAU); g.fill();
        }
        // One path for every block, so the arms of a bracket do not double their shadow where they meet.
        g.beginPath();
        for (const b of arena.walls) g.rect(map.px(b.x - b.hw + 0.12), map.py(b.y - b.hh + 0.18), b.hw * 2 * map.s, b.hh * 2 * map.s);
        g.fill();
        // Wall lip.
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = 6 * map.k;
        g.strokeRect(x0, y0, w, h);
        floor = c;
    }

    const teamColor = (team) => (team === 'blue' ? palette.blue : palette.red);

    function drawMarker(v, x, y, R) {
        ctx.strokeStyle = teamColor(v.team);
        ctx.lineWidth = Math.max(1.5, R * 0.14);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        if (v.team === 'blue') {
            ctx.ellipse(x, y + R * 0.15, R * 1.3, R * 1.05, 0, 0, TAU);
        } else {
            const rx = R * 1.35, ry = R * 1.1, cy = y + R * 0.15;
            ctx.moveTo(x, cy - ry); ctx.lineTo(x + rx, cy); ctx.lineTo(x, cy + ry); ctx.lineTo(x - rx, cy);
            ctx.closePath();
        }
        ctx.stroke();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(x, y + R * 0.35, R * 1.05, R * 0.6, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    const FRIENDLY_ACTIONS = new Set(['mend_ally', 'peel_to_ally']);

    function drawPillars() {
        for (const p of arena.pillars) {
            const x = map.px(p.x), y = map.py(p.y), r = p.r * map.s;
            const pg = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
            pg.addColorStop(0, '#c9c2b4'); pg.addColorStop(0.7, '#8a8378'); pg.addColorStop(1, '#5a544b');
            ctx.fillStyle = pg;
            ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
            ctx.strokeStyle = '#3d3933';
            ctx.lineWidth = Math.max(1.5, r * 0.1);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(40,36,30,0.6)';
            ctx.lineWidth = Math.max(1, r * 0.05);
            ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0.3, 2.1); ctx.moveTo(x - r * 0.2, y - r * 0.5); ctx.lineTo(x + r * 0.1, y - r * 0.1); ctx.stroke();
        }
    }

    /**
     * The wall blocks, in the pillars' stone. All of them go down as one path (outline, then face)
     * so a bracket or an ell reads as one piece with no seam where its blocks meet; each block
     * then gets a lit top edge and a shaded foot. The stone is far lighter than the floor and
     * carries neither team's hue, and the canvas tokens do not change with the colour scheme.
     */
    function drawWalls() {
        if (!arena.walls.length) return;
        const lip = Math.max(2, 0.13 * map.s);
        ctx.beginPath();
        for (const b of arena.walls) ctx.rect(map.px(b.x - b.hw), map.py(b.y - b.hh), b.hw * 2 * map.s, b.hh * 2 * map.s);
        ctx.strokeStyle = '#3d3933';
        ctx.lineWidth = Math.max(3, 0.12 * map.s);
        ctx.stroke();
        ctx.fillStyle = '#8a8378';
        ctx.fill();
        for (const b of arena.walls) {
            const x = map.px(b.x - b.hw), y = map.py(b.y - b.hh), w = b.hw * 2 * map.s, h = b.hh * 2 * map.s;
            ctx.fillStyle = '#c9c2b4';
            ctx.fillRect(x, y, w, lip);
            ctx.fillStyle = '#5a544b';
            ctx.fillRect(x, y + h - lip, w, lip);
        }
    }

    function drawBrush(time) {
        ctx.strokeStyle = '#3f8f3a';
        ctx.lineCap = 'round';
        for (const t of tufts) {
            const x = map.px(t.x), y = map.py(t.y), h = 0.32 * t.s * map.s;
            const sway = reduced ? 0 : Math.sin(time * 1.8 + t.ph) * h * 0.25;
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = Math.max(1.5, 2.2 * map.k);
            ctx.beginPath();
            for (const dx of [-0.35, 0, 0.35]) {
                ctx.moveTo(x + dx * h * 0.6, y);
                ctx.quadraticCurveTo(x + dx * h + sway * 0.5, y - h * 0.6, x + dx * h * 1.4 + sway, y - h);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.lineCap = 'butt';
    }

    function drawTarBubbles(time) {
        if (reduced) return;
        ctx.strokeStyle = 'rgba(120,98,70,0.7)';
        ctx.lineWidth = Math.max(1, map.k);
        arena.tar.forEach((t, ti) => {
            for (let i = 0; i < 5; i++) {
                const k = (time * 0.45 + i / 5 + ti * 0.13) % 1;
                const a = i * 2.4 + ti, d = t.r * 0.6 * (((i * 37) % 10) / 10);
                ctx.globalAlpha = 1 - k;
                ctx.beginPath();
                ctx.arc(map.px(t.x + Math.cos(a) * d), map.py(t.y + Math.sin(a) * d), (0.04 + k * 0.12) * map.s, 0, TAU);
                ctx.stroke();
            }
        });
        ctx.globalAlpha = 1;
    }

    /** Darkens everything but one unit, and crowns it MVP (victory ceremony). */
    function drawSpotlight(v, time) {
        const x = map.px(v.x), y = map.py(v.y), R = radius(v) * map.s;
        const sg = ctx.createRadialGradient(x, y, R * 1.8, x, y, R * 9);
        sg.addColorStop(0, 'rgba(0,0,0,0)');
        sg.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = sg;
        ctx.fillRect(map.px(0) - map.s * 20, map.py(0) - map.s * 20, map.s * ARENA_W * 3, map.s * ARENA_H * 3);
        const bob = reduced ? 0 : Math.sin(time * 4) * 3 * map.k;
        ctx.font = `800 ${Math.max(11, 13 * map.k)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const by = y - R * 2.6 + bob, bw = ctx.measureText('MVP').width + 14 * map.k;
        ctx.fillStyle = '#ffcf4a';
        ctx.beginPath(); ctx.roundRect(x - bw / 2, by - 10 * map.k, bw, 20 * map.k, 10 * map.k); ctx.fill();
        ctx.fillStyle = '#2b1d00';
        ctx.fillText('MVP', x, by + 0.5);
    }

    /** Cinema bars plus a caption, eased in by k (0..1). Drawn in screen space, over the camera. */
    function drawLetterbox(k, caption) {
        const h = canvas.height * 0.09 * k;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, h);
        ctx.fillRect(0, canvas.height - h, canvas.width, h);
        if (!caption || k < 0.5) return;
        ctx.globalAlpha = (k - 0.5) * 2;
        ctx.font = `800 ${Math.max(14, h * 0.42)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(caption, canvas.width / 2, canvas.height - h / 2);
        ctx.globalAlpha = 1;
    }

    /** Applies the camera around the arena centre, kept inside the arena so no void shows. */
    function applyCamera(c) {
        cam = null;
        if (!c || !(c.zoom > 1.001)) return;
        const z = c.zoom;
        const cx = map.px(ARENA_W / 2), cy = map.py(ARENA_H / 2);
        const halfW = (ARENA_W * map.s) / 2 / z, halfH = (ARENA_H * map.s) / 2 / z;
        const clampTo = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
        const tx = clampTo(map.px(c.x), map.px(0) + halfW, map.px(ARENA_W) - halfW);
        const ty = clampTo(map.py(c.y), map.py(0) + halfH, map.py(ARENA_H) - halfH);
        ctx.translate(cx, cy);
        ctx.scale(z, z);
        ctx.translate(-tx, -ty);
        cam = { cx, cy, z, tx, ty };
    }

    function drawTargetLine(v, views, selected) {
        if (!v.alive || v.target < 0 || v.action === 'idle' || (v.flags & FLAGS.PANIC)) return;
        const t = views[v.target];
        if (!t || !t.alive) return;
        const friendly = FRIENDLY_ACTIONS.has(v.action) || t.team === v.team;
        ctx.globalAlpha = selected ? 0.9 : 0.22;
        ctx.strokeStyle = friendly ? palette.heal : teamColor(v.team);
        ctx.lineWidth = Math.max(1, (selected ? 2.5 : 1.5) * map.k);
        if (friendly) ctx.setLineDash([6 * map.k, 5 * map.k]);
        ctx.beginPath();
        ctx.moveTo(map.px(v.x), map.py(v.y));
        ctx.lineTo(map.px(t.x), map.py(t.y));
        ctx.stroke();
        ctx.setLineDash([]);
        if (selected) {
            // Arrowhead at the target so direction is unambiguous.
            const a = Math.atan2(t.y - v.y, t.x - v.x), tx = map.px(t.x) - Math.cos(a) * 0.55 * map.s, ty = map.py(t.y) - Math.sin(a) * 0.55 * map.s;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(tx - Math.cos(a - 0.45) * 10 * map.k, ty - Math.sin(a - 0.45) * 10 * map.k);
            ctx.lineTo(tx - Math.cos(a + 0.45) * 10 * map.k, ty - Math.sin(a + 0.45) * 10 * map.k);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawOverlay(v, x, y, R, selected, time) {
        if (!v.alive) return;
        const barW = Math.max(26 * map.k, R * 2.2), barH = Math.max(4, 5 * map.k);
        const bx = x - barW / 2, by = y - R * 1.55 - barH;
        const pct = Math.max(0, v.hp / v.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = pct > 0.5 ? '#5fe07f' : pct > 0.25 ? '#ffc247' : '#ff5a5a';
        ctx.fillRect(bx, by, barW * pct, barH);
        // The energy reserve, a thin strip under the HP bar; hidden when full.
        const st = v.stamina ?? 1;
        if (st < 0.99) {
            const sh = Math.max(2, barH * 0.5);
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(bx - 1, by + barH + 1, barW + 2, sh + 1);
            ctx.fillStyle = st > 0.35 ? '#ffd166' : '#ff8f3a';
            ctx.fillRect(bx, by + barH + 1.5, barW * Math.max(0, st), sh);
        }

        // Intent glyph above the bar (what Jev told it to do).
        const gy = by - 11 * map.k;
        drawGlyph(v.flags & FLAGS.PANIC ? 'panic' : v.action, x, gy, 8 * map.k, v.team);

        // Slot badge.
        ctx.font = `700 ${Math.max(9, 10 * map.k)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const badgeX = x + R * 0.95, badgeY = y + R * 0.95;
        ctx.fillStyle = teamColor(v.team);
        ctx.beginPath(); ctx.arc(badgeX, badgeY, 7.5 * map.k, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(v.slot + 1), badgeX, badgeY + 0.5);

        if (v.flags & FLAGS.STALE) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            const sx = x + R * 1.1, sy = y - R * 1.1;
            ctx.beginPath(); ctx.ellipse(sx, sy, 10 * map.k, 6.5 * map.k, 0, 0, TAU); ctx.fill();
            ctx.fillStyle = '#c9ced6';
            ctx.fillText('…', sx, sy - 1);
        }

        if (selected) {
            const pulse = 1 + 0.08 * Math.sin(time * 6);
            ctx.strokeStyle = palette.ink;
            ctx.lineWidth = 2 * map.k;
            ctx.beginPath(); ctx.arc(x, y, R * 1.65 * pulse, 0, TAU); ctx.stroke();
            ctx.font = `700 ${Math.max(10, 11 * map.k)}px system-ui, sans-serif`;
            const label = `${v.label} · ${v.name}`;
            const tw = ctx.measureText(label).width + 10 * map.k;
            // Blue's tag hangs below its unit, Red's sits above the HP bar, so when the two selected
            // units meet in a scrum their name tags do not land on top of each other.
            const ly = v.team === 'blue' ? y + R * 1.8 : y - R * 1.55 - 38 * map.k;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(x - tw / 2, ly, tw, 16 * map.k);
            ctx.fillStyle = palette.ink;
            ctx.fillText(label, x, ly + 8 * map.k);
        }
    }

    /** Small vector icons for the unit's current intent. */
    function drawGlyph(kind, x, y, s, team) {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.arc(0, 0, s * 1.15, 0, TAU); ctx.fill();
        ctx.strokeStyle = ctx.fillStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.2, s * 0.2);
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        switch (kind) {
            case 'melee_charge':   // fist / claw swipe
                for (let i = -1; i <= 1; i++) { ctx.moveTo(-s * 0.55, i * s * 0.4 - s * 0.2); ctx.lineTo(s * 0.55, i * s * 0.4 + s * 0.2); }
                ctx.stroke(); break;
            case 'kite_and_shoot': // glob
                ctx.fillStyle = '#9be35a'; ctx.arc(0, 0, s * 0.45, 0, TAU); ctx.fill(); break;
            case 'lob_boulder':    // rock
                ctx.fillStyle = '#b8a88f';
                for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; ctx.lineTo(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.5); }
                ctx.closePath(); ctx.fill(); break;
            case 'mend_ally':      // cross
                ctx.strokeStyle = '#7dff9a';
                ctx.moveTo(-s * 0.55, 0); ctx.lineTo(s * 0.55, 0); ctx.moveTo(0, -s * 0.55); ctx.lineTo(0, s * 0.55); ctx.stroke(); break;
            case 'shield_brace':   // shield
                ctx.moveTo(0, -s * 0.6); ctx.lineTo(s * 0.5, -s * 0.35); ctx.lineTo(s * 0.35, s * 0.3); ctx.lineTo(0, s * 0.62);
                ctx.lineTo(-s * 0.35, s * 0.3); ctx.lineTo(-s * 0.5, -s * 0.35); ctx.closePath(); ctx.stroke(); break;
            case 'shell_up':       // dome
                ctx.arc(0, s * 0.2, s * 0.55, Math.PI, 0); ctx.closePath(); ctx.stroke(); break;
            case 'dodge_dash':     // chevrons
                ctx.moveTo(-s * 0.55, -s * 0.4); ctx.lineTo(-s * 0.1, 0); ctx.lineTo(-s * 0.55, s * 0.4);
                ctx.moveTo(0, -s * 0.4); ctx.lineTo(s * 0.45, 0); ctx.lineTo(0, s * 0.4); ctx.stroke(); break;
            case 'fall_back':      // back arrow
                ctx.moveTo(s * 0.55, 0); ctx.lineTo(-s * 0.5, 0); ctx.moveTo(-s * 0.15, -s * 0.35); ctx.lineTo(-s * 0.55, 0); ctx.lineTo(-s * 0.15, s * 0.35); ctx.stroke(); break;
            case 'take_cover':     // a pillar with someone tucked behind it
                ctx.arc(-s * 0.15, 0, s * 0.42, 0, TAU); ctx.stroke();
                ctx.beginPath(); ctx.arc(s * 0.5, 0, s * 0.18, 0, TAU); ctx.fill(); break;
            case 'peel_to_ally':   // two linked dots
                ctx.arc(-s * 0.3, 0, s * 0.22, 0, TAU); ctx.moveTo(s * 0.52, 0); ctx.arc(s * 0.3, 0, s * 0.22, 0, TAU); ctx.fill(); break;
            case 'panic':          // !
                ctx.fillStyle = '#7fd0ff';
                ctx.fillRect(-s * 0.12, -s * 0.6, s * 0.24, s * 0.75);
                ctx.beginPath(); ctx.arc(0, s * 0.45, s * 0.14, 0, TAU); ctx.fill(); break;
            default:               // idle / awaiting orders
                for (let i = -1; i <= 1; i++) { ctx.moveTo(i * s * 0.35 + s * 0.1, 0); ctx.arc(i * s * 0.35, 0, s * 0.1, 0, TAU); }
                ctx.fill();
        }
        ctx.restore();
    }

    resize();

    return {
        looks,
        resize,

        /**
         * Draws one frame. frame = { time, tick, dt, views, projectiles, events, selected, live,
         * camera, spotlight, letterbox, caption, teamColor };
         * `selected` is a unit index or an array of them (Dual Inspector: one per team).
         * `events` are this frame's sim events (fed to fx once per sim tick by the caller).
         */
        draw(frame) {
            if (!floor) buildFloor();
            const { views, projectiles = [], selected = -1, time = 0, dt = 1 / 60 } = frame;
            const picked = new Set([].concat(selected));

            for (const e of frame.events || []) if (e.u !== undefined && memory[e.u]) noteEvent(memory[e.u], e);
            fx.update(dt);

            const shake = reduced ? 0 : fx.shakeAmount;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = palette.wall;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (shake > 0) ctx.translate(Math.sin(time * 91) * shake * 5 * map.k, Math.cos(time * 77) * shake * 5 * map.k);
            applyCamera(frame.camera);
            ctx.drawImage(floor, 0, 0);

            fx.drawStains(ctx, map);
            drawTarBubbles(time);
            for (const v of views) if (v.alive) drawMarker(v, map.px(v.x), map.py(v.y), (v.r ?? radius(v)) * map.s);
            for (const v of views) drawTargetLine(v, views, picked.has(v.idx));

            const order = views.slice().sort((a, b) => a.y - b.y);
            for (const v of order) {
                const R = radius(v) * map.s;
                const x = map.px(v.x), y = map.py(v.y);
                const target = v.target >= 0 ? views[v.target] : null;
                v.px = x; v.py = y;
                v.lookAt = target && target.alive ? { x: map.px(target.x), y: map.py(target.y) } : null;
                drawCreature(ctx, looks[v.idx], v, memory[v.idx], x, y, R, time, dt, reduced);
            }

            drawWalls();
            drawPillars();
            drawBrush(time);
            fx.drawProjectiles(ctx, projectiles, map, time);
            fx.drawParticles(ctx, map);
            fx.drawBlooms(ctx, map, views, time, frame.teamColor || teamColor, reduced);
            for (const v of order) drawOverlay(v, map.px(v.x), map.py(v.y), radius(v) * map.s, picked.has(v.idx), time);
            fx.drawPopups(ctx, map);
            if (frame.spotlight >= 0 && views[frame.spotlight]?.alive) drawSpotlight(views[frame.spotlight], time);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (frame.letterbox > 0) drawLetterbox(frame.letterbox, frame.caption);
        },

        /** Unit index under a client-space point (for click-to-inspect), or -1. */
        pick(clientX, clientY, views) {
            const rect = canvas.getBoundingClientRect();
            let x = (clientX - rect.left) * dpr, y = (clientY - rect.top) * dpr;
            if (cam) { x = (x - cam.cx) / cam.z + cam.tx; y = (y - cam.cy) / cam.z + cam.ty; }

            let best = -1, bd = Infinity;
            for (const v of views) {
                if (!v.alive) continue;
                const d = Math.hypot(map.px(v.x) - x, map.py(v.y) - y);
                const R = radius(v) * map.s * 1.6;
                if (d < R && d < bd) { bd = d; best = v.idx; }
            }
            return best;
        },

        /** Forgets per-unit animation memory (Black Box jumps). */
        resetMemory() { for (let i = 0; i < memory.length; i++) memory[i] = newMemory(); },

        dispose() {
            for (const l of looks) releaseLook(l);
            floor = null;
        },
    };

    function radius(v) { return (10 + 3 * creatures[v.idx].mass) / PPM; }
}
