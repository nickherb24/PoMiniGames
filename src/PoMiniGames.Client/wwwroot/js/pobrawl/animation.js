// animation.js — procedural pose animation for the fighter rigs.
//
// A pose is a partial map { jointName: {x,y,z} } of Euler targets; a track is a
// timed sequence of poses. Each tick: resolve the target pose (track or base
// stance), layer overlays, damp-lerp every joint. Legs belong to the foot-IK
// stepper unless the current track segment keys that leg.

import * as THREE from 'three';

const GUARD = {
  torso: { x: 0.06, y: 0.18, z: 0 },
  head: { x: -0.05, y: -0.15, z: 0 },
  shoulderL: { x: -0.65, y: 0, z: 0.12 },
  shoulderR: { x: -0.75, y: 0, z: -0.12 },
  elbowL: { x: -1.25, y: 0, z: 0 },
  elbowR: { x: -1.3, y: 0, z: 0 },
  hipL: { x: -0.14, y: 0, z: 0 },
  hipR: { x: -0.1, y: 0, z: 0 },
  kneeL: { x: 0.28, y: 0, z: 0 },
  kneeR: { x: 0.24, y: 0, z: 0 },
};

const BLOCK = {
  torso: { x: 0.16, y: 0.05, z: 0 },
  head: { x: 0.1, y: 0, z: 0 },
  shoulderL: { x: -1.05, y: 0, z: 0.35 },
  shoulderR: { x: -1.1, y: 0, z: -0.35 },
  elbowL: { x: -2.1, y: 0, z: 0 },
  elbowR: { x: -2.15, y: 0, z: 0 },
  hipL: { x: -0.24, y: 0, z: 0 },
  hipR: { x: -0.2, y: 0, z: 0 },
  kneeL: { x: 0.45, y: 0, z: 0 },
  kneeR: { x: 0.4, y: 0, z: 0 },
};

const KO_POSE = {
  torso: { x: -0.7, y: 0, z: 0 },
  head: { x: -0.5, y: 0, z: 0 },
  shoulderL: { x: 0.2, y: 0, z: 0.6 },
  shoulderR: { x: 0.15, y: 0, z: -0.6 },
  elbowL: { x: -0.3, y: 0, z: 0 },
  elbowR: { x: -0.3, y: 0, z: 0 },
  hipL: { x: -0.05, y: 0, z: 0 },
  hipR: { x: -0.05, y: 0, z: 0 },
  kneeL: { x: 0.05, y: 0, z: 0 },
  kneeR: { x: 0.05, y: 0, z: 0 },
};

// Transient tracks: [pose, duration, opts] segments. Durations align with the
// combat windup/active/recover windows in game.js (punch 0.08/0.10/0.22,
// kick 0.12/0.12/0.30, hitstun 0.35). opts.k is the segment's lerp stiffness;
// opts.overshoot scales the segment's own joints past their nominal pose.
const TRACKS = {
  punch: [
    // windup: hip-load + shoulder coil (0.08 total)
    [{ shoulderR: { x: 0.05, y: 0, z: -0.5 }, elbowR: { x: -2.05, y: 0, z: 0 },
       torso: { x: 0.02, y: 0.65, z: 0 }, head: { x: -0.02, y: -0.22, z: 0 },
       shoulderL: { x: -0.85, y: 0, z: 0.2 } }, 0.04, { k: 18 }],
    [{ shoulderR: { x: -0.6, y: 0, z: -0.3 }, elbowR: { x: -1.6, y: 0, z: 0 },
       torso: { x: 0.06, y: 0.55, z: 0 } }, 0.04, { k: 22 }],
    // active: whip → full cross extension. Striker capsules ride the fist mesh,
    // so this pose IS the reach.
    [{ shoulderR: { x: -1.45, y: 0, z: 0.1 }, elbowR: { x: -0.2, y: 0, z: 0 },
       torso: { x: 0.16, y: -0.45, z: 0 }, head: { x: 0, y: 0.1, z: 0 } }, 0.05, { k: 52, overshoot: 1.14 }],
    [{ shoulderR: { x: -1.7, y: 0, z: 0.05 }, elbowR: { x: -0.01, y: 0, z: 0 },
       torso: { x: 0.24, y: -0.85, z: 0 }, head: { x: 0.05, y: 0.2, z: 0 },
       shoulderL: { x: -0.35, y: 0, z: 0.35 } }, 0.05, { k: 58, overshoot: 1.22 }],
    // recover: recoil then settle to guard (0.22)
    [{ shoulderR: { x: -1.1, y: 0, z: -0.1 }, elbowR: { x: -0.7, y: 0, z: 0 },
       torso: { x: 0.08, y: -0.15, z: 0 } }, 0.10, { k: 14 }],
    [GUARD, 0.12, { k: 9 }],
  ],
  kick: [
    // windup: weight shift + knee chamber (0.12)
    [{ hipR: { x: -0.4, y: 0, z: 0 }, kneeR: { x: 1.3, y: 0, z: 0 },
       torso: { x: 0.14, y: 0.15, z: 0.04 }, shoulderL: { x: -0.5, y: 0, z: 0.3 } }, 0.05, { k: 16 }],
    [{ hipR: { x: -0.85, y: 0, z: 0 }, kneeR: { x: 1.8, y: 0, z: 0 },
       torso: { x: 0.1, y: 0.1, z: 0.05 } }, 0.07, { k: 20 }],
    // active: snap extension → drive-through; torso lean-back opens the hip.
    [{ hipR: { x: -1.65, y: 0, z: 0 }, kneeR: { x: 0.04, y: 0, z: 0 },
       torso: { x: -0.38, y: 0.05, z: 0 }, shoulderL: { x: -0.2, y: 0, z: 0.55 },
       shoulderR: { x: -0.2, y: 0, z: -0.65 }, head: { x: 0.1, y: 0, z: 0 } }, 0.06, { k: 50, overshoot: 1.2 }],
    [{ hipR: { x: -1.4, y: 0, z: 0 }, kneeR: { x: 0.18, y: 0, z: 0 },
       torso: { x: -0.28, y: 0.02, z: 0 } }, 0.06, { k: 32 }],
    // recover: retract, replant (0.30)
    [{ hipR: { x: -0.5, y: 0, z: 0 }, kneeR: { x: 1.2, y: 0, z: 0 },
       torso: { x: 0.05, y: 0.08, z: 0 } }, 0.12, { k: 14 }],
    [GUARD, 0.18, { k: 8 }],
  ],
  hitstun: [
    // Small whip, sag, recover (0.35 = HITSTUN). Keep torso deflection in the
    // 5-15° band — the head sells the hit, not a folding spine.
    [{ torso: { x: -0.16, y: 0.06, z: 0 }, head: { x: -0.3, y: 0.04, z: 0 },
       shoulderL: { x: 0.15, y: 0, z: 0.35 }, shoulderR: { x: 0.12, y: 0, z: -0.35 },
       elbowL: { x: -0.35, y: 0, z: 0 }, elbowR: { x: -0.35, y: 0, z: 0 } }, 0.06, { k: 40, overshoot: 1.1 }],
    [{ torso: { x: -0.09, y: 0.04, z: 0 }, head: { x: -0.14, y: 0, z: 0 },
       shoulderL: { x: 0.1, y: 0, z: 0.25 }, shoulderR: { x: 0.08, y: 0, z: -0.25 },
       elbowL: { x: -0.55, y: 0, z: 0 }, elbowR: { x: -0.55, y: 0, z: 0 } }, 0.08, { k: 16 }],
    [GUARD, 0.21, { k: 10 }],
  ],
  ko: [
    [KO_POSE, 0.6, { k: 24 }],
  ],
};

