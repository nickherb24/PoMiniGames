// pojevarena/index.js — the engine facade the Blazor page drives (window.PoJevArena).
//
// Contract surface (called from src/PoMiniGames.Client/Games/PoJevArena/*):
//   PoJevArena.deploy(canvasId, dotnetRef, ticketJson, abilitiesJson, optionsJson)   → starts a live match
//   PoJevArena.select(unitIdx) / cycle(team, +1|-1)                                  → Dual Inspector: one pick per team
//   PoJevArena.scrub(frame) / play() / pause() / step(n) / jumpDecision(dir) / setSpeed(x)  → Black Box
//   PoJevArena.jumpTo(frame, unitIdx)                                                 → debrief "Jump"
//   PoJevArena.setAutoCamera(on) / skipIntro()                                        → view toggles
//   PoJevArena.shareClip()                                                            → the kill-cam WebM
//   PoJevArena.stop()                                                                  → tears the match down
//   PoJevArena.preview(canvasId, creatureJson, team) → id / stopPreview(id)            → Factory live preview
//   PoJevArena.portrait(canvasId, creatureJson, team)                                  → static library card
//
// .NET callbacks (JSON strings in and out; the page deserialises with source-gen contexts):
//   DecideAsync(batchJson) → responseJson   the only way this module reaches the server, so every call
//                                           rides the app HttpClient (antiforgery + credentials)
//   OnInspector(json)                       per team: its selected unit + the Jev distribution governing it
//   OnHud(json)                             ~4 Hz: clock, alive counts, HP shares, calls, notices, map
//   OnSelected(team)                        a unit was clicked (the phone layout follows that side)
//   OnStats(open)                           Tab held / released during the live match: the stat HUD
//   OnMatchEnded(json)                      winner, reason, duration, debrief, careers, MVP, KOs → page reports
//   OnBlackBox(json)                        replay position while scrubbing/playing
//
// The whistle runs a short show before the Black Box opens (skippable with a click or a key, and
// skipped under reduced motion): the kill cam replays the final blow slowed, letterboxed and
// zoomed while a MediaRecorder captures it as the shareable clip, then the ceremony — the
// winners hop, confetti falls, the MVP is spotlit — and only then OnMatchEnded.
//
// Lifecycle: stop() (and page dispose) cancels the rAF loop, removes every listener, stops the
// scheduler and recorder and drops cached bitmaps — the PoRacer cleanup contract.

import * as sim from './sim.js';
import { createRenderer, viewOf } from './render.js';
import { createFx } from './fx.js';
import { createScheduler } from './scheduler.js';
import { createBlackBox } from './blackbox.js';
import { lookFor, newMemory, drawCreature, FLAGS } from './creatures.js';
import { summarize } from './debrief.js';
import { createAudio } from './audio.js';
import { createPostFx } from './postfx.js';

const BASE_ACTIONS = ['idle', 'melee_charge', 'peel_to_ally', 'fall_back', 'take_cover'];
const HUD_EVERY_S = 0.25;
const ENGAGED_M = 3;
const KILLCAM_BEFORE = 90, KILLCAM_AFTER = 30, KILLCAM_SPEED = 0.45;     // frames, frames, × real time
const CEREMONY_S = 2.6;
const SLOWMO_S = 0.45, SLOWMO_SCALE = 0.35;
// <html data-motion> is the OS preference OR the player's own switch in the settings sheet.
const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
  || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

let match = null;            // the one live/replaying arena
let lastClip = null;         // the last kill cam, kept past stop() so the result bar can share it
const previews = new Map();  // id → preview loop
let nextPreviewId = 1;

function teamColorFor(canvas) {
    const css = getComputedStyle(canvas);
    const blue = css.getPropertyValue('--jev-blue').trim() || '#3d7bff';
    const red = css.getPropertyValue('--jev-red').trim() || '#f0524f';
    return (team) => (team === 'blue' ? blue : red);
}

function send(dotnet, method, payload) {
    try { dotnet.invokeMethodAsync(method, JSON.stringify(payload)).catch(() => { }); } catch { /* disposed */ }
}

// ── Live match ───────────────────────────────────────────────────────────────

