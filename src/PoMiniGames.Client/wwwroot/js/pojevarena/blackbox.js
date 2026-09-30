// pojevarena/blackbox.js — the forensic recorder behind the post-match scrubber.
//
// Every physics frame is kept (a 3:00 match is 10,800 frames) in preallocated typed arrays —
// about 31 bytes per unit per frame, ~7 MB for a full 10v10 — plus a growable flat buffer for
// projectiles, the per-frame combat events (so a replay shows the same impacts and popups) and
// every Jev decision with its full probability distributions. Nothing here is persisted or
// uploaded: it lives for the finished match only (SPEC §4.7).
//
// decode(frame) rebuilds the exact "view" objects render.js draws live, so the scrubber and the
// live arena are the same picture.

import { FLAGS } from './creatures.js';
import { DT } from './sim.js';

const PROJECTILE_KINDS = ['glob', 'boulder', 'mend'];
const P_STRIDE = 7; // x, y, vx, vy, age, flight, kind

export function createBlackBox(world, { actions, abilityIds, maxFrames = 10_800 + 300 }) {
    const n = world.units.length;
    const cap = maxFrames * n;
    const f32 = (k) => new Float32Array(cap * k);
    const pos = f32(2), vel = f32(2), facing = f32(1), hp = f32(1);
    const flags = new Uint16Array(cap);
    const target = new Int8Array(cap);
    const action = new Uint8Array(cap);
    const cast = new Uint8Array(cap);          // 0 = none, else abilityIds index + 1
    const castT = new Uint8Array(cap);         // centiseconds
    const strikeT = new Uint8Array(cap);
    const alive = new Uint8Array(cap);
    const stamina = new Uint8Array(cap);       // percent of the energy reserve
    const deathTime = new Float32Array(n).fill(-1);

    let proj = new Float32Array(4096);
    let projLen = 0;
    const projStart = new Uint32Array(maxFrames + 1);
    const projCount = new Uint16Array(maxFrames);

    const events = new Map();       // frame → events[]
    const decisions = [];           // { frame, unit, ok, ... } in arrival order
    let byFrame = null;             // frame → decisions, built once the log is complete

    const actionCode = new Map(actions.map((a, i) => [a, i]));
    let frames = 0;

    return {
        get frames() { return frames; },
        get decisions() { return decisions; },
        seconds: (frame) => frame * DT,

        /** Records the world as it stands after a step (call once per sim tick). */
        record(staleSecondsOf) {
            if (frames >= maxFrames) return;
            const f = frames;
            for (let i = 0; i < n; i++) {
                const u = world.units[i], k = f * n + i;
                pos[k * 2] = u.x; pos[k * 2 + 1] = u.y;
                vel[k * 2] = u.vx; vel[k * 2 + 1] = u.vy;
                facing[k] = u.facing;
                hp[k] = u.hp;
                let fl = 0;
                if (u.intent.panicked) fl |= FLAGS.PANIC;
                if (u.shell > 0) fl |= FLAGS.SHELL;
                if (u.braced) fl |= FLAGS.BRACE;
                if (u.invuln > 0) fl |= FLAGS.INVULN;
                if (u.poison > 0) fl |= FLAGS.POISON;
                if (staleSecondsOf(i) > 1.5) fl |= FLAGS.STALE;
                if (u.dash > 0) fl |= FLAGS.DASH;
                if (u.cast) fl |= FLAGS.CAST;
                if (u.strike.phase === 1) fl |= FLAGS.WINDUP;
                if (u.strike.phase === 2) fl |= FLAGS.LUNGE;
                if (u.stagger > 0) fl |= FLAGS.REEL;
                flags[k] = fl;
                target[k] = u.intent.target;
                action[k] = u.intent.decided ? (actionCode.get(u.intent.action) ?? 0) : 0;
                cast[k] = u.cast ? abilityIds.indexOf(u.cast.id) + 1 : 0;
                castT[k] = u.cast ? Math.min(255, Math.round(u.cast.t * 100)) : 0;
                strikeT[k] = Math.min(255, Math.round(u.strike.t * 100));
                alive[k] = u.alive ? 1 : 0;
                stamina[k] = Math.round(100 * u.reserve / u.reserveMax);
                if (!u.alive && deathTime[i] < 0) deathTime[i] = u.deathTime;
            }

            projStart[f] = projLen;
            const ps = world.projectiles;
            if (projLen + ps.length * P_STRIDE > proj.length) {
                const grown = new Float32Array(Math.max(proj.length * 2, projLen + ps.length * P_STRIDE));
                grown.set(proj.subarray(0, projLen));
                proj = grown;
            }
            for (const p of ps) {
                proj.set([p.x, p.y, p.vx, p.vy, p.age, p.flight, PROJECTILE_KINDS.indexOf(p.kind)], projLen);
                projLen += P_STRIDE;
            }
            projCount[f] = ps.length;

            if (world.events.length) events.set(f, world.events.slice());
            frames++;
        },

        /** Stores one Jev answer (or failure) against the frame it arrived on. */
        recordDecision(frame, unitIdx, decision, request) {
            decisions.push({
                frame,
                unit: unitIdx,
                askedFrame: request?.frame ?? frame,
                ok: !!decision.ok,
                failure: decision.failure || null,
                action: decision.action || null,
                actionConfidence: decision.actionConfidence ?? 0,
                actionProbabilities: decision.actionProbabilities || null,
                focus: decision.focus || null,
                focusConfidence: decision.focusConfidence ?? 0,
                focusProbabilities: decision.focusProbabilities || null,
                panic: decision.panic ?? 0,
                latencyMs: decision.latencyMs ?? 0,
                stamina: request?.state?.stamina ?? null,
            });
        },

        /** The most recent decision for a unit at or before a frame (what was governing it then). */
        decisionAt(unitIdx, frame) {
            for (let i = decisions.length - 1; i >= 0; i--) {
                const d = decisions[i];
                if (d.unit === unitIdx && d.frame <= frame) return d;
            }
            return null;
        },

        /** Frame of the previous/next decision (any unit, or one unit) from `frame`. */
        neighbourDecision(frame, dir, unitIdx = -1) {
            let best = -1;
            for (const d of decisions) {
                if (unitIdx >= 0 && d.unit !== unitIdx) continue;
                if (dir > 0 && d.frame > frame && (best < 0 || d.frame < best)) best = d.frame;
                if (dir < 0 && d.frame < frame && d.frame > best) best = d.frame;
            }
            return best;
        },

        eventsAt(frame) { return events.get(frame) || []; },

        /** A unit's recorded HP on a frame (the debrief's per-phase HP). */
        hpAt(frame, unit) { return frames ? hp[Math.max(0, Math.min(frames - 1, frame)) * n + unit] : 0; },

        /** Rebuilds the drawable views for a recorded frame (same shape as render.viewOf). */
        decode(frame, creatures) {
            const f = Math.max(0, Math.min(frames - 1, frame));
            const t = f * DT;
            const views = new Array(n);
            for (let i = 0; i < n; i++) {
                const k = f * n + i, u = world.units[i];
                const isAlive = alive[k] === 1;
                views[i] = {
                    idx: i, team: u.team, slot: u.slot, label: u.label, name: u.name,
                    alive: isAlive,
                    deathAge: isAlive ? -1 : Math.max(0, t - deathTime[i]),
                    x: pos[k * 2], y: pos[k * 2 + 1], vx: vel[k * 2], vy: vel[k * 2 + 1],
                    facing: facing[k], hp: hp[k], maxHp: u.maxHp,
                    // Acceleration is not recorded: it is the velocity change since the frame before.
                    ax: f > 0 ? (vel[k * 2] - vel[(k - n) * 2]) / DT : 0,
                    ay: f > 0 ? (vel[k * 2 + 1] - vel[(k - n) * 2 + 1]) / DT : 0,
                    stamina: stamina[k] / 100,
                    flags: flags[k],
                    castId: cast[k] ? abilityIds[cast[k] - 1] : null,
                    castT: castT[k] / 100,
                    strikeT: strikeT[k] / 100,
                    action: actions[action[k]] || 'idle',
                    target: target[k],
                    focus: null,
                    stale: flags[k] & FLAGS.STALE ? 2 : 0,
                };
            }
            const projectiles = [];
            for (let j = 0, o = projStart[f]; j < projCount[f]; j++, o += P_STRIDE) {
                projectiles.push({
                    x: proj[o], y: proj[o + 1], vx: proj[o + 2], vy: proj[o + 3],
                    age: proj[o + 4], flight: proj[o + 5], kind: PROJECTILE_KINDS[proj[o + 6]] || 'glob',
                });
            }
            return { views, projectiles, time: t };
        },

        /** Every knockout, in frame order: the scrubber's timeline markers and the kill cam's cue. */
        deaths() {
            const out = [];
            for (const [f, evs] of events) {
                for (const e of evs) if (e.type === 'death') out.push({ frame: f, unit: e.u, team: world.units[e.u].team, source: e.source ?? -1 });
            }
            return out.sort((a, b) => a.frame - b.frame);
        },

        /** The decisions that arrived on one frame (replay blooms). Indexed on first use, after the match. */
        decisionsOn(frame) {
            if (!byFrame) {
                byFrame = new Map();
                for (const d of decisions) (byFrame.get(d.frame) || byFrame.set(d.frame, []).get(d.frame)).push(d);
            }
            return byFrame.get(frame) || [];
        },

        get approxBytes() {
            return cap * (4 * 6 + 2 + 1 * 7) + proj.byteLength;
        },
    };
}
