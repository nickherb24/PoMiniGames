// pojevarena/sim.js — the pure 60 Hz battle simulation.
//
// No DOM, no fetch, no Date.now(): time is the tick counter and the only randomness is the
// seeded spawn jitter, so `node` can drive a whole match headlessly and the same seed plus the
// same decisions replays the same fight. Decisions come in through applyDecision() (from Jev,
// via scheduler.js); the physics never decides anything itself — it only carries out the
// latest intent, and holds it indefinitely when Jev is late (the user's call, SPEC §4.5).
//
// Units are metres and seconds throughout; render.js scales by PPM (40 px = 1 m).
//
// Hazards (ARENAS below) are static and chosen by the seed, so they replay with the match:
// pillars block bodies and projectiles and are what Jev's take_cover option hides behind, brush
// softens ranged hits on whoever stands in it, and tar slows and burns.

import { HANDLERS } from './abilities.js';

export const PPM = 40;
export const ARENA_W = 800 / PPM;   // 20 m
export const ARENA_H = 600 / PPM;   // 15 m
export const DT = 1 / 60;
export const MATCH_SECONDS = 180;

// ── Locomotion: forces on Earth ─────────────────────────────────────────────
// Nothing moves because a velocity was set. Legs push against the ground; how hard is capped by
// grip (μ·m·g) and by leg power (P/v, so pushing gets harder the faster you already go), and the
// work they do comes out of an energy reserve. A body with no footing (reeling from a blow, or
// shelled) skids to a stop on kinetic friction; air drag and tar resist everyone. Speeds are the
// creature's own `moveSpeed` (cruise) and SPRINT × that at full effort.
const G = 9.81;                                  // m/s²
export const KG_PER_MASS = 24;                   // design mass 1-5 → 24-120 kg
const MU_GRIP = 0.8;                             // feet on packed dirt: legs max out at 7.8 m/s²
const MU_BURST = 1.15;                           // an explosive push (lunge, dodge) briefly out-grips a stride
const MU_PLANTED = 1.2;                          // braced: feet dug in
const MU_SLIDE = 0.5;                            // a body skidding with no footing
const MU_SHELL = 0.6;                            // a shell grinding on the dirt
const TAR_GRIP = 0.35;                           // × grip in tar
const TAR_VISCOSITY = 1.6;                       // N per (m/s) per kg of drag in tar
const AIR = 0.5 * 1.2 * 0.9;                     // ½ρCd: drag = AIR × frontal area × v²
const RESPONSE = 6;                              // 1/s: legs chase the wanted velocity at RESPONSE·Δv (then capped)
const BURST_RESPONSE = 18;
const SPRINT = 1.5;                              // top speed at full effort, × cruise
const LUNGE_EFFORT = 2.2;
const DODGE_EFFORT = 2.2;
const MAX_SPEED = 20;                            // m/s: a safety rail, never reached by legs

// Energy: critical-power model. Below critical power (CP) the reserve refills by the gap; above
// it the excess drains the finite anaerobic reserve (W′). Steady cruising sits just under CP, so
// it is sustainable; sprinting and every acceleration burst spend the reserve, and an emptied
// reserve leaves only FATIGUED_POWER of peak leg power until it recovers.
const GAIT_COST = 1.0;                           // W/kg per m/s: every stride costs, even at steady speed
const BRAKE_COST = 0.3;                          // braking (eccentric) work costs ~1/3 of pushing
const CP_MARGIN = 1.0;                           // W/kg of headroom over cruising cost (covers air drag at cruise)
const PEAK_POWER_PER_SPEED = 3.2;                // W/kg per m/s of sprint speed
const RESERVE_PER_KG = 120;                      // J/kg of W′
const FATIGUED_POWER = 0.4;
const WINDED = 0.15;                             // below this share of reserve, no more sprinting

const WALL_RESTITUTION = 0.5;
const BODY_RESTITUTION = 0.3;
const PANIC_THRESHOLD = 0.70;
const UNDER_FIRE_SECONDS = 1.5;
const ALLY_NEAR_M = 4;

// Melee, for every creature (SPEC §4.3).
const STRIKE_REACH_M = 0.3;
const STRIKE_WINDUP_S = 0.12;
const STRIKE_LUNGE_S = 0.22;                     // an explosive step: time to cover the reach from a standstill
const STRIKE_COOLDOWN_S = 1.0;

// Hit reactions: every blow shoves the one it lands on, away from where it came from. Impulses
// are N·s-ish (they are divided by the victim's effective mass, so bracing and shelling resist),
// the victim's closing speed toward the blow is cancelled first so a charging unit is really
// stopped, and a short stagger keeps its own steering from immediately eating the shove.
const MELEE_IMPULSE_PER_MASS = 2.2;              // × attacker mass
const GLOB_IMPULSE = 3;
const BOULDER_IMPULSE_PER_MASS = 3;              // × thrower mass (the registry row's `knock`)
const MAX_KNOCK_MS = 6;
const STAGGER_MIN_S = 0.18, STAGGER_MAX_S = 0.45, STAGGER_PER_MS = 0.05;