function deploy(canvasId, dotnet, ticketJson, abilitiesJson, optionsJson) {
    stop();
    const canvas = document.getElementById(canvasId);
    if (!canvas) return false;

    const ticket = JSON.parse(ticketJson);
    const abilities = JSON.parse(abilitiesJson);
    const options = optionsJson ? JSON.parse(optionsJson) : {};
    const creatures = [...ticket.blue, ...ticket.red];
    const actions = BASE_ACTIONS.concat(abilities.map(a => a.jevOption));
    const reduced = reducedMotion();

    const world = sim.createWorld({ seed: ticket.seed, blue: ticket.blue, red: ticket.red, abilities });
    const fx = createFx();
    const renderer = createRenderer(canvas, { creatures, fx, reduced, seed: ticket.seed });
    const teamColor = teamColorFor(canvas);
    const blackbox = createBlackBox(world, { actions, abilityIds: abilities.map(a => a.id) });
    lastClip = null;

    const m = {
        canvas, dotnet, world, fx, renderer, blackbox, teamColor, reduced,
        audio: createAudio(creatures),
        post: createPostFx(document.getElementById(canvasId + 'Gl'), canvas, { reduced }),
        // Dual Inspector: one selected unit per team (Blue-01 and Red-01 to start).
        sel: { blue: 0, red: ticket.blue.length },
        mode: 'live',           // 'live' | 'killcam' | 'ceremony' | 'replay'
        frame: 0, playing: false, speed: 1, replayAcc: 0,
        raf: 0, last: 0, acc: 0, hudAcc: 0, paused: false,
        notices: [], remaining: null, pendingEvents: [],
        listeners: [],
        autoCam: options.autoCamera !== false,
        cam: { x: sim.ARENA_W / 2, y: sim.ARENA_H / 2, zoom: 1 },
        ko: null,               // { x, y, t }: the camera punches in on a knockout
        slowUntil: 0,
        stung: { blue: false, red: false },
        show: null,             // the end sequence's state (kill cam, ceremony)
        mvp: -1,
    };

    m.scheduler = createScheduler(world, {
        decide: async (batch) => JSON.parse(await dotnet.invokeMethodAsync('DecideAsync', JSON.stringify(batch))),
        onDecision: (frame, idx, decision, request) => {
            blackbox.recordDecision(frame, idx, decision, request);
            if (m.mode === 'live' && world.units[idx].alive) fx.bloom(idx, decision);
            if (idx === m.sel.blue || idx === m.sel.red) pushInspector(m, world.units[idx].team);
        },
        onNotice: (notice) => { if (!m.notices.includes(notice)) m.notices.push(notice); pushHud(m, true); },
        onRemaining: (remaining) => { m.remaining = remaining; },
    });

    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); m.listeners.push(() => target.removeEventListener(type, fn, opts)); };
    on(canvas, 'pointerdown', (e) => {
        if (m.mode === 'killcam' || m.mode === 'ceremony') { skipShow(m); return; }
        const idx = renderer.pick(e.clientX, e.clientY, currentViews(m));
        if (idx >= 0) { select(idx); tell(m, 'OnSelected', m.world.units[idx].team); }
    });
    on(window, 'resize', () => renderer.resize());
    // Tab holds the stat HUD open during play (a scoreboard key); releasing it, or losing focus
    // mid-hold, hands the whole screen back to the arena.
    on(window, 'keyup', (e) => { if (e.key === 'Tab' && m.statsHeld) { m.statsHeld = false; tell(m, 'OnStats', false); } });
    on(window, 'blur', () => { if (m.statsHeld) { m.statsHeld = false; tell(m, 'OnStats', false); } });
    on(document, 'visibilitychange', () => { m.paused = document.hidden; m.last = performance.now(); });
    on(window, 'keydown', (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        if ((m.mode === 'killcam' || m.mode === 'ceremony') && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) { skipShow(m); e.preventDefault(); return; }
        if (e.key === 'Tab' && m.mode === 'live') {
            e.preventDefault();
            if (!m.statsHeld) { m.statsHeld = true; tell(m, 'OnStats', true); }
            return;
        }

        if (e.key === '[') { cycle('blue', -1); e.preventDefault(); }
        else if (e.key === ']') { cycle('blue', 1); e.preventDefault(); }
        else if (e.key === ';') { cycle('red', -1); e.preventDefault(); }
        else if (e.key === "'") { cycle('red', 1); e.preventDefault(); }
        else if (m.mode !== 'replay') return;
        else if (e.key === ' ') { m.playing ? pause() : play(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { step(e.shiftKey ? -60 : -1); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { step(e.shiftKey ? 60 : 1); e.preventDefault(); }
        else if (e.key === 'Home') { scrub(0); e.preventDefault(); }
        else if (e.key === 'End') { scrub(m.blackbox.frames - 1); e.preventDefault(); }
    });
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => renderer.resize());
        ro.observe(canvas);
        m.listeners.push(() => ro.disconnect());
    }

    match = m;
    m.last = performance.now();
    m.raf = requestAnimationFrame((t) => loop(m, t));
    pushInspectors(m);
    return true;
}

