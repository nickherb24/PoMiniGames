// audio.js — procedural Web Audio for PoMarbleRace. No asset files: everything is synthesized
// from oscillators and noise buffers.
//
// The race used to be almost silent — three one-shot sounds, and impact clinks gated so hard
// that most of a run had no audio at all. The soundscape is now continuous: a rolling bed that
// tracks the leader's speed, a crowd that swells toward the finish, and one-shots layered on
// top (countdown, gun, boost, overtake, finish, result).
//
// ── Graph (SOUND #7) ──
// Everything used to sum straight into one `master` gain, which meant the gun, both beds and a
// burst of clinks could all land in the same window with nothing to catch them — the output
// clipped. There are now two buses feeding a compressed master, plus a reverb send:
//
//     beds (roll, crowd, drone) → bedBus ─┐
//     one-shots (clink, whoosh…) → sfxBus ─┼→ master → compressor → destination
//                                  │       │
//                                  └→ reverbSend → convolver ─┘
//
// bedBus is DUCKED by `duck()` when something important fires (gun, sting, finish), so the beds
// step out of the way of the moment instead of fighting it. Mute is still one gain on `master`,
// so it stays a single write rather than a flag checked in eight places.
//
// ── Spatialization (SOUND #9) ──
// One-shots accept an optional `cue` — `{ pan, gain }` from scene.audioCue(), which projects a
// world position against the live camera. A StereoPannerNode is used rather than a full HRTF
// PannerNode: it is dramatically cheaper per node, and the HRTF detail is inaudible on the
// laptop speakers most players use.
//
// ── Buffers (SOUND #8) ──
// Impacts are PRE-RENDERED through an OfflineAudioContext at startup into a small bank of
// AudioBuffers, rather than building an oscillator graph per hit. This is both cheaper per
// impact and less repetitive — see makeImpactBank.

const NOISE_SECONDS = 2;

// #8 — how many impact variants to pre-render, and how long each is.
const IMPACT_VARIANTS = 8;
const IMPACT_SECONDS = 0.22;

// #10 — impulse response length for the convolution reverb.
const IR_SECONDS = 1.5;

// ── Surface-aware rolling (GFX 2026-09-30) ──
// The rolling bed used to be one bandpass riding the LEADER's speed on every surface. It now
// follows the camera's marble and the material it is actually touching (game.js reads the
// contact list after each step): filter shape, level and a tremolo rate/depth per surface. The
// tremolo is what makes a rumble band or a washboard read as ridges rather than as louder noise.
// `air` is silence — a marble in flight makes no rolling sound, which sells the jumps.
const SURFACES = {
  surface: { type: 'bandpass', lo: 140, span: 620, q: 1.1, gain: 1.0, trem: 0, rate: 0 },
  obstacle: { type: 'bandpass', lo: 180, span: 700, q: 1.4, gain: 1.0, trem: 0, rate: 0 },
  rumble: { type: 'lowpass', lo: 90, span: 300, q: 2.4, gain: 1.7, trem: 0.55, rate: 22 },
  bump: { type: 'bandpass', lo: 120, span: 380, q: 2.0, gain: 1.5, trem: 0.85, rate: 9 },
  ice: { type: 'highpass', lo: 2200, span: 2400, q: 0.7, gain: 0.8, trem: 0, rate: 0 },
  boost: { type: 'bandpass', lo: 320, span: 1100, q: 0.9, gain: 1.35, trem: 0.2, rate: 34 },
  air: { type: 'bandpass', lo: 140, span: 620, q: 1.1, gain: 0, trem: 0, rate: 0 },
};

