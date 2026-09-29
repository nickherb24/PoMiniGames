// audio.js — synthesized audio bus for PoBrawl.
// No audio files; everything is generated from OscillatorNode + filtered noise.
// Architecture:
//   master gain -> glue compressor -> limiter -> destination
//     ├── sfxGain       (impacts, blocks, KO, voice grunts, footsteps)
//     │     ├── panner (per source; StereoPanner keyed off world-x)
//     │     └── reverbSend -> convolver -> reverbGain -> master
//     ├── musicGain     (round-start loop stem + low-HP tension)
//     └── introGain     (round-start chiptune riff)
//
// Every public method is a no-op while muted so the game can call them freely.

// 2 seconds of noise. Longer than any single sound that reads from it, so
// every playback can start at a random offset (see `_noiseSource`) and no two
// cracks are the same waveform.
const NOISE_SECONDS = 2;

// Half-width of the arena in world units, for mapping world-x -> stereo pan.
const ARENA_HALF_WIDTH = 6;

// Music scheduler: wake every LOOKAHEAD_MS and schedule every note that falls
// due within SCHEDULE_AHEAD seconds. Timer jitter no longer reaches the audio
// clock — the timer only decides *when we schedule*, never *when a note plays*.
const LOOKAHEAD_MS = 25;
// How far ahead of the audio clock notes are queued. This is the budget for
// main-thread stalls: the timer can't fire while the thread is blocked, so any
// block longer than this drains the queue and the bass line audibly hiccups.
// A round opening (fresh rigs, first-frame shader compiles) can block for a
// couple hundred milliseconds, so keep the queue deep enough to ride that out
// — 0.1 s was not, which is why the music stuttered as a match started.
const SCHEDULE_AHEAD = 0.45;

// ── Dynamic mix constants (GFX/SOUND #5) ─────────────────────────────────
// The SFX bus runs through a lowpass that normally sits above the audible
// band (so it is a straight wire) and is swept down for the "concussion"
// after a heavy head hit or a KO. 20 kHz rather than `Infinity` because a
// BiquadFilter still has a phase response at its corner — parking it past
// Nyquist keeps the open state genuinely transparent.
const SFX_FILTER_OPEN = 20000;
// Corner the concussion sweeps down to at full strength. 420 Hz kills the
// crack/hiss layers of every impact and leaves the body thuds, which is what
// "ears ringing" actually sounds like.
const SFX_FILTER_MUFFLED = 420;
// Sidechain: how far the music bus is pulled down by a full-power impact, and
// how fast it recovers. Attack is near-instant (the duck has to be under the
// transient, not after it); release is slow enough to read as breathing.
const DUCK_ATTACK = 0.012;
const DUCK_RELEASE = 0.32;

// ── Crowd bed constants (GFX/SOUND #6) ───────────────────────────────────
// The crowd is three layers of filtered noise, not a sample: a low "room"
// rumble, a mid chatter band, and a high hiss. Intensity moves the mid band's
// centre frequency and the overall level, which is what a real crowd does as
// it gets louder — it does not just get bigger, it gets brighter.
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

// Synthesized impulse response: exponentially-decaying stereo noise. Gives the
// arena a sense of enclosure — dry hits read as happening in a vacuum.
// Decorrelated channels so the tail widens rather than sitting centre.
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

// Release every node in `nodes` once `source` finishes. Without this each
// impact leaves its panner wired to sfxGain forever, and a long flurry piles
// up hundreds of live nodes on the audio thread.
function autoDisconnect(source, nodes) {
  source.onended = () => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
  };
}

// ── Announcer voice pick (GFX/SOUND #7) ──────────────────────────────────
// Cached because getVoices() walks the platform voice list on every call, and
// the announcer fires at round start / KO — moments already busy with rig
// rebuilds and shader compiles.
//
// Deliberately NOT shared with pojoker-speech-interop.js, which wants a British
// storyteller. A boxing PA wants the opposite: an American, deep, and above all
// LOCAL voice. Remote/network voices ("Natural", "Online") are filtered out —
// they sound better but arrive hundreds of milliseconds late, and an announcer
// calling "K.O." after the replay has started is worse than a robotic one.
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

