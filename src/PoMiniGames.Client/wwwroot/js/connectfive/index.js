// connectfive/index.js — physics-driven disc drop + chain reaction for ConnectFive.
//
// WHY THIS EXISTS
// The chip-drop audio + impact cue are separate; the visual drop would otherwise
// be a CSS keyframe (cf-slide-down). That keyframe overshoots and squashes — it
// reads as "physical" for a single disc — but it drops the same distance into
// every row, so a disc landing on a tall pile falls through the discs already
// there. matter.js gives the new disc a real collision body inside a real
// column, so it falls exactly as far as the pile leaves it and thumps onto the
// stack.
//
// THE COLUMN IS THE MODEL. Each drop builds three static bodies
// around the falling disc: two walls on the column's own boundaries and one
// support plank whose top face is the top of the pile. A single rigid body
// cannot tell a plank from the discs it stands for — but it very much can tell
// a FLAT surface from a round one, which per-disc circular "ghost" bodies would
// be. A circle resting on a circle is unstable equilibrium, so with no wall to
// stop it the disc rolls off the pile and drifts across the board (measured:
// landing in column 3, coming to rest at column 3.54, with its real cell still
// hidden behind it). Walls + a flat pile top is the whole fix.
//
// QUALITY GATES (same shape as impactBus.js / glassFx.js):
//   • reduced motion      → fall back to the keyframe, never spawn the engine
//   • low quality tier    → fall back to the keyframe
//   • matter.js not on window (CDN blocked / offline)
//                          → window.PoConnectFive is never set; the Blazor
//                            call below the page makes hits a thrown JS error
//                            which the page catches and the keyframe runs.
//   • any uncaught throw during the drop
//                          → cancelDrop() reveals the static disc on the next
//                            frame so a mid-drop failure never leaves the
//                            board blank.
//
// BUNDLE IMPACT: zero. matter.min.js loads from the jsdelivr CDN as a
// classic-script dependency injected by engineLoader.js; the trimmed WASM
// bundle does not include it. The cost is paid only by sessions that actually
// visit /connectfive.