export function createAudio() {
  let ctx = null;
  let muted = false;
  let lastClink = 0;
  let lastOvertake = 0;

  // Graph nodes, built lazily on first ensure(). Null until then.
  let master = null, comp = null, bedBus = null, sfxBus = null;
  let reverbSend = null, convolver = null;
  let rollSrc = null, rollFilter = null, rollGain = null;
  let rollTrem = null, tremOsc = null, tremDepth = null, rollKind = 'surface';
  let ownsCtx = false;
  let crowdSrc = null, crowdFilter = null, crowdGain = null;
  let droneOscs = null, droneFilter = null, droneGain = null, droneBase = null;
  let noiseBuf = null;
  let impactBank = null;      // #8 — filled asynchronously; null until then

  function makeNoise(c) {
    const buf = c.createBuffer(1, c.sampleRate * NOISE_SECONDS, c.sampleRate);
    const d = buf.getChannelData(0);
    // Brownian-ish noise: cheaper than true pink, and the low-frequency weighting is what
    // makes it read as "rumble" and "crowd" rather than as a hiss.
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  // ── #10 Convolution reverb ────────────────────────────────────────────
  // A synthetic impulse response: stereo decaying noise with a slight inter-channel difference
  // so the tail has width. Written straight into an AudioBuffer — synchronous, a few ms, and
  // zero asset files. One ConvolverNode serves the whole game.
  function makeImpulseResponse(c) {
    const len = Math.floor(c.sampleRate * IR_SECONDS);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Exponential decay with a short pre-delay ramp, so the tail sounds like a space rather
        // than a noise burst pasted on the end of every sound.
        const env = Math.pow(1 - t, 2.6) * Math.min(1, t * 60);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  // ── #8 Pre-rendered impact bank ───────────────────────────────────────
  // Renders IMPACT_VARIANTS distinct marble impacts once, through an OfflineAudioContext, into
  // reusable AudioBuffers. Two reasons this beats the old per-hit oscillator graph:
  //
  //  1. COST. Playing an impact becomes one AudioBufferSourceNode with no scheduled ramps,
  //     instead of an oscillator + gain + four automation events built and torn down per hit.
  //  2. VARIATION. A single synthesized clink is exactly why repeated hits sounded like a
  //     machine gun. Eight variants, plus playbackRate jitter at play time, removes that.
  //
  // Rendering is async. Until it resolves, playClink falls back to the original oscillator path,
  // so there is never a silent window at the start of a race.
  async function makeImpactBank(sampleRate) {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) return null;
    const len = Math.ceil(sampleRate * IMPACT_SECONDS);
    const renders = [];
    for (let v = 0; v < IMPACT_VARIANTS; v++) {
      const oc = new OfflineCtx(1, len, sampleRate);
      // Spread the variants across pitch, decay and tone/noise balance so no two hits in a
      // pile-up are the same sound.
      const f0 = 420 + (v / (IMPACT_VARIANTS - 1)) * 900;
      const decay = 0.075 + (v % 3) * 0.02;
      const out = oc.createGain();
      out.gain.value = 1;
      out.connect(oc.destination);

      // Tonal body: a triangle dropping in pitch — the "glass" of the marble.
      const osc = oc.createOscillator();
      osc.type = v % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(f0, 0);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, decay);
      const og = oc.createGain();
      og.gain.setValueAtTime(0.0001, 0);
      og.gain.exponentialRampToValueAtTime(0.9, 0.003);
      og.gain.exponentialRampToValueAtTime(0.0001, decay);
      osc.connect(og).connect(out);
      osc.start(0);
      osc.stop(decay + 0.01);

      // Transient: a very short filtered noise tick that gives the hit its edge. Without this
      // the impact reads as a bell rather than a strike.
      const nb = oc.createBuffer(1, Math.ceil(sampleRate * 0.02), sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
      const nsrc = oc.createBufferSource();
      nsrc.buffer = nb;
      const hp = oc.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800 + v * 220;
      const ng = oc.createGain();
      ng.gain.setValueAtTime(0.5, 0);
      ng.gain.exponentialRampToValueAtTime(0.0001, 0.03);
      nsrc.connect(hp).connect(ng).connect(out);
      nsrc.start(0);

      renders.push(oc.startRendering());
    }
    try { return await Promise.all(renders); } catch { return null; }
  }

  function buildBeds(c) {
    noiseBuf = makeNoise(c);

    // Rolling bed: noise through a bandpass whose frequency rides marble speed.
    rollSrc = c.createBufferSource();
    rollSrc.buffer = noiseBuf;
    rollSrc.loop = true;
    rollFilter = c.createBiquadFilter();
    rollFilter.type = 'bandpass';
    rollFilter.frequency.value = 220;
    rollFilter.Q.value = 1.1;
    rollGain = c.createGain();
    rollGain.gain.value = 0;
    // Tremolo: an LFO added onto a unity gain. Depth 0 leaves the bed untouched.
    rollTrem = c.createGain();
    rollTrem.gain.value = 1;
    tremOsc = c.createOscillator();
    tremOsc.type = 'triangle';
    tremOsc.frequency.value = 12;
    tremDepth = c.createGain();
    tremDepth.gain.value = 0;
    tremOsc.connect(tremDepth).connect(rollTrem.gain);
    tremOsc.start();
    rollSrc.connect(rollFilter).connect(rollGain).connect(rollTrem).connect(bedBus);
    rollSrc.start();

    // Crowd bed: the same noise, lowpassed hard and swelled as the race resolves.
    crowdSrc = c.createBufferSource();
    crowdSrc.buffer = noiseBuf;
    crowdSrc.loop = true;
    crowdFilter = c.createBiquadFilter();
    crowdFilter.type = 'lowpass';
    crowdFilter.frequency.value = 900;
    crowdFilter.Q.value = 0.7;
    crowdGain = c.createGain();
    crowdGain.gain.value = 0;
    crowdSrc.connect(crowdFilter).connect(crowdGain).connect(bedBus);
    crowdSrc.start();

    // #10 TENSION DRONE — the "background audio node". Three detuned saws through a lowpass.
    // Gain and cutoff are driven by how close the race is to resolving (see updateBeds), so it
    // rises under the crowd through the whole race and RESOLVES at the line (see resolveDrone),
    // giving the ending a musical release rather than only a chime.
    //
    // A2 (110 Hz) root with a fifth above it. Detuning the unisons by a few cents is what stops
    // three oscillators from summing into one sterile tone.
    droneFilter = c.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 220;
    droneFilter.Q.value = 3.2;
    droneGain = c.createGain();
    droneGain.gain.value = 0;
    droneFilter.connect(droneGain).connect(bedBus);
    droneOscs = [];
    droneBase = [];
    for (const [freq, detune] of [[110, -7], [110, 9], [164.81, 4]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(droneFilter);
      o.start();
      droneOscs.push(o);
      droneBase.push(freq);
    }
  }

  // #10 — put the drone back to its root pitch for a new race. The audio context is built ONCE
  // and survives every track regeneration (game.js _nextTrack rebuilds the world, not the
  // sound), so without this the fifth that resolveDrone() steps up by would compound race after
  // race until the drone was a whistle.
  function resetDrone() {
    if (!ctx || !droneOscs) return;
    const now = ctx.currentTime;
    droneOscs.forEach((o, i) => {
      o.frequency.cancelScheduledValues(now);
      o.frequency.setValueAtTime(droneBase[i], now);
    });
    droneGain.gain.cancelScheduledValues(now);
    droneGain.gain.setValueAtTime(0, now);
  }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      // Shared context (js/audioBus.js) — one AudioContext for the whole app. `ownsCtx` records
      // whether this module made its own, because only then may dispose() close it: closing the
      // shared one silenced every other game (and the music) for the rest of the visit.
      ctx = (window.PoAudioBus && window.PoAudioBus.contextSync()) || null;
      if (!ctx) { ctx = new AC(); ownsCtx = true; }

      // #7 — master → compressor → destination. The compressor is the safety net that the old
      // single-gain graph never had: it catches the gun, a sting and a burst of impacts landing
      // together instead of letting them sum past full scale.
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      master.connect(comp).connect(
        (window.PoAudioBus && window.PoAudioBus.busSync('sfx')) || ctx.destination);

      // Two buses so the beds can be ducked independently of the one-shots.
      bedBus = ctx.createGain();
      bedBus.gain.value = 1;
      bedBus.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);

      // #10 — reverb on a SEND, not inline, so the dry signal stays present and only a
      // controlled amount of the one-shot bus is wetted. One convolver for the whole game.
      convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      reverbSend = ctx.createGain();
      reverbSend.gain.value = 0.22;
      sfxBus.connect(reverbSend).connect(convolver).connect(master);

      buildBeds(ctx);

      // #8 — kick off the offline render. Nothing waits on it; playClink uses the synthesized
      // fallback until the bank lands.
      makeImpactBank(ctx.sampleRate).then((bank) => { impactBank = bank; }).catch(() => { });
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // #7 — pull the beds down briefly so a one-shot owns the moment, then let them back up.
  function duck(amount = 0.35, hold = 0.25) {
    if (!ctx || !bedBus) return;
    const now = ctx.currentTime;
    bedBus.gain.cancelScheduledValues(now);
    bedBus.gain.setTargetAtTime(amount, now, 0.02);
    bedBus.gain.setTargetAtTime(1, now + hold, 0.22);
  }

  // #9 — wire a one-shot's output through an optional stereo pan + distance gain. Returns the
  // node a source should connect INTO. With no cue this is just the bus, so nothing is spent on
  // sounds that have no position (countdown pips, result stings).
  function cueNode(cue) {
    if (!cue || !ctx.createStereoPanner) return sfxBus;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, cue.pan || 0));
    const g = ctx.createGain();
    g.gain.value = cue.gain == null ? 1 : cue.gain;
    p.connect(g).connect(sfxBus);
    return p;
  }

  // ── Continuous beds ───────────────────────────────────────────────────
  // Called every frame from the game loop. `speed` is the focused marble's speed and `surface` a
  // SURFACES key for what it is touching; `nearFinish` (0..1) drives the crowd and the drone.
  function updateBeds(speed, nearFinish, racing, surface) {
    if (!ctx || !rollGain) return;
    const now = ctx.currentTime;
    const v = Math.min(1, Math.max(0, speed / 45));
    const sf = SURFACES[surface] || SURFACES.surface;
    // A filter TYPE can't be ramped, so it only changes on a surface change (a click there is
    // masked by the change itself); everything continuous is ramped.
    if (surface !== rollKind && SURFACES[surface]) {
      rollKind = surface;
      rollFilter.type = sf.type;
      rollFilter.Q.setTargetAtTime(sf.q, now, 0.03);
      tremOsc.frequency.setTargetAtTime(sf.rate || 12, now, 0.03);
    }
    // Ramp rather than set: a per-frame setValueAtTime on a gain is a zipper-noise generator.
    const rollTarget = racing ? (0.02 + v * 0.16) * sf.gain : 0;
    rollGain.gain.setTargetAtTime(rollTarget, now, surface === 'air' ? 0.03 : 0.08);
    rollFilter.frequency.setTargetAtTime(sf.lo + v * sf.span, now, 0.08);
    tremDepth.gain.setTargetAtTime(sf.trem * (0.4 + 0.6 * v), now, 0.05);

    const near = Math.max(0, Math.min(1, nearFinish));
    const crowdTarget = racing ? 0.015 + near * 0.13 : 0.01;
    crowdGain.gain.setTargetAtTime(crowdTarget, now, 0.25);
    crowdFilter.frequency.setTargetAtTime(600 + near * 1400, now, 0.25);

    // #10 drone: barely there at the start of a race, unmistakable by the last stretch. The
    // filter opening is what makes it feel like it's building rather than just getting louder.
    if (droneGain) {
      droneGain.gain.setTargetAtTime(racing ? 0.012 + near * near * 0.075 : 0, now, 0.5);
      droneFilter.frequency.setTargetAtTime(180 + near * 620, now, 0.5);
    }
  }

  // #10 — the release. Called when the race resolves: the drone steps up a fifth and fades,
  // which is what turns a rising tension into an ending instead of a cut-off.
  function resolveDrone() {
    if (!ctx || !droneGain) return;
    const now = ctx.currentTime;
    for (const o of droneOscs) {
      o.frequency.setTargetAtTime(o.frequency.value * 1.5, now, 0.12);
    }
    droneFilter.frequency.setTargetAtTime(1400, now, 0.15);
    droneGain.gain.setTargetAtTime(0.06, now, 0.05);
    droneGain.gain.setTargetAtTime(0, now + 0.7, 0.4);
  }

  function silenceBeds() {
    if (!ctx || !rollGain) return;
    const now = ctx.currentTime;
    rollGain.gain.setTargetAtTime(0, now, 0.1);
    crowdGain.gain.setTargetAtTime(0, now, 0.1);
    // The drone is deliberately NOT silenced here — resolveDrone() lands its release first, and
    // cutting the gain at the same moment would swallow it.
  }

  // ── One-shots ─────────────────────────────────────────────────────────
  // `dest` defaults to the one-shot bus; pass a cueNode() to place the sound in the stereo
  // field (#9).
  function tone(freq, start, dur, peak, type, endFreq, dest) {
    const c = ctx;
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(dest || sfxBus);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // A marble impact. volume/pitch scale with impact speed; `cue` places it in the stereo field.
  // Prefers a pre-rendered buffer from the #8 bank and falls back to the original synthesized
  // clink while the offline render is still in flight.
  function playClink(speed, cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    // Throttle relaxed from 20ms: that gate existed because every hit was the SAME sound, so
    // dense traffic turned into a machine gun. With eight variants and pitch jitter it doesn't,
    // and gating it now just makes a pile-up sound thinner than it is.
    if (now - lastClink < 0.008) return;
    lastClink = now;

    const v = Math.min(1, speed / 22);
    const dest = cueNode(cue);

    if (impactBank && impactBank.length) {
      const src = c.createBufferSource();
      src.buffer = impactBank[(Math.random() * impactBank.length) | 0];
      // Harder hits are pitched up as well as louder — the pitch is most of what the ear reads
      // as force. The jitter keeps two hits of identical speed from being identical sounds.
      src.playbackRate.value = 0.82 + v * 0.5 + (Math.random() - 0.5) * 0.12;
      const g = c.createGain();
      g.gain.value = 0.05 + v * 0.2;
      src.connect(g).connect(dest);
      src.start(now);
      return;
    }

    // Fallback: the original oscillator clink, used only until the bank finishes rendering.
    const freq = 320 + v * 900;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05 + v * 0.18, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(dest);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  // Countdown pip. `final` is the go tone — higher and longer. Deliberately unspatialized: it's
  // a UI sound, not a thing happening on the track.
  function playBeep(final) {
    const c = ensure();
    if (!c) return;
    tone(final ? 1046.5 : 660, c.currentTime + 0.01, final ? 0.22 : 0.09, 0.14, 'square');
  }

  // Starting gun: a noise crack through a fast-decaying highpass.
  function playGun() {
    const c = ensure();
    if (!c || !noiseBuf) return;
    const now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800;
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    src.connect(hp).connect(g).connect(sfxBus);
    src.start(now);
    src.stop(now + 0.25);
    tone(90, now, 0.18, 0.3, 'sine', 40); // body thump under the crack
    duck(0.3, 0.3);                        // #7 — the gun owns the moment
    resetDrone();                          // #10 — new race, tension starts from zero again
  }

  // Boost pad: a rising whoosh.
  function playWhoosh(cue) {
    const c = ensure();
    if (!c) return;
    tone(240, c.currentTime + 0.01, 0.26, 0.09, 'sawtooth', 900, cueNode(cue));
  }

  // Overtake: a two-note rise when you gain a place, a fall when you lose one. Throttled — the
  // pack trades places constantly in traffic. `cue` places it where the OTHER marble is (the one
  // you passed, or the one that passed you), so you hear which side the move happened on.
  function playOvertake(gained, cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastOvertake < 0.5) return;
    lastOvertake = now;
    const a = gained ? 587.33 : 466.16;
    const b = gained ? 880.0 : 349.23;
    const dest = cueNode(cue ? { pan: cue.pan, gain: 1 } : null);
    tone(a, now + 0.01, 0.09, 0.1, 'square', null, dest);
    tone(b, now + 0.09, 0.11, 0.1, 'square', null, dest);
  }

  // Your own top-10 finish: a crowd roar that swells in and rolls off over ~2 s, on top of the
  // finish chime. The same noise buffer as the beds, lowpassed into a mass of voices.
  function playRoar() {
    const c = ensure();
    if (!c || !noiseBuf) return;
    const now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, now);
    lp.frequency.linearRampToValueAtTime(1600, now + 0.35);
    lp.frequency.linearRampToValueAtTime(700, now + 2.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.45, now + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.3);
    src.connect(lp).connect(g).connect(sfxBus);
    src.start(now);
    src.stop(now + 2.4);
    duck(0.4, 0.6);
  }

  // Finish chime for a marble crossing the line. Spatialized, so a pack finishing ahead of you
  // spreads across the stereo field instead of stacking dead centre.
  function playFinish(cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    const dest = cueNode(cue);
    tone(880, now + 0.01, 0.13, 0.11, 'triangle', null, dest);
    tone(1318.5, now + 0.07, 0.16, 0.09, 'triangle', null, dest);
  }

  // Win = rising triad, lose = falling minor.
  function playSting(win) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + 0.02;
    const notes = win ? [523.25, 659.25, 783.99] : [392.0, 311.13, 261.63];
    notes.forEach((f, i) => tone(f, t + i * 0.12, 0.28, 0.16, 'square'));
    duck(0.25, 0.5);   // #7 — clear the beds out from under the result
    resolveDrone();    // #10 — land the tension the drone has been building
  }

  function applyMute() {
    if (!master || !ctx) return;
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
  }

  return {
    resume() { ensure(); },
    playClink,
    playSting,
    playBeep,
    playGun,
    playWhoosh,
    playOvertake,
    playRoar,
    playFinish,
    updateBeds,
    silenceBeds,
    setMuted(m) { muted = !!m; applyMute(); },
    toggleMuted() { muted = !muted; applyMute(); return muted; },
    isMuted() { return muted; },
    dispose() {
      if (ctx) {
        try { rollSrc && rollSrc.stop(); } catch { }
        try { crowdSrc && crowdSrc.stop(); } catch { }
        // The drone oscillators are long-running sources like the beds — leaving them started
        // keeps the context alive after close() in some browsers.
        if (droneOscs) for (const o of droneOscs) { try { o.stop(); } catch { } }
        try { tremOsc && tremOsc.stop(); } catch { }
        // The shared context outlives this game: detach our graph from it instead of closing it.
        if (ownsCtx) { try { ctx.close(); } catch { } } else { try { master && master.disconnect(); } catch { } }
        ctx = null; master = null; comp = null; bedBus = null; sfxBus = null;
        rollTrem = null; tremOsc = null; tremDepth = null; ownsCtx = false;
        reverbSend = null; convolver = null;
        rollSrc = null; crowdSrc = null; rollGain = null; crowdGain = null;
        droneOscs = null; droneGain = null; droneFilter = null; droneBase = null;
        impactBank = null;
      }
    },
  };
}
