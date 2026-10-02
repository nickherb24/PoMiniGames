// pushWorker.js — the service-worker half of game invites.
//
// Imported by BOTH workers (service-worker.js in development, service-worker.published.js
// in a published build) so an invite behaves the same in each; nothing here caches.
//
// A push from this app carries no payload (see Features/Invites/WebPushSender.cs): it
// is only a wake-up. The invite itself is fetched from the API on the player's own
// cookie, so the push service never learns who invited whom. A browser requires every
// push to end in a visible notification, so a fetch that fails (signed out, offline)
// still shows a generic one rather than nothing.

self.addEventListener('push', event => event.waitUntil(showInvite()));

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(openInvite(event.notification.data));
});

async function showInvite() {
    let invite = null;
    try {
        const response = await fetch('/api/invites/pending', { credentials: 'include' });
        if (response.ok) invite = (await response.json())[0] || null;
    } catch { /* offline — the generic notification below still appears */ }

    await self.registration.showNotification(
        invite ? `${invite.from} invites you to play ${invite.title}` : 'You have a game invite',
        {
            body: invite ? 'Tap to join the lobby.' : 'Open PoMiniGames to see it.',
            icon: 'favicon.png',
            // One slot: a second invite replaces the first instead of stacking.
            tag: 'po-invite',
            renotify: true,
            data: { url: invite ? invite.url : '/' },
        });
}

async function openInvite(data) {
    // The server writes the link as a path into this app; anything else opens the hub.
    let target = new URL('/', self.location.origin);
    try {
        const wanted = new URL((data && data.url) || '/', self.location.origin);
        if (wanted.origin === self.location.origin) target = wanted;
    } catch { /* malformed — keep the hub */ }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
        try {
            await client.focus();
            await client.navigate(target.href);
            return;
        } catch { /* a window this worker does not control cannot be navigated — try the next */ }
    }
    await self.clients.openWindow(target.href);
}
