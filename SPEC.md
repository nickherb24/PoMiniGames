# Specification — PoJevArena (10v10 Jev-Driven Creature Battle)

> Living spec. Update whenever scope, decisions, or success criteria change, and keep
> [`tasks/todo.md`](tasks/todo.md) in sync. Framework invariants and standing rules live in
> [`CLAUDE.md`](CLAUDE.md) and [`AGENT.md`](AGENT.md); where the external NET_START/NET_RULES
> templates disagree with them (Radzen, `dotnet user-secrets`), the repo files win.
> The previous PoCabinet spec is in git history (`git show 438800e7:SPEC.md`).

---

## 1. Objective

Ship **PoJevArena**, a new mini-game inside PoMiniGames: an autonomous 10v10 2D creature battle in which
every tactical decision (manoeuvre, target, panic) is made by **TypeSafe's Jev** System One model, and the
player's role is to design creatures, draft teams, watch, and inspect *why* Jev decided what it did.

1. **Creature Factory** — design a creature from bounded physical stats (HP, speed, mass), an **offense ability**
   and a **defense ability** from a data-driven ability registry, and three personality descriptors picked from fixed
   catalogs, all within a build-point budget. **Every creature can melee.** Some also hurl projectiles or mend allies,
   and the registry is built so new abilities drop in later. Saving publishes it to a **shared public library** in
   Azure Table Storage that every signed-in player drafts from.
2. **Readable, animated creatures** — every creature is drawn procedurally with a silhouette you can tell apart at a
   glance: body from mass and speed, features from its abilities, expression and idle mannerisms from its temperament.
   Every action has a wind-up, a motion and an impact, so a spectator can follow who is doing what to whom (§4.8).
3. **Roster Builder** — fill 10 slots for Team Blue and 10 for Team Red from the library plus five built-in presets.
4. **Live Arena** — 800 × 600 Canvas 2D arena, fixed 60 Hz physics in the browser, overhead intent gizmos and
   target lines, and a click-to-inspect **Jev Telemetry** panel (choice probability bars, confidence, panic probability).
5. **Real Jev, required** — decisions come only from Jev via a server proxy; there is no local decision fallback.
   Each unit re-decides once per second, staggered so a 250 ms batch carries ~5 units. Jev sees each unit's
   personality and ability cooldowns, and picks from options that its abilities unlock.
6. **Black Box** — after the match, a forensic scrubber replays every recorded frame, including animation events, and
   shows the exact Jev distribution that governed the selected unit at that moment.
7. **Community stats** — every finished match increments deployed / wins / losses / draws on each library creature
   that fought; the library sorts by win rate.
8. **Three modes** on the standard route scheme: `/pojevarena/1player`, `/pojevarena/2player`, `/pojevarena/demo`.

---

## 2. User Journeys

### Journey 1 — 1P: design, draft, watch (`/pojevarena/1player`)
1. Player lands on the page (sign-in or guest login required, as for every game-data write). A status chip shows
   `Jev: ready · 18,240 calls left today` (or `Jev unavailable`, which disables Deploy — see §10).
2. **Factory**: player names a creature, sets HP / Speed / Mass sliders, picks an offense ability (or none) and a
   defense ability (or none), and picks Temperament / Target bias / Panic from dropdowns. A build-point meter shows
   what's left of the 80-point budget. A **live animated preview** redraws the creature as each choice changes and
   cycles its idle, melee and ability animations. The player clicks **Save to library**; the creature appears in the
   library immediately, credited to the player's display name. Library cards show a small animated portrait.
3. **Library**: searchable, sortable (Newest · Most used · Win rate) list. Presets are pinned at the top. The
   player's own creatures show Edit / Delete.
4. **Roster**: clicking a library card with Blue or Red active appends it to that team's next free slot; clicking a
   filled slot clears it. `Clear` empties a team. Rosters persist to `localStorage` between visits.
5. **Deploy Battle** (enabled when both teams have 10): the page registers the match with the server, freezes a copy
   of each creature's stats (later library edits do not affect a running match), and spawns 20 units in circular
   start zones on opposite sides.
6. Units idle ("awaiting orders") until their first Jev answer arrives, then act. Clicking a unit anchors the
   Telemetry Inspector to it; `[` / `]` cycle units.
7. The match ends when one team has no living units, or at **3:00** (§4.6). A result banner shows the winner, and
   the page reports the result so each library creature's counters update.