function tell(m, method, arg) {
    try { m.dotnet.invokeMethodAsync(method, arg).catch(() => { }); } catch { /* disposed */ }
}

function loop(m, now) {
    if (match !== m) return;
    m.raf = requestAnimationFrame((t) => loop(m, t));
    const dt = Math.min(0.1, (now - m.last) / 1000);
    m.last = now;
    if (m.paused) return;

    if (m.mode === 'live') {
        // Slow motion only stretches how much sim time a frame buys; the scheduler runs on sim
        // time, so a slowed stretch makes no extra Jev calls.
        const slow = now < m.slowUntil;
        m.audio.setRate(slow ? 0.8 : 1);
        // Hit-stop (impactBus, set by a knockout below) rides the same scale.
        m.acc += dt * (slow ? SLOWMO_SCALE : 1) * (window.PoImpact?.getTimeScale?.() ?? 1);
        while (m.acc >= sim.DT && !m.world.over) {
            m.acc -= sim.DT;
            sim.step(m.world);
            m.scheduler.tick();
            m.blackbox.record((i) => m.scheduler.staleSeconds(i));
            m.fx.onEvents(m.world.events, m.world.units, m.world.tick, { reduced: m.reduced, teamColor: m.teamColor });
            m.fx.trample(m.world.units, m.world.tick);
            m.audio.onEvents(m.world.events, m.world.units);
            for (const e of m.world.events) { m.pendingEvents.push(e); if (e.type === 'death') onKnockout(m, e, now); }
        }
        const views = m.world.units.map(u => viewOf(u, m.world, m.scheduler.staleSeconds(u.idx)));
        direct(m, views, dt);
        const t0 = performance.now();
        draw(m, { time: m.world.time, dt, views, projectiles: m.world.projectiles, grade: slow ? 1 : 0 });
        noteDrawTime(m, performance.now() - t0);

        m.hudAcc += dt;
        if (m.hudAcc >= HUD_EVERY_S) { m.hudAcc = 0; pushHud(m); pushInspectors(m); driveMusic(m, views); }
        if (m.world.over) beginShow(m);
    } else if (m.mode === 'killcam') {
        runKillcam(m, dt);
    } else if (m.mode === 'ceremony') {
        runCeremony(m, dt);
    } else {
        if (m.playing) {
            m.replayAcc += dt * m.speed;
            while (m.replayAcc >= sim.DT) {
                m.replayAcc -= sim.DT;
                if (m.frame >= m.blackbox.frames - 1) { m.playing = false; break; }
                advanceReplay(m);
            }
        }
        drawReplay(m, dt);
    }
}

/** One recorded frame forward, with its sparks, sounds and Jev blooms (kill cam and Black Box play). */
function advanceReplay(m) {
    m.frame++;
    const evs = m.blackbox.eventsAt(m.frame);
    const d = m.blackbox.decode(m.frame);
    m.fx.onEvents(evs, d.views, m.frame, { reduced: m.reduced, teamColor: m.teamColor, live: false });
    m.audio.onEvents(evs, d.views);
    for (const dec of m.blackbox.decisionsOn(m.frame)) m.fx.bloom(dec.unit, dec);
    for (const e of evs) m.pendingEvents.push(e);
    return d;
}

