// pocabinet/physics.js
//
// Arcade car physics + AI for PoCabinet: speed along heading, a lateral-grip cap
// (understeer past it), grass run-off with extra drag, and a barrier that strips
// the outward velocity component.
//
// MIRROR CONTRACT: step / advanceDistance / resolveContacts / gridSlot / aiControls
// are line-for-line ports of PoCabinetPhysics.cs and PoCabinetAiDriver.cs, with the
// same constants in the same order of operations. Solo races run this copy.
// Multiplayer runs the C# copy on the server while this copy predicts the local
// car and replays unacknowledged inputs on top of every snapshot — if the two
// drift apart, each correction becomes a visible snap.
//
// Frame: forward is (cos h, sin h); the right-hand side is (-sin h, cos h); steer
// +1 turns right (heading increases). The scene maps sim (x, y) → world (x/10, y/10)
// on the ground plane, which makes "right" on screen and "right" here agree. The
// old practice ticker had this backwards (left key turned right).

import { wrapAngle } from './track.js';

export const TICK_SECONDS = 1 / 30;
export const MAX_SPEED = 140;
export const KMH_PER_UNIT = 2.0;
const ACCEL = 55;
const BRAKE_DECEL = 130;
const COAST_DECEL = 14;
const REVERSE_ACCEL = 25;
const REVERSE_MAX = 18;
const STEER_RATE = 2.3;
const STEER_FULL_SPEED = 18;
export const GRIP_ACCEL = 105;
const SCRUB_DECEL = 30;
const GRASS_DECEL = 50;
const GRASS_GRIP = 0.6;
export const RUN_OFF = 26;
export const CAR_RADIUS = 14;
const WALL_RESTITUTION = 0.25;
const WALL_FRICTION = 0.85;
const CONTACT_SPEED_FLOOR = REVERSE_MAX * 1.5;

/** The four officials, in the server's roster order (PoCabinetPersonality.Roster). */
export const OFFICIALS = Object.freeze([
    { id: 'sean-s', name: 'Sean S.', color: '#3470d8', maxSpeed: MAX_SPEED * 0.93, corneringSkill: 0.62,
      persona: { lookahead: 25, lateralOffset: -0.95, brakingAggression: 0.95, collisionTolerance: 0.2, draftingAffinity: 0.1 } },
    { id: 'steve-b', name: 'Steve B.', color: '#5e4b8b', maxSpeed: MAX_SPEED * 0.95, corneringSkill: 0.55,
      persona: { lookahead: 45, lateralOffset: 0.85, brakingAggression: 0.20, collisionTolerance: 0.6, draftingAffinity: 0.2 } },
    { id: 'bill-b', name: 'Bill B.', color: '#a02c2c', maxSpeed: MAX_SPEED * 0.91, corneringSkill: 0.70,
      persona: { lookahead: 100, lateralOffset: 0.0, brakingAggression: 0.50, collisionTolerance: 0.9, draftingAffinity: 0.0 } },
    { id: 'mike-p', name: 'Mike P.', color: '#1c8054', maxSpeed: MAX_SPEED * 0.96, corneringSkill: 0.60,
      persona: { lookahead: 130, lateralOffset: -0.40, brakingAggression: 0.40, collisionTolerance: 0.3, draftingAffinity: 0.95 } },
]);

/** Neutral line used by the demo autopilot and for finished cars' cool-down lap. */
export const AUTOPILOT = Object.freeze({ lookahead: 100, lateralOffset: 0, brakingAggression: 0.5, collisionTolerance: 0.9, draftingAffinity: 0 });

export function wallLateral(track) {
    return track.halfWidth + RUN_OFF - CAR_RADIUS * 0.5;
}

/** A fresh physical body. Race bookkeeping (laps, times) is layered on by the caller. */
export function createBody() {
    return {
        x: 0, y: 0, heading: 0, speed: 0,
        segHint: -1, along: 0, distance: 0, lateral: 0,
        onGrass: false, sliding: false, wallImpact: 0,
    };
}

export function copyBody(src, dst) {
    const d = dst || {};
    d.x = src.x; d.y = src.y; d.heading = src.heading; d.speed = src.speed;
    d.segHint = src.segHint; d.along = src.along; d.distance = src.distance; d.lateral = src.lateral;
    d.onGrass = src.onGrass; d.sliding = src.sliding; d.wallImpact = src.wallImpact;
    return d;
}