// Colliders are sized to the drawn silhouette (body plus the plates and feet around it), not to
// the bare body circle render.js starts from — at 1.0 neighbours visibly sank into each other.
const COLLIDER_SCALE = 1.15;
const CONTACT_ITERATIONS = 3;

// Damage pipeline factors (registry Power values win where an ability carries them).
const SHELL_FACTOR = 0.6;
const BRACE_FACTOR = 0.4;
const BRACE_ARC_COS = Math.cos(Math.PI / 3);     // front 120 degrees
const POISON_DPS = 2;
const TAR_DPS = 2;
const BRUSH_RANGED_FACTOR = 0.7;
const COVER_GAP_M = 0.15;
const AVOID_LOOKAHEAD_M = 1.2;

// Every blow's damage, after the formulas above. The PRD numbers make a 10v10 blob of focus
// fire end in ~25 s at designed HP; halving them was the tuned pace until 2026-09-30, when the
// user asked for five times fewer hit points — see battleHp. One knob, applied in applyDamage.
const DAMAGE_SCALE = 0.5;

/**
 * A creature's HP in battle: its designed HP (50-500, what the build budget prices and the library
 * stores) divided by 5. Mirrors PoJevArenaRules.BattleHp, which the server uses to check and word
 * the HP the scheduler reports, so the two must change together.
 */
export const BATTLE_HP_DIVISOR = 5;
export const battleHp = (designedHp) => Math.max(1, Math.round(designedHp / BATTLE_HP_DIVISOR));

/**
 * The three arena layouts, in metres (arena 20 x 15). Everything sits in the x 6-14 band so the
 * spawn circles (x < 5, x > 15) stay clear. The seed picks one, so a replay rebuilds the same map.
 */
export const ARENAS = [
    {
        name: 'Four Pillars',
        pillars: [{ x: 7, y: 4.2, r: 0.6 }, { x: 13, y: 4.2, r: 0.6 }, { x: 7, y: 10.8, r: 0.6 }, { x: 13, y: 10.8, r: 0.6 }],
        brush: [{ x: 10, y: 2.2, r: 1.5 }, { x: 10, y: 12.8, r: 1.5 }],
        tar: [{ x: 10, y: 7.5, r: 1.2 }],
    },
    {
        name: 'The Diamond',
        pillars: [{ x: 10, y: 4, r: 0.7 }, { x: 10, y: 11, r: 0.7 }, { x: 7.6, y: 7.5, r: 0.55 }, { x: 12.4, y: 7.5, r: 0.55 }],
        brush: [{ x: 7, y: 2.6, r: 1.3 }, { x: 13, y: 12.4, r: 1.3 }, { x: 7, y: 12.4, r: 1.3 }, { x: 13, y: 2.6, r: 1.3 }],
        tar: [],
    },
    {
        name: 'Tar Mire',
        pillars: [{ x: 8.4, y: 5, r: 0.6 }, { x: 11.6, y: 10, r: 0.6 }],
        brush: [{ x: 6.8, y: 11.5, r: 1.4 }, { x: 13.2, y: 3.5, r: 1.4 }],
        tar: [{ x: 10, y: 7.5, r: 1.9 }],
    },
];

export const arenaFor = (seed) => ARENAS[(seed >>> 0) % ARENAS.length];

/** mulberry32 — tiny seeded PRNG; the sim's only randomness is spawn jitter. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function radiusFor(mass) { return ((10 + 3 * mass) / PPM) * COLLIDER_SCALE; }

/**
 * Builds a match. `blue`/`red` are the frozen ArenaCreature rows from the match ticket;
 * `abilities` is PoJevArenaCatalog.Abilities (the tuning source).
 */
export function createWorld({ seed, blue, red, abilities }) {
    const defs = new Map(abilities.map(a => [a.id, a]));
    const rng = mulberry32(seed);
    const units = [];
    const spawn = (roster, isBlue) => {
        const cx = (isBlue ? 130 : 670) / PPM, cy = 300 / PPM;
        roster.forEach((creature, slot) => {
            // 7 on an outer ring, 3 inside, with a little seeded jitter; overlaps settle on tick 1.
            const outer = slot < 7;
            const ring = outer ? 1.55 : 0.55;
            // Red's formation is Blue's mirrored across the centre line, so slot N faces slot N.
            const base = (outer ? slot / 7 : (slot - 7) / 3) * Math.PI * 2 + rng() * 0.3;
            const angle = isBlue ? base : Math.PI - base;
            const r = radiusFor(creature.mass);
            const kg = creature.mass * KG_PER_MASS;
            const reserve = kg * RESERVE_PER_KG;
            units.push({
                idx: units.length,
                slot,
                team: isBlue ? 'blue' : 'red',
                label: `${isBlue ? 'Blue' : 'Red'}-${String(slot + 1).padStart(2, '0')}`,
                creature,
                name: creature.name,
                maxHp: battleHp(creature.maxHp),
                hp: battleHp(creature.maxHp),
                alive: true,
                mass: creature.mass,
                kg,
                speed: creature.moveSpeed,
                r,
                reserve,
                reserveMax: reserve,
                cp: kg * (GAIT_COST * creature.moveSpeed + CP_MARGIN),
                pPeak: kg * PEAK_POWER_PER_SPEED * creature.moveSpeed * SPRINT,
                ax: 0, ay: 0,
                x: cx + Math.cos(angle) * ring + (rng() - 0.5) * 0.2,
                y: cy + Math.sin(angle) * ring + (rng() - 0.5) * 0.2,
                vx: 0,
                vy: 0,
                facing: isBlue ? 0 : Math.PI,
                intent: { action: 'idle', focus: null, target: -1, panicked: false, decided: false, since: 0 },
                abil: (creature.abilities || []).map(id => ({ id, def: defs.get(id), cd: 0 })).filter(a => a.def),
                strike: { phase: 0, t: 0, cd: 0, target: -1, landed: false },
                cast: null,
                braced: false,
                shell: 0,
                invuln: 0,
                dash: 0, dashDx: 0, dashDy: 0,
                poison: 0,
                stagger: 0,
                lastHitTime: -99,
                deathTime: -1,
                kills: 0,
                dealt: 0,
                healed: 0,
            });
        });
    };
    spawn(blue, true);
    spawn(red, false);

    return {
        seed, tick: 0, time: 0, units, projectiles: [], events: [], pending: [],
        over: false, winner: null, nextProjectileId: 1, arena: arenaFor(seed),
    };
}

