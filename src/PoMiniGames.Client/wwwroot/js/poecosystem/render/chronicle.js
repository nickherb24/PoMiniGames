// chronicle.js — chronicle moments (GFX pass 2, idea 7).
//
// The island's landmarks (an extinction, a new age of the tribe, a treaty, a new variety,
// an eruption, an outbreak) used to arrive as one more line in the event log. This module
// gives each one a beat of cinema: letterbox bars slide in, a serif title card names the
// moment ("Year 14 · Extinction — Wolves are extinct"), and when it is done the card is
// FILED — a same-document View Transition morphs it into the HUD's status chip, which is
// where the dashboard and its Timeline are one click away. The renderer and the score are
// told separately (index.js), so the camera, the colour and the music land on the same
// moment as the card.
//
// It is DOM owned by the engine, parented to the world host (a Blazor element that renders
// no children of its own, the same arrangement the canvas already uses), so no component
// re-render can clobber it. pointer-events are off throughout: it is a caption, never a
// control, and it must not eat a click meant for the island.
//
// Throttled: one card at a time, a floor between cards, and only the most notable pending
// landmark survives the wait. A century of history must not become a slideshow.
const MIN_GAP_MS = 30000;
const SHOW_MS = 5200;
const PRIORITY = { extinction: 6, variety: 4, tech: 5, treaty: 3, diplomacy: 3, eruption: 4, outbreak: 4, weather: 1 };
const KICKER = {
  extinction: 'Extinction', variety: 'A new variety', tech: 'A new age', treaty: 'Treaty',
  eruption: 'Eruption', outbreak: 'Outbreak', weather: 'Weather',
};

/** Is this sim event a landmark worth a card? Mirrors world.js LANDMARK_KINDS. */
export function isChronicleEvent(ev) {
  if (!ev || !PRIORITY[ev.kind]) return false;
  if (ev.kind === 'weather') return ev.weather === 2 || ev.weather === 3;
  if (ev.kind === 'diplomacy') return ev.action === 'war' || ev.action === 'peace';
  return true;
}

// THE TICKER. Everything smaller than a landmark — a field note, a legend the Herald
// wrote, a decade turning, a pact — queues here rather than becoming a toast on top of the
// card above for the same moment: one quiet line under the status chip at a time, a few
// seconds each. Toasts are kept for what the viewer asked to be told about (a watched creature, an alert of their own, something they just did).
const TICK_MS = 4600;
const TICK_GAP_MS = 350;
const TICK_QUEUE = 6;

