// assets.js — manifest fetch + content-hash Cache API layer.
//
// Payload URLs are content-addressed (the hash IS the identity), so a cached entry can
// never be stale — a changed GLB is a new hash and a new URL. The only maintenance is
// eviction: hashes the manifest no longer lists are deleted after a successful load.
// The service worker deliberately does not precache .pvx (its offlineAssetsInclude is
// extension-based); this cache is the offline story for voxel assets.

import { decodePvx } from './pvx.js';

const CACHE_NAME = 'povoxelstrike-assets';

async function openCache() {
  // caches is unavailable in insecure contexts; the game still works, just re-downloads.
  if (!('caches' in self)) return null;
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

/**
 * Fetch the manifest and every listed volume (cache-first), decode, and evict stale
 * cache entries. Individual asset failures are skipped with a warning — a partly
 * loaded world beats no world.
 *
 * @returns {Promise<Array<{name:string, hash:string, dims:[number,number,number],
 *   palette:Uint8Array, paletteMaterial:Uint8Array, materials:object[], cells:Uint8Array}>>}
 */
export async function loadAssets() {
  const manifestRes = await fetch(new URL('api/povoxelstrike/assets', document.baseURI));
  if (!manifestRes.ok) throw new Error(`asset manifest returned ${manifestRes.status}`);
  const manifest = await manifestRes.json();

  const cache = await openCache();
  const volumes = [];
  const liveUrls = new Set();

  for (const entry of manifest) {
    const url = new URL(entry.url, document.baseURI).href;
    liveUrls.add(url);
    try {
      let res = cache ? await cache.match(url) : null;
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error(`payload returned ${res.status}`);
        if (cache) { try { await cache.put(url, res.clone()); } catch { /* quota — serve without caching */ } }
      }
      const volume = decodePvx(await res.arrayBuffer());
      volume.name = entry.name;
      volume.hash = entry.hash;
      volumes.push(volume);
    } catch (err) {
      console.warn(`[PoVoxelStrike] skipping asset ${entry.name} (${entry.hash}):`, err);
    }
  }

  if (cache) {
    try {
      for (const req of await cache.keys()) {
        if (!liveUrls.has(req.url)) await cache.delete(req);
      }
    } catch { /* eviction is best-effort */ }
  }

  return volumes;
}
