// pocabinet/physics.js
//
// Arcade car physics + AI for PoCabinet: speed along heading, a lateral-grip cap
// (understeer past it), grass run-off with extra drag, and a barrier that strips
// the outward velocity component.
//
// Contacts (2026-09-30) are between car-shaped hulls, not circles: a capsule 39 long
// and 17 wide, the body cars.js draws. A hit is an impulse along the contact normal
// (equal masses, a little restitution) applied where the hulls touch, so it shoves a
// car sideways (`slip`) and turns it (`spin`) as well as changing its speed; the tyres
// then bleed both off in step(). A tap on a rear corner turns a car, a T-bone slides it.
//
// MIRROR CONTRACT: step / advanceDistance / hullContact / resolveContacts / gridSlot /
// soloField / aiControls are line-for-line ports of PoCabinetPhysics.cs,
// PoCabinetAiDriver.cs and PoCabinetPersonality.SoloField, with the same constants in
// the same order of operations. Solo races run this copy. All trig is track.js's own
// sin / cos / atan2 (never Math.*), so the two copies agree to the last bit and a lap
// proof replays as the same race on the server.
// Multiplayer runs the C# copy on the server while this copy predicts the local
// car and replays unacknowledged inputs on top of every snapshot — if the two
// drift apart, each correction becomes a visible snap.
//
// Frame: forward is (cos h, sin h); the right-hand side is (-sin h, cos h); steer
// +1 turns right (heading increases). The scene maps sim (x, y) → world (x/10, y/10)
// on the ground plane, which makes "right" on screen and "right" here agree. The
// old practice ticker had this backwards (left key turned right).

import { wrapAngle, sin, cos, atan2 } from './track.js';

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
/** Hull: a spine of ±HULL_HALF along the heading, HULL_RADIUS thick (39 x 17 overall). */
export const HULL_HALF = 11;
export const HULL_RADIUS = 8.5;
const CONTACT_RESTITUTION = 0.2;
/** Yaw inertia over mass: the square of a 39 x 17 body's radius of gyration. */
const YAW_INERTIA = 150;
const SLIP_DECEL = 120;
const SPIN_DECEL = 5;
const MAX_SLIP = 60;
const MAX_SPIN = 2.5;
const SLIP_SLIDING = 8;
/** Cars further apart than this along the road never touch: where the Playground run
 *  crosses over itself they are on different levels. */
const SAME_ROAD = 120;
/** AI following: the gap it keeps to the car ahead (centres; hulls touch at 39) and the braking it plans on. */
const FOLLOW_GAP = 44;
const FOLLOW_DECEL = 80;
/** How far up the road the AI looks for traffic. */
const AI_RANGE = 170;
const GRID_COLUMN = 22;
const GRID_ROW = 50;
/** Solo and demo races: 99 rivals and the player. */
export const SOLO_RIVALS = 99;
/** The player's grid slot in a solo race: mid-pack, quicker cars ahead and slower behind.
 *  Rival i of soloField() takes slot i, or i + 1 from here back. */
export const PLAYER_SLOT = 50;

/** A driver's lapses are drawn once per stretch of road this long, and last this far into it (see lapse()). */
const LAPSE_STRETCH = 380;
const LAPSE_LENGTH = 170;

/**
 * The four officials, in the server's roster order (PoCabinetPersonality.Roster). A persona
 * is how a car is driven: the line it holds (lateralOffset), how early it turns in
 * (lookahead), how late and how hard it brakes (brakingAggression), how it insists on its
 * line in traffic (collisionTolerance), whether it tucks in behind a car (draftingAffinity)
 * and how often it overcooks a corner and runs off the road (wildness; seed keys the draws).
 */
