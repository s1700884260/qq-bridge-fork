# ensure-bridge.ps1 -- guard, runs every minute from Task Scheduler (hidden).
#
# Rule: the bridge only makes sense while DSH is running.
#   * DSH running + bridge missing  -> start the bridge (hidden, detached)
#   * DSH not running               -> stop the bridge, do nothing else
# So nothing gets restarted (and no console keeps churning) after DSH is closed.
#
# ASCII only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.
$ErrorActionPreference = 'Continue'

$NodeExe = $null
foreach ($cand in @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
    )) {
    if (-not $cand -or -not (Test-Path $cand)) { continue }
    $found = Get-ChildItem $cand -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*dependencies\node\bin\node.exe' } | Select-Object -First 1
    if ($found) { $NodeExe = $found.FullName; break }
}
if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source }
}
$BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeLog = Join-Path $BridgeDir 'state\bridge.out.log'

function Get-RunningBridge {
    # Match loosely: different launchers pass 'src\bridge.js', 'src/bridge.js' or an absolute path.
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*bridge.js*' })
}

function Test-BridgePort {
    $conn = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Get-DshHost {
    @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dsh-desktop-host*' })
}

function Stop-Bridge($procs) {
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
    }
}

$dsh = Get-DshHost
$bridge = Get-RunningBridge
$portUp = Test-BridgePort

if ($dsh.Count -eq 0) {
    if ($bridge.Count -gt 0 -or $portUp) {
        Stop-Bridge $bridge
        if ($portUp -and $bridge.Count -eq 0) {
            # Fall back to the port owner when the process list was not readable.
            $owner = (Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue).OwningProcess
            foreach ($ownerPid in @($owner)) { if ($ownerPid) { try { Stop-Process -Id $ownerPid -Force -ErrorAction Stop } catch {} } }
        }
        Write-Host "[guard] DSH is not running; bridge stopped (procs=$($bridge.Count), port=$portUp)"
    }
    exit 0
}

if ($bridge.Count -gt 0 -or $portUp) { exit 0 }

# DSH is up but the bridge is not: let the launcher do the work (it also syncs
# baseUrl to the current DSH port, restarts SnowLuma when its port is down, and
# detaches the bridge through WMI).
Write-Host '[guard] DSH is running but bridge is missing; launching it'
$launcher = Join-Path $BridgeDir 'start-qq-bridge.ps1'
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Force -Detach 2>&1 | ForEach-Object { Write-Host "[guard] $_" }
} catch {
    Write-Host "[guard] launcher failed: $($_.Exception.Message)"
}

# Report the outcome so the task history shows whether it worked.
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline -and @(Get-RunningBridge).Count -eq 0 -and -not (Test-BridgePort)) { Start-Sleep -Seconds 3 }
Write-Host "[guard] bridge up = $(@(Get-RunningBridge).Count -gt 0 -or (Test-BridgePort))"
