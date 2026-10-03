// appPrefs.js — applies the user's display/feedback preferences to the document.
//
// The single interop surface behind SettingsService. Everything here is a
// write-through: SettingsService owns the persisted value, this module owns
// the DOM/audio-graph consequence of it.
//
// Theme deliberately lives on `<html data-theme>` rather than a media query —
// see the long comment above the light palette in css/app.css for why. The
// first stamp happens in the inline script in index.html (before first paint);
// this module takes over once Blazor has booted, and is what makes the
// Auto/Light/Dark switch take effect without a reload.

import * as AudioBus from './audioBus.js';

const THEME_KEY = 'pomini_theme';

let _mediaQuery = null;
let _mediaListener = null;
let _motionQuery = null;
let _motionListener = null;

/** Resolve "auto" against the OS; pass "light"/"dark" through unchanged. */
function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
        return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

/**
 * Stamp the effective theme on <html>.
 *
 * In "auto" we also subscribe to the OS preference so the page re-themes live
 * when the system flips (macOS/Windows sunset schedules do this mid-session).
 * The listener is torn down whenever the mode is no longer auto — leaving it
 * attached would let the OS silently override an explicit user choice.
 *
 * @param {'auto'|'light'|'dark'} mode
 */
export function applyTheme(mode) {
    try {
        document.documentElement.setAttribute('data-theme', resolve(mode));

        if (_mediaQuery && _mediaListener) {
            _mediaQuery.removeEventListener('change', _mediaListener);
            _mediaQuery = null;
            _mediaListener = null;
        }

        if (mode === 'auto') {
            _mediaQuery = matchMedia('(prefers-color-scheme: light)');
            _mediaListener = (e) => {
                document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
            };
            _mediaQuery.addEventListener('change', _mediaListener);
        }
    } catch { /* no matchMedia — the dark default stands */ }
}

/**
 * Toggle the manual reduced-motion opt-in.
 *
 * `data-motion` is the single source of truth the stylesheet reads — app.css no
 * longer carries a parallel `@media (prefers-reduced-motion)` universal rule, so
 * the OS preference has to be folded in HERE or an OS-reduced-motion user would
 * lose their guard the moment this runs. Effective value is therefore
 * `userChoice || osPreference`: turning the app toggle off does NOT re-enable
 * motion for someone whose system asked for less, which is the behaviour the two
 * separate rules used to produce.
 *
 * Mirrors applyTheme: the OS listener stays attached only while the user has not
 * overridden, so a live system change re-resolves but never beats an explicit
 * opt-in.
 *
 * @param {boolean} reduce
 */
export function applyReducedMotion(reduce) {
    try {
        stampMotion(reduce);

        if (_motionQuery && _motionListener) {
            _motionQuery.removeEventListener('change', _motionListener);
            _motionQuery = null;
            _motionListener = null;
        }

        // Only worth listening when the user has NOT opted in: once they have,
        // the attribute is already set and no OS change can alter the outcome.
        if (!reduce) {
            _motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
            _motionListener = () => stampMotion(false);
            _motionQuery.addEventListener('change', _motionListener);
        }
    } catch { /* best-effort */ }
}

/** Apply `userChoice || osPreference` to <html data-motion>. */
function stampMotion(reduce) {
    if (reduce || prefersReducedMotion()) {
        document.documentElement.setAttribute('data-motion', 'reduce');
    } else {
        document.documentElement.removeAttribute('data-motion');
    }
}

/**
 * Colour-blind-safe palettes. Like motion, the answer lives on <html> so game
 * engines can read it without an interop round-trip: PoEcosystem's charts and
 * PoCabinet's minimap switch to their Okabe–Ito sets when `data-colorsafe` is
 * present, on top of each game's own setting. The first stamp is the pre-paint
 * script in index.html.
 * @param {boolean} on
 */
export function applyColorSafe(on) {
    try {
        if (on) document.documentElement.setAttribute('data-colorsafe', '1');
        else document.documentElement.removeAttribute('data-colorsafe');
    } catch { /* best-effort */ }
}

/**
 * Master volume, 0..1. Delegates to the shared bus, which owns the gain node
 * and the persisted key — duplicating that here is exactly the five-modules
 * problem audioBus.js was created to end.
 * @param {number} volume
 */
export function applyVolume(volume) {
    try {
        AudioBus.setVolume(volume);
    } catch { /* Web Audio unavailable — nothing to set */ }
}

/**
 * Master mute. Goes through the bus so the change lands on the live gain node,
 * not just on the storage key: every already-running game engine is connected
 * to that node, so writing storage alone would leave the current session
 * audible until the next reload.
 * @param {boolean} muted
 */
export function applyMuted(muted) {
    try {
        AudioBus.setMuted(muted);
    } catch { /* Web Audio unavailable — nothing to set */ }
}

/**
 * Graphics quality for every game. 'auto' hands the choice back to the device
 * read in qualityTiers.js, which owns the tier and its storage key.
 * @param {'auto'|'low'|'medium'|'high'} tier
 */
export function applyGraphicsTier(tier) {
    const value = tier === 'auto' ? null : tier;
    if (window.PoQuality) {
        window.PoQuality.setOverride(value);
        return;
    }
    // qualityTiers.js not loaded yet: leave the choice where it will find it.
    try {
        if (value) localStorage.setItem('poFx.tier', value);
        else localStorage.removeItem('poFx.tier');
    } catch { /* private mode: nothing to persist */ }
}

/**
 * Read the OS reduced-motion preference, so the settings UI can tell the user
 * their system is already asking for less motion regardless of this toggle.
 * @returns {boolean}
 */
export function prefersReducedMotion() {
    try {
        return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}