export const OFFICIALS = Object.freeze([
    { id: 'sean-s', name: 'Sean S.', color: '#3470d8', maxSpeed: MAX_SPEED * 0.93, corneringSkill: 0.62,
      persona: { lookahead: 25, lateralOffset: -0.95, brakingAggression: 0.95, collisionTolerance: 0.2, draftingAffinity: 0.1, wildness: 0.12, seed: 201 } },
    { id: 'steve-b', name: 'Steve B.', color: '#5e4b8b', maxSpeed: MAX_SPEED * 0.95, corneringSkill: 0.55,
      persona: { lookahead: 45, lateralOffset: 0.85, brakingAggression: 0.20, collisionTolerance: 0.6, draftingAffinity: 0.2, wildness: 0.03, seed: 202 } },
    { id: 'bill-b', name: 'Bill B.', color: '#a02c2c', maxSpeed: MAX_SPEED * 0.91, corneringSkill: 0.70,
      persona: { lookahead: 100, lateralOffset: 0.0, brakingAggression: 0.50, collisionTolerance: 0.9, draftingAffinity: 0.0, wildness: 0.01, seed: 203 } },
    { id: 'mike-p', name: 'Mike P.', color: '#1c8054', maxSpeed: MAX_SPEED * 0.96, corneringSkill: 0.60,
      persona: { lookahead: 130, lateralOffset: -0.40, brakingAggression: 0.40, collisionTolerance: 0.3, draftingAffinity: 0.95, wildness: 0.06, seed: 204 } },
]);

const FIELD_FIRST = ['Dana', 'Kyle', 'Priya', 'Omar', 'Lena', 'Marcus', 'Ines', 'Tobias', 'Yuki', 'Carla',
    'Dmitri', 'Aisha', 'Hank', 'Noor', 'Felix', 'Greta', 'Ravi', 'Sofia', 'Walt'];
const FIELD_LAST = ['K.', 'R.', 'D.', 'W.', 'M.'];

/**
 * The 99 rivals of a solo race in grid order: the four officials, then 95 field racers
 * from the quickest to the slowest. Qualifying order on purpose: a grid sorted any other
 * way has to overtake itself, and a hundred cars doing that on a 27-second lap is a
 * traffic jam, not a race. A field racer's pace comes from its index; so does its
 * personality, every trait from a byte of its own (two hashes of the index), so no two
 * cars drive alike and no trait follows from another.
 * Mirrors PoCabinetPersonality.SoloField (which carries no names or colours: the server
 * only re-runs the physics).
 */
export function soloField() {
    const field = OFFICIALS.slice();
    const n = SOLO_RIVALS - OFFICIALS.length;
    for (let i = 0; i < n; i++) {
        const h = Math.imul(i + 1, 0x9E3779B1) >>> 0;
        const g = Math.imul(i + 1, 0x85EBCA6B) >>> 0;
        const a = (h & 0xff) / 255, b = ((h >>> 8) & 0xff) / 255, c = ((h >>> 16) & 0xff) / 255, d = (h >>> 24) / 255;
        const e = (g & 0xff) / 255, f = ((g >>> 8) & 0xff) / 255, k = ((g >>> 16) & 0xff) / 255, m = (g >>> 24) / 255;
        const pace = 1 - i / (n - 1);
        field.push({
            id: 'field', name: `${FIELD_FIRST[i % FIELD_FIRST.length]} ${FIELD_LAST[Math.floor(i / FIELD_FIRST.length)]}`,
            color: `hsl(${Math.round(d * 360)}, ${55 + Math.round(a * 35)}%, ${32 + Math.round(b * 30)}%)`,
            maxSpeed: MAX_SPEED * (0.7 + 0.2 * pace + 0.03 * a),
            corneringSkill: 0.25 + 0.35 * pace + 0.08 * b,
            persona: {
                lookahead: 30 + 90 * c, lateralOffset: -0.9 + 1.8 * d, brakingAggression: 0.05 + 0.9 * e,
                collisionTolerance: 0.1 + 0.8 * k, draftingAffinity: 0.7 * m,
                // Most of the field is tidy; a few are a liability.
                wildness: 0.01 + 0.2 * f * f, seed: i + 1,
            },
        });
    }
    return field;
}

/**
 * A driver's lapse: 0 while it is driving properly, else how far over the limit it thinks
 * the grip goes (1.5 to 2.4 times), signed by the side of the road it is about to leave
 * (+ = right). While it lasts the car misses its line, runs wide onto the run-off on that
 * side and carries too much speed into whatever corner is next; then it gathers it up.
 * One draw per LAPSE_STRETCH of race distance, live for the first LAPSE_LENGTH of it and
 * never off the grid: a pure hash of the driver's seed and the stretch. No state, no RNG,
 * integer and exact double arithmetic only, so the lap verifier draws the same lapses.
 * Mirrors PoCabinetAiDriver.Lapse.
 */
