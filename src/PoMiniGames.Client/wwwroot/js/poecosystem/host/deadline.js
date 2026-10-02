// deadline.js — "this dependency may be missing, but it may never be slow".
//
// The simulation boots behind two awaits it does not control: a cannon-es import from a
// public CDN, and an IndexedDB open. Both were written as optional — a rejected import
// leaves physics off, a failed open falls back to a Map — but *optional* was only ever
// enforced for failure, never for silence. A CDN that accepts the connection and then
// says nothing, or an IndexedDB open blocked behind another tab's upgrade, settles
// neither way, and `await Promise.all([...])` on a never-settling promise wedges the
// whole world: the renderer keeps painting sky at 60 fps, no terrain ever arrives, and
// because the camera is only re-seated once terrain exists, nothing moves it — the page
// looks like a frozen screenshot of an empty sky (reproduced by holding the cannon-es
// request open).
//
// So every boot dependency runs against a clock. A timeout is NOT an error here: it
// resolves to the same fallback a rejection would, and the sim starts without it.
export function withDeadline(promise, ms, onTimeout) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

/** How long any single boot dependency may take before the sim starts without it. */
export const BOOT_DEADLINE_MS = 6000;