/** Advance one car by dt with controls { throttle, brake, steer }. Mirrors PoCabinetPhysics.Step. */
export function step(track, car, c, dt, grip) {
    const throttle = c.throttle, brake = c.brake, steer = c.steer;
    const v = car.speed;
    const surfaceGrip = car.onGrass ? GRASS_GRIP : 1;

    let v2;
    if (v < -0.01) {
        if (brake > 0 && throttle === 0) {
            v2 = Math.max(-REVERSE_MAX, v - REVERSE_ACCEL * brake * dt);
        } else {
            v2 = v + (throttle * ACCEL + COAST_DECEL) * dt;
            if (throttle === 0) v2 = Math.min(v2, 0);
        }
    } else if (v <= 0.5 && throttle === 0 && brake > 0) {
        v2 = Math.max(-REVERSE_MAX, v - REVERSE_ACCEL * brake * dt);
    } else {
        const ratio = v / MAX_SPEED;
        let a = throttle * ACCEL * grip * Math.max(0, 1 - ratio * ratio)
            - brake * BRAKE_DECEL
            - COAST_DECEL * (1 - throttle);
        if (car.onGrass && v > 25) a -= GRASS_DECEL;
        v2 = Math.max(0, v + a * dt);
    }

    const speedAbs = Math.abs(v2);
    const lockScale = Math.min(1, speedAbs / STEER_FULL_SPEED);
    const omegaWanted = steer * STEER_RATE * lockScale * (v2 < 0 ? -1 : 1);
    const omegaGrip = GRIP_ACCEL * grip * surfaceGrip / Math.max(speedAbs, 1);
    const omega = Math.min(omegaGrip, Math.max(-omegaGrip, omegaWanted));
    car.sliding = Math.abs(omegaWanted) > omegaGrip * 1.02 && speedAbs > 30;
    if (car.sliding) {
        v2 = v2 > 0 ? Math.max(0, v2 - SCRUB_DECEL * dt) : Math.min(0, v2 + SCRUB_DECEL * dt);
    }

    let heading = car.heading + omega * dt;
    let x = car.x + Math.cos(heading) * v2 * dt;
    let y = car.y + Math.sin(heading) * v2 * dt;

    let proj = track.project(x, y, car.segHint);
    const wallLat = wallLateral(track);
    car.wallImpact = 0;
    if (Math.abs(proj.lateral) > wallLat) {
        const s = proj.lateral > 0 ? 1 : -1;
        const nx = -proj.ty * s, ny = proj.tx * s;
        const excess = Math.abs(proj.lateral) - wallLat;
        x -= nx * excess;
        y -= ny * excess;

        let vx = Math.cos(heading) * v2, vy = Math.sin(heading) * v2;
        const vn = vx * nx + vy * ny;
        if (vn > 0) {
            const tx = vx - nx * vn, ty = vy - ny * vn;
            vx = tx * WALL_FRICTION - nx * vn * WALL_RESTITUTION;
            vy = ty * WALL_FRICTION - ny * vn * WALL_RESTITUTION;
            const speed = Math.sqrt(vx * vx + vy * vy);
            if (speed > 1) heading = v2 >= 0 ? Math.atan2(vy, vx) : Math.atan2(-vy, -vx);
            v2 = v2 >= 0 ? speed : -speed;
            car.wallImpact = vn;
        }
        proj = track.project(x, y, proj.index);
    }

    car.x = x;
    car.y = y;
    car.heading = wrapAngle(heading);
    car.speed = v2;
    car.segHint = proj.index;
    car.lateral = proj.lateral;
    car.onGrass = Math.abs(proj.lateral) > track.halfWidth;
    advanceDistance(track, car, proj.along);
}

function advanceDistance(track, car, along) {
    let delta = along - car.along;
    const half = track.length * 0.5;
    if (delta > half) delta -= track.length;
    else if (delta < -half) delta += track.length;
    car.distance += delta;
    car.along = along;
}

/** Pairwise contacts in index order. Mirrors PoCabinetPhysics.ResolveContacts. */
export function resolveContacts(cars) {
    const min = CAR_RADIUS * 2;
    for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) {
            const a = cars[i], b = cars[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d <= 1e-6 || d >= min) continue;
            const nx = dx / d, ny = dy / d;
            const push = (min - d) * 0.5;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;

            const ahx = Math.cos(a.heading), ahy = Math.sin(a.heading);
            const bhx = Math.cos(b.heading), bhy = Math.sin(b.heading);
            const va = a.speed * (ahx * nx + ahy * ny);
            const vb = b.speed * (bhx * nx + bhy * ny);
            const closing = va - vb;
            if (closing <= 0) continue;
            a.speed -= closing * 0.6 * (ahx * nx + ahy * ny);
            b.speed += closing * 0.3 * (bhx * nx + bhy * ny);
            a.speed = Math.min(MAX_SPEED * 1.08, Math.max(-CONTACT_SPEED_FLOOR, a.speed));
            b.speed = Math.min(MAX_SPEED * 1.08, Math.max(-CONTACT_SPEED_FLOOR, b.speed));
        }
    }
}

