# E2EAPI

C# end-to-end **API** tests — pure HTTP calls that emulate functionality against
the in-process host. No browser. Browser/UI coverage lives in the sibling
[`E2EUI`](../E2EUI/) project.

These replaced the legacy Playwright JavaScript spec suite (`tests/e2e/`, removed
during the 2026-06-23 §5 migration to satisfy the "Unit & Integration: C# only" rule).

## What runs here

- **`ApiContractSmokeTests`** — verifies the public HTTP shape of the BFF
  (`/api/health/ping`, `/api/auth/handshake`, fake-auth header flow).
- **`HomeSmokeTests`** — verifies that the root path and deep links return the
  WASM shell `index.html` (SPA fallback contract).
- **`DeploymentSmokeTests`** — verifies the routes the Azure availability
  test pings in production (`/health`, `/api/auth/handshake`, `/openapi/v1.json`).

Each test follows the `PoMiniGamesE2EFixture` pattern: spin the host in-process
via `WebApplicationFactory<Program>`, force `Auth:EnableFakeAuth=true` so
`[Authorize]`-guarded routes are reachable, and assert against the HTTP contract
(status code + JSON shape) rather than the rendered DOM.

## Running

```pwsh
# from repo root — requires Azurite on 127.0.0.1:10002 (scripts/setup.ps1)
dotnet test tests/E2EAPI/E2EAPI.csproj
```