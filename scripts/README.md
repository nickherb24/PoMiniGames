# scripts/

Working scripts only — the one-off debug files that used to live here were removed in
the 2026-08-18 cleanup (they referenced files that no longer exist and had no callers).

| Script | Purpose | Called from |
|---|---|---|
| `test-all.ps1` | Full CI-equivalent test run (Unit → Integration → E2E-API → E2E-UI); frees port 5080, starts Azurite, installs Playwright | README.md, E2E-UI csproj |
| `setup.ps1` | One-time dev-machine setup | E2E-API fixture docs |
| `smoke-local.ps1` | Local smoke of the running app | `.vscode/tasks.json` |
| `deploy-preflight.ps1` | Pre-`azd up` checks | on demand |
| `bundle-report.ps1` | Trimmed WASM bundle size report (top-DLLs + per-CSS breakdown) | test-all.ps1 snapshot pointer |
| `coverage-matrix.ps1` | Cross-tier route-coverage matrix over the four dotnet test tiers | on demand |
| `coverage-report.ps1` | Merges the four tiers' Cobertura output into one HTML line-coverage report | on demand |

The one-off asset pipelines (PoMarbleRace track baking, PoSports sprite-sheet
re-export) and the counting helper were removed on 2026-09-11 — their inputs,
outputs, or docs no longer exist. Development is Windows/`pwsh`.

`test-ceilings.ps1 [-NoBuild]` runs only the four method-budget guards, skips browser installation, and fails if any guard is absent or over budget.
