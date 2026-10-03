# PoMiniGames

Instant-play mini-games platform: a .NET 10 Minimal API host that also serves its
Blazor WebAssembly client from a single origin (port 5080), with SignalR for real-time
multiplayer, Azure Table Storage for persistence, and Azure AI Foundry behind the
AI-powered games.

## Overview

Fourteen small games on one website. The browser runs each game in full, including its
computer opponents; the server signs players in, referees online play, checks and stores
scores, and talks to AI models on the player's behalf.

- **One origin.** The API host serves the Blazor client it is then called by, so there is no
  cross-site setup in production.
- **Each game is a Razor page plus a JavaScript engine** (`wwwroot/js/<game>/`), loaded on
  demand and wired together with JS interop callbacks.
- **Online play runs over 15 SignalR hubs.** Match, lobby and race state is held in server
  memory and is lost on restart.
- **No database.** Scores, ratings, saves and AI spend ledgers live in Azure Table Storage;
  PoEcosystem world files live in Blob Storage. A player is whoever the sign-in token says
  they are; there is no Player table.
- **Computer opponents are hand-written rules, not trained models.** Difficulty is a table of
  numbers in source. The exceptions are hosted models: Azure AI Foundry chat models write
  jokes, quizzes, banter and chronicles, and TypeSafe's Jev makes PoJevArena's battle calls.
  Each has a daily cap per player and a scripted fallback.
- **Works offline.** A score that cannot reach the server is parked in the browser and sent
  automatically later.

### Documentation

| Document | What it covers |
|---|---|
| [Architecture & game loop](DOCS/20261003/architecture_overview.md) | How agents look, decide and act; scoring rules; tuning settings |
| [Agent & rig inventory](DOCS/20261003/model_summary.md) | Every computer-controlled character, its source file and physics setup |
| [Creature dashboard](DOCS/20261003/creatures_dashboard.html) | Abilities grid with an Executive / Technical toggle |
| [Level & arena setup](DOCS/20261003/scene_layout.html) | To-scale arena drawings, spawn points, hazards, collision layers |
| [Performance comparison](DOCS/20261003/creature_benchmarks.html) | Skill by difficulty, smoothness, update rates and running cost |
| [Training charts guide](DOCS/20261003/training_metrics_guide.md) | The four training charts in plain English, and what stands in for them here |
| [Architecture map](https://claude.ai/artifact/HGHLwMdGyveqtknNC1o5ar) | Component diagrams, request flows and the data model (private link; share it from the page to give others access) |

## Games (`src/PoMiniGames.Client/Games/`)

| Game | One-liner |
|---|---|
| TicTacToe | 4-in-a-row on 6×6 vs AI, hot-seat, or online quick-match (SignalR) |
| ConnectFive | Five-in-a-row vs AI, hot-seat, or online quick-match (SignalR) |
| PoBrawl | Physics brawler with a presidents ladder + fighter Elo demo board |
| PoCoupleQuiz | Two-player realtime couples quiz (SignalR) |
| PoFunQuiz | AI-generated multiplayer quiz lobby |
| PoJoker | AI joke judge with a grandma audience |
| PoMarbleRace | Physics marble race on baked GLB tracks; online 2-player via host-streamed physics |
| PoRacer | Canvas racer with WebGL effects, solo races, and a multiplayer lobby |
| PoCabinet | 3D circuit racer: solo career across four tracks, AI officials, and a server-simulated online lobby |
| PoSports | Sprite-based sports mini-game |
| PoVoxelStrike | Third-person survival shooter with fully destructible voxel structures |
| PoJevArena | Design creatures, draft 10 v 10, and watch TypeSafe's Jev make every tactical call; post-match Black Box scrubber |
| PoEcosystem | Watch-only island simulation: species, tribes and an AI-written chronicle; cloud save slots and a shared gallery |
| SandPlayground | GPU sand-and-water sandbox |

## Quick start

```powershell
# prerequisites: .NET SDK 10.0.400 (global.json), Docker
docker compose up -d azurite                                  # local table storage
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj
# → http://localhost:5080  (API + client, one origin)

pwsh scripts/test-all.ps1                                     # full test suite
```

## Layout

```
src/
├── PoMiniGames.API/            Host + vertical feature slices (Features/<Slice>)
├── PoMiniGames.Client/         Blazor WASM client (assembly: PoMiniGamesClient)
├── PoMiniGames.Infrastructure/ Table Storage, HighScoreDescriptor<T> leaderboards
├── PoMiniGames.Domain/         Domain primitives (EloCalculator, GameKey, ...)
└── PoMiniGames.Shared/         DTOs shared between client and server
tests/
├── PoMiniGames.Unit/           ≤100 tests (hermetic)
├── PoMiniGames.Integration/    ≤50 tests (Testcontainers Azurite)
├── PoMiniGames.E2EAPI/         ≤25 tests (HTTP contract)
├── PoMiniGames.E2EUI/          ≤25 tests (Playwright)
└── Shared/                     TestBudgetGuard (no test ever spends AI tokens)
infra/                          Bicep (azd); deployed by .github/workflows/deploy.yml
scripts/                        Working scripts only — see scripts/README.md
```

## Notes

- Auth: Microsoft Entra sign-in in the browser (MSAL), sent to the API as a bearer token.
  Guest login exists only in Development/Test and only from loopback. The whole app sits
  behind the sign-in gate; leaderboard reads are anonymous at the API, and all game-data
  writes require auth + antiforgery.
- UI is native Blazor + plain CSS by design — no heavy component libraries.
- Offline-friendly PWA: finished scores park locally and sync on reconnect/sign-in.
- Deploy: `azd up` (App Service F1, resource group `PoMiniGames`).

PoRacer ranks **best completed laps**, separately from final race times. Its legacy JSON
field and Azure Table column `totalTimeSeconds` / `TotalTimeSeconds` retain their names
for stored-score compatibility; existing rows are preserved without inferred conversion.
Run `pwsh scripts/test-ceilings.ps1` to check all four test-method budgets without Docker.
CI validates Bicep and deploys application code; use `azd up` for resource provisioning.