// ── Charge poses: held coils for hold-to-charge (see setCharge) ─────────
const CHARGE_POSES = {
  // Legs unkeyed so the foot-IK keeps the stance planted.
  punch: {
    torso: { x: 0.04, y: 0.85, z: 0 }, head: { x: -0.05, y: -0.5, z: 0 },
    shoulderR: { x: 0.35, y: 0, z: -0.55 }, elbowR: { x: -2.3, y: 0, z: 0 },
    shoulderL: { x: -1.0, y: 0, z: 0.25 }, elbowL: { x: -1.6, y: 0, z: 0 },
  },
  // Right leg keyed so the stepper releases it (same rule as the kick track).
  kick: {
    torso: { x: 0.26, y: 0.1, z: 0.05 }, head: { x: -0.15, y: 0, z: 0 },
    hipR: { x: -1.05, y: 0, z: 0 }, kneeR: { x: 2.0, y: 0, z: 0 },
    shoulderL: { x: -0.7, y: 0, z: 0.55 }, shoulderR: { x: -0.5, y: 0, z: -0.65 },
    elbowL: { x: -1.1, y: 0, z: 0 }, elbowR: { x: -1.0, y: 0, z: 0 },
  },
};

// ── Entrance tracks: one per president, played during the countdown ────
const ENTRANCES = {
  // Trump: chin-up swagger — head high, shoulders back, fists on hips.
  swagger: [
    [{ torso: { x: -0.04, y: 0.1, z: 0 }, head: { x: -0.18, y: 0, z: 0 },
       shoulderL: { x: -0.4, y: 0, z: 0.55 }, shoulderR: { x: -0.45, y: 0, z: -0.55 },
       elbowL: { x: -1.6, y: 0, z: 0 }, elbowR: { x: -1.6, y: 0, z: 0 },
       hipL: { x: -0.05, y: 0, z: 0 }, hipR: { x: -0.05, y: 0, z: 0 } }, 0.6, { k: 8 }],
    [{ torso: { x: -0.02, y: 0.15, z: 0 }, head: { x: -0.22, y: 0, z: 0 },
       shoulderL: { x: -0.3, y: 0, z: 0.45 }, shoulderR: { x: -0.35, y: 0, z: -0.45 },
       elbowL: { x: -1.7, y: 0, z: 0 }, elbowR: { x: -1.7, y: 0, z: 0 } }, 0.6, { k: 6 }],
    [GUARD, 0.3, { k: 6 }],
  ],
  // Biden: aviator-adjust — hand to brow, two quick taps.
  aviator: [
    [{ torso: { x: 0.08, y: 0, z: 0 }, head: { x: -0.08, y: -0.05, z: 0 },
       shoulderR: { x: -1.3, y: 0, z: -0.4 }, elbowR: { x: -2.0, y: 0, z: 0 },
       shoulderL: { x: -0.7, y: 0, z: 0.1 }, elbowL: { x: -1.4, y: 0, z: 0 } }, 0.35, { k: 14 }],
    [{ torso: { x: 0.06, y: 0, z: 0 }, head: { x: -0.06, y: -0.05, z: 0 },
       shoulderR: { x: -1.4, y: 0, z: -0.5 }, elbowR: { x: -2.1, y: 0, z: 0 },
       shoulderL: { x: -0.7, y: 0, z: 0.1 }, elbowL: { x: -1.4, y: 0, z: 0 } }, 0.35, { k: 18 }],
    [{ shoulderR: { x: -0.7, y: 0, z: -0.15 }, elbowR: { x: -1.4, y: 0, z: 0 } }, 0.4, { k: 12 }],
    [GUARD, 0.4, { k: 6 }],
  ],
  // Obama: fist-bump — left arm cocked forward, head nod.
  fistbump: [
    [{ torso: { x: 0.0, y: 0.25, z: 0 }, head: { x: 0.06, y: 0.15, z: 0 },
       shoulderL: { x: -1.2, y: 0, z: 0.3 }, elbowL: { x: -2.4, y: 0, z: 0 } }, 0.4, { k: 12 }],
    [{ torso: { x: 0.0, y: -0.15, z: 0 }, head: { x: -0.1, y: -0.05, z: 0 },
       shoulderL: { x: -0.9, y: 0, z: 0.35 }, elbowL: { x: -1.4, y: 0, z: 0 },
       shoulderR: { x: -0.65, y: 0, z: -0.2 }, elbowR: { x: -1.2, y: 0, z: 0 } }, 0.35, { k: 16 }],
    [{ torso: { x: 0.06, y: 0.18, z: 0 }, head: { x: 0.08, y: 0.12, z: 0 },
       shoulderL: { x: -1.2, y: 0, z: 0.3 }, elbowL: { x: -2.4, y: 0, z: 0 } }, 0.4, { k: 14 }],
    [GUARD, 0.35, { k: 8 }],
  ],
  // Bush: cowboy wave — wide arm swing side-to-side.
  cowboy: [
    [{ torso: { x: 0.05, y: -0.1, z: 0 }, head: { x: -0.1, y: 0, z: 0 },
       shoulderR: { x: -0.3, y: 0, z: -1.7 }, elbowR: { x: -2.0, y: 0, z: 0 } }, 0.4, { k: 14 }],
    [{ torso: { x: 0.05, y: -0.1, z: 0 }, head: { x: -0.1, y: 0, z: 0 },
       shoulderR: { x: -0.3, y: 0, z: -1.0 }, elbowR: { x: -2.0, y: 0, z: 0 } }, 0.3, { k: 14 }],
    [{ torso: { x: 0.05, y: -0.1, z: 0 }, head: { x: -0.1, y: 0, z: 0 },
       shoulderR: { x: -0.3, y: 0, z: -1.7 }, elbowR: { x: -2.0, y: 0, z: 0 } }, 0.3, { k: 14 }],
    [GUARD, 0.5, { k: 8 }],
  ],
  // Clinton: thumbs-up — single arm raise.
  thumbsup: [
    [{ torso: { x: 0.04, y: 0, z: 0 }, head: { x: -0.04, y: 0.1, z: 0 },
       shoulderR: { x: -2.5, y: 0, z: -0.05 }, elbowR: { x: -0.8, y: 0, z: 0 },
       shoulderL: { x: -0.65, y: 0, z: 0.1 }, elbowL: { x: -1.3, y: 0, z: 0 } }, 0.45, { k: 10 }],
    [{ torso: { x: 0.04, y: 0, z: 0 }, head: { x: -0.02, y: 0.1, z: 0 },
       shoulderR: { x: -2.6, y: 0, z: -0.05 }, elbowR: { x: -0.85, y: 0, z: 0 } }, 0.4, { k: 8 }],
    [GUARD, 0.5, { k: 6 }],
  ],
  // Nixon: the double-V victory arms — both fists high and wide, two pumps.
  victory: [
    [{ torso: { x: -0.06, y: 0, z: 0 }, head: { x: -0.2, y: 0, z: 0 },
       shoulderL: { x: -2.5, y: 0, z: 0.65 }, shoulderR: { x: -2.5, y: 0, z: -0.65 },
       elbowL: { x: -0.25, y: 0, z: 0 }, elbowR: { x: -0.25, y: 0, z: 0 } }, 0.45, { k: 10 }],
    [{ torso: { x: -0.02, y: 0, z: 0 }, head: { x: -0.16, y: 0, z: 0 },
       shoulderL: { x: -2.35, y: 0, z: 0.55 }, shoulderR: { x: -2.35, y: 0, z: -0.55 },
       elbowL: { x: -0.3, y: 0, z: 0 }, elbowR: { x: -0.3, y: 0, z: 0 } }, 0.3, { k: 12 }],
    [{ torso: { x: -0.06, y: 0, z: 0 }, head: { x: -0.2, y: 0, z: 0 },
       shoulderL: { x: -2.55, y: 0, z: 0.68 }, shoulderR: { x: -2.55, y: 0, z: -0.68 },
       elbowL: { x: -0.22, y: 0, z: 0 }, elbowR: { x: -0.22, y: 0, z: 0 } }, 0.35, { k: 12 }],
    [GUARD, 0.4, { k: 6 }],
  ],
  // Carter: a warm side-to-side wave with a friendly head nod.
  wave: [
    [{ torso: { x: 0.04, y: 0, z: 0 }, head: { x: 0.06, y: 0.08, z: 0.04 },
       shoulderR: { x: -2.6, y: 0, z: -0.3 }, elbowR: { x: -0.5, y: 0, z: 0.4 } }, 0.4, { k: 12 }],
    [{ head: { x: 0.04, y: -0.05, z: -0.03 },
       shoulderR: { x: -2.6, y: 0, z: -0.15 }, elbowR: { x: -0.5, y: 0, z: -0.35 } }, 0.3, { k: 14 }],
    [{ head: { x: 0.06, y: 0.06, z: 0.04 },
       shoulderR: { x: -2.6, y: 0, z: -0.3 }, elbowR: { x: -0.5, y: 0, z: 0.4 } }, 0.3, { k: 14 }],
    [GUARD, 0.5, { k: 6 }],
  ],
  // Trump: the double-hand pump — both forearms cocked by the hips, pumping
  // down-and-up in rhythm with a chin-up bob. Two full pumps, then guard.
  trumpPump: [
    [{ torso: { x: 0.04, y: 0.06, z: 0 }, head: { x: -0.14, y: 0, z: 0 },
       shoulderL: { x: -0.35, y: 0, z: 0.42 }, shoulderR: { x: -0.35, y: 0, z: -0.42 },
       elbowL: { x: -2.0, y: 0, z: 0 }, elbowR: { x: -2.0, y: 0, z: 0 } }, 0.22, { k: 16 }],
    [{ torso: { x: 0.13, y: 0.06, z: 0 }, head: { x: -0.05, y: 0, z: 0 },
       shoulderL: { x: -0.12, y: 0, z: 0.40 }, shoulderR: { x: -0.12, y: 0, z: -0.40 },
       elbowL: { x: -1.02, y: 0, z: 0 }, elbowR: { x: -1.02, y: 0, z: 0 } }, 0.18, { k: 20 }],
    [{ torso: { x: 0.04, y: 0.06, z: 0 }, head: { x: -0.14, y: 0, z: 0 },
       shoulderL: { x: -0.35, y: 0, z: 0.42 }, shoulderR: { x: -0.35, y: 0, z: -0.42 },
       elbowL: { x: -2.0, y: 0, z: 0 }, elbowR: { x: -2.0, y: 0, z: 0 } }, 0.18, { k: 20 }],
    [{ torso: { x: 0.13, y: 0.06, z: 0 },
       elbowL: { x: -1.02, y: 0, z: 0 }, elbowR: { x: -1.02, y: 0, z: 0 } }, 0.18, { k: 20 }],
    [GUARD, 0.24, { k: 8 }],
  ],
  // Reagan: the actor's finger-gun point-and-wink — right arm snaps forward
  // level, a double jab of the point.
  point: [
    [{ torso: { x: 0.06, y: -0.16, z: 0 }, head: { x: -0.05, y: -0.1, z: 0 },
       shoulderR: { x: -1.5, y: 0, z: -0.15 }, elbowR: { x: -0.2, y: 0, z: 0 },
       shoulderL: { x: -0.6, y: 0, z: 0.15 }, elbowL: { x: -1.2, y: 0, z: 0 } }, 0.34, { k: 15 }],
    [{ torso: { x: 0.03, y: -0.16, z: 0 }, head: { x: -0.02, y: -0.1, z: 0 },
       shoulderR: { x: -1.28, y: 0, z: -0.15 }, elbowR: { x: -0.55, y: 0, z: 0 } }, 0.26, { k: 17 }],
    [{ torso: { x: 0.06, y: -0.16, z: 0 },
       shoulderR: { x: -1.5, y: 0, z: -0.15 }, elbowR: { x: -0.2, y: 0, z: 0 } }, 0.3, { k: 17 }],
    [GUARD, 0.4, { k: 8 }],
  ],
  // Ford: the clumsy stumble — a wide side-to-side wobble with arms flailing
  // for balance and a knee dip, playing on his pratfall reputation.
  stumble: [
    [{ torso: { x: 0.05, y: 0, z: 0.22 }, head: { x: 0, y: 0, z: 0.18 },
       shoulderL: { x: -0.9, y: 0, z: 0.7 }, shoulderR: { x: -0.3, y: 0, z: -0.5 },
       elbowL: { x: -0.8, y: 0, z: 0 }, elbowR: { x: -0.7, y: 0, z: 0 },
       kneeL: { x: 0.3, y: 0, z: 0 } }, 0.3, { k: 12 }],
    [{ torso: { x: 0.05, y: 0, z: -0.22 }, head: { x: 0, y: 0, z: -0.18 },
       shoulderR: { x: -0.9, y: 0, z: -0.7 }, shoulderL: { x: -0.3, y: 0, z: 0.5 },
       elbowR: { x: -0.8, y: 0, z: 0 }, elbowL: { x: -0.7, y: 0, z: 0 },
       kneeR: { x: 0.3, y: 0, z: 0 } }, 0.3, { k: 12 }],
    [{ torso: { x: 0.08, y: 0, z: 0.1 }, head: { x: 0.1, y: 0, z: 0.08 },
       shoulderL: { x: -0.6, y: 0, z: 0.6 }, shoulderR: { x: -0.5, y: 0, z: -0.6 },
       elbowL: { x: -1.0, y: 0, z: 0 }, elbowR: { x: -1.0, y: 0, z: 0 } }, 0.25, { k: 10 }],
    [GUARD, 0.35, { k: 7 }],
  ],
  // Bush Sr.: a full golf swing — wind the torso back, then whip it across
  // (the Kennebunkport duffer).
  golf: [
    [{ torso: { x: 0.05, y: -0.9, z: 0 }, head: { x: -0.05, y: -0.5, z: 0 },
       shoulderL: { x: -1.7, y: 0, z: 0.2 }, shoulderR: { x: -1.9, y: 0, z: -0.1 },
       elbowL: { x: -0.7, y: 0, z: 0 }, elbowR: { x: -0.6, y: 0, z: 0 } }, 0.45, { k: 9 }],
    [{ torso: { x: 0.05, y: 0.9, z: 0 }, head: { x: -0.05, y: 0.4, z: 0 },
       shoulderL: { x: -1.9, y: 0, z: 0.1 }, shoulderR: { x: -1.7, y: 0, z: -0.2 },
       elbowL: { x: -0.6, y: 0, z: 0 }, elbowR: { x: -0.7, y: 0, z: 0 } }, 0.3, { k: 22 }],
    [GUARD, 0.5, { k: 7 }],
  ],
  // Generic salute — fallback for any president without a bespoke dance.
  salute: [
    [{ torso: { x: 0.04, y: 0.05, z: 0 }, head: { x: -0.05, y: 0, z: 0 },
       shoulderR: { x: -1.6, y: 0, z: -0.35 }, elbowR: { x: -2.4, y: 0, z: 0 } }, 0.5, { k: 12 }],
    [{ shoulderR: { x: -1.5, y: 0, z: -0.3 }, elbowR: { x: -2.4, y: 0, z: 0 } }, 0.5, { k: 8 }],
    [GUARD, 0.5, { k: 6 }],
  ],
  // BOB: fists-up — square up ready stance.
  ready: [
    [{ torso: { x: 0.08, y: 0.1, z: 0 }, head: { x: -0.06, y: 0, z: 0 },
       shoulderL: { x: -1.1, y: 0, z: 0.35 }, shoulderR: { x: -1.15, y: 0, z: -0.35 },
       elbowL: { x: -1.85, y: 0, z: 0 }, elbowR: { x: -1.9, y: 0, z: 0 } }, 0.6, { k: 10 }],
    [{ torso: { x: 0.1, y: 0.1, z: 0 }, shoulderL: { x: -1.15, y: 0, z: 0.35 }, shoulderR: { x: -1.2, y: 0, z: -0.35 } }, 0.5, { k: 8 }],
    [GUARD, 0.4, { k: 6 }],
  ],
  // LBJ: "the Johnson Treatment" — drops an arm across the opponent's
  // shoulder and leans in close, head bowed as if whispering. Forearm
  // presses in, then releases with a tilt-back laugh.
  lbjTreatment: [
    [{ torso: { x: 0.08, y: 0, z: 0.05 }, head: { x: 0.18, y: -0.08, z: 0.04 },
       shoulderR: { x: -0.5, y: 0, z: -0.7 }, elbowR: { x: -2.3, y: 0, z: 0 },
       shoulderL: { x: -0.5, y: 0, z: 0.55 }, elbowL: { x: -1.7, y: 0, z: 0 } }, 0.55, { k: 9 }],
    [{ torso: { x: 0.05, y: 0, z: 0.08 }, head: { x: 0.2, y: -0.1, z: 0.05 },
       shoulderR: { x: -0.45, y: 0, z: -0.65 }, elbowR: { x: -2.4, y: 0, z: 0 } }, 0.45, { k: 10 }],
    [{ torso: { x: -0.02, y: 0.05, z: 0 }, head: { x: -0.12, y: 0.1, z: -0.02 },
       shoulderR: { x: -0.7, y: 0, z: -0.3 }, elbowR: { x: -1.4, y: 0, z: 0 },
       shoulderL: { x: -0.7, y: 0, z: 0.3 }, elbowL: { x: -1.4, y: 0, z: 0 } }, 0.45, { k: 8 }],
    [GUARD, 0.35, { k: 6 }],
  ],
  // JFK: confident head-tilt and wave — right hand rises in a casual
  // open-palm greeting, then the chin drops with that famous grin.
  jfkNod: [
    [{ torso: { x: 0.03, y: 0, z: 0 }, head: { x: 0.12, y: 0.04, z: 0.02 },
       shoulderR: { x: -2.55, y: 0, z: -0.2 }, elbowR: { x: -1.1, y: 0, z: 0 },
       shoulderL: { x: -0.6, y: 0, z: 0.1 }, elbowL: { x: -1.2, y: 0, z: 0 } }, 0.45, { k: 12 }],
    [{ head: { x: 0.04, y: -0.08, z: -0.02 },
       shoulderR: { x: -2.55, y: 0, z: -0.12 }, elbowR: { x: -1.1, y: 0, z: 0 } }, 0.3, { k: 14 }],
    [{ head: { x: 0.12, y: 0.02, z: 0.02 },
       shoulderR: { x: -2.55, y: 0, z: -0.22 }, elbowR: { x: -1.05, y: 0, z: 0 } }, 0.35, { k: 14 }],
    [GUARD, 0.4, { k: 6 }],
  ],
  // Eisenhower: a sharp military salute — right hand snaps up to the
  // brow, holds for a beat, drops crisply to guard.
  eisenhowerSalute: [
    [{ torso: { x: 0.04, y: 0, z: 0 }, head: { x: -0.04, y: 0, z: 0 },
       shoulderR: { x: -0.5, y: 0, z: -0.2 }, elbowR: { x: -0.7, y: 0, z: 0 } }, 0.25, { k: 22 }],
    [{ head: { x: -0.06, y: 0, z: 0 },
       shoulderR: { x: -0.18, y: 0, z: -0.18 }, elbowR: { x: -2.6, y: 0, z: 0 } }, 0.5, { k: 10 }],
    [{ head: { x: -0.04, y: 0, z: 0 },
       shoulderR: { x: -0.2, y: 0, z: -0.2 }, elbowR: { x: -2.55, y: 0, z: 0 } }, 0.45, { k: 9 }],
    [{ shoulderR: { x: -0.55, y: 0, z: -0.2 }, elbowR: { x: -1.4, y: 0, z: 0 } }, 0.25, { k: 16 }],
    [GUARD, 0.35, { k: 6 }],
  ],
  // Truman: "Give 'em hell" — both fists raised high in a fighter's
  // pose, a quick double-pump at chin level, then settle.
  giveEmHell: [
    [{ torso: { x: 0.06, y: 0.05, z: 0 }, head: { x: -0.05, y: 0.05, z: 0 },
       shoulderL: { x: -2.45, y: 0, z: 0.5 }, shoulderR: { x: -2.45, y: 0, z: -0.5 },
       elbowL: { x: -0.4, y: 0, z: 0 }, elbowR: { x: -0.4, y: 0, z: 0 } }, 0.35, { k: 14 }],
    [{ torso: { x: 0.0, y: -0.05, z: 0 },
       shoulderL: { x: -1.4, y: 0, z: 0.4 }, shoulderR: { x: -1.4, y: 0, z: -0.4 },
       elbowL: { x: -1.9, y: 0, z: 0 }, elbowR: { x: -1.9, y: 0, z: 0 } }, 0.22, { k: 18 }],
    [{ torso: { x: 0.06, y: 0.05, z: 0 },
       shoulderL: { x: -2.45, y: 0, z: 0.5 }, shoulderR: { x: -2.45, y: 0, z: -0.5 },
       elbowL: { x: -0.4, y: 0, z: 0 }, elbowR: { x: -0.4, y: 0, z: 0 } }, 0.25, { k: 16 }],
    [GUARD, 0.45, { k: 6 }],
  ],
  // FDR: the long cigarette-holder flourish — head tilted up, right hand
  // raised shoulder-high in a relaxed open palm (the holder grip), then
  // a regal chin-up pose before the guard.
  fdrCane: [
    [{ torso: { x: 0.03, y: 0.02, z: 0 }, head: { x: 0.08, y: 0.08, z: 0.02 },
       shoulderR: { x: -2.3, y: 0, z: -0.2 }, elbowR: { x: -0.6, y: 0, z: 0.05 },
       shoulderL: { x: -0.55, y: 0, z: 0.15 }, elbowL: { x: -1.2, y: 0, z: 0 } }, 0.55, { k: 10 }],
    [{ head: { x: 0.05, y: 0.12, z: 0 },
       shoulderR: { x: -2.3, y: 0, z: -0.25 }, elbowR: { x: -0.55, y: 0, z: 0.05 } }, 0.4, { k: 12 }],
    [{ torso: { x: -0.01, y: 0.06, z: 0 }, head: { x: -0.08, y: 0.04, z: 0 },
       shoulderR: { x: -0.65, y: 0, z: -0.2 }, elbowR: { x: -1.3, y: 0, z: 0 } }, 0.4, { k: 9 }],
    [GUARD, 0.4, { k: 6 }],
  ],
};