function lapse(persona, distance) {
    if (!(persona.wildness > 0) || distance < LAPSE_STRETCH) return 0;
    const at = distance + persona.seed * 53;
    const stretch = Math.floor(at / LAPSE_STRETCH);
    if (at - stretch * LAPSE_STRETCH > LAPSE_LENGTH) return 0;
    let h = Math.imul(stretch ^ Math.imul(persona.seed, 0x9E3779B1), 0x85EBCA6B);
    h ^= h >>> 13;
    h = Math.imul(h, 0xC2B2AE35);
    h = (h ^ (h >>> 16)) >>> 0;
    if ((h & 0xffff) / 65535 >= persona.wildness) return 0;
    const over = 1.5 + ((h >>> 16) & 0xff) / 255 * 0.9;
    return h >>> 31 ? over : -over;
}

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
        slip: 0, spin: 0,   // sideways speed (+ = right) and yaw rate a contact left behind
    };
}

export function copyBody(src, dst) {
    const d = dst || {};
    d.x = src.x; d.y = src.y; d.heading = src.heading; d.speed = src.speed;
    d.segHint = src.segHint; d.along = src.along; d.distance = src.distance; d.lateral = src.lateral;
    d.onGrass = src.onGrass; d.sliding = src.sliding; d.wallImpact = src.wallImpact;
    d.slip = src.slip; d.spin = src.spin;
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

    // What a contact left behind: the tyres scrub the sideways slide and the spin off.
    const slipGrip = SLIP_DECEL * grip * surfaceGrip * dt;
    let slip = car.slip > 0 ? Math.max(0, car.slip - slipGrip) : Math.min(0, car.slip + slipGrip);
    const spin = car.spin > 0 ? Math.max(0, car.spin - SPIN_DECEL * dt) : Math.min(0, car.spin + SPIN_DECEL * dt);
    if (Math.abs(slip) > SLIP_SLIDING) car.sliding = true;

    let heading = car.heading + (omega + spin) * dt;
    let x = car.x + (cos(heading) * v2 - sin(heading) * slip) * dt;
    let y = car.y + (sin(heading) * v2 + cos(heading) * slip) * dt;

    let proj = track.project(x, y, car.segHint);
    const wallLat = wallLateral(track);
    car.wallImpact = 0;
    if (Math.abs(proj.lateral) > wallLat) {
        const s = proj.lateral > 0 ? 1 : -1;
        const nx = -proj.ty * s, ny = proj.tx * s;
        const excess = Math.abs(proj.lateral) - wallLat;
        x -= nx * excess;
        y -= ny * excess;

        let vx = cos(heading) * v2 - sin(heading) * slip, vy = sin(heading) * v2 + cos(heading) * slip;
        const vn = vx * nx + vy * ny;
        if (vn > 0) {
            const tx = vx - nx * vn, ty = vy - ny * vn;
            vx = tx * WALL_FRICTION - nx * vn * WALL_RESTITUTION;
            vy = ty * WALL_FRICTION - ny * vn * WALL_RESTITUTION;
            const speed = Math.sqrt(vx * vx + vy * vy);
            if (speed > 1) heading = v2 >= 0 ? atan2(vy, vx) : atan2(-vy, -vx);
            v2 = v2 >= 0 ? speed : -speed;
            slip = 0;   // the car leaves the barrier pointing the way it is going
            car.wallImpact = vn;
        }
        proj = track.project(x, y, proj.index);
    }

    car.x = x;
    car.y = y;
    car.heading = wrapAngle(heading);
    car.speed = v2;
    car.slip = slip;
    car.spin = spin;
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

const HIT = { nx: 0, ny: 0, depth: 0, x: 0, y: 0 };

/**
 * Where two hulls touch: null when they are more than `slack` apart, else a shared scratch
 * { nx, ny (unit normal, a → b), depth, x, y (the contact point) }. Takes anything with
 * x, y, heading. Mirrors PoCabinetPhysics.HullContact; fx.js uses it for the sparks.
 */
export function hullContact(a, b, slack) {
    const reach = (HULL_HALF + HULL_RADIUS) * 2 + slack;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx > reach || dx < -reach || dy > reach || dy < -reach) return null;
    const ahx = cos(a.heading), ahy = sin(a.heading);
    const bhx = cos(b.heading), bhy = sin(b.heading);
    // Closest points of the two spines: a + s·ha and b + t·hb, s and t in ±HULL_HALF.
    const dot = ahx * bhx + ahy * bhy;
    const da = -(ahx * dx + ahy * dy), db = -(bhx * dx + bhy * dy);
    const denom = 1 - dot * dot;
    // Within ~10° of parallel the sides meet along their overlap, not at one end: take its
    // middle, or every side-by-side rub would turn both cars.
    let s = denom > 0.03 ? (dot * db - da) / denom : -da * 0.5;
    s = Math.min(HULL_HALF, Math.max(-HULL_HALF, s));
    let t = dot * s + db;
    if (t < -HULL_HALF) {
        t = -HULL_HALF;
        s = Math.min(HULL_HALF, Math.max(-HULL_HALF, t * dot - da));
    } else if (t > HULL_HALF) {
        t = HULL_HALF;
        s = Math.min(HULL_HALF, Math.max(-HULL_HALF, t * dot - da));
    }
    const px = a.x + ahx * s, py = a.y + ahy * s;
    const qx = b.x + bhx * t, qy = b.y + bhy * t;
    const ex = qx - px, ey = qy - py;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d <= 1e-6 || d >= HULL_RADIUS * 2 + slack) return null;
    HIT.nx = ex / d; HIT.ny = ey / d;
    HIT.depth = HULL_RADIUS * 2 - d;
    HIT.x = (px + qx) * 0.5; HIT.y = (py + qy) * 0.5;
    return HIT;
}

