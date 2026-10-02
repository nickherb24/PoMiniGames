// postFx.js — post-processing pieces shared by the three.js games.
//
// PoBrawl and PoMarbleRace each built their own composer, and each one grew a
// slightly different version of the same ideas. What is here is the part that
// genuinely wants to be shared:
//
//   RACK FOCUS   a depth-of-field pass that is OFF during play and ramps in for
//                a moment on a KO / photo finish. This is the cinematic trick
//                the two games were missing, and doing it as a transient pass
//                rather than an always-on one is what makes it affordable.
//   PUNCH        one function that turns impactBus's 0..1 envelope into the
//                aberration/radial-blur values the games' own shaders already
//                have. Before this, PoBrawl decayed its own caPulse and the DOM
//                shook on a different curve, so a single hit produced two
//                slightly out-of-sync reactions.
//   TIER         the shared read of visualRuntime.js's data-gfx attribute, so
//                "what can this machine afford" is answered the same way in
//                both engines.
//
// WHY DoF IS ONLY EVER TRANSIENT
// BokehPass renders the scene a second time with a depth override material. At
// 60 fps during play that is a permanent doubling of the draw-call count for an
// effect nobody looks at while they are concentrating on the game. Enabled for
// the ~1.2 s of a KO — when the action has already stopped — it costs nothing
// that matters and is the single most "expensive-looking" thing in the app.
//
// A disabled pass is skipped entirely by EffectComposer, including its depth
// prepass, so the off state really is free.

import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import * as Impact from './impactBus.js';

/** Current adaptive-quality tier, as published by visualRuntime.js. */
export function tier() {
    if (typeof document === 'undefined') return 'high';
    return document.documentElement.getAttribute('data-gfx') || 'high';
}

/** Convenience: is this machine allowed the expensive effects? */
export function allowHeavy() {
    return tier() === 'high';
}

/**
 * A depth-of-field pass that is off until something dramatic happens.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {number} width
 * @param {number} height
 * @returns {{pass: BokehPass, trigger: Function, update: Function, setSize: Function, dispose: Function}}
 */
export function createRackFocus(scene, camera, width, height) {
    const pass = new BokehPass(scene, camera, {
        focus: 40,
        // `aperture` in BokehPass is in metres-ish reciprocal units; this value
        // gives a shallow-but-not-comical field at the distances both games use.
        aperture: 0.00035,
        maxblur: 0.0,
    });
    pass.enabled = false;

    let hold = 0;        // seconds left at full blur
    let level = 0;       // current 0..1
    let target = 0;
    let peak = 0.012;    // maxblur at level 1

    /**
     * Rack the focus onto a point and blur everything else.
     * @param {number} [focusDistance=40] world units from the camera
     * @param {number} [holdSec=0.9] time at full blur before it eases back out
     * @param {number} [strength=1] 0..1 multiplier on the blur radius
     */
    function trigger(focusDistance, holdSec, strength) {
        // Skipped outright below the top tier. A machine already dropping frames
        // does not need a second full-scene render at the most dramatic moment
        // of the match — that is exactly when a hitch is most noticeable.
        if (!allowHeavy()) return;
        pass.uniforms.focus.value = focusDistance == null ? 40 : focusDistance;
        peak = 0.012 * (strength == null ? 1 : Math.max(0, Math.min(1.5, strength)));
        hold = holdSec == null ? 0.9 : holdSec;
        target = 1;
        pass.enabled = true;
    }

    /** Call every frame with the frame delta in seconds. */
    function update(dt) {
        if (!pass.enabled) return;
        if (hold > 0) {
            hold -= dt;
            if (hold <= 0) target = 0;
        }
        // Ease in fast, out slow. A slow fade IN would mean the blur arrives
        // after the moment it is reacting to; a fast fade OUT would snap.
        const k = target > level ? 9 : 2.2;
        level += (target - level) * (1 - Math.exp(-k * dt));
        pass.uniforms.maxblur.value = level * peak;
        if (target === 0 && level < 0.01) {
            // Fully faded — turn the pass off so its depth prepass stops running.
            level = 0;
            pass.uniforms.maxblur.value = 0;
            pass.enabled = false;
        }
    }

    function setSize(w, h) {
        pass.setSize(w, h);
    }

    function dispose() {
        pass.dispose?.();
    }

    pass.setSize(width, height);
    return { pass, trigger, update, setSize, dispose };
}

/**
 * Chromatic aberration strength for the current impact envelope.
 *
 * Games add this to their own baseline rather than replacing it, so a scene
 * that already has a permanent slight fringe keeps it.
 * @param {number} [scale=1]
 */
export function punchAberration(scale) {
    return Impact.getPunch() * 0.006 * (scale == null ? 1 : scale);
}

/** Radial (zoom) blur strength for the current impact envelope. */
export function punchRadial(scale) {
    // Squared: a light hit should barely smear while a KO should be unmissable,
    // and a linear map makes every hit look like the same medium-sized event.
    const p = Impact.getPunch();
    return p * p * (scale == null ? 1 : scale);
}

/**
 * Camera shake in 3D, driven by the same trauma reservoir as the DOM shake.
 * Applies an offset in the camera's own basis so the shake is always
 * screen-relative regardless of where the camera is looking.
 *
 * MUST be called AFTER the game has positioned its camera for the frame, and
 * the offset is not accumulated — it is recomputed from scratch each call, so
 * there is nothing to undo.
 *
 * @param {THREE.Camera} camera
 * @param {number} nowSec
 * @param {number} [amplitude=0.9] world units at full trauma
 */
export function applyCameraShake(camera, nowSec, amplitude) {
    const s = Impact.getShake();
    if (s < 0.001) return;
    const a = (amplitude == null ? 0.9 : amplitude) * s;
    // Same incommensurable-frequency noise as impactBus, so the 3D camera and
    // the DOM chrome visibly shake together rather than on two rhythms.
    const x = (Math.sin(nowSec * 13.7) * 0.62 + Math.sin(nowSec * 32.5 + 1.7) * 0.38) * a;
    const y = (Math.sin(nowSec * 17.3) * 0.62 + Math.sin(nowSec * 41.0 + 1.7) * 0.38) * a;
    camera.translateX(x);
    camera.translateY(y);
}

// Window alias so non-module scripts (impactFx.js) can drive the
// punch effects without an import — this file is an ES module and impactFx is
// a classic script loaded before Blazor boots.
window.PoThreeFx = {
    tier, allowHeavy,
    punchAberration, punchRadial, applyCameraShake,
};
