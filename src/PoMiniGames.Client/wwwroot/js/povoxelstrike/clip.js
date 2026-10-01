// clip.js — a five-second WebM of the run's biggest collapse.
//
// A WebM cannot be cut after the fact, so there is no rolling buffer to trim: the recorder
// starts when a collapse is announced and stops five seconds later. That works because
// DebrisManager announces a collapse the moment the mass DETACHES — the fall is what comes
// next. Only a collapse heavier than the one already kept starts a recording, and the kept
// clip is replaced only when its successor has finished.

const CLIP_MS = 5000;

export class ClipRecorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.best = 0;        // voxels in the collapse the kept clip shows
    this.blob = null;
    this._recorder = null;
    this._timer = 0;
  }

  /** @param voxels size of the collapse that is starting */
  trigger(voxels) {
    if (this._recorder || voxels <= this.best) return;
    if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) return;
    try {
      const stream = this.canvas.captureStream(30);
      const type = ['video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
      if (!type) return;
      const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        this._recorder = null;
        if (chunks.length) { this.blob = new Blob(chunks, { type: 'video/webm' }); this.best = voxels; }
      };
      recorder.start();
      this._recorder = recorder;
      this._timer = setTimeout(() => this._stop(), CLIP_MS);
    } catch (err) {
      console.warn('[PoVoxelStrike] clip recording unavailable:', err);
      this._recorder = null;
    }
  }

  _stop() {
    clearTimeout(this._timer);
    try { if (this._recorder?.state === 'recording') this._recorder.stop(); } catch { /* already stopped */ }
  }

  /** Download the kept clip. False when the run never produced one. */
  save() {
    if (!this.blob) return false;
    const url = URL.createObjectURL(this.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voxel-strike-collapse.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }

  dispose() { this._stop(); }
}
