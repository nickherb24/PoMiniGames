// audio.js — synthesized audio bus for PoBrawl.
// No audio files; everything is generated from OscillatorNode + filtered noise.
// Architecture:
//   master gain -> glue compressor -> limiter -> destination
//     ├── sfxGain       (impacts, blocks, KO, voice grunts)
//     │     ├── panner (per source; StereoPanner keyed off world-x)
//     │     └── reverbSend -> convolver -> reverbGain -> master
//     ├── musicGain     (round-start loop stem + low-HP tension)
//     └── introGain     (round-start chiptune riff)
//
// Every public method is a no-op while muted so the game can call them freely.

// Seconds of shared noise; longer than any sound reading it, so each playback
// starts at a random offset (`_noiseSource`).
const NOISE_SECONDS = 2;

// Half-width of the arena in world units, for mapping world-x -> stereo pan.
const ARENA_HALF_WIDTH = 6;

// Music scheduler: wake every LOOKAHEAD_MS, queue notes due within SCHEDULE_AHEAD
// seconds. SCHEDULE_AHEAD is the main-thread stall budget — a round opening can
// block a few hundred ms, and anything longer drains the queue audibly.
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.45;

// SFX-bus lowpass: open (20 kHz, not Infinity — the corner's phase response stays
// out of band) normally, swept down to MUFFLED (Hz) for the concussion.
const SFX_FILTER_OPEN = 20000;
const SFX_FILTER_MUFFLED = 420;
// Music sidechain attack/release, seconds.
const DUCK_ATTACK = 0.012;
const DUCK_RELEASE = 0.32;

// Crowd bed: three filtered-noise layers; intensity raises level and brightens the mid band.
const CROWD_BASE_GAIN = 0.05;
const CROWD_PEAK_GAIN = 0.16;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Simple low-passed white noise — closer to "thud" than harsh hiss.
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.15 * white) / 1.15;
    data[i] = last;
  }
  return buf;
}

// Synthesized IR: exponentially decaying, decorrelated stereo noise.
function makeImpulseResponse(ctx, duration = 1.2, decay = 2.6) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

// Release `nodes` once `source` ends, or a flurry piles up live nodes on the audio thread.
function autoDisconnect(source, nodes) {
  source.onended = () => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
  };
}

// Announcer voice, cached (getVoices() is slow). Not shared with pojoker-speech-interop.js:
// this wants an American, deep, LOCAL voice — network voices ("Natural", "Online") lag
// hundreds of ms, and a late "K.O." is worse than a robotic one.
let _announcerVoice = null;
let _announcerVoiceResolved = false;
function pickAnnouncerVoice() {
  if (_announcerVoiceResolved) return _announcerVoice;
  let voices = [];
  try { voices = window.speechSynthesis?.getVoices() || []; } catch { return null; }
  // Voice lists populate asynchronously on Chrome; an empty list means "not
  // yet", not "none", so stay unresolved and try again on the next call.
  if (!voices.length) return null;
  const local = voices.filter((v) => v.localService !== false
    && !/natural|online/i.test(v.name));
  const pool = local.length ? local : voices;
  _announcerVoice =
    pool.find((v) => v.lang?.startsWith('en-US') && /david|mark|guy|male/i.test(v.name))
    || pool.find((v) => v.lang?.startsWith('en') && /david|mark|guy|male/i.test(v.name))
    || pool.find((v) => v.lang?.startsWith('en-US'))
    || pool.find((v) => v.lang?.startsWith('en'))
    || pool[0]
    || null;
  _announcerVoiceResolved = true;
  return _announcerVoice;
}

// Per-fighter grunt voice: pitch f0 (Hz), vowel formants f1/f2 (Hz), rasp = breath
// noise through the upper formant (0..1). Unknown ids use DEFAULT_VOICE.
const VOICES = {
  trump:      { f0: 105, f1: 650, f2: 1100, rasp: 0.35 },
  biden:      { f0: 118, f1: 600, f2: 1300, rasp: 0.45 },
  obama:      { f0: 98,  f1: 560, f2: 1050, rasp: 0.15 },
  bush:       { f0: 112, f1: 700, f2: 1250, rasp: 0.25 },
  clinton:    { f0: 120, f1: 620, f2: 1350, rasp: 0.6 },
  bushsr:     { f0: 130, f1: 580, f2: 1450, rasp: 0.2 },
  reagan:     { f0: 108, f1: 540, f2: 1150, rasp: 0.5 },
  carter:     { f0: 125, f1: 660, f2: 1500, rasp: 0.15 },
  ford:       { f0: 110, f1: 600, f2: 1200, rasp: 0.2 },
  nixon:      { f0: 100, f1: 520, f2: 1000, rasp: 0.3 },
  lbj:        { f0: 95,  f1: 640, f2: 1080, rasp: 0.4 },
  jfk:        { f0: 122, f1: 700, f2: 1400, rasp: 0.2 },
  eisenhower: { f0: 115, f1: 560, f2: 1250, rasp: 0.25 },
  truman:     { f0: 128, f1: 620, f2: 1550, rasp: 0.15 },
  fdr:        { f0: 104, f1: 580, f2: 1150, rasp: 0.2 },
};
const DEFAULT_VOICE = { f0: 112, f1: 600, f2: 1250, rasp: 0.25 };

// Note name → semitone (C4 = MIDI 60); sharps (#) and flats (b).
const NOTE_NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
                     F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8,
                     A: 9, 'A#': 10, Bb: 10, B: 11 };
