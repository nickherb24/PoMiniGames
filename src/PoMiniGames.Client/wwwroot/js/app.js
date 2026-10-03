// View Transitions API + WebGL2 capability probe.
// Smooth page transitions for Chromium-based browsers; graceful
// progressive enhancement for everyone else (no-op fall-through).
(function () {
  'use strict';

  // ----- 1. View Transitions for SPA navigations -----
  // Intercept any in-page link click and, when the browser supports the
  // View Transitions API, wrap the navigation in startViewTransition so
  // the page cross-fades instead of hard-cutting. Falls back to a normal
  // navigation in unsupported browsers.
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href^="/"]');
    if (!link) return;
    // Only the hub's game cards take this path. It is a full document load (that is
    // what the card-to-title morph needs), and for every other link in the app that
    // meant rebooting the whole WASM runtime to change page. Those are left to the
    // Blazor router, which swaps the page in place.
    if (!link.closest('.home-card')) return;
    if (link.target && link.target !== '_self') return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!document.startViewTransition) return;
    e.preventDefault();
    var href = link.getAttribute('href');
    // Card-to-game morph: name the pressed hub card's heading and leave its icon and title
    // for the next document's boot splash (index.html #po-boot-hero), which carries the same
    // view-transition-name, so the card glides up into the loading game's title.
    var card = link.closest('.home-card');
    var head = card && card.querySelector('.home-card-head');
    if (head) {
      try {
        sessionStorage.setItem('poHero', JSON.stringify({
          path: href,
          icon: (head.querySelector('.home-card-icon') || {}).textContent || '',
          title: (head.querySelector('.home-card-title') || {}).textContent || ''
        }));
        head.style.viewTransitionName = 'po-hero';
      } catch (_) { /* storage blocked: the plain cross-fade */ }
    }
    var transition = document.startViewTransition(function () {
      window.location.href = href;
    });
    // The page unloads before the transition can finish, so its promises reject.
    // That is the expected end of this transition, not an error.
    var ignore = function () {};
    transition.ready.catch(ignore);
    transition.finished.catch(ignore);
    transition.updateCallbackDone.catch(ignore);
  });

  // ----- 2. WebGL2 + device capability probe (callable from Blazor) -----
  // Gates the home page ambient particle field. Skips WebGL entirely on
  // low-memory devices, when prefers-reduced-motion is set, or when WebGL2
  // is unavailable. Returns a boolean — caller falls back to the CSS gradient.
  window.probeWebGL2 = function () {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return false;
      }
      // Mobile-portrait battery guard: the ambient particle field is purely
      // decorative chrome behind the game list. On portrait phones it's GPU/battery
      // cost with little payoff, so fall back to the (already frozen <=768px) CSS
      // gradient there instead of waking the GPU render loop.
      if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
        return false;
      }
      var mem = navigator.deviceMemory || 4;
      if (mem < 4) return false;
      var c = document.createElement('canvas');
      var gl = c.getContext && c.getContext('webgl2');
      if (!gl) return false;
      // Hand the probe's context straight back: the browser caps live contexts.
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (_) {
      return false;
    }
  };

})();

