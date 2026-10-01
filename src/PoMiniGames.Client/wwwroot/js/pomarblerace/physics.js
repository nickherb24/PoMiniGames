// physics.js — cannon-es world + materials for PoMarbleRace
// Sphere marbles, box floor/walls, sphere pegs/bumps, hinged turnstile paddles.
import * as CANNON from 'cannon-es';

// Real-marble physics. The world is scaled at 1 unit = 1 cm, so a radius-1 marble is a 20 mm
// glass "shooter" (see marbles.js for the ~10.5 g mass that implies). Gravity is a weighty,
// natural fall — stronger than the old floaty arcade value but deliberately short of a literal
// 9.8 m/s² (which at this scale would be 981 u/s² and run the race ~8× faster). The floor has
// real friction, so marbles ROLL down the course (angular velocity coupling to linear) the way
// real marbles do, instead of sliding.
//
// GRAVITY survived the move to the authored course (2026-08-10) on purpose, even though the
// course is much shallower than the old chute (average slope 0.27 against 0.42). The reason is
// that raising or lowering it changes nothing about whether marbles hold the banked turns: the
// speed a marble reaches on a ramp and the speed a banked turn is designed for BOTH scale as
// sqrt(g), so the ratio between them — which is what decides how high a marble rides — is
// gravity-independent. What holds the pack in is the authored geometry: 24° of bank on the
// start helix rising to near-vertical through the Track-LowerA/B loops, with a wall 8.3 units
// tall (four marble diameters) at every channel edge.
export const GRAVITY = 72;        // world gravity magnitude (down -Y) — weighty, and enough to
                                  // keep pace once rolling friction scrubs speed on the turns
// 1/60, halved from 1/120 when the procedural chute was replaced by the authored course
// (2026-08-10). Not a preference — a budget. Colliding 101 marbles against a trimesh course costs
// ~16.5 ms per step at the start line (the worst case, with the whole field still bunched), so at
// 1/120 the physics alone wanted ~33 ms per rendered frame and the race would have run in slow
// motion. One step per frame at 60 Hz fits.
//
// The trade is integration accuracy, and the margin that matters is tunnelling: the fastest
// marbles observed on this course run ~55 u/s, which is 0.92 units per step here, against a
// marble 2 units across. The surface catches it with better than 2x to spare, and would keep
// doing so up to ~120 u/s. Raising this back to 1/120 is safe for physics and NOT safe for the
// frame budget — check the step cost before considering it.
export const FIXED_DT = 1 / 60;   // fixed physics step
export const MAX_SUBSTEPS = 4;

export function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  // Friction now matters, and 101 marbles pile up a lot of simultaneous contacts, so give the
  // solver a couple more iterations to keep the rolling stable and jitter-free.
  world.solver.iterations = 16;
  world.solver.tolerance = 0.001;
  world.defaultContactMaterial.friction = 0.12;

  // Real glass marbles: they roll (surface friction couples spin to travel) and they're
  // bouncy on hard surfaces (glass has a high coefficient of restitution).
  const marble = new CANNON.Material('marble');
  const surface = new CANNON.Material('surface');   // the authored track shells
  const obstacle = new CANNON.Material('obstacle');  // peg and gate primitives
  const rumble = new CANNON.Material('rumble');      // high-friction floor bands (slow zones)
  const bump = new CANNON.Material('bump');          // washboard ridges — low bounce so they don't launch marbles
  const spinner = new CANNON.Material('spinner');    // motorised paddles — the one surface that hits back
  const ice = new CANNON.Material('ice');            // near-frictionless plates — marbles skid instead of rolling

  // Floor + walls. This coefficient is bracketed from both sides and the bracket MOVED when the
  // procedural chute was replaced by the authored course (2026-08-10), so it is not a free knob:
  //
  //   lower bound — rolling without slipping needs friction ≥ (2/7)·tan(slope). The course's
  //     average slope is 0.27, so ≥ 0.077 keeps marbles rolling rather than skidding.
  //   upper bound — the non-trapping property needs friction < tan(slope) on every DESCENDING
  //     stretch, or gravity stops winning and the pack can settle. The shallowest sustained
  //     slope on the course is Track-LowerC's run to the line at 0.11, with Track-Upper at 0.14.
  //
  // 0.18 (tuned for the old 0.42 ramp) sat ABOVE that new ceiling and would have stalled the
  // field on the final straight. 0.09 clears the rolling bound and stays under the shallowest
  // descent. Re-run scripts/bake-marble-track.mjs for the current per-segment slope table — it
  // flags any segment that has dropped below this value.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, surface,
    { friction: 0.09, restitution: 0.35 }));
  world.addContactMaterial(new CANNON.ContactMaterial(marble, obstacle,
    { friction: 0.25, restitution: 0.45 }));
  // Glass on glass is the bounciest contact in the world (COR ≈ 0.55 here), with a little
  // friction so a knock also imparts spin.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, marble,
    { friction: 0.15, restitution: 0.55 }));
  // Rumble bands: extra friction to shave speed and reshuffle the pack, but kept below the
  // ramp's tan(slope) so a rolling marble slows without ever stopping (non-blocking guarantee).
  world.addContactMaterial(new CANNON.ContactMaterial(marble, rumble,
    { friction: 0.3, restitution: 0.12 }));
  // Washboard ridges: low bounce so they jostle the pack without launching marbles airborne.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, bump,
    { friction: 0.2, restitution: 0.25 }));
  // Gauntlet rotors: high restitution so a motor-driven arm genuinely flings a marble instead
  // of shoving it. The bounce is the drama — the one contact tuned to make things worse.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, spinner,
    { friction: 0.15, restitution: 0.6 }));
  // Ice: the OPPOSITE end of the bracket from rumble. Rolling without slipping needs friction
  // >= (2/7)*tan(slope); at 0.02 a marble on any real gradient here is well under that, so it
  // stops rolling and SKIDS — it keeps its speed but loses the grip to hold a line, and arrives
  // at the next turn carrying momentum it cannot steer. Being far below tan(slope) it also can
  // never trap: on ice gravity always wins by a wide margin.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, ice,
    { friction: 0.02, restitution: 0.22 }));

  return { world, materials: { marble, surface, obstacle, rumble, bump, spinner, ice } };
}

/**
 * @returns {number} seconds the physics actually advanced. NOT always `dt`: cannon-es stops
 *   sub-stepping as soon as one step has cost more wall time than FIXED_DT and throws the rest of
 *   the accumulated time away, so a frame that asked for three steps can get one.
 */
export function stepWorld(world, dt) {
  const before = world.stepnumber;
  // clamp dt so a stall/tab-switch can't explode the integrator
  world.step(FIXED_DT, Math.min(dt, 0.05), MAX_SUBSTEPS);
  return (world.stepnumber - before) * FIXED_DT;
}
