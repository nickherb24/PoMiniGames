// Service worker registration + the two browser signals Blazor cannot read on its
// own: connectivity changes and "a new build is waiting to take over".
//
// Both are pushed into .NET via DotNetObjectReference callbacks rather than polled,
// so the UI reacts the moment the browser fires the event.
window.poPwa = (() => {
    let registration = null;
    let updateListener = null;   // DotNetObjectReference -> OnUpdateAvailable()
    let onlineListener = null;   // DotNetObjectReference -> OnConnectivityChanged(bool)

    // Install-prompt state (2026-09-11 fix): these MUST live at IIFE scope.
    // They were first written as `let` statements inside the returned object
    // literal, which is a SyntaxError — the whole file failed to parse, so
    // window.poPwa never existed and service-worker registration, the offline
    // banner, the update prompt and the install prompt were all silently dead
    // on every route.
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

        // ── Update-toast routing (2026-09-29) ────────────────────────────
        // One call handing .NET everything it needs to decide whether the "new
        // version" toast may show: demo/kiosk pages stay silent (a reel has
        // nobody to press Update) and localhost/lan dev hosts stay silent (a
        // developer who rebuilds twice in an hour would be nagged twice an
        // hour). This used to be probed from C# with `eval` interop, which
        // failed open — dev hosts got the nag the code exists to prevent.
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

        // ── Install prompt (2026-09-04 UI sweep, Option 9) ─────────────────
        // The browser fires `beforeinstallprompt` once per page load when the app
        // meets PWA installability criteria (manifest, SW, HTTPS, engagement). We
        // capture it here so a future install button can request it on demand via
        // `promptInstall()`; the user only sees the browser's native sheet, never a
        // custom modal that would feel like an ad. The `appinstalled` event clears
        // the deferred prompt — a second tap is meaningless once the app is on the
        // home screen. State + listeners live at IIFE scope above (2026-09-11 fix).

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
    };
})();
