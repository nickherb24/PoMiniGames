// gl-fps.js — global requestAnimationFrame-driven FPS sampler.
// Drives the top-nav <FpsCounter /> on every page. Self-stops on `beforeunload`
// so navigating away doesn't leak a callback.
//
// Single-instance, but *last writer wins*: `start` adopts the newest ref rather
// than no-op'ing on a second call, and `stop(token)` only tears the loop down if
// the caller still owns it. The badge is unconditional, and the
// app swaps whole layouts (MainLayout ↔ EmptyLayout ↔ BareLayout) on
// navigation — each carrying its own <FpsCounter />. With a first-writer-wins
// start and an unconditional stop, an incoming counter that mounted before the
// outgoing one disposed would be silently killed by its predecessor's stop and
// the badge would stay blank until a full reload.

(function () {
  let raf = 0;
  let last = 0;
  let dotnetRef = null;
  let owner = 0;

  function tick(now) {
    if (!dotnetRef) return;
    if (last) {
      const delta = now - last;
      // Ignore giant gaps (tab was hidden) so the counter doesn't drop to 0.
      if (delta < 1000) {
        try { dotnetRef.invokeMethodAsync('OnTick', delta); } catch { /* component gone */ }
      }
    }
    last = now;
    raf = requestAnimationFrame(tick);
  }

  window.glFps = {
    start(ref, token) {
      dotnetRef = ref;
      owner = token;
      last = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    // token omitted (or 0) means "stop regardless" — used by beforeunload.
    stop(token) {
      if (token && token !== owner) return;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      dotnetRef = null;
      owner = 0;
      last = 0;
    },
  };

  window.addEventListener('beforeunload', () => window.glFps.stop(0));
})();