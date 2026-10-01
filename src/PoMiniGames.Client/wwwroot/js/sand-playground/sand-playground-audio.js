// ===========================================================================
// SandPlayground — procedural audio engine (Web Audio, zero assets).
// Everything is synthesized at runtime: noise buffers, a procedural cavern
// impulse response for the convolution reverb, continuous ambient beds
// (pour / flow / mist / wind / drone / fuse hiss / seismic rumble / rain /
// torch) and one-shot SFX (blasts, snaps, splashes, thuds, drips, thunder).
// The simulation engine drives it with discrete events plus a per-frame
// stats bundle.
//
// The graph hangs off the app's shared AudioContext (audioBus.js 'sfx' bus),
// so the app-level volume and mute apply and the context is suspended with
// the tab. This module must NEVER close that context: dispose() stops its own
// sources and disconnects. It only owns (and closes) a context of its own in
// the fallback case where the bus is missing.
//
// Every one-shot takes the event's sim-space x (0..800) and is panned to it.
// ===========================================================================

const W = 800;

let ctx = null, ownCtx = false;
let master, duckFilter, limiter, dryBus, verbBus;
let noiseBuf = null, brownBuf = null;
let clipCurve = null;
let beds = null;
let live = [];          // long-running sources, stopped on dispose
let whistle = null;
let lastLand = 0, lastPlip = 0, lastSnap = 0, lastThud = 0, lastSizzle = 0, lastBeep = 0;

export function unlock() {
    if (ctx) {
        if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => { /* no gesture yet */ });
        return;
    }
    try { build(); } catch { ctx = null; }
}

export function dispose() {
    if (!ctx) return;
    for (const n of live) { try { n.stop(); } catch { /* never started */ } }
    live = [];
    try { limiter.disconnect(); master.disconnect(); } catch { /* already gone */ }
    if (ownCtx) { try { ctx.close(); } catch { /* already closed */ } }
    ctx = null; beds = null; whistle = null;
}

// Slow-motion duck: the whole mix drops under a low-pass while time is
// stretched, then opens back up. `amount` 0 = open, 1 = fully ducked.
export function slowmo(amount) {
    if (!ctx) return;
    const hz = 18000 * Math.pow(0.03, Math.max(0, Math.min(1, amount)));
    duckFilter.frequency.setTargetAtTime(hz, ctx.currentTime, 0.05);
}

// Audio track of everything this game plays, for the clip recorder.
export function recordTap() {
    if (!ctx || !ctx.createMediaStreamDestination) return null;
    const d = ctx.createMediaStreamDestination();
    limiter.connect(d);
    return { stream: d.stream, close: () => { try { limiter.disconnect(d); } catch { /* gone */ } } };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function mkNoise(seconds, brown) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (brown) {
        let acc = 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + (Math.random() * 2 - 1) * 0.02) * 0.998;
            d[i] = acc * 18;
        }
    } else {
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
}

function mkIR(seconds, decay) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * Math.exp(-t * 2.2);
        }
    }
    return buf;
}

function build() {
    const bus = window.PoAudioBus;
    let dest = null;
    ctx = bus?.contextSync?.() ?? null;
    if (ctx) dest = bus.busSync('sfx');
    if (!ctx || !dest) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        dest = ctx.destination;
        ownCtx = true;
    }

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 8;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.24;
    limiter.connect(dest);

    duckFilter = ctx.createBiquadFilter();
    duckFilter.type = 'lowpass';
    duckFilter.frequency.value = 18000;
    duckFilter.connect(limiter);

    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(duckFilter);

    dryBus = ctx.createGain();
    dryBus.connect(master);

    // Procedural cavern reverb.
    const conv = ctx.createConvolver();
    conv.buffer = mkIR(2.2, 2.6);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.6;
    conv.connect(verbOut);
    verbOut.connect(master);
    verbBus = ctx.createGain();
    verbBus.connect(conv);

    noiseBuf = mkNoise(2.4, false);
    brownBuf = mkNoise(3.1, true);
    clipCurve = new Float32Array(257);
    for (let i = 0; i < 257; i++) clipCurve[i] = Math.tanh((i / 128 - 1) * 2.5);

    buildBeds();
}

