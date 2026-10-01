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

export function officialName(officialId) {
    return OFFICIAL_DISPLAY_NAMES[officialId] || officialId || '';
}