#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Singular, CI-equivalent test orchestrator for PoMiniGames. Runs the full tiered
  suite (Unit -> Integration -> E2E-API -> E2E-UI) the same way locally and in CI.
.DESCRIPTION
  Preflight (idempotent):
    1. Free the host lock — a running `dotnet run` host (port 5080) locks the build
       output DLLs and breaks a full-solution build. Kill only that host, never the
       unrelated dotnet processes (MCP servers, language servers).
    2. Bring up the shared Azurite container (the E2E-API tier binds 127.0.0.1:10002).
       The Unit tier needs nothing; Integration and E2E-UI spin their own Azurite via
       Testcontainers.
    3. Install the pinned Playwright Chromium build (no-op if already present).
    4. Build once with -warnaserror honored.
  Then each tier runs in order, results roll up, and structural ceilings
  (the 100/50/25/25 Rule) are checked. Exit code is non-zero on any tier failure.
.NOTES
  Method ceilings fail through TierCeilingGuard; discovered cases are reported separately so coverage is never deleted
  to satisfy a counter; runaway growth still surfaces immediately in the summary.
#>

param(
    [switch]$SkipPlaywrightInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$slnx = Join-Path $repoRoot 'PoMiniGames.slnx'

function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }

# ── Preflight 1: free the host lock (scoped, not a blanket dotnet kill) ───────
Write-Step 'Freeing host lock (port 5080 + PoMiniGames host process)'
try {
    $conns = Get-NetTCPConnection -LocalPort 5080 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Ok "Stopped process $($c.OwningProcess) holding port 5080"
    }
} catch { Write-Warn "Port 5080 check skipped: $($_.Exception.Message)" }
Get-Process -Name 'PoMiniGames' -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Write-Ok "Stopped host process PoMiniGames ($($_.Id))"
}

# ── Preflight 2: shared Azurite for the E2E-API tier ─────────────────────────
Write-Step 'Ensuring shared Azurite container (E2E-API tier)'
if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker compose -f (Join-Path $repoRoot 'docker-compose.yml') up -d | Out-Null
        Write-Ok 'Azurite container "pominigames" is up'
    } catch { Write-Warn "Could not start Azurite: $($_.Exception.Message)" }
} else {
    Write-Warn 'Docker not available — E2E-API/Integration storage tiers may fail.'
}

# ── Preflight 3: build once ──────────────────────────────────────────────────
Write-Step 'Building the solution (warnings are errors)'
dotnet build $slnx -c Debug --nologo -v minimal

# ── Preflight 3b: bundle-size snapshot (non-blocking) ────────────────────────
# Cheap check: if the previous Release publish still exists under
# src/PoMiniGames.Client/bin/Release/net10.0/wwwroot/_framework, print its
# current size so a developer iterating on UI changes can spot regressions
# without paying for a fresh publish. The full report (top-DLLs + per-CSS
# breakdown) lives in scripts/bundle-report.ps1 and runs on demand.
Write-Step 'Bundle-size snapshot (non-blocking)'
$frameworkDir = Join-Path $repoRoot 'src/PoMiniGames.Client/bin/Release/net10.0/wwwroot/_framework'
if (Test-Path $frameworkDir) {
    $size = (Get-ChildItem -Path $frameworkDir -Recurse -File |
        Measure-Object -Property Length -Sum).Sum
    $sizeMb = [math]::Round($size / 1MB, 2)
    $budget = 25
    if ($sizeMb -gt $budget) {
        Write-Warn "_framework is $sizeMb MB — over the $budget MB cap. Run scripts/bundle-report.ps1 for the top-DLL breakdown."
    } else {
        Write-Ok "_framework is $sizeMb MB / $budget MB cap (headroom $([math]::Round($budget - $sizeMb, 2)) MB)"
    }
} else {
    Write-Warn "No Release publish output at $frameworkDir — run scripts/bundle-report.ps1 to populate."
}

# ── Preflight 4: Playwright browsers ─────────────────────────────────────────
if (-not $SkipPlaywrightInstall) {
    Write-Step 'Ensuring Playwright Chromium (E2E-UI tier)'
    $pw = Join-Path $repoRoot 'tests/PoMiniGames.E2EUI/bin/Debug/net10.0/playwright.ps1'
    if (Test-Path $pw) {
        try { & $pw install chromium | Out-Null; Write-Ok 'Playwright Chromium ready' }
        catch { Write-Warn "Playwright install failed: $($_.Exception.Message)" }
    } else { Write-Warn "Playwright script not found at $pw" }
}

# ── Tiered run ───────────────────────────────────────────────────────────────
# Tier name -> @{ Project; Ceiling } (the per-tier test-count caps).
$tiers = [ordered]@{
    'Unit'        = @{ Project = 'tests/PoMiniGames.Unit/PoMiniGames.Unit.csproj';                       Ceiling = 100 }
    'Integration' = @{ Project = 'tests/PoMiniGames.Integration/PoMiniGames.Integration.csproj';         Ceiling = 50 }
    'E2EAPI'      = @{ Project = 'tests/PoMiniGames.E2EAPI/PoMiniGames.E2EAPI.csproj';                  Ceiling = 25 }
    'E2EUI'       = @{ Project = 'tests/PoMiniGames.E2EUI/PoMiniGames.E2EUI.csproj';                    Ceiling = 25 }
}

$summary = @()
$anyFailed = $false

foreach ($name in $tiers.Keys) {
    $proj = $tiers[$name].Project
    $ceiling = $tiers[$name].Ceiling
    Write-Step "Running $name tier"

    $output = dotnet test (Join-Path $repoRoot $proj) --no-build -c Debug --nologo 2>&1
    $output | ForEach-Object { Write-Host $_ }

    $line = ($output | Select-String -Pattern 'Passed:\s*\d+|Failed:\s*\d+|Total:\s*\d+' | Select-Object -Last 1)
    $passed = 0; $failed = 0; $total = 0
    if ($line -match 'Failed:\s*(\d+).*Passed:\s*(\d+).*Total:\s*(\d+)') {
        $failed = [int]$Matches[1]; $passed = [int]$Matches[2]; $total = [int]$Matches[3]
    }

    $tierFailed = ($LASTEXITCODE -ne 0) -or ($failed -gt 0)
    if ($tierFailed) { $anyFailed = $true; Write-Err "${name}: $failed failed / $total total" }
    else { Write-Ok "${name}: $passed passed / $total total" }

    # Discovered theory cases are runtime work, not the method ceiling.
    # TierCeilingGuard fails the tier if its method budget is exceeded.
    $summary += [pscustomobject]@{ Tier = $name; Passed = $passed; Failed = $failed; Cases = $total; MethodCap = $ceiling }

}

# ── Roll-up ──────────────────────────────────────────────────────────────────
Write-Step 'Test summary'
$summary | Format-Table -AutoSize | Out-String | Write-Host

if ($anyFailed) {
    Write-Err 'One or more tiers failed.'
    exit 1
}
Write-Ok 'All tiers passed.'
exit 0