function lerpAngle(cur, target, k) {
  return cur + (target - cur) * k;
}

// Per-character stance offsets, partial { jointName: {x?,y?,z?} }, added to GUARD.
function personalizeGuard(offsets) {
  if (!offsets) return GUARD;
  const out = {};
  for (const [n, p] of Object.entries(GUARD)) out[n] = { ...p };
  for (const [n, o] of Object.entries(offsets)) {
    const t = out[n] || (out[n] = { x: 0, y: 0, z: 0 });
    t.x += o.x || 0;
    t.y += o.y || 0;
    t.z += o.z || 0;
  }
  return out;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Foot IK constants ────────────────────────────────────────────────────
// Rig-local leg dimensions: hip→knee 0.42, knee→shoe-center ~(0,-0.45,0.06).
const L1 = 0.42;
const L2 = Math.hypot(0.45, 0.06);
const FOOT_Y = 0.085;          // world Y the shoe center rests at
const STANCE_X = 0.135;        // lateral stance half-width (root-local)
const STANCE_Z = { L: 0.10, R: -0.02 }; // orthodox stagger: left foot leads
const STEP_DUR = 0.16;         // seconds per step
const STEP_LIFT = 0.08;        // swing arc height
const SNAP_DIST = 0.6;         // beyond this the foot just slides (heavy knockback)

const _v = new THREE.Vector3();
const _stance = new THREE.Vector3();
const _hipLocal = new THREE.Vector3();
const _targetLocal = new THREE.Vector3();
const _footW = new THREE.Vector3();

export class Animator {
  constructor(joints, stance = null) {
    this.joints = joints;
    this.track = null;
    this.trackT = 0;
    // Track segments referencing GUARD resolve to this personalized guard.
    this.guard = personalizeGuard(stance);
    this.base = this.guard;
    this.walkPhase = 0;
    this.chargeName = null;
    this.chargeAmt = 0;
    // Hit-reaction lean in radians (decays each tick).
    this.leanX = 0;
    this.leanZ = 0;
    this.moveLean = { x: 0, z: 0, tx: 0, tz: 0 };
    this.look = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0 };
    this.clinch = 0;
    this.clinchTarget = 0;
    // jointName -> { ox,oy,oz (offset), vx,vy,vz (velocity) }
    this.reactions = {};
    // World-space foot plants; null until first update.
    this.feet = {
      L: { plant: null, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1 },
      R: { plant: null, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1 },
    };
    this._legDriven = { L: false, R: false };
    // Set by the ragdolls so the pose-lerp doesn't fight their solvers.
    this.frozen = false;
  }

  play(name) {
    // Combat track or entrance; unknown → null (idle is the base stance).
    this.track = TRACKS[name] || ENTRANCES[name] || null;
    this.trackT = 0;
  }

  // Hold-to-charge coil, called every tick while held. `name` 'punch'|'kick'|null;
  // `amt` 0..1 deepens the pose and the tremble. Ignored while a track plays.
  setCharge(name, amt) {
    if (name && this.chargeName !== name) this.track = null;
    this.chargeName = name || null;
    this.chargeAmt = name ? amt : 0;
  }

  setBlocking(on) {
    this.base = on ? BLOCK : this.guard;
  }

  // Head-tracking targets (root-local yaw/pitch toward the opponent).
  setLook(yaw, pitch) {
    this.look.tYaw = clamp(yaw, -0.6, 0.6);
    this.look.tPitch = clamp(pitch, -0.35, 0.35);
  }

  // Momentum lean targets (already in root-local terms).
  setMoveLean(x, z) {
    this.moveLean.tx = clamp(x, -0.3, 0.3);
    this.moveLean.tz = clamp(z, -0.25, 0.25);
  }

  setClinch(on) {
    this.clinchTarget = on ? 1 : 0;
  }

  // Inject an angular impulse into a joint's reaction spring (rad/s).
  applyReaction(name, ix, iy, iz) {
    const r = this.reactions[name] || (this.reactions[name] = {
      ox: 0, oy: 0, oz: 0, vx: 0, vy: 0, vz: 0,
    });
    r.vx += ix; r.vy += iy; r.vz += iz;
  }

  /** ctx: { dt, speed (0..1), idleT (s), root (Object3D), vel (Vector3 world) } */
  update(ctx) {
    const { dt } = ctx;
    if (this.frozen) return;

    // ── Resolve the target pose ────────────────────────────────────────
    let target = this.base;
    let trackK = 0;
    this._legDriven.L = false;
    this._legDriven.R = false;

    if (this.track) {
      this.trackT += dt;
      let t = this.trackT;
      let seg = null, segOpts = null;
      for (const [pose, dur, opts] of this.track) {
        if (t <= dur) { seg = pose; segOpts = opts; break; }
        t -= dur;
      }
      if (seg) {
        if (seg === GUARD) {
          target = this.guard;
        } else {
          const ov = segOpts?.overshoot ?? 1;
          if (ov !== 1) {
            const scaled = {};
            for (const [n, p] of Object.entries(seg)) {
              scaled[n] = { x: p.x * ov, y: p.y * ov, z: p.z * ov };
            }
            target = { ...this.guard, ...scaled };
          } else {
            target = { ...this.guard, ...seg };
          }
          // Legs keyed by this segment are track-driven; the stepper must not fight them.
          this._legDriven.L = !!(seg.hipL || seg.kneeL);
          this._legDriven.R = !!(seg.hipR || seg.kneeR);
        }
        trackK = segOpts?.k ?? 24;
      } else {
        this.track = null;
      }
    }

    // Charge coil: 80% on tap → full at max charge.
    if (!this.track && this.chargeName && CHARGE_POSES[this.chargeName]) {
      const pose = CHARGE_POSES[this.chargeName];
      const depth = 0.8 + 0.2 * this.chargeAmt;
      const scaled = {};
      for (const [n, p] of Object.entries(pose)) {
        scaled[n] = { x: p.x * depth, y: p.y * depth, z: p.z * depth };
      }
      target = { ...this.guard, ...scaled };
      this._legDriven.L = !!(pose.hipL || pose.kneeL);
      this._legDriven.R = !!(pose.hipR || pose.kneeR);
      trackK = 16;
    }
    const snappy = trackK > 0;
    const tremble = (this.chargeName && this.chargeAmt > 0.1)
      ? Math.sin(ctx.idleT * 47) * 0.05 * this.chargeAmt : 0;

    // ── Overlay state advance ──────────────────────────────────────────
    this.walkPhase += ctx.speed * dt * 9;
    const swing = Math.sin(this.walkPhase) * 0.55 * ctx.speed;
    const bob = Math.abs(Math.sin(this.walkPhase)) * 0.04 * ctx.speed
      + Math.sin(ctx.idleT * 2.2) * 0.012;
    const breath = Math.sin(ctx.idleT * 1.9) * (0.02 - 0.01 * ctx.speed);

    const kSm = Math.min(1, dt * 7);
    this.look.yaw += (this.look.tYaw - this.look.yaw) * Math.min(1, dt * 8);
    this.look.pitch += (this.look.tPitch - this.look.pitch) * Math.min(1, dt * 8);
    this.moveLean.x += (this.moveLean.tx - this.moveLean.x) * kSm;
    this.moveLean.z += (this.moveLean.tz - this.moveLean.z) * kSm;
    this.clinch += (this.clinchTarget - this.clinch) * kSm;

    // Reaction springs (stiff, heavily damped — a 0.2-0.4s whip).
    for (const name of Object.keys(this.reactions)) {
      const r = this.reactions[name];
      r.vx += (-90 * r.ox - 11 * r.vx) * dt;
      r.vy += (-90 * r.oy - 11 * r.vy) * dt;
      r.vz += (-90 * r.oz - 11 * r.vz) * dt;
      r.ox = clamp(r.ox + r.vx * dt, -0.9, 0.9);
      r.oy = clamp(r.oy + r.vy * dt, -0.9, 0.9);
      r.oz = clamp(r.oz + r.vz * dt, -0.9, 0.9);
      if (Math.abs(r.ox) + Math.abs(r.oy) + Math.abs(r.oz)
        + Math.abs(r.vx) + Math.abs(r.vy) + Math.abs(r.vz) < 0.01) {
        delete this.reactions[name];
      }
    }

    // ── Pose lerp with overlays ────────────────────────────────────────
    const k = Math.min(1, dt * (snappy ? trackK : 12));
    for (const [name, joint] of Object.entries(this.joints)) {
      const pose = target[name] || { x: 0, y: 0, z: 0 };
      let px = pose.x, py = pose.y, pz = pose.z;

      // Walk-cycle overlay: arms + spine only (legs belong to the stepper).
      if (!snappy && ctx.speed > 0.02) {
        if (name === 'shoulderL') px -= swing * 0.4;
        else if (name === 'shoulderR') px += swing * 0.4;
        else if (name === 'torso') { py -= swing * 0.28; pz += swing * 0.06; }
        else if (name === 'head') py += swing * 0.18;
      }

      if (name === 'torso') px += breath;
      else if (name === 'shoulderL') pz += breath * 0.4;
      else if (name === 'shoulderR') pz -= breath * 0.4;

      if (tremble !== 0) {
        if (name === 'torso') px += tremble;
        else if (name === 'shoulderL' || name === 'shoulderR') px += tremble * 1.4;
        else if (name === 'head') px += tremble * 0.7;
      }

      if (name === 'torso') { px += this.leanX; pz += this.leanZ; }
      else if (name === 'head') { px += this.leanX * 0.6; pz += this.leanZ * 0.6; }
      else if (name === 'hips') { px += this.leanX * 0.4; }

      // Momentum lean: into acceleration, counter-lean on braking.
      if (name === 'torso') { px += this.moveLean.x * 0.7; pz += this.moveLean.z * 0.7; }
      else if (name === 'hips') { px += this.moveLean.x * 0.4; pz += this.moveLean.z * 0.3; }

      // Head tracking (mostly suppressed while a track whips the head).
      if (name === 'head' && !snappy) { py += this.look.yaw; px += this.look.pitch; }
      else if (name === 'head' && snappy) { py += this.look.yaw * 0.35; }
      else if (name === 'torso' && !snappy) py += this.look.yaw * 0.15;

      // Clinch: forearms brace at chest range.
      if (this.clinch > 0.01 && !snappy) {
        if (name === 'shoulderL') { px += -0.4 * this.clinch; pz += 0.22 * this.clinch; }
        else if (name === 'shoulderR') { px += -0.35 * this.clinch; pz += -0.22 * this.clinch; }
        else if (name === 'elbowL' || name === 'elbowR') px += -0.55 * this.clinch;
      }

      // Reaction spring offsets (target-level, so the lerp can't accumulate).
      const r = this.reactions[name];
      if (r) { px += r.ox; py += r.oy; pz += r.oz; }

      joint.rotation.x = lerpAngle(joint.rotation.x, px, k);
      joint.rotation.y = lerpAngle(joint.rotation.y, py, k);
      joint.rotation.z = lerpAngle(joint.rotation.z, pz, k);
      if (name === 'hips') {
        joint.position.y = 1.0 + bob;
        joint.position.x = Math.sin(this.walkPhase) * 0.05 * ctx.speed;
      }
    }

    // ── Foot IK: plant, step, solve ────────────────────────────────────
    if (ctx.root) {
      ctx.root.updateMatrixWorld(true);
      this._updateFeet(ctx);
      for (const side of ['L', 'R']) {
        if (this._legDriven[side]) continue;
        this._footTarget(side, _footW);
        this._solveLeg(side, _footW, dt, ctx.root);
      }
    }
  }

  // Feet stay planted in world space; when the body's stance point drifts too far
  // from a plant, that foot steps to a new plant leading the velocity.
  _updateFeet(ctx) {
    const root = ctx.root;
    const dt = ctx.dt;
    const moving = ctx.speed > 0.05;
    const thresh = moving ? 0.18 : 0.09;

    const anySwinging = this.feet.L.t < 1 || this.feet.R.t < 1;
    let worst = null, worstErr = 0;

    for (const side of ['L', 'R']) {
      const f = this.feet[side];
      _stance.set(side === 'L' ? -STANCE_X : STANCE_X, 0, STANCE_Z[side]);
      root.localToWorld(_stance);
      _stance.y = FOOT_Y;

      if (!f.plant) {
        f.plant = _stance.clone();
        continue;
      }

      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / STEP_DUR);
        if (f.t >= 1) f.plant.copy(f.to);
        continue;
      }

      const dx = f.plant.x - _stance.x;
      const dz = f.plant.z - _stance.z;
      const err = Math.hypot(dx, dz);
      if (err > SNAP_DIST) {
        // Body launched (heavy knockback) — feet can't step that fast; slide.
        f.plant.copy(_stance);
      } else if (err > thresh && err > worstErr) {
        worst = side;
        worstErr = err;
        f._stanceX = _stance.x;
        f._stanceZ = _stance.z;
      }
    }

    // One foot in the air at a time.
    if (worst && !anySwinging) {
      const f = this.feet[worst];
      f.from.copy(f.plant);
      const lead = 0.13;
      f.to.set(
        f._stanceX + clamp((ctx.vel?.x ?? 0) * lead, -0.25, 0.25),
        FOOT_Y,
        f._stanceZ + clamp((ctx.vel?.z ?? 0) * lead, -0.25, 0.25));
      f.t = 0;
    }
  }

  // Current IK target for a foot: the plant, or the swing arc.
  _footTarget(side, out) {
    const f = this.feet[side];
    if (!f.plant) { out.set(0, FOOT_Y, 0); return; }
    if (f.t >= 1) { out.copy(f.plant); return; }
    const e = f.t * f.t * (3 - 2 * f.t); // smoothstep
    out.lerpVectors(f.from, f.to, e);
    out.y = FOOT_Y + Math.sin(Math.PI * f.t) * STEP_LIFT;
  }

  // Two-bone leg IK in root-local space: hip pitch/roll + knee bend so the
  // shoe center reaches the target. Knee stays ahead of the hip-ankle line
  // (human flexion). First-order corrected for the hips-group lean.
  _solveLeg(side, targetWorld, dt, root) {
    const hipJ = this.joints['hip' + side];
    const kneeJ = this.joints['knee' + side];
    if (!hipJ || !kneeJ) return;

    hipJ.getWorldPosition(_v);
    _hipLocal.copy(_v);
    root.worldToLocal(_hipLocal);
    _targetLocal.copy(targetWorld);
    root.worldToLocal(_targetLocal);

    const u = _hipLocal.y - _targetLocal.y;             // down
    const vFwd = _targetLocal.z - _hipLocal.z;          // forward
    const w = _targetLocal.x - _hipLocal.x;             // lateral
    let d = Math.sqrt(u * u + vFwd * vFwd + w * w);
    d = clamp(d, 0.25, L1 + L2 - 0.02);

    const kneeBend = Math.PI - Math.acos(clamp(
      (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const theta = Math.atan2(vFwd, Math.max(u, 0.05));
    const alpha = Math.acos(clamp(
      (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));

    // Compensate the hips-group lean so the world-space solution holds.
    const hipRx = -(theta + alpha) - (this.joints.hips ? this.joints.hips.rotation.x : 0);
    const hipRz = Math.asin(clamp(w / d, -0.45, 0.45))
      - (this.joints.hips ? this.joints.hips.rotation.z : 0);

    const kIK = Math.min(1, dt * 22);
    hipJ.rotation.x = lerpAngle(hipJ.rotation.x, clamp(hipRx, -1.7, 1.0), kIK);
    hipJ.rotation.z = lerpAngle(hipJ.rotation.z, clamp(hipRz, -0.5, 0.5), kIK);
    hipJ.rotation.y = lerpAngle(hipJ.rotation.y, 0, kIK);
    kneeJ.rotation.x = lerpAngle(kneeJ.rotation.x, clamp(kneeBend, 0.02, 2.2), kIK);
    kneeJ.rotation.y = lerpAngle(kneeJ.rotation.y, 0, kIK);
    kneeJ.rotation.z = lerpAngle(kneeJ.rotation.z, 0, kIK);
  }

  // Apply a hit-lean impulse (radians, world-space). Decays internally next tick.
  applyLean(x, z) {
    this.leanX += x;
    this.leanZ += z;
    // Tight cap: this stacks with the hitstun track, reaction springs and ragdoll blend.
    this.leanX = Math.max(-0.2, Math.min(0.2, this.leanX));
    this.leanZ = Math.max(-0.2, Math.min(0.2, this.leanZ));
  }

  decayLean(dt) {
    const k = 1 - Math.min(1, dt * 5);
    this.leanX *= k;
    this.leanZ *= k;
  }
}