function draw(m, { time, dt, views, projectiles, camera = m.cam, spotlight = -1, letterbox = 0, caption = null, grade = 0 }) {
    m.renderer.draw({
        time, dt, views, projectiles, events: m.pendingEvents, selected: [m.sel.blue, m.sel.red],
        camera, spotlight, letterbox, caption, teamColor: m.teamColor,
    });
    m.pendingEvents.length = 0;
    if (!m.post) return;
    let panicked = 0, alive = 0;
    for (const v of views) if (v.alive) { alive++; if (v.flags & FLAGS.PANIC) panicked++; }
    const punch = m.reduced ? 0 : Math.max(m.fx.shakeAmount, window.PoImpact?.getPunch?.() || 0);
    if (!m.post.render({ punch, panic: Math.min(1, alive ? (panicked / alive) * 2.5 : 0), grade, time })) {
        m.post.hide();
        m.post = null;
    }
}

function drawReplay(m, dt) {
    const d = m.blackbox.decode(m.frame);
    draw(m, { time: d.time, dt, views: d.views, projectiles: d.projectiles, camera: null });
    m.hudAcc += dt;
    if (m.hudAcc >= 0.1) { m.hudAcc = 0; pushBlackBox(m); }
}

// ── Camera, slow motion, music ───────────────────────────────────────────────

/**
 * The auto-director: drift toward the thickest fighting and tighten on it, punch in on a
 * knockout, and ease everything so the viewer never feels the cut. Off (or reduced motion) is
 * the whole arena, still.
 */
function direct(m, views, dt) {
    let tx = sim.ARENA_W / 2, ty = sim.ARENA_H / 2, zoom = 1;
    if (m.autoCam && !m.reduced) {
        if (m.ko && m.ko.t > 0) {
            m.ko.t -= dt;
            tx = m.ko.x; ty = m.ko.y; zoom = 1.45;
        } else {
            let n = 0, sx = 0, sy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (const v of views) {
                if (!v.alive || !views.some(o => o.alive && o.team !== v.team && Math.hypot(o.x - v.x, o.y - v.y) < ENGAGED_M)) continue;
                n++; sx += v.x; sy += v.y;
                x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
            }
            if (n >= 2) {
                tx = sx / n; ty = sy / n;
                zoom = Math.max(1, Math.min(1.3, 1.3 - Math.max((x1 - x0) / sim.ARENA_W, (y1 - y0) / sim.ARENA_H) * 0.6));
            }
        }
    }
    const k = 1 - Math.exp(-dt * 2.2);
    m.cam.x += (tx - m.cam.x) * k;
    m.cam.y += (ty - m.cam.y) * k;
    m.cam.zoom += (zoom - m.cam.zoom) * k;
}

function onKnockout(m, e, now) {
    const u = m.world.units[e.u];
    m.ko = { x: u.x, y: u.y, t: 0.7 };
    // An inspector parked on the fallen reads "Defeated, stale" for the rest of the match; move it on.
    if (m.sel[u.team] === u.idx) cycle(u.team, 1);
    window.PoImpact?.vibrate?.([40]);
    window.PoImpact?.hitstop?.(90);   // no-op under reduced motion
    const counts = sim.teamCounts(m.world);
    // Late knockouts get a beat of slow motion; the opening melee would just crawl.
    if (!m.reduced && !m.world.over && (counts.blue <= 3 || counts.red <= 3)) m.slowUntil = now + SLOWMO_S * 1000;
    for (const team of ['blue', 'red']) {
        if (counts[team] === 1 && !m.stung[team]) { m.stung[team] = true; m.audio.sting(); }
    }
}

/** The soundtrack's tension: how much of the field is locked in melee, plus a last-stand lift. */
function driveMusic(m, views) {
    const d = window.PoMusicDirector;
    if (!d?.tension) return;
    let alive = 0, engaged = 0;
    for (const v of views) {
        if (!v.alive) continue;
        alive++;
        if (views.some(o => o.alive && o.team !== v.team && Math.hypot(o.x - v.x, o.y - v.y) < ENGAGED_M)) engaged++;
    }
    const c = sim.teamCounts(m.world);
    d.tension(0.2 + 0.5 * (alive ? engaged / alive : 0) + (Math.min(c.blue, c.red) <= 2 ? 0.3 : 0));
}

// ── The end sequence: kill cam → ceremony → Black Box ────────────────────────