const panOf = x => Math.max(-0.85, Math.min(0.85, (x / W) * 2 - 1));

// Route a one-shot voice: entry gain -> optional lowpass -> pan -> dry +
// reverb send. `x` is the event's sim-space column; omit for a centred voice.
function route(wet = 0.2, lowpassHz = 0, x = null) {
    const inp = ctx.createGain();
    let tail = inp;
    if (lowpassHz > 0) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lowpassHz;
        tail.connect(f);
        tail = f;
    }
    if (x !== null && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = panOf(x);
        tail.connect(p);
        tail = p;
    }
    tail.connect(dryBus);
    if (wet > 0.01) {
        const w = ctx.createGain();
        w.gain.value = wet;
        tail.connect(w);
        w.connect(verbBus);
    }
    return inp;
}

function nsrc(buf, loop = false) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    if (loop) s.loopEnd = buf.duration;
    return s;
}

function env(g, at, attack, peak, dur) {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
}

// Tiny band-passed noise transient (grain landings, crackle, droplets).
function tick(at, freq, q, peak, dur, dest) {
    const n = nsrc(noiseBuf);
    n.playbackRate.value = 0.5 + Math.random();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, at, 0.004, peak, dur);
    n.connect(f); f.connect(g); g.connect(dest);
    n.start(at);
    n.stop(at + dur + 0.05);
}

// ---------------------------------------------------------------------------
// Continuous ambient beds
// ---------------------------------------------------------------------------

function mkBed(buf, filterType, freq, q, wet) {
    const src = nsrc(buf, true);
    src.loopStart = Math.random() * buf.duration * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f); f.connect(g);
    g.connect(dryBus);
    if (wet > 0.01) {
        const w = ctx.createGain();
        w.gain.value = wet;
        g.connect(w);
        w.connect(verbBus);
    }
    src.start();
    live.push(src);
    return { src, filter: f, gain: g };
}

function osc(type, freq) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start();
    live.push(o);
    return o;
}

function buildBeds() {
    beds = {
        pour: mkBed(noiseBuf, 'bandpass', 1500, 0.8, 0.12),
        flow: mkBed(brownBuf, 'lowpass', 640, 0.7, 0.15),
        mist: mkBed(noiseBuf, 'bandpass', 3200, 1.1, 0.2),
        wind: mkBed(noiseBuf, 'bandpass', 320, 0.6, 0.05),
        fuse: mkBed(noiseBuf, 'highpass', 5200, 0.7, 0.08),
        rumble: mkBed(brownBuf, 'lowpass', 130, 0.8, 0.3),
        vac: mkBed(noiseBuf, 'bandpass', 780, 2.5, 0.05),
        rain: mkBed(noiseBuf, 'highpass', 2600, 0.5, 0.1),
        torch: mkBed(brownBuf, 'bandpass', 420, 0.9, 0.1),
    };

    // Wind wanders: a slow LFO wobbles the band centre so it never loops.
    const wg = ctx.createGain();
    wg.gain.value = 130;
    osc('sine', 0.07).connect(wg); wg.connect(beds.wind.filter.frequency);

    // Deep cavern drone: detuned sine pair + faint octave, breathing slowly.
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    droneGain.connect(dryBus);
    const dw = ctx.createGain();
    dw.gain.value = 0.5;
    droneGain.connect(dw); dw.connect(verbBus);
    for (const [fr, g0] of [[54.5, 1.0], [55.3, 0.8], [110.4, 0.3]]) {
        const og = ctx.createGain();
        og.gain.value = g0;
        osc('sine', fr).connect(og); og.connect(droneGain);
    }
    const dlg = ctx.createGain();
    dlg.gain.value = 0.016;
    osc('sine', 0.045).connect(dlg); dlg.connect(droneGain.gain);
    beds.drone = { gain: droneGain };

    // Vacuum motor tone under the dig-tool noise band.
    const vg = ctx.createGain();
    vg.gain.value = 0.3;
    osc('sawtooth', 118).connect(vg); vg.connect(beds.vac.gain);

    // Falling-bomb whistle: one voice that follows the fastest faller.
    const wo = osc('sine', 1400);
    const wgain = ctx.createGain();
    wgain.gain.value = 0;
    const wpan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    wo.connect(wgain); wgain.connect(wpan); wpan.connect(dryBus);
    whistle = { osc: wo, gain: wgain, pan: wpan.pan || null };
}

