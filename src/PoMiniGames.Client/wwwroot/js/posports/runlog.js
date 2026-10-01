// runlog.js — the record of one human's keys through a meet.
//
// Two consumers read the same string: the ghost (your best run, replayed beside
// you) and the server, which re-runs it through PoSportsSim and stores the time
// IT gets (Features/PoSports/PoSportsRunVerifier.cs — the format below is a
// contract with that file). The stride model is fixed-step and takes nothing but
// these presses, so the log is the whole run.
//
// Wire format, two legs joined by '|':   <F>;<v>.<v>.<v>…
//   F  '1' if the player typed before the sprint gun (a false start), else '0'
//   v  base-36 of (tick * 5 + code): tick = fixed steps already run this leg when
//      the key landed (so it applies BEFORE that step), code = 0-3 the sequence
//      ordinal, 4 the jump.
const CODES = 5;
/** Longest leg the server will replay: its own 90 s safety cap at 60 Hz. */
export const MAX_TICKS = 5400;

export class RunLog {
  constructor() {
    this.reset();
  }

  reset() {
    this.legs = { sprint: { falseStart: false, events: [] }, hurdles: { falseStart: false, events: [] } };
  }

  /** A key that landed while the leg was live. */
  key(leg, tick, code) {
    if (tick < 0 || tick >= MAX_TICKS) return;
    this.legs[leg]?.events.push(tick * CODES + code);
  }

  /** A sequence key before the gun. Only the sprint countdown carries a hold into the leg. */
  falseStart(leg) {
    if (this.legs[leg]) this.legs[leg].falseStart = true;
  }

  encode() {
    const leg = (l) => `${l.falseStart ? 1 : 0};${l.events.map((v) => v.toString(36)).join('.')}`;
    return `${leg(this.legs.sprint)}|${leg(this.legs.hurdles)}`;
  }
}

/** Parse an encoded log back into per-leg event lists (for the ghost). Null if malformed. */
export function decode(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split('|');
  if (parts.length !== 2) return null;
  const out = {};
  for (const [i, name] of ['sprint', 'hurdles'].entries()) {
    const [flag, body] = parts[i].split(';');
    if (body === undefined) return null;
    const events = [];
    for (const tok of body ? body.split('.') : []) {
      const v = parseInt(tok, 36);
      if (!Number.isFinite(v) || v < 0) return null;
      events.push({ tick: Math.floor(v / CODES), code: v % CODES });
    }
    out[name] = { falseStart: flag === '1', events };
  }
  return out;
}
