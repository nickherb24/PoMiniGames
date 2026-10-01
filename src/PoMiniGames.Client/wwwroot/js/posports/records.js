// records.js — this browser's PoSports bests.
//
// The server board keeps one combined time per player; everything a player races
// against lives here: the best time for each leg, the best meet with its key log
// (the ghost), the field-event bests, the daily meet and its streak, and the key
// bindings. localStorage, so it is a per-device convenience: it can be empty in a
// private window, and nothing here is trusted by the server.
const KEY = 'posports.records.v1';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

function write(r) {
  try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* private mode / quota */ }
}

/** Everything, for the page (stats row, intro card). */
export function all() {
  return read();
}

/** The ghost: the key log of the best meet, or null. */
export function ghost() {
  return read().ghost ?? null;
}

/**
 * Fold one finished meet in. Returns what changed, with the values it beat, so
 * the results card can show deltas.
 * @param {{sprint: number, hurdles: number, total: number, inputs: string}} run
 */
export function recordMeet(run) {
  const r = read();
  const prev = { sprint: r.sprint ?? 0, hurdles: r.hurdles ?? 0, total: r.total ?? 0 };
  const better = (now, was) => !was || now < was;
  const out = {
    prev,
    newSprint: better(run.sprint, prev.sprint),
    newHurdles: better(run.hurdles, prev.hurdles),
    newTotal: better(run.total, prev.total),
  };
  if (out.newSprint) r.sprint = run.sprint;
  if (out.newHurdles) r.hurdles = run.hurdles;
  if (out.newTotal) { r.total = run.total; r.ghost = run.inputs; }
  r.meets = (r.meets ?? 0) + 1;
  write(r);
  return out;
}

/** Field events: best is the largest distance, or for the relay the lowest time. */
export function recordEvent(event, value, lowerIsBetter) {
  const r = read();
  r.events = r.events ?? {};
  const was = r.events[event] ?? 0;
  const record = !was || (lowerIsBetter ? value < was : value > was);
  if (record) { r.events[event] = value; write(r); }
  return { record, prev: was };
}

/** Local calendar day as yyyymmdd — the daily meet's seed and its streak key. */
export function today(d = new Date()) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * A finished daily meet. The streak grows when yesterday was also run, holds on a
 * second go the same day, and restarts otherwise.
 */
export function recordDaily(total) {
  const r = read();
  const day = today();
  const d = r.daily ?? { day: 0, best: 0, streak: 0 };
  if (d.day !== day) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    d.streak = d.day === today(y) ? d.streak + 1 : 1;
    d.day = day;
    d.best = total;
  } else if (total < d.best) {
    d.best = total;
  }
  r.daily = d;
  write(r);
  return d;
}

export function keymaps() {
  return read().keys ?? null;
}

export function saveKeymaps(maps) {
  const r = read();
  r.keys = maps;
  write(r);
}