// Per-frame drive from the engine. `s` fields are 0..1 levels (fuse = count).
export function frame(dtMs, s) {
    if (!ctx || !beds || ctx.state !== 'running') return;
    const t = ctx.currentTime, k = 0.18, rain = s.rain || 0;
    beds.pour.gain.gain.setTargetAtTime(Math.min(0.5, s.pour * 0.85), t, k);
    beds.flow.gain.gain.setTargetAtTime(Math.min(0.5, s.flow * 0.8), t, k);
    beds.mist.gain.gain.setTargetAtTime(Math.min(0.35, s.falls * 0.8), t, k);
    beds.wind.gain.gain.setTargetAtTime(0.025 + 0.05 * s.wind + 0.06 * rain, t, 0.6);
    beds.fuse.gain.gain.setTargetAtTime(Math.min(0.22, s.fuse * 0.1), t, 0.08);
    beds.rumble.gain.gain.setTargetAtTime(Math.min(0.55, s.rumble * 0.5), t, 0.1);
    beds.vac.gain.gain.setTargetAtTime(s.vac ? 0.3 : 0, t, 0.07);
    beds.rain.gain.gain.setTargetAtTime(0.16 * rain, t, 0.8);
    beds.torch.gain.gain.setTargetAtTime(s.torch ? 0.4 : 0, t, 0.06);
    beds.drone.gain.gain.setTargetAtTime(0.05, t, 1.5);

    // The whistle falls in pitch as the bomb picks up speed away from the
    // listener's ear line — the Doppler slide everyone knows from newsreels.
    const w = s.whistle;
    whistle.gain.gain.setTargetAtTime(w ? Math.min(0.07, w.speed * 0.008) : 0, t, 0.08);
    if (w) {
        whistle.osc.frequency.setTargetAtTime(Math.max(500, 1900 - w.speed * 95), t, 0.05);
        if (whistle.pan) whistle.pan.setTargetAtTime(panOf(w.x), t, 0.05);
    }

    // Sparse generative events: cave drips and faint skittering.
    if (Math.random() < dtMs * (0.00012 + 0.0004 * s.flow)) drip();
    if (Math.random() < dtMs * 0.00003) skitter();
}

function drip() {
    const t = ctx.currentTime + Math.random() * 0.05;
    const v = route(0.75, 0, Math.random() * W);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 900 + Math.random() * 900;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.08);
    const g = ctx.createGain();
    env(g, t, 0.004, 0.1, 0.1);
    o.connect(g); g.connect(v);
    o.start(t);
    o.stop(t + 0.15);
}

function skitter() {
    const t = ctx.currentTime;
    const n = 3 + (Math.random() * 4 | 0);
    const v = route(0.5, 0, Math.random() * W);
    for (let i = 0; i < n; i++)
        tick(t + i * 0.028 + Math.random() * 0.012, 4200 + Math.random() * 2800, 3, 0.02, 0.02, v);
}

// ---------------------------------------------------------------------------
// One-shot SFX
// ---------------------------------------------------------------------------

