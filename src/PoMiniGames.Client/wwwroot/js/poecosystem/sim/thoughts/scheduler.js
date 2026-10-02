// scheduler.js — who thinks next. One inference in flight at a time; a plain round-robin
// over living creatures by index, except that a newly selected creature jumps the queue
// once (the selected creature preempts).
import { NONE } from '../core/entities.js';

export function createThoughtScheduler() {
  let cursor = 0;
  let pending = NONE;
  let servedSelected = NONE;
  return {
    get pending() { return pending; },
    /** Handle of the next thinker, or NONE while one is in flight or nobody is alive. */
    next(e, selected) {
      if (pending !== NONE && e.resolve(pending) !== NONE) return NONE;
      pending = NONE;
      if (selected !== NONE && selected !== servedSelected && e.resolve(selected) !== NONE) {
        servedSelected = selected;
        pending = selected;
        return selected;
      }
      if (e.count === 0) return NONE;
      for (let n = 0; n < e.cap; n++) {
        const i = (cursor + n) % e.cap;
        if (!e.alive[i]) continue;
        cursor = (i + 1) % e.cap;
        pending = e.handle(i);
        return pending;
      }
      return NONE;
    },
    /**
     * Up to `n` thinkers at once, for the batched cloud path. Same round-robin and the same
     * one-time preemption for a newly selected creature; nothing is marked pending, because
     * the runtime tracks the one batch in flight itself.
     */
    take(e, selected, n) {
      const out = [];
      if (selected !== NONE && selected !== servedSelected && e.resolve(selected) !== NONE) { servedSelected = selected; out.push(selected); }
      for (let scanned = 0; scanned < e.cap && out.length < n && e.count > 0; scanned++) {
        const i = cursor;
        cursor = (cursor + 1) % e.cap;
        if (!e.alive[i]) continue;
        const h = e.handle(i);
        if (!out.includes(h)) out.push(h);
      }
      return out;
    },
    complete(handle) { if (handle === pending) pending = NONE; },
    cancel() { pending = NONE; },
    getState() { return { cursor, servedSelected }; },
    setState(s) { cursor = s.cursor | 0; servedSelected = s.servedSelected ?? NONE; pending = NONE; },
  };
}
