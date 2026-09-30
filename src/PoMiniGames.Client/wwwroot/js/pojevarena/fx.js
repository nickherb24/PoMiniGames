// pojevarena/fx.js — per-ability visuals, particles, popups and decals.
//
// Everything here is driven by the sim's per-tick events (and the projectile list), never by the
// sim's internals, so the Black Box can feed recorded events back through and get the same show.
// Particle randomness is seeded from (tick, event index), not Math.random(), so a replayed frame
// sprays the same sparks. The ability visuals are keyed by registry id / projectile kind — the
// visual third of "one registry row + one handler + one visual" (see abilities.js).
//
// The floor remembers the fight: splats, craters, death marks and the paths units trample are
// baked into one arena-sized stain canvas as they happen, so they cost one drawImage a frame
// however long the match runs (the old 60-decal list forgot the early fight). Black Box jumps
// keep it: it is the record of the whole match, not of the scrubbed frame.
//
// Blooms are Jev made visible: when a decision lands, a ring of petals — one per option, sized by
// its probability, the chosen one in team colour — opens over the unit and fades. A coin-flip
// call (confidence under 0.40) flickers.

const TAU = Math.PI * 2;
const MAX_PARTICLES = 400;
const MAX_POPUPS = 40;
const MAX_BLOOMS = 24;
const BLOOM_LIFE_S = 1.1;
const COIN_FLIP = 0.40;
const STAIN_PPM = 60;                 // stain canvas pixels per metre (1.5x the arena's 40)
const ARENA_M = { w: 20, h: 15 };

/** Height (m) of a thrown projectile: the same parabola sim.js flies it on (½·g·t·(flight − t)). */
const arc = (p) => Math.max(0, 0.5 * 9.81 * p.age * (p.flight - p.age));

