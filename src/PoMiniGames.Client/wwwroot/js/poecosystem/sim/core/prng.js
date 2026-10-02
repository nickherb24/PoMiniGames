// prng.js — seeded random streams. Nothing under sim/ may call Math.random
// (ESLint enforces it); every draw goes through one of these.
import { RNG_SALT } from './config.js';

/** mulberry32 — same generator as povoxelstrike/world.js, copied so sim/ stays self-contained. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stream with helpers and a restorable state (the mulberry32 word). The
 * generator is re-implemented inline rather than wrapping mulberry32() so the
 * state can be read back and set for snapshots.
 */
export function createRng(seed) {
  let a = seed >>> 0;
  let spare = null; // cached second gaussian sample
  const rng = {
    seed: seed >>> 0,
    next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** Float in [0, 1). Alias for next(). */
    uniform() { return rng.next(); },
    /** Integer in [0, n). */
    int(n) { return Math.floor(rng.next() * n); },
    /** Float in [lo, hi). */
    range(lo, hi) { return lo + rng.next() * (hi - lo); },
    pick(arr) { return arr[Math.floor(rng.next() * arr.length)]; },
    /** Standard normal via Box–Muller. */
    gaussian() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0;
      while (u === 0) u = rng.next();
      const v = rng.next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    // The Box–Muller spare is state too. Dropping it on save would make a world snapshotted
    // between the two halves of a pair draw different traits for its next newborn after a
    // restore while consuming exactly as many draws — a silent divergence. A pending spare
    // saves as [a, spare]; a bare number is still read.
    getState() { return spare === null ? a : [a, spare]; },
    setState(s) {
      if (Array.isArray(s)) { a = s[0] >>> 0; spare = Number.isFinite(s[1]) ? s[1] : null; } else { a = s >>> 0; spare = null; }
    },
  };
  return rng;
}

/** One stream per RNG_SALT key, all derived from the world seed. */
export function createStreams(seed) {
  const streams = {};
  for (const key of Object.keys(RNG_SALT)) streams[key] = createRng((seed ^ RNG_SALT[key]) >>> 0);
  streams.getState = () => {
    const s = {};
    for (const key of Object.keys(RNG_SALT)) s[key] = streams[key].getState();
    return s;
  };
  streams.setState = (s) => {
    for (const key of Object.keys(RNG_SALT)) if (key in s) streams[key].setState(s[key]);
  };
  return streams;
}

/**
 * Coerce a seed the user typed into a uint32. Plain integers pass through so a shared
 * "seed 7" reproduces exactly — including the NEGATIVE form the UI shows for a seed that
 * came back from the sim as a signed int32, which must round-trip to the same island.
 * Anything else is FNV-1a hashed.
 */
export function hashString(text) {
  const s = String(text ?? '').trim();
  if (/^-?\d{1,10}$/.test(s)) {
    const n = Number(s);
    if (n >= -0x80000000 && n <= 0xFFFFFFFF) return n >>> 0;
  }
  let h = 0x811C9DC5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
