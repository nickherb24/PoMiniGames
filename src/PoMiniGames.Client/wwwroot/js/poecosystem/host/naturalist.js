// naturalist.js — real-world field-guide cards for the Almanac.
// iNaturalist's public taxa API gives each of the island's four species a photo, its
// licence and attribution, and a link to the taxon page; Wikipedia's REST summary gives a
// short description. Both are anonymous, CORS-enabled, and called from the browser with
// credentials omitted — never through the app's HttpClient, whose pipeline attaches the
// session cookie and antiforgery header to everything it sends.
//
// The answer is cached in localStorage for a week: the facts do not change, and the
// Almanac is opened far more often than a field guide needs refreshing.
const SPECIES = Object.freeze([
  { species: 0, scientific: 'Oryctolagus cuniculus' },
  { species: 1, scientific: 'Cervus elaphus' },
  { species: 2, scientific: 'Canis lupus' },
  { species: 3, scientific: 'Homo sapiens' },
]);
const CACHE_KEY = 'poeco:naturalist:v2';
const CACHE_MS = 7 * 24 * 3600 * 1000;
const SUMMARY_MAX = 320;

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s ?? '');

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function lookup(entry, fetchImpl) {
  // Exact scientific-name match, not the first hit: a search for "Canis lupus" ranks the
  // domestic dog (Canis familiaris) first.
  const taxa = await getJson(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(entry.scientific)}&rank=species&per_page=10&locale=en`, fetchImpl);
  const results = taxa?.results ?? [];
  const t = results.find(r => String(r.name ?? '').toLowerCase() === entry.scientific.toLowerCase()) ?? null;
  if (!t) return null;
  let summary = '';
  const wiki = typeof t.wikipedia_url === 'string' ? t.wikipedia_url.split('/wiki/')[1] : '';
  if (wiki) {
    try {
      const page = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${wiki}`, fetchImpl);
      summary = clip(page?.extract ?? '', SUMMARY_MAX);
    } catch { /* the photo card still stands without a summary */ }
  }
  return {
    species: entry.species,
    commonName: t.preferred_common_name ?? t.name ?? entry.scientific,
    scientificName: t.name ?? entry.scientific,
    photoUrl: t.default_photo?.medium_url ?? t.default_photo?.square_url ?? '',
    attribution: clip(t.default_photo?.attribution ?? '', 160),
    license: t.default_photo?.license_code ?? '',
    url: `https://www.inaturalist.org/taxa/${t.id}`,
    observations: t.observations_count ?? 0,
    summary,
  };
}

/** The four cards, from cache when fresh; [] when offline and nothing is cached. */
export async function fetchSpeciesInfo({ storage = globalThis.localStorage, fetchImpl = globalThis.fetch?.bind(globalThis), now = Date.now } = {}) {
  try {
    const cached = storage ? JSON.parse(storage.getItem(CACHE_KEY) ?? 'null') : null;
    if (cached && now() - cached.at < CACHE_MS && Array.isArray(cached.cards) && cached.cards.length) return cached.cards;
  } catch { /* a corrupt cache is just a miss */ }
  if (!fetchImpl) return [];
  const settled = await Promise.allSettled(SPECIES.map(s => lookup(s, fetchImpl)));
  const cards = settled.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  if (cards.length) { try { storage?.setItem(CACHE_KEY, JSON.stringify({ at: now(), cards })); } catch { /* quota */ } }
  return cards;
}