// ── Queries ──────────────────────────────────────────────────────────────────

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const edge = (a, b) => Math.max(0, dist(a, b) - a.r - b.r);
const enemiesOf = (w, u) => w.units.filter(o => o.alive && o.team !== u.team);
const alliesOf = (w, u) => w.units.filter(o => o.alive && o.team === u.team && o !== u);
const hpPct = (u) => u.hp / u.maxHp;
const inside = (zones, u) => zones.some(z => Math.hypot(u.x - z.x, u.y - z.y) <= z.r);

function nearestPillar(w, u) {
    let best = null, bd = Infinity;
    for (const p of w.arena.pillars) { const d = Math.hypot(p.x - u.x, p.y - u.y) - p.r; if (d < bd) { bd = d; best = p; } }
    return best;
}

function nearest(list, u) {
    let best = null, bd = Infinity;
    for (const o of list) { const d = dist(u, o); if (d < bd) { bd = d; best = o; } }
    return best;
}

function isRanged(unit) {
    return unit.abil.some(a => HANDLERS[a.id]?.ranged);
}

export function teamCounts(w) {
    let blue = 0, red = 0;
    for (const u of w.units) if (u.alive) (u.team === 'blue' ? blue++ : red++);
    return { blue, red };
}

/**
 * Everything the scheduler sends for one unit (the server's ArenaUnitState shape) plus the
 * focus → unit index map needed to resolve Jev's target_focus answer back to a unit.
 */
export function measure(w, idx) {
    const u = w.units[idx];
    const enemies = enemiesOf(w, u);
    const allies = alliesOf(w, u);
    const candidates = {};
    const put = (focus, o) => { if (o) candidates[focus] = o.idx; };

    put('nearest_threat', nearest(enemies, u));
    put('weakest_target', enemies.reduce((b, o) => (!b || hpPct(o) < hpPct(b) ? o : b), null));
    put('strongest_threat', enemies.reduce((b, o) => (!b || o.hp > b.hp ? o : b), null));
    put('ranged_threat', nearest(enemies.filter(isRanged), u));
    const hurt = allies.filter(a => a.hp < a.maxHp);
    put('protect_ally', hurt.length ? hurt.reduce((b, o) => (hpPct(o) < hpPct(b) ? o : b)) : nearest(allies, u));

    const counts = teamCounts(w);
    const round1 = (v) => Math.round(v * 10) / 10;
    return {
        candidates,
        state: {
            unit: u.label,
            hp: Math.max(1, Math.ceil(u.hp)),
            abilityCooldowns: u.abil.map(a => round1(Math.max(0, a.cd))),
            poisoned: u.poison > 0,
            underFire: w.time - u.lastHitTime < UNDER_FIRE_SECONDS,
            alliesNear: Math.min(9, allies.filter(a => dist(u, a) <= ALLY_NEAR_M).length),
            candidates: Object.entries(candidates).map(([focus, i]) => ({
                focus,
                unit: w.units[i].label,
                distanceM: Math.min(25, round1(edge(u, w.units[i]))),
                hpPercent: Math.round(100 * hpPct(w.units[i])),
            })),
            blueAlive: counts.blue,
            redAlive: counts.red,
            coverDistanceM: coverDistance(w, u),
            stamina: Math.round(100 * u.reserve / u.reserveMax),
            inBrush: inside(w.arena.brush, u),
            inTar: inside(w.arena.tar, u),
        },
    };
}

