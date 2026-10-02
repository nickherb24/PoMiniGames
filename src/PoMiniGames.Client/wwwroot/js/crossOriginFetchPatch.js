// Cross-origin credentials patch.
//
// The Blazor WASM HttpClient uses the browser's `fetch` underneath, and
// defaults to `credentials: 'omit'`. On the standalone-client dev setup
// (Blazor served from :5261, API on :5000) every cross-origin request
// therefore drops the DevCookie set by `/api/auth/dev-login`, and every
// subsequent protected endpoint returns 401 "Requires an authenticated
// user".
//
// This module patches the global `fetch` once so that requests to *our API
// origin* get `credentials: 'include'` and the cookie round-trips.
//
// The allow-list is load-bearing, not a nicety. A blanket
// "any cross-origin request gets credentials: 'include'" patch also hits
// third-party endpoints, and any of them that answers with
// `Access-Control-Allow-Origin: *` — as login.microsoftonline.com does —
// has its response rejected by the browser, because the Fetch spec forbids
// the wildcard once credentials are included. That broke MSAL's instance
// discovery: the failed lookup left `preferred_network` undefined and MSAL
// then requested `https://undefined/common/v2.0/.well-known/openid-configuration`,
// so Microsoft sign-in died with `endpoints_resolution_error` behind a blank
// popup. Only ever widen this to origins we actually own and that echo a
// specific `Access-Control-Allow-Origin` back.
//
// Idempotent — repeated installs are no-ops.

let installed = false;

/**
 * Install the credentials patch for a single API origin.
 * @param {string} apiBaseAddress Absolute URL of the API base (e.g. "http://localhost:5000/").
 *   Same-origin or unparseable values install nothing — the browser default already
 *   sends cookies same-origin.
 */
export function installCrossOriginCredentialsPatch(apiBaseAddress) {
    if (installed) return;

    let apiOrigin;
    try {
        apiOrigin = new URL(apiBaseAddress, window.location.href).origin;
    } catch {
        return;
    }

    // Nothing to do when the API is served from our own origin: fetch already
    // sends cookies same-origin, so patching would add risk and no behaviour.
    if (apiOrigin === window.location.origin) return;

    installed = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = function patchedFetch(input, init) {
        let url;
        try {
            url = typeof input === 'string'
                ? new URL(input, window.location.href)
                : (input instanceof URL
                    ? input
                    : new URL(input.url, window.location.href));
        } catch {
            // Unparseable URL — fall back to the original fetch.
            return originalFetch(input, init);
        }

        // Anything that is not our API — third-party CDNs, MSAL's Entra
        // discovery/token calls — must keep the browser's default credentials
        // mode. See the header comment for what breaks otherwise.
        if (url.origin !== apiOrigin) {
            return originalFetch(input, init);
        }

        // Our API, cross-origin: ensure credentials: 'include'. Don't clobber a
        // caller that explicitly set 'omit' (intentional opt-out).
        const nextInit = init ? { ...init } : {};
        if (!('credentials' in nextInit)) {
            nextInit.credentials = 'include';
        }
        return originalFetch(input, nextInit);
    };
}
