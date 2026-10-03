# Training Charts Explained in Plain English

Snapshot date: 2026-10-03. See also [architecture_overview.md](architecture_overview.md) and
[creature_benchmarks.html](creature_benchmarks.html).

---

## Tier 1: Quick Look (30 seconds)

Training tools such as TensorBoard draw four charts that tell you whether an AI is learning.
This guide explains each one without maths.

**PoMiniGames has none of these charts**, because nothing in it is trained. Its opponents
are hand-written rules, and its language models are rented, already trained. So this guide
does two jobs:

1. It explains the four charts, so the vocabulary is there if a trained agent is ever added.
2. For each chart it names the closest thing you *can* watch in this project today.

| Chart | Nickname | The one question it answers |
|---|---|---|
| Cumulative Reward | The Scoreboard | Is it winning more often? |
| Episode Length | Survival Time | Is it finishing faster or lasting longer? |
| Policy Loss | Confusion Level | Is it still changing its mind, or has it settled? |
| Entropy | Curiosity | Is it still trying new things? |

---

## Tier 2: Core Mechanics

### Cumulative Reward: "The Scoreboard"

**What it shows.** The average score the agent earned per attempt, plotted over training
time.

**What to watch for.**

- **Climbing, then flattening:** healthy. It learned, then ran out of things to improve.
- **Flat from the start:** it is not learning. The scoring rules are probably too hard to
  stumble into, or the agent cannot sense what it needs.
- **Climbs, then falls off a cliff:** it found a trick, then lost it. Training is unstable.
- **Sawtooth:** normal when the task gets harder in stages.

**Closest thing here.** The game's own results:

| Game | What plays the role of the scoreboard |
|---|---|
| TicTacToe, ConnectFive | The player's rating. The CPU is tied to it, so a rising rating means a stronger CPU next game. |
| PoBrawl | The demo rating board (CPU against CPU), stored in cloud storage, not in the repo. |
| PoCabinet, PoRacer | Finishing position and best lap. |
| PoMarbleRace | Placing in the top 10 of 101. |
| PoEcosystem | Population counts over the years. |

### Episode Length: "Survival Time"

**What it shows.** How long each attempt lasted before it ended.

**What to watch for.** Which direction is good depends on the task.

- **Survival tasks** (stay upright, stay alive): longer is better.
- **Goal tasks** (reach the flag, win the race): shorter is better.
- **Stuck at the maximum:** the agent never finishes; it only times out.
- **Stuck near zero:** it fails immediately every time.

**Closest thing here.**

| Game | Round length | Which direction is "good" for the CPU |
|---|---|---|
| PoBrawl | 60 s cap | Shorter (a quick knockout) |
| PoJevArena | 180 s cap | Shorter (a team wipe) |
| PoVoxelStrike | No cap | Shorter for the monsters, longer for the player |
| PoSports | 9.5 to 14 s per leg by design | Shorter |
| PoRacer | 3 laps, 180 s cap | Shorter |
| PoEcosystem | Until the animals die out | Longer |

### Policy Loss: "Confusion Level"

**What it shows.** How much the agent's strategy changed on each training update.

**What to watch for.**

- **Bumpy early, calmer later:** healthy. Big changes at first, small refinements at the end.
- **Huge spikes late on:** something is destabilising it. Often the learning pace is too high.
- **Dead flat at zero from the start:** it is not updating at all.

Do not read this chart alone. A low value only says the agent stopped changing, not that it
stopped at a good strategy. Check the Scoreboard alongside it.

**Closest thing here.** There is no equivalent. Rule-based agents never change their
strategy, so their "confusion" is permanently zero. The nearest observable is *consistency*:

- **Fully repeatable:** ConnectFive at top strength, PoCabinet racers, PoEcosystem per world
  seed. Same situation, same answer, every time.
- **Dice involved but seeded:** PoBrawl, PoSports. Repeatable if you fix the seed.
- **Not repeatable:** PoVoxelStrike monsters and PoRacer steering wobble use unseeded dice.

### Entropy: "Curiosity / Exploration"

**What it shows.** How random the agent's choices are.

**What to watch for.**

- **Starts high, drifts down slowly:** healthy. It explored, then committed.
- **Crashes to zero early:** it committed too soon and is repeating one habit. It may never
  find a better one.
- **Stays high forever:** it never commits. Its behaviour will look jittery.

**Closest thing here.** The hand-set randomness knobs. These are the same idea, except a
designer chose the number instead of training lowering it.

