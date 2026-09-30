// news.js — the "Breaking News" result package.
//
// A cable-news lower third over the result frame: a LIVE bug, a BREAKING NEWS tag,
// a headline written from the fight that just happened, a "popular vote" bar that
// is really the hits-landed split, and a ticker crawling the scorecard. It is the
// presidents' fight, so the result reads as a network calling a race.
//
// Engine DOM, like the banner and the splash, so it is styled from
// PoBrawlPage.razor.css through ::deep. Built once per engine, shown per result,
// hidden on the next countdown. Only the clip button takes pointer events.
//
// Headlines are picked with the engine's seeded RNG, so a demo replay tells the
// same story twice.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class NewsDesk {
  constructor(container, { onSaveClip, demo = false } = {}) {
    const el = document.createElement('div');
    el.className = demo ? 'pb-news pb-news--demo' : 'pb-news';
    // Not a live region: the page's shell already announces every result.
    el.innerHTML = `
      <div class="pb-news__bug"><span class="pb-news__live">LIVE</span><span class="pb-news__net">PBN</span></div>
      <div class="pb-news__vote" aria-hidden="true">
        <div class="pb-news__vote-head">POPULAR VOTE <small>hits landed</small></div>
        <div class="pb-news__vote-row">
          <span class="pb-news__vote-l"></span>
          <span class="pb-news__vote-bar"><span class="pb-news__vote-fill"></span></span>
          <span class="pb-news__vote-r"></span>
        </div>
      </div>
      <div class="pb-news__lower">
        <div class="pb-news__tag">BREAKING NEWS</div>
        <div class="pb-news__headline"></div>
        <div class="pb-news__ticker" aria-hidden="true"><div class="pb-news__track"></div></div>
      </div>
      <button type="button" class="pb-news__clip" hidden>🎬 Save KO clip</button>`;
    container.appendChild(el);
    this.el = el;
    this.clipBtn = el.querySelector('.pb-news__clip');
    this.clipBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.clipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      onSaveClip?.();
    });
    // A clicked button would keep focus, and the fight reads Space/Enter off
    // window — same reason the page's own tools preventDefault on mousedown.
    this.clipBtn.addEventListener('mousedown', (e) => e.preventDefault());
  }

  /**
   * @param {object} r
   * @param {string} r.p1 @param {string} r.p2 display names
   * @param {number} r.winner 0 draw, 1, 2
   * @param {boolean} r.ko knockout (vs decision at the bell)
   * @param {number} r.seconds clock at the finish
   * @param {{hits:number,blocks:number,bestCombo:number,biggestHit:number}[]} r.stats
   * @param {() => number} rand seeded 0..1
   */
  show(r, rand) {
    const [a, b] = [r.p1.toUpperCase(), r.p2.toUpperCase()];
    const w = r.winner === 1 ? a : r.winner === 2 ? b : null;
    const l = r.winner === 1 ? b : r.winner === 2 ? a : null;
    const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
    const mmss = `${Math.floor(r.seconds / 60)}:${String(Math.floor(r.seconds % 60)).padStart(2, '0')}`;
    const [s1, s2] = r.stats;
    const total = Math.max(1, s1.hits + s2.hits);
    const share1 = Math.round((s1.hits / total) * 100);
    const landslide = Math.abs(share1 - 50) >= 20;

    let headline;
    if (!w) {
      headline = pick([
        'TOO CLOSE TO CALL — RECOUNT DEMANDED',
        `${a} AND ${b} DEADLOCKED AT THE BELL`,
        'NO WINNER DECLARED — BOTH CAMPS CLAIM VICTORY',
      ]);
    } else if (r.ko) {
      headline = pick([
        `SHOCK KO: ${l} FLOORED BY ${w} AT ${mmss}`,
        `${w} KNOCKS OUT ${l} — CROWD ERUPTS`,
        `${l} DOWN AND OUT. ${w} DECLARES VICTORY`,
        landslide ? `LANDSLIDE: ${w} BURIES ${l}` : `${w} EDGES A BRUTAL ONE OVER ${l}`,
      ]);
    } else {
      headline = pick([
        `${w} WINS ON THE CARDS OVER ${l}`,
        `JUDGES CALL IT FOR ${w}`,
        `${l} CONCEDES — ${w} TAKES THE DECISION`,
      ]);
    }

    const items = [
      `${a} ${s1.hits} HITS`, `${b} ${s2.hits} HITS`,
      `BEST COMBO ${Math.max(s1.bestCombo, s2.bestCombo)}`,
      `BIGGEST HIT ${Math.round(Math.max(s1.biggestHit, s2.biggestHit))}`,
      `BLOCKS ${s1.blocks}–${s2.blocks}`,
      r.ko ? `KO AT ${mmss}` : 'WENT THE DISTANCE',
      w ? `${w} CAMP "NOT SURPRISED"` : 'BOTH CORNERS FILE PROTESTS',
      'MORE AFTER THE BREAK',
    ];
    // Twice over, so the CSS crawl can loop at -50% with no visible seam.
    const line = items.map((s) => `<span>${esc(s)}</span>`).join('<i>◆</i>');
    this.el.querySelector('.pb-news__track').innerHTML = `${line}<i>◆</i>${line}<i>◆</i>`;
    this.el.querySelector('.pb-news__headline').textContent = headline;
    this.el.querySelector('.pb-news__vote-l').textContent = `${a} ${share1}%`;
    this.el.querySelector('.pb-news__vote-r').textContent = `${100 - share1}% ${b}`;
    this.el.querySelector('.pb-news__vote-fill').style.setProperty('--share', `${share1}%`);
    this.clipBtn.hidden = true;
    this.el.classList.remove('pb-news--on');
    void this.el.offsetWidth; // restart the slide-in
    this.el.classList.add('pb-news--on');
  }

  showClipButton(on) {
    this.clipBtn.hidden = !on;
  }

  hide() {
    this.el.classList.remove('pb-news--on');
    this.clipBtn.hidden = true;
  }

  dispose() {
    this.el.remove();
  }
}