/** Grid slot: two columns, pole just behind the line. Mirrors PoCabinetPhysics.GridSlot. */
export function gridSlot(track, car, slot) {
    const row = Math.floor(slot / 2);
    const back = 18 + row * 42;
    const lateral = (slot % 2 === 0 ? -1 : 1) * track.halfWidth * 0.38;
    const p = track.pointAt(track.length - back);
    car.x = p.x + -p.ty * lateral;
    car.y = p.y + p.tx * lateral;
    car.heading = Math.atan2(p.ty, p.tx);
    car.speed = 0;
    const proj = track.project(car.x, car.y, -1);
    car.segHint = proj.index;
    car.along = proj.along;
    car.lateral = proj.lateral;
    car.onGrass = false;
    car.distance = proj.along > track.length * 0.5 ? proj.along - track.length : proj.along;
}

/** Speed the tightest corner in braking range allows. Shared by the AI and the auto-brake assist. */
function cornerSpeed(track, car, grip, margin) {
    const v = car.speed;
    const kappa = track.maxCurvature(car.along + 5, car.along + 30 + Math.abs(v) * 1.1);
    return Math.sqrt(GRIP_ACCEL * grip * margin / Math.max(kappa, 1e-5));
}

/** AI controls for one car. Mirrors PoCabinetAiDriver.Decide. */
export function aiControls(track, car, persona, maxSpeed, corneringSkill, field, grip) {
    const v = car.speed;
    const hw = track.halfWidth;
    let lateralTarget = persona.lateralOffset * hw * 0.6;

    let ahead = null, gap = Number.MAX_VALUE;
    for (const other of field) {
        if (other === car) continue;
        const d = other.distance - car.distance;
        if (d > 4 && d < 60 && d < gap) { gap = d; ahead = other; }
    }
    if (ahead) {
        const latGap = ahead.lateral - car.lateral;
        if (persona.draftingAffinity > 0.5 && gap > 22) {
            lateralTarget = ahead.lateral;
        } else if (Math.abs(latGap) < 24 && gap < 45) {
            const side = ahead.lateral > 0 ? -1 : 1;
            lateralTarget += side * hw * 0.45 * (1 - persona.collisionTolerance);
        }
    }
    lateralTarget = Math.min(hw * 0.8, Math.max(-hw * 0.8, lateralTarget));

    const look = persona.lookahead * 0.5 + 20 + Math.abs(v) * 0.45;
    const p = track.pointAt(car.along + look);
    const tx = p.x + -p.ty * lateralTarget;
    const ty = p.y + p.tx * lateralTarget;
    const desired = Math.atan2(ty - car.y, tx - car.x);
    const err = wrapAngle(desired - car.heading);
    let steer = Math.min(1, Math.max(-1, err * 2.4));
    if (v < 0) steer = -steer;

    const margin = 0.55 + corneringSkill * 0.4;
    let target = Math.min(maxSpeed, cornerSpeed(track, car, grip, margin));
    if (ahead && Math.abs(ahead.lateral - car.lateral) < 20) {
        target = Math.min(target, Math.max(0, ahead.speed) + (gap - 18) * 1.5);
    }

    const throttle = v < target - 3 ? 1 : v < target ? 0.35 : 0;
    const brake = v > target + 4
        ? Math.min(1, Math.max(0.15, (v - target) / 18 * (0.6 + persona.brakingAggression * 0.8)))
        : 0;
    return { throttle, brake, steer };
}

/**
 * Driver aids, applied to the player's raw input before it is stepped or sent.
 * Online they run client-side on the input only, so the server needs no special
 * case and nobody gets a different physics model.
 *   steering: 'off' | 'light' | 'strong' — blend toward the centre-line steer
 *   autoBrake: lift and brake when over the next corner's speed
 */
export function assistControls(track, car, input, assists, grip) {
    let { throttle, brake, steer } = input;
    const weight = assists?.steering === 'strong' ? 0.6 : assists?.steering === 'light' ? 0.35 : 0;
    if (weight > 0 && car.speed > 5) {
        const guide = aiControls(track, car, AUTOPILOT, MAX_SPEED, 0.9, [], grip);
        steer = Math.min(1, Math.max(-1, steer * (1 - weight * 0.5) + guide.steer * weight));
    }
    if (assists?.autoBrake && car.speed > 20) {
        const target = cornerSpeed(track, car, grip, 0.92);
        if (car.speed > target + 4) {
            throttle = Math.min(throttle, 0.3);
            brake = Math.max(brake, Math.min(1, (car.speed - target) / 25));
        }
    }
    return { throttle, brake, steer };
}
