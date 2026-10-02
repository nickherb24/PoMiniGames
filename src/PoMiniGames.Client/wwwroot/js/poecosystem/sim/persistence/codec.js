// codec.js — a world snapshot as bytes that can leave the browser. IndexedDB stores the
// snapshot by structured clone, which carries typed arrays for free; the cloud store
// (Features/PoEcosystem on the API) takes an opaque gzip'd body, so this is the one
// place a snapshot is turned into JSON and back.
//
// Typed arrays become { $ta: "<ctor>", $b64: "<bytes>" } — a tag no sim state uses — and
// are rebuilt on decode; everything else is plain JSON already. Gzip is the platform's
// CompressionStream, available on the main thread and in workers alike, so no library.
const CTORS = { Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array };

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Snapshot → JSON text. */
export function encodeSnapshot(snapshot) {
  return JSON.stringify(snapshot, (_, value) => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $ta: value.constructor.name, $b64: toBase64(bytes) };
    }
    return value;
  });
}

/** Migrate snapshot schema: converts legacy v1 snapshots cleanly to v2. */
export function migrateSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  if (!snap.schemaVersion || snap.schemaVersion < 2) {
    snap.schemaVersion = 2;
    if (snap.state && !snap.state.tribes) {
      snap.state.tribes = {
        version: 2,
        tribes: [],
        buildings: [],
      };
    }
  }
  return snap;
}

/** JSON text → snapshot, typed arrays restored. Throws on malformed input. */
export function decodeSnapshot(text) {
  const parsed = JSON.parse(text, (_, value) => {
    if (value && typeof value === 'object' && typeof value.$ta === 'string' && typeof value.$b64 === 'string') {
      const Ctor = CTORS[value.$ta];
      if (!Ctor) return value;
      const bytes = fromBase64(value.$b64);
      // A fresh buffer is always aligned, so any element size views it directly.
      return new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
    }
    return value;
  });
  return migrateSnapshot(parsed);
}

/** Snapshot → gzip'd bytes (Uint8Array). */
export async function packSnapshot(snapshot) {
  const text = encodeSnapshot(snapshot);
  if (typeof CompressionStream === 'undefined') return new TextEncoder().encode(text);
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzip'd (or plain JSON) bytes → snapshot. */
export async function unpackSnapshot(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const gzipped = u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  let text;
  if (gzipped) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(u8);
  return decodeSnapshot(text);
}