/**
 * Pairwise hull contacts in index order: separate the two cars, then one impulse along
 * the normal at the contact point, shared between each car's speed, sideways slip and
 * spin. Mirrors PoCabinetPhysics.ResolveContacts.
 */
export function resolveContacts(track, cars) {
    const half = track.length * 0.5;
    for (let i = 0; i < cars.length; i++) {
        const a = cars[i];
        if (track.parked(a.distance)) continue;
        for (let j = i + 1; j < cars.length; j++) {
            const b = cars[j];
            let gap = b.along - a.along;
            if (gap > half) gap -= track.length;
            else if (gap < -half) gap += track.length;
            if (gap > SAME_ROAD || gap < -SAME_ROAD || track.parked(b.distance)) continue;
            const hit = hullContact(a, b, 0);
            if (!hit) continue;
            const nx = hit.nx, ny = hit.ny;
            const rax = hit.x - a.x, ray = hit.y - a.y;
            const rbx = hit.x - b.x, rby = hit.y - b.y;
            const push = hit.depth * 0.5;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;

            const ahx = cos(a.heading), ahy = sin(a.heading);
            const bhx = cos(b.heading), bhy = sin(b.heading);
            // Each hull's velocity at the contact point: forward speed, slip to its right, spin.
            const vax = ahx * a.speed - ahy * a.slip - a.spin * ray, vay = ahy * a.speed + ahx * a.slip + a.spin * rax;
            const vbx = bhx * b.speed - bhy * b.slip - b.spin * rby, vby = bhy * b.speed + bhx * b.slip + b.spin * rbx;
            const closing = (vax - vbx) * nx + (vay - vby) * ny;
            if (closing <= 0) continue;
            const armA = rax * ny - ray * nx, armB = rbx * ny - rby * nx;
            const impulse = (1 + CONTACT_RESTITUTION) * closing / (2 + (armA * armA + armB * armB) / YAW_INERTIA);
            a.speed -= impulse * (nx * ahx + ny * ahy);
            a.slip -= impulse * (ny * ahx - nx * ahy);
            a.spin -= impulse * armA / YAW_INERTIA;
            b.speed += impulse * (nx * bhx + ny * bhy);
            b.slip += impulse * (ny * bhx - nx * bhy);
            b.spin += impulse * armB / YAW_INERTIA;
            // Bounded so a shove can't launch a car past what its own engine could do.
            a.speed = Math.min(MAX_SPEED * 1.08, Math.max(-CONTACT_SPEED_FLOOR, a.speed));
            b.speed = Math.min(MAX_SPEED * 1.08, Math.max(-CONTACT_SPEED_FLOOR, b.speed));
            a.slip = Math.min(MAX_SLIP, Math.max(-MAX_SLIP, a.slip));
            b.slip = Math.min(MAX_SLIP, Math.max(-MAX_SLIP, b.slip));
            a.spin = Math.min(MAX_SPIN, Math.max(-MAX_SPIN, a.spin));
            b.spin = Math.min(MAX_SPIN, Math.max(-MAX_SPIN, b.spin));
        }
    }
}

