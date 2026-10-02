#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run the azure-deployment-preflight skill against this repo's infra/ folder.
.DESCRIPTION
  A deployment preflight (Bicep lint + what-if + permission check) must run
  before any `azd provision`. This script
  is a thin wrapper around the global skill — it prints the manifest and a concrete
  next-step command.
.EXAMPLE
  pwsh ./scripts/deploy-preflight.ps1 -EnvironmentName myenv
#>
[CmdletBinding()]
param(
    [string]$EnvironmentName = 'pominigames-dev'
)

$skillPath = Join-Path $env:USERPROFILE '.agents/skills/azure-deployment-preflight/SKILL.md'
if (-not (Test-Path $skillPath)) {
    Write-Warning "Skill manifest not found at $skillPath. Install the azure-deployment-preflight skill globally first."
    exit 1
}

Write-Host "=== azure-deployment-preflight ===" -ForegroundColor Cyan
Write-Host "  manifest:   $skillPath"
Write-Host "  target env: $EnvironmentName"
Write-Host ""
Write-Host "Recommended flow:" -ForegroundColor Gray
Write-Host "  1. az bicep build --file infra/main.bicep" -ForegroundColor Gray
Write-Host "  2. az deployment sub what-if --location westus2 --template-file infra/main.bicep --parameters environmentName=$EnvironmentName" -ForegroundColor Gray
Write-Host "  3. (Optional) hand the agent the skill manifest above and have it run the permission checks." -ForegroundColor Gray