(function () {
    'use strict';

    // matter.js exposes itself on `window.Matter` when loaded as a classic
    // script. If the CDN injection failed, we return early and never publish
    // `window.PoConnectFive` — the page's Blazor JSInterop call then throws,
    // the page catches, and the existing CSS keyframe runs as it always did.
    const Matter = window.Matter;
    if (!Matter) {
        console.warn('PoConnectFive: matter.js not on window; physics drop disabled, CSS keyframe will run.');
        return;
    }

    // ─── Module state ─────────────────────────────────────────────────────
    /** @type {Matter.Engine|null} Created once on init(), lives until reset(). */
    let _engine = null;
    /** @type {HTMLElement|null} The .cf-board element, measured on init(). */
    let _board = null;
    /** @type {object|null} Measured grid geometry — see measureBoard(). */
    let _layout = null;
    /** @type {{ body: Matter.Body, statics: Matter.Body[], clone: HTMLElement,
        col: number, targetRow: number, color: string,
        cellEl: HTMLElement|null, hiddenEl: HTMLElement|null }|null} */
    let _drop = null;
    // There is no shared wall set. The floor a disc lands on depends on
    // the target row, so it is built per drop together with the column walls —
    // see spawnColumnBodies(). A board-wide floor pinned to row 8 would only be
    // correct for the first disc in a column.
    let _active = false;
    let _rafId = 0;
    /** Frame-counted stillness: how many consecutive frames the disc has been slow. */
    let _stillFrames = 0;
    /** rAF timestamp from last step; used for delta integration. */
    let _lastFrame = 0;
    /** Watchdog id. A disc that never satisfies isAtRest() (the tab was throttled,
        the board was resized mid-flight) would leave its cell hidden forever. The
        drop is force-settled after this long no matter what the physics thinks. */
    let _watchdogId = 0;
    /** Force-settle deadline. Deliberately BELOW the 850 ms demo cadence in
        ConnectFivePage.RunDemoLoop: a drop that overstays must be finalized by
        its own watchdog, not cancelled by the next drop, or the disc it was
        delivering is revealed mid-flight while a new clone is already falling. */
    const DROP_TIMEOUT_MS = 800;
    /** Rest-detection position: assigned in dropDisc() and read by the step loop.
        They must be declared — under strict mode an undeclared assignment throws
        ReferenceError and dropDisc() would fall back to the CSS keyframe. */
    let _restX = 0;
    let _restY = 0;

    // ─── Quality gates ────────────────────────────────────────────────────
    function motionReduced() {
        try {
            if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch { return false; }
    }
    function tier() {
        try { return document.documentElement.getAttribute('data-gfx') || 'high'; }
        catch { return 'high'; }
    }
    function enabled() {
        if (motionReduced()) return false;
        if (tier() === 'low') return false;
        return true;
    }

    // ─── Measurement ──────────────────────────────────────────────────────
    /**
     * Measure the live grid. Reads --cf-cell (set by ConnectFivePage.razor.css
     * via `clamp(…)` on the viewport) and the board's bounding rect to get
     * viewport coordinates for each cell. The grid is 9x9 with `gap: 3px` and
     * `padding: 10px` on the board frame.
     */
    function measureBoard(boardEl) {
        _board = boardEl;
        const cellEls = _board.querySelectorAll('.cf-cell');
        if (cellEls.length < 81) return false;

        // ── Measure the CELLS, never the CSS variable ────────────────────
        // Parsing `--cf-cell` with
        //     parseFloat(getComputedStyle(board).getPropertyValue('--cf-cell'))
        // does not work: that property is declared as
        //     clamp(28px, min(calc((100dvh - 310px)/9), calc((100dvw - 100px)/9)), 84px)
        // and getPropertyValue hands back a custom property's TOKENS, unresolved
        // — the literal "clamp(28px, min(calc(..." string. parseFloat of that is
        // NaN, so a fallback would silently take over and the whole grid would be
        // modelled at the wrong cell size. A 9.55px error per row compounds to
        // ~76px by row 8, i.e. MORE THAN A FULL ROW: discs stop in the wrong row,
        // and it is invisible at any viewport where the clamp happens to land
        // near the fallback.
        //
        // The cells are real laid-out elements, so their rects are the ground
        // truth for size, pitch and origin at once — no variable parsing, no
        // assumptions about gap or padding, and correct at every viewport.
        const c0 = cellEls[0].getBoundingClientRect();
        const c1 = cellEls[1].getBoundingClientRect();       // next column
        const c9 = cellEls[9].getBoundingClientRect();       // next row
        const cLast = cellEls[80].getBoundingClientRect();   // row 8, col 8
        const r = _board.getBoundingClientRect();

        const cellSize = c0.width;
        const strideX = (c1.left - c0.left) || cellSize;
        const strideY = (c9.top - c0.top) || cellSize;
        const gap = strideY - cellSize;
        const gridLeft = c0.left;
        const gridTop = c0.top;
        const gridRight = cLast.right;
        const gridBottom = cLast.bottom;
        const stride = strideY;
        const paddingLeft = gridLeft - r.left;
        const paddingTop = gridTop - r.top;
        const paddingRight = r.right - gridRight;
        const paddingBottom = r.bottom - gridBottom;

        // Pre-compute cell centres. Every matter.js body — the falling disc, the
        // column walls, the pile plank — is placed off these.
        const cells = [];
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                cells.push({
                    row, col,
                    cx: gridLeft + col * strideX + cellSize / 2,
                    cy: gridTop + row * strideY + cellSize / 2,
                });
            }
        }
        // ── One radius, because the disc collides at the size it is drawn ──
        // `.cf-cell .piece` is 84% of the cell, so 0.42 * cellSize.
        //
        // Nothing stacks circles — the pile is one flat plank whose top face is
        // placed off cellCy() — so the stacking pitch does not depend on the
        // radius at all, and a body fatter than its own sprite would only wedge the
        // disc against the column walls. The drawn radius is the honest one.
        const visR = cellSize * 0.42;
        const physR = visR;
        _layout = {
            cellSize, gap, paddingLeft, paddingTop, paddingRight, paddingBottom,
            gridLeft, gridTop, gridRight, gridBottom, stride, strideX, strideY,
            cells, visR, physR,
        };
        return true;
    }

    /** Viewport y of the centre of `row` — the single source of truth for where
        a disc in that row belongs, shared by the pile plank and the rest target
        so they cannot disagree. */
    function cellCy(row) {
        return _layout.gridTop + row * _layout.strideY + _layout.cellSize / 2;
    }

    /** Viewport x of the centre of `col`. */
    function cellCx(col) {
        return _layout.gridLeft + col * _layout.strideX + _layout.cellSize / 2;
    }

    /** The .cf-cell element a drop is landing in (cells render row-major). */
    function cellAt(row, col) {
        if (!_board) return null;
        const cells = _board.querySelectorAll('.cf-cell');
        return cells.length < 81 ? null : cells[row * 9 + col];
    }

    // ─── Engine + walls ───────────────────────────────────────────────────
    function buildEngine() {
        // Gravity is tuned so a full-height drop (nine rows) lands in ~450 ms,
        // comfortably inside both the 0.55 s CSS keyframe this replaces and the
        // 850 ms demo cadence. At the old 1.55 the same drop took past 1 s and
        // the next demo move cancelled it in mid-air.
        _engine = Matter.Engine.create({ gravity: { x: 0, y: 5 } });
    }

    // ─── Per-drop bodies ──────────────────────────────────────────────────
    /**
     * Build the three static bodies that make a column a column, for this drop:
     * the two walls on its own boundaries and the plank the pile presents.
     *
     * The plank's top face sits at cellCy(targetRow) + physR, so a disc resting
     * on it has its centre exactly on the target cell's centre — the same place
     * the static disc is drawn, which is why restYForRow() is just cellCy().
     * targetRow already encodes where the pile ends (the caller derives it from
     * the board model), so no DOM scan for existing discs is needed and none of
     * this depends on Blazor having painted the new piece yet.
     *
     * The walls are what keep a disc in the column it was dropped into. Without
     * them the disc wandered off the pile and settled between columns, or over a
     * neighbouring column where there is nothing to catch it at all.
     */
    function spawnColumnBodies(col, targetRow) {
        const l = _layout;
        const r = l.physR;
        const T = 200;            // wall thickness; only the inner face matters
        const half = T / 2;
        const cx = cellCx(col);
        const halfCol = l.strideX / 2;
        // Walls span from above the spawn height down past the bottom row, so a
        // disc is inside the column from the instant it exists.
        const top = spawnY() - l.strideY;
        const height = (l.gridBottom + T) - top;
        // Bodies are positioned by their CENTRE, so every surface is offset by
        // half the thickness. Passing the surface coordinate directly would put each
        // wall 100px into the playfield and make the disc stop a row high and then jump.
        return [
            Matter.Bodies.rectangle(cx, cellCy(targetRow) + r + half, l.strideX, T,
                { isStatic: true, render: { visible: false } }),
            Matter.Bodies.rectangle(cx - halfCol - half, top + height / 2, T, height,
                { isStatic: true, render: { visible: false } }),
            Matter.Bodies.rectangle(cx + halfCol + half, top + height / 2, T, height,
                { isStatic: true, render: { visible: false } }),
        ];
    }

    /** Viewport y the disc is released from — a constant distance above row 0, so
        every drop reads as the same throw regardless of how full the column is. */
    function spawnY() {
        return cellCy(0) - _layout.strideY * 1.6;
    }

    /** Spawn the dynamic body + the floating clone that mirrors its position. */
    function spawnFallingDisc(col, color) {
        const l = _layout;
        const r = l.physR;      // collision radius (grid pitch)
        const vr = l.visR;      // drawn radius (matches the CSS disc)
        // Spawn JUST ABOVE the board top. The exact value doesn't matter as
        // long as it's clearly above; matter.js integrates gravity from here.
        const cx = cellCx(col);
        const cy = spawnY();

        // Floating clone. position: fixed so it can move with the body without
        // affecting the grid layout. The clone's class matches the existing
        // .piece / .red-piece / .yellow-piece styling — no new CSS needed.
        const clone = document.createElement('div');
        clone.className = 'piece ' + (color === 'red' ? 'red-piece' : 'yellow-piece') + ' cf-physics-clone';
        // Sized from the VISUAL radius: the body is deliberately fatter than
        // the disc (see measureBoard), and drawing the clone at physR would
        // make the falling piece visibly larger than every settled one.
        clone.style.width = (vr * 2) + 'px';
        clone.style.height = (vr * 2) + 'px';
        clone.style.position = 'fixed';
        clone.style.left = '0';
        clone.style.top = '0';
        clone.style.zIndex = '5';
        clone.style.pointerEvents = 'none';
        clone.style.willChange = 'transform';
        clone.style.transform = `translate3d(${cx - vr}px, ${cy - vr}px, 0)`;
        document.body.appendChild(clone);

        // Dynamic body. Restitution is intentionally low — the disc settles
        // rather than ricocheting. FrictionAir drags it slightly so a vertical
        // fall does not run away from the framerate budget.
        const body = Matter.Bodies.circle(cx, cy, r, {
            restitution: 0.18,
            friction: 0.05,
            // Air drag is deliberately slight: enough to keep the settle calm,
            // not enough to make a nine-row drop float. At 0.012 the disc lost
            // most of the gravity increase above.
            frictionAir: 0.004,
            density: 0.0022,
            render: { visible: false },
        });
        // A tiny lateral kick keeps the column entry visually interesting (the
        // disc never falls perfectly straight); zero on average, and the column
        // walls bound where it can end up, so it cannot compound into drift.
        Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 0.4, y: 0 });
        return { body, clone };
    }

    // ─── Settle detection ─────────────────────────────────────────────────
    /**
     * Where should the disc centre end up once at rest? The centre of its own
     * cell — the same place the static disc will be drawn.
     *
     * This is the same number spawnColumnBodies() places the pile plank against,
     * so the physics and the grid cannot disagree about where a row is. Earlier
     * revisions derived a separate answer here (gridBottom - r for the bottom
     * row, lowerDiscCentre - 2r elsewhere); the disc then rested off-grid, the
     * reveal snapped it into place, and isAtRest() was testing against a y the
     * disc would never actually reach.
     */
    function restYForRow(targetRow) {
        return cellCy(targetRow);
    }

    /**
     * A drop is "settled" when the disc has been slow AND near its rest y for
     * a few consecutive frames. Frame-counting defeats the "false rest" case
     * where a single collision frame happens to look like stillness.
     */
    function isAtRest(body, restY) {
        // Read _layout lazily — at module init time it is still null. The
        // layout is fixed for the engine's lifetime, but only after init().
        const slow = Math.abs(body.velocity.y) < 0.6 && Math.abs(body.velocity.x) < 0.8;
        const nearY = Math.abs(body.position.y - restY) < _layout.cellSize * 0.12;
        // The column walls leave exactly (strideX/2 - physR) of lateral play, so
        // this can only fail while the disc is still bouncing off one of them —
        // never because it has wandered into another column, which is what the
        // old fixed 0.08*cellSize window could not distinguish.
        const nearX = Math.abs(body.position.x - _restX) < (_layout.strideX / 2 - _layout.physR) + 1;
        if (slow && nearY && nearX) { _stillFrames++; return _stillFrames >= 4; }
        _stillFrames = 0;
        return false;
    }
    // `_restX` / `_restY` are updated by dropDisc() before the rAF loop is
    // asked to settle-detect. Cached here so the closure doesn't need to read
    // _drop every frame.

    // ─── rAF loop ─────────────────────────────────────────────────────────
    function step(now) {
        if (!_engine) return;
        // Cap delta so a backgrounded tab returning mid-physics does not
        // dump 30+ steps into the engine in one frame.
        if (!_drop) { _lastFrame = 0; _rafId = requestAnimationFrame(step); return; }
        const delta = Math.min(32, _lastFrame ? now - _lastFrame : 16.67);
        _lastFrame = now;
        Matter.Engine.update(_engine, delta);

        {
            const b = _drop.body;
            // Draw at the VISUAL radius, not the body's collision radius.
            const r = _layout.visR;
            // Write the body position into the clone's transform each frame.
            // translate3d puts the clone on its own compositor layer so this
            // is a GPU-side move — no layout, no paint.
            if (_drop.clone) {
                _drop.clone.style.transform = `translate3d(${b.position.x - r}px, ${b.position.y - r}px, 0)`;
            }
            if (isAtRest(b, _restY)) finalizeDrop();
        }
        _rafId = requestAnimationFrame(step);
    }

    function finalizeDrop() {
        if (!_drop) return;
        const drop = _drop;
        try {
            Matter.World.remove(_engine.world, [drop.body, ...drop.statics]);
        } catch { /* engine may have been torn down already */ }
        if (drop.clone && drop.clone.parentNode) drop.clone.parentNode.removeChild(drop.clone);
        _drop = null;
        _stillFrames = 0;
        clearWatchdog();
        revealCell(drop);
        // The landing event is observable to anyone else who wants to
        // hook into it (audio syncing, particles, scoreboard shake). The page
        // already fires the chip-drop audio from Blazor — kept there so the
        // timing is deterministic even when matter.js never loads.
        try {
            window.dispatchEvent(new CustomEvent('po-cf-drop-landed', {
                detail: { col: drop.col, row: drop.targetRow, color: drop.color }
            }));
        } catch { /* CustomEvent unavailable on a very old browser */ }
    }

    /**
     * Hide the static disc of the cell this drop is landing in, so the player
     * sees only the falling clone.
     *
     * Applied as an INLINE style on the disc, and RETRIED until the disc shows
     * up. Both halves of that matter:
     *   • The disc does not exist yet when dropDisc() runs — the caller places
     *     the piece in the board model and only then re-renders — so the hide
     *     has to wait for Blazor to paint it. Waiting a single frame and giving
     *     up would, whenever the render landed a frame later, leave the cell
     *     with its static disc AND a falling clone: "two discs at once".
     *   • The cell's `class` attribute is Blazor-managed (piece colour, win
     *     cascade, disabled), so a class added here is wiped by the very next
     *     diff. Blazor never sets a `style` attribute on the disc, so it leaves
     *     an inline one alone.
     * Every failure path clears it, and the watchdog guarantees one runs.
     */
    function hideCell(drop) {
        if (!drop || !drop.cellEl) return;
        const deadline = performance.now() + DROP_TIMEOUT_MS;
        const attempt = () => {
            // A drop that already settled (or was cancelled) must not hide the
            // disc it just delivered.
            if (_drop !== drop) return;
            const disc = drop.cellEl.querySelector('.piece:not(.ghost-piece)');
            if (!disc) {
                if (performance.now() < deadline) requestAnimationFrame(attempt);
                return;
            }
            drop.hiddenEl = disc;
            disc.style.visibility = 'hidden';
            disc.style.animation = 'none';
        };
        requestAnimationFrame(attempt);
    }

    /**
     * Show the cell's static disc again, now that the clone has delivered it.
     *
     * `animation` stays pinned to none. Clearing it would hand the disc
     * back to `.cf-cell .piece { animation: cf-slide-down … }`, and because the
     * keyframe has been suppressed since the frame the disc was created, the browser
     * would start it HERE — so every move would play twice: the clone falls and
     * vanishes, then a second disc drops in from nine rows up. The physics flight IS
     * this disc's drop animation; there is nothing left for the keyframe to do.
     *
     * The element is re-queried rather than trusted: a Blazor diff between the
     * hide and the reveal can swap the span (ghost-piece → piece), which would
     * leave the inline hide on a detached node and a hidden disc on screen.
     */
    function revealCell(drop) {
        if (!drop) return;
        const live = drop.cellEl && drop.cellEl.querySelector('.piece:not(.ghost-piece)');
        for (const disc of new Set([drop.hiddenEl, live])) {
            if (!disc) continue;
            disc.style.visibility = '';
            disc.style.animation = 'none';
        }
    }

    /**
     * While physics owns the drop, `.cf-cell .piece`'s cf-slide-down keyframe is
     * suppressed board-wide, because the flight IS the animation. Without this
     * the disc Blazor has just rendered plays the keyframe for the frame or two
     * before hideCell() finds it — a disc flashing in at the top of the board
     * while an identical clone falls past it.
     *
     * It is a toggle, not a one-time flag, because `enabled()` can go false at
     * any moment: the adaptive quality tier drops `data-gfx` to `low` under load
     * and every later drop then falls through to the keyframe, which has to be
     * there when it does. dropDisc() sets it either way on every call.
     *
     * The class goes on the BOARD, whose class attribute is a static literal in
     * ConnectFivePage.razor and so is never re-emitted by a Blazor diff. (The
     * per-cell class is diff-managed, which is why the hide itself is an inline
     * style — see hideCell.)
     */
    function suppressKeyframe(on) {
        if (!_board) return;
        if (_board.classList.contains('cf-board--physics') === on) return;
        if (!on) {
            // Handing the keyframe back would restart it on every disc already
            // on the board. Retire them first — they are long since settled.
            for (const disc of _board.querySelectorAll('.cf-cell .piece:not(.ghost-piece)')) {
                disc.style.animation = 'none';
            }
        }
        _board.classList.toggle('cf-board--physics', on);
    }

    function clearWatchdog() {
        if (_watchdogId) { clearTimeout(_watchdogId); _watchdogId = 0; }
    }

    /** Force-settle a drop that outlived its welcome, so the disc can never stay
        hidden behind a clone that is still bouncing (or a rest test that will
        never pass). */
    function armWatchdog() {
        clearWatchdog();
        _watchdogId = setTimeout(() => {
            _watchdogId = 0;
            if (_drop) finalizeDrop();
        }, DROP_TIMEOUT_MS);
    }

    function cancelDrop() {
        // Reveal the static disc immediately on any failure path so a
        // mid-drop throw never leaves the cell visually blank.
        if (_drop) {
            try { Matter.World.remove(_engine.world, [_drop.body, ..._drop.statics]); }
            catch { /* engine may have been torn down already */ }
            if (_drop.clone && _drop.clone.parentNode) _drop.clone.parentNode.removeChild(_drop.clone);
            revealCell(_drop);
            _drop = null;
        }
        _stillFrames = 0;
        clearWatchdog();
    }

    /** Re-measure the grid and, if it has moved or resized, rebuild the static
        walls around it. Returns false if the board is not currently measurable
        (mid-render, or the page navigated away), in which case the caller falls
        back to the CSS keyframe rather than dropping into stale geometry. */
    function refreshLayout() {
        if (!_board || !_engine) return false;
        const prev = _layout;
        if (!measureBoard(_board)) { _layout = prev; return !!prev; }
        return true;
    }

    // ─── Public API ───────────────────────────────────────────────────────
    /**
     * One-time setup. Measures the board, builds the engine, starts the rAF
     * loop. Idempotent. Returns true if physics is now active.
     *
     * Accepts either a DOM element (from in-page script) or a CSS selector
     * (from Blazor's IJSRuntime, which marshalls values cleanly only as
     * primitives + strings). On Blazor's side the page passes ".cf-board".
     */
    function init(boardElOrSelector) {
        if (!enabled()) return false;
        if (_active) return true;
        const board = typeof boardElOrSelector === 'string'
            ? document.querySelector(boardElOrSelector)
            : boardElOrSelector;
        if (!board) return false;
        try {
            if (!measureBoard(board)) return false;
            buildEngine();
            _active = true;
            _lastFrame = 0;
            _rafId = requestAnimationFrame(step);
            return true;
        } catch (e) {
            console.warn('PoConnectFive.init failed:', e);
            _active = false;
            return false;
        }
    }

    /**
     * Drop a disc into a column. Returns true if physics took the drop;
     * false if the call should fall through to the CSS keyframe (engine not
     * available, reduced motion, etc.).
     */
    function dropDisc(col, targetRow, color) {
        const decline = () => { suppressKeyframe(false); return false; };
        if (!enabled() || !_active || !_layout || !_engine) return decline();
        if (typeof col !== 'number' || col < 0 || col > 8) return decline();
        if (typeof targetRow !== 'number' || targetRow < 0 || targetRow > 8) return decline();
        // Cancel any in-flight drop. Two simultaneous drops would compete for
        // the clone element; the caller is responsible for not double-tapping.
        if (_drop) cancelDrop();
        try {
            // Re-measure before every drop. --cf-cell is a clamp() over dvh/dvw,
            // so a rotate, a resize or the browser chrome collapsing changes the
            // cell size, and every static body below is placed off that geometry.
            // Cheap (81 rects the browser has already laid out) and it removes a
            // whole class of stale-layout bug.
            if (!refreshLayout()) return decline();
            suppressKeyframe(true);
            const statics = spawnColumnBodies(col, targetRow);
            const { body, clone } = spawnFallingDisc(col, color);
            Matter.World.add(_engine.world, [body, ...statics]);
            // Hide ONLY the cell being dropped into. A board-wide hide would
            // blank all 81 discs for the duration of the flight — in the
            // CPU-vs-CPU demo, where the next drop starts before the last one
            // settles, the board would be blank essentially always.
            // (suppressKeyframe above is board-wide by design: it suppresses
            // an ANIMATION, and never visibility.)
            const cellEl = cellAt(targetRow, col);
            _drop = { body, statics, clone, col, targetRow, color, cellEl, hiddenEl: null };
            hideCell(_drop);
            _restX = cellCx(col);
            _restY = restYForRow(targetRow);
            _stillFrames = 0;
            _lastFrame = 0;
            armWatchdog();
            return true;
        } catch (e) {
            console.warn('PoConnectFive.dropDisc failed:', e);
            cancelDrop();
            return decline();
        }
    }

    /** Tear down the engine and any in-flight drop. Page calls this on Dispose. */
    function reset() {
        cancelDrop();
        suppressKeyframe(false);
        clearWatchdog();
        if (_rafId) cancelAnimationFrame(_rafId);
        _rafId = 0;
        _active = false;
        _engine = null;
        _layout = null;
        _board = null;
    }

    window.PoConnectFive = { init, dropDisc, reset, isAvailable: () => _active };
})();