/** Columns of the starting grid: as many as the tarmac takes, at least two. */
export function gridColumns(track) {
    return Math.max(2, Math.floor(track.halfWidth * 1.6 / GRID_COLUMN) + 1);
}

/**
 * Distance behind the line of grid row `row`. Rows are GRID_ROW apart, but none stands on a
 * bend tighter than one and a half road widths: there the slots of neighbouring rows fan
 * into each other (Press Briefing turns 130° in thirty units at its line), so the row moves
 * back to where the road has straightened. Mirrors PoCabinetPhysics.GridBack.
 */
export function gridBack(track, row) {
    const limit = 1 / (track.halfWidth * 1.5);
    let back = 18;
    for (let r = 0; back < track.length; ) {
        const at = track.length - back;
        if (track.maxCurvature(at - 25, at + 25) > limit) { back += 8; continue; }
        if (r === row) break;
        r++;
        back += GRID_ROW;
    }
    return back;
}

/** Grid slot: rows across the tarmac, pole just behind the line. Mirrors PoCabinetPhysics.GridSlot. */
export function gridSlot(track, car, slot) {
    const cols = gridColumns(track);
    const back = gridBack(track, Math.floor(slot / cols));
    const lateral = (slot % cols - (cols - 1) / 2) * GRID_COLUMN;
    const p = track.pointAt(track.length - back);
    car.x = p.x + -p.ty * lateral;
    car.y = p.y + p.tx * lateral;
    car.heading = atan2(p.ty, p.tx);
    car.speed = 0;
    car.slip = 0;
    car.spin = 0;
    // Hinted with where the slot is: a long grid runs back over other parts of a course
    // that crosses itself, and a blind nearest-point search can land on the wrong level.
    const proj = track.project(car.x, car.y, track.indexAt(track.length - back));
    car.segHint = proj.index;
    car.along = proj.along;
    car.lateral = proj.lateral;
    car.onGrass = false;
    // Race distance starts negative: the slot's own distance behind the line, corrected by
    // where the car projects (a bend moves an outer slot a little along the road). Not
    // "along minus a lap": a front-row slot on a tight last bend can project past the line.
    let off = proj.along - (track.length - back);
    if (off > track.length * 0.5) off -= track.length;
    else if (off < -track.length * 0.5) off += track.length;
    car.distance = off - back;
}

/**
 * Speed the tightest corner in braking range allows; `reach` is how many seconds of road
 * that range is (the later a driver brakes, the less). Shared by the AI and the auto-brake assist.
 */
function cornerSpeed(track, car, grip, margin, reach) {
    const v = car.speed;
    // Capped at a turn as tight as the road is wide: the centerline has kinks sharper than
    // that (Mar-a-Lago's last bend, a few samples long) which a car simply cuts across,
    // and braking for them parked a 100-car field on the start line.
    const kappa = Math.min(1 / track.halfWidth, track.maxCurvature(car.along + 5, car.along + 30 + Math.abs(v) * reach));
    return Math.sqrt(GRIP_ACCEL * grip * margin / Math.max(kappa, 1e-5));
}

// aiControls scratch: the slower cars ahead within range, and how far ahead each is.
const NEAR = [];
const NEAR_GAP = [];

/** Clear road ahead in lane `lateral` (capped at AI_RANGE) among the first `n` NEAR cars. */
function clearRun(n, lateral) {
    let run = AI_RANGE;
    for (let i = 0; i < n; i++) {
        if (NEAR_GAP[i] < run && Math.abs(NEAR[i].lateral - lateral) < 20) run = NEAR_GAP[i];
    }
    return run;
}

