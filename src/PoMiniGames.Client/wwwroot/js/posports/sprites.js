// sprites.js — atlas loading and frame drawing for the PoSports characters.
//
// Assets live at images/PoSports/<char>/<anim>/{atlas.json, spritesheet.webp}
// (normalized by scripts/posports-assets.ps1). Loading is lazy and per-character:
// a meet only fetches the characters actually in its lanes, and only the anims
// requested — a full character is ~1-2 MB, so eager-loading the whole roster would
// triple first-paint time for nothing.
//
// Sheets are WebP, not PNG (about a third smaller across the roster). The sheet
// dimensions are what keep the atlas.json frame rectangles valid — if you ever
// re-export, preserve them or every frame coordinate below shifts.
// The `frames/` directories beside each sheet are export intermediates that
// nothing here reads; they are excluded from publish in PoMiniGamesClient.csproj.
//
// Failure policy (spec error table): one retry per asset, then a colored-rectangle
// fallback so a flaky fetch degrades the art, never the race.

const ANIM_FPS = 24; // all sheets were exported at a uniform cadence

/** char key -> anim key -> {bitmap, frames: [{x,y,w,h}], failed} */
const cache = new Map();

/** Deterministic fallback tint per character, used when a sheet fails to load. */
export const FALLBACK_COLORS = {
  kim: '#8a4ad9',
  matt: '#4ad98a', nick: '#d9c44a', tong: '#d9704a',
};

async function fetchAsset(url, asJson, attempt = 0) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return asJson ? await res.json() : await res.blob();
  } catch (err) {
    if (attempt === 0) return fetchAsset(url, asJson, 1);
    throw err;
  }
}

async function loadAnim(char, anim) {
  const base = `images/PoSports/${char}/${anim}`;
  const [atlas, blob] = await Promise.all([
    fetchAsset(`${base}/atlas.json`, true),
    fetchAsset(`${base}/spritesheet.webp`, false),
  ]);
  const bitmap = await createImageBitmap(blob);
  // Atlas frames object is keyed "0","1",… — order numerically, drop any partial
  // trailing cell that would sample past the sheet edge.
  const frames = Object.keys(atlas.frames)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => atlas.frames[k])
    .filter((f) => f.x + f.w <= bitmap.width && f.y + f.h <= bitmap.height);
  return { bitmap, frames, failed: false };
}

/**
 * Load the given anims for a character into the cache. Resolves when all settle;
 * failed anims are cached as failed (drawn as fallback rects) rather than rejecting.
 */
export async function loadCharacter(char, anims) {
  let perChar = cache.get(char);
  if (!perChar) { perChar = new Map(); cache.set(char, perChar); }
  await Promise.all(anims.map(async (anim) => {
    if (perChar.has(anim)) return;
    const pending = loadAnim(char, anim).catch((err) => {
      console.warn(`[PoSports] sprite load failed: ${char}/${anim}`, err);
      return { bitmap: null, frames: [], failed: true };
    });
    perChar.set(anim, pending);          // cache the promise → concurrent callers coalesce
    perChar.set(anim, await pending);    // then swap in the settled value
  }));
}

/**
 * Draw one character frame. `t` is seconds since the anim started (frames advance at
 * ANIM_FPS and loop unless `loop` is false, where the last frame holds). (x, y) is the
 * BOTTOM-CENTER anchor — feet on the track; `height` is the on-screen sprite height in
 * canvas px; `flip` mirrors horizontally (all sheets face right).
 */
export function draw(ctx, char, anim, t, x, y, height, { flip = false, loop = true } = {}) {
  const entry = cache.get(char)?.get(anim);
  if (!entry || typeof entry.then === 'function' || entry.failed || entry.frames.length === 0) {
    // Fallback: a tinted rounded rect the size the sprite would be.
    const w = height * 0.45;
    ctx.save();
    ctx.fillStyle = FALLBACK_COLORS[char] ?? '#888';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - height, w, height, 6);
    ctx.fill();
    ctx.restore();
    return;
  }

  const idx = Math.floor(t * ANIM_FPS);
  const frame = entry.frames[loop ? idx % entry.frames.length : Math.min(idx, entry.frames.length - 1)];
  const w = height * (frame.w / frame.h);
  ctx.save();
  if (flip) {
    ctx.translate(x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-x, 0);
  }
  ctx.drawImage(entry.bitmap, frame.x, frame.y, frame.w, frame.h, x - w / 2, y - height, w, height);
  ctx.restore();
}

/** Drop a character's decoded bitmaps (page dispose). */
export function unloadAll() {
  for (const perChar of cache.values()) {
    for (const entry of perChar.values()) {
      if (entry && typeof entry.then !== 'function') entry.bitmap?.close?.();
    }
  }
  cache.clear();
}