/** Edge-to-edge metres to the nearest pillar, or -1 on a map without any (the prompt's contract). */
function coverDistance(w, u) {
    const p = nearestPillar(w, u);
    if (!p) return -1;
    return Math.min(25, Math.round(Math.max(0, Math.hypot(p.x - u.x, p.y - u.y) - p.r - u.r) * 10) / 10);
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * Applies one Jev answer. `candidates` is the focus → index map from the measure() that produced
 * the request, so the target is the unit Jev was actually shown. panic > 0.70 overrides combat.
 */
export function applyDecision(w, idx, decision, candidates) {
    const u = w.units[idx];
    if (!u || !u.alive) return;
    const intent = u.intent;
    const wasPanicked = intent.panicked;

    intent.action = decision.action || intent.action;
    if (decision.focus && candidates && candidates[decision.focus] !== undefined) {
        intent.focus = decision.focus;
        intent.target = candidates[decision.focus];
    }
    intent.panicked = (decision.panic ?? 0) > PANIC_THRESHOLD;
    intent.decided = true;
    intent.since = w.time;
    // Decisions land between ticks; queue the event so the next step() reports it.
    if (intent.panicked !== wasPanicked) w.pending.push({ type: 'panic', u: idx, on: intent.panicked });
}

// ── Damage ───────────────────────────────────────────────────────────────────

/**
 * The one damage pipeline, so defences stack predictably:
 * invulnerable → 0; else × (1 − shell); × (1 − brace) if the blow lands in the front arc.
 * Poison skips the brace (it is already inside) but not the shell.
 */
export function applyDamage(w, u, amount, kind, fromX, fromY, source = -1) {
    if (!u.alive || amount <= 0) return 0;
    const dot = kind === 'poison' || kind === 'tar';
    if (u.invuln > 0) {
        // A dodged blow is worth showing; a dodged poison/tar tick (60 a second) is noise.
        if (!dot) w.events.push({ type: 'dodge', u: u.idx });
        return 0;
    }

    let dmg = amount * DAMAGE_SCALE;
    if (u.shell > 0) dmg *= 1 - shellFactor(u);
    if ((kind === 'glob' || kind === 'boulder') && inside(w.arena.brush, u)) dmg *= BRUSH_RANGED_FACTOR;
    if (u.braced && !dot) {
        const dx = fromX - u.x, dy = fromY - u.y, len = Math.hypot(dx, dy) || 1;
        const cos = (dx * Math.cos(u.facing) + dy * Math.sin(u.facing)) / len;
        if (cos >= BRACE_ARC_COS) {
            dmg *= 1 - braceFactor(u);
            w.events.push({ type: 'block', u: u.idx });
        }
    }

    if (!dot) knockBack(w, u, fromX, fromY, kind, source);
    u.hp = Math.max(0, u.hp - dmg);
    if (source >= 0) w.units[source].dealt += dmg;
    if (dot) {
        // Poison and tar tick every frame; report it once per whole HP lost so the event stream (and
        // the Black Box recording it) stays proportional to what a viewer can actually see.
        u.poisonAcc = (u.poisonAcc || 0) + dmg;
        if (u.poisonAcc >= 1 || u.hp <= 0) {
            w.events.push({ type: 'hit', u: u.idx, kind, amount: u.poisonAcc, source });
            u.poisonAcc = 0;
        }
    } else {
        u.lastHitTime = w.time;
        w.events.push({ type: 'hit', u: u.idx, kind, amount: dmg, source });
    }

    if (u.hp <= 0) {
        u.alive = false;
        u.deathTime = w.time;
        u.vx = u.vy = 0;
        if (source >= 0) w.units[source].kills++;
        w.events.push({ type: 'death', u: u.idx, source });
    }
    return dmg;
}

/**
 * The shove a landed blow gives its victim: along the line from where the blow came from, sized
 * by the blow's impulse over the victim's effective mass, capped, with a stagger that grows with
 * it. Dodged blows never get here (applyDamage returns first), and damage-over-time never shoves.
 */
function knockBack(w, u, fromX, fromY, kind, source) {
    const src = source >= 0 ? w.units[source] : null;
    const impulse = kind === 'melee' ? MELEE_IMPULSE_PER_MASS * (src ? src.mass : 1)
        : kind === 'boulder' ? BOULDER_IMPULSE_PER_MASS * (src ? src.mass : 1)
        : kind === 'glob' ? GLOB_IMPULSE : 0;
    if (impulse <= 0) return;
    let nx = u.x - fromX, ny = u.y - fromY;
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) return;
    nx /= len; ny /= len;
    const closing = u.vx * nx + u.vy * ny;
    if (closing < 0) { u.vx -= closing * nx; u.vy -= closing * ny; }
    const dv = Math.min(MAX_KNOCK_MS, impulse / effectiveMass(u));
    u.vx += nx * dv;
    u.vy += ny * dv;
    u.stagger = Math.max(u.stagger, Math.min(STAGGER_MAX_S, STAGGER_MIN_S + dv * STAGGER_PER_MS));
}

const shellFactor = (u) => u.abil.find(a => a.id === 'hard_shell')?.def.power ?? SHELL_FACTOR;
const braceFactor = (u) => u.abil.find(a => a.id === 'shield_brace')?.def.power ?? BRACE_FACTOR;

export function heal(w, u, amount, source) {
    if (!u.alive) return 0;
    const healed = Math.min(amount, u.maxHp - u.hp);


    u.hp += healed;
    if (source >= 0 && w.units[source]) w.units[source].healed += healed;
    w.events.push({ type: 'heal', u: u.idx, amount: healed, source });
    return healed;
}

