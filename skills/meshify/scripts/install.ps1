# meshify skill 安装器（Windows PowerShell）
# 用法：powershell -ExecutionPolicy ByPass -File install.ps1 [-Mode all|cli-only|skill-only]
# 行为：探测宿主 skills 目录 -> 复制 SKILL.md + references/ -> 构建未编译的 CLI -> doctor 摘要
param(
    [ValidateSet('all', 'cli-only', 'skill-only')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillDir = Split-Path -Parent $Here                    # skills\meshify
$RepoRoot = Split-Path -Parent (Split-Path -Parent $SkillDir)  # 仓库根

# ------------------------------------------------------------------
# 1. 宿主探测
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
# 2. CLI 构建
# ------------------------------------------------------------------
function Build-Cli {
    $dist = Join-Path $RepoRoot 'packages\cli\dist\index.js'
    if (-not (Test-Path $dist)) {
        Write-Host '  构建内核与 CLI（pnpm install + tsc）…'
        Push-Location $RepoRoot
        try {
            if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
                throw '需要 pnpm（npm i -g pnpm）'
            }
            pnpm install --silent
            Push-Location packages\core; npx tsc -p tsconfig.json; Pop-Location
            Push-Location packages\kernel-ts; npx tsc -p tsconfig.json; Pop-Location
            Push-Location packages\cli; npx tsc -p tsconfig.json; Pop-Location
        } finally { Pop-Location }
    }
}

Write-Host 'meshify skill 安装器'

if ($Mode -in 'all', 'skill-only') {
    Write-Host '探测宿主 skills 目录…'
    foreach ($hostDir in Get-Hosts) { Install-Skill $hostDir }
}

if ($Mode -in 'all', 'cli-only') {
    Build-Cli
    $cli = Join-Path $RepoRoot 'packages\cli\bin\meshify.js'
    if (Test-Path $cli) {
        Write-Host '  环境自检：'
        & node $cli doctor
    } else {
        Write-Host '  [--] CLI 未构建（-Mode cli-only 可单独构建）'
    }
}

Write-Host '完成。验证：node packages\cli\bin\meshify.js inspect <model.glb>'
Write-Host 'Tier1（STEP/CAD）按需安装：meshify doctor --install-uv; cd packages-py\kernel-py; uv sync'
