// pojevarena/creatures.js — procedural creature art and the per-unit animation state machine.
//
// Everything is drawn from the creature's own data, so a spectator can tell creatures
// apart without the inspector:
//   body     ← mass and speed (heavy = wide and plated, fast = sleek teardrop with a tail)
//   features ← abilities (throat sac, forelimbs, antennae, shield plate, back plates, fins)
//   face     ← temperament (brows, eyes, mouth) plus an idle mannerism
//   pattern  ← a seeded hash of the creature id (spots or stripes, accent hue)
// The textured body is cached per creature × team × pixel size; faces, limbs and pose effects
// are drawn live. Units are drawn from a plain "view" (see viewOf) so live play and Black Box
// replay share this code exactly.

export const FLAGS = {
    PANIC: 1, SHELL: 2, BRACE: 4, INVULN: 8, POISON: 16, STALE: 32, DASH: 64, CAST: 128, WINDUP: 256, LUNGE: 512,
    CHEER: 1024,   // victory ceremony only: the winners hop
    REEL: 2048,    // staggered by a blow: leans back off its facing
};

const TAU = Math.PI * 2;

// ── Looks ────────────────────────────────────────────────────────────────────

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function seeded(seed) {
    let s = seed || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

/** Everything about how a creature looks, derived once from its data. */
export function lookFor(creature, team, palette) {
    const h = hash(creature.id + '|' + creature.name);
    const rnd = seeded(h);
    const abilities = creature.abilities || [];
    const has = (id) => abilities.includes(id);
    const body = creature.mass >= 3.5 ? 'bulky' : creature.moveSpeed >= 6.5 ? 'sleek' : 'blob';
    const accentHue = h % 360;
    const spots = Array.from({ length: 3 + (h % 4) }, () => ({ x: rnd() * 1.4 - 0.8, y: rnd() * 1.4 - 0.7, r: 0.12 + rnd() * 0.14 }));
    return {
        id: creature.id,
        team,
        body,
        pattern: (h >> 3) % 3 === 0 ? 'stripes' : 'spots',
        spots,
        fill: team === 'blue' ? palette.blue : palette.red,
        dark: team === 'blue' ? palette.blueDark : palette.redDark,
        accent: `hsl(${accentHue} 70% 60%)`,
        temperament: creature.temperament,
        features: {
            sac: has('spit_glob'),
            arms: has('hurl_boulder'),
            antennae: has('mend_bolt'),
            plate: has('shield_brace'),
            shell: has('hard_shell'),
            fins: has('dodge_dash'),
            claws: !abilities.some(id => id === 'spit_glob' || id === 'hurl_boulder' || id === 'mend_bolt'),
        },
        phase: (h % 1000) / 1000 * TAU,   // de-syncs idle breathing across a pack
        cache: null,
    };
}

// ── Body path & cached texture ───────────────────────────────────────────────

function bodyPath(ctx, body, R) {
    ctx.beginPath();
    if (body === 'bulky') {
        ctx.ellipse(0, 0, R * 1.08, R * 0.98, 0, 0, TAU);
    } else if (body === 'sleek') {
        // Teardrop: blunt nose at +x, tapering tail toward -x.
        ctx.moveTo(R * 1.05, 0);
        ctx.bezierCurveTo(R * 1.05, R * 0.95, -R * 0.4, R * 0.95, -R * 1.25, R * 0.12);
        ctx.quadraticCurveTo(-R * 1.45, 0, -R * 1.25, -R * 0.12);
        ctx.bezierCurveTo(-R * 0.4, -R * 0.95, R * 1.05, -R * 0.95, R * 1.05, 0);
    } else {
        ctx.ellipse(0, 0, R, R * 0.94, 0, 0, TAU);
    }
    ctx.closePath();
}

/** Body + pattern + outline rendered once per pixel radius into an offscreen canvas. */
function bodyTexture(look, R) {
    const key = Math.round(R * 4);
    if (look.cache && look.cache.key === key) return look.cache;
    const pad = 1.6;
    const size = Math.ceil(R * pad * 2 + 4);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = canvas.getContext('2d');
    g.translate(size / 2, size / 2);

    // Soft top-down shading: lighter toward the upper-left "sun".
    const grad = g.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R * 1.3);
    grad.addColorStop(0, shade(look.fill, 0.25));
    grad.addColorStop(1, look.fill);
    bodyPath(g, look.body, R);
    g.fillStyle = grad;
    g.fill();

    g.save();
    bodyPath(g, look.body, R);
    g.clip();
    g.globalAlpha = 0.35;
    g.fillStyle = look.accent;
    if (look.pattern === 'stripes') {
        for (let i = -2; i <= 2; i++) {
            g.beginPath();
            g.ellipse(i * R * 0.42, 0, R * 0.09, R * 1.1, 0.25, 0, TAU);
            g.fill();
        }
    } else {
        for (const s of look.spots) { g.beginPath(); g.arc(s.x * R, s.y * R, s.r * R, 0, TAU); g.fill(); }
    }
    g.restore();

    if (look.body === 'bulky') {
        // Armour plates across the back for the heavyweights.
        g.strokeStyle = shade(look.dark, -0.1);
        g.lineWidth = Math.max(1, R * 0.07);
        for (let i = 0; i < 3; i++) {
            g.beginPath();
            g.arc(-R * 0.15 - i * R * 0.28, 0, R * 0.62, Math.PI * 0.62, Math.PI * 1.38);
            g.stroke();
        }
    }

    bodyPath(g, look.body, R);
    g.lineWidth = Math.max(1.2, R * 0.08);
    g.strokeStyle = look.dark;
    g.stroke();

    look.cache = { key, canvas, size };
    return look.cache;
}