function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/** Projectile looks, by kind (spit_glob → glob, hurl_boulder → boulder, mend_bolt → mend). */
const PROJECTILES = {
    glob(ctx, p, m, time) {
        const r = m.s * 0.16, h = arc(p) * m.s;
        const x = m.px(p.x), y = m.py(p.y) - h;
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath(); ctx.ellipse(x, y + h + r * 0.3, r, r * 0.45, 0, 0, TAU); ctx.fill();
        // Drip trail behind the glob.
        const len = Math.hypot(p.vx, p.vy) || 1;
        for (let i = 1; i <= 4; i++) {
            ctx.globalAlpha = 0.5 - i * 0.1;
            ctx.fillStyle = '#7ddc4a';
            ctx.beginPath();
            ctx.arc(x - (p.vx / len) * r * i * 1.3, y - (p.vy / len) * r * i * 1.3, r * (1 - i * 0.18), 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#9be35a';
        ctx.strokeStyle = '#3f7a1c';
        ctx.lineWidth = Math.max(1, r * 0.3);
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.2, r, Math.atan2(p.vy, p.vx), 0, TAU);
        ctx.fill();
        ctx.stroke();
    },
    boulder(ctx, p, m, time) {
        // A real lob: the sim's parabola (arcHeight), so the drawing and what it can hit agree.
        const k = Math.min(1, p.age / Math.max(0.05, p.flight));
        const h = arc(p) * m.s;
        const x = m.px(p.x), y = m.py(p.y), r = m.s * 0.26;
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.4, r * (1 - k * 0.1), r * 0.45, 0, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.translate(x, y - h);
        ctx.rotate(p.age * 9);
        ctx.fillStyle = '#8b7d6b';
        ctx.strokeStyle = '#4a4036';
        ctx.lineWidth = Math.max(1, r * 0.15);
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
            const a = (i / 7) * TAU, rr = r * (0.82 + ((i * 37) % 5) * 0.06);
            i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    },
    mend(ctx, p, m, time) {
        const x = m.px(p.x), y = m.py(p.y), r = m.s * 0.13;
        const len = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = 'rgba(157,255,176,0.7)';
        ctx.lineWidth = r * 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let i = 1; i <= 5; i++) {
            const bx = x - (p.vx / len) * r * i * 1.6, by = y - (p.vy / len) * r * i * 1.6;
            const wob = Math.sin(time * 20 + i) * r * 0.6;
            ctx.lineTo(bx - (p.vy / len) * wob, by + (p.vx / len) * wob);
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.fillStyle = '#e9fff0';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        // A little cross so a heal never reads as an attack.
        ctx.strokeStyle = '#2e9d4a';
        ctx.lineWidth = Math.max(1, r * 0.35);
        ctx.beginPath();
        ctx.moveTo(x - r * 0.6, y); ctx.lineTo(x + r * 0.6, y);
        ctx.moveTo(x, y - r * 0.6); ctx.lineTo(x, y + r * 0.6);
        ctx.stroke();
    },
};

export function createFx() {
    const particles = [];
    const popups = [];
    const blooms = [];
    let shake = 0;
    let stain = null;

    function burst(r, x, y, n, color, speed, life, size, gravity = 0) {
        for (let i = 0; i < n && particles.length < MAX_PARTICLES; i++) {
            const a = r() * TAU, v = speed * (0.4 + r() * 0.8);
            particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, age: 0, color, size: size * (0.6 + r() * 0.8), gravity, drag: 0.9 });
        }
    }

    function popup(x, y, text, color, big = false) {
        if (popups.length >= MAX_POPUPS) popups.shift();
        popups.push({ x, y, text, color, age: 0, life: 0.9, big });
    }

    function stainCtx() {
        if (!stain) {
            const w = ARENA_M.w * STAIN_PPM, h = ARENA_M.h * STAIN_PPM;
            stain = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        }
        return stain.getContext('2d');
    }

    /**
     * Bakes a soft splat into the floor (metres in, stain pixels out): a radial fade rather than a
     * flat polygon, plus a few droplets for death marks. Stains never fade, so each one is faint
     * on its own and a busy corner darkens gradually instead of tiling with hard-edged blobs.
     */
    function decal(x, y, color, size, kind) {
        const g = stainCtx();
        const cx = x * STAIN_PPM, cy = y * STAIN_PPM, r = size * STAIN_PPM;
        const soft = (px, py, pr, alpha) => {
            const grad = g.createRadialGradient(px, py, 0, px, py, pr);
            grad.addColorStop(0, color);
            grad.addColorStop(0.55, color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            g.globalAlpha = alpha;
            g.fillStyle = grad;
            g.beginPath();
            g.arc(px, py, pr, 0, TAU);
            g.fill();
        };
        soft(cx, cy, r, kind === 'death' ? 0.2 : 0.16);
        if (kind === 'death') {
            // Droplets, placed from the position so a replay lays the same ones.
            const r0 = rng(Math.round(x * 97) * 131 + Math.round(y * 89) + 7);
            for (let i = 0; i < 5; i++) {
                const a = r0() * TAU, d = r * (0.9 + r0() * 0.7);
                soft(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.12 + r0() * 0.14), 0.22);
            }
        }
        g.globalAlpha = 1;
    }

    return {
        get particleCount() { return particles.length; },
        get shakeAmount() { return shake; },

        /**
         * Turns one tick's events into visuals. `units` are the frame's views (metres), `tick`
         * seeds the randomness. `live` is false while scrubbing, when shake is suppressed.
         */
        onEvents(events, units, tick, { reduced = false, teamColor, live = true } = {}) {
            events.forEach((e, i) => {
                const r = rng(tick * 131 + i * 7919 + 17);
                const u = e.u !== undefined ? units[e.u] : null;
                const at = u ? { x: u.x, y: u.y } : { x: e.x, y: e.y };
                if (!at || !Number.isFinite(at.x)) return;
                const n = reduced ? 0.3 : 1;

                switch (e.type) {
                    case 'windup':
                        burst(r, at.x + Math.cos(u.facing) * 0.35, at.y + Math.sin(u.facing) * 0.35, Math.ceil(4 * n), '#ffffff', 1.2, 0.18, 0.05);
                        break;
                    case 'hit': {
                        if (e.kind === 'poison' || e.kind === 'tar') {
                            burst(r, at.x, at.y, 1, e.kind === 'tar' ? '#2a2018' : '#8ee060', 0.3, 0.6, 0.06, -0.8);
                            break;
                        }
                        const heavy = e.kind === 'boulder' || e.amount >= 15;
                        const color = e.kind === 'glob' ? '#9be35a' : e.kind === 'boulder' ? '#b8a88f' : '#ffe27a';
                        burst(r, at.x, at.y, Math.ceil((heavy ? 14 : 9) * n), color, heavy ? 3.2 : 2.4, 0.35, heavy ? 0.1 : 0.07);
                        popup(at.x, at.y - 0.4, `-${Math.max(1, Math.round(e.amount))}`, '#ff8a80', heavy);
                        if (e.kind === 'glob') decal(at.x, at.y, '#6fb83a', 0.35, 'splat');
                        if (e.kind === 'boulder') decal(at.x, at.y, '#5b5146', 0.45, 'crater');
                        if (live && !reduced && heavy) shake = Math.min(1, shake + (e.kind === 'boulder' ? 0.7 : 0.35));
                        break;
                    }
                    case 'block':
                        burst(r, at.x + Math.cos(u.facing) * 0.5, at.y + Math.sin(u.facing) * 0.5, Math.ceil(7 * n), '#e8f1ff', 2.6, 0.25, 0.06);
                        popup(at.x, at.y - 0.55, 'BLOCK', '#dfe9ff');
                        break;
                    case 'dodge':
                        popup(at.x, at.y - 0.5, 'miss', '#ffffff');
                        break;
                    case 'heal':
                        if (e.amount < 0.5) break;      // a mend on someone already full: no "+0"
                        burst(r, at.x, at.y, Math.ceil(10 * n), '#9dffb0', 1.2, 0.6, 0.06, -1.2);
                        popup(at.x, at.y - 0.4, `+${Math.round(e.amount)}`, '#7dff9a');
                        break;
                    case 'death':
                        burst(r, at.x, at.y, Math.ceil(18 * n), teamColor(u.team), 3.5, 0.6, 0.11);
                        decal(at.x, at.y, teamColor(u.team), 0.5, 'death');

                        if (live && !reduced) shake = Math.min(1, shake + 0.4);
                        break;
                    case 'ability':
                        if (e.ability === 'dodge_dash') burst(r, at.x, at.y, Math.ceil(8 * n), '#d9cbb0', 1.5, 0.35, 0.08);
                        if (e.ability === 'hard_shell') popup(at.x, at.y - 0.55, 'SHELL', '#e3e8f2');
                        if (e.ability === 'shield_brace') burst(r, at.x, at.y, Math.ceil(6 * n), '#d9cbb0', 0.8, 0.4, 0.07);
                        break;
                    case 'impact':
                    case 'fizzle':
                        // Stone chips, no caption: stacked "COVER" labels over a busy pillar were noise.
                        if (e.pillar) burst(r, e.x, e.y, Math.ceil(8 * n), '#bdb6a8', 2.2, 0.35, 0.06);
                        if (e.kind === 'boulder') burst(r, e.x, e.y, Math.ceil(10 * n), '#a8987f', 2, 0.5, 0.09);
                        if (e.kind === 'glob' && e.type === 'fizzle') decal(e.x, e.y, '#6fb83a', 0.25, 'splat');
                        break;
                    case 'panic':
                        if (e.on) popup(at.x, at.y - 0.6, 'PANIC', '#7fd0ff', true);
                        break;
                }
            });
        },

        /**
         * Scuffs the floor under every moving unit, every fourth tick, so the routes a fight
         * actually took wear in over the match. Live only: the Black Box replays onto a floor
         * that already holds the whole match.
         */
        trample(views, tick) {
            if (tick % 4) return;
            const g = stainCtx();
            g.fillStyle = '#000';
            g.globalAlpha = 0.035;
            for (const v of views) {
                if (!v.alive || Math.hypot(v.vx, v.vy) < 0.8) continue;
                g.beginPath();
                g.ellipse(v.x * STAIN_PPM, v.y * STAIN_PPM, 0.22 * STAIN_PPM, 0.14 * STAIN_PPM, Math.atan2(v.vy, v.vx), 0, TAU);
                g.fill();
            }
            g.globalAlpha = 1;
        },

        /** A Jev answer landed for a unit: open its bloom (replacing any still showing). */
        bloom(idx, d) {
            if (!d || !d.ok || !d.actionProbabilities) return;
            const probs = Object.entries(d.actionProbabilities).sort((a, b) => b[1] - a[1]).slice(0, 8);
            const at = blooms.findIndex(b => b.idx === idx);
            if (at >= 0) blooms.splice(at, 1);
            if (blooms.length >= MAX_BLOOMS) blooms.shift();
            blooms.push({ idx, probs, chosen: d.action, conf: d.actionConfidence || 0, age: 0 });
        },

        /** Victory confetti in the winners' colours, from the top edge (metres). */
        confetti(colors, seed) {
            const r = rng(seed * 977 + 3);
            for (let i = 0; i < 160 && particles.length < MAX_PARTICLES; i++) {
                particles.push({
                    x: r() * ARENA_M.w, y: -0.3 - r() * 1.5, vx: (r() - 0.5) * 1.5, vy: 1.5 + r() * 2.5,
                    life: 2.6 + r(), age: 0, color: colors[i % colors.length], size: 0.07 + r() * 0.05,
                    gravity: 2.2, drag: 0.985, rect: true, rot: r() * TAU, spin: (r() - 0.5) * 14,
                });
            }
        },

        update(dt) {
            for (const p of particles) {
                p.age += dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                p.vx *= p.drag; p.vy = p.vy * p.drag + p.gravity * dt;
                if (p.rect) p.rot += p.spin * dt;
            }
            for (const b of blooms) b.age += dt;
            for (let i = blooms.length - 1; i >= 0; i--) if (blooms[i].age >= BLOOM_LIFE_S) blooms.splice(i, 1);
            for (let i = particles.length - 1; i >= 0; i--) if (particles[i].age >= particles[i].life) particles.splice(i, 1);
            for (const p of popups) p.age += dt;
            for (let i = popups.length - 1; i >= 0; i--) if (popups[i].age >= popups[i].life) popups.splice(i, 1);
            shake = Math.max(0, shake - dt * 3);
        },

        drawStains(ctx, m) {
            if (stain) ctx.drawImage(stain, m.px(0), m.py(0), ARENA_M.w * m.s, ARENA_M.h * m.s);
        },

        /** The petals over each unit that just heard back from Jev. views are metres; m maps them. */
        drawBlooms(ctx, m, views, time, teamColor, reduced) {
            for (const b of blooms) {
                const v = views[b.idx];
                if (!v || !v.alive) continue;
                const k = b.age / BLOOM_LIFE_S;
                let alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
                if (b.conf < COIN_FLIP && !reduced) alpha *= 0.55 + 0.45 * Math.abs(Math.sin(time * 37 + b.idx));
                const grow = reduced ? 1 : Math.min(1, 0.6 + k * 2);
                const x = m.px(v.x), y = m.py(v.y), R = m.s * 0.5 * grow;
                const n = b.probs.length, half = (TAU / n) * 0.36;
                ctx.save();
                ctx.translate(x, y);
                b.probs.forEach(([option, p], i) => {
                    const a = -Math.PI / 2 + i * (TAU / Math.max(1, n));
                    const len = R * (0.7 + 2.4 * p);
                    ctx.globalAlpha = alpha * (option === b.chosen ? 0.9 : 0.45);
                    ctx.fillStyle = option === b.chosen ? teamColor(v.team) : '#ffffff';
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55);
                    ctx.quadraticCurveTo(Math.cos(a - half) * len, Math.sin(a - half) * len, Math.cos(a) * len, Math.sin(a) * len);
                    ctx.quadraticCurveTo(Math.cos(a + half) * len, Math.sin(a + half) * len, Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55);
                    ctx.fill();
                });
                ctx.globalAlpha = alpha * 0.8;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = Math.max(1, m.k * 1.5);
                ctx.beginPath(); ctx.arc(0, 0, R * 0.55, 0, TAU); ctx.stroke();
                ctx.restore();
            }
            ctx.globalAlpha = 1;
        },

        drawProjectiles(ctx, projectiles, m, time) {
            for (const p of projectiles) (PROJECTILES[p.kind] || PROJECTILES.glob)(ctx, p, m, time);
        },

        drawParticles(ctx, m) {
            for (const p of particles) {
                ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
                ctx.fillStyle = p.color;
                if (p.rect) {
                    // Confetti: a spinning slip that flattens as it turns edge-on.
                    const s = Math.max(1.5, p.size * m.s);
                    ctx.save();
                    ctx.translate(m.px(p.x), m.py(p.y));
                    ctx.rotate(p.rot);
                    ctx.fillRect(-s, -s * 0.45 * Math.abs(Math.cos(p.rot * 1.7)), s * 2, s * 0.9 * Math.abs(Math.cos(p.rot * 1.7)) + 0.5);
                    ctx.restore();
                    continue;
                }
                ctx.beginPath();
                ctx.arc(m.px(p.x), m.py(p.y), Math.max(1, p.size * m.s), 0, TAU);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        },

        drawPopups(ctx, m) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const p of popups) {
                const k = p.age / p.life;
                ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
                const size = Math.max(10, m.s * (p.big ? 0.42 : 0.32)) * (k < 0.12 ? 0.7 + k * 2.5 : 1);
                ctx.font = `800 ${size}px system-ui, sans-serif`;
                const x = m.px(p.x), y = m.py(p.y) - k * m.s * 0.8;
                ctx.lineWidth = Math.max(2, size * 0.18);
                ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                ctx.strokeText(p.text, x, y);
                ctx.fillStyle = p.color;
                ctx.fillText(p.text, x, y);
            }
            ctx.globalAlpha = 1;
        },

        /** Clears transient visuals (Black Box jumps, so stale sparks don't linger); the floor stays. */
        clear() {
            particles.length = 0;
            popups.length = 0;
            blooms.length = 0;
            shake = 0;
        },

    };
}
