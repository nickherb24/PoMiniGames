#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Enforces the single-branch invariant (§1.3): `master` is the only branch, local and remote.
.DESCRIPTION
  Fails (exit 1) if any branch other than `master` exists locally or on `origin`, and warns
  when local `master` is ahead of `origin/master` (remote does not yet have the latest code).
  Pass -Fix to delete offending local branches and prune stale remote-tracking refs.
.NOTES
  Idempotent read-only check by default. Run in CI or a pre-push hook so branch drift can
  never silently reappear. See AGENT.md rule 1 (master branch only).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Fix
)

$ErrorActionPreference = 'Stop'
$failed = $false

function Write-Ok  ([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Bad ([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }

Write-Host "=== Branch hygiene (§1.3: master is the only branch) ===" -ForegroundColor Cyan

git fetch --prune origin 2>&1 | Out-Null

# --- Local branches ---
$localBranches = @(git branch --format='%(refname:short)' | Where-Object { $_ -and $_ -ne 'master' })
if ($localBranches.Count -eq 0) {
    Write-Ok "No stray local branches."
} else {
    Write-Bad "Stray local branches: $($localBranches -join ', ')"
    $failed = $true
    if ($Fix) {
        foreach ($b in $localBranches) {
            if ($PSCmdlet.ShouldProcess($b, "git branch -D")) { git branch -D $b | Out-Null; Write-Ok "Deleted local '$b'." }
        }
    }
}

# --- Remote branches ---
# `%(refname:short)` renders the symbolic origin/HEAD as bare "origin"; require a
# real "origin/<branch>" shape so the HEAD pointer is never counted as a branch.
$remoteBranches = @(git branch -r --format='%(refname:short)' |
    Where-Object { $_ -like 'origin/*' -and $_ -ne 'origin/master' -and $_ -notlike '*/HEAD' })
if ($remoteBranches.Count -eq 0) {
    Write-Ok "No stray remote branches."
} else {
    Write-Bad "Stray remote branches: $($remoteBranches -join ', ')"
    $failed = $true
    if ($Fix) {
        foreach ($b in $remoteBranches) {
            $name = $b -replace '^origin/', ''
            if ($PSCmdlet.ShouldProcess($b, "git push origin --delete")) { git push origin --delete $name | Out-Null; Write-Ok "Deleted remote '$b'." }
        }
    }
}

# --- master must have the latest code on the remote ---
$ahead = (git rev-list --count origin/master..master 2>$null)
if ($ahead -and [int]$ahead -gt 0) {
    Write-Warn "Local master is ahead of origin/master by $ahead commit(s). Run 'git push origin master' so the remote has the latest code."
}

if ($failed -and -not $Fix) {
    Write-Host "`nBranch hygiene FAILED. Re-run with -Fix to remove offending branches." -ForegroundColor Red
    exit 1
}
Write-Host "`nBranch hygiene OK." -ForegroundColor Green
