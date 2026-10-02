// Service worker registration + the two browser signals Blazor cannot read on its
// own: connectivity changes and "a new build is waiting to take over".
//
// Both are pushed into .NET via DotNetObjectReference callbacks rather than polled,
// so the UI reacts the moment the browser fires the event.
window.poPwa = (() => {
    let registration = null;
    let updateListener = null;   // DotNetObjectReference -> OnUpdateAvailable()
    let onlineListener = null;   // DotNetObjectReference -> OnConnectivityChanged(bool)

    // Install-prompt state: these MUST live at IIFE scope. A `let` statement
    // inside the returned object literal is a SyntaxError — the whole file would
    // fail to parse, so window.poPwa would never exist and service-worker
    // registration, the offline banner, the update prompt and the install prompt
    // would all be silently dead on every route.
    let deferredInstallPrompt = null;
    let installed = false;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
        installed = true;
        deferredInstallPrompt = null;
    });

    function notifyUpdate() {
        if (updateListener) {
            updateListener.invokeMethodAsync('OnUpdateAvailable').catch(() => { });
        }
    }

    return {
        // Called once from MainLayout. Registration failure is never fatal: the app
        // works fine without offline support, so a blocked/unsupported worker must
        // not break startup.
        async register() {
            if (!('serviceWorker' in navigator)) return false;
            try {
                registration = await navigator.serviceWorker.register('service-worker.js');
            } catch {
                return false;
            }

            // A worker already parked in `waiting` means an update downloaded during
            // a previous visit and never activated.
            if (registration.waiting && navigator.serviceWorker.controller) notifyUpdate();

            registration.addEventListener('updatefound', () => {
                const installing = registration.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    // `controller` distinguishes an update from the very first install
                    // — on a first visit there is nothing to tell the user to reload for.
                    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                        notifyUpdate();
                    }
                });
            });
            return true;
        },

        setUpdateListener(dotNetRef) { updateListener = dotNetRef; },

        // ── Update-toast routing ─────────────────────────────────────────
        // One call handing .NET everything it needs to decide whether the "new
        // version" toast may show: demo/kiosk pages stay silent (a reel has
        // nobody to press Update) and localhost/lan dev hosts stay silent (a
        // developer who rebuilds twice in an hour would be nagged twice an
        // hour). Probing from C# with `eval` interop would fail open and nag
        // dev hosts, which is what this exists to prevent.
        pageContext() {
            return {
                path: location.pathname,
                query: location.search,
                host: location.hostname,
            };
        },

        // Tell the waiting worker to activate, then reload onto it. Without the
        // controllerchange wait, the reload can race the activation and land back on
        // the old build, which reads to the user as "the update button did nothing".
        applyUpdate() {
            if (!registration || !registration.waiting) { location.reload(); return; }
            let reloaded = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (reloaded) return;
                reloaded = true;
                location.reload();
            });
            registration.waiting.postMessage('skipWaiting');
        },

        // ── Connectivity ──────────────────────────────────────────────────────
        // navigator.onLine is a coarse signal (it reports link state, not whether
        // our server is actually reachable), but it is the only one that fires
        // instantly and without a request. Good enough to drive a banner.
        isOnline() { return navigator.onLine; },

        setOnlineListener(dotNetRef) {
            onlineListener = dotNetRef;
            const push = () => {
                if (onlineListener) {
                    onlineListener.invokeMethodAsync('OnConnectivityChanged', navigator.onLine)
                        .catch(() => { });
                }
            };
            window.addEventListener('online', push);
            window.addEventListener('offline', push);
            return navigator.onLine;
        },

        // ── Install prompt ─────────────────────────────────────────────────
        // The browser fires `beforeinstallprompt` once per page load when the app
        // meets PWA installability criteria (manifest, SW, HTTPS, engagement). We
        // capture it here so a future install button can request it on demand via
        // `promptInstall()`; the user only sees the browser's native sheet, never a
        // custom modal that would feel like an ad. The `appinstalled` event clears
        // the deferred prompt — a second tap is meaningless once the app is on the
        // home screen. State + listeners live at IIFE scope above.

        // True iff the browser has offered an install. Returns false on browsers
        // without PWA support (Firefox desktop, in-app browsers) — callers should
        // hide the install affordance rather than rendering a button that does
        // nothing.
        canInstall() { return !!deferredInstallPrompt; },
        wasInstalled() { return installed; },

        // Show the browser's native install sheet. Resolves to 'accepted',
        // 'dismissed', or 'unavailable' (no prompt is queued). Safe to call when
        // canInstall() is false — it just resolves 'unavailable' and the UI can
        // degrade gracefully.
        async promptInstall() {
            if (!deferredInstallPrompt) return 'unavailable';
            deferredInstallPrompt.prompt();
            const choice = await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            return choice.outcome; // 'accepted' or 'dismissed'
        },

        // ── Invite link ────────────────────────────────────────────────────
        // The native share sheet where there is one (phones, and Windows/macOS
        // Chrome), the clipboard otherwise. Resolves 'shared', 'copied' or 'failed'
        // so the caller can say which happened; a dismissed share sheet is 'shared'
        // too, because the player saw it and chose not to send.
        async shareLink(title, url) {
            if (navigator.share) {
                try {
                    await navigator.share({ title, url });
                    return 'shared';
                } catch (e) {
                    if (e && e.name === 'AbortError') return 'shared';
                    // NotAllowedError etc. — fall through to the clipboard.
                }
            }
            try {
                await window.poCopyToClipboard(url);
                return 'copied';
            } catch {
                return 'failed';
            }
        },
    };
})();

// Game invites: the page half of Web Push. The worker half is js/pushWorker.js, the
// server half Features/Invites. Only the browser calls live here; the API calls go
// through the app's HttpClient in InviteService so they carry the antiforgery token.
window.poPush = (() => {
    const supported = () =>
        'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    // `navigator.serviceWorker.ready` never settles when no worker registered, so ask
    // for the registration instead and treat "none" as "cannot".
    const registration = async () => (supported() ? await navigator.serviceWorker.getRegistration() : null) || null;

    function keyBytes(base64Url) {
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    }

    return {
        // 'unsupported' | 'denied' | 'on' | 'off'
        async state() {
            const reg = await registration();
            if (!reg) return 'unsupported';
            if (Notification.permission === 'denied') return 'denied';
            return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
        },

        // Asks for permission (must run inside a click) and subscribes. Resolves the
        // endpoint to register with the server, or null if the player said no.
        async subscribe(publicKey) {
            const reg = await registration();
            if (!reg) return null;
            if (await Notification.requestPermission() !== 'granted') return null;

            const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
            try {
                return (await reg.pushManager.subscribe(options)).endpoint;
            } catch {
                // An old subscription made with a different server key blocks a new
                // one. Drop it and try once more.
                const stale = await reg.pushManager.getSubscription();
                if (!stale) return null;
                await stale.unsubscribe();
                try {
                    return (await reg.pushManager.subscribe(options)).endpoint;
                } catch {
                    return null;
                }
            }
        },

        // Resolves the endpoint that was dropped, so the server can forget it too.
        async unsubscribe() {
            const reg = await registration();
            const subscription = reg && await reg.pushManager.getSubscription();
            if (!subscription) return null;
            await subscription.unsubscribe();
            return subscription.endpoint;
        },
    };
})();