export function createChronicle(host, { reducedMotion = () => false } = {}) {
  if (!host || typeof document === 'undefined') return { show() {}, ticker() {}, dispose() {} };

  const root = document.createElement('div');
  root.className = 'poeco-cine';
  root.setAttribute('aria-hidden', 'true');   // the event log already announces it
  root.innerHTML = `
    <div class="poeco-cine-bar poeco-cine-bar--top"></div>
    <div class="poeco-cine-bar poeco-cine-bar--bottom"></div>
    <div class="poeco-cine-card">
      <p class="poeco-cine-kicker"></p>
      <p class="poeco-cine-title"></p>
    </div>`;
  host.appendChild(root);
  const card = root.querySelector('.poeco-cine-card');
  const kicker = root.querySelector('.poeco-cine-kicker');
  const title = root.querySelector('.poeco-cine-title');

  let lastAt = -Infinity;
  let pending = null;
  let busy = false;
  let timers = [];
  let disposed = false;

  let waitTimer = 0;          // the one "present the pending card when the gap is up" timer
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers = timers.filter(t => t !== id); if (!disposed) fn(); }, ms);
    timers.push(id);
    return id;
  };

  function present(item) {
    busy = true;
    lastAt = performance.now();
    root.dataset.kind = item.ev.kind;
    kicker.textContent = `Year ${item.year} · ${KICKER[item.ev.kind] ?? (item.ev.action === 'war' ? 'War' : 'Peace')}`;
    title.textContent = item.ev.text ?? '';
    card.style.viewTransitionName = '';
    root.classList.remove('is-filing');
    // Reflow between the class flips so the entrance animation restarts every time.
    void root.offsetWidth;
    root.classList.add('is-on');
    later(file, SHOW_MS);
  }

  function finish() {
    root.classList.remove('is-on', 'is-filing');
    card.style.viewTransitionName = '';
    busy = false;
    if (pending && !disposed) {
      const next = pending; pending = null;
      later(() => present(next), Math.max(0, MIN_GAP_MS - (performance.now() - lastAt)));
    }
  }

  /** Morph the card into the status chip, where the Timeline lives; plain fade otherwise. */
  function file() {
    const chip = document.querySelector('.poeco-chip');
    const canMorph = chip && typeof document.startViewTransition === 'function' && !reducedMotion()
      && chip.getClientRects().length > 0;
    if (!canMorph) { root.classList.add('is-filing'); later(finish, 600); return; }
    const docEl = document.documentElement;
    // Only the card and the chip take part: with the root excluded, the live canvas keeps
    // rendering through the transition instead of freezing into a cross-faded snapshot.
    const prevRootName = docEl.style.viewTransitionName;
    docEl.style.viewTransitionName = 'none';
    card.style.viewTransitionName = 'poeco-chronicle';
    let vt;
    try {
      vt = document.startViewTransition(() => {
        card.style.viewTransitionName = '';
        root.classList.remove('is-on');
        chip.style.viewTransitionName = 'poeco-chronicle';
      });
    } catch {
      docEl.style.viewTransitionName = prevRootName;
      root.classList.add('is-filing'); later(finish, 600); return;
    }
    const done = () => {
      chip.style.viewTransitionName = '';
      docEl.style.viewTransitionName = prevRootName;
      chip.classList.add('poeco-chip--news');
      later(() => chip.classList.remove('poeco-chip--news'), 2400);
      finish();
    };
    vt.finished.then(done, done);
  }

  // The ticker is a live region: the lines it carries were announced as toasts before.
  const tick = document.createElement('p');
  tick.className = 'poeco-ticker';
  tick.setAttribute('role', 'status');
  tick.hidden = true;
  host.appendChild(tick);
  const tickQueue = [];
  let ticking = false;
  function nextTick() {
    const text = tickQueue.shift();
    if (text === undefined) { ticking = false; tick.hidden = true; return; }
    ticking = true;
    tick.textContent = text;
    tick.hidden = false;
    tick.classList.remove('is-on');
    void tick.offsetWidth;
    tick.classList.add('is-on');
    later(() => { tick.classList.remove('is-on'); later(nextTick, TICK_GAP_MS); }, TICK_MS);
  }

  return {
    /** A quiet line under the status chip. Oldest dropped when the queue is full. */
    ticker(text) {
      if (disposed || typeof text !== 'string' || !text.trim()) return;
      if (tickQueue.length >= TICK_QUEUE) tickQueue.shift();
      tickQueue.push(text.trim().slice(0, 180));
      if (!ticking) nextTick();
    },
    /** A landmark event; `year` is the island's current year. */
    show(ev, year) {
      if (disposed || !isChronicleEvent(ev)) return;
      const item = { ev, year: year ?? 0, p: PRIORITY[ev.kind] ?? 1 };
      const wait = MIN_GAP_MS - (performance.now() - lastAt);
      if (busy || wait > 0) {
        if (!pending || item.p >= pending.p) pending = item;
        if (!busy && !waitTimer) {
          waitTimer = later(() => { waitTimer = 0; if (pending && !busy) { const next = pending; pending = null; present(next); } }, Math.max(0, wait));
        }
        return;
      }
      present(item);
    },
    get busy() { return busy; },
    dispose() {
      disposed = true;
      for (const id of timers) clearTimeout(id);
      timers = [];
      root.remove();
      tick.remove();
    },
  };
}
