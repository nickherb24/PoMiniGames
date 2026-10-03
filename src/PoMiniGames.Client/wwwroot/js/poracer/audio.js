// PoRacer's continuous sound and the one-shot cues that depend on what a car is doing.
//
// Nothing here owns an AudioContext, a mute or a volume: voices feed the shared sfx bus
// (window.PoAudioBus), so the app's own mute and level apply and stop() only has to disconnect
// what it made. It must never close the shared context.
//
//   • engine  — the car the camera follows: two detuned saws through a lowpass, pitched by a
//     virtual five-speed gearbox (the sim has none), louder and brighter under power.
//   • rivals  — the three nearest other cars, one saw each, panned by where they are on screen
//     and pitch-shifted for Doppler, so a pass is heard before it is seen.
//   • events  — crash, skid, sand, turbo and pass cues, read off consecutive server snapshots
//     at 20 Hz. The voices live in gameCues.js. Each also rumbles a gamepad (phones buzz through the cue's own haptic).
//   • music   — PoMusicDirector.tension, lifted on the final lap and when a rival is close.
import { rumble } from './input.js';

const GEAR_TOP = [70, 130, 195, 265, 345];   // sim units/s at the top of each gear
const RIVALS = 3, HEAR = 620;

let ctx = null, engine = null, rivals = [];
let gear = 0, lastV = 0;
const last = { skid: 0, pass: 0, turbo: 0, crash: 0 };
let litWas = 0;

const cue = (name, opts) => { try { window.PoCue?.fire('poracer', name, opts); } catch { /* audio is never fatal */ } };

function voice(pan) {
    const out = window.PoAudioBus.busSync('sfx');
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 600;
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(filter); filter.connect(gain);
    let panner = null;
    if (pan && ctx.createStereoPanner) { panner = ctx.createStereoPanner(); gain.connect(panner); panner.connect(out); }
    else gain.connect(out);
    osc.start();
    return { osc, filter, gain, panner, extra: [] };
}

/** Build the voices. Safe to call repeatedly and before a user gesture (the context just stays suspended). */
export function start() {
    stop();
    ctx = window.PoAudioBus?.contextSync?.() || null;
    if (!ctx || !window.PoAudioBus.busSync('sfx')) { ctx = null; return; }
    engine = voice(false);
    // The second saw an octave down, a few cents off, is what makes one oscillator an engine.
    const sub = ctx.createOscillator(); sub.type = 'sawtooth'; sub.detune.value = -1207;
    sub.connect(engine.filter); sub.start();
    engine.extra.push(sub);
    rivals = Array.from({ length: RIVALS }, () => voice(true));
    gear = 0; lastV = 0; litWas = 0;
}

export function stop() {
    for (const v of [engine, ...rivals]) {
        if (!v) continue;
        for (const node of [v.osc, ...v.extra]) { try { node.stop(); node.disconnect(); } catch { /* already stopped */ } }
        for (const node of [v.filter, v.gain, v.panner]) { try { node?.disconnect(); } catch { /* not connected */ } }
    }
    engine = null; rivals = []; ctx = null;
    try { window.PoMusicDirector?.tension(0); } catch { /* optional */ }
}

/** Speed → engine note. Shifts up at the top of a gear and down with hysteresis, so the note saws like a gearbox. */
function note(v) {
    const speed = Math.abs(v);
    while (gear < GEAR_TOP.length - 1 && speed > GEAR_TOP[gear]) gear++;
    while (gear > 0 && speed < GEAR_TOP[gear - 1] * 0.82) gear--;
    const lo = gear === 0 ? 0 : GEAR_TOP[gear - 1] * 0.62;
    const rev = Math.max(0, Math.min(1, (speed - lo) / (GEAR_TOP[gear] - lo)));
    return 52 + rev * 118;
}

/**
 * Per rendered frame. `cars` are the interpolated cars, `me` the one the camera follows
 * (the local car, or the leader when spectating), `quiet` halves it for a demo.
 */
