# meshify skill installer (Windows PowerShell)
# Usage: powershell -ExecutionPolicy ByPass -File install.ps1 [-Mode all|cli-only|skill-only]
# Behavior: detect host skills dirs -> copy SKILL.md + references/ -> build the CLI if needed -> doctor summary
param(
    [ValidateSet('all', 'cli-only', 'skill-only')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillDir = Split-Path -Parent $Here                    # skills\meshify
$RepoRoot = Split-Path -Parent (Split-Path -Parent $SkillDir)  # repo root

# ------------------------------------------------------------------
# 1. host detection
# ------------------------------------------------------------------
function Get-Hosts {
    $candidates = @(
        '.claude\skills', '.cursor\skills', '.agents\skills',
        '.codex\skills', '.qoder\skills', '.codebuddy\skills', '.comate\skills'
    )
    $found = @()
    foreach ($c in $candidates) {
        $d = Join-Path $RepoRoot $c
        $parent = Split-Path -Parent $d
        if ((Test-Path $parent) -or (Test-Path $d)) { $found += $d }
    }
    if ($found.Count -eq 0) { $found = @(Join-Path $RepoRoot '.claude\skills') }
    return $found
}

function Install-Skill($target) {
    $dest = Join-Path $target 'meshify'
    New-Item -ItemType Directory -Force -Path (Join-Path $dest 'references') | Out-Null
    Copy-Item (Join-Path $SkillDir 'SKILL.md') (Join-Path $dest 'SKILL.md') -Force
    Copy-Item (Join-Path $SkillDir 'references\*.md') (Join-Path $dest 'references') -Force
    Write-Host "  [ok] skill -> $dest"
}

# ------------------------------------------------------------------
# 2. CLI build
# ------------------------------------------------------------------
function Build-Cli {
    $dist = Join-Path $RepoRoot 'packages\cli\dist\index.js'
    if (-not (Test-Path $dist)) {
        Write-Host '  Building kernel and CLI (pnpm install + tsc)...'
        Push-Location $RepoRoot
        try {
            if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
                throw 'pnpm is required (npm i -g pnpm)'
            }
            pnpm install --silent
            Push-Location packages\core; npx tsc -p tsconfig.json; Pop-Location
            Push-Location packages\kernel-ts; npx tsc -p tsconfig.json; Pop-Location
            Push-Location packages\cli; npx tsc -p tsconfig.json; Pop-Location
        } finally { Pop-Location }
    }
}

Write-Host 'meshify skill installer'

if ($Mode -in 'all', 'skill-only') {
    Write-Host 'Detecting host skills directories...'
    foreach ($hostDir in Get-Hosts) { Install-Skill $hostDir }
}

if ($Mode -in 'all', 'cli-only') {
    Build-Cli
    $cli = Join-Path $RepoRoot 'packages\cli\bin\meshify.js'
    if (Test-Path $cli) {
        Write-Host '  Environment check:'
        & node $cli doctor
    } else {
        Write-Host '  [--] CLI not built (-Mode cli-only builds it alone)'
    }
}

Write-Host 'Done. Verify: node packages\cli\bin\meshify.js inspect <model.glb>'
Write-Host 'Tier1 (STEP/CAD) on demand: meshify doctor --install-uv; cd packages-py\kernel-py; uv sync'