function beginShow(m) {
    m.scheduler.stop('match-over');
    const w = m.world;
    m.mvp = pickMvp(w);
    const last = m.blackbox.deaths().at(-1);
    if (m.reduced || w.endReason !== 'wipe' || !last) { beginCeremony(m); return; }

    const start = Math.max(0, last.frame - KILLCAM_BEFORE);
    const at = m.blackbox.decode(last.frame).views[last.unit];
    const blow = m.blackbox.eventsAt(last.frame).find(e => e.type === 'death' && e.u === last.unit);
    const killer = blow && blow.source >= 0 ? w.units[blow.source] : null;
    m.show = {
        end: Math.min(m.blackbox.frames - 1, last.frame + KILLCAM_AFTER), t: 0,
        cam: { x: at.x, y: at.y, zoom: 1.7 },
        caption: killer ? `FINAL BLOW · ${killer.label} ${killer.name}` : 'FINAL BLOW',
    };
    m.mode = 'killcam';
    m.frame = start;
    m.replayAcc = 0;
    m.fx.clear();
    m.renderer.resetMemory();
    m.audio.setRate(0.8);
    startClip(m);
}

function runKillcam(m, dt) {
    const s = m.show;
    s.t += dt;
    m.replayAcc += dt * KILLCAM_SPEED;
    while (m.replayAcc >= sim.DT && m.frame < s.end) { m.replayAcc -= sim.DT; advanceReplay(m); }
    const k = 1 - Math.exp(-dt * 3);
    m.cam.x += (s.cam.x - m.cam.x) * k;
    m.cam.y += (s.cam.y - m.cam.y) * k;
    m.cam.zoom += (s.cam.zoom - m.cam.zoom) * k;
    const d = m.blackbox.decode(m.frame);
    draw(m, { time: d.time, dt, views: d.views, projectiles: d.projectiles, letterbox: Math.min(1, s.t / 0.4), caption: s.caption, grade: 1 });
    if (m.frame >= s.end) beginCeremony(m);
}

function beginCeremony(m) {
    stopClip(m);
    m.audio.setRate(1);
    const w = m.world;
    if (m.reduced) { endMatch(m); return; }
    m.mode = 'ceremony';
    m.frame = m.blackbox.frames - 1;
    m.show = { t: 0 };
    const colors = w.winner === 'draw' ? [m.teamColor('blue'), m.teamColor('red'), '#ffd84a'] : [m.teamColor(w.winner), '#ffd84a', '#ffffff'];
    m.fx.confetti(colors, w.tick);
    m.audio.fanfare();
    window.PoMusicDirector?.verdict?.(true);
}

function runCeremony(m, dt) {
    const s = m.show;
    s.t += dt;
    const w = m.world;
    const d = m.blackbox.decode(m.frame);
    for (const v of d.views) if (v.alive && (w.winner === 'draw' || v.team === w.winner)) v.flags |= FLAGS.CHEER;
    const star = d.views[m.mvp];
    const target = star?.alive ? { x: star.x, y: star.y, zoom: 1.25 } : { x: sim.ARENA_W / 2, y: sim.ARENA_H / 2, zoom: 1 };
    const k = 1 - Math.exp(-dt * 2.5);
    m.cam.x += (target.x - m.cam.x) * k;
    m.cam.y += (target.y - m.cam.y) * k;
    m.cam.zoom += (target.zoom - m.cam.zoom) * k;
    draw(m, { time: w.time + s.t, dt, views: d.views, projectiles: [], spotlight: m.mvp });
    if (s.t >= CEREMONY_S) endMatch(m);
}

function skipShow(m) {
    if (m.mode === 'killcam') { m.frame = m.show.end; beginCeremony(m); }
    else if (m.mode === 'ceremony') endMatch(m);
}

/**
 * The match's most valuable creature: damage, healing (worth a little more, since it is rarer)
 * and knockouts, from the winning side — or anyone, on a draw.
 */
function pickMvp(w) {
    let best = -1, bestScore = -1;
    for (const u of w.units) {
        if (w.winner !== 'draw' && u.team !== w.winner) continue;
        const score = u.dealt + u.healed * 1.2 + u.kills * 25;
        if (score > bestScore) { bestScore = score; best = u.idx; }
    }
    return best;
}

