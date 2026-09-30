// pocabinet/dialogue.js
//
// Client-side dialogue bubble renderer. Lines come from the server's sim online
// and from the banter pool in solo races; this module mounts a DOM bubble over the
// race view that fades in on each line and fades out after a short delay.
//
// API:
//   const handle = dialogue.mount(parentEl, officialId);
//   dialogue.show(handle, text, { durationMs });
//   dialogue.unmount(handle);

import { currentSettings } from './settings.js';

const BUBBLE_FADE_MS = 220;
const DEFAULT_VISIBLE_MS = 2400;

// Per-official name shown above the bubble. The wire shape sends the canonical
// id ("sean-s"); the client resolves a display name locally so the wire stays
// small and one place owns the copy.
const OFFICIAL_DISPLAY_NAMES = Object.freeze({
    'sean-s': 'Sean S.',
    'steve-b': 'Steve B.',
    'bill-b': 'Bill B.',
    'mike-p': 'Mike P.',
});

class DialogueHandle {
    constructor(root, nameEl, bodyEl) {
        this.root = root;
        this.nameEl = nameEl;
        this.bodyEl = bodyEl;
        this.disposed = false;
        this.hideTimer = null;
    }

    show(text, durationMs = DEFAULT_VISIBLE_MS) {
        if (this.disposed || !this.root) return;
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        this.bodyEl.textContent = text || '';
        this.root.classList.add('pocabinet-dialogue--visible');
        this.hideTimer = setTimeout(() => this.hide(), durationMs);
    }

    hide() {
        if (this.disposed || !this.root) return;
        this.root.classList.remove('pocabinet-dialogue--visible');
        this.hideTimer = null;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.hideTimer) clearTimeout(this.hideTimer);
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }
}

export function mount(parent, officialId) {
    if (typeof parent === 'string') parent = document.getElementById(parent);
    if (!parent) throw new Error('pocabinet/dialogue: parent element is required');

    const root = document.createElement('div');
    root.className = 'pocabinet-dialogue';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const nameEl = document.createElement('div');
    nameEl.className = 'pocabinet-dialogue__name';
    nameEl.textContent = OFFICIAL_DISPLAY_NAMES[officialId] || officialId || '';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'pocabinet-dialogue__body';

    root.appendChild(nameEl);
    root.appendChild(bodyEl);
    parent.appendChild(root);

    return new DialogueHandle(root, nameEl, bodyEl);
}

export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

/** Show a line on the bubble; facade for window.PoCabinet.showDialogue. */
export function show(handle, text, durationMs) {
    if (!handle) return;
    handle.show(text, durationMs);
}

/** Hide the bubble immediately; facade for window.PoCabinet.hideDialogue. */
export function hide(handle) {
    if (!handle) return;
    handle.hide();
}

// Each official's radio voice (2026-09-29): the browser's own speech synthesis — free,
// offline, no audio assets — with a per-official pick among the installed English
// voices plus pitch and rate, so four officials sound like four people even where a
// device has only one voice. speechSynthesis plays straight to the output device, not
// through audio.js's graph, so the master volume is applied per utterance here.
const VOICE = Object.freeze({
    'sean-s': { pick: 0, pitch: 1.15, rate: 1.18 },
    'steve-b': { pick: 1, pitch: 0.8, rate: 0.95 },
    'bill-b': { pick: 2, pitch: 0.7, rate: 1.02 },
    'mike-p': { pick: 3, pitch: 1.0, rate: 0.9 },
});

/** Say `text` in `officialId`'s voice, unless muted or voices are off. Interrupts the last line. */
export function speak(officialId, text) {
    try {
        const synth = window.speechSynthesis;
        const s = currentSettings();
        if (!synth || !text || s.muted || s.voices === false || !(s.masterVolume > 0)) return;
        const v = VOICE[officialId] || VOICE['mike-p'];
        const english = synth.getVoices().filter(x => /^en(-|_|$)/i.test(x.lang));
        const u = new SpeechSynthesisUtterance(text);
        if (english.length) u.voice = english[v.pick % english.length];
        u.pitch = v.pitch;
        u.rate = v.rate;
        u.volume = Math.min(1, Math.max(0, s.masterVolume));
        synth.cancel();
        synth.speak(u);
    } catch { /* voices are flavour */ }
}

export function officialName(officialId) {
    return OFFICIAL_DISPLAY_NAMES[officialId] || officialId || '';
}