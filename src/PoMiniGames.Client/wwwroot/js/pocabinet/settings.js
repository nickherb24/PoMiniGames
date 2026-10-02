// pocabinet/settings.js
//
// Player settings + per-track records (personal bests) for PoCabinet.
//
// Two localStorage stores, both owned HERE so Blazor never touches the raw
// JSON (the page reads/writes through the window.PoCabinet facade and gets
// plain values back):
//
//   pocabinet.settings.v1  — audio / render / accessibility / environment prefs
//   pocabinet.records.v1   — best lap + best sector splits per track id
//
// Trim-safety: no reflection, no dynamic dispatch — plain object shapes with
// fixed keys, defensively re-merged over DEFAULTS so a stale or hand-edited
// store can never poison a session.

const SETTINGS_KEY = 'pocabinet.settings.v1';
const RECORDS_KEY = 'pocabinet.records.v1';

const DEFAULT_SETTINGS = Object.freeze({
    // Fixed, not settings: volume, mute, reduced motion and colour-safe
    // colours are the app's (the settings sheet; PoAudioBus, <html data-motion>,
    // <html data-colorsafe>). They stay in the object because audio.js, scene.js and
    // minimap.js read these keys, but sanitize() does not take them from the store, so
    // a stale saved value (a muted Cabinet, say) cannot outlive the app's switch.
    masterVolume: 0.7,     // Cabinet's mix level under the app's volume
    muted: false,
    reducedMotion: false,
    colorSafe: false,
    music: true,           // adaptive race score (music.js)
    hudScale: 1,           // HUD font scale, 0.85 / 1 / 1.15
    weather: 'clear',      // clear | rain | auto (auto = open-meteo, DC). Clear by default (2026-09-29): auto changed grip without warning
    // Controls + driver aids (input.js / physics.assistControls). Aids only
    // shape the player's input, so they work online without server support.
    touchControls: 'auto', // auto (coarse pointer or first touch) | on | off
    steerMode: 'pad',      // pad (on-screen steer pad) | tilt (device orientation)
    steerSensitivity: 1,   // 0.5..1.5 multiplier on every steering source
    steeringAssist: 'off', // off | light | strong — blend toward the centre line
    autoBrake: false,      // lift + brake for the next corner
    racingLine: false,     // corner-speed coloured line on the road
});

let settings = { ...DEFAULT_SETTINGS };

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function sanitize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const s = { ...DEFAULT_SETTINGS };
    s.hudScale = clamp(src.hudScale, 0.8, 1.3, s.hudScale);
    s.music = src.music !== false;
    if (['auto', 'clear', 'rain'].includes(src.weather)) s.weather = src.weather;
    if (['auto', 'on', 'off'].includes(src.touchControls)) s.touchControls = src.touchControls;
    if (['pad', 'tilt'].includes(src.steerMode)) s.steerMode = src.steerMode;
    s.steerSensitivity = clamp(src.steerSensitivity, 0.5, 1.5, s.steerSensitivity);
    if (['off', 'light', 'strong'].includes(src.steeringAssist)) s.steeringAssist = src.steeringAssist;
    s.autoBrake = !!src.autoBrake;
    s.racingLine = !!src.racingLine;
    return s;
}

/** Load settings from localStorage (once per page boot); returns the merged object. */
export function loadSettings() {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (raw) settings = sanitize(JSON.parse(raw));
    } catch {
        // private mode / quota / corrupt JSON — defaults already in place
    }
    return { ...settings };
}

/** Merge a patch into settings, persist, and return the new snapshot. */
export function saveSettings(patch) {
    settings = sanitize({ ...settings, ...(patch && typeof patch === 'object' ? patch : {}) });
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* persistence is best-effort */ }
    return { ...settings };
}

/** Live settings snapshot (no copy — treat as read-only). */
export function currentSettings() {
    return settings;
}

// ──────────────────────────────────────────────────────────────────────────
//  Per-track records: best lap + best sector splits.
//  Shape: { [trackId]: { bestLap: number, sectors: [s1,s2,s3] } }
// ──────────────────────────────────────────────────────────────────────────

function readRecords() {
    try {
        const raw = window.localStorage.getItem(RECORDS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch { /* fall through to empty */ }
    return {};
}

function writeRecords(records) {
    try {
        window.localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    } catch { /* best-effort */ }
}

/** Read one track's records. Returns { bestLap: -1, sectors: [-1,-1,-1] } when unset. */
export function getRecords(trackId) {
    const all = readRecords();
    const rec = all[trackId];
    if (!rec || typeof rec !== 'object') return { bestLap: -1, sectors: [-1, -1, -1] };
    const sectors = Array.isArray(rec.sectors)
        ? [0, 1, 2].map(i => (Number.isFinite(Number(rec.sectors[i])) ? Number(rec.sectors[i]) : -1))
        : [-1, -1, -1];
    const bestLap = Number.isFinite(Number(rec.bestLap)) ? Number(rec.bestLap) : -1;
    return { bestLap, sectors };
}

/**
 * Record a finished race for a track. Returns
 * { isPb, previousBest } where previousBest is -1 when there was no prior lap.
 * A missing/non-positive lap still persists sector splits but never counts as a PB.
 */
export function recordTrackResult(trackId, bestLapSeconds, sectors) {
    const all = readRecords();
    const rec = (all[trackId] && typeof all[trackId] === 'object') ? all[trackId] : {};
    const previousBest = Number.isFinite(Number(rec.bestLap)) ? Number(rec.bestLap) : -1;

    const lap = Number(bestLapSeconds);
    let isPb = false;
    if (Number.isFinite(lap) && lap > 0 && (previousBest < 0 || lap < previousBest)) {
        rec.bestLap = lap;
        isPb = true;
    }

    if (Array.isArray(sectors)) {
        const stored = Array.isArray(rec.sectors) ? rec.sectors.slice(0, 3) : [];
        for (let i = 0; i < 3; i++) {
            const t = Number(sectors[i]);
            if (Number.isFinite(t) && t > 0) {
                const cur = Number(stored[i]);
                if (!Number.isFinite(cur) || cur <= 0 || t < cur) stored[i] = t;
            }
        }
        rec.sectors = stored;
    }

    all[trackId] = rec;
    writeRecords(all);
    return { isPb, previousBest };
}