function startClip(m) {
    try {
        if (typeof MediaRecorder === 'undefined') return;
        const el = m.post ? document.getElementById(m.canvas.id + 'Gl') : m.canvas;
        const stream = el?.captureStream?.(30);
        if (!stream) return;
        for (const t of m.audio.stream()?.getAudioTracks() ?? []) stream.addTrack(t);
        const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
        if (!type) return;
        const chunks = [];
        const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
            // Only the canvas track is ours to end; the audio track belongs to the arena's mix.
            for (const t of stream.getVideoTracks()) t.stop();
            if (chunks.length) lastClip = new Blob(chunks, { type: 'video/webm' });
        };
        rec.start();
        m.recorder = rec;
    } catch { m.recorder = null; }
}

function stopClip(m) {
    try { if (m.recorder?.state === 'recording') m.recorder.stop(); } catch { /* already stopped */ }
    m.recorder = null;
}

function endMatch(m) {
    const w = m.world;
    const counts = sim.teamCounts(w);
    const round1 = (v) => Math.round(v * 10) / 10;
    send(m.dotnet, 'OnMatchEnded', {
        winner: w.winner, reason: w.endReason, durationSeconds: w.time,
        blueAlive: counts.blue, redAlive: counts.red,
        hpPercent: w.hpPercent || null,
        calls: m.scheduler.calls,
        decisions: m.blackbox.decisions.filter(d => d.ok).length,
        frames: m.blackbox.frames,
        // What each team was "thinking", from the Black Box log: no extra Jev calls.
        debrief: summarize(w, m.blackbox.decisions, { deaths: m.blackbox.deaths(), hpAt: m.blackbox.hpAt, frames: m.blackbox.frames }),
        units: w.units.map(u => ({ slot: u.idx, kills: u.kills, damage: round1(u.dealt), healed: round1(u.healed) })),
        mvp: m.mvp,
        kos: m.blackbox.deaths().map(d => ({ frame: d.frame, team: d.team })),
        clip: !!lastClip,
        arena: w.arena.name,
    });
    // Hand over to the Black Box, parked on the final frame.
    m.mode = 'replay';
    m.frame = m.blackbox.frames - 1;
    m.playing = false;
    m.fx.clear();
    pushBlackBox(m);
    pushInspectors(m);
}

/** Rolling window of draw durations, for the render budget check (SPEC §4.8: ≤ 8 ms p95). */
function noteDrawTime(m, ms) {
    m.drawMs ??= [];
    m.drawMs.push(ms);
    if (m.drawMs.length > 600) m.drawMs.shift();
}

function drawP95(m) {
    if (!m.drawMs?.length) return null;
    const sorted = m.drawMs.slice().sort((a, b) => a - b);
    return +sorted[Math.floor(sorted.length * 0.95)].toFixed(2);
}

function currentViews(m) {
    return m.mode === 'live'
        ? m.world.units.map(u => viewOf(u, m.world, m.scheduler.staleSeconds(u.idx)))
        : m.blackbox.decode(m.frame).views;
}

function pushHud(m, force = false) {
    const w = m.world;
    const counts = sim.teamCounts(w);
    let blueHp = 0, blueMax = 0, redHp = 0, redMax = 0;
    for (const u of w.units) {
        if (u.team === 'blue') { blueHp += u.hp; blueMax += u.maxHp; } else { redHp += u.hp; redMax += u.maxHp; }
    }
    send(m.dotnet, 'OnHud', {
        time: w.time, blueAlive: counts.blue, redAlive: counts.red,
        calls: m.scheduler.calls, remaining: m.remaining, notices: m.notices, stopped: m.scheduler.stoppedReason, force,
        blueHp: blueMax ? blueHp / blueMax : 0, redHp: redMax ? redHp / redMax : 0,
        arena: w.arena.name,
    });
}