// ── The kit handed to ability handlers (keeps abilities.js free of an import cycle) ──

const kit = {
    dist, edge, nearest, enemiesOf, alliesOf, hpPct,
    ready: (a) => a.cd <= 0,
    towards: (u, t, k = 1) => steer(t.x - u.x, t.y - u.y, k),
    away: (u, t, k = 1) => steer(u.x - t.x, u.y - t.y, k),
    hold: () => ({ x: 0, y: 0, k: 0 }),
    /** Starts a wind-up; the handler's release() runs when it completes. */
    cast(w, u, a, target, windup) {
        u.cast = { id: a.id, t: 0, windup, target };
        w.events.push({ type: 'cast', u: u.idx, ability: a.id, windup });
    },
    fire(w, u, spec) {
        const t = w.units[spec.target];
        const dx = t.x - u.x, dy = t.y - u.y, len = Math.hypot(dx, dy) || 1;
        w.projectiles.push({
            id: w.nextProjectileId++, kind: spec.kind, team: u.team, source: u.idx, target: spec.target,
            x: u.x + (dx / len) * u.r, y: u.y + (dy / len) * u.r,
            vx: (dx / len) * spec.speed, vy: (dy / len) * spec.speed,
            speed: spec.speed, ttl: spec.ttl, age: 0, flight: Math.max(0.05, (len - u.r) / spec.speed),
            power: spec.power, poison: spec.poison || 0,
            heals: !!spec.heals, homing: !!spec.homing,
        });
    },
    ability(w, u, id) { w.events.push({ type: 'ability', u: u.idx, ability: id }); },
};

function steer(dx, dy, k) {
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? { x: 0, y: 0, k: 0 } : { x: dx / len, y: dy / len, k };
}

// ── Step ─────────────────────────────────────────────────────────────────────

export function step(w, dt = DT) {
    if (w.over) return;
    w.events.length = 0;
    if (w.pending.length) { w.events.push(...w.pending); w.pending.length = 0; }

    for (const u of w.units) if (u.alive) think(w, u, dt);
    for (const u of w.units) if (u.alive) integrate(u, dt, w);
    collide(w);
    for (const u of w.units) if (u.alive) confine(u, w);
    for (const u of w.units) if (u.alive) melee(w, u, dt);
    moveProjectiles(w, dt);
    for (const u of w.units) if (u.alive) tickStatus(w, u, dt);

    w.tick++;
    w.time = w.tick * dt;
    checkEnd(w);
}

/** Turns the current intent into a steering command, and runs ability handlers. */
function think(w, u, dt) {
    u.braced = false;
    for (const a of u.abil) a.cd = Math.max(0, a.cd - dt);
    u.strike.cd = Math.max(0, u.strike.cd - dt);

    const intent = u.intent;
    let target = intent.target >= 0 ? w.units[intent.target] : null;
    const wantsAlly = intent.focus === 'protect_ally';
    if (!target || !target.alive || (target.team === u.team) !== wantsAlly) {
        // The focus died (or never existed): fall back to the obvious one until Jev re-decides.
        target = wantsAlly ? nearest(alliesOf(w, u), u) : nearest(enemiesOf(w, u), u);
        intent.target = target ? target.idx : -1;
    }

    let cmd = kit.hold();
    if (u.cast) {
        cmd = kit.hold();                          // planted while winding up
    } else if (intent.panicked) {
        const walls = [[0, u.y], [ARENA_W, u.y], [u.x, 0], [u.x, ARENA_H]];
        const [wx, wy] = walls.reduce((b, p) => (Math.hypot(p[0] - u.x, p[1] - u.y) < Math.hypot(b[0] - u.x, b[1] - u.y) ? p : b));
        cmd = steer(wx - u.x, wy - u.y, SPRINT);          // panic runs flat out, for as long as the reserve lasts
    } else {
        const action = intent.action;
        const ability = u.abil.find(a => a.def.jevOption === action);
        if (ability && HANDLERS[ability.id]) {
            cmd = HANDLERS[ability.id].run(w, u, ability, target, kit) || kit.hold();
        } else if (action === 'melee_charge' && target && target.team !== u.team) {
            cmd = kit.towards(u, target, 1.5);
        } else if (action === 'peel_to_ally') {
            const ally = nearest(alliesOf(w, u), u);
            cmd = ally && edge(u, ally) > 0.6 ? kit.towards(u, ally, 1) : kit.hold();
        } else if (action === 'fall_back' || action === 'take_cover') {
            const threat = nearest(enemiesOf(w, u), u);
            const pillar = action === 'take_cover' ? nearestPillar(w, u) : null;
            if (pillar && threat) {
                // The spot on the pillar's far side from the threat, just clear of the stone.
                const dx = pillar.x - threat.x, dy = pillar.y - threat.y, len = Math.hypot(dx, dy) || 1;
                const gap = pillar.r + u.r + COVER_GAP_M;
                const sx = pillar.x + (dx / len) * gap, sy = pillar.y + (dy / len) * gap;
                cmd = Math.hypot(sx - u.x, sy - u.y) > 0.25 ? steer(sx - u.x, sy - u.y, 1) : kit.hold();
            } else {
                cmd = threat ? kit.away(u, threat, 1) : kit.hold();
            }
        }
    }
    cmd = avoidPillars(w, u, cmd);

    if (u.shell > 0 || u.braced || u.stagger > 0) cmd = kit.hold();
    // The lunge is an explosive step at the one it is striking.
    if (u.strike.phase === 2 && u.stagger <= 0) {
        const t = w.units[u.strike.target];
        if (t && t.alive) cmd = kit.towards(u, t, LUNGE_EFFORT);
    }
    u.cmd = cmd;

    // Face the target (or the way we're going); a braced unit squares up to the nearest threat.
    const faceAt = u.braced ? nearest(enemiesOf(w, u), u) : (intent.panicked ? null : target);
    const desired = faceAt ? Math.atan2(faceAt.y - u.y, faceAt.x - u.x)
        : (Math.hypot(u.vx, u.vy) > 0.2 ? Math.atan2(u.vy, u.vx) : u.facing);
    let diff = desired - u.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    u.facing += diff * Math.min(1, dt * 10);

    // Ability wind-ups complete here.
    if (u.cast) {
        u.cast.t += dt;
        if (u.cast.t >= u.cast.windup) {
            const cast = u.cast;
            u.cast = null;
            const a = u.abil.find(x => x.id === cast.id);
            const t = w.units[cast.target];
            if (a && t && t.alive) HANDLERS[a.id].release(w, u, a, t, kit);
        }
    }
}

