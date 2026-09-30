// clip.js — the shareable KO clip.
//
// Keeps the last several seconds of the fight recorded at all times and, when a
// match ends, keeps the file: the lead-up, the finishing blow and the fall, with
// the fight's own audio. The news overlay (news.js) and the result modal offer it
// as "Save KO clip" (the phone share sheet where the browser has one).
//
// Same machinery as PoEcosystem's Island Reel (poecosystem/render/reel.js), for
// the same two reasons — read the notes there before changing either:
//   • TWO RECORDERS staggered by half a segment. A WebM is only decodable from its
//     first chunk, so a rolling buffer cannot be cut from the middle; with two
//     staggered recorders one of them always holds SEGMENT/2..SEGMENT of valid video.
//   • A MIRROR CANVAS. Encoding the full-resolution WebGL canvas would cost more than
//     the game; mirror() copies each composed frame into a small 2D canvas at 30 fps
//     and that is what is encoded. It must run straight after composer.render(), in
//     the same task, because the WebGL canvas has no preserveDrawingBuffer.
//
// Not in demo (a kiosk would encode forever for nobody), the training room (no KO),
// or on the low tier. Clips live in memory as one blob and never leave the machine
// unless the player saves or shares one.

const SEGMENT_MS = 14000;
const MIRROR_FPS = 30;
const MIME = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* keep looking */ } }
  return null;
}

export class KoClipRecorder {
  /**
   * @param {HTMLCanvasElement} source the renderer's canvas
   * @param {() => MediaStream|null} audioStream the fight mix, once the context exists
   */
  constructor(source, audioStream, { width = 854 } = {}) {
    this.source = source;
    this.audioStream = audioStream;
    this.mime = pickMime();
    this.ok = !!this.mime && typeof HTMLCanvasElement !== 'undefined'
      && !!HTMLCanvasElement.prototype.captureStream;
    this.width = width;
    this.recs = [];
    this.frozen = false;
    this.blob = null;
    this.url = null;
    this._lastMirror = 0;
    this._audioAdded = false;
  }

  start() {
    if (!this.ok || this.stream) return;
    const aspect = (this.source.height || 9) / (this.source.width || 16);
    this.mirror2d = document.createElement('canvas');
    this.mirror2d.width = this.width;
    this.mirror2d.height = Math.round(this.width * aspect / 2) * 2; // encoders want even sizes
    this.ctx2d = this.mirror2d.getContext('2d', { alpha: false });
    try { this.stream = this.mirror2d.captureStream(MIRROR_FPS); } catch { this.ok = false; return; }
    this.recs = [{ rec: null, chunks: [], startedAt: 0 }, { rec: null, chunks: [], startedAt: 0 }];
    this._startRec(this.recs[0]);
    this._second = setTimeout(() => this._startRec(this.recs[1]), SEGMENT_MS / 2);
    this._cycle = setInterval(() => {
      if (this.frozen) return; // a finished match keeps what it has until capture()
      const now = performance.now();
      for (const r of this.recs) {
        if (r.busy || !r.rec || now - r.startedAt < SEGMENT_MS) continue;
        const old = r.rec; r.rec = null;
        try { old.ondataavailable = null; old.stop(); } catch { /* already stopped */ }
        this._startRec(r);
      }
    }, 500);
  }

  /** Copy the frame just composed. Call right after composer.render(). */
  mirror(now) {
    if (!this.stream) return;
    if (now - this._lastMirror < 1000 / MIRROR_FPS - 2) return;
    this._lastMirror = now;
    try { this.ctx2d.drawImage(this.source, 0, 0, this.mirror2d.width, this.mirror2d.height); } catch { /* context lost */ }
  }

  _startRec(r) {
    if (!this.stream || this.disposed) return;
    // The fight mix only exists once the AudioContext has been unlocked by a
    // gesture, which is usually after the first recorder started. A recorder's
    // track list is fixed at construction, so the track joins the shared stream
    // here and every recorder built from then on carries it.
    if (!this._audioAdded) {
      const a = this.audioStream?.();
      const track = a?.getAudioTracks?.()[0];
      if (track) { this.stream.addTrack(track); this._audioAdded = true; }
    }
    try {
      const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 3_000_000 });
      r.chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) r.chunks.push(e.data); };
      rec.start(1000);
      r.rec = rec;
      r.startedAt = performance.now();
    } catch { r.rec = null; }
  }

  /** The match is decided: stop recycling so the lead-up is not thrown away. */
  freeze() {
    if (!this.stream) return;
    this.frozen = true;
  }

  /** Close the clip: keep the recorder with the longest history. Resolves to a Blob or null. */
  async capture() {
    if (!this.stream || !this.frozen || this._capturing) return null;
    this._capturing = true;
    const r = this.recs.filter((x) => x.rec).sort((a, b) => a.startedAt - b.startedAt)[0];
    let blob = null;
    if (r) {
      r.busy = true;
      blob = await new Promise((resolve) => {
        const rec = r.rec;
        rec.onstop = () => resolve(new Blob(r.chunks, { type: this.mime.split(';')[0] }));
        try { rec.stop(); } catch { resolve(null); }
        r.rec = null;
      });
      r.busy = false;
    }
    this._capturing = false;
    if (this.disposed) return null;
    if (blob && blob.size > 0) {
      if (this.url) URL.revokeObjectURL(this.url);
      this.blob = blob;
      this.url = URL.createObjectURL(blob);
    }
    return this.blob;
  }

  /** Next match: forget the old clip's hold on the cycle and record afresh. */
  resume() {
    if (!this.stream) return;
    this.frozen = false;
    for (const r of this.recs) if (!r.rec) this._startRec(r);
  }

  /** Save or share the most recent clip. */
  async save(title = 'PoBrawl KO') {
    if (!this.blob) return false;
    const ext = this.blob.type.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = `pobrawl-ko-${stamp}.${ext}`;
    // The share sheet only where it is the natural gesture (touch devices);
    // on a desktop a download is what "save" means.
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.canShare && navigator.share) {
      try {
        const file = new File([this.blob], name, { type: this.blob.type });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return true; }
      } catch { /* cancelled or refused — fall through to a download */ }
    }
    const a = document.createElement('a');
    a.href = this.url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._second);
    clearInterval(this._cycle);
    for (const r of this.recs) {
      try { if (r.rec) { r.rec.ondataavailable = null; r.rec.stop(); } } catch { /* already stopped */ }
      r.rec = null;
      r.chunks = [];
    }
    try { for (const t of this.stream?.getVideoTracks() || []) t.stop(); } catch { /* */ }
    this.stream = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = this.blob = null;
  }
}
