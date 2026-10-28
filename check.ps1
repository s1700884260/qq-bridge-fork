# check.ps1 -- read-only self-check for a qq-bridge installation.
#
# Prints one line per check and exits with 0 when everything that must work does.
# Use it before opening an issue: it answers "is it my setup or the code".
#
# ASCII only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$problems = @()
$notes = @()

function Report([string]$name, [bool]$ok, [string]$detail) {
    $tag = if ($ok) { 'ok  ' } else { 'FAIL' }
    if (-not $Quiet -or -not $ok) { Write-Host ("[" + $tag + "] " + $name.PadRight(26) + " " + $detail) }
    if (-not $ok) { $script:problems += "${name}: $detail" }
}

# ---------------------------------------------------------------- 1. Node.js
$node = ''
foreach ($base in @((Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))) {
    if (-not $base -or -not (Test-Path $base)) { continue }
    $found = Get-ChildItem $base -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*dependencies\node\bin\node.exe' } | Select-Object -First 1
    if ($found) { $node = $found.FullName; break }
}
if (-not $node) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }
Report 'node' ([bool]$node) ($(if ($node) { & $node --version } else { 'not found' }))

# ------------------------------------------------------------- 2. source tree
$bridgeJs = Join-Path $root 'src\bridge.js'
Report 'src/bridge.js' (Test-Path $bridgeJs) $(if (Test-Path $bridgeJs) { 'present' } else { 'missing' })
$deps = Join-Path $root 'node_modules\@modelcontextprotocol\sdk'
Report 'node_modules' (Test-Path $deps) $(if (Test-Path $deps) { 'installed' } else { 'missing -> run install.ps1' })

# --------------------------------------------------------------- 3. config
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path $configPath)) {
    Report 'config.json' $false 'missing -> copy config.example.json or run install.ps1'
} else {
    try {
        $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Report 'config.json' $true 'parsed'
        Report 'config.ownerQQ' ([bool]$cfg.ownerQQ -and [int64]$cfg.ownerQQ -gt 0) ("ownerQQ=" + $cfg.ownerQQ)
        $groupCount = @($cfg.allow.groups).Count
        Report 'config.groups' ($groupCount -gt 0) ("$groupCount group(s) allowed")
        Report 'config.snowluma.token' ([bool]$cfg.snowluma.accessToken) $(if ($cfg.snowluma.accessToken) { 'set' } else { 'empty -> copy from SnowLuma config' })
    } catch {
        Report 'config.json' $false ("invalid JSON: " + $_.Exception.Message)
    }
}

# ------------------------------------------------------------ 4. SnowLuma API
if ($cfg) {
    $httpUrl = [string]$cfg.snowluma.httpUrl
    if (-not $httpUrl) { $httpUrl = 'http://127.0.0.1:3000' }
    try {
        $headers = @{}
        if ($cfg.snowluma.accessToken) { $headers['Authorization'] = 'Bearer ' + $cfg.snowluma.accessToken }
        $info = Invoke-RestMethod -Uri ($httpUrl + '/get_login_info') -Headers $headers -TimeoutSec 5
        $nick = $info.data.nickname
        Report 'SnowLuma OneBot' $true ("$httpUrl as " + $nick)
    } catch {
        Report 'SnowLuma OneBot' $false ("$httpUrl unreachable: " + $_.Exception.Message)
    }
}

# --------------------------------------------------------- 5. DSH web + bridge
$bridgePort = 3100
if ($cfg) { $bridgePort = [int]$cfg.consolePort }
$bridgeUp = $false
try {
    $conn = Get-NetTCPConnection -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue
    $bridgeUp = [bool]$conn
} catch {}
Report 'bridge port' $bridgeUp ("$bridgePort " + $(if ($bridgeUp) { 'listening' } else { 'not listening -> start-qq-bridge.ps1' }))

$dshProcs = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh-desktop-host*' })
Report 'DeepSeek Harness' ($dshProcs.Count -gt 0) $(if ($dshProcs.Count -gt 0) { "pid " + ($dshProcs.ProcessId -join ',') } else { 'not running (the bridge needs it)' })

if ($bridgeUp) {
    try {
        $tokenFile = Join-Path $root 'state\console-token'
        $token = ''
        if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
        $status = Invoke-RestMethod -Uri ("http://127.0.0.1:$bridgePort/api/status") -Headers @{ 'x-console-token' = $token } -TimeoutSec 8
        Report 'bridge status' ([bool]$status.dshReady) ("mode=" + $status.mode + " dshReady=" + $status.dshReady + " snowluma=" + $status.snowluma.connected)
    } catch {
        Report 'bridge status' $false ("/api/status failed: " + $_.Exception.Message)
    }
}

# ------------------------------------------------------------------- 6. voice
$edgePython = ''
foreach ($base in @((Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'), (Join-Path $env:LOCALAPPDATA 'Programs\Python'))) {
    if (-not $base -or -not (Test-Path $base)) { continue }
    $found = Get-ChildItem $base -Recurse -Filter 'python.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $edgePython = $found.FullName; break }
}
if ($edgePython) {
    $edgeOk = $false
    try { & $edgePython -c 'import edge_tts' 2>$null; $edgeOk = ($LASTEXITCODE -eq 0) } catch {}
    if ($edgeOk) { Report 'edge-tts (voice)' $true 'available' } else { $notes += 'edge-tts not installed: text-to-speech (qq_send_voice_text) needs: python -m pip install edge-tts' }
} else {
    $notes += 'no bundled python found: text-to-speech (qq_send_voice_text) will fall back to pre-recorded audio'
}

# --------------------------------------------------------------------- result
Write-Host ''
if ($notes.Count -gt 0) {
    Write-Host 'notes (optional features):'
    foreach ($n in $notes) { Write-Host "  - $n" }
}
if ($problems.Count -gt 0) {
    Write-Host ('problems: ' + $problems.Count) -ForegroundColor Yellow
    foreach ($p in $problems) { Write-Host "  - $p" }
    exit 1
}
Write-Host 'all required checks passed.' -ForegroundColor Green
exit 0
