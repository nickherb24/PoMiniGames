# scripts/

Working scripts only — the one-off debug files that used to live here were removed in
the 2026-08-18 cleanup (they referenced files that no longer exist and had no callers).

| Script | Purpose | Called from |
|---|---|---|
| `test-all.ps1` | All four test tiers (Unit → Integration → E2E-API → E2E-UI); frees port 5080, starts Azurite, installs Playwright. CI itself runs only the Unit tier. | README.md, E2E-UI csproj |
| `setup.ps1` | One-time dev-machine setup | E2E-API fixture docs |
| `smoke-local.ps1` | Local smoke of the running app | `.vscode/tasks.json` |
| `bundle-report.ps1` | Trimmed WASM bundle size report (top-DLLs + per-CSS breakdown) | test-all.ps1 snapshot pointer |
| `coverage-matrix.ps1` | Cross-tier route-coverage matrix over the four dotnet test tiers | on demand |
| `css-lint.ps1` | Structural check of every stylesheet (unterminated comments, unbalanced braces) | `deploy.yml`; run it after any scripted CSS edit |
| `test-ceilings.ps1` | The four test-method budget guards, without Docker or browsers | `deploy.yml`, README.md |

The one-off asset pipelines (PoMarbleRace track baking, PoSports sprite-sheet
re-export) and the counting helper were removed on 2026-09-11 — their inputs,
outputs, or docs no longer exist. Development is Windows/`pwsh`.

`test-ceilings.ps1 [-NoBuild]` runs only the four method-budget guards, skips browser installation, and fails if any guard is absent or over budget.
