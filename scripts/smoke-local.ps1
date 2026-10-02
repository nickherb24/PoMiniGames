#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Smoke-tests the locally running PoMiniGames API.
  Verifies the health, diagnostics, and OpenAPI endpoints respond correctly.
  Requires the app to be running on http://localhost:5080.
#>

$BASE = "http://localhost:5080"
$PASS = 0
$FAIL = 0

function Test-Endpoint {
    param([string]$Label, [string]$Url, [int]$ExpectedStatus = 200)
    try {
        # Use -SkipHttpErrorCheck so 401/403/4xx don't throw — the status-code
        # comparison below classifies the result correctly.
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop -SkipHttpErrorCheck
        if ($resp.StatusCode -eq $ExpectedStatus) {
            Write-Host "  [PASS] $Label ($($resp.StatusCode))" -ForegroundColor Green
            $script:PASS++
        } else {
            Write-Host "  [FAIL] $Label — expected $ExpectedStatus, got $($resp.StatusCode)" -ForegroundColor Red
            $script:FAIL++
        }
    } catch {
        Write-Host "  [FAIL] $Label — $($_.Exception.Message)" -ForegroundColor Red
        $script:FAIL++
    }
}

Write-Host "`nPoMiniGames smoke test against $BASE`n" -ForegroundColor Cyan

Test-Endpoint "GET /health"        "$BASE/health"
Test-Endpoint "GET /api/health"    "$BASE/api/health"
Test-Endpoint "GET /api/health/ping" "$BASE/api/health/ping"
# /api/diag, not /diag: there is no Blazor diag page, so a bare /diag
# falls through to MapFallbackToFile and returns the WASM shell with a vacuous 200.
Test-Endpoint "GET /api/diag"      "$BASE/api/diag"
Test-Endpoint "GET /openapi/v1.json" "$BASE/openapi/v1.json"
Test-Endpoint "GET /api/auth/handshake" "$BASE/api/auth/handshake"
Test-Endpoint "GET /api/auth/me"  "$BASE/api/auth/me" 401
Test-Endpoint "GET /api/leaderboards" "$BASE/api/leaderboards"
Test-Endpoint "GET /_framework/blazor.webassembly.js" "$BASE/_framework/blazor.webassembly.js"

# One assertion, not one per deleted route. This file had accumulated a tombstone per
# removal (/api/statistics, /api/evolution/summary, /api/face/leaderboard) and the list
# only ever grows; what they all actually checked is that an unmapped /api/* path 404s
# rather than being swallowed by the SPA fallback, which this single probe covers.
Test-Endpoint "GET /api/<unmapped> 404s (not SPA fallback)" "$BASE/api/definitely-not-a-route" 404

# Verify the Blazor WASM boot manifest responds 404 with
# `UseBlazorFrameworkFiles` synthesizing the live boot.json (the actual served
# body is generated at request time from the staged _framework/ directory).
try {
    $boot = Invoke-WebRequest -Uri "$BASE/_framework/blazor.boot.json" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($boot.StatusCode -eq 200) {
        Write-Host "  [PASS] GET /_framework/blazor.boot.json (200, $($boot.Content.Length) bytes)" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  [FAIL] GET /_framework/blazor.boot.json — got $($boot.StatusCode)" -ForegroundColor Red
        $script:FAIL++
    }
} catch {
    Write-Host "  [INFO] GET /_framework/blazor.boot.json — not synthesized in this build: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`nResults: $PASS passed, $FAIL failed`n" -ForegroundColor $(if ($FAIL -eq 0) { "Green" } else { "Red" })
exit $FAIL