8. The **Jev debrief** opens first: one card per team saying, in plain sentences, what that team was
   "thinking". It covers:
   - its style (aggressive, defensive or supportive, with the share of calls it's based on)
   - its targeting habit
   - how sure Jev was (average confidence and coin-flip calls under 0.40)
   - morale (who panicked, peak panic)
   - failed calls
   - an action-share chart and a per-creature breakdown (go-to move and confidence)
   - key moments: the most confident call, the closest call against the best alternative, and the first panic.
     Each has a **Jump** link into the Black Box.

   It is computed in the browser from the Black Box decision log (`js/pojevarena/debrief.js`), so it costs no extra
   Jev calls.
9. The **Black Box** (toggle next to the debrief) offers play/pause, step ±1 frame, jump to the previous/next
   decision, first/last, speed 0.25×–4×, and a timeline slider. The canvas and inspector show the historical state at
   the scrubbed frame.

### Journey 2 — 2P hot-seat (`/pojevarena/2player`)
1. Same device, one signed-in account. Player 1 drafts **Blue** while Red's tray is hidden, then clicks **Lock Blue**.
2. A hand-off screen ("Pass to Player 2") hides Blue's roster; Player 2 drafts **Red** and clicks **Lock Red**.
3. Both rosters are revealed, then the match deploys and plays as in Journey 1, with the banner naming "Player 1 (Blue)"
   or "Player 2 (Red)" as the winner.

### Journey 3 — Demo (`/pojevarena/demo`)
1. Two rosters are generated from the five presets plus up to six random library creatures per team.
2. The match auto-deploys after the standard `GameIntro` demo delay, plays to the end, shows the result for 8 s,
   plays 20 s of the Black Box highlights (the last 20 s before the end), then starts a new match.
3. Demo calls count against the signed-in identity's daily allowance; when the allowance cannot cover another match
   (< 3,600 calls left), the loop stops on a "Daily Jev allowance reached" card.
4. PoJevArena is **not** added to the kiosk rotation (`GameCatalog.Demo`); see Open Question 1.

---

## 3. Pinned Tech Stack & Versions

Pinned via [`global.json`](global.json) and [`Directory.Packages.props`](Directory.Packages.props). **No new packages.**

| Concern | Choice |
|---|---|
| SDK / runtime | .NET SDK `10.0.400` (rollForward disabled), `net10.0`, `LangVersion latest` |
| Client | Blazor WebAssembly `10.0.10`, trimmed publish (`PublishTrimmed`, `EnableTrimAnalyzer`) |
| Engine | Plain ES modules, **Canvas 2D** (no three.js, no physics library), loaded on demand through `wwwroot/js/engineLoader.js` |
| Persistence | Azure Table Storage via `Azure.Data.Tables` `12.11.0`; Azurite locally; `localStorage` for rosters/UI prefs |
| Outbound HTTP | `IHttpClientFactory` + `Microsoft.Extensions.Http.Resilience` `10.7.0` (already referenced) |
| Decision model | TypeSafe Jev on OpenRouter — model **`typesafe/jev-1.13`** (pinned, not `jev-latest`, so calibration does not shift under us), `POST https://openrouter.ai/api/v1/systemone`, Bearer key |
| Tests | xUnit `2.9.3`, FluentAssertions `8.8.0`, NSubstitute `6.2.0`, `Microsoft.AspNetCore.Mvc.Testing` `10.0.10`, Testcontainers.Azurite `4.12.0`, Microsoft.Playwright `1.50.0` |
| UI | Native Blazor + scoped `.razor.css` + `app.css` tokens. **No Radzen** (bundle size — `CLAUDE.md` overrides the NET_START "Radzen First" rule) |

### 3.1 Jev wire contract (verified 2026-09-24 against the OpenRouter API reference)

Request — one unit per call, all three questions in one request:

```json
{
  "model": "typesafe/jev-1.13",
  "state": "Subject: Blue-04 (Role: Spitter, HP: 32/110 [29%], ...)\n...",
  "questions": {
    "tactical_action": { "type": "choice", "instructions": "...", "criteria": { "melee_charge": "...", "...": "..." } },
    "target_focus":    { "type": "choice", "instructions": "...", "criteria": { "nearest_threat": "...", "...": "..." } },
    "panic_trigger":   { "type": "noul",   "instructions": "...", "criteria": { "true": "...", "false": "..." } }
  },
  "session_id": "<matchId>",
  "user": "<sha256(identity)[..24]>"
}
```

Response (fields used): `answers.<key>.type`, choice → `choice`, `confidence`, `probabilities{option:p}`;
noul → `noul` (probability of true); `usage.input_tokens`, `usage.output_tokens`, `usage.cost` (USD).
Documented example: 3 questions, 476 input tokens, `cost 0.000019992`. Errors: 400 / 401 / 402 (credits) /
403 / 404 / 429 (rate limit — numeric limit **not published**) / 5xx. The API accepts **one `state` per request**,
so the "batch" endpoint below fans out server-side.

---

## 4. Game Design

### 4.1 Creature archetype (library row and preset)

| Field | Type / Range | Notes |
|---|---|---|
| `name` | 2–24 chars | Through `DisplayNameSanitizer` (`PoMiniGames.Domain/Services`); rejected names return 422 |
| `maxHp` | int 50–500 | |
| `moveSpeed` | 2.0–9.0 m/s | step 0.5 |
| `mass` | 1.0–5.0 | step 0.5; radius = `10 + 3·mass` px; drives melee damage and knockback |
| `abilities` | ≤ 1 per slot, ids from the registry (§4.1.1) | Stored as a list, so a future slot (e.g. `utility`) needs no schema change |
| `temperament` | `reckless_berserker` · `disciplined_anchor` · `skirmisher` · `cautious_sniper` · `loyal_guardian` · `opportunist` | fixed catalog |
| `targetBias` | `engage_closest` · `hunt_weakest` · `protect_allies` · `focus_ranged` · `challenge_strongest` | fixed catalog |
| `panicThreshold` | `fights_to_death` · `panics_under_25_hp` · `panics_under_50_hp` · `flees_if_outnumbered` · `flees_when_alone` · `breaks_when_allies_fall` | fixed catalog |

**Every creature has a melee attack** (§4.3). Abilities are extras on top of it.

**Build budget: 80 points** (Open Question 6). Costs, rounded to 0.1:
HP `(maxHp−50)/450 × 40` · speed `(moveSpeed−2)/7 × 30` · mass `(mass−1)/4 × 20` · plus each ability's cost.
Maxing all three stats costs 90, so every creature is a trade-off. The same function runs in `PoMiniGames.Shared`
(server validation, client meter) and is mirrored in `sim.js` only for display.

#### 4.1.1 Ability registry (the extension point)

One table in `PoMiniGames.Shared` (`PoJevArenaAbilities`) drives validation, cost, the Jev option each ability
unlocks (key and criterion text) and the client parameters. JS has one handler per id in `abilities.js` and one
visual per id in `fx.js`. **Adding an ability means one registry row, one handler and one visual.** Nothing in the
prompt builder, storage, validation or UI lists abilities by name.

| Id | Slot | Cost | Jev option it unlocks | Effect (v1 tuning) | Signature look |
|---|---|---|---|---|---|
| `spit_glob` | offense | 12 | `kite_and_shoot` — "Back away from the target while spitting from range" | Glob 18 m/s, 10 dmg + poison 2 dmg/s for 2 s, range 10 m, cd 1.2 s | Throat sac swells, then a green glob with a drip trail; splat decal |
| `hurl_boulder` | offense | 15 | `lob_boulder` — "Plant feet and hurl a heavy boulder at the target" | Arcing rock 11 m/s, 28 dmg + 3 m/s knockback, range 7 m, cd 3 s, 0.4 s wind-up | Big forelimbs; rock rises overhead, spins with a ground shadow, dust burst |
| `mend_bolt` | offense | 15 | `mend_ally` — "Move near the most injured ally and heal it" | Bolt 18 m/s, heals 12, range 6 m, cd 1.5 s | Glowing antennae; green ribbon bolt, sparkles, `+12` popup |
| `shield_brace` | defense | 8 | `shield_brace` — "Stop, dig in and brace for impact" | While held: `v ← v·0.2`, collision mass × 3, −40% melee damage from the front 120° | Shield plate on the front edge; arc flashes on a blocked hit |
| `hard_shell` | defense | 12 | `shell_up` — "Retract into the shell to survive incoming damage" | 2.5 s: −60% all damage, can't move or attack; cd 7 s | Back plates; body shrinks into a domed shell with a metallic sheen |
| `dodge_dash` | defense | 10 | `dodge_dash` — "Dash sideways out of the threat's line of attack" | 0.25 s burst perpendicular to the nearest threat, invulnerable for 0.3 s, cd 4 s | Swept fins; afterimage trail of 3 fading ghosts |

Base options that every creature gets: `melee_charge` ("Rush the target and strike it in melee"), `peel_to_ally`
("Disengage and move to the closest living ally"), `fall_back` ("Back away from the nearest threat without attacking").

Presets (ids `preset:<slug>`, constants in `PoMiniGames.Shared`, never in the table, no stats), all within budget:

| Preset | HP | Speed | Mass | Offense | Defense | Temperament · Bias · Panic | Points |
|---|---|---|---|---|---|---|---|
| **Vanguard Tank** | 450 | 3.0 | 4.5 | — | `shield_brace` | disciplined_anchor · engage_closest · fights_to_death | 65.3 |
| **Berserker Rusher** | 160 | 8.0 | 2.0 | — | `dodge_dash` | reckless_berserker · hunt_weakest · fights_to_death | 50.5 |
| **Poison Spitter** | 110 | 5.5 | 1.5 | `spit_glob` | `dodge_dash` | skirmisher · hunt_weakest · panics_under_25_hp | 44.8 |
| **Boulder Brute** | 300 | 3.5 | 4.0 | `hurl_boulder` | `hard_shell` | opportunist · challenge_strongest · panics_under_50_hp | 70.6 |
| **Backline Medic** | 130 | 5.0 | 1.5 | `mend_bolt` | `hard_shell` | loyal_guardian · protect_allies · flees_when_alone | 49.5 |

### 4.2 Arena and units
- 800 × 600 px arena, **40 px = 1 m** (all distances sent to Jev are in metres, one decimal).
- Blue spawns in a circle of radius 90 px centred at (130, 300); Red at (670, 300). Deterministic placement from a
  seeded RNG (`mulberry32(matchSeed)`), so the Black Box and bug reports can quote a seed.
- Units are labelled `Blue-01`…`Blue-10`, `Red-01`…`Red-10` by roster slot.

### 4.3 Physics (browser, fixed 60 Hz, `dt = 1/60`)
- Semi-implicit Euler: `v += a·dt`, `v *= 0.92` per tick (damping), speed clamped to `moveSpeed·1.5` m/s, `x += v·dt`.
- Circle–circle elastic collision with positional de-penetration, using effective mass (`mass × 3` while bracing).
- Wall bounce with restitution 0.5.
- **Melee (every creature)**: when a unit whose intent is `melee_charge` comes within 0.3 m of its target's edge, it
  runs a strike: 120 ms wind-up, then a lunge. The hit lands on contact:
  `Damage = 15 + 0.5 · |v_attacker − v_defender| · mass_attacker` (velocities in m/s), plus knockback
  `2.0 · mass_attacker / effective_mass_defender` m/s. A strike has a 1.0 s cooldown per attacker, so sustained
  contact is never per-frame damage.
- **Global damage scale 0.5** (tuned 2026-09-25 in the node harness). It applies to every source inside the one
  damage pipeline. At the PRD's raw numbers a 10v10 match ended in about 25 s. With the scale, headless matches run
  27–77 s, giving Jev 30–80 decisions per unit.
- **Ability projectiles** (spit glob, boulder, mend bolt) use the registry parameters. They hit on circle overlap with
  an enemy (heals hit an ally), with no friendly fire. The boulder's arc is visual only; it collides on the ground plane.
- **Damage pipeline** (one function, so defenses stack predictably): invulnerable → 0; else × (1 − shell 0.6);
  × (1 − brace 0.4 if the hit comes from the front arc); poison ticks bypass the brace but not the shell.
- Cooldowns tick in sim time. Ability state (active, remaining, cooldown) is part of the unit record, the Black Box
  frame, and the state sent to Jev.
- The physics loop owns no decisions: steering and ability triggers read the unit's current intent only.

### 4.4 Decision protocol
Every **250 ms** the scheduler sends one batch containing the living units whose slot is due. A unit's slot is
`slotIndex mod 4`, so each unit is asked once per second. Batches never overlap for the same unit (a unit with an
in-flight request is skipped that cycle).

**Client → server** (structured numbers only; the client computes all arithmetic, as the PRD requires):
subject (id, team, archetype name, HP, maxHp, mass, speed, the three personality ids, ability ids with
`ready` or seconds of cooldown left, whether poisoned, under-fire flag, allies within 4 m), and up to five candidates —
nearest threat, weakest enemy, strongest enemy, nearest ranged enemy (anyone with a projectile ability), most
injured ally — each with id, distance (m), HP %, and ability ids. It also sends the team alive counts.

**Server** validates every field against the catalogs, the registry and the bounds, then **builds the state string
and the question set itself** (see §3.1 and the PRD's state format, extended with an `Abilities:` line and each
candidate's abilities). The proxy therefore cannot be used to send arbitrary text to Jev on our key.

`tactical_action` options = the three base options + the option each of the unit's abilities unlocks. An ability
whose cooldown will not be ready within 1 s is still offered, and Jev sees its cooldown in the state. If Jev picks it
early, the unit moves into position and fires when ready. A Vanguard Tank sees 4 options; a Boulder Brute sees 5.

`target_focus` options are the candidates present in that request (`nearest_threat`, `weakest_target`,
`strongest_threat`, `ranged_threat`, `protect_ally`). `panic_trigger` is a noul.

### 4.5 Applying a decision (browser)
- `panic_trigger > 0.70` → `isPanicked = true`, action `panic_flee`: steer toward the nearest wall at `moveSpeed`,
  ignore combat. A later answer ≤ 0.70 recovers the unit.
- `melee_charge`: acceleration `û_target · moveSpeed · 1.5`, then strikes on contact (§4.3).
- `fall_back`: acceleration `−û_threat · moveSpeed`.
- `peel_to_ally`: acceleration toward the closest living ally.
- Ability options run their registry handler. `kite_and_shoot` backpedals when inside 60% of range and approaches when
  outside range, firing when ready. `lob_boulder` approaches to range, plants its feet and throws. `mend_ally` moves
  within 5 m of the ally and heals. `shield_brace` holds until the next decision. `shell_up` and `dodge_dash` fire once
  when ready, and the unit then falls back to `fall_back` until the next decision.
- The target is resolved from the candidate id sent in that request. If it has died, the unit re-targets the nearest
  enemy (or nearest ally for `protect_ally` / `mend_ally`) until its next decision.
- **Failure = hold last intent, indefinitely** (user decision): a failed or late call leaves the unit acting on its
  last decision; the inspector shows `stale · 4.2 s`. A unit that has never had a decision keeps idling. Physics
  never pauses for Jev.

### 4.6 Match end
- A team with no living units loses (panicked units are alive). Both wiped on the same tick is a draw.
- At **3:00** of sim time: team HP% = Σ currentHp / Σ maxHp over all 10 slots (dead = 0). Higher wins; within
  1 percentage point is a draw.

### 4.7 Black Box
- Records every physics frame (up to 10,800 plus 5 s of slack) into preallocated typed arrays: per unit x, y, vx, vy,
  facing, hp, intent code, target index, animation state and phase, ability active/cooldown values, flags (panicked,
  shelled, braced, invulnerable, poisoned, stale, dead), and projectile positions.
- Records **combat events** (strike wind-up/hit, ability fired, projectile hit, heal, block, death, panic
  start/end) so a replay shows the same impacts, popups and particles. Particles are regenerated from the event and a
  seeded RNG, not stored.
- Records every Jev decision as an event: frame, unit, both choice distributions, confidence values, panic
  probability, latency, and failure reason if any.
- Memory stays under ~8 MB for a full match. Nothing is persisted or uploaded.

### 4.8 Creature art, animation and readability

Everything is procedural Canvas 2D, with no image assets to ship. The goal is that a spectator can tell *what each
creature is, what it's doing and to whom* without opening the inspector.

**Silhouette (who it is)**, built once per creature from its data and cached to an offscreen canvas per team:
- Body from mass and speed: heavy creatures are wide and rounded with armour plates; fast ones are a sleek teardrop
  with a tail; light and slow ones are a soft round blob. Size follows the collision radius exactly.
- Ability features: a throat sac (spit), oversized forelimbs (boulder), glowing antennae (mend), a front shield plate
  (brace), dorsal shell plates (shell), swept fins (dash). A creature with none has plain claws.
- Temperament: face and idle mannerism. Berserker has angry brows, a snarl and twitchy idle. Anchor has a level gaze
  and a planted stance. Skirmisher bobs lightly on its feet. Sniper squints. Guardian's eyes track its nearest ally.
  Opportunist's eyes dart around.
- A seeded pattern (spots or stripes) and an accent hue from the creature id keep library creatures distinct. Team
  colour is the body fill; the accent is secondary.
- Team is never shown by colour alone: Blue units stand on a circular base ring, Red on a diamond. Both hues come from
  scheme-invariant `--jev-blue` / `--jev-red` tokens, checked against deuteranopia.

**Motion (what it's doing)**:
- Idle breathing (±3% scale). Movement squashes and stretches along velocity, leans into turns, and plays a 2-frame
  foot patter scaled by speed. Eyes look at the current target.
- Melee: 120 ms wind-up (pull back, telegraph flash), a lunge, a bite/claw arc and an impact star. The defender
  flashes white for 80 ms, is knocked back, and a damage number floats up. The camera nudges on heavy hits (off
  under reduced motion).
- Every ability has the wind-up → release → impact sequence in the §4.1.1 table.
- Shell: shrinks into a dome with a sheen. Brace: a shield arc appears at the front and flashes on a blocked hit.
  Dash: afterimage ghosts.
- Poison: green tint pulse and bubbles. Low HP (< 25%): limp and a slower breath. Panic: sweat drops, trembling, a
  `!` above it, and a scramble toward the wall.
- Death: squash, pop into team-coloured particles, and leave a fading decal. Dead units stop blocking.

**Intent overlay (to whom)**:
- A thin line to the current target: solid for attacks, dashed green for heals and protect. There is an action glyph
  above the HP bar (fist, glob, rock, cross, shield, shell, dash, flee) and a slot number badge.
- Stale units show a dim `…` bubble. The selected unit gets a pulsing ring and a name tag.
- The canvas is sized by `--gps-area-h` and aspect-locked at 4:3, with devicePixelRatio scaling.
- `prefers-reduced-motion` turns off shake, squash and stretch, and particle bursts; state changes stay visible as
  static glyphs.

**Budget**: all 20 units, 30 projectiles, particles (capped at 400) and the overlay render in ≤ 8 ms per frame on the
dev machine, leaving room for physics inside a 16.7 ms frame.

---

## 5. Server Surface (`src/PoMiniGames.API/Features/PoJevArena`)

All routes are relative to the authenticated `/api` group, so they need auth and antiforgery on writes.

| Method & route | Purpose | Rate policy |
|---|---|---|
| `GET /api/pojevarena/status` | `{ configured, dailyLimit, used, remaining, resetUtc }` | `pojevarena` |
| `GET /api/pojevarena/creatures?sort=new\|used\|winrate&q=` | Library, top 200 | `leaderboard-read` |
| `POST /api/pojevarena/creatures` | Create (owner cap 25 → 409) | `pojevarena` |
| `PUT /api/pojevarena/creatures/{id}` | Edit own (else 403/404) | `pojevarena` |
| `DELETE /api/pojevarena/creatures/{id}` | Delete own | `pojevarena` |
| `POST /api/pojevarena/matches` | Register match: 20 creature ids + mode → `{ matchId, seed }` | `pojevarena` |
| `POST /api/pojevarena/matches/{matchId}/decisions` | 1–8 units → per-unit decision or failure | `pojevarena-decide` |
| `POST /api/pojevarena/matches/{matchId}/result` | Winner + duration; accepted once | `pojevarena` |

- **Jev client** (feature-owned, restored and trimmed from the version deleted in `2235ed7d`): named `HttpClient`
  with a 1,500 ms timeout and standard resilience **with retries disabled** (a late decision is worthless at 1 Hz).
  It uses one process-wide `ConcurrencyLimiter` (16 permits, queue 64). The upstream `usage.cost` is logged per call and
  summed per match.
- **Daily allowance**: 20,000 Jev calls per identity per UTC day, stored durably with ETag increments, using the same
  write-behind pattern as `AiTokenBudget` / `IAiTokenLedgerStore` (table `PoJevArenaCallLedger`). A batch
  that would exceed the allowance is rejected whole with **429** plus `Retry-After` set to the reset time.
- **Match registry**: an in-memory `IMemoryCache` holds `matchId → rosters, owner, decisionCount, reported`, with a
  15-minute sliding TTL. A result is accepted only once and only from the owner, and only when it is plausible:
  the match lasted at least 10 s, at least 80% of the claimed duration has passed on the server clock since
  registration, and there were at least max(40, 4 × duration) paid Jev decisions. The winner is still the client's
  word (the server does not re-simulate), so a fake result is possible, but it costs the same time and allowance as
  playing the match. That is enough for a sort order. If the stats write fails, the claim is released so a retry
  can land. A recycled
  host forgets the match, so the result returns 404 and the page shows "stats not recorded".
- **Creature store**: table `PoJevArenaCreatures`, one partition `lib`, RowKey is an 8-char id. Columns hold the
  stats, OwnerKey (SHA-256 of the claim id, first 24 hex characters), OwnerName, Deployed/Wins/Losses/Draws,
  CreatedUtc and UpdatedUtc. Counter updates go through `TableConcurrency.UpdateWithRetryAsync` as increments.
  Row keys are inverted ticks plus a random suffix, so a partition scan reads newest-first. A listing considers the
  newest 2,000 creatures and returns 200; the used/win-rate sorts and name search rank within that window. When
  storage is down, a listing returns 503 (the page says "offline", never "empty") and writes fail cleanly.
- **Configuration**: section `PoMiniGames:Jev` with `Endpoint`, `Model`, `ApiKey`, `CallTimeoutMs`,
  `MaxConcurrentCalls` and `DailyCallsPerIdentity`. The key comes from Key Vault secret `PoMiniGames--Jev--ApiKey`,
  restored as the conditional secret in `infra/kv-secrets.bicep`, or from `appsettings.Development.json` locally.
  **Never `dotnet user-secrets`, and never committed.** A missing key does not stop the app booting; `status`
  reports `configured:false`.
- **Test stub**: `PoMiniGames:Jev:UseStub = "true"` is added to `tests/Shared/TestBudgetGuard.Overrides`. That is the
  single AI-mocking edit. It is honoured **only** when the host environment is `Test`, so production and
  development can never fall back to it.

---

## 6. Build, Test, Lint, and Run Commands

```powershell
dotnet build PoMiniGames.slnx                                   # 0 warnings (TreatWarningsAsErrors)
dotnet format PoMiniGames.slnx --verify-no-changes --verbosity minimal
docker compose up -d azurite                                    # storage emulator
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj # http://localhost:5080/pojevarena/1player

# Targeted tests only (never the full suite unprompted — CLAUDE.md)
dotnet test tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj --filter "FullyQualifiedName~PoJevArena"
dotnet test tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj --filter "FullyQualifiedName~PoJevArena"
dotnet test tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj --filter "FullyQualifiedName~PoJevArena"
dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj --filter "FullyQualifiedName~PoJevArena"
pwsh scripts/test-ceilings.ps1                                  # all four method ceilings (CI gate)

# Trim audit + bundle budget (CI gates)
dotnet publish src/PoMiniGames.Client/PoMiniGamesClient.csproj -c Release -p:PublishTrimmed=true

# Headless engine check (scratch, not a test tier): node drives js/pojevarena/sim.js with a scripted decision source
node <scratchpad>/jevarena-sim-check.mjs
```

---

## 7. Project Structure

```
src/PoMiniGames.Shared/Games/PoJevArenaShared.cs          # catalogs, bounds, presets, wire DTOs, JsonContext
src/PoMiniGames.API/Features/PoJevArena/
├── PoJevArenaEndpoints.cs          # all routes in §5
├── Jev/JevOptions.cs · JevClient.cs · JevWire.cs          # feature-owned Jev boundary (+ StubJevClient, Test env only)
├── JevPromptBuilder.cs             # validated unit state → state string + question set (pure)
├── JevCallAllowance.cs             # daily per-identity cap (write-behind over the ledger store)
├── ArenaMatchRegistry.cs           # in-memory match → rosters, decision count, reported flag
├── CreatureLibraryStore.cs         # PoJevArenaCreatures table
└── PoJevArenaLog.cs                # LoggerMessage source-gen
src/PoMiniGames.Client/Games/PoJevArena/
├── PoJevArenaPage.razor(.cs/.css)  # @page "/pojevarena", "/pojevarena/{ModeSegment}"; GameShell + GameIntro
├── CreatureFactory.razor           # form + budget meter + live animated preview canvas; validation mirrors Shared
├── CreatureLibrary.razor           # <Virtualize> list, sort/search, own-row edit/delete
├── RosterTrays.razor               # 2 × 10 slots, hot-seat hiding
├── JevInspector.razor              # probability bars, confidence, panic, stale timer
├── BlackBoxScrubber.razor          # transport controls + timeline
└── PoJevArenaApiClient.cs          # typed client, source-gen JSON, try/catch → null
src/PoMiniGames.Client/wwwroot/js/pojevarena/
├── index.js      # window.PoJevArena = { mount, preview, deploy, select, scrub, play, stop, unmount }
├── sim.js        # pure 60 Hz physics, melee, damage pipeline, match end (no DOM; node-runnable)
├── abilities.js  # registry id → handler (trigger, update, projectile) — the JS extension point
├── scheduler.js  # 250 ms staggered batches → dotnet.invokeMethodAsync('DecideAsync', json)
├── blackbox.js   # typed-array frame recorder + combat and decision event logs
├── creatures.js  # procedural silhouettes, faces, cached body bitmaps, animation state machine
├── fx.js         # per-ability wind-up/release/impact visuals, particles, popups, decals
└── render.js     # Canvas 2D composition: arena, units, HP bars, intent overlay, reduced-motion path
```

The platform lists that must be edited by hand: `GameCatalog.All`, `GameKeys`, Domain `GameKey`,
`MainLayout.GameRoutePrefixes`, `engineLoader.js` `REGISTRY`, `StorageInitializer.AdditionalTables`,
`EndpointRouteExtensions`, `GameServicesExtensions`, `RateLimitingExtensions`, `TestBudgetGuard`,
`infra/kv-secrets.bicep` and `infra/main.bicep`, and `CLAUDE.md` (slice list, game count 13 → 14).

---

## 8. Code Style & Conventions

```csharp
// Feature slice, relative group under the authenticated /api group (EndpointRouteExtensions).
public static RouteGroupBuilder MapPoJevArenaEndpoints(this RouteGroupBuilder api)
{
    var group = api.MapGroup("/pojevarena").WithTags("PoJevArena");
    group.MapPost("/matches/{matchId}/decisions", DecideAsync)
         .WithName("PoJevArenaDecide")
         .RequireRateLimiting("pojevarena-decide");
    return group;
}
```

```javascript
// sim.js stays pure: no DOM, no fetch, no Date.now() — time is the tick counter.
export function step(world, dt) { integrate(world, dt); collide(world); resolveCombat(world, dt); checkEnd(world); }
```

1. Files declare `namespace PoMiniGames.Features.PoJevArena` explicitly (the API's `RootNamespace` is pinned).
2. The client uses the `PoMiniGamesClient.*` namespace. `.cs` files need their `using`s; `.razor` files get them from `_Imports.razor`.
3. Every DTO the client serializes is registered in a source-generated `JsonSerializerContext` (trim-safe).
4. Colours come from `app.css` tokens. Team Blue and Red are scheme-invariant canvas tokens (`--jev-blue`, `--jev-red`).
5. `style="..."` is used only to pass runtime values into custom properties. Child-component rules in the page's scoped CSS use `::deep`.
6. Comments are contract-oriented and only where a real constraint needs recording.

---

## 9. Testing Strategy

**Framework**: xUnit + FluentAssertions (+ NSubstitute), Testcontainers Azurite, WebApplicationFactory, Playwright.
**There is no JS test tier and none will be added.** The engine is checked with a scratch `node` script during
development, and with E2E-UI.

| Tier | Ceiling | Today | PoJevArena adds (methods) | Room strategy |
|---|---|---|---|---|
| Unit | 100 | **104 — already failing the CI gate** | 4 | **T0: fold ≥ 8 existing facts into theories first** (to ≤ 96) |
| Integration | 50 | 49 | 1 | Store round-trip + commuting counter increments, one theory |
| E2E-API | 25 | **25 (full)** | 0 new methods | Add rows to an existing contract `[Theory]`, or fold two E2E-API facts to free one |
| E2E-UI | 25 | 20 | 1 | Factory → roster → deploy (stub Jev) → banner → scrubber |

Unit surface (theories):
1. `JevPromptBuilder_BuildsStateAndOptions` — base options plus one per ability, every registry row yields a unique
   option with criterion text, cooldown text in the state, metres and percentages, candidates omitted when absent.
2. `CreatureValidation_RejectsOutOfBoundsAndOffCatalog` — bounds, catalogs, unknown ability, two in one slot,
   over budget, every preset within budget, and names through the sanitizer.
3. `JevResponse_MapsOrFails` — well-formed answers, missing keys, unknown option, NaN or out-of-range probabilities, HTTP error → failure.
4. `CallAllowance_AndMatchRegistry_Contracts` — cap boundary, UTC-day reset, whole-batch rejection, result accepted once, owner-only, 40-decision minimum.

**Coverage target**: ≥ 90% line coverage of `JevPromptBuilder`, `JevCallAllowance`, `ArenaMatchRegistry` and the response
mapper. Canvas rendering is checked visually with screenshots, not unit tests.

---

## 10. Edge Cases & Error States

| Case | Behaviour |
|---|---|
| Jev key not configured | `status.configured=false`; Deploy disabled with "Jev unavailable — this arena needs Jev"; Factory, Library and Roster still work |
| 401 / 402 / 403 from upstream | Every unit in the batch fails and holds its intent; one banner: "Jev rejected the request (credits/key)" |
| 429 upstream / timeout / 5xx | Only that unit fails; it holds its last intent and shows stale in the inspector |
| Daily allowance exhausted mid-match | Proxy returns 429; units hold intents to the end of the match; banner "Daily Jev allowance reached — resets 00:00 UTC" |
| Allowance < 3,600 at Deploy | Deploy allowed with a warning showing the remaining calls (a match may end with stale units) |
| Answer arrives after the unit died or the match ended | Discarded (the call still counts against the allowance) |
| Answer names an option not offered | That unit fails, logged as schema drift |
| Tab hidden / backgrounded | Physics and scheduler pause (`visibilitychange`); no calls while paused |
| Library creature edited or deleted while in a saved roster | The match uses the frozen copy; on reload, deleted ids drop out of the saved roster with a toast |
| Owner at 25 creatures | 409 "Library limit reached — delete one to save another" |
| Name fails the sanitizer | 422 with the sanitizer's reason; the form keeps its input |
| Storage down | Library shows empty with "Library offline"; presets still work; result reporting returns 503 and is not retried |
| Host recycled mid-match (F1) | Decisions for an unknown match return 404; client shows "Match expired — redeploy"; stats not recorded |
| Guest signs in mid-session | Antiforgery re-armed by the existing client handler; match registration belongs to the new identity |
| Trim analyzer IL2xxx | Fix at the source (source-gen JSON); `TrimmerRoots.xml` only as a last resort, with a comment |

---

## 11. Boundaries

**Always**
- Build the Jev state and questions on the server, from validated structured input.
- Run targeted tests only, and keep `scripts/test-ceilings.ps1` green after every task.
- Restart the host after a code change and confirm `GET /health` returns 200 before calling it done.
- Call `ArmAntiforgeryAsync()` in every test that writes to `/api`.
- Make sure no test can reach the real Jev endpoint (`TestBudgetGuard`).

**Ask first**
- Adding PoJevArena to the kiosk rotation (Open Question 1).
- Raising `DailyCallsPerIdentity` or `MaxConcurrentCalls`, or switching the model to `jev-latest`.
- Any schema change to shared tables or to `IAiTokenLedgerStore` beyond parameterizing its table name.
- Any new package, including the NET_START `ponytail` plugin. It is a user-scope Claude Code plugin the user installs with `/plugin`, not a repo dependency.

**Never**
- A local or heuristic decision fallback outside the `Test` environment.
- A generic Jev pass-through that forwards client-supplied text or questions.
- Radzen, `dotnet user-secrets`, or a committed key.
- Raising a test ceiling, running the full suite unprompted, or pushing without being asked.

---

## 12. Out of Scope (v1)

1. Online multiplayer or spectating (the simulation is local to one browser).
2. Saving or sharing Black Box replays (only the kill-cam clip is shareable, since 2026-09-30).
3. Leaderboards or player Elo. *(Creature Elo landed 2026-09-30, see §15.)*
4. Free-text personality or quirks; player-built arenas. *(Three fixed hazard maps landed 2026-09-30, see §15.)*
5. Abilities beyond the six in §4.1.1, and a third ability slot. The registry is built for both, but neither ships in
   v1. Status effects other than poison.
6. Moderation tooling beyond the name sanitizer and owner delete (no reporting or admin UI).
7. Kiosk rotation (pending Open Question 1).
8. A server-side re-simulation or anti-cheat for results (only the decision-count gate).

---

## 13. Success Criteria

1. `dotnet build PoMiniGames.slnx` reports 0 warnings and 0 errors, and `dotnet format --verify-no-changes` passes.
2. `pwsh scripts/test-ceilings.ps1` passes: Unit ≤ 100 (repairing today's 104), Integration ≤ 50, E2E-API ≤ 25, E2E-UI ≤ 25.
3. All new PoJevArena tests pass in each tier (`--filter FullyQualifiedName~PoJevArena`).
4. The trimmed client publish has 0 IL2xxx warnings, and `_framework` stays ≤ 25 MB (size recorded before and after).
5. `/pojevarena/1player`, `/pojevarena/2player` and `/pojevarena/demo` render with no console errors, and the game card appears on the home page.
6. With a real key: a full 10v10 match finishes. Server logs show ≤ 20 upstream calls/s, a p95 proxy batch latency is recorded,
   and the summed `usage.cost` per match is ≤ $0.15.
7. Physics runs at 60 Hz with 20 units, 20 projectiles and gizmos (frame p95 ≤ 16.7 ms in Chromium on the dev machine, measured with the Performance panel).
8. With the stub in the E2E-UI host, the whole Journey 1 flow (save → draft 10 + 10 → deploy → banner → scrub) passes.
9. The Black Box scrubs to any frame in ≤ 50 ms, and the inspector shows the recorded distribution for that unit at that frame.
10. Library: a creature saved by user A is visible to user B, B cannot edit or delete it (403), and the 26th save returns 409.
11. After a match, every library creature that fought has deployed + 1 and exactly one of wins/losses/draws + 1. Two
    concurrent results on the same creature both apply (integration test).
12. Anonymous calls to every PoJevArena route return 401, and writes without antiforgery return 403 (E2E-API contract rows).
13. The 20,001st call of the day returns 429 with `Retry-After`, and the count survives a host restart (unit + integration).
14. Without a key, the app boots, `status.configured=false`, and Deploy is disabled.
15. **Readability**: in a screenshot taken mid-battle, each of the five presets can be identified by silhouette alone
    (grey-scaled image), and the team is identifiable without colour (base ring vs diamond). This is judged against
    a screenshot sheet with one row per preset in both teams, idle, melee, ability and defense poses.
16. **Animation coverage**: every registry ability, plus melee, death and panic, has a visible wind-up, release and
    impact, shown in the Factory preview cycle and captured as a Playwright screenshot per ability.
17. Every creature can melee: with scripted decisions in the `node` harness, a creature with no abilities damages an
    enemy through `melee_charge`.
18. **Extension check**: a throwaway branch adds a seventh ability by touching exactly the registry row, one
    `abilities.js` handler and one `fx.js` visual. Build and the unit theories pass, and Jev is offered the new option.
    The branch is discarded afterwards.
19. Render cost is ≤ 8 ms/frame p95 with 20 units under maximum effects (§4.8 budget), measured in the Chromium
    Performance panel.

---

## 14. Open Questions (defaults apply unless answered)

1. **Kiosk rotation** — should PoJevArena join `GameCatalog.Demo`? An unattended kiosk spends about $0.07 per match
   from the signed-in account's allowance. *Default: no.*
2. **PoCabinet is missing from `MainLayout.GameRoutePrefixes`**, so the footer shows on its routes. This predates
   PoJevArena. Fix it in the same one-line edit? *Default: yes.*
3. **Which endpoint** — `/api/v1/systemone` (documented as SDK-compatible, not marked alpha) or the
   `/api/alpha/decisions` the deleted client used? *Default: systemone; it's a config value, so switching is free.*
4. **OpenRouter's Jev rate limit is unpublished.** The first real-key smoke run records the 429 rate at 20 calls/s.
   If it's above 1%, `MaxConcurrentCalls` drops to 8. *Default: measure, then decide.*
5. **Profile radar** (`ProfilePage.GameDefs`) — PoJevArena has no player rating. *Default: leave it out.*
6. **Build budget** — without one, a library sorted by win rate converges on "max everything plus shell". *Default:
   80 points as in §4.1. The costs are registry and constant data, so tuning later is a data change, and existing
   creatures that go over a lowered budget stay playable but can't be re-saved until trimmed.*

---

## 15. Additions (2026-09-30)

- **Hazard maps.** `sim.js` `ARENAS`: three fixed layouts (Four Pillars, The Diamond, Tar Mire), picked by
  `seed % 3` so a replay rebuilds the same map. Pillars block bodies and projectiles; brush softens ranged hits
  (×0.7); tar slows to half speed and burns 2 HP/s. Jev gets a fourth base option, `take_cover` ("move behind the
  nearest pillar"), and the state carries `coverDistanceM` / `inBrush` / `inTar`, which the server validates and
  words (`JevPromptBuilder`, pinned by the `hazards` snapshot). Pillar avoidance keeps its dodge side per pillar,
  or units dither against the stone when their target circles it.
- **Creature rating and careers.** Each library creature carries a head-to-head Elo (`PairwiseEloCalculator`,
  own default instance: seed 1000, K 24, floor 100), priced against the average rating of the ten it faced, applied
  as an increment under the ETag like the win counters. The result report adds per-slot kills/damage/heals and the
  engine's MVP; the server clamps them and adds them to careers (`Kills`, `DamageDealt`, `Mvps`). The library sorts
  by `rating` (unrated rows count as the seed until they have 3 fights).
- **Drafting.** `+ Blue` / `+ Red` on every card replace the active-team mode; per-team Fill, Copy Blue (1P), and
  named Squads in localStorage (`pojevarena.squads.v1`, 20 max); Fork any card into the Factory; library filter by
  owner, ability or temperament. The Factory is a drawer with chip pickers. Hot-seat is Lock & pass → Lock & deploy.
- **Presentation (render/audio only; the sim never reads any of it).** Synthesized SFX and creature voices on the
  `PoAudioBus` sfx bus (`audio.js`); `PoMusicDirector` tension from the share of units in melee; Jev decision blooms;
  a WebGL2 grade pass over the 2D canvas (`postfx.js`, optional); auto camera and late-knockout slow motion (sim time,
  so no extra Jev calls); a floor stain canvas that keeps the whole fight; and at the whistle a kill cam (recorded as a
  shareable WebM) and a victory ceremony before `OnMatchEnded`. Both are skippable and skipped under reduced motion.
- **Feel and length (later the same day).** Every blow that lands (not poison or tar) shoves its victim along the
  blow's line: impulse ÷ effective mass (bracing and shelling resist), the victim's closing speed cancelled, and a
  0.18–0.45 s stagger with no steering or new swings; the striker's follow-through stops on contact. Colliders are
  1.15× the drawn body and contacts relax over 3 passes. Creatures fight on one fifth of their designed HP (`BattleHp`; the
  factory, cards, inspectors and Jev's prompt all show battle HP), so matches last seconds, not minutes. The live battle is full screen; Tab (or the Stats button) shows the
  telemetry columns and the HUD pill. The debrief closes with a story per creature: lifetime, killer, phases of
  thinking with HP at each change, confidence, targeting, panics and numbers.
- **Real locomotion (later still).** Movement is forces on Earth: legs push (grip-limited at μ·m·g and power-limited at
  P/v), bodies without footing skid on kinetic friction, air drag and tar resist, and masses are 24–120 kg. Leg work
  drains a critical-power/W′ reserve: cruising is sustainable, sprints and every burst of acceleration spend it, and an
  empty reserve leaves 40% leg power and no sprinting until it recovers. Jev reads `Stamina: 35% (tiring)`; the arena
  shows it as a strip under the HP bar, and creatures lean into acceleration and pant when tired. Measured: a
  48 kg cruiser reaches 9 m/s in ~2 s and stops from 9 m/s in 1.45 s over 4.8 m. Boulders fly a ballistic arc
  (½·g·t·(T−t)), clearing bodies mid-flight and landing where they were aimed.
