# PoMiniGames

Instant-play mini-games platform: a .NET 10 Minimal API host that also serves its
Blazor WebAssembly client from a single origin (port 5080), with SignalR for real-time
multiplayer, Azure Table Storage for persistence, and Azure AI Foundry behind the
AI-powered games.

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

- Auth: Microsoft Entra (BFF cookie pattern) plus guest login; leaderboard reads are
  anonymous, all game-data writes require auth + antiforgery.
- UI is native Blazor + plain CSS by design — no heavy component libraries.
- Offline-friendly PWA: finished scores park locally and sync on reconnect/sign-in.
- Deploy: `azd up` (App Service F1, resource group `PoMiniGames`).

PoRacer ranks **best completed laps**, separately from final race times. Its legacy JSON
field and Azure Table column `totalTimeSeconds` / `TotalTimeSeconds` retain their names
for stored-score compatibility; existing rows are preserved without inferred conversion.
Run `pwsh scripts/test-ceilings.ps1` to check all four test-method budgets without Docker.
CI validates Bicep and deploys application code; use `azd up` for resource provisioning.