| Agent | Randomness knob | Range |
|---|---|---|
| TicTacToe CPU | Chance of a deliberately random move | 55% at the lowest rating, 5% at the highest |
| ConnectFive CPU | Chance of a deliberately random move | 60% at the lowest rating, 0% at the highest |
| PoBrawl boxer | Dice on block, punish, bait and combo | Block chance 16% (rung 1) to 97% (rung 15) |
| PoSports runner | Typing error rate, jump timing wobble | 0.8% to 1% errors; wobble 40% down to 15% |
| PoCabinet official | "Wildness": chance of misjudging a corner | 1% to 12% |
| PoRacer bot | Steering wobble | About 0.3% to 0.8% of ticks |
| PoEcosystem creature | Personality mutation between generations | 0.08 standard deviation per trait |

### Agent Comparison Grid

The template asks for a Low / Medium / High / Healthy rating on each chart. Those charts do
not exist here, so each cell rates the **closest observable** described above, taken from the
code and tuning tables. It is a design reading, not a measurement.

Key: **Scoreboard** = how much evidence of results exists. **Survival Time** = whether rounds
end in a healthy way. **Confusion** = how consistent the behaviour is (Low is good).
**Curiosity** = how much randomness is built in.

| Agent | Scoreboard (evidence of results) | Survival Time (round endings) | Confusion (inconsistency) | Curiosity (randomness) | Ready for the game? |
|---|---|---|---|---|---|
| TicTacToe CPU | Low: no strength tests | Healthy: every game ends in a win or a full board | Low | Medium: 5% to 55% by rating | Yes, already live |
| ConnectFive CPU | Low: no strength tests | Healthy | Low | Medium: 0% to 60% by rating | Yes, already live |
| PoBrawl boxers | Medium: live rating board, none stored in repo | Healthy: 60 s cap with a draw band | Low | High at low rungs, Low at top rungs | Yes, already live |
| PoVoxelStrike monsters | Low | Healthy: escalates until the player wins or dies | Medium: frame-rate dependent, unseeded | Medium | Yes, already live |
| PoVoxelStrike wall guns | Low | Healthy: a gun dies when its wall falls | Low | Low: small aim spread | Yes, already live |
| PoSports runners | Medium: design target of 9.5 to 14 s per leg | Healthy | Low | Low | Yes, already live |
| PoCabinet racers | High: five recorded laps, lap-time test bounds | Healthy: 15 s grace after the winner | Low: fully repeatable | Low: 1% to 12% | Yes, already live |
| PoRacer bots | Medium: lap times noted in code comments | Healthy: 180 s cap, rescue after 2 s stuck | Medium: unseeded wobble | Low | Yes, already live |
| PoMarbleRace marbles | High: every map must finish 96 of 101 in tests | Healthy: 180 s cap, nudge when stalled | Low | None: no brain | Yes, already live |
| PoEcosystem creatures | Medium: extinction counts noted in a code comment | Healthy: ends only when the animals are gone | Low: repeatable per seed | Medium: mutation plus personality | Yes, already live |
| Jev (PoJevArena) | Low: answer quality is not measured anywhere | Healthy: 180 s cap | Not known: external model | Not known: external model | Yes, already live; quality unmeasured |
| Chat-model agents (jokes, quizzes, banter, chronicle) | Low: tests cover parsing and fallbacks, not quality | Healthy: 20 s cap with fallbacks | Not known: external model | Not known: temperature is never set | Yes, already live; quality unmeasured |

**Reading the grid.** The weakest column is the Scoreboard. Most agents have never had their
skill measured. If you want to know how good an opponent really is, that is the gap to close
first (see Tier 3).

---

## Tier 3: Setup Guide

### Getting real numbers for this project

No training setup is needed. These are the practical ways to produce the measurements the
grid above is missing.

| To measure | How | Effort |
|---|---|---|
| Board-game CPU strength | A unit test that plays CPU against CPU at two rating rungs for a few hundred games and asserts the higher rung wins more. Both AIs are pure C# and need no browser. | Small |
| PoBrawl boxer strength | Read the existing demo rating board at `/api/leaderboards/pobrawldemo` after demo mode has run for a while. | None, data accrues by itself |
| PoRacer bot lap times | Run an all-bot race per difficulty tier and log best laps from the server sim. | Small |
| PoEcosystem balance | Run the simulation headless for a fixed number of years across several seeds and record which species survive. | Medium |
| Hosted-model quality | Collect a fixed set of inputs and review the answers by hand. Cost per run is real money, so keep the set small. | Medium, costs tokens |

Tests in this repo must never spend hosted-model tokens. `tests/Shared/TestBudgetGuard.cs`
forces every game onto canned answers; leave that in place.

### If you add a trained agent later

| Setting in plain language | What to start with | What to watch on the charts |
|---|---|---|
| Learning pace | Low and steady | Spikes in Confusion Level mean it is too high |
| How far ahead it plans | Long enough to cover one full round | A flat Scoreboard can mean it is too short |
| Memory size | Larger is safer but slower | A wobbly Scoreboard can mean it is too small |
| Exploration rate | Moderate | Curiosity crashing to zero early means it is too low |

Save the four charts as images beside the model file, and add its row to
[model_summary.md](model_summary.md).