export function frame(cars, me, quiet) {
    if (!ctx || !engine || !me) return;
    const t = ctx.currentTime;
    const power = me.v > lastV + 0.05 ? 1 : 0.35;   // accelerating vs. coasting or braking
    lastV = me.v;
    const f = note(me.v);
    engine.osc.frequency.setTargetAtTime(f, t, 0.03);
    engine.extra[0].frequency.setTargetAtTime(f, t, 0.03);
    engine.filter.frequency.setTargetAtTime(380 + f * (4 + power * 7), t, 0.06);
    engine.gain.gain.setTargetAtTime((quiet ? 0.03 : 0.06) * (0.55 + power * 0.45), t, 0.08);

    const near = [];
    for (const car of cars) {
        if (car === me) continue;
        const dx = car.x - me.x, dy = car.y - me.y, distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= HEAR * HEAR) continue;
        const entry = { c: car, d: Math.sqrt(distanceSquared) };
        let i = near.length;
        while (i > 0 && near[i - 1].d > entry.d) i--;
        if (i >= RIVALS) continue;
        near.splice(i, 0, entry);
        if (near.length > RIVALS) near.pop();
    }
    for (let i = 0; i < rivals.length; i++) {
        const r = rivals[i], n = near[i];
        if (!n) { r.gain.gain.setTargetAtTime(0, t, 0.1); continue; }
        const dx = n.c.x - me.x, dy = n.c.y - me.y, d = Math.max(1, n.d);
        // Closing speed along the line between the two cars: positive = approaching = pitched up.
        const closing = ((Math.cos(me.h) * me.v - Math.cos(n.c.h) * n.c.v) * dx + (Math.sin(me.h) * me.v - Math.sin(n.c.h) * n.c.v) * dy) / d;
        r.osc.frequency.setTargetAtTime((58 + Math.abs(n.c.v) * 0.34) * (1 + Math.max(-0.2, Math.min(0.2, closing / 1500))), t, 0.05);
        const k = 1 - n.d / HEAR;
        r.gain.gain.setTargetAtTime((quiet ? 0.02 : 0.045) * k * k, t, 0.08);
        r.panner?.pan.setTargetAtTime(Math.max(-1, Math.min(1, dx / 420)), t, 0.08);
    }
}

/**
 * Per server snapshot (20 Hz). `prev` / `cur` are consecutive car arrays in roster order;
 * `me` is the local car's index (-1 when spectating: no cues, the engine bed is enough).
 */
export function events(prev, cur, me, laps) {
    const a = prev?.[me], b = cur?.[me];
    if (!a || !b) return;
    const now = performance.now();

    const hit = b.damage - a.damage;
    if (hit >= 0.025 && now - last.crash > 250) {
        last.crash = now;
        const s = Math.min(1, hit / 0.1);
        cue('crash', { gain: 0.45 + s * 0.55, scale: 0.4 + s * 0.6 });
        rumble(0.4 + s * 0.6);
    }
    if (b.sand && !a.sand) { cue('sandDrift'); rumble(0.3); }
    if (b.skid >= 0.6 && a.skid < 0.6 && Math.abs(b.v) > 110 && now - last.skid > 700) {
        last.skid = now;
        cue('skid', { gain: 0.8 });
        rumble(0.2);
    }
    // A boost starting: a pad, or a drift let go with enough charge.
    if (b.boostT > 0 && !(a.boostT > 0)) { cue('boostPad', { gain: 0.8 }); rumble(0.35); }
    // The sim raises the glow once the car is flat out near top speed: the turbo coming on song.
    // (Not while boosted: a boost sets the glow too, and its own cue just played.)
    if (b.boost >= 0.6 && a.boost < 0.6 && !(b.boostT > 0) && now - last.turbo > 5000) { last.turbo = now; cue('turbo'); }

    // A pass: a rival alongside (within 70 units) that was closing and is now pulling away.
    let nearest = 1e9;
    for (let i = 0; i < cur.length; i++) {
        if (i === me || !prev[i]) continue;
        const d1 = Math.hypot(cur[i].x - b.x, cur[i].y - b.y), d0 = Math.hypot(prev[i].x - a.x, prev[i].y - a.y);
        nearest = Math.min(nearest, d1);
        if (d1 < 70 && d1 > d0 && Math.abs(cur[i].v - b.v) > 35 && now - last.pass > 1500) {
            last.pass = now;
            cue('dopplerPass', { pan: Math.max(-1, Math.min(1, (cur[i].x - b.x) / 70)), pitch: cur[i].v > b.v ? 1.15 : 0.9 });
        }
    }
    // Music follows the race: calm early, lifted on the final lap, a little more with a rival on your bumper.
    const lapTension = b.finished ? 0 : b.lap >= laps ? 0.7 : b.lap === laps - 1 ? 0.3 : 0.12;
    try { window.PoMusicDirector?.tension(lapTension + (nearest < 160 && !b.finished ? 0.2 : 0)); } catch { /* optional */ }
}

/** Start lights: one beep per lamp as it comes on. `lit` is 0-5. */
export function lights(lit) {
    if (lit > litWas) cue('light');
    litWas = lit;
}