function noteToFreq(name) {
  const m = /^([A-G][#b]?)(-?\d+)$/.exec(name);
  if (!m) return 440;
  const semi = NOTE_NAMES[m[1]];
  const oct = parseInt(m[2], 10);
  const midi = (oct + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Round-start chiptune intros: ≤5 s two-voice riffs (melody = detuned squares,
// bass = triangle), [note, beats]. Keys MUST match the charId in fighters.js.
const INTRO_THEMES = {
  // Donald Trump (2017-2021) — riff from "Eye of the Tiger" (Survivor, 1982)
  trump: {
    bpm: 138,
    melody: [
      ['E4', 0.5], ['E4', 0.5], ['G#4', 0.5], ['E4', 0.5],
      ['B3', 0.5], ['C5', 0.5], ['D5', 0.5], ['E5', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['G#4', 0.5], ['E4', 0.5],
      ['B3', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ],
    bass: [['E2', 2], ['A2', 2], ['E2', 2], ['B2', 2]],
  },
  // Joe Biden (2021-2025) — riff from "Don't Stop Believin'" (Journey, 1981)
  biden: {
    bpm: 119,
    melody: [
      ['E4', 1], ['E4', 1], ['G4', 1], ['E4', 1],
      ['G4', 0.5], ['A4', 0.5], ['B4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['F#4', 0.5], ['E4', 1], ['D4', 1],
    ],
    bass: [['E2', 2], ['A2', 2], ['D3', 2], ['A2', 2]],
  },
  // Barack Obama (2009-2017) — riff from "Signed, Sealed, Delivered" (Stevie Wonder, 1970)
  obama: {
    bpm: 110,
    melody: [
      ['F4', 0.5], ['F4', 0.5], ['Eb4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['Eb4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['Eb4', 0.5], ['F4', 1], ['G4', 1],
    ],
    bass: [['F2', 2], ['Bb2', 2], ['F2', 2], ['C3', 2]],
  },
  // George W. Bush (2001-2009) — riff from "Sweet Home Alabama" (Lynyrd Skynyrd, 1974)
  bush: {
    bpm: 96,
    melody: [
      ['D5', 0.5], ['D5', 0.5], ['C5', 0.5], ['G4', 0.5],
      ['D5', 0.5], ['D5', 0.5], ['C5', 0.5], ['G4', 0.5],
      ['D5', 0.5], ['C5', 0.5], ['G4', 1], ['D5', 1],
    ],
    bass: [['D2', 2], ['G2', 2], ['D2', 2], ['A2', 2]],
  },
  // Bill Clinton (1993-2001) — riff from "Don't Stop" (Fleetwood Mac, 1977)
  clinton: {
    bpm: 120,
    melody: [
      ['G4', 1], ['D5', 1], ['E5', 1], ['D5', 0.5],
      ['C5', 0.5], ['D5', 1], ['E5', 0.5], ['D5', 0.5],
      ['E5', 0.5], ['D5', 0.5], ['C5', 1], ['B4', 1],
    ],
    bass: [['G2', 2], ['D3', 2], ['E2', 2], ['C3', 2]],
  },
  // George H.W. Bush (1989-1993) — riff from "I've Been Everywhere" (Johnny Cash, 1962)
  bushsr: {
    bpm: 130,
    melody: [
      ['A4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ],
    bass: [['A2', 2], ['E2', 2], ['D2', 2], ['A2', 2]],
  },
  // Ronald Reagan (1981-1989) — riff from "God Bless the U.S.A." (Lee Greenwood, 1984)
  reagan: {
    bpm: 110,
    melody: [
      ['C5', 0.5], ['G4', 0.5], ['A4', 0.5], ['F4', 0.5],
      ['C5', 0.5], ['G4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['C5', 0.5], ['G4', 0.5], ['A4', 0.5], ['F4', 0.5],
      ['C5', 1], ['G4', 1],
    ],
    bass: [['C2', 2], ['G2', 2], ['A1', 2], ['F2', 2]],
  },
  // Jimmy Carter (1977-1981) — riff from "Georgia on My Mind" (Ray Charles, 1960)
  carter: {
    bpm: 80,
    melody: [
      ['F4', 1], ['E4', 0.5], ['F4', 0.5], ['A4', 1],
      ['G4', 0.5], ['F4', 0.5], ['E4', 1], ['D4', 1],
    ],
    bass: [['F2', 2], ['C2', 2], ['D2', 2], ['Bb1', 2]],
  },
  // Gerald Ford (1974-1977) — riff from "Rock the Boat" (The Hues Corporation, 1974)
  ford: {
    bpm: 124,
    melody: [
      ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['E4', 0.5],
      ['D4', 0.5], ['E4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['A4', 0.5], ['B4', 0.5], ['C5', 0.5], ['D5', 0.5],
      ['C5', 1],
    ],
    bass: [['A1', 2], ['G1', 2], ['F1', 2], ['E1', 2]],
  },
  // Richard Nixon (1969-1974) — riff from "(Sittin' On) The Dock of the Bay" (Otis Redding, 1968)
  nixon: {
    bpm: 104,
    melody: [
      ['G4', 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
      ['G4', 1], ['E4', 1],
      ['G4', 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
      ['A4', 0.5], ['G4', 1],
    ],
    bass: [['G2', 2], ['E2', 2], ['A1', 2], ['G2', 2]],
  },
  // Lyndon B. Johnson (1963-1969) — riff from "Ballad of the Green Berets" (Barry Sadler, 1966)
  lbj: {
    bpm: 88,
    melody: [
      ['C4', 0.5], ['C4', 0.5], ['E4', 0.5], ['G4', 0.5],
      ['G4', 0.5], ['E4', 0.5], ['C4', 0.5], ['D4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['F4', 0.5], ['E4', 0.5],
      ['D4', 1], ['C4', 1],
    ],
    bass: [['C2', 2], ['G2', 2], ['F2', 2], ['C2', 2]],
  },
  // John F. Kennedy (1961-1963) — riff from "High Hopes" (Frank Sinatra, 1959)
  jfk: {
    bpm: 120,
    melody: [
      ['A4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['C5', 0.5], ['B4', 0.5],
      ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['A4', 1], ['E4', 1],
    ],
    bass: [['A1', 2], ['E2', 2], ['F#1', 2], ['D2', 2]],
  },
  // Dwight D. Eisenhower (1953-1961) — riff from "In the Mood" (Glen Miller, 1939)
  eisenhower: {
    bpm: 150,
    melody: [
      ['F4', 0.5], ['D5', 0.5], ['C5', 0.5], ['A4', 0.5],
      ['Bb4', 0.5], ['A4', 0.5], ['G4', 0.5], ['F4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['Bb4', 0.5], ['C5', 0.5],
      ['D5', 1], ['C5', 1],
    ],
    bass: [['Bb1', 2], ['F2', 2], ['G2', 2], ['C3', 2]],
  },
  // Harry S. Truman (1945-1953) — riff from "Sentimental Journey" (Les Brown / Doris Day, 1945)
  truman: {
    bpm: 100,
    melody: [
      ['C4', 0.5], ['E4', 0.5], ['G4', 0.5], ['C5', 0.5],
      ['B4', 0.5], ['A4', 0.5], ['G4', 0.5], ['E4', 0.5],
      ['F4', 0.5], ['G4', 0.5], ['A4', 0.5], ['B4', 0.5],
      ['C5', 1], ['G4', 1],
    ],
    bass: [['C2', 2], ['G1', 2], ['F1', 2], ['C2', 2]],
  },
  // Franklin D. Roosevelt (1933-1945) — riff from "Happy Days Are Here Again" (1929)
  fdr: {
    bpm: 100,
    melody: [
      ['G4', 0.5], ['G4', 0.5], ['G4', 0.5], ['C5', 0.5],
      ['B4', 0.5], ['A4', 0.5], ['G4', 0.5], ['F4', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['A4', 0.5], ['G4', 0.5],
      ['F4', 1], ['E4', 1],
    ],
    bass: [['G2', 2], ['D2', 2], ['C2', 2], ['G1', 2]],
  },
};

// Lazy AudioContext + master bus, built on first call.
class AudioBus {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.reverbGain = null; // wet level for the convolver send
    this.noiseBuf = null;
    this.musicNodes = null;
    this.introGain = null;  // dedicated bus for round-start chiptune intros
    this.introNodes = null; // active intro oscillators/gains, for cleanup
    this._introRestoreVol = 0.35; // remembered musicGain value to restore after ducking
    this.lowMusicCrossfade = 0; // 0 = normal stem, 1 = low-HP stem
    this._ensureFailed = false; // latched so a broken graph can't report success
    // Audio-reactive envelope for the bloom pulse (getEnvelope); SFX nudge it, tick(dt)
    // decays it. Both must start at 0 or tick chases a ceiling and pins the bloom on.
    this._env = 0;
    this._envPeak = 0; // ceiling for the latest hit; decays in tick()
    this.sfxFilter = null;   // concussion lowpass, in-line on the SFX bus
    this.musicDuck = null;   // sidechain VCA between musicGain and master
    this.crowdGain = null;   // crowd bed level (owned by setCrowdIntensity)
    this.crowdDuck = null;   // crowd duck VCA (owned by the announcer)
    this._crowdBase = 0;     // level setCrowdIntensity last asked for
    this._crowdNodes = null; // live crowd oscillators/sources, for teardown
    this._crowdIntensity = 0;
    this._hitstopDepth = 0;  // 0 = normal, 1 = fully "in the vacuum"
    this._speaking = false;
  }

  _ensure() {
    if (this.ctx && !this._ensureFailed) return true;
    if (this._ensureFailed) return false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { this._ensureFailed = true; return false; }
      // Shared context (js/audioBus.js) — one AudioContext for the whole app.
      const shared = window.PoAudioBus && window.PoAudioBus.contextSync();
      const ctx = shared || new Ctor();
      this.ctx = ctx;
      // Only a context we made is ours to close — see close().
      this._ownsCtx = !shared;

      this.master = ctx.createGain();
      this.master.gain.value = 0.85;

      // Glue compressor, then a brickwall limiter to stay under 0 dBFS.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      this.master.connect(comp).connect(limiter).connect(
        (window.PoAudioBus && window.PoAudioBus.busSync('sfx')) || ctx.destination);
      // Post-limiter mix, tapped by tapStream() for the KO clip recorder (clip.js).
      this.out = limiter;

      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = 1.0;

      // Concussion filter: dry AND wet pass through it, so the reverb muffles too.
      this.sfxFilter = ctx.createBiquadFilter();
      this.sfxFilter.type = 'lowpass';
      this.sfxFilter.frequency.value = SFX_FILTER_OPEN;
      // Non-resonant, so the sweep doesn't whistle.
      this.sfxFilter.Q.value = 0.0001;
      this.sfxGain.connect(this.sfxFilter);
      this.sfxFilter.connect(this.master);

      // Parallel reverb send, so the wet level is tunable on its own.
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.18;
      this.sfxFilter.connect(convolver).connect(this.reverbGain).connect(this.master);

      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.35;
      // Sidechain VCA: a separate gain because setMusicTension/playIntroTheme own (and
      // cancelScheduledValues on) musicGain. One owner per automation stage.
      this.musicDuck = ctx.createGain();
      this.musicDuck.gain.value = 1.0;
      // Danger lowpass, owned by setDanger(); wide open unless a fighter nears KO.
      this.musicLP = ctx.createBiquadFilter();
      this.musicLP.type = 'lowpass';
      this.musicLP.frequency.value = SFX_FILTER_OPEN;
      this.musicLP.Q.value = 0.0001;
      this.musicGain.connect(this.musicLP).connect(this.musicDuck).connect(this.master);

      // Crowd bed bus, outside sfx/music. Two stages, two owners: crowdGain
      // (setCrowdIntensity) and crowdDuck (the announcer).
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      this.crowdDuck = ctx.createGain();
      this.crowdDuck.gain.value = 1.0;
      this.crowdGain.connect(this.crowdDuck).connect(this.master);

      // Round-start chiptune bus, separate so ducking the loop leaves the intro alone.
      this.introGain = ctx.createGain();
      this.introGain.gain.value = 0.15;
      this.introGain.connect(this.master);

      this.noiseBuf = makeNoiseBuffer(ctx);
      return true;
    } catch (e) {
      // Latch the failure so a half-built graph never reports success.
      this._ensureFailed = true;
      try { console.error('[pobrawl/audio] AudioContext setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  // One-shot noise source at a random offset into the shared buffer.
  _noiseSource(playSeconds) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const maxOffset = Math.max(0, this.noiseBuf.duration - playSeconds - 0.01);
    src._offset = Math.random() * maxOffset;
    return src;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.85;
    // The crowd bed loops, so tear it down on mute rather than leave it running.
    if (this.muted) this.stopCrowd();
    else if (this.ctx) this.startCrowd();
    // Speech bypasses master.gain, so mute has to stop it separately.
    if (this.muted) this.stopAnnounce();
  }

  // Big hits ~1.0, blocks ~0.4, whooshes ~0.2.
  _pulse(power) {
    this._envPeak = Math.max(this._envPeak, Math.min(1, power));
  }

  // Per-frame decay (~90 ms halflife; silence → 0 in ~0.5 s). The ceiling decays
  // too, since _pulse only raises it.
  tick(dt) {
    this._envPeak *= Math.exp(-dt * 4.0);
    const decay = Math.exp(-dt * 7.5);
    this._env = this._envPeak * (1 - decay) + this._env * decay;
    if (this._env < 0.005 && this._envPeak < 0.005) { this._env = 0; this._envPeak = 0; }
  }

  getEnvelope() { return this._env; }

  // Resume the context after a user gesture.
  async resume() {
    if (this._ensure() && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
  }

  // One-shot spatializer: StereoPanner keyed off world-x (cheap; fits the side-on camera).
  _spatializer(worldPos) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      // Max 0.8: hard-panned mono reads as broken on headphones.
      p.pan.value = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8 : 0;
      return p;
    }
    // Fallback (no StereoPannerNode): equal-power pan across a 2-channel merger.
    const splitL = ctx.createGain();
    const splitR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const x = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8 : 0;
    const angle = (x + 1) * Math.PI / 4; // 0..PI/2
    splitL.gain.value = Math.cos(angle);
    splitR.gain.value = Math.sin(angle);
    const input = ctx.createGain();
    input.connect(splitL).connect(merger, 0, 0);
    input.connect(splitR).connect(merger, 0, 1);
    // Callers connect to the returned node and read `.output` for the tail.
    input.output = merger;
    return input;
  }

  // The fallback spatializer's output (merger) is not the node callers feed.
  _connectSpat(spat) {
    (spat.output || spat).connect(this.sfxGain);
    return spat;
  }

  // Layered impact: thud + crack + hiss. A kick lands lower and longer. Every layer
  // is randomized per call — identical repeats are the biggest synth tell.
  impact({ power = 1, blocked = false, worldPos = null, kind = 'punch' } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(blocked ? 0.45 : Math.min(1, 0.55 + power * 0.25));
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const heavy = kind === 'kick';

    // 1. Body thud (sine, fast decay). Kicks sit ~30 Hz lower and ring longer.
    const thudBase = blocked ? 180 : (heavy ? 65 : 95) + power * 35;
    const thudDecay = heavy ? 0.26 : 0.18;
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(thudBase * rand(0.88, 1.12), now);
    thud.frequency.exponentialRampToValueAtTime(heavy ? 38 : 45, now + (heavy ? 0.11 : 0.08));
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(
      blocked ? 0.18 : (heavy ? 0.40 : 0.34), now + rand(0.003, 0.007));
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + thudDecay);
    thud.connect(thudGain).connect(spat);
    thud.start(now); thud.stop(now + thudDecay + 0.04);
    autoDisconnect(thud, [thud, thudGain]);

    // 1b. Low-mid body — kicks only. Gives the weight a punch doesn't have.
    if (heavy && !blocked) {
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(rand(150, 190), now);
      body.frequency.exponentialRampToValueAtTime(80, now + 0.14);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.14, now + 0.006);
      bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
      body.connect(bodyGain).connect(spat);
      body.start(now); body.stop(now + 0.24);
      autoDisconnect(body, [body, bodyGain]);
    }

    // 2. Crack (bandpass noise burst).
    if (!blocked) {
      const crackDur = 0.08;
      const src = this._noiseSource(crackDur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = ((heavy ? 1300 : 1800) + power * 600) * rand(0.8, 1.2);
      bp.Q.value = rand(1.1, 1.8);
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.0001, now);
      crackGain.gain.linearRampToValueAtTime(0.22 + power * 0.05, now + rand(0.003, 0.006));
      crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      src.connect(bp).connect(crackGain).connect(spat);
      src.start(now, src._offset); src.stop(now + crackDur);
      autoDisconnect(src, [src, bp, crackGain]);
    }

    // 3. Hiss tail (highpass noise).
    const tailDur = 0.28;
    const tail = this._noiseSource(tailDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = rand(3400, 4600);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.0001, now);
    tailGain.gain.linearRampToValueAtTime(blocked ? 0.04 : 0.10, now + 0.01);
    tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    tail.connect(hp).connect(tailGain).connect(spat);
    tail.start(now, tail._offset); tail.stop(now + tailDur);
    // Last layer to finish, so it owns tearing down the shared spatializer.
    autoDisconnect(tail, [tail, hp, tailGain, spat, spat.output].filter(Boolean));
  }

  block(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));

    // Wooden "tap" — two short triangle hits, detuned and re-spaced per block.
    const spacing = rand(0.04, 0.06);
    const detune = rand(0.9, 1.1);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = (240 - i * 40) * detune;
      const g = ctx.createGain();
      const t0 = now + i * spacing;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.15, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + 0.09);
      // Second (last) tap tears down the shared spatializer.
      autoDisconnect(o, i === 1 ? [o, g, spat, spat.output].filter(Boolean) : [o, g]);
    }
  }

  ko() {
    if (!this._ensure() || this.muted) return;
    this._pulse(1.0);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Sub-bass thud + slow down sweep + crash noise.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.9);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, now);
    subG.gain.linearRampToValueAtTime(0.6, now + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    sub.connect(subG).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.25);
    autoDisconnect(sub, [sub, subG]);

    const crashDur = 1.05;
    const crash = this._noiseSource(crashDur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.0001, now);
    cG.gain.linearRampToValueAtTime(0.35, now + 0.04);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    crash.connect(lp).connect(cG).connect(this.sfxGain);
    crash.start(now, crash._offset); crash.stop(now + crashDur);
    autoDisconnect(crash, [crash, lp, cG]);
  }

  // Pain grunt when a hit lands. `charId` picks the president's voice (VOICES).
  grunt({ power = 1, blocked = false, charId = null } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.15 + power * 0.1);
    const v = VOICES[charId] || DEFAULT_VOICE;
    // Wide per-call spread: grunts repeat most, so they go robotic fastest.
    const f0 = v.f0 * (blocked ? 1.35 : 0.95 + power * 0.25) * rand(0.9, 1.12);
    this._voice(v, f0, f0 * rand(0.5, 0.62), rand(0.18, 0.24), 0.08, 1);
  }

  // Effort "hup" on a kick or a charged swing: shorter, higher, a more open vowel.
  effort(charId, power = 1) {
    if (!this._ensure() || this.muted) return;
    const v = VOICES[charId] || DEFAULT_VOICE;
    const f0 = v.f0 * (1.15 + 0.2 * power) * rand(0.94, 1.06);
    this._voice(v, f0, f0 * 0.8, 0.13, 0.05 + 0.02 * power, 1.25);
  }

  // One exhausted exhale — game.js breathes the fighter in the red between heartbeats.
  breath(charId, strength = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const v = VOICES[charId] || DEFAULT_VOICE;
    const src = this._noiseSource(0.7);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = v.f2 * rand(0.95, 1.1);
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.035 * clamp(strength, 0, 1), now + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.6);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + 0.65);
    autoDisconnect(src, [src, bp, g]);
  }

  // Shared vocal tract: a sawtooth glottis sliding fromHz → toHz, through two
  // formant bandpasses in parallel, plus breath noise through the upper formant.
  // `open` scales F1 (a wider mouth raises it — "ha" versus "uh").
  _voice(v, fromHz, toHz, dur, peak, open) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(fromHz, now);
    o.frequency.exponentialRampToValueAtTime(toHz, now + dur * 0.85);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(peak, now + 0.012);
    out.gain.exponentialRampToValueAtTime(0.001, now + dur);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = v.f1 * open * rand(0.94, 1.06);
    f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = v.f2 * rand(0.94, 1.06);
    f2.Q.value = 7;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.6;
    o.connect(f1).connect(out);
    o.connect(f2).connect(f2g).connect(out);
    const nodes = [o, f1, f2, f2g, out];
    if (v.rasp > 0.05) {
      const n = this._noiseSource(dur + 0.05);
      const ng = ctx.createGain();
      ng.gain.value = v.rasp * 0.9;
      n.connect(ng).connect(f2);
      n.start(now, n._offset); n.stop(now + dur + 0.02);
      autoDisconnect(n, [n, ng]);
    }
    out.connect(this.sfxGain);
    o.start(now); o.stop(now + dur + 0.03);
    autoDisconnect(o, nodes);
  }

  // Prop materials:
  //   wood  — a knock plus a three-mode crack (a plank's resonances ring for
  //           ~0.1 s, not a note), then a patter of splinters landing
  //   rope  — a low twang with a vibrato wobble: a cable under tension, not a string
  //   steel — inharmonic bar partials (1 : 2.76 : 5.4 : 8.93), a turnbuckle clang
  prop({ material = 'wood', power = 1, worldPos = null } = {}) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = clamp(power, 0.2, 2.6);
    const spat = this._connectSpat(this._spatializer(worldPos));
    const nodes = [];
    let end = now;

    const tone = (type, hz, t0, peak, decay, toHz = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(hz, t0);
      if (toHz) o.frequency.exponentialRampToValueAtTime(toHz, t0 + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + decay + 0.02);
      autoDisconnect(o, [o, g]);
      nodes.push(o);
      end = Math.max(end, t0 + decay + 0.02);
      return o;
    };
    const noise = (hz, q, t0, peak, decay) => {
      const src = this._noiseSource(decay + 0.02);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      src.connect(bp).connect(g).connect(spat);
      src.start(t0, src._offset); src.stop(t0 + decay + 0.02);
      autoDisconnect(src, [src, bp, g]);
      end = Math.max(end, t0 + decay + 0.02);
    };

    if (material === 'rope') {
      this._pulse(0.2 + p * 0.1);
      const hz = rand(62, 80) + p * 8;
      const o = tone('triangle', hz, now, 0.1 + p * 0.05, 0.55 + p * 0.1, hz * 0.86);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(6, 8);
      const depth = ctx.createGain();
      depth.gain.value = hz * 0.05;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(now); lfo.stop(now + 0.7);
      autoDisconnect(lfo, [lfo, depth]);
      tone('sine', hz * 2.01, now, 0.04, 0.35);
      noise(900, 0.8, now, 0.03 + p * 0.02, 0.12);             // fibre creak
    } else if (material === 'steel') {
      this._pulse(0.5);
      const base = rand(200, 240);
      [1, 2.76, 5.4, 8.93].forEach((m, i) =>
        tone('sine', base * m, now, (0.09 - i * 0.018) * p, 1.1 - i * 0.22));
      noise(4200, 1.2, now, 0.08, 0.04);                        // strike click
    } else {
      this._pulse(0.35 + p * 0.2);
      tone('sine', rand(150, 190), now, 0.26 * Math.min(1.4, p), 0.12, 70);   // knock
      for (const hz of [420, 950, 2100]) noise(hz * rand(0.9, 1.1), 9, now, 0.12 * p, rand(0.08, 0.16));
      // Splinters: clicks thinning out as the pieces settle.
      const n = 4 + Math.round(p * 3);
      for (let i = 0; i < n; i++) {
        const t = now + 0.12 + Math.pow(i / n, 1.4) * 0.6 + rand(0, 0.04);
        noise(rand(1800, 4200), 3, t, 0.05 * (1 - i / n) + 0.01, 0.03);
      }
    }
    // Tear the shared spatializer down once every layer is done.
    const k = ctx.createConstantSource();
    k.start(now); k.stop(end + 0.05);
    autoDisconnect(k, [k, spat, spat.output].filter(Boolean));
  }

  // Press-row shutters: a mechanical click pair (curtain open, curtain close) per camera.
  shutter(count = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const t0 = now + i * rand(0.03, 0.09) + rand(0, 0.02);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pan.pan) pan.pan.value = rand(-0.8, 0.8);
      pan.connect(this.sfxGain);
      for (const [dt, hz] of [[0, rand(3000, 3800)], [rand(0.02, 0.035), rand(2200, 2800)]]) {
        const src = this._noiseSource(0.03);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = hz;
        bp.Q.value = 2.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.linearRampToValueAtTime(0.035, t0 + dt + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + dt + 0.02);
        src.connect(bp).connect(g).connect(pan);
        src.start(t0 + dt, src._offset); src.stop(t0 + dt + 0.03);
        autoDisconnect(src, dt ? [src, bp, g, pan] : [src, bp, g]);
      }
    }
  }

  // Victory pyro: a CO2 jet's hiss sweeping down, over a low whump.
  pyro(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.5);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const src = this._noiseSource(1.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(3200, now);
    bp.frequency.exponentialRampToValueAtTime(700, now + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 1.2);
    src.connect(bp).connect(g).connect(spat);
    src.start(now, src._offset); src.stop(now + 1.25);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, now);
    o.frequency.exponentialRampToValueAtTime(40, now + 0.25);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.22, now + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0008, now + 0.3);
    o.connect(og).connect(spat);
    o.start(now); o.stop(now + 0.32);
    autoDisconnect(o, [o, og]);
    autoDisconnect(src, [src, bp, g, spat, spat.output].filter(Boolean));
  }

  // Tape rewind into the next match: warbling chatter climbing in pitch, then the
  // transport's stop-clunk.
  rewind(dur = 0.75) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this._noiseSource(dur + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(4200, now + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 17;
    const depth = ctx.createGain();
    depth.gain.value = 500;
    lfo.connect(depth).connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.06);
    g.gain.setValueAtTime(0.09, now + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + dur + 0.02);
    lfo.start(now); lfo.stop(now + dur + 0.02);
    autoDisconnect(lfo, [lfo, depth]);
    autoDisconnect(src, [src, bp, g]);
    const clunk = ctx.createOscillator();
    clunk.type = 'triangle';
    clunk.frequency.setValueAtTime(160, now + dur);
    clunk.frequency.exponentialRampToValueAtTime(60, now + dur + 0.08);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now + dur);
    cg.gain.linearRampToValueAtTime(0.16, now + dur + 0.004);
    cg.gain.exponentialRampToValueAtTime(0.0008, now + dur + 0.12);
    clunk.connect(cg).connect(this.sfxGain);
    clunk.start(now + dur); clunk.stop(now + dur + 0.14);
    autoDisconnect(clunk, [clunk, cg]);
  }

  // Glass giving way: a crack, then high inharmonic tinkles scattering as the
  // shards fall (the result-screen shatter).
  shatter() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.6);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const crack = this._noiseSource(0.2);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.22, now + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0008, now + 0.18);
    crack.connect(hp).connect(cg).connect(this.sfxGain);
    crack.start(now, crack._offset); crack.stop(now + 0.2);
    autoDisconnect(crack, [crack, hp, cg]);
    for (let i = 0; i < 14; i++) {
      const t0 = now + 0.05 + Math.pow(Math.random(), 1.6) * 0.9;
      const o = ctx.createOscillator();
      o.frequency.value = rand(2800, 7200);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(rand(0.012, 0.03), t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + rand(0.08, 0.2));
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.22);
      autoDisconnect(o, [o, g]);
    }
  }

  whoosh() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.22);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.25;
    const src = this._noiseSource(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const sweepFrom = rand(650, 950);
    bp.frequency.setValueAtTime(sweepFrom, now);
    bp.frequency.linearRampToValueAtTime(sweepFrom * rand(2.4, 3.0), now + rand(0.14, 0.22));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(rand(0.05, 0.075), now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, bp, g]);
  }

  // ══ Dynamic mix ══════════════════════════════════════════════════════

  /**
   * Ramp an AudioParam down and back to `base`. The setValueAtTime(param.value)
   * after cancelScheduledValues is load-bearing: without it a mid-ramp cancel
   * jumps to the last scheduled value and rapid hits zipper.
   */
  _duckParam(param, base, amount, hold = 0, release = DUCK_RELEASE) {
    const now = this.ctx.currentTime;
    const floor = Math.max(0, base * (1 - clamp(amount, 0, 1)));
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(floor, now + DUCK_ATTACK);
    if (hold > 0) param.setValueAtTime(floor, now + DUCK_ATTACK + hold);
    param.linearRampToValueAtTime(base, now + DUCK_ATTACK + hold + release);
  }

  /**
   * Sidechain the music under a landed hit (power 0..1). Depth 0.18 + 0.42·power:
   * a jab barely moves it, so normal exchanges don't stutter.
   */
  duckMusic(power = 1) {
    if (!this._ensure() || this.muted || !this.musicDuck) return;
    this._duckParam(this.musicDuck.gain, 1.0, 0.18 + 0.42 * clamp(power, 0, 1));
  }

  /**
   * "Ears ringing" after a heavy head hit or KO: muffle the SFX bus, hold, reopen,
   * with a tinnitus sine on top and the music ducked.
   * @param {number} strength 0..1 — how far the corner drops and how long it holds
   */
  concussion(strength = 1) {
    if (!this._ensure() || this.muted || !this.sfxFilter) return;
    const s = clamp(strength, 0, 1);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hold = 0.18 + 0.5 * s;
    const corner = SFX_FILTER_OPEN - (SFX_FILTER_OPEN - SFX_FILTER_MUFFLED) * s;

    const f = this.sfxFilter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    // Exponential: pitch is perceived logarithmically.
    f.exponentialRampToValueAtTime(Math.max(120, corner), now + 0.05);
    f.setValueAtTime(Math.max(120, corner), now + 0.05 + hold);
    f.exponentialRampToValueAtTime(SFX_FILTER_OPEN, now + 0.05 + hold + 0.55 + 0.5 * s);

    if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.7 * s, hold, 0.6);

    // Tinnitus sine, randomized per call.
    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = rand(3100, 4200);
    const tg = ctx.createGain();
    const dur = 0.05 + hold + 0.9;
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.016 * s, now + 0.08);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    // Straight to master, bypassing the muffle it rings over.
    tone.connect(tg).connect(this.master);
    tone.start(now); tone.stop(now + dur + 0.02);
    autoDisconnect(tone, [tone, tg]);
  }

  /**
   * The "vacuum" during hit-pause (true on freeze, false on resume): pulls the
   * reverb so the room vanishes and slams back. Cheaper than M/S narrowing.
   */
  setHitstop(active) {
    if (!this._ensure() || !this.reverbGain) return;
    const want = active ? 1 : 0;
    if (want === this._hitstopDepth) return;
    this._hitstopDepth = want;
    const now = this.ctx.currentTime;
    const rv = this.reverbGain.gain;
    rv.cancelScheduledValues(now);
    rv.setValueAtTime(rv.value, now);
    rv.linearRampToValueAtTime(active ? 0.03 : 0.18, now + (active ? 0.015 : 0.12));
  }

  // ══ Crowd bed ════════════════════════════════════════════════════════
  // Three noise bands whose level and brightness track tension, a chant at high
  // tension, and one-shot reactions.

  startCrowd() {
    if (!this._ensure() || this.muted || this._crowdNodes) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // One looping source per band at its own offset, so the layers stay decorrelated.
    const loopSource = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start(now, Math.random() * Math.max(0.01, this.noiseBuf.duration - 0.05));
      return s;
    };

    // Swell VCA: one-shot reactions ride on top of the intensity level.
    const swell = ctx.createGain();
    swell.gain.value = 1.0;
    swell.connect(this.crowdGain);

    // Layer 1: room rumble, mono.
    const rumbleSrc = loopSource();
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 190;
    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0.9;
    rumbleSrc.connect(rumbleLp).connect(rumbleG).connect(swell);

    // Layer 2: chatter — the band intensity moves (level and centre frequency).
    const chatterSrc = loopSource();
    const chatterBp = ctx.createBiquadFilter();
    chatterBp.type = 'bandpass';
    chatterBp.frequency.value = 540;
    chatterBp.Q.value = 0.7;
    const chatterG = ctx.createGain();
    chatterG.gain.value = 1.0;
    const chatterPan = this._pan(-0.3);
    chatterSrc.connect(chatterBp).connect(chatterG).connect(chatterPan);
    (chatterPan.output || chatterPan).connect(swell);

    // Layer 3: hiss.
    const hissSrc = loopSource();
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 3200;
    const hissG = ctx.createGain();
    hissG.gain.value = 0.22;
    const hissPan = this._pan(0.34);
    hissSrc.connect(hissHp).connect(hissG).connect(hissPan);
    (hissPan.output || hissPan).connect(swell);

    // Chant: slow LFO on the chatter gain; setCrowdIntensity owns its depth.
    const chantLfo = ctx.createOscillator();
    chantLfo.type = 'sine';
    chantLfo.frequency.value = 1.15; // ~69 bpm — a stadium chant, not a tremolo
    const chantDepth = ctx.createGain();
    chantDepth.gain.value = 0;
    chantLfo.connect(chantDepth).connect(chatterG.gain);
    chantLfo.start(now);

    this._crowdNodes = {
      sources: [rumbleSrc, chatterSrc, hissSrc],
      chantLfo, chantDepth, chatterBp, swell,
      all: [rumbleSrc, rumbleLp, rumbleG, chatterSrc, chatterBp, chatterG,
            chatterPan, chatterPan.output, hissSrc, hissHp, hissG, hissPan,
            hissPan.output, chantLfo, chantDepth, swell].filter(Boolean),
    };
    this.setCrowdIntensity(this._crowdIntensity);
  }

  // _spatializer, but taking a pan position directly.
  _pan(x) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(x, -1, 1);
      return p;
    }
    const splitL = ctx.createGain();
    const splitR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const angle = (clamp(x, -1, 1) + 1) * Math.PI / 4;
    splitL.gain.value = Math.cos(angle);
    splitR.gain.value = Math.sin(angle);
    const input = ctx.createGain();
    input.connect(splitL).connect(merger, 0, 0);
    input.connect(splitR).connect(merger, 0, 1);
    input.output = merger;
    return input;
  }

  /**
   * Crowd excitement — the same value that drives arena.js's animated crowd.
   * @param {number} t 0..1
   */
  setCrowdIntensity(t) {
    this._crowdIntensity = clamp(t, 0, 1);
    if (!this._crowdNodes || !this._ensure()) return;
    const now = this.ctx.currentTime;
    const i = this._crowdIntensity;
    this._crowdBase = CROWD_BASE_GAIN + (CROWD_PEAK_GAIN - CROWD_BASE_GAIN) * i;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.muted ? 0 : this._crowdBase, now + 0.6);
    // Brighten as it gets louder: 540 Hz murmur → 1150 Hz roar.
    const bp = this._crowdNodes.chatterBp.frequency;
    bp.cancelScheduledValues(now);
    bp.setValueAtTime(bp.value, now);
    bp.linearRampToValueAtTime(540 + 610 * i, now + 0.6);
    // Chant only emerges in the top half of the range.
    const d = this._crowdNodes.chantDepth.gain;
    d.cancelScheduledValues(now);
    d.setValueAtTime(d.value, now);
    d.linearRampToValueAtTime(0.55 * Math.max(0, i - 0.45) / 0.55, now + 0.8);
  }

  /** Roar on a big landed hit. `power` 0..1. */
  crowdSwell(power = 1) {
    if (!this._crowdNodes || !this._ensure() || this.muted) return;
    const now = this.ctx.currentTime;
    const p = clamp(power, 0, 1);
    const s = this._crowdNodes.swell.gain;
    s.cancelScheduledValues(now);
    s.setValueAtTime(s.value, now);
    // Fast up, slow down.
    s.linearRampToValueAtTime(1 + 2.4 * p, now + 0.11);
    s.linearRampToValueAtTime(1, now + 0.11 + 0.7 + 0.5 * p);
  }

  /** Sharp intake of breath — a near-KO, a sever, a whiffed super. */
  crowdGasp() {
    if (!this._ensure() || this.muted || !this.crowdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.55;
    const src = this._noiseSource(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    // The rise-fall contour is what makes it a gasp.
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.linearRampToValueAtTime(1750, now + 0.16);
    bp.frequency.linearRampToValueAtTime(900, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.5, now + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.crowdGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, bp, g]);
  }

  stopCrowd() {
    if (!this._crowdNodes) return;
    for (const s of this._crowdNodes.sources) { try { s.stop(); } catch { /* */ } }
    try { this._crowdNodes.chantLfo.stop(); } catch { /* */ }
    // Loops never fire onended, so autoDisconnect can't clean this graph.
    for (const n of this._crowdNodes.all) { try { n.disconnect(); } catch { /* */ } }
    this._crowdNodes = null;
  }

  // ══ PA announcer ═════════════════════════════════════════════════════
  // CONSTRAINT: speechSynthesis renders straight to the output device and cannot
  // be routed into an AudioContext, so no bus processing applies. The PA feel comes
  // from voice/pitch/rate, a mic-key click + thump through the bus, and ducking.
  announce(text, { rate = 0.92, pitch = 0.62, volume = 1, duckSec = 1.1 } = {}) {
    if (this.muted || !text) return;
    this._paKey();
    if (this._ensure()) {
      if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.62, duckSec, 0.5);
      if (this.crowdDuck) this._duckParam(this.crowdDuck.gain, 1.0, 0.45, duckSec, 0.5);
    }
    const synth = typeof window !== 'undefined' && window.speechSynthesis;
    if (!synth) return; // no Web Speech — the mic key + duck still land
    try {
      // Drop any backlog: a late "K.O." is worse than none.
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickAnnouncerVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      this._speaking = true;
      u.onend = u.onerror = () => { this._speaking = false; };
      synth.speak(u);
    } catch { this._speaking = false; }
  }

  /** Mic-key click + cabinet thump: the sound of a PA opening up. */
  _paKey() {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const tick = this._noiseSource(0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 2.2;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.09, now + 0.004);
    tg.gain.exponentialRampToValueAtTime(0.0005, now + 0.05);
    tick.connect(bp).connect(tg).connect(this.sfxGain);
    tick.start(now, tick._offset); tick.stop(now + 0.06);
    autoDisconnect(tick, [tick, bp, tg]);
    // Cabinet thump.
    const th = ctx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(120, now);
    th.frequency.exponentialRampToValueAtTime(52, now + 0.14);
    const thg = ctx.createGain();
    thg.gain.setValueAtTime(0.0001, now);
    thg.gain.linearRampToValueAtTime(0.11, now + 0.01);
    thg.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    th.connect(thg).connect(this.sfxGain);
    th.start(now); th.stop(now + 0.22);
    autoDisconnect(th, [th, thg]);
  }

  stopAnnounce() {
    this._speaking = false;
    try { window.speechSynthesis?.cancel(); } catch { /* */ }
  }

  // Super stinger: tape-stop, sub drop under the freeze, then a detuned chord.
  superStinger() {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1. Tape stop: falling bandpassed noise.
    const stopDur = 0.42;
    const tape = this._noiseSource(stopDur);
    const tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass';
    tbp.Q.value = 1.4;
    tbp.frequency.setValueAtTime(4200, now);
    tbp.frequency.exponentialRampToValueAtTime(180, now + stopDur);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.16, now + 0.03);
    tg.gain.exponentialRampToValueAtTime(0.001, now + stopDur);
    tape.connect(tbp).connect(tg).connect(this.sfxGain);
    tape.start(now, tape._offset); tape.stop(now + stopDur);
    autoDisconnect(tape, [tape, tbp, tg]);

    // 2. Sub drop under the hit-pause.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(180, now);
    sub.frequency.exponentialRampToValueAtTime(31, now + 0.7);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, now);
    sg.gain.linearRampToValueAtTime(0.5, now + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    sub.connect(sg).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.05);
    autoDisconnect(sub, [sub, sg]);

    // 3. Chord: minor triad, three detuned saws per note, opening lowpass; 0.18 s in.
    const chordAt = now + 0.18;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, chordAt);
    lp.frequency.exponentialRampToValueAtTime(5200, chordAt + 0.5);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, chordAt);
    cg.gain.linearRampToValueAtTime(0.13, chordAt + 0.08);
    cg.gain.exponentialRampToValueAtTime(0.001, chordAt + 1.5);
    lp.connect(cg).connect(this.sfxGain);
    for (const hz of [110, 130.81, 329.63]) {         // A2, C3, E4
      for (const cents of [-7, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz;
        o.detune.value = cents;
        o.connect(lp);
        o.start(chordAt); o.stop(chordAt + 1.55);
        autoDisconnect(o, [o]);
      }
    }
    // Shared filter/gain torn down off a sentinel that outlives every note.
    const last = ctx.createConstantSource();
    last.start(chordAt); last.stop(chordAt + 1.6);
    autoDisconnect(last, [last, lp, cg]);

    this._pulse(1.0);
    this.crowdSwell(1.0);
  }

  // Music stem: two synthesized loops crossfaded by HP.
  startMusic() {
    if (!this._ensure() || this.musicNodes) return;
    const ctx = this.ctx;
    const tempo = 96; // bpm
    const beat = 60 / tempo;

    // Two gains: bassEnv (per-note, scheduler) and bassLevel (setMusicTension, which
    // cancelScheduledValues and would otherwise wipe queued notes).
    const bassNotes = [55, 55, 73, 65]; // A1, A1, D2, C2 (A minor pentatonic)
    const bassNode = ctx.createOscillator();
    bassNode.type = 'triangle';
    const bassEnv = ctx.createGain();
    bassEnv.gain.value = 0;
    const bassLevel = ctx.createGain();
    bassLevel.gain.value = 0.22;
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = 'lowpass';
    bassLP.frequency.value = 700;
    bassNode.connect(bassLP).connect(bassEnv).connect(bassLevel).connect(this.musicGain);
    bassNode.start();

    // Lookahead scheduler: the timer only decides when to queue; note times come
    // off the audio clock.
    let step = 0;
    let nextNoteTime = ctx.currentTime + 0.05;
    const scheduleNote = (t) => {
      const freq = bassNotes[step % bassNotes.length];
      bassNode.frequency.setValueAtTime(freq, t);
      bassEnv.gain.setValueAtTime(0.0001, t);
      bassEnv.gain.linearRampToValueAtTime(1, t + 0.01);
      bassEnv.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.85);
      step++;
    };
    const scheduler = () => {
      if (this.musicNodes?.stopped) return;
      // After a stall, skip missed beats (staying on the grid) rather than cram
      // them all into one instant.
      if (nextNoteTime < ctx.currentTime) {
        const missed = Math.ceil((ctx.currentTime - nextNoteTime) / beat);
        nextNoteTime += missed * beat;
        step += missed;
      }
      while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        scheduleNote(nextNoteTime);
        nextNoteTime += beat;
      }
    };
    const bassInterval = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler();

    // Pad: filtered noise with a slow LFO on cutoff.
    const pad = ctx.createBufferSource();
    pad.buffer = this.noiseBuf;
    pad.loop = true;
    const padLP = ctx.createBiquadFilter();
    padLP.type = 'lowpass';
    padLP.frequency.value = 600;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.04;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.18;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain).connect(padLP.frequency);
    pad.connect(padLP).connect(padGain).connect(this.musicGain);
    pad.start(); lfo.start();

    this.musicNodes = {
      bassNode, bassEnv, bassLevel, bassInterval, pad, lfo, padGain,
      stopped: false,
    };
  }

  // 0..1 toward the "low-HP" stem: quieter bass, louder pad.
  setMusicTension(t) {
    this.lowMusicCrossfade = clamp(t, 0, 1);
    if (!this.musicNodes || !this._ensure()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Writes bassLevel, not the per-note envelope — see startMusic.
    this.musicNodes.bassLevel.gain.cancelScheduledValues(now);
    this.musicNodes.bassLevel.gain.linearRampToValueAtTime(0.22 - 0.16 * this.lowMusicCrossfade, now + 0.4);
    this.musicNodes.padGain.gain.cancelScheduledValues(now);
    this.musicNodes.padGain.gain.linearRampToValueAtTime(0.04 + 0.06 * this.lowMusicCrossfade, now + 0.4);
  }

  stopMusic() {
    if (!this.musicNodes) return;
    this.musicNodes.stopped = true;
    clearInterval(this.musicNodes.bassInterval);
    try { this.musicNodes.bassNode.stop(); } catch { /* */ }
    try { this.musicNodes.pad.stop(); } catch { /* */ }
    try { this.musicNodes.lfo.stop(); } catch { /* */ }
    this.musicNodes = null;
  }

  // Round-start riff for charId (an INTRO_THEMES key) on introGain, ducking the loop.
  // Restarts any in-flight intro.
  playIntroTheme(charId) {
    if (!this._ensure() || this.muted) return;
    const theme = INTRO_THEMES[charId];
    if (!theme || !this.introGain) return;

    this.stopIntroTheme();

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const beatDur = 60 / theme.bpm;

    let melodyBeats = 0, bassBeats = 0;
    for (const [, d] of theme.melody) melodyBeats += d;
    if (theme.bass) for (const [, d] of theme.bass) bassBeats += d;
    const totalDur = Math.max(melodyBeats, bassBeats) * beatDur;

    // Duck and restore in audio time, so tab throttling can't strand it.
    if (this.musicGain) {
      this._introRestoreVol = this.musicGain.gain.value;
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(0.08, now + 0.08);
      const restoreAt = now + totalDur + 0.15;
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, restoreAt + 0.35);
    }

    const created = [];

    // Lead: two detuned squares.
    let t = 0;
    for (const [note, dur] of theme.melody) {
      const startT = now + t * beatDur;
      const endT = startT + dur * beatDur * 0.92;
      const freq = noteToFreq(note);

      const o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.value = freq;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = freq * 1.006; // 0.6% detune → slight chorus
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startT);
      g.gain.linearRampToValueAtTime(0.14, startT + 0.006);
      g.gain.setValueAtTime(0.14, endT - 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, endT);

      o1.connect(g); o2.connect(g); g.connect(this.introGain);
      o1.start(startT); o2.start(startT);
      o1.stop(endT + 0.02); o2.stop(endT + 0.02);
      created.push(o1, o2, g);
      t += dur;
    }

    if (theme.bass) {
      let bt = 0;
      for (const [note, dur] of theme.bass) {
        const startT = now + bt * beatDur;
        const endT = startT + dur * beatDur * 0.94;
        const freq = noteToFreq(note);

        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, startT);
        g.gain.linearRampToValueAtTime(0.11, startT + 0.008);
        g.gain.setValueAtTime(0.11, endT - 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, endT);

        o.connect(g).connect(this.introGain);
        o.start(startT); o.stop(endT + 0.02);
        created.push(o, g);
        bt += dur;
      }
    }

    this.introNodes = created;
  }

  // Idempotent.
  stopIntroTheme() {
    if (!this.introNodes) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    if (this.musicGain && ctx) {
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, now + 0.08);
    }
    for (const n of this.introNodes) {
      try { if (n.stop) n.stop(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
    this.introNodes = null;
  }

  // Combo melody: each hit in a run rings one step up A minor pentatonic (the
  // music loop's key), a mallet voice layered on the impact. Deliberately not
  // quantised to the beat — hit audio must land on the frame of contact.
  comboNote(n, worldPos = null) {
    if (n < 2 || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const PENTA = [0, 3, 5, 7, 10];               // A C D E G
    const deg = Math.min(n - 2, 11);              // tops out two octaves up
    const semis = PENTA[deg % 5] + 12 * Math.floor(deg / 5);
    const f0 = 440 * Math.pow(2, semis / 12);
    const spat = this._connectSpat(this._spatializer(worldPos));
    const voice = (hz, peak, decay) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
      o.connect(g).connect(spat);
      o.start(now); o.stop(now + decay + 0.03);
      return [o, g];
    };
    const lift = Math.min(1, 0.55 + deg * 0.06);
    const [o1, g1] = voice(f0, 0.07 * lift, 0.42);
    const [o2, g2] = voice(f0 * 2.76, 0.022 * lift, 0.16);
    autoDisconnect(o2, [o2, g2]);
    // The longer fundamental owns tearing down the shared spatializer.
    autoDisconnect(o1, [o1, g1, spat, spat.output].filter(Boolean));
  }

  // Run of 4+ expiring: a rising Am(add9) arpeggio resolving the combo phrase.
  comboFinisher(n) {
    if (n < 4 || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = [220, 261.63, 329.63, 493.88, 440];  // A3 C4 E4 B4 A4
    const peak = Math.min(0.075, 0.04 + n * 0.004);
    notes.forEach((hz, i) => {
      const t0 = now + i * 0.055;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.7);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.75);
      autoDisconnect(o, [o, g]);
    });
    this.crowdSwell(0.5);
  }

  // One lub-dub; game.js owns the tempo (shared with the screen-edge pulse).
  heartbeat(strength = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp(strength, 0, 1);
    const thump = (t0, peak) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.2);
      // Straight to master so it survives the concussion lowpass.
      o.connect(g).connect(this.master);
      o.start(t0); o.stop(t0 + 0.22);
      autoDisconnect(o, [o, g]);
    };
    thump(now, 0.3 * s);
    thump(now + 0.17, 0.2 * s);
  }

  /** 0..1 — how close the nearer fighter is to a KO. Sinks the music under a lowpass. */
  setDanger(level) {
    if (!this.musicLP || !this.ctx) return;
    const d = clamp(level, 0, 1);
    // Exponential sweep, 20 kHz → ~700 Hz.
    const hz = d < 0.01 ? SFX_FILTER_OPEN : 700 * Math.pow(SFX_FILTER_OPEN / 700, 1 - d);
    this.musicLP.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.25);
  }

  // VS splash: riser into a sub boom + clang at 0.45 s, when the splash CSS slams
  // the name cards together.
  vsSting() {
    // Running-only: nodes queued on a suspended context would fire mid-fight on resume.
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hitAt = now + 0.45;

    const riseDur = 0.45;
    const rise = this._noiseSource(riseDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(900, now);
    hp.frequency.exponentialRampToValueAtTime(5200, hitAt);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.exponentialRampToValueAtTime(0.14, hitAt - 0.01);
    rg.gain.linearRampToValueAtTime(0.0001, hitAt + 0.02);
    rise.connect(hp).connect(rg).connect(this.sfxGain);
    rise.start(now, rise._offset); rise.stop(hitAt + 0.03);
    autoDisconnect(rise, [rise, hp, rg]);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, hitAt);
    sub.frequency.exponentialRampToValueAtTime(34, hitAt + 0.5);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, hitAt);
    sg.gain.linearRampToValueAtTime(0.5, hitAt + 0.015);
    sg.gain.exponentialRampToValueAtTime(0.0008, hitAt + 0.8);
    sub.connect(sg).connect(this.sfxGain);
    sub.start(hitAt); sub.stop(hitAt + 0.85);
    autoDisconnect(sub, [sub, sg]);

    // Clang: three inharmonic square partials through a bandpass.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 2.2;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, hitAt);
    cg.gain.linearRampToValueAtTime(0.06, hitAt + 0.005);
    cg.gain.exponentialRampToValueAtTime(0.0008, hitAt + 0.9);
    bp.connect(cg).connect(this.sfxGain);
    for (const hz of [311, 523, 887]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz;
      o.connect(bp);
      o.start(hitAt); o.stop(hitAt + 0.95);
      autoDisconnect(o, [o]);
    }
    const last = ctx.createConstantSource();
    last.start(hitAt); last.stop(hitAt + 1.0);
    autoDisconnect(last, [last, bp, cg]);
    this._pulse(0.6);
  }

  // Breaking-news "da-da-da-DAAA": brass stabs to a held fifth over a timpani roll.
  newsSting() {
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.02;
    const stab = (t0, freqs, dur, peak) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t0);
      lp.frequency.exponentialRampToValueAtTime(4200, t0 + 0.05);
      lp.frequency.exponentialRampToValueAtTime(1600, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.setValueAtTime(peak, t0 + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      lp.connect(g).connect(this.sfxGain);
      for (const hz of freqs) {
        for (const cents of [-6, 6]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = hz;
          o.detune.value = cents;
          o.connect(lp);
          o.start(t0); o.stop(t0 + dur + 0.02);
          autoDisconnect(o, [o]);
        }
      }
      const end = ctx.createConstantSource();
      end.start(t0); end.stop(t0 + dur + 0.05);
      autoDisconnect(end, [end, lp, g]);
    };
    const e = 0.16;
    stab(now, [440, 659.25], 0.12, 0.05);              // A4 + E5
    stab(now + e, [440, 659.25], 0.12, 0.05);
    stab(now + e * 2, [493.88, 739.99], 0.12, 0.055);  // B4 + F#5
    stab(now + e * 3, [587.33, 880], 1.1, 0.065);      // D5 + A5, held

    for (let i = 0; i < 8; i++) {
      const t0 = now + i * (e * 3 / 8);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(98, t0);
      o.frequency.exponentialRampToValueAtTime(72, t0 + 0.08);
      const g = ctx.createGain();
      const pk = 0.05 + i * 0.025;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + (i === 7 ? 0.9 : 0.12));
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + (i === 7 ? 0.95 : 0.14));
      autoDisconnect(o, [o, g]);
    }
  }

  /**
   * The finished mix as a MediaStream, for the KO clip recorder. Null until the
   * context exists (no gesture yet) — clip.js asks again on each recorder restart.
   */
  tapStream() {
    if (!this.ctx || !this.out || this._ensureFailed) return null;
    if (!this._tap) {
      try {
        this._tap = this.ctx.createMediaStreamDestination();
        this.out.connect(this._tap);
      } catch { this._tap = null; return null; }
    }
    return this._tap.stream;
  }

  close() {
    this.stopMusic();
    this.stopIntroTheme();
    this.stopCrowd();
    this.stopAnnounce();
    if (this.ctx) {
      // Never close the shared app context (js/audioBus.js); only a private fallback.
      if (this._ownsCtx && this.ctx.state !== 'closed') {
        this.ctx.close().catch(() => { /* already closing */ });
      } else {
        // Detach our chain from the shared bus.
        try { this.master?.disconnect(); } catch { /* already disconnected */ }
      }
      this.ctx = null;
    }
    if (this._tap) { try { this.out?.disconnect(this._tap); } catch { /* */ } this._tap = null; }
    this.master = this.sfxGain = this.musicGain = this.reverbGain = this.introGain = null;
    this.sfxFilter = this.musicDuck = this.musicLP = this.crowdGain = this.crowdDuck = null;
    this.out = null;
    this.noiseBuf = null;
  }
}

export { AudioBus };