// TNT detonation: sub-bass drop + soft-clipped crack + brown rumble tail +
// scattered crackle. Underwater blasts are muffled and gurgle; underground
// blasts get a long cavern reverb tail. `size` (0.55 small .. 1 big) scales
// level and pitches a small charge up.
export function boom(o = {}) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const depth = o.depth || 0;
    const size = o.size || 1;
    const v = route(0.18 + depth * 0.5, o.submerged ? 340 : 0, o.x ?? null);
    v.gain.value = 0.45 + 0.55 * size;
    const pitch = 1.6 - 0.6 * size;

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime((o.submerged ? 72 : 96) * pitch, t);
    sub.frequency.exponentialRampToValueAtTime(26 * pitch, t + 1.35);
    const sg = ctx.createGain();
    env(sg, t, 0.008, 1.0, o.submerged ? 2.3 : 1.7);
    const shaper = ctx.createWaveShaper();
    shaper.curve = clipCurve;
    sub.connect(sg); sg.connect(shaper); shaper.connect(v);
    sub.start(t);
    sub.stop(t + 2.4);

    const crack = nsrc(noiseBuf);
    const cf = ctx.createBiquadFilter();
    cf.type = 'lowpass';
    cf.frequency.setValueAtTime(o.submerged ? 700 : 6800, t);
    cf.frequency.exponentialRampToValueAtTime(140, t + 0.55);
    const cg = ctx.createGain();
    env(cg, t, 0.005, o.submerged ? 0.5 : 0.85, 0.7);
    crack.connect(cf); cf.connect(cg); cg.connect(v);
    crack.start(t);
    crack.stop(t + 0.8);

    const tail = nsrc(brownBuf);
    const tf = ctx.createBiquadFilter();
    tf.type = 'lowpass';
    tf.frequency.value = 190;
    const tg = ctx.createGain();
    env(tg, t + 0.05, 0.08, 0.5, 2.8);
    tail.connect(tf); tf.connect(tg); tg.connect(v);
    tail.start(t);
    tail.stop(t + 3.0);

    if (o.submerged) {
        for (let i = 0; i < 6; i++) {
            const bt = t + 0.15 + Math.random() * 1.2;
            const bo = ctx.createOscillator();
            bo.type = 'sine';
            const bf = 90 + Math.random() * 130;
            bo.frequency.setValueAtTime(bf, bt);
            bo.frequency.exponentialRampToValueAtTime(bf * 3, bt + 0.12);
            const bg = ctx.createGain();
            env(bg, bt, 0.01, 0.08, 0.14);
            bo.connect(bg); bg.connect(v);
            bo.start(bt);
            bo.stop(bt + 0.2);
        }
    } else {
        for (let i = 0; i < 11; i++)
            tick(t + 0.12 + Math.random() * 1.4, 700 + Math.random() * 2600, 2, 0.06 * (1 - i / 14), 0.05, v);
    }
}

// Thunder: a crack, then a long rolling low-passed tail in the reverb.
export function thunder(x, delay = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const v = route(0.7, 0, x);
    const crack = nsrc(noiseBuf);
    const cf = ctx.createBiquadFilter();
    cf.type = 'highpass';
    cf.frequency.value = 1400;
    const cg = ctx.createGain();
    env(cg, t, 0.003, 0.55, 0.16);
    crack.connect(cf); cf.connect(cg); cg.connect(v);
    crack.start(t); crack.stop(t + 0.25);

    const roll = nsrc(brownBuf);
    roll.playbackRate.value = 0.7;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.setValueAtTime(900, t);
    rf.frequency.exponentialRampToValueAtTime(90, t + 2.6);
    const rg = ctx.createGain();
    env(rg, t + 0.02, 0.06, 0.8, 3.0);
    roll.connect(rf); rf.connect(rg); rg.connect(v);
    roll.start(t); roll.stop(t + 3.1);
}

// Fuse beep. The engine calls this on a shrinking interval, so the last
// second of a fuse is a rising, accelerating stutter. `urgency` 0..1.
export function fuseBeep(x, urgency) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastBeep < 0.045) return;
    lastBeep = t;
    const v = route(0.12, 0, x);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 880 + 900 * urgency;
    const g = ctx.createGain();
    env(g, t, 0.003, 0.035 + 0.05 * urgency, 0.05);
    o.connect(g); g.connect(v);
    o.start(t); o.stop(t + 0.08);
}

