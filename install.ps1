# install.ps1 -- one-stop setup for qq-bridge on Windows.
#
# What it does (idempotent; safe to re-run):
#   1. checks Node.js >= 22
#   2. installs npm dependencies when node_modules is missing
#   3. writes config.json from config.example.json if it does not exist yet
#      (owner QQ / whitelisted groups / SnowLuma token can be passed as parameters)
#   4. optionally registers the "keep the bridge alive while DSH runs" scheduled task
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -OwnerQQ 123456 -Groups 11111,22222
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipDeps -NoTasks
#
# ASCII only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.
[CmdletBinding()]
param(
    [string]$OwnerQQ = '',
    [string[]]$Groups = @(),
    [string]$SnowlumaHome = '',
    [string]$SnowlumaToken = '',
    [string]$DshBaseUrl = '',
    [switch]$SkipDeps,
    [switch]$NoTasks
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say([string]$message) { Write-Host "[install] $message" }
function Fail([string]$message) { Write-Host "[install] ERROR: $message" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. Node.js
$node = ''
foreach ($base in @((Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))) {
    if (-not $base -or -not (Test-Path $base)) { continue }
    $found = Get-ChildItem $base -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*dependencies\node\bin\node.exe' } | Select-Object -First 1
    if ($found) { $node = $found.FullName; break }
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) { Fail 'node.exe not found. Install Node.js >= 22.13 (or install DeepSeek Harness, which bundles one).' }
$versionText = (& $node --version) -replace '^v', ''
$major = [int]($versionText.Split('.')[0])
Say "node $versionText -> $node"
if ($major -lt 22) { Fail "Node.js >= 22.13 is required, found $versionText." }

# ------------------------------------------------------------- 2. dependencies
if (-not $SkipDeps) {
    if (Test-Path (Join-Path $root 'node_modules\@modelcontextprotocol\sdk')) {
        Say 'dependencies already installed; skipping (use -SkipDeps to silence)'
    } else {
        $npm = $null
        foreach ($cand in @((Join-Path (Split-Path -Parent $node) 'npm.cmd'), (Join-Path (Split-Path -Parent (Split-Path -Parent $node)) 'npm.cmd'))) {
            if (Test-Path $cand) { $npm = $cand; break }
        }
        if (-not $npm) { $c = Get-Command npm.cmd -ErrorAction SilentlyContinue; if ($c) { $npm = $c.Source } }
        if (-not $npm) { Fail 'npm not found next to node.exe. Install dependencies manually: npm install --omit=dev' }
        Say "installing dependencies with $npm (this can take a few minutes)"
        & $npm install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail "npm install failed with exit code $LASTEXITCODE" }
    }
}

# ------------------------------------------------------------------ 3. config
$configPath = Join-Path $root 'config.json'
$examplePath = Join-Path $root 'config.example.json'
if (Test-Path $configPath) {
    Say 'config.json already exists; leaving it untouched'
} else {
    if (-not (Test-Path $examplePath)) { Fail 'config.example.json is missing from the package' }
    $cfg = Get-Content $examplePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($OwnerQQ) { $cfg.ownerQQ = [int64]$OwnerQQ }
    # powershell -File "install.ps1 -Groups 1,2" passes ONE string "1,2": split it again.
    $groupList = @()
    foreach ($g in $Groups) {
        foreach ($piece in ([string]$g -split '[,;\s]+')) {
            if ($piece) { $groupList += [int64]$piece }
        }
    }
    if ($groupList.Count -gt 0) {
        $cfg.allow.private = @()
        if ($OwnerQQ) { $cfg.allow.private = @([int64]$OwnerQQ) }
        $cfg.allow.groups = $groupList
    }
    if ($DshBaseUrl) { $cfg.dsh.baseUrl = $DshBaseUrl }
    if ($SnowlumaHome) { $cfg.snowluma.homeDir = $SnowlumaHome }
    if ($SnowlumaToken) { $cfg.snowluma.accessToken = $SnowlumaToken }

    # SnowLuma is usually installed at C:\SnowLuma or beside the user's home; try to help.
    if (-not $cfg.snowluma.homeDir) {
        foreach ($cand in @('C:\SnowLuma', (Join-Path $env:USERPROFILE 'SnowLuma'))) {
            if (Test-Path (Join-Path $cand 'config')) { $cfg.snowluma.homeDir = $cand; break }
        }
    }
    $json = $cfg | ConvertTo-Json -Depth 40
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Say "wrote $configPath"
    if (-not $OwnerQQ) { Say 'ownerQQ is null: set it in config.json (only this QQ may use private chat)' }
    if ($groupList.Count -eq 0) { Say 'allow.groups is empty: add the group numbers the bot may answer in' }
    if (-not $SnowlumaToken) { Say 'snowluma.accessToken is empty: copy it from C:\SnowLuma\config\onebot_<qq>.json' }
}

# ------------------------------------------------------------------ 4. tasks
if (-not $NoTasks) {
    $taskName = 'QQBridge-Guard'
    $ps1 = (Get-Command powershell.exe).Source
    $guard = Join-Path $root 'ensure-bridge.ps1'
    if (-not (Test-Path $guard)) {
        Say 'ensure-bridge.ps1 not found; skipping the guard task'
    } else {
        $action = New-ScheduledTaskAction -Execute $ps1 -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$guard`""
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Say "registered scheduled task $taskName (every minute; starts the bridge only while DSH runs)"
    }
}

Say ''
Say 'done. next steps:'
Say "  1. start DeepSeek Harness, then run:  powershell -File start-qq-bridge.ps1"
Say '  2. send one QQ message to the bot account and watch state\bridge.log'
Say '  3. read docs\guides\SETUP.md for SnowLuma, models, roles and voice setup'