// ── Presidential voices (2026-09-29) ──────────────────────────────────────
// grunt() used to be one voice for all fifteen fighters. Each now has a pitch
// (f0), two vowel formants (f1/f2 — what makes a voice sound like a particular
// throat rather than a synth) and a rasp amount (breath noise through the upper
// formant). Nixon and LBJ sit low and gravelly, Truman and Bush Sr. reedy,
// Clinton and Biden breathy. Unknown ids fall back to the middle of the table.
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

// Note name → MIDI semitone offset (C4 = 60 → freq 261.63 Hz).
// Supports sharps (#) and flats (b); octave is parsed from the digits.
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

// Round-start chiptune intros. Each entry is a ≤5-second two-voice riff
// inspired by a popular tune from the president's era:
//   melody  — the lead line (square wave, lightly detuned pair)
//   bass    — the root/fifth foundation (triangle wave)
// The key MUST match the charId in fighters.js — used as INTRO_THEMES[id].
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

// Lazy AudioContext + master bus; we never start audio without a user gesture,
// but the bus itself can be created on first call.
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
    // Audio-reactive envelope. Each SFX call nudges this up; the render loop
    // calls tick(dt) once a frame to decay it. The BrawlGame reads
    // getEnvelope() to pulse the UnrealBloomPass on every impact.
    // Both start at 0: a non-zero _envPeak is a ceiling `tick` would chase with
    // no sound playing, which pins the bloom on permanently.
    this._env = 0;
    this._envPeak = 0; // ceiling for the latest hit; decays in tick()
    // ── Dynamic mix (#5) ──────────────────────────────────────────────
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

      // Glue compressor, then a brickwall limiter. The compressor alone lets
      // simultaneous impacts punch through into clipping; the limiter is the
      // thing that actually guarantees we stay under 0 dBFS.
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
      // The finished mix, post-limiter — what tapStream() hands the KO clip
      // recorder (clip.js) so a saved clip sounds like the fight did.
      this.out = limiter;

      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = 1.0;

      // Concussion filter (#5). Every SFX — dry AND wet — passes through it, so
      // a heavy head hit muffles the room reflection as well as the crack. A
      // sweep that left the reverb bright would read as a broken mix rather
      // than as a stunned fighter.
      this.sfxFilter = ctx.createBiquadFilter();
      this.sfxFilter.type = 'lowpass';
      this.sfxFilter.frequency.value = SFX_FILTER_OPEN;
      // Q at the Butterworth-ish default. A resonant corner would whistle as it
      // swept, which is a synth effect, not a concussion.
      this.sfxFilter.Q.value = 0.0001;
      this.sfxGain.connect(this.sfxFilter);
      this.sfxFilter.connect(this.master);

      // Reverb send: sfx go out dry via the filter->master path and wet via this
      // parallel convolver path, so the wet level is tunable on its own.
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.18;
      this.sfxFilter.connect(convolver).connect(this.reverbGain).connect(this.master);

      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.35;
      // Sidechain VCA (#5). Deliberately a SECOND gain rather than automating
      // musicGain itself: setMusicTension and playIntroTheme both write
      // musicGain (and cancelScheduledValues on it), so a duck scheduled there
      // would be wiped by the next tension change — or worse, would wipe one.
      // Two stages, two owners, no interference.
      this.musicDuck = ctx.createGain();
      this.musicDuck.gain.value = 1.0;
      // Danger lowpass (GFX/SOUND #4). A third stage with a third owner:
      // setDanger() closes it as a fighter nears a KO, so the music sinks under
      // the heartbeat. Wide open (and so inaudible) the rest of the time.
      this.musicLP = ctx.createBiquadFilter();
      this.musicLP.type = 'lowpass';
      this.musicLP.frequency.value = SFX_FILTER_OPEN;
      this.musicLP.Q.value = 0.0001;
      this.musicGain.connect(this.musicLP).connect(this.musicDuck).connect(this.master);

      // Crowd bed bus (#6). Sits outside sfxGain so impacts can duck/swell it
      // independently, and outside musicGain so the music tension curve does
      // not drag the hall's ambience around with it.
      // Same two-stage split as the music: crowdGain is the *intensity* level
      // (owned by setCrowdIntensity) and crowdDuck is the *duck* VCA (owned by
      // the announcer). One node for both would mean every announcement fought
      // the next tension update for the same automation timeline.
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      this.crowdDuck = ctx.createGain();
      this.crowdDuck.gain.value = 1.0;
      this.crowdGain.connect(this.crowdDuck).connect(this.master);

      // Round-start chiptune bus — independent of sfxGain (impacts) and
      // musicGain (looped stem) so ducking only affects the loop while the
      // intro plays over the top.
      this.introGain = ctx.createGain();
      this.introGain.gain.value = 0.15;
      this.introGain.connect(this.master);

      this.noiseBuf = makeNoiseBuffer(ctx);
      return true;
    } catch (e) {
      // Latch the failure. Previously this swallowed the error and returned
      // false while leaving this.ctx assigned, so the *next* call short-circuited
      // on `if (this.ctx) return true` and reported success with a half-built
      // graph — a one-character typo silently killed every noise layer and the
      // intro themes for good. Fail closed and say so.
      this._ensureFailed = true;
      try { console.error('[pobrawl/audio] AudioContext setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  // One-shot noise source, started at a random offset so repeated sounds never
  // replay the identical slice of the shared buffer.
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
    // The crowd bed is a set of LOOPING sources — unlike every one-shot here,
    // muting the master is not enough to make it stop costing anything, and an
    // unmuted context would bring it straight back at full level. Tear it down
    // on mute and rebuild on unmute.
    if (this.muted) this.stopCrowd();
    else if (this.ctx) this.startCrowd();
    // Speech does not go through master.gain at all (see the announce() note),
    // so muting has to reach it separately or the announcer keeps talking over
    // a silent game.
    if (this.muted) this.stopAnnounce();
  }

  // Audio-reactive envelope: every SFX method calls _pulse(power) right when
  // the sound fires, so the bloom pass in game.js can read getEnvelope() the
  // same frame. Big hits land at ~1.0, whooshes at ~0.2, blocks at ~0.4.
  _pulse(power) {
    this._envPeak = Math.max(this._envPeak, Math.min(1, power));
  }

  // Per-frame envelope decay. Halflife ≈ 90 ms so a flurry of hits keeps
  // the bloom glowing; silence brings it back to zero in ~0.5 s.
  tick(dt) {
    // The ceiling has to decay too. _pulse only ever raises _envPeak (Math.max),
    // so a static ceiling is one _env chases upward and never leaves — the bloom
    // sat pinned at 1.0 through total silence.
    this._envPeak *= Math.exp(-dt * 4.0);
    const decay = Math.exp(-dt * 7.5);
    this._env = this._envPeak * (1 - decay) + this._env * decay;
    // After enough decay, both targets converge; collapse them so a new pulse
    // doesn't get averaged into the tail of a previous one.
    if (this._env < 0.005 && this._envPeak < 0.005) { this._env = 0; this._envPeak = 0; }
  }

  getEnvelope() { return this._env; }

  // Resume the context after a user gesture — Blazor can't always start audio
  // because the .razor lifecycle may not be triggered by a button click.
  async resume() {
    if (this._ensure() && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
  }

  // One-shot spatializer: StereoPanner keyed off world-x.
  //
  // This used to build an HRTF PannerNode. HRTF runs a convolution per node and
  // positions sound relative to ctx.listener — which nothing in the game ever
  // moves, so every hit was panned against a default listener at the origin
  // regardless of the camera. For a 2.5D fighter on a fixed side-on camera,
  // world-x -> pan is both what we actually want and far cheaper.
  _spatializer(worldPos) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      // 0.8 rather than a hard 1.0: fully-panned mono sounds collapse into one
      // ear on headphones and read as broken rather than positional.
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

  // Connect a spatializer's audible output to the sfx bus. The fallback path
  // pans through a merger, so its output node is not the node callers feed.
  _connectSpat(spat) {
    (spat.output || spat).connect(this.sfxGain);
    return spat;
  }

  // Layered impact: low thud (sine + sub noise) + mid crack (filtered noise) + hiss.
  //
  // `kind` ('punch' | 'kick') sets the weight: a kick lands lower, decays longer
  // and carries more low-mid body. Every layer is randomized per call — identical
  // repeats are the single biggest tell that a hit is synthesized.
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
    // _ensure/mute check first: this used to pulse the bloom envelope even when
    // audio was muted or unavailable, flashing the screen for a sound nobody heard.
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
    // Wider per-call spread than a fixed pitch: a grunt repeats far more often
    // than an impact, so it goes "robotic" fastest without variation.
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

  // ══ Prop materials (2026-09-29) ═══════════════════════════════════════
  // Crates, ropes and turnbuckles all used to play impact() — a body blow.
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

  // Cheap footstep tick — call on every other walk-cycle hit.
  footstep(volume = 0.05, worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.08);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = rand(80, 100);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(volume * rand(0.85, 1.15), now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    o.connect(g).connect(spat);
    o.start(now); o.stop(now + 0.09);
    autoDisconnect(o, [o, g, spat, spat.output].filter(Boolean));
  }

  // ══ Dynamic mix (GFX/SOUND #5) ═══════════════════════════════════════
  // Three effects, one idea: the mix should react to what just happened on
  // screen. Before this the bus was static — a KO and a jab reached the
  // speakers through exactly the same signal path, so the only thing that
  // distinguished them was how loud they were.

  /**
   * Ramp an AudioParam down and back to `base`. Shared by the impact sidechain
   * and the announcer duck, which want the same shape at different depths.
   *
   * cancelScheduledValues + an explicit setValueAtTime(param.value) is the
   * load-bearing pair: without the second call, cancelling mid-ramp leaves the
   * param at its *last scheduled* value rather than where it audibly is, and
   * rapid hits produce a stepped zipper instead of a smooth pump.
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
   * Sidechain the music under an impact. Called from the engine on every landed
   * hit, with the same 0..1 power the impact sound used.
   *
   * The depth is deliberately sub-linear (0.18 + 0.42·power, so a jab barely
   * moves it and a full-charge kick pulls the stem down by ~60%): a duck deep
   * enough to notice on every jab turns a normal exchange into a stuttering
   * mess, which is the same failure mode that killed the old bloom pulse.
   */
  duckMusic(power = 1) {
    if (!this._ensure() || this.muted || !this.musicDuck) return;
    this._duckParam(this.musicDuck.gain, 1.0, 0.18 + 0.42 * clamp(power, 0, 1));
  }

  /**
   * "Ears ringing" after a heavy head hit or a KO: sweep the whole SFX bus down
   * to a muffled corner, hold, then open back up, with a faint tinnitus sine
   * over the top and the music pulled well down underneath.
   *
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
    // Exponential, not linear: frequency is perceived logarithmically, so a
    // linear ramp from 20 kHz spends most of its time in the top octave where
    // nothing is audible and then falls off a cliff at the end.
    f.exponentialRampToValueAtTime(Math.max(120, corner), now + 0.05);
    f.setValueAtTime(Math.max(120, corner), now + 0.05 + hold);
    f.exponentialRampToValueAtTime(SFX_FILTER_OPEN, now + 0.05 + hold + 0.55 + 0.5 * s);

    // Music drops out from under it for the length of the ring.
    if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.7 * s, hold, 0.6);

    // Tinnitus: a quiet high sine that fades in behind the muffle and out with
    // it. Detuned slightly per call so repeated KOs don't ring on one pitch.
    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = rand(3100, 4200);
    const tg = ctx.createGain();
    const dur = 0.05 + hold + 0.9;
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.016 * s, now + 0.08);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    // Straight to master: routing the ringing through sfxFilter would muffle
    // the very thing that is supposed to be cutting through the muffle.
    tone.connect(tg).connect(this.master);
    tone.start(now); tone.stop(now + dur + 0.02);
    autoDisconnect(tone, [tone, tg]);
  }

  /**
   * The "vacuum" during hit-pause. Called with true when the engine freezes the
   * frame on impact and false when it resumes.
   *
   * True stereo width narrowing would need a mid/side matrix over the whole
   * bus, and every source here is already panned individually — decoding and
   * re-encoding M/S for a 50 ms effect is not worth the node count. Pulling the
   * reverb tail and a little master level instead produces the same read: the
   * room disappears for the length of the freeze and slams back when it ends.
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

  // ══ Crowd bed (GFX/SOUND #6) ═════════════════════════════════════════
  // arena.js has had an animated crowd since the beginning; audio.js had one
  // filtered-noise pad described as "feels like a crowd murmur" buried inside
  // the music loop. This is the crowd as its own instrument: three noise bands
  // whose level AND brightness track match tension, a chant that emerges only
  // when the tension is high, and one-shot reactions the engine can fire.

  startCrowd() {
    if (!this._ensure() || this.muted || this._crowdNodes) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // One looping source per band, each started at its own random offset into
    // the shared 2 s buffer so the three layers are decorrelated. A single
    // source split three ways would phase-lock them into one filtered tone.
    const loopSource = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start(now, Math.random() * Math.max(0.01, this.noiseBuf.duration - 0.05));
      return s;
    };

    // Swell VCA — sits between the mix and the intensity level so a one-shot
    // reaction rides on top of whatever the tension level currently is.
    const swell = ctx.createGain();
    swell.gain.value = 1.0;
    swell.connect(this.crowdGain);

    // Layer 1: room rumble. Mono, centred — a hall's low end has no direction.
    const rumbleSrc = loopSource();
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 190;
    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0.9;
    rumbleSrc.connect(rumbleLp).connect(rumbleG).connect(swell);

    // Layer 2: chatter. This is the band intensity moves — both its level and
    // its centre frequency, so an excited crowd gets brighter, not just louder.
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

    // Layer 3: hiss. Barely audible on its own; it is what stops the bed
    // sounding like a lowpassed rumble and starts it sounding like people.
    const hissSrc = loopSource();
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 3200;
    const hissG = ctx.createGain();
    hissG.gain.value = 0.22;
    const hissPan = this._pan(0.34);
    hissSrc.connect(hissHp).connect(hissG).connect(hissPan);
    (hissPan.output || hissPan).connect(swell);

    // Chant: a slow LFO added onto the chatter gain. Its DEPTH is what
    // setCrowdIntensity raises, so at low tension the bed is flat and as the
    // fight gets desperate a rhythmic surge emerges out of it on its own.
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

  // StereoPanner with the same merger fallback _spatializer uses, but taking a
  // pan position directly rather than a world point.
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
   * Where the crowd sits between "waiting for the bell" and "on its feet".
   * The engine feeds this the same excitement value that drives the animated
   * crowd in arena.js, so what you see and what you hear are one signal.
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
    // Fast up, slow down — a crowd reacts in a tenth of a second and takes a
    // second to settle. The reverse reads as a fade-in, which is uncanny.
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
    // Rising then falling: the pitch contour is the whole reason this reads as
    // a gasp rather than a noise burst.
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

  /** Low disapproving swell — a whiffed heavy, a ring-out stall. */
  crowdBoo() {
    if (!this._ensure() || this.muted || !this.crowdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.95;
    const src = this._noiseSource(dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.42, now + 0.18);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(lp).connect(g).connect(this.crowdGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, lp, g]);
    // A touch of sung vowel under the noise so it reads as voices, not wind.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(96, now);
    o.frequency.linearRampToValueAtTime(84, now + dur);
    const ob = ctx.createBiquadFilter();
    ob.type = 'lowpass';
    ob.frequency.value = 500;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.05, now + 0.2);
    og.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(ob).connect(og).connect(this.crowdGain);
    o.start(now); o.stop(now + dur + 0.02);
    autoDisconnect(o, [o, ob, og]);
  }

  stopCrowd() {
    if (!this._crowdNodes) return;
    for (const s of this._crowdNodes.sources) { try { s.stop(); } catch { /* */ } }
    try { this._crowdNodes.chantLfo.stop(); } catch { /* */ }
    // Looping sources never fire `onended` on their own, so autoDisconnect
    // would never run for this graph — tear it down by hand.
    for (const n of this._crowdNodes.all) { try { n.disconnect(); } catch { /* */ } }
    this._crowdNodes = null;
  }

  // ══ PA announcer (GFX/SOUND #7) ══════════════════════════════════════
  //
  // IMPORTANT CONSTRAINT, so nobody tries to "fix" this later: a
  // SpeechSynthesisUtterance is rendered by the platform straight to the output
  // device. There is no MediaStream, no AudioNode, and no way to route it into
  // an AudioContext, so it CANNOT be pushed through this bus's waveshaper,
  // bandpass or convolver. The tannoy character therefore comes from three
  // things that can be controlled: the voice/pitch/rate on the utterance
  // itself, a synthesized mic-key click and cabinet thump fired through the bus
  // underneath it, and ducking the music and crowd out of its way. Getting a
  // genuinely processed announcer would mean shipping rendered audio assets,
  // which this game deliberately does not do.
  announce(text, { rate = 0.92, pitch = 0.62, volume = 1, duckSec = 1.1 } = {}) {
    if (this.muted || !text) return;
    this._paKey();
    // Duck music and crowd so the line sits on top of the mix.
    if (this._ensure()) {
      if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.62, duckSec, 0.5);
      if (this.crowdDuck) this._duckParam(this.crowdDuck.gain, 1.0, 0.45, duckSec, 0.5);
    }
    const synth = typeof window !== 'undefined' && window.speechSynthesis;
    if (!synth) return; // no Web Speech — the mic key + duck still land
    try {
      // A queued backlog is worse than a dropped line here: announcements are
      // tied to moments ("K.O.", "ROUND TWO"), and one arriving four seconds
      // late is actively confusing.
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
    // Click: a very short bandpassed noise tick, hard and dry.
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
    // Thump: the speaker cabinet moving. Sells "big room PA" more than the click.
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

  // ══ Super stinger (GFX/SOUND #2) ═════════════════════════════════════
  // The signature super used to borrow the generic whoosh() — the same sound a
  // missed jab makes. This is its own cue: a tape-stop on the way in, a sub
  // drop under the freeze, and a wide detuned chord that blooms out of it.
  superStinger() {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1. Tape stop: a noise sweep whose bandpass falls off a cliff, plus a
    //    detuned pitch-down. Reads as the world grinding to a halt.
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

    // 3. Chord: a minor triad with the fifth voiced an octave up, three
    //    detuned saws per note, opening through a lowpass. It lands 0.18 s in,
    //    on the far side of the tape stop, so the two read as cause and effect.
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
    // The chord and its filter outlive every oscillator's onended, so they are
    // torn down off the last note rather than by autoDisconnect on each.
    const last = ctx.createConstantSource();
    last.start(chordAt); last.stop(chordAt + 1.6);
    autoDisconnect(last, [last, lp, cg]);

    this._pulse(1.0);
    this.crowdSwell(1.0);
  }

  // Continuous music stem: two layered loops we crossfade between based on HP.
  // No samples, so we synthesize a simple 4-step bass + filtered noise pad.
  startMusic() {
    if (!this._ensure() || this.musicNodes) return;
    const ctx = this.ctx;
    const tempo = 96; // bpm
    const beat = 60 / tempo;

    // Bass voice. Signal path is deliberately two gains deep:
    //   bassEnv   — the per-note envelope, written by the scheduler ahead of time
    //   bassLevel — the tension mix, written by setMusicTension
    // One shared gain can't do both: tension has to cancelScheduledValues, which
    // would wipe the notes the scheduler has already queued up.
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

    // Lookahead scheduler. The old version fired setInterval every beat and
    // scheduled at `ctx.currentTime` — so every note landed wherever timer jitter
    // happened to put it, and a backgrounded tab (throttled to ~1s timers) stalled
    // the sequence outright. Now the timer only decides when to *queue*; note times
    // come off the audio clock and stay exact regardless of jitter.
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
      // Catch-up guard. If the main thread was blocked past the lookahead
      // window (or the tab was throttled), nextNoteTime is now in the past.
      // Scheduling those notes anyway makes the AudioParam ramps fire
      // immediately, cramming a whole run of beats into one instant — the
      // stutter is the catch-up, not the gap. Skip the missed beats and
      // resume on the next one still in the future, staying on the grid.
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

    // Pad: filtered noise with a slow LFO on cutoff — feels like a crowd murmur.
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

  // 0..1 — how much to crossfade the music toward the "low-HP" stem.
  // We simulate the low-HP stem by attenuating the bass + brightening the pad.
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

  // Round-start chiptune intro. Plays a short (~4–5s) period-appropriate riff
  // for the given character on introGain while ducking the musicGain loop.
  // Safe to call repeatedly — any in-flight intro is stopped first.
  //   charId — must match a key in INTRO_THEMES (i.e. a fighters.js charId).
  playIntroTheme(charId) {
    if (!this._ensure() || this.muted) return;
    const theme = INTRO_THEMES[charId];
    if (!theme || !this.introGain) return;

    // Cancel anything still ringing from a previous intro.
    this.stopIntroTheme();

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const beatDur = 60 / theme.bpm;

    // Total length is the longer of melody / bass in beats.
    let melodyBeats = 0, bassBeats = 0;
    for (const [, d] of theme.melody) melodyBeats += d;
    if (theme.bass) for (const [, d] of theme.bass) bassBeats += d;
    const totalDur = Math.max(melodyBeats, bassBeats) * beatDur;

    // Duck musicGain down so the intro sits clearly on top, then restore it.
    // Scheduled in audio-time so it survives tab-throttling.
    if (this.musicGain) {
      this._introRestoreVol = this.musicGain.gain.value;
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(0.08, now + 0.08);
      const restoreAt = now + totalDur + 0.15;
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, restoreAt + 0.35);
    }

    const created = [];

    // Lead voice — pair of slightly-detuned square oscillators for that
    // NES-style chiptune heft. Hard 5ms attack, exponential release tail.
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

    // Bass voice — single triangle oscillator, slight attack/release.
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

  // Stop any in-flight intro theme. Idempotent.
  stopIntroTheme() {
    if (!this.introNodes) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    // Snap musicGain back to its pre-duck volume in case we cut mid-intro.
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

  // ══ Combo melody (GFX/SOUND #3, 2026-09-23) ══════════════════════════
  // Each landed hit in a run rings one step further up A minor pentatonic —
  // the scale the music loop's bass line walks (startMusic: A1 A1 D2 C2) — so a
  // combo plays a rising phrase in the song's own key instead of the same crack
  // eight times. A mallet voice (fundamental + an inharmonic 2.76× partial) sits
  // ON the impact, never replacing it: the hit still sounds like a hit.
  //
  // Not quantised to the beat grid on purpose. A cue that waits up to half a
  // beat for the downbeat would lag the fist it belongs to, and the whole point
  // of hit audio is that it lands on the frame of contact.
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
    // Later steps ring a touch louder — the phrase should build, not plateau.
    const lift = Math.min(1, 0.55 + deg * 0.06);
    const [o1, g1] = voice(f0, 0.07 * lift, 0.42);
    const [o2, g2] = voice(f0 * 2.76, 0.022 * lift, 0.16);
    autoDisconnect(o2, [o2, g2]);
    // The longer fundamental owns tearing down the shared spatializer.
    autoDisconnect(o1, [o1, g1, spat, spat.output].filter(Boolean));
  }

  // A cashed-in run of 4+: a quick rising Am(add9) arpeggio that resolves the
  // phrase the combo notes started. Fires when the run expires, not on the last
  // hit, so it reads as the crowd's "ooh" rather than as another impact.
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

  // ══ Danger state (GFX/SOUND #4, 2026-09-23) ══════════════════════════
  // One lub-dub. game.js owns the tempo (it also drives the screen-edge pulse
  // off the same beat), so this only has to make the sound.
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
      // Straight to master, NOT the SFX bus: the concussion lowpass sits on that
      // bus, and the heartbeat is exactly the sound that should survive it.
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
    // Exponential in frequency so the sweep sounds even: 20 kHz → ~700 Hz.
    const hz = d < 0.01 ? SFX_FILTER_OPEN : 700 * Math.pow(SFX_FILTER_OPEN / 700, 1 - d);
    this.musicLP.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.25);
  }

  // ══ VS splash sting (GFX/SOUND #8, 2026-09-23) ═══════════════════════
  // A reversed-cymbal riser into a sub boom and a metallic clang, timed so the
  // boom lands as the two name cards meet (the splash CSS slams them in at ~0.45 s).
  vsSting() {
    // Running-only: the first splash plays before any gesture has unlocked the
    // context, and nodes scheduled on a suspended context fire whenever it is
    // finally resumed — a VS boom arriving in the middle of the fight.
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

    // Clang: three inharmonic square partials through a bandpass — a bell struck
    // with a hammer, not a note.
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

  // ══ Breaking-news sting (GFX/SOUND #9, 2026-09-23) ═══════════════════
  // The cable-news "da-da-da-DAAA": three bright brass stabs climbing to a held
  // fifth, over a timpani roll that swells into the last hit.
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

    // Timpani roll: rapid low sine hits swelling into the downbeat.
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
      // The shared bus context is the whole app's (js/audioBus.js): closing it here killed
      // audio for every game visited afterwards, and handed the NEXT PoBrawl engine — a
      // training-room toggle re-inits one in place — a dead context whose second close()
      // rejected ("Cannot close a closed AudioContext"). Our nodes are disconnected by the
      // stop* calls above; only a private fallback context is ours to close.
      if (this._ownsCtx && this.ctx.state !== 'closed') {
        this.ctx.close().catch(() => { /* already closing */ });
      } else {
        // On the shared context, cut our master chain loose so a re-init does not leave
        // a dead graph hanging off the app's bus.
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