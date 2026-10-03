# E2EUI

C# end-to-end **UI** tests — real-browser coverage driven by
[Microsoft.Playwright](https://playwright.dev/dotnet/) against the live host.
Pure HTTP-contract checks (no browser) live in the sibling
[`E2EAPI`](../E2EAPI/) project.

## How it works

`KestrelServerFixture` boots the real host on a dynamic **Kestrel** port (the
default `WebApplicationFactory` TestServer is in-memory and unreachable by a
browser). Tests navigate to `fixture.ServerAddress` with Playwright and assert
the rendered Blazor WASM UI.

- **`HomePageUiTests`** — launches headless Chromium, navigates to `/`, waits for
  network idle, and asserts the WASM client booted (title + `#app` content).

## Prerequisites

1. **Azurite** on `127.0.0.1:10002` — `scripts/setup.ps1` brings it up.
2. **Playwright browsers** (one-time per machine), installed from the build
   output after a first `dotnet build`:

   ```pwsh
   pwsh tests/PoMiniGames.E2EUI/bin/Debug/net10.0/playwright.ps1 install chromium
   ```

## Running

```pwsh
# from repo root
dotnet test tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj
```

> **Not run in CI** by default (needs browser binaries). Per repo UPDATES,
> the `.github/workflows/deploy.yml` runs only the Unit tier; this tier is run locally
> via `scripts/test-all.ps1` or in an environment that supplies Azurite + browsers.