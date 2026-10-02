// Development service worker — deliberately a no-op.
//
// Caching in development makes every code change appear not to take effect: the
// browser serves the previous build from the cache and the developer debugs a
// stale app. The real worker is service-worker.published.js, which the build
// substitutes for this file on `dotnet publish` only.
//
// This file must stay empty of caching logic. If you need to debug offline
// behaviour, run against published output (see docs: publish -> serve -> DevTools
// offline), not against `dotnet run`.
self.addEventListener('fetch', () => { });

// Game invites (push + notification click). Not caching, so it belongs here too:
// without it an invite could only be tried against a published build.
self.importScripts('./js/pushWorker.js');
