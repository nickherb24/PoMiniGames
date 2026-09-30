// pojevarena/debrief.js — the end-of-match "what was each team thinking" summary.
//
// Pure and node-runnable: it only reads the Black Box's decision log and the world's final
// state, so the debrief costs no extra Jev (or any AI) calls. Numbers only — the page turns them
// into sentences — so the wording lives in one place (JevDebrief.razor) and this stays testable.

const PANIC = 0.70;
const COIN_FLIP = 0.40;

/**
 * decisions: blackbox.decisions (each { frame, unit, ok, failure, action, actionConfidence,
 *            actionProbabilities, focus, focusProbabilities, panic, latencyMs }).
 * deaths: blackbox.deaths() ({ frame, unit, team, source }); hpAt(frame, unit): recorded HP.
 * Returns { blue, red } team summaries and `units`, one lifetime story per unit.
 */
export function summarize(world, allDecisions, { deaths = [], hpAt = null, frames = 0 } = {}) {
    const teams = { blue: newTeam(), red: newTeam() };
    // An answer that lands after its unit fell was paid for but never applied (the scheduler drops
    // it), so it is no part of what the unit "thought": left in, a story read "switched to dodge
    // dash with 0% HP".
    const diedAt = new Map(deaths.map(d => [d.unit, d.frame]));
    const decisions = allDecisions.filter(d => !(diedAt.has(d.unit) && d.frame >= diedAt.get(d.unit)));

    for (const d of decisions) {
        const u = world.units[d.unit];
        if (!u) continue;
        const t = teams[u.team];
        if (!d.ok) { t.failures++; continue; }

        t.decisions++;
        t.confidenceSum += d.actionConfidence || 0;
        t.latencySum += d.latencyMs || 0;
        bump(t.actions, d.action);
        if (d.focus) bump(t.foci, d.focus);
        if ((d.actionConfidence || 0) < COIN_FLIP) t.coinFlips++;

        if ((d.panic || 0) > PANIC) {
            t.panicDecisions++;
            t.panickedUnits.add(u.idx);
            if (!t.firstPanic) t.firstPanic = moment(d, u, 'first-panic');
        }
        if ((d.panic || 0) > t.peakPanic) t.peakPanic = d.panic || 0;

        if (!t.surest || (d.actionConfidence || 0) > t.surest.confidence) t.surest = moment(d, u, 'surest');
        const margin = marginOverRunnerUp(d);
        if (margin !== null && (!t.torn || margin < t.torn.margin)) t.torn = { ...moment(d, u, 'torn'), margin };
    }

    const out = {};
    for (const [team, t] of Object.entries(teams)) {
        const alive = world.units.filter(u => u.team === team && u.alive).length;
        out[team] = {
            decisions: t.decisions,
            failures: t.failures,
            averageConfidence: t.decisions ? round(t.confidenceSum / t.decisions) : 0,
            averageLatencyMs: t.decisions ? Math.round(t.latencySum / t.decisions) : 0,
            coinFlips: t.coinFlips,
            actions: shares(t.actions, t.decisions),
            foci: shares(t.foci, sum(t.foci)),
            panicDecisions: t.panicDecisions,
            panickedUnits: t.panickedUnits.size,
            peakPanic: round(t.peakPanic),
            survivors: alive,
            moments: [t.surest, t.torn, t.firstPanic].filter(Boolean),
        };
    }
    out.units = world.units.map(u => story(world, u, decisions.filter(d => d.unit === u.idx), deaths, hpAt, frames));
    return out;
}

/**
 * One unit's life as Jev ran it: when it fell and to whom, and its phases — runs of the same
 * chosen action, with a one-call blip folded into the run it interrupted, so a single wobble
 * does not read as a change of plan (`switches` still counts every change of mind). A unit killed
 * by poison or tar has no killer (`source` -1).
 */