/**
 * Bends a steering command around a pillar in the way, so a unit sent straight at a target
 * behind one slides past instead of pinning itself to the stone. The side is picked once per
 * pillar and kept while that pillar stays in the way: re-picking every tick dithers when the
 * target circles the stone, and the unit stalls against it. Geometry and slot pick the side,
 * never randomness, so replays agree.
 */
function avoidPillars(w, u, cmd) {
    if (!cmd.k) return cmd;
    const pillars = w.arena.pillars;
    for (let i = 0; i < pillars.length; i++) {
        const p = pillars[i];
        const dx = p.x - u.x, dy = p.y - u.y;
        const ahead = dx * cmd.x + dy * cmd.y;
        const clear = p.r + u.r + 0.05;
        if (ahead <= 0 || ahead > clear + AVOID_LOOKAHEAD_M) continue;
        const across = dx * cmd.y - dy * cmd.x;          // signed offset of the pillar from the path
        if (Math.abs(across) >= clear) continue;
        if (u.avoid?.pillar !== i) u.avoid = { pillar: i, side: across === 0 ? (u.slot % 2 ? 1 : -1) : Math.sign(across) };
        const side = u.avoid.side;
        return steer(cmd.x + side * cmd.y * 1.2, cmd.y - side * cmd.x * 1.2, cmd.k);
    }
    u.avoid = null;
    return cmd;
}


/**
 * One tick of locomotion: the legs' force (the only one that costs energy), then friction, drag
 * and tar, integrated semi-implicitly; then the energy book-keeping. `u.ax/ay` is the net
 * acceleration, which the renderer turns into lean.
 */
function integrate(u, dt, w) {
    const tar = inside(w.arena.tar, u);
    const vx = u.vx, vy = u.vy, sp = Math.hypot(vx, vy);
    const footing = u.stagger <= 0 && u.shell <= 0;
    const burst = u.dash > 0 || u.strike.phase === 2;
    let lx = 0, ly = 0;                                        // leg acceleration, m/s²

    if (footing) {
        // The velocity the unit is trying to have.
        let wx = 0, wy = 0;
        if (u.dash > 0) {
            wx = u.dashDx * u.speed * DODGE_EFFORT; wy = u.dashDy * u.speed * DODGE_EFFORT;
        } else if (!u.braced) {
            const c = u.cmd;
            const effort = !burst && u.reserve < u.reserveMax * WINDED ? Math.min(1, c.k) : c.k;
            wx = c.x * u.speed * effort; wy = c.y * u.speed * effort;
        }
        const k = burst ? BURST_RESPONSE : RESPONSE;
        lx = k * (wx - vx); ly = k * (wy - vy);

        // Grip: no leg can push harder than friction lets it.
        const grip = (u.braced ? MU_PLANTED : burst ? MU_BURST : MU_GRIP) * (tar ? TAR_GRIP : 1) * G;
        const a = Math.hypot(lx, ly);
        if (a > grip) { lx *= grip / a; ly *= grip / a; }

        // Power: pushing along the motion costs force × speed, and leg power is finite (less when tired).
        const fresh = u.reserve / u.reserveMax;
        const pAvail = u.pPeak * (FATIGUED_POWER + (1 - FATIGUED_POWER) * fresh) * (burst ? 1.3 : 1);
        const push = (lx * vx + ly * vy) * u.kg;
        if (push > pAvail) { lx *= pAvail / push; ly *= pAvail / push; }
    }

    // Passive forces, as accelerations.
    let px = 0, py = 0;
    if (sp > 1e-6) {
        const ux = vx / sp, uy = vy / sp;
        let decel = AIR * (2 * u.r) * sp * sp / u.kg;          // air drag on a body 2r wide, 1 m tall
        if (!footing) decel += (u.shell > 0 ? MU_SHELL : MU_SLIDE) * G;
        if (tar) decel += TAR_VISCOSITY * sp;
        decel = Math.min(decel, sp / dt);                       // friction stops a body, never reverses it
        px = -ux * decel; py = -uy * decel;
    }

    u.ax = lx + px; u.ay = ly + py;
    u.vx += u.ax * dt;
    u.vy += u.ay * dt;
    const v = Math.hypot(u.vx, u.vy);
    if (v > MAX_SPEED) { u.vx *= MAX_SPEED / v; u.vy *= MAX_SPEED / v; }

    // Energy: leg work (braking at a third of the price) plus the cost of striding at this speed.
    const legPower = (lx * vx + ly * vy) * u.kg;
    const spend = Math.max(0, legPower) + BRAKE_COST * Math.max(0, -legPower) + (footing && sp > 0.2 ? GAIT_COST * u.kg * sp : 0);
    u.reserve = Math.max(0, Math.min(u.reserveMax, u.reserve + (u.cp - spend) * dt));

    u.x += u.vx * dt;
    u.y += u.vy * dt;
    confine(u, w);
}

