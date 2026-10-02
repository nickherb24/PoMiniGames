// errorReporter.js — tells the server when the page breaks in a player's browser.
//
// WHY: without it a shader typo can leave a game on the error boundary for weeks and
// the first anyone knows is a person opening the page. Every report becomes one Warning in the server log (POST /client-errors, see
// Features/Health/ClientErrorEndpoints.cs).
//
// What is reported:
//   - uncaught errors and failed <script>/<link> loads   (window 'error', capture phase)
//   - unhandled promise rejections                        ('unhandledrejection')
//   - anything that reaches console.error                 (Blazor logs an unhandled
//     component exception and AppErrorBoundary's catch there; three.js logs a shader
//     that failed to compile there)
//   - a WebGL context lost under a canvas that is still on the page a second later
//
// Loaded BEFORE consoleFilter.js on purpose: that filter then wraps this file's
// console.error, so the audio-teardown noise it drops never reaches the reporter.
//
// Bounded on this side as well as the server's: one report per distinct message and
// ten per page load, so a loop that throws every frame costs ten requests, not 3,600.

(function () {
    if (window.poClientErrors) return;

    var MAX_PER_PAGE = 10;
    var sent = 0;
    var seen = Object.create(null);

    function clip(value, max) {
        var text = value == null ? '' : String(value);
        return text.length > max ? text.slice(0, max) : text;
    }

    function report(kind, message, source, stack) {
        try {
            message = clip(message, 500);
            var key = kind + '|' + message;
            if (!message || seen[key] || sent >= MAX_PER_PAGE) return;
            seen[key] = true;
            sent++;

            var blob = new Blob([JSON.stringify({
                kind: kind,
                message: message,
                source: clip(source, 200),
                stack: clip(stack, 2000),
                path: clip(location.pathname + location.search, 200),
            })], { type: 'application/json' });

            // sendBeacon is queued by the browser and survives the unload an error often
            // causes. keepalive fetch is the same promise for browsers that refuse the beacon.
            if (!(navigator.sendBeacon && navigator.sendBeacon('/client-errors', blob))) {
                fetch('/client-errors', { method: 'POST', body: blob, keepalive: true }).catch(function () { });
            }
        } catch (_) { /* a reporter that throws would report itself forever */ }
    }

    window.addEventListener('error', function (e) {
        var target = e.target;
        // Capture phase also sees load failures, which do not bubble. Only scripts and
        // stylesheets: a missing engine module breaks a game, a missing image does not.
        if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
            report('resource', 'Failed to load ' + (target.src || target.href || target.tagName));
            return;
        }
        report('error', e.message, (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
            e.error && e.error.stack);
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
        var reason = e.reason;
        // An aborted fetch is a navigation tearing down its own requests, not a fault.
        if (reason && reason.name === 'AbortError') return;
        report('rejection', reason && reason.message ? reason.message : reason, '', reason && reason.stack);
    });

    // A game disposing its renderer on the way out loses its context too. Those canvases
    // are gone a second later; one still on the page has lost a context it was using.
    window.addEventListener('webglcontextlost', function (e) {
        var canvas = e.target;
        setTimeout(function () {
            if (canvas && canvas.isConnected) {
                report('webgl-context-lost', 'WebGL context lost on ' + (canvas.id || canvas.className || 'canvas'));
            }
        }, 1000);
    }, true);

    var rawError = console.error;
    console.error = function () {
        try {
            var parts = [];
            var stack = '';
            for (var i = 0; i < arguments.length; i++) {
                var a = arguments[i];
                if (a instanceof Error) {
                    parts.push(a.message);
                    stack = stack || a.stack;
                } else if (typeof a === 'string') {
                    parts.push(a);
                }
            }
            report('console', parts.join(' '), '', stack);
        } catch (_) { /* never let the hook break logging */ }
        return rawError.apply(console, arguments);
    };

    // For code that catches an error itself and still wants it known.
    window.poClientErrors = { report: report };
})();