/** One side's inspector payload: its selected unit, what it's doing, and the Jev answer governing it. */
function pushInspector(m, team) {
    if (!m) return;
    const idx = m.sel[team];
    const frame = m.mode === 'live' ? m.world.tick : m.frame;
    const views = currentViews(m);
    const v = views[idx];
    if (!v) return;
    const d = m.blackbox.decisionAt(idx, frame);
    const stale = m.mode === 'live' ? m.scheduler.staleSeconds(idx) : (d ? (frame - d.frame) / 60 : frame / 60);
    send(m.dotnet, 'OnInspector', {
        unit: v.label, index: v.idx, team: v.team, name: v.name, creatureId: m.world.units[idx].creature.id,
        hp: Math.max(0, Math.round(v.hp)), maxHp: v.maxHp, alive: v.alive, stamina: Math.round(100 * (v.stamina ?? 1)),
        action: (v.flags & FLAGS.PANIC) ? 'panic_flee' : v.action,
        target: v.target >= 0 ? views[v.target]?.label ?? null : null,
        staleSeconds: Math.max(0, stale),
        frame, mode: m.mode,
        decision: d,
    });
}

function pushInspectors(m) {
    if (!m) return;
    pushInspector(m, 'blue');
    pushInspector(m, 'red');
}

function pushBlackBox(m) {
    send(m.dotnet, 'OnBlackBox', {
        frame: m.frame, frames: m.blackbox.frames, seconds: m.frame / 60,
        playing: m.playing, speed: m.speed, decisions: m.blackbox.decisions.length,
    });
    pushInspectors(m);
}

// ── Inspector & Black Box controls ───────────────────────────────────────────

/** Selects a unit on its own team's side (the other side's selection is untouched). */
function select(idx) {
    if (!match) return;
    const u = match.world.units[Math.max(0, Math.min(match.world.units.length - 1, idx | 0))];
    match.sel[u.team] = u.idx;
    pushInspector(match, u.team);
}

/** Steps one side's selection to the next living unit of that team. */
function cycle(team, dir) {
    if (!match) return;
    const views = currentViews(match);
    const mine = views.filter(v => v.team === team);
    const at = mine.findIndex(v => v.idx === match.sel[team]);
    for (let k = 1; k <= mine.length; k++) {
        const v = mine[(at + dir * k + mine.length * 2) % mine.length];
        if (v.alive) { select(v.idx); return; }
    }
}

function scrub(frame) {
    const m = match;
    if (!m || m.mode !== 'replay') return;
    m.frame = Math.max(0, Math.min(m.blackbox.frames - 1, frame | 0));
    // The floor keeps its stains: it is the record of the whole match, not of this frame.
    m.fx.clear();
    m.renderer.resetMemory();
    pushBlackBox(m);
}

function play() { if (match?.mode === 'replay') { if (match.frame >= match.blackbox.frames - 1) scrub(0); match.playing = true; pushBlackBox(match); } }
function pause() { if (match?.mode === 'replay') { match.playing = false; pushBlackBox(match); } }
function step(n) { if (match?.mode === 'replay') { match.playing = false; scrub(match.frame + (n | 0)); } }
function setSpeed(x) { if (match) { match.speed = Math.max(0.25, Math.min(4, +x || 1)); pushBlackBox(match); } }
/** Debrief "Jump": park the Black Box on a frame and put that unit in its side's inspector. */
function jumpTo(frame, unitIdx) {
    if (match?.mode !== 'replay') return;
    match.playing = false;
    const u = match.world.units[unitIdx | 0];
    if (u) match.sel[u.team] = u.idx;
    scrub(frame);
}

function jumpDecision(dir, team) {
    if (match?.mode !== 'replay') return;
    const unit = team === 'blue' || team === 'red' ? match.sel[team] : -1;
    const f = match.blackbox.neighbourDecision(match.frame, dir, unit);
    if (f >= 0) { match.playing = false; scrub(f); }
}

function setAutoCamera(on) { if (match) match.autoCam = !!on; }

function skipIntro() { if (match) skipShow(match); }

/** Shares the kill-cam clip (Web Share with a file where supported, else a download). */
async function shareClip() {
    if (!lastClip) return false;
    const file = new File([lastClip], 'jev-arena-final-blow.webm', { type: 'video/webm' });
    try {
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Jev Arena: the final blow' });
            return true;
        }
    } catch (e) {
        if (e?.name === 'AbortError') return true;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
}

function stop() {
    const m = match;
    if (!m) return;
    match = null;
    cancelAnimationFrame(m.raf);
    m.scheduler.stop('stopped');
    stopClip(m);
    for (const off of m.listeners) off();
    m.renderer.dispose();
    m.fx.clear();
    m.audio.dispose();
    m.post?.hide();
}

// ── Factory preview & library portraits ─────────────────────────────────────

