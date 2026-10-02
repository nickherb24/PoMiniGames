#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Publish the Blazor WASM client and report on bundle size + CSS footprint.
.DESCRIPTION
  The 25 MB `_framework` budget is enforced inline by
  the "WASM bundle-size budget" step in .github/workflows/deploy.yml, with no
  developer-side feedback — a UI sweep can quietly bloat the bundle past the
  limit and only fail master, where it is expensive to track down.

  This script publishes the client to a temp location, measures:
    · total _framework size (the 25 MB cap)
    · top 10 largest individual assemblies
    · top 10 largest individual CSS files in wwwroot
  and prints a table. Exits 0 with a WARN if over budget; exits 1 only on a
  publish failure.

  It is deliberately idempotent — no network, no Azurite, no Playwright —
  so a developer can run it locally between commits while iterating on UI
  changes. The CI gate stays where it is (deploy.yml); this is the
  local-friendly mirror.

  The CSS-file size report is a soft check: there is no fixed CSS budget
  today, but the WASM trim audit already penalises per-file CSS for
  duplication. A spike after a UI sweep is a useful regression signal even
  without a hard cap.
.PARAMETER NoPublish
  Skip the publish and read sizes from the last successful publish output
  under bin/Release/net10.0/wwwroot/_framework. Useful when the developer
  has already published for a manual smoke test.
.PARAMETER BudgetMb
  Override the 25 MB cap. Default 25.
.EXAMPLE
  pwsh scripts/bundle-report.ps1
.EXAMPLE
  pwsh scripts/bundle-report.ps1 -NoPublish
#>

param(
    [switch]$NoPublish,
    [int]$BudgetMb = 25
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$client = Join-Path $repoRoot 'src/PoMiniGames.Client/PoMiniGamesClient.csproj'
$publishDir = Join-Path $repoRoot 'src/PoMiniGames.Client/bin/Release/net10.0/wwwroot/_framework'
$cssRoot = Join-Path $repoRoot 'src/PoMiniGames.Client'

function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }

function Format-Size([long]$bytes) {
    if ($bytes -lt 1KB) { return "$bytes B" }
    if ($bytes -lt 1MB) { return ('{0:N1} KB' -f ($bytes / 1KB)) }
    return ('{0:N2} MB' -f ($bytes / 1MB))
}

# ── Publish unless skipped ──────────────────────────────────────────────────
if (-not $NoPublish) {
    Write-Step 'Publishing client (Release / net10.0 / trimmed)'
    $pub = dotnet publish $client -c Release -f net10.0 -o (Split-Path $publishDir -Parent) --nologo -v minimal 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err 'Publish failed.'
        $pub | ForEach-Object { Write-Host $_ }
        exit 1
    }
    Write-Ok 'Publish complete.'
} else {
    Write-Step "Reusing existing publish output at $publishDir"
}

if (-not (Test-Path $publishDir)) {
    Write-Err "Publish output not found at $publishDir. Run without -NoPublish first."
    exit 1
}

# ── _framework size ──────────────────────────────────────────────────────────
Write-Step "_framework total size"
$frameworkSize = (Get-ChildItem -Path $publishDir -Recurse -File |
    Measure-Object -Property Length -Sum).Sum
$frameworkMb = [math]::Round($frameworkSize / 1MB, 2)
$budgetBytes = $BudgetMb * 1MB
$overBudget = $frameworkSize -gt $budgetBytes

Write-Host ("  Total: {0} ({1} MB)" -f (Format-Size $frameworkSize), $frameworkMb)
if ($overBudget) {
    Write-Warn "Over budget: $frameworkMb MB > $BudgetMb MB cap (delta $([math]::Round(($frameworkSize - $budgetBytes) / 1MB, 2)) MB)"
} else {
    Write-Ok ("Under budget: {0} MB / {1} MB cap (headroom {2} MB)" -f $frameworkMb, $BudgetMb, ([math]::Round(($budgetBytes - $frameworkSize) / 1MB, 2)))
}

# ── Top 10 assemblies ────────────────────────────────────────────────────────
Write-Step "Top 10 largest assemblies in _framework"
$topDlls = Get-ChildItem -Path $publishDir -Filter '*.dll' -File |
    Sort-Object Length -Descending |
    Select-Object -First 10
$topDlls | ForEach-Object {
    '{0,12}  {1}' -f (Format-Size $_.Length), $_.Name
} | ForEach-Object { Write-Host "  $_" }

# ── CSS file footprint (source) ──────────────────────────────────────────────
Write-Step "Top 10 largest source CSS files"
$cssFiles = Get-ChildItem -Path $cssRoot -Filter '*.css' -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/]obj[\\/]' -and $_.FullName -notmatch '[\\/]bin[\\/]' } |
    Sort-Object Length -Descending |
    Select-Object -First 10
if (-not $cssFiles) {
    Write-Warn "No CSS files found under $cssRoot"
} else {
    $cssFiles | ForEach-Object {
        '{0,10}  {1}' -f (Format-Size $_.Length), ($_.FullName.Substring($cssRoot.Length + 1))
    } | ForEach-Object { Write-Host "  $_" }
}

# ── Verdict ──────────────────────────────────────────────────────────────────
Write-Step 'Verdict'
if ($overBudget) {
    Write-Warn "WASM client bundle is over the $BudgetMb MB cap. Audit new dependencies and CSS duplication before merging."
    # Non-blocking per the WARN contract; exit 0 so a developer can still
    # commit while iterating. CI's deploy-preflight is the hard gate.
    exit 0
}
Write-Ok "Bundle is within budget."
exit 0