function story(world, u, mine, deaths, hpAt, frames) {
    const ok = mine.filter(d => d.ok);
    const death = deaths.find(d => d.unit === u.idx);
    const killer = death && death.source >= 0 ? world.units[death.source] : null;
    const end = death ? death.frame : Math.max(0, frames - 1);
    const hpPct = (frame) => (hpAt ? Math.round(100 * Math.max(0, hpAt(frame, u.idx)) / u.maxHp) : null);

    const runs = [];
    for (const d of ok) {
        const last = runs.at(-1);
        if (last && last.action === d.action) { last.calls++; last.conf += d.actionConfidence || 0; continue; }
        runs.push({ action: d.action, fromFrame: d.frame, calls: 1, conf: d.actionConfidence || 0 });
    }
    const phases = [];
    runs.forEach((r, i) => {
        const prev = phases.at(-1);
        // The last call is never a blip: what a unit was doing as it fell is the end of its story.
        if (prev && (prev.action === r.action || (r.calls === 1 && i < runs.length - 1))) { prev.calls += r.calls; prev.conf += r.conf; return; }
        phases.push({ ...r });
    });

    const foci = {};
    let panics = 0, firstPanic = -1, coinFlips = 0, confSum = 0, winded = -1;
    for (const d of ok) {
        if (winded < 0 && d.stamina != null && d.stamina < 15) winded = d.frame;
        bump(foci, d.focus);
        confSum += d.actionConfidence || 0;
        if ((d.actionConfidence || 0) < COIN_FLIP) coinFlips++;
        if ((d.panic || 0) > PANIC) { panics++; if (firstPanic < 0) firstPanic = d.frame; }
    }
    const top = shares(foci, sum(foci))[0];

    return {
        index: u.idx, unit: u.label, name: u.name, team: u.team,
        survived: !death, diedAtFrame: death ? death.frame : -1,
        killer: killer?.label ?? null, killerName: killer?.name ?? null,
        hpPercent: Math.round(100 * Math.max(0, u.hp) / u.maxHp),
        kills: u.kills, damage: Math.round(u.dealt), healed: Math.round(u.healed),
        decisions: ok.length, failures: mine.length - ok.length,
        averageConfidence: ok.length ? round(confSum / ok.length) : 0,
        coinFlips, switches: Math.max(0, runs.length - 1),
        phases: phases.map((p, i) => ({
            action: p.action, fromFrame: p.fromFrame, toFrame: phases[i + 1]?.fromFrame ?? end,
            calls: p.calls, hpPercent: hpPct(p.fromFrame), confidence: round(p.conf / p.calls),
        })),
        topFocus: top?.key ?? null, topFocusShare: top?.share ?? 0,
        panics, firstPanicFrame: firstPanic, windedFrame: winded, endFrame: end,
    };
}


function newTeam() {
    return {
        decisions: 0, failures: 0, confidenceSum: 0, latencySum: 0, coinFlips: 0,
        actions: {}, foci: {},
        panicDecisions: 0, panickedUnits: new Set(), peakPanic: 0,
        surest: null, torn: null, firstPanic: null,
    };
}

function moment(d, u, kind) {
    // The runner-up is the best option Jev did NOT pick (its pick is not always the argmax: ties).
    const ranked = Object.entries(d.actionProbabilities || {}).filter(([k]) => k !== d.action).sort((a, b) => b[1] - a[1]);
    return {
        kind,
        frame: d.frame,
        unitIndex: u.idx,
        unit: u.label,
        name: u.name,
        action: d.action,
        confidence: round(d.actionConfidence || 0),
        runnerUp: ranked[0]?.[0] ?? null,
        runnerUpProbability: ranked[0] ? round(ranked[0][1]) : 0,
        panic: round(d.panic || 0),
    };
}

/** How far the chosen option led the best alternative (the smaller, the closer the call). */
function marginOverRunnerUp(d) {
    const p = d.actionProbabilities || {};
    const others = Object.entries(p).filter(([k]) => k !== d.action).map(([, v]) => v);
    if (!others.length || p[d.action] === undefined) return null;
    return p[d.action] - Math.max(...others);
}

const bump = (bag, key) => { if (key) bag[key] = (bag[key] || 0) + 1; };
const sum = (bag) => Object.values(bag).reduce((a, b) => a + b, 0);
const round = (v) => Math.round(v * 100) / 100;

function shares(bag, total) {
    return Object.entries(bag)
        .map(([key, n]) => ({ key, count: n, share: total ? round(n / total) : 0 }))
        .sort((a, b) => b.count - a.count);
}
