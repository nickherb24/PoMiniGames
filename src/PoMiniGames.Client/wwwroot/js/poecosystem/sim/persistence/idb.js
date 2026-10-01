// idb.js — the world store. A tiny key/value surface (get/put/delete) over IndexedDB in
// the browser, or over a Map in tests and as a last-resort fallback. The sim worker owns
// the store, so autosave never crosses a thread boundary.

import { migrateSnapshot } from './codec.js';

const DB_NAME = 'poecosystem';
const STORE = 'worlds';
const CURRENT = 'current';
const META = 'meta';

export function memoryIdb() {
  const map = new Map();
  return {
    kind: 'memory',
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

/**
 * Open (or create) the IndexedDB-backed store; falls back to memory when unavailable.
 *
 * "Unavailable" has to include *silent*, not just broken. `open()` fires neither success
 * nor error when the upgrade is blocked by another tab holding the database (onblocked),
 * and in a partitioned or storage-denied context it can throw outright or simply never
 * answer. The sim worker awaits this before it will handle a single message, so a promise
 * that never settles here is a world that never starts — hence the explicit onblocked
 * branch and the wall clock behind it. Losing persistence costs an autosave; hanging
 * costs the whole island.
 */
export function openWorldStore(indexedDbImpl = globalThis.indexedDB, { timeoutMs = 4000 } = {}) {
  if (!indexedDbImpl) return Promise.resolve(memoryIdb());
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (store) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(store);
    };
    timer = setTimeout(() => done(memoryIdb()), timeoutMs);

    let req;
    try { req = indexedDbImpl.open(DB_NAME, 1); }
    catch { done(memoryIdb()); return; }

    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    // Another tab is still holding the old version open: that open will not proceed until
    // it closes, which may be never.
    req.onblocked = () => done(memoryIdb());
    req.onerror = () => done(memoryIdb());
    req.onsuccess = () => {
      const db = req.result;
      // An open that lands after the fallback was handed out has no reader: close it
      // rather than leaving a connection that would block the NEXT tab's upgrade.
      if (settled) { try { db.close(); } catch { /* already gone */ } return; }
      const run = (mode, fn) => new Promise((ok, fail) => {
        const tx = db.transaction(STORE, mode);
        const r = fn(tx.objectStore(STORE));
        r.onsuccess = () => ok(r.result === undefined ? null : r.result);
        r.onerror = () => fail(r.error);
      });
      done({
        kind: 'indexeddb',
        get: (key) => run('readonly', (s) => s.get(key)),
        put: (key, value) => run('readwrite', (s) => s.put(value, key)),
        delete: (key) => run('readwrite', (s) => s.delete(key)),
      });
    };
  });
}

export async function saveWorld(store, snapshot) {
  // Both writes go out together: they are independent keys, and an autosave should not
  // pay two sequential transaction commits.
  await Promise.all([
    store.put(CURRENT, snapshot),
    store.put(META, {
      seed: snapshot.seed,
      tick: snapshot.tick,
      year: snapshot.year,
      savedAt: snapshot.savedAt,
      counts: snapshot.counts,
      schemaVersion: snapshot.schemaVersion ?? 2,
    }),
  ]);
}

export async function loadWorld(store) {
  const snap = await store.get(CURRENT);
  return snap ? migrateSnapshot(snap) : null;
}
export const loadWorldMeta = (store) => store.get(META);
export async function deleteWorld(store) { await store.delete(CURRENT); await store.delete(META); }

// ── Keyframes (the time machine, 2026-09-30) ───────────────────────────────────────────
// One whole snapshot per decade of the CURRENT world, beside the autosave: `kf:index` lists
// them ({ seed, frames: [{ year, tick, counts, savedAt }] }) and `kf:<year>` holds each. A
// frame is only ever opened read-only (simRuntime marks the world ephemeral), so the past
// can be visited and never rewritten. Bounded: the oldest frame goes when a ninth arrives.
const KF_INDEX = 'kf:index';
const kfKey = (year) => `kf:${year}`;
export const KEYFRAME_MAX = 8;

export async function listKeyframes(store, seed) {
  const idx = await store.get(KF_INDEX);
  return idx && idx.seed === seed && Array.isArray(idx.frames) ? idx.frames : [];
}

export async function saveKeyframe(store, snapshot) {
  const idx = await store.get(KF_INDEX);
  const old = Array.isArray(idx?.frames) ? idx.frames : [];
  // Another world's frames, or frames from a future this world has not reached (a save
  // older than its newest frame was resumed), are dropped before the new one is filed.
  const keep = idx?.seed === snapshot.seed ? old.filter(f => f.year < snapshot.year) : [];
  for (const f of old) if (!keep.includes(f)) await store.delete(kfKey(f.year));
  keep.push({ year: snapshot.year, tick: snapshot.tick, counts: snapshot.counts, savedAt: snapshot.savedAt });
  while (keep.length > KEYFRAME_MAX) await store.delete(kfKey(keep.shift().year));
  await store.put(kfKey(snapshot.year), snapshot);
  await store.put(KF_INDEX, { seed: snapshot.seed, frames: keep });
  return keep;
}

export async function loadKeyframe(store, year) {
  const snap = await store.get(kfKey(year));
  return snap ? migrateSnapshot(snap) : null;
}

export async function clearKeyframes(store) {
  const idx = await store.get(KF_INDEX);
  for (const f of idx?.frames ?? []) await store.delete(kfKey(f.year));
  await store.delete(KF_INDEX);
}
