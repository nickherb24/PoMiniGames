// pojevarena/abilities.js — behaviour per ability id: the JS half of the extension point.
//
// Adding an ability is one registry row in PoMiniGames.Shared/Games/PoJevArenaShared.cs (id, slot,
// cost, the Jev option it unlocks, tuning), one handler here keyed by the same id, and one visual
// in fx.js. Handlers read their numbers from `a.def` (that registry row), never from constants,
// so tuning stays a data change. Nothing else in the engine lists abilities by name.
//
// Contract:
//   run(world, unit, ability, target, kit)     → steering {x, y, k}; called every tick while the
//                                               unit's intent is this ability's Jev option.
//                                               May start a wind-up via kit.cast(...).
//   release(world, unit, ability, target, kit) → the wind-up finished: fire / apply the effect.
//   ranged: true                               → counts as a "ranged_threat" for Jev's candidates.
//
// `kit` is supplied by sim.js (steering helpers, cast, fire), which keeps this module free of an
// import cycle and trivially node-runnable.

const SPIT_WINDUP_S = 0.15;
const MEND_WINDUP_S = 0.12;
const MEND_HOLD_M = 5;

export const HANDLERS = {
    // Keep range: back off inside 60% of range, close in beyond it, strafe in the band; spit when ready.
    spit_glob: {
        ranged: true,
        run(w, u, a, t, kit) {
            if (!t || t.team === u.team) return kit.hold();
            const range = a.def.rangeMeters;
            const d = kit.edge(u, t);
            if (kit.ready(a) && d <= range) {
                kit.cast(w, u, a, t.idx, SPIT_WINDUP_S);
                kit.ability(w, u, a.id);
                a.cd = a.def.cooldownSeconds;
            }
            if (d < range * 0.6) return kit.away(u, t, 1);
            if (d > range * 0.95) return kit.towards(u, t, 1);
            // Strafe: perpendicular to the target line, side chosen by slot so a pack fans out.
            const dx = t.x - u.x, dy = t.y - u.y;
            const side = u.slot % 2 ? 1 : -1;
            return { x: -dy * side / (Math.hypot(dx, dy) || 1), y: dx * side / (Math.hypot(dx, dy) || 1), k: 0.4 };
        },
        release(w, u, a, t, kit) {
            kit.fire(w, u, {
                kind: 'glob', target: t.idx, speed: a.def.projectileSpeed, power: a.def.power,
                poison: a.def.durationSeconds, ttl: (a.def.rangeMeters * 1.3) / a.def.projectileSpeed,
            });
        },
    },

    // Close to range, plant, a long visible wind-up, then a heavy knockback rock.
    hurl_boulder: {
        ranged: true,
        run(w, u, a, t, kit) {
            if (!t || t.team === u.team) return kit.hold();
            const range = a.def.rangeMeters;
            const d = kit.edge(u, t);
            if (kit.ready(a) && d <= range) {
                kit.cast(w, u, a, t.idx, a.def.durationSeconds);
                kit.ability(w, u, a.id);
                a.cd = a.def.cooldownSeconds;
                return kit.hold();
            }
            return d > range * 0.9 ? kit.towards(u, t, 1) : kit.hold();
        },
        release(w, u, a, t, kit) {
            kit.fire(w, u, {
                kind: 'boulder', target: t.idx, speed: a.def.projectileSpeed, power: a.def.power,
                ttl: (a.def.rangeMeters * 1.4) / a.def.projectileSpeed,
            });
        },
    },

    // Heal the most injured ally in reach; stay close enough to keep doing it.
    mend_bolt: {
        run(w, u, a, t, kit) {
            let ally = t && t.team === u.team && t.alive ? t : null;
            if (!ally || ally.hp >= ally.maxHp) {
                const hurt = kit.alliesOf(w, u).filter(o => o.hp < o.maxHp);
                ally = hurt.length ? hurt.reduce((b, o) => (kit.hpPct(o) < kit.hpPct(b) ? o : b)) : null;
            }
            if (!ally) {
                const buddy = kit.nearest(kit.alliesOf(w, u), u);
                return buddy && kit.edge(u, buddy) > 2 ? kit.towards(u, buddy, 0.8) : kit.hold();
            }
            u.intent.target = ally.idx;
            const d = kit.edge(u, ally);
            if (kit.ready(a) && d <= a.def.rangeMeters) {
                kit.cast(w, u, a, ally.idx, MEND_WINDUP_S);
                kit.ability(w, u, a.id);
                a.cd = a.def.cooldownSeconds;
            }
            return d > MEND_HOLD_M ? kit.towards(u, ally, 1) : kit.hold();
        },
        release(w, u, a, t, kit) {
            kit.fire(w, u, {
                kind: 'mend', target: t.idx, speed: a.def.projectileSpeed, power: a.def.power,
                heals: true, homing: true, ttl: 1.5,
            });
        },
    },

    // Held for as long as it is the intent: nearly stationary, heavy, blocks the front arc.
    shield_brace: {
        run(w, u, a, t, kit) {
            if (!u.braced && kit.ready(a)) kit.ability(w, u, a.id);
            u.braced = true;
            a.cd = a.def.cooldownSeconds;
            return kit.hold();
        },
        release() { },
    },

    // One-shot: tuck in for the duration, then back off until Jev says otherwise.
    hard_shell: {
        run(w, u, a, t, kit) {
            if (u.shell <= 0 && kit.ready(a)) {
                u.shell = a.def.durationSeconds;
                a.cd = a.def.cooldownSeconds;
                kit.ability(w, u, a.id);
            }
            if (u.shell > 0) return kit.hold();
            const threat = kit.nearest(kit.enemiesOf(w, u), u);
            return threat ? kit.away(u, threat, 1) : kit.hold();
        },
        release() { },
    },

    // One-shot: an explosive sidestep out of the nearest threat's line, briefly untouchable.
    dodge_dash: {
        run(w, u, a, t, kit) {
            const threat = kit.nearest(kit.enemiesOf(w, u), u);
            if (threat && u.dash <= 0 && kit.ready(a)) {
                const dx = threat.x - u.x, dy = threat.y - u.y, len = Math.hypot(dx, dy) || 1;
                // Pick the perpendicular that heads toward the arena centre, so dashes don't pin to walls.
                let px = -dy / len, py = dx / len;
                if ((10 - u.x) * px + (7.5 - u.y) * py < 0) { px = -px; py = -py; }
                // The legs do the rest: sim.js drives an explosive push along this line for 0.25 s.
                u.dash = 0.25;
                u.dashDx = px;
                u.dashDy = py;
                u.invuln = a.def.durationSeconds;
                a.cd = a.def.cooldownSeconds;
                kit.ability(w, u, a.id);
            }
            return threat ? kit.away(u, threat, 1) : kit.hold();
        },
        release() { },
    },
};