// ── Colour helpers ───────────────────────────────────────────────────────────

function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))));
    const r = mix(n >> 16), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ── Per-unit animation memory (render-side only; never part of the sim) ─────

export function newMemory() {
    return { flash: 0, walk: 0, lastX: NaN, lastY: NaN, ghosts: [], dart: 0, dartSeed: Math.random() };
}

/** Feeds this frame's events into the unit's memory (hit flash, etc.). */
export function noteEvent(mem, e) {
    if (e.type === 'hit' && e.kind !== 'poison') mem.flash = 0.09;
    if (e.type === 'block') mem.block = 0.25;
    if (e.type === 'heal') mem.healGlow = 0.35;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

/**
 * Draws one unit centred at (px, py) in canvas pixels, radius R pixels.
 * view: { alive, deathAge, vx, vy, facing, hp, maxHp, flags, castId, castT, strikeT, lookAt: {x,y}|null, allyAt }
 * time: seconds (for idle loops). reduced: prefers-reduced-motion.
 */
export function drawCreature(ctx, look, view, mem, px, py, R, time, dt, reduced) {
    const f = view.flags | 0;
    const speed = Math.hypot(view.vx, view.vy);
    mem.flash = Math.max(0, mem.flash - dt);
    mem.block = Math.max(0, (mem.block || 0) - dt);
    mem.healGlow = Math.max(0, (mem.healGlow || 0) - dt);

    // Dying: squash, then pop outward and fade (0.45 s). The decal is fx.js's job.
    if (!view.alive) {
        const k = Math.min(1, view.deathAge / 0.45);
        if (k >= 1) return;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(view.facing);
        const s = k < 0.4 ? 1 - k * 0.5 : 0.8 + (k - 0.4) * 1.2;
        ctx.scale(s * (k < 0.4 ? 1.15 : 1), s);
        ctx.globalAlpha = 1 - Math.max(0, (k - 0.4) / 0.6);
        const tex = bodyTexture(look, R);
        ctx.drawImage(tex.canvas, -tex.size / 2, -tex.size / 2);
        ctx.restore();
        return;
    }

    // Walk cycle advances with distance travelled, so pace reads directly off the feet.
    if (Number.isFinite(mem.lastX)) mem.walk += Math.hypot(px - mem.lastX, py - mem.lastY) / Math.max(4, R * 0.9);
    mem.lastX = px; mem.lastY = py;

    const lowHp = view.hp / view.maxHp < 0.25;
    const temperament = look.temperament;

    // ── pose offsets ──
    let ox = 0, oy = 0, sx = 1, sy = 1, rot = view.facing;
    // Tired bodies pant: faster, deeper breaths as the energy reserve runs down.
    const tired = 1 - Math.min(1, (view.stamina ?? 1) / 0.5);
    const breathRate = (lowHp ? 0.45 : temperament === 'disciplined_anchor' ? 0.6 : 0.9) + tired * 1.6;
    const breath = reduced ? 0 : Math.sin(time * TAU * breathRate + look.phase) * ((temperament === 'disciplined_anchor' ? 0.015 : 0.03) + tired * 0.04);
    sx += breath; sy += breath;

    if (!reduced) {
        // Squash & stretch along the facing while moving.
        const stretch = Math.min(0.14, speed * 0.03);
        sx += stretch; sy -= stretch * 0.6;
        if (temperament === 'skirmisher') oy += Math.sin(time * TAU * 2.2 + look.phase) * R * 0.06;
        if (temperament === 'reckless_berserker' && speed < 0.4) rot += Math.sin(time * 31 + look.phase) * 0.04;
        if (f & FLAGS.PANIC) { ox += Math.sin(time * 70) * R * 0.05; oy += Math.cos(time * 63) * R * 0.05; }
        // Lean into the push: a body shifts toward where its legs are driving it (and back when braking).
        const lean = Math.min(0.16, Math.hypot(view.ax || 0, view.ay || 0) * 0.018);
        if (lean > 0.01) { const a = Math.atan2(view.ay, view.ax); ox += Math.cos(a) * R * lean; oy += Math.sin(a) * R * lean; }
        if (lowHp) sy *= 0.95;
        if (f & FLAGS.REEL) { ox -= Math.cos(view.facing) * R * 0.14; oy -= Math.sin(view.facing) * R * 0.14; sx *= 0.92; sy *= 1.05; }
        if (f & FLAGS.CHEER) {
            const hop = Math.abs(Math.sin(time * 7 + look.phase));
            oy -= hop * R * 0.45;
            sx *= 1 - hop * 0.04; sy *= 1 + hop * 0.08;
        }
    }

    const strikeT = view.strikeT || 0;
    if (f & FLAGS.WINDUP) {                           // pull back, telegraph
        const k = Math.min(1, strikeT / 0.12);
        ox -= Math.cos(view.facing) * R * 0.22 * k; oy -= Math.sin(view.facing) * R * 0.22 * k;
        sx *= 1 + 0.08 * k; sy *= 1 + 0.08 * k;
    } else if (f & FLAGS.LUNGE) {                     // snap forward
        ox += Math.cos(view.facing) * R * 0.25; oy += Math.sin(view.facing) * R * 0.25;
        sx *= 1.2; sy *= 0.88;
    }
    if (f & FLAGS.SHELL) { sx *= 0.86; sy *= 0.86; }
    if (f & FLAGS.CAST && view.castId === 'hurl_boulder') { sx *= 1.06; sy *= 1.06; }

    // ── dash afterimages ──
    if (f & FLAGS.DASH) {
        mem.ghosts.push({ x: px, y: py, a: 0.45 });
        if (mem.ghosts.length > 3) mem.ghosts.shift();
    }
    for (const gh of mem.ghosts) {
        gh.a -= dt * 2.4;
        if (gh.a <= 0) continue;
        ctx.save();
        ctx.globalAlpha = gh.a;
        ctx.translate(gh.x, gh.y);
        ctx.rotate(view.facing);
        const tex = bodyTexture(look, R);
        ctx.drawImage(tex.canvas, -tex.size / 2, -tex.size / 2);
        ctx.restore();
    }
    mem.ghosts = mem.ghosts.filter(g => g.a > 0);

    ctx.save();
    ctx.translate(px + ox, py + oy);
    ctx.rotate(rot);

    drawFeet(ctx, look, R, mem.walk, speed > 0.25 && !(f & FLAGS.SHELL), lowHp);
    drawFeaturesBehind(ctx, look, R, f, time);

    ctx.save();
    ctx.scale(sx, sy);
    const tex = bodyTexture(look, R);
    ctx.drawImage(tex.canvas, -tex.size / 2, -tex.size / 2);

    if (f & FLAGS.POISON) {
        ctx.globalAlpha = 0.25 + 0.15 * Math.sin(time * 9);
        bodyPath(ctx, look.body, R);
        ctx.fillStyle = '#7ddc4a';
        ctx.fill();
        ctx.globalAlpha = 1;
    }
    if (mem.healGlow > 0) {
        ctx.globalAlpha = mem.healGlow * 1.6;
        bodyPath(ctx, look.body, R * 1.08);
        ctx.strokeStyle = '#9dffb0';
        ctx.lineWidth = R * 0.18;
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    ctx.restore();

    drawFeaturesFront(ctx, look, view, R, f, time, mem);
    drawFace(ctx, look, view, R, f, time, mem, reduced);

    if (f & FLAGS.SHELL) drawShellDome(ctx, look, R, time);
    if (f & FLAGS.INVULN) {
        ctx.globalAlpha = 0.5;
        bodyPath(ctx, look.body, R * 1.15);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = R * 0.08;
        ctx.setLineDash([R * 0.25, R * 0.2]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }

    // Hit flash: the whole silhouette goes white for ~80 ms.
    if (mem.flash > 0) {
        ctx.globalAlpha = Math.min(1, mem.flash / 0.09) * 0.85;
        ctx.scale(sx, sy);
        bodyPath(ctx, look.body, R);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
    }
    ctx.restore();

    if (f & FLAGS.PANIC && !reduced) drawSweat(ctx, px + ox, py + oy, R, time);
}

function drawFeet(ctx, look, R, walk, moving, lowHp) {
    ctx.fillStyle = look.dark;
    const step = moving ? Math.sin(walk * Math.PI) * R * 0.22 : 0;
    const limp = lowHp ? 0.5 : 1;
    const feet = [[0.45, 0.78, step], [0.45, -0.78, -step * limp], [-0.45, 0.78, -step * limp], [-0.45, -0.78, step]];
    for (const [fx, fy, off] of feet) {
        ctx.beginPath();
        ctx.ellipse(fx * R + off, fy * R, R * 0.22, R * 0.15, 0, 0, TAU);
        ctx.fill();
    }
}

function drawFeaturesBehind(ctx, look, R, f, time) {
    const ft = look.features;
    if (ft.fins) {
        ctx.fillStyle = shade(look.fill, -0.25);
        for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(-R * 0.1, side * R * 0.7);
            ctx.lineTo(-R * 0.95, side * R * 1.25);
            ctx.lineTo(-R * 0.65, side * R * 0.55);
            ctx.closePath();
            ctx.fill();
        }
    }
    if (ft.arms) {
        // Oversized forelimbs; raised overhead while a boulder is being wound up.
        const raised = (f & FLAGS.CAST) ? 1 : 0;
        ctx.fillStyle = shade(look.fill, -0.18);
        ctx.strokeStyle = look.dark;
        ctx.lineWidth = Math.max(1, R * 0.07);
        for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.ellipse(R * (0.55 - raised * 0.45), side * R * (0.95 - raised * 0.45), R * 0.42, R * 0.26, side * (0.5 - raised * 0.9), 0, TAU);
            ctx.fill();
            ctx.stroke();
        }
    }
}

function drawFeaturesFront(ctx, look, view, R, f, time, mem) {
    const ft = look.features;

    if (ft.claws) {
        ctx.fillStyle = '#f4efe6';
        const open = (f & FLAGS.LUNGE) ? 0.25 : 0;
        for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(R * 0.85, side * R * (0.38 + open));
            ctx.lineTo(R * 1.28, side * R * (0.22 + open));
            ctx.lineTo(R * 0.9, side * R * (0.16 + open));
            ctx.closePath();
            ctx.fill();
        }
    }

    if (ft.sac) {
        // Throat sac: bulges past the nose so it changes the silhouette itself (it must read
        // without colour), and swells further through a spit wind-up.
        const k = (f & FLAGS.CAST) && view.castId === 'spit_glob' ? Math.min(1, (view.castT || 0) / 0.15) : 0;
        ctx.fillStyle = '#9be35a';
        ctx.strokeStyle = '#2d5c12';
        ctx.lineWidth = Math.max(1.5, R * 0.1);
        ctx.beginPath();
        ctx.arc(R * 1.0, 0, R * (0.3 + 0.22 * k), 0, TAU);
        ctx.fill();
        ctx.stroke();
    }

    if (ft.antennae) {
        const flare = (f & FLAGS.CAST) && view.castId === 'mend_bolt' ? 1 : 0;
        ctx.strokeStyle = look.dark;
        ctx.lineWidth = Math.max(1, R * 0.07);
        for (const side of [1, -1]) {
            const sway = Math.sin(time * 3 + side) * R * 0.08;
            ctx.beginPath();
            ctx.moveTo(R * 0.55, side * R * 0.3);
            ctx.quadraticCurveTo(R * 1.1, side * R * 0.55 + sway, R * 1.3, side * R * 0.75 + sway);
            ctx.stroke();
            ctx.fillStyle = '#b9ffcf';
            ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 5 + side);
            ctx.beginPath();
            ctx.arc(R * 1.3, side * R * 0.75 + sway, R * (0.13 + flare * 0.1), 0, TAU);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    if (ft.plate) {
        const braced = f & FLAGS.BRACE;
        ctx.strokeStyle = braced ? '#e8f1ff' : '#c7ccd6';
        ctx.lineWidth = R * (braced ? 0.3 : 0.2);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, 0, R * (braced ? 1.22 : 1.05), braced ? -Math.PI / 3 : -0.55, braced ? Math.PI / 3 : 0.55);
        ctx.stroke();
        if (mem.block > 0) {
            ctx.strokeStyle = `rgba(255,255,255,${mem.block * 3})`;
            ctx.lineWidth = R * 0.12;
            ctx.beginPath();
            ctx.arc(0, 0, R * 1.45, -Math.PI / 3, Math.PI / 3);
            ctx.stroke();
        }
        ctx.lineCap = 'butt';
    }

    if (ft.shell && !(f & FLAGS.SHELL)) {
        ctx.fillStyle = shade(look.dark, 0.15);
        ctx.globalAlpha = 0.85;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(-R * (0.15 + i * 0.28), 0, R * 0.2, R * (0.55 - i * 0.08), 0, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

function drawShellDome(ctx, look, R, time) {
    const g = ctx.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R * 1.1);
    g.addColorStop(0, '#f2f5fa');
    g.addColorStop(0.5, shade(look.dark, 0.35));
    g.addColorStop(1, shade(look.dark, -0.2));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.02, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = shade(look.dark, -0.35);
    ctx.lineWidth = R * 0.08;
    ctx.stroke();
    // Plate seams + a moving sheen so "shelled" reads as a hard, metallic state.
    ctx.lineWidth = R * 0.05;
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(0, i * R * 0.9, R * 0.9, 0.35 * Math.PI, 0.65 * Math.PI); ctx.stroke(); }
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(Math.sin(time * 2) * R * 0.4, -R * 0.35, R * 0.18, R * 0.5, 0.6, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
}

/** Eyes, brows and mouth sit at the front of the body; pupils track what the creature is looking at. */
function drawFace(ctx, look, view, R, f, time, mem, reduced) {
    if (f & FLAGS.SHELL) return;
    const t = look.temperament;
    const eyeX = R * 0.42, eyeY = R * 0.34;
    const eyeR = R * (t === 'loyal_guardian' ? 0.25 : 0.21);
    const squint = t === 'cautious_sniper' ? 0.45 : t === 'opportunist' ? 0.6 : 1;

    // Pupil direction in local space: toward the look-at point, darting for the opportunist.
    let lx = 1, ly = 0;
    if (view.lookAt) {
        const dx = view.lookAt.x - (view.px ?? 0), dy = view.lookAt.y - (view.py ?? 0);
        const a = Math.atan2(dy, dx) - view.facing;
        lx = Math.cos(a); ly = Math.sin(a);
    }
    if (t === 'opportunist' && !reduced) {
        const slot = Math.floor(time / 0.7 + mem.dartSeed * 10);
        ly += ((slot * 7919) % 3 - 1) * 0.9;
    }
    const plen = Math.hypot(lx, ly) || 1;
    lx /= plen; ly /= plen;

    for (const side of [1, -1]) {
        const ex = eyeX, ey = side * eyeY;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(ex, ey, eyeR * squint, eyeR, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#16161c';
        ctx.beginPath();
        const pr = eyeR * (f & FLAGS.PANIC ? 0.35 : 0.55);
        ctx.ellipse(ex + lx * eyeR * 0.35 * squint, ey + ly * eyeR * 0.35, pr * squint, pr, 0, 0, TAU);
        ctx.fill();

        // Brows (drawn on the forward side of each eye, i.e. toward +x in local space).
        ctx.strokeStyle = look.dark;
        ctx.lineWidth = Math.max(1, R * 0.08);
        ctx.lineCap = 'round';
        ctx.beginPath();
        const bx = ex + eyeR * 0.2;
        if (t === 'reckless_berserker' || (f & FLAGS.WINDUP)) {
            ctx.moveTo(bx - eyeR * 0.9, ey + side * eyeR * 1.2);
            ctx.lineTo(bx + eyeR * 0.5, ey - side * eyeR * 0.1);         // slanted in: angry
        } else if (t === 'skirmisher' || (f & FLAGS.PANIC)) {
            ctx.moveTo(bx - eyeR * 0.6, ey + side * eyeR * 1.5);
            ctx.lineTo(bx - eyeR * 0.9, ey - side * eyeR * 0.3);         // raised: alert / scared
        } else if (t === 'cautious_sniper' && side === 1) {
            ctx.moveTo(bx - eyeR * 0.2, ey + eyeR * 1.4);
            ctx.lineTo(bx - eyeR * 0.6, ey - eyeR * 0.6);                // one brow up
        } else {
            ctx.moveTo(bx - eyeR * 0.5, ey + side * eyeR * 1.25);
            ctx.lineTo(bx - eyeR * 0.5, ey - side * eyeR * 0.45);        // level
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
    }

    // Mouth at the nose.
    ctx.strokeStyle = '#1b1414';
    ctx.lineWidth = Math.max(1, R * 0.07);
    ctx.beginPath();
    const mx = R * 0.8;
    const open = (f & FLAGS.LUNGE) || (f & FLAGS.PANIC) || (f & FLAGS.CHEER);

    if (open) {
        ctx.fillStyle = '#3a1016';
        ctx.ellipse(mx, 0, R * 0.12, R * 0.22, 0, 0, TAU);
        ctx.fill();
    } else if (t === 'reckless_berserker') {
        ctx.moveTo(mx, -R * 0.2);
        for (let i = 0; i <= 4; i++) ctx.lineTo(mx + (i % 2 ? R * 0.07 : 0), -R * 0.2 + i * R * 0.1);   // snarl
        ctx.stroke();
    } else if (t === 'opportunist') {
        ctx.moveTo(mx, -R * 0.18);
        ctx.quadraticCurveTo(mx + R * 0.08, R * 0.05, mx - R * 0.02, R * 0.2);                          // smirk
        ctx.stroke();
    } else if (t === 'disciplined_anchor') {
        ctx.moveTo(mx, -R * 0.17);
        ctx.lineTo(mx, R * 0.17);
        ctx.stroke();
    } else {
        ctx.arc(mx - R * 0.12, 0, R * 0.2, -0.9, 0.9);                                                 // smile
        ctx.stroke();
    }
}

function drawSweat(ctx, x, y, R, time) {
    ctx.fillStyle = '#7fd0ff';
    for (let i = 0; i < 3; i++) {
        const k = ((time * 1.6 + i / 3) % 1);
        const a = -Math.PI / 2 + (i - 1) * 0.7;
        const d = R * (1.0 + k * 0.6);
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        const dx = x + Math.cos(a) * d, dy = y + Math.sin(a) * d;
        ctx.moveTo(dx, dy - R * 0.16);
        ctx.quadraticCurveTo(dx + R * 0.1, dy, dx, dy + R * 0.08);
        ctx.quadraticCurveTo(dx - R * 0.1, dy, dx, dy - R * 0.16);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

/** Drops cached textures (on unmount or DPR change). */
export function releaseLook(look) { look.cache = null; }