/** AI controls for one car. Mirrors PoCabinetAiDriver.Decide. */
export function aiControls(track, car, persona, maxSpeed, corneringSkill, field, grip) {
    const v = car.speed;
    const hw = track.halfWidth;
    const edge = hw * 0.8;
    const line = persona.lateralOffset * hw * 0.6;
    let lateralTarget = line;

    // Traffic. What is in the way (the car to follow, a car alongside) is judged in this
    // car's own frame, from where the two actually are: the centerline has kinks tighter
    // than a car, and across one of those "ahead on the road" is noise that parked a whole
    // field behind a car that was beside it. Lanes are a road notion, so the lane choice
    // reads road positions: the nearest car ahead, and the ones not pulling away.
    const half = track.length * 0.5;
    const hx = cos(car.heading), hy = sin(car.heading);
    let ahead = null, gap = Number.MAX_VALUE;
    let blocker = null, blockGap = Number.MAX_VALUE;
    let left = false, right = false;
    let near = 0;
    for (const other of field) {
        if (other === car) continue;
        // Along the road first: it wraps the lap (a lapped or cooling-down car counts) and
        // drops the other level of a crossing.
        let d = other.along - car.along;
        if (d > half) d -= track.length;
        else if (d < -half) d += track.length;
        if (d <= -AI_RANGE || d >= AI_RANGE || track.parked(other.distance)) continue;
        const dx = other.x - car.x, dy = other.y - car.y;
        const fwd = dx * hx + dy * hy, side = dy * hx - dx * hy;
        if (fwd > -44 && fwd < 44) {
            if (side > 12 && side < 30) right = true;
            else if (side < -12 && side > -30) left = true;
        }
        // In its path AND ahead of it on the road: two cars converging at an angle are each
        // in the other's path, and without the second test both wait for the other forever.
        if (d > 0 && fwd > 4 && fwd < blockGap && Math.abs(side) < 20) { blockGap = fwd; blocker = other; }
        if (d <= 4) continue;
        if (d < gap) { gap = d; ahead = other; }
        if (other.speed < v + 4) { NEAR[near] = other; NEAR_GAP[near] = d; near++; }
    }
    if (ahead && persona.draftingAffinity > 0.5 && gap > 50) {
        lateralTarget = ahead.lateral;
    } else if (near > 0) {
        // Pick a lane: its own line and seven across the tarmac, scored by the clear road
        // ahead, less how far the lane is from its line (a tolerant driver insists on its
        // line) and from where the car is now (which keeps the choice from flickering).
        const own = 0.2 + 0.6 * persona.collisionTolerance;
        let best = clearRun(near, line) - Math.abs(line - car.lateral) * 0.25;
        for (let k = -3; k <= 3; k++) {
            const lane = edge * k / 3;
            const score = clearRun(near, lane) - Math.abs(lane - line) * own - Math.abs(lane - car.lateral) * 0.25;
            if (score > best) { best = score; lateralTarget = lane; }
        }
    }
    lateralTarget = Math.min(edge, Math.max(-edge, lateralTarget));
    // A lapse: off its line and out over the edge of the road.
    const lapsing = lapse(persona, car.distance);
    if (lapsing !== 0) lateralTarget = lapsing > 0 ? hw + RUN_OFF * 0.6 : -(hw + RUN_OFF * 0.6);
    // Never turn in on a car that is alongside: hold the lane (but always come back off the grass).
    if (lateralTarget > car.lateral ? right : left) lateralTarget = Math.min(edge, Math.max(-edge, car.lateral));

    const look = persona.lookahead * 0.5 + 20 + Math.abs(v) * 0.45;
    const p = track.pointAt(car.along + look);
    const tx = p.x + -p.ty * lateralTarget;
    const ty = p.y + p.tx * lateralTarget;
    const desired = atan2(ty - car.y, tx - car.x);
    const err = wrapAngle(desired - car.heading);
    let steer = Math.min(1, Math.max(-1, err * 2.4));
    if (v < 0) steer = -steer;

    // A late braker looks 0.7 s up the road for its corner, a cautious one 1.3 s; either
    // way a lapse has it believing in grip that is not there.
    const margin = (0.55 + corneringSkill * 0.4) * (lapsing !== 0 ? Math.abs(lapsing) : 1);
    let target = Math.min(maxSpeed, cornerSpeed(track, car, grip, margin, 1.3 - 0.6 * persona.brakingAggression));
    if (blocker) {
        // The car ahead in this lane: no faster than can still be braked down to its speed
        // in the room there is, and a little under it once nose to tail. Never negative:
        // brake at a standstill is the reverse gear.
        const room = blockGap - FOLLOW_GAP;
        const vb = Math.max(0, blocker.speed);
        target = Math.min(target, room > 0 ? Math.sqrt(vb * vb + 2 * FOLLOW_DECEL * room) : Math.max(0, vb - 15));
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
        const target = cornerSpeed(track, car, grip, 0.92, 1.1);
        if (car.speed > target + 4) {
            throttle = Math.min(throttle, 0.3);
            brake = Math.max(brake, Math.min(1, (car.speed - target) / 25));
        }
    }
    return { throttle, brake, steer };
}
