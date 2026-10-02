// Split-screen PoFunQuiz hotkey bridge.
//
// Razor can't subscribe to global keyboard events directly, so we register
// a window keydown handler here and forward each press to the .NET handler
// exposed by the page (OnSplitHotkeyAsync / OnSoloHotkeyAsync). The listener
// is registered once per page lifetime and torn down on dispose.
//
// Layout:
//   - Split-screen 2P: keys 1/2/3/4 → P1 options 0-3; 6/7/8/9 → P2 options 0-3
//   - Solo + alternating-turns 2P: keys 1/2/3/4 → options 0-3
//   - 5 is intentionally ignored (USB number row gap) so cross-side hits
//     are statistically less likely.
//
// We deliberately ignore keypresses when the user is typing in an input or
// contenteditable (e.g. the player name field on the landing card). That
// way the keys only fire during the in-game screen, not while the user is
// entering their names.

(function () {
    let dotnetRef = null;
    let active = false;
    // Solo + alternating-turns 2P reuse the same 1-4 keys as the
    // split-screen P1 side but route to a different .NET handler. Tracking the
    // mode here means the solo path can call OnSoloHotkeyAsync without the
    // page needing a second JS file or a second interop call.
    let activeMode = "split";

    function shouldIgnore(target) {
        if (!target) return false;
        const tag = (target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return true;
        if (target.isContentEditable) return true;
        return false;
    }

    function onKeyDown(ev) {
        if (!active || !dotnetRef) return;
        if (shouldIgnore(ev.target)) return;
        // Only react to plain key presses (no Ctrl/Alt/Meta); let the browser
        // handle its own shortcuts unmodified.
        if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

        let side = null;
        let optionIndex = null;
        let method = "OnSplitHotkeyAsync";
        const isSolo = activeMode === "solo";
        switch (ev.key) {
            case "1": side = isSolo ? "S" : "L"; optionIndex = 0; method = isSolo ? "OnSoloHotkeyAsync" : "OnSplitHotkeyAsync"; break;
            case "2": side = isSolo ? "S" : "L"; optionIndex = 1; method = isSolo ? "OnSoloHotkeyAsync" : "OnSplitHotkeyAsync"; break;
            case "3": side = isSolo ? "S" : "L"; optionIndex = 2; method = isSolo ? "OnSoloHotkeyAsync" : "OnSplitHotkeyAsync"; break;
            case "4": side = isSolo ? "S" : "L"; optionIndex = 3; method = isSolo ? "OnSoloHotkeyAsync" : "OnSplitHotkeyAsync"; break;
            case "6": if (isSolo) return; side = "R"; optionIndex = 0; break;
            case "7": if (isSolo) return; side = "R"; optionIndex = 1; break;
            case "8": if (isSolo) return; side = "R"; optionIndex = 2; break;
            case "9": if (isSolo) return; side = "R"; optionIndex = 3; break;
            default: return;
        }

        // Prevent the digit from leaking into any focused field (we already
        // bail out for inputs, but this also blocks arrow-key scrolling,
        // tab focus changes, etc.).
        ev.preventDefault();
        try {
            dotnetRef.invokeMethodAsync(method, side, optionIndex);
        } catch (e) {
            // .NET ref disposed during navigation — silence.
        }
    }

    window.poFunQuizSplitHotkeys = {
        register: function (ref) {
            dotnetRef = ref;
            active = true;
            activeMode = "split";
            window.addEventListener("keydown", onKeyDown, true);
        },
        // Solo + alternating-turns 2P use the same 1-4 keys but don't have
        // 6-9. Returning early on those keeps preventDefault from swallowing
        // a digit that has nowhere useful to go.
        registerSolo: function (ref) {
            dotnetRef = ref;
            active = true;
            activeMode = "solo";
            window.addEventListener("keydown", onKeyDown, true);
        },
        unregister: function () {
            active = false;
            activeMode = "split";
            window.removeEventListener("keydown", onKeyDown, true);
            dotnetRef = null;
        }
    };
})();