// Scene change swoosh for the reset transition.
export function whoosh(dur = 0.9) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.3);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.9;
    f.frequency.setValueAtTime(2400, t);
    f.frequency.exponentialRampToValueAtTime(260, t + dur);
    const g = ctx.createGain();
    env(g, t, dur * 0.35, 0.3, dur);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + dur + 0.1);
}

// Concrete bar bending failure: dry crack + resonant body knock.
export function snap(x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastSnap < 0.06) return;
    lastSnap = t;
    const v = route(0.3, 0, x);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1100;
    const g = ctx.createGain();
    env(g, t, 0.003, 0.55, 0.07);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.12);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(64, t + 0.14);
    const og = ctx.createGain();
    env(og, t, 0.004, 0.5, 0.17);
    o.connect(og); og.connect(v);
    o.start(t); o.stop(t + 0.2);
}

export function shatter(x = null) {
    if (!ctx) return;
    snap(x);
    const t = ctx.currentTime;
    const v = route(0.35, 0, x);
    for (let i = 0; i < 5; i++)
        tick(t + 0.03 + Math.random() * 0.24, 500 + Math.random() * 1800, 1.5, 0.12, 0.07, v);
}

export function splash(mag = 0.6, x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.25, 0, x);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1900, t);
    f.frequency.exponentialRampToValueAtTime(380, t + 0.32);
    const g = ctx.createGain();
    env(g, t, 0.012, 0.5 * mag, 0.4);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.5);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.16);
    const og = ctx.createGain();
    env(og, t, 0.01, 0.3 * mag, 0.2);
    o.connect(og); og.connect(v);
    o.start(t); o.stop(t + 0.25);

    for (let i = 0; i < 4; i++)
        tick(t + 0.1 + Math.random() * 0.3, 2600 + Math.random() * 1600, 3, 0.05 * mag, 0.03, v);
}

export function balloonPop(x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.2, 0, x);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 900;
    const g = ctx.createGain();
    env(g, t, 0.002, 0.5, 0.04);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.08);
    splash(0.9, x);
}

// Small droplet entering a pool.
export function plip(x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastPlip < 0.07) return;
    lastPlip = t;
    const v = route(0.3, 0, x);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 700 + Math.random() * 500;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.4, t + 0.06);
    const g = ctx.createGain();
    env(g, t, 0.004, 0.1, 0.08);
    o.connect(g); g.connect(v);
    o.start(t); o.stop(t + 0.12);
}

export function launch(mag = 0.7, x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.1, 0, x);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.6;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(600 + 1900 * mag, t + 0.26);
    const g = ctx.createGain();
    env(g, t, 0.02, 0.22 * (0.4 + mag), 0.3);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.35);
}

// Rigid body hitting soft ground.
export function thud(mag = 0.6, x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastThud < 0.08) return;
    lastThud = t;
    const v = route(0.25, 0, x);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    const g = ctx.createGain();
    env(g, t, 0.005, 0.45 * mag, 0.13);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.18);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const og = ctx.createGain();
    env(og, t, 0.005, 0.55 * mag, 0.15);
    o.connect(og); og.connect(v);
    o.start(t); o.stop(t + 0.2);
}

// Ballistic grain touching down (heavily throttled).
export function grainLand(hot, x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastLand < 0.045) return;
    lastLand = t;
    tick(t, hot ? 1900 + Math.random() * 1900 : 850 + Math.random() * 800,
        2, hot ? 0.05 : 0.04, 0.025, route(0.15, 0, x));
}

// Water flashing to steam against something hot (throttled).
export function sizzle(x = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastSizzle < 0.09) return;
    lastSizzle = t;
    const v = route(0.25, 0, x);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(4500 + Math.random() * 1500, t);
    f.Q.value = 3;
    const g = ctx.createGain();
    env(g, t, 0.004, 0.15, 0.12);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.14);
}