const PREVIEW_POSES = [
    { name: 'idle', flags: 0, speed: 0, secs: 1.4 },
    { name: 'move', flags: 0, speed: 3, secs: 1.2 },
    { name: 'windup', flags: FLAGS.WINDUP, speed: 0, secs: 0.35 },
    { name: 'strike', flags: FLAGS.LUNGE, speed: 3, secs: 0.35 },
    { name: 'ability', flags: FLAGS.CAST, speed: 0, secs: 0.9 },
    { name: 'defense', flags: 0, speed: 0, secs: 1.2 },
];

function previewPalette(canvas) {
    const css = getComputedStyle(canvas);
    const v = (n, f) => css.getPropertyValue(n).trim() || f;
    return { blue: v('--jev-blue', '#3d7bff'), blueDark: v('--jev-blue-dark', '#1b3f99'), red: v('--jev-red', '#f0524f'), redDark: v('--jev-red-dark', '#8f1f1d') };
}

function drawPose(canvas, look, creature, pose, t, poseT) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); look.cache = null; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const R = Math.min(canvas.width, canvas.height) * (0.2 + 0.04 * creature.mass / 5);
    const offense = (creature.abilities || []).find(a => a === 'spit_glob' || a === 'hurl_boulder' || a === 'mend_bolt') || null;
    const defense = (creature.abilities || []).find(a => a === 'shield_brace' || a === 'hard_shell' || a === 'dodge_dash') || null;
    let flags = pose.flags;
    if (pose.name === 'ability' && !offense) flags = 0;
    if (pose.name === 'defense') flags = defense === 'shield_brace' ? FLAGS.BRACE : defense === 'hard_shell' ? FLAGS.SHELL : defense === 'dodge_dash' ? FLAGS.DASH | FLAGS.INVULN : 0;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const view = {
        alive: true, deathAge: -1, vx: pose.speed, vy: 0, facing: 0, hp: creature.maxHp, maxHp: creature.maxHp,
        flags, castId: pose.name === 'ability' ? offense : null, castT: poseT, strikeT: poseT,
        px: cx, py: cy, lookAt: { x: cx + 100, y: cy + Math.sin(t) * 40 },
    };
    drawCreature(ctx, look, view, look.previewMem || (look.previewMem = newMemory()), cx, cy, R, t, 1 / 60, reducedMotion());
}

function preview(canvasId, creatureJson, team) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return 0;
    const creature = JSON.parse(creatureJson);
    const look = lookFor(creature, team || 'blue', previewPalette(canvas));
    const id = nextPreviewId++;
    const start = performance.now();
    const total = PREVIEW_POSES.reduce((s, p) => s + p.secs, 0);
    const state = { raf: 0 };
    const frame = (now) => {
        if (!previews.has(id)) return;
        const t = (now - start) / 1000;
        let within = reducedMotion() ? 0 : t % total, pose = PREVIEW_POSES[0];
        for (const p of PREVIEW_POSES) { if (within < p.secs) { pose = p; break; } within -= p.secs; }
        drawPose(canvas, look, creature, pose, t, within);
        canvas.dataset.pose = pose.name;
        state.raf = requestAnimationFrame(frame);
    };
    previews.set(id, state);
    state.raf = requestAnimationFrame(frame);
    return id;
}

function stopPreview(id) {
    const state = previews.get(id);
    if (!state) return;
    cancelAnimationFrame(state.raf);
    previews.delete(id);
}

function portrait(canvasId, creatureJson, team) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const creature = JSON.parse(creatureJson);
    drawPose(canvas, lookFor(creature, team || 'blue', previewPalette(canvas)), creature, PREVIEW_POSES[0], 0.4, 0);
}

const api = {
    deploy, stop, select, cycle,
    scrub, play, pause, step, setSpeed, jumpDecision, jumpTo,
    setAutoCamera, skipIntro, shareClip,
    preview, stopPreview, portrait,
    /** Test/diagnostic hook: frames recorded and calls made (read by the E2E-UI test). */
    state: () => (match ? { mode: match.mode, frames: match.blackbox.frames, calls: match.scheduler.calls, over: match.world.over, time: match.world.time, drawP95: drawP95(match) } : null),
};

window.PoJevArena = api;
export default api;