/** Pillar and wall bounce; also re-run after contacts, since de-penetration can push a body into either. */
function confine(u, w) {
    for (const p of w.arena.pillars) {
        const dx = u.x - p.x, dy = u.y - p.y, d = Math.hypot(dx, dy), min = p.r + u.r;
        if (d >= min) continue;
        const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0;
        u.x = p.x + nx * min; u.y = p.y + ny * min;
        const into = u.vx * nx + u.vy * ny;
        if (into < 0) { u.vx -= (1 + WALL_RESTITUTION) * into * nx; u.vy -= (1 + WALL_RESTITUTION) * into * ny; }
    }
    if (u.x < u.r) { u.x = u.r; u.vx = Math.abs(u.vx) * WALL_RESTITUTION; }
    if (u.x > ARENA_W - u.r) { u.x = ARENA_W - u.r; u.vx = -Math.abs(u.vx) * WALL_RESTITUTION; }
    if (u.y < u.r) { u.y = u.r; u.vy = Math.abs(u.vy) * WALL_RESTITUTION; }
    if (u.y > ARENA_H - u.r) { u.y = ARENA_H - u.r; u.vy = -Math.abs(u.vy) * WALL_RESTITUTION; }
}

const effectiveMass = (u) => u.mass * (u.braced ? 3 : 1) * (u.shell > 0 ? 3 : 1);

/**
 * Circle–circle contacts: mass-weighted positional de-penetration, relaxed over a few passes so a
 * scrum settles instead of sinking into itself, and one restitution impulse per contact (first
 * pass only, so a pile does not bounce harder the more passes it takes). The dead no longer block.
 */
function collide(w) {
    for (let pass = 0; pass < CONTACT_ITERATIONS; pass++) contactPass(w, pass === 0);
}

function contactPass(w, impulses) {
    const us = w.units;
    for (let i = 0; i < us.length; i++) {
        const a = us[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < us.length; j++) {
            const b = us[j];
            if (!b.alive) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy), min = a.r + b.r;
            if (d >= min) continue;
            const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0;
            const ma = effectiveMass(a), mb = effectiveMass(b);
            const ia = 1 / ma, ib = 1 / mb;
            const push = (min - d) / (ia + ib);
            a.x -= nx * push * ia; a.y -= ny * push * ia;
            b.x += nx * push * ib; b.y += ny * push * ib;
            const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (impulses && rel < 0) {
                const jImp = -(1 + BODY_RESTITUTION) * rel / (ia + ib);
                a.vx -= jImp * ia * nx; a.vy -= jImp * ia * ny;
                b.vx += jImp * ib * nx; b.vy += jImp * ib * ny;
            }
        }
    }
}

/** Every creature can melee: close in on melee_charge, wind up, lunge, land on contact. */
function melee(w, u, dt) {
    const s = u.strike;
    const target = s.target >= 0 ? w.units[s.target] : null;

    if (s.phase === 0) {
        if (u.intent.panicked || u.intent.action !== 'melee_charge' || s.cd > 0 || u.shell > 0 || u.cast || u.stagger > 0) return;
        const t = w.units[u.intent.target];
        if (!t || !t.alive || t.team === u.team || edge(u, t) > STRIKE_REACH_M) return;
        s.phase = 1; s.t = 0; s.target = t.idx; s.landed = false;
        w.events.push({ type: 'windup', u: u.idx, target: t.idx });
        return;
    }

    s.t += dt;
    if (!target || !target.alive) { s.phase = 0; s.cd = STRIKE_COOLDOWN_S; return; }

    if (s.phase === 1 && s.t >= STRIKE_WINDUP_S) {
        s.phase = 2; s.t = 0;                   // think() turns this into an explosive step at the target
    } else if (s.phase === 2) {

        if (!s.landed && edge(u, target) <= 0.05) {
            s.landed = true;
            const rel = Math.hypot(u.vx - target.vx, u.vy - target.vy);
            const dmg = 15 + 0.5 * rel * u.mass;
            const dx = target.x - u.x, dy = target.y - u.y, len = Math.hypot(dx, dy) || 1;
            // The striker's follow-through stops on contact: its momentum went into the shove.
            const along = u.vx * (dx / len) + u.vy * (dy / len);
            if (along > 0) { u.vx -= along * (dx / len); u.vy -= along * (dy / len); }
            applyDamage(w, target, dmg, 'melee', u.x, u.y, u.idx);
        }
        if (s.landed || s.t >= STRIKE_LUNGE_S) {
            if (!s.landed) w.events.push({ type: 'miss', u: u.idx });
            s.phase = 0; s.cd = STRIKE_COOLDOWN_S;
        }
    }
}

