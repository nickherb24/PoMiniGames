// Production service worker: cache-first over the build's asset manifest, so the
// app shell, the .NET WASM runtime and every game's engine JS are available with no
// network. Only active in `dotnet publish` output — `dotnet run` gets the no-op
// service-worker.js instead.

self.importScripts('./service-worker-assets.js');
// Game invites: the push and notificationclick handlers, shared with the dev worker.
self.importScripts('./js/pushWorker.js');
self.addEventListener('install', event => event.waitUntil(onInstall(event)));
self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('fetch', event => event.respondWith(onFetch(event)));
// Lets the page tell a waiting worker to take over immediately (the "reload to
// update" toast) instead of waiting for every tab to close.
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});

const cacheNamePrefix = 'pominigames-offline-';
const cacheName = `${cacheNamePrefix}${self.assetsManifest.version}`;

// Static assets worth precaching. Game engine JS under js/<game>/ (three.js,
// cannon-es) are static web assets and land in the manifest automatically, so they
// are covered by the .js rule with no hand-maintained list to drift.
const offlineAssetsInclude = [
    /\.dll$/, /\.pdb$/, /\.wasm/, /\.html/, /\.js$/, /\.json$/, /\.css$/,
    /\.woff2?$/, /\.png$/, /\.jpe?g$/, /\.gif$/, /\.svg$/, /\.ico$/,
    /\.webmanifest$/, /\.blat$/, /\.dat$/,
];
const offlineAssetsExclude = [
    /^service-worker\.js$/,
    // Dev-only config; the published app reads appsettings.json.
    /^appsettings\.Development\.json$/,
];

// ── Never-cache list ──────────────────────────────────────────────────────────
// The correctness-critical part of this file. Auth here is a BFF cookie pattern
// over MSAL redirects; a cached auth redirect or a cached /api response does not
// fail loudly — it yields a mis-scoped session or silently stale game data, which
// is far harder to diagnose than an outright error. SignalR likewise must always
// reach the server: a cached negotiate response points at a connection that no
// longer exists.
//
// Anything matching these paths is passed straight to the network, cached never,
// and served from cache never.
const networkOnlyPaths = [
    /^\/api\//,                  // every REST endpoint
    /^\/auth(\/|$)/,             // client auth routes + server auth endpoints
    /^\/authentication(\/|$)/,   // MSAL redirect routes
    /^\/signin-oidc/,            // Entra redirect target
    /^\/signout/,                // sign-out endpoints
    /^\/health/,                 // liveness — a cached "healthy" is a lie
    /\/hubs?\//,                 // /couplequiz/hubs/game
    /-hub(\/|$)/,                // /poracer/lobby-hub, /posports/race-hub, …
    /\/gamehub(\/|$)/,           // /funquiz/gamehub
    /\/negotiate(\/|$|\?)/,      // SignalR negotiate on any hub
];

function isNetworkOnly(url) {
    // Cross-origin requests are never ours to cache.
    if (url.origin !== self.location.origin) return true;
    return networkOnlyPaths.some(pattern => pattern.test(url.pathname));
}

// Precache batch size.
//
// The stock Blazor template hands every asset to a single cache.addAll(), which
// issues them all in parallel. That does not survive this app's manifest: at ~2250
// assets the whole call rejects with "TypeError: Failed to fetch" (the browser runs
// out of connection resources), the install fails, and the cache is left EMPTY — so
// offline support silently does not exist while every individual asset is fine.
// Measured: single addAll -> fails; batches of 40 -> all 2257 cached in ~19s.
// Batching is therefore load-bearing, not a micro-optimisation. Keep it.
const precacheBatchSize = 40;

async function onInstall() {
    const assetsRequests = self.assetsManifest.assets
        .filter(asset => offlineAssetsInclude.some(p => p.test(asset.url)))
        .filter(asset => !offlineAssetsExclude.some(p => p.test(asset.url)))
        .map(asset => new Request(asset.url, { integrity: asset.hash, cache: 'no-cache' }));

    const cache = await caches.open(cacheName);
    // Sequential batches. A throw aborts the install deliberately: a half-filled
    // cache is worse than none — the app would boot offline and then fail on the
    // first asset that was never stored.
    for (let i = 0; i < assetsRequests.length; i += precacheBatchSize) {
        await cache.addAll(assetsRequests.slice(i, i + precacheBatchSize));
    }
}

async function onActivate() {
    // Drop caches from previous builds; keep only this version's.
    const keys = await caches.keys();
    await Promise.all(keys
        .filter(key => key.startsWith(cacheNamePrefix) && key !== cacheName)
        .map(key => caches.delete(key)));
    await self.clients.claim();
}

async function onFetch(event) {
    const request = event.request;

    if (request.method !== 'GET') return fetch(request);

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return fetch(request);
    }
    if (isNetworkOnly(url)) return fetch(request);

    // SPA navigations resolve to the cached shell so deep links work offline. The
    // auth routes above are excluded before reaching here, so this never short-
    // circuits a redirect the server needs to handle.
    const cache = await caches.open(cacheName);
    const shouldServeIndexHtml = request.mode === 'navigate';
    const cached = await cache.match(shouldServeIndexHtml ? 'index.html' : request);
    if (cached) return cached;

    // Not precached (a runtime asset, or a first-run miss). Go to network and fail
    // the way the browser normally would when offline.
    return fetch(request);
}
