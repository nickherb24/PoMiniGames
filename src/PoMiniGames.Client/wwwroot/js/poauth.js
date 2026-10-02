// Microsoft sign-in (MSAL.js) interop for the Blazor WASM client.
//
// The server exposes the SPA's ClientId / Authority / Scope / RedirectPath via
// /api/auth/handshake; AuthStateService passes them here. Sign-in uses a popup so
// no route-level redirect handling is required. acquireTokenSilent fetches an
// access token for the API scope, which the C# side attaches as the bearer for
// authenticated API calls.
//
// All functions degrade gracefully (return null / throw a clear error) when the
// msal-browser global failed to load, so the rest of the app is unaffected.
(function () {
    let app = null;
    let apiScope = null;
    // Cached result of the redirect-flow callback. MSAL's handleRedirectPromise
    // resolves before Blazor's OnInitialized runs, so we stash the auth result
    // and let AuthStateService pick it up via consumeRedirectResult().
    let pendingRedirectResult = null;

    function ensureLib() {
        if (typeof msal === "undefined" || !msal.PublicClientApplication) {
            console.warn("MSAL library not available (CDN unavailable or offline mode).");
            return false;
        }
        return true;
    }

    function loginScopes(scope) {
        const base = ["openid", "profile", "email"];
        return scope ? base.concat([scope]) : base;
    }

    async function acquireToken(account, scope) {
        if (!scope || !account || !app) return null;
        try {
            const res = await app.acquireTokenSilent({ account, scopes: [scope] });
            return res.accessToken;
        } catch (e) {
            try {
                const res = await app.acquireTokenPopup({ scopes: [scope] });
                return res.accessToken;
            } catch {
                return null;
            }
        }
    }

    function toResult(account, accessToken) {
        return {
            name: account.name || account.username,
            username: account.username,
            accessToken: accessToken || null
        };
    }

    window.poAuth = {
        init: function (clientId, authority, redirectPath) {
            if (!ensureLib()) return;
            apiScope = null;
            // Stash for the in-flight-lock recovery path in signIn().
            window.__poAuthLastClientId = clientId;
            window.__poAuthLastAuthority = authority;
            window.__poAuthLastRedirectPath = redirectPath;
            const origin = window.location.origin;
            const redirectUri = redirectPath
                ? origin + (redirectPath.startsWith("/") ? redirectPath : "/" + redirectPath)
                : origin;
            // MSAL.js appends `/v2.0/.well-known/openid-configuration` to the authority.
            // If the server-supplied authority already ends in `/v2.0`, MSAL will double
            // the segment and throw `endpoints_resolution_error` on init. Strip it here
            // as a defense-in-depth (the server should already normalize, but if a
            // future config slips through, MSAL still works).
            let safeAuthority = authority || "";
            safeAuthority = safeAuthority.replace(/\/v2\.0\/?$/i, "");
            app = new msal.PublicClientApplication({
                auth: {
                    clientId: clientId,
                    authority: safeAuthority,
                    redirectUri: redirectUri,
                    postLogoutRedirectUri: origin
                },
                cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false }
            });
        },

        // Silent restore: returns a result if MSAL already has a cached account.
        // If the current page load is the post-redirect callback (URL contains
        // an auth code/error from Microsoft), process it first so the result
        // flows through the same ApplyMicrosoftSessionAsync path.
        handleRedirect: async function (scope) {
            if (!app) return null;
            if (pendingRedirectResult !== null) {
                const cached = pendingRedirectResult;
                pendingRedirectResult = null;
                return cached;
            }
            apiScope = scope;
            try {
                const res = await app.handleRedirectPromise();
                if (!res) return null;
                const account = res.account || (app.getAllAccounts()[0]);
                if (!account) return null;
                app.setActiveAccount(account);
                const token = await acquireToken(account, scope);
                return toResult(account, token);
            } catch (e) {
                // Most common cause: handleRedirectPromise was called twice on the
                // same page load (SPA re-hydration). Swallow & return null so the
                // subsequent tryRestore path can still pick up a cached account.
                if (e && (e.errorCode === "interaction_in_progress"
                    || (e.message && e.message.indexOf("interaction_in_progress") !== -1)
                    || (e.message && e.message.indexOf("already running") !== -1))) {
                    return null;
                }
                throw e;
            }
        },

        tryRestore: async function (scope) {
            if (!app) return null;
            apiScope = scope;
            const accounts = app.getAllAccounts();
            if (!accounts || accounts.length === 0) {
                // Auto-retry after a self-induced reload (used to clear a stale
                // `interaction_in_progress` lock). Only retries once.
                if (sessionStorage.getItem("poAuth.retryAfterReload") === "1") {
                    sessionStorage.removeItem("poAuth.retryAfterReload");
                    const retryScope = sessionStorage.getItem("poAuth.retryScope") || scope;
                    sessionStorage.removeItem("poAuth.retryScope");
                    try {
                        var retryRes = await app.loginRedirect({ scopes: loginScopes(retryScope) });
                    } catch (e) { /* swallowed; navigation in progress */ }
                }
                return null;
            }
            const account = accounts[0];
            const token = await acquireToken(account, scope);
            return toResult(account, token);
        },

        // Interactive popup sign-in. Handles a stale "interaction in progress" lock
        // by reloading the page (which clears MSAL's module-level state). Without this,
        // a blocked popup leaves the lock set and every subsequent attempt fails until
        // the user manually refreshes.
        signIn: async function (scope) {
            ensureLib();
            apiScope = scope;
            try {
                var res = await app.loginPopup({ scopes: loginScopes(scope) });
            }
            catch (e) {
                // If MSAL is locked OR the popup was blocked, try the redirect flow.
                // loginRedirect also clears any cross-frame sandbox issue.
                try {
                    await app.loginRedirect({ scopes: loginScopes(scope) });
                    return; // browser navigates away
                }
                catch (e2) {
                    // If loginRedirect also failed with interaction_in_progress, the
                    // only remaining cure is to reload the page so MSAL's module-level
                    // lock resets. Tell the user once and reload after a short delay.
                    if (e2 && (e2.errorCode === "interaction_in_progress"
                              || (e2.message && e2.message.indexOf("interaction_in_progress") !== -1))) {
                        // Mark the next reload so we retry the sign-in automatically.
                        sessionStorage.setItem("poAuth.retryAfterReload", "1");
                        sessionStorage.setItem("poAuth.retryScope", scope || "");
                        // Show a brief inline notice by reloading after the user has time to read.
                        setTimeout(function () { window.location.reload(); }, 1500);
                        throw new Error("Microsoft sign-in was previously interrupted. Reloading…");
                    }
                    throw e2;
                }
            }
            const account = res.account || (app.getAllAccounts()[0]);
            if (!account) return null;
            app.setActiveAccount(account);
            const token = await acquireToken(account, scope);
            return toResult(account, token);
        },

        // Fallback: full-page redirect (works in sandboxed iframes / browsers that
        // block popups). Returns a promise that never resolves — the browser
        // navigates away before the .NET continuation runs. Use when popup flow
        // throws `popup_window_error`.
        signInRedirect: async function (scope) {
            ensureLib();
            apiScope = scope;
            await app.loginRedirect({ scopes: loginScopes(scope) });
        },

        signOut: async function () {
            if (!app) return;
            const account = app.getActiveAccount() || (app.getAllAccounts()[0]);
            if (!account) return;
            // Local sign-out only: logout() clears the MSAL account/token cache,
            // and onRedirectNavigate returning false cancels the navigation to
            // the Entra logout endpoint. logoutPopup() was tried first — in
            // embedded browsers (VS Code simple browser) the popup window opens
            // but its cross-origin navigation never completes, stranding a blank
            // about:blank window that the user has to close by hand. The Entra
            // SSO session itself stays alive: the app's real session is the
            // bearer/dev-cookie, and a full identity logout can still be done
            // directly at login.microsoftonline.com.
            try {
                await app.logout({
                    account: account,
                    onRedirectNavigate: function () { return false; }
                });
            } catch (e) {
                // Best-effort: a failed local logout must never block the app's
                // own sign-out (bearer/dev-cookie is already cleared by the C# side).
            }
        }
    };
})();