// Thrown things fall. A projectile is aimed to come down on the spot its target stood at launch,
// `flight` seconds later, so its height is the parabola ½·g·t·(flight − t). Only a boulder flies
// high enough to matter: in the middle of its arc it sails over bodies (BODY_HEIGHT), and at the
// end of the arc it lands — on whoever is under it, or in the dirt. Globs and mend bolts stay low.
const BODY_HEIGHT_M = 0.9;
export const arcHeight = (p) => Math.max(0, 0.5 * G * p.age * (p.flight - p.age));

function moveProjectiles(w, dt) {
    const keep = [];
    for (const p of w.projectiles) {
        p.age += dt;
        const lob = p.kind === 'boulder';
        const landed = lob && p.age >= p.flight;
        if (p.homing) {
            const t = w.units[p.target];
            if (t && t.alive) {
                const dx = t.x - p.x, dy = t.y - p.y, len = Math.hypot(dx, dy) || 1;
                p.vx = (dx / len) * p.speed; p.vy = (dy / len) * p.speed;
            }
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        let hit = null;
        const overhead = lob && !landed && arcHeight(p) > BODY_HEIGHT_M;
        for (const u of w.units) {
            if (overhead) break;
            if (!u.alive) continue;
            if (p.heals ? u.idx !== p.target : u.team === p.team) continue;
            if (Math.hypot(u.x - p.x, u.y - p.y) <= u.r + (landed ? 0.3 : 0.12)) { hit = u; break; }
        }

        if (hit) {
            if (p.heals) {
                heal(w, hit, p.power, p.source);
            } else {
                // The blow comes from behind the projectile, so the shove follows its flight line.
                const len = Math.hypot(p.vx, p.vy) || 1;
                applyDamage(w, hit, p.power, p.kind, hit.x - (p.vx / len), hit.y - (p.vy / len), p.source);
                if (p.poison > 0 && hit.alive && hit.invuln <= 0) hit.poison = Math.max(hit.poison, p.poison);
            }
            w.events.push({ type: 'impact', kind: p.kind, x: p.x, y: p.y, projectile: p.id });
            continue;
        }

        const inArena = p.x > 0 && p.x < ARENA_W && p.y > 0 && p.y < ARENA_H;
        const stone = w.arena.pillars.some(q => Math.hypot(p.x - q.x, p.y - q.y) <= q.r);
        if (p.age < p.ttl && inArena && !stone && !landed) keep.push(p);

        else w.events.push({ type: 'fizzle', kind: p.kind, x: p.x, y: p.y, projectile: p.id, pillar: stone });
    }
    w.projectiles = keep;
}

function tickStatus(w, u, dt) {
    if (u.poison > 0) {
        u.poison = Math.max(0, u.poison - dt);
        applyDamage(w, u, POISON_DPS * dt, 'poison', u.x, u.y);
    }
    if (u.alive && inside(w.arena.tar, u)) applyDamage(w, u, TAR_DPS * dt, 'tar', u.x, u.y);

    if (u.shell > 0) u.shell = Math.max(0, u.shell - dt);
    if (u.invuln > 0) u.invuln = Math.max(0, u.invuln - dt);
    if (u.dash > 0) u.dash = Math.max(0, u.dash - dt);
    if (u.stagger > 0) u.stagger = Math.max(0, u.stagger - dt);

}

function checkEnd(w) {
    const { blue, red } = teamCounts(w);
    if (blue === 0 || red === 0) {
        w.over = true;
        w.winner = blue === 0 && red === 0 ? 'draw' : blue === 0 ? 'red' : 'blue';
        w.endReason = 'wipe';
        return;
    }
    if (w.time >= MATCH_SECONDS - 1e-9) {
        const pct = (team) => {
            let hp = 0, max = 0;
            for (const u of w.units) if (u.team === team) { hp += u.hp; max += u.maxHp; }
            return 100 * hp / max;
        };
        const b = pct('blue'), r = pct('red');
        w.over = true;
        w.winner = Math.abs(b - r) <= 1 ? 'draw' : b > r ? 'blue' : 'red';
        w.endReason = 'time';
        w.hpPercent = { blue: b, red: r };
    }
}
