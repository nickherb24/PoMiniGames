// prefs.js — per-viewer preferences in localStorage (injectable for tests). The player's
// position lives here too: the god is not part of the world, so it never enters a snapshot.

export const PREF_DEFAULTS = Object.freeze({
  llmEnabled: true,
  modelId: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
  speed: 1,
  seed: '',
  sound: true,           // procedural ambience (render/audio.js)
  player: null,          // { x, y, z, yaw, pitch, fly }
  keyLegendSeen: false,
  // Settings panel. quality: 'auto' | 'high' | 'medium' | 'low'.
  quality: 'auto',
  palette: 'default',    // 'default' | 'cb' (colour-blind safe)
  reducedMotion: false,
  bindings: null,        // { action: [codes] } overrides over input.js DEFAULT_BINDINGS
});
const PREFIX = 'poeco:';

export function createPrefs(storage) {
  const safe = storage && typeof storage.getItem === 'function' ? storage : null;
  return {
    get(key) {
      const fallback = PREF_DEFAULTS[key];
      if (!safe) return fallback;
      try {
        const raw = safe.getItem(PREFIX + key);
        if (raw === null || raw === undefined) return fallback;
        const value = JSON.parse(raw);
        return typeof fallback === 'object' || value === null || typeof value === typeof fallback ? value : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      if (!safe) return;
      try { safe.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode / quota */ }
    },
    remove(key) { try { safe?.removeItem(PREFIX + key); } catch { /* ignore */ } },
  };
}
