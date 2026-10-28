# start-qq-bridge.ps1 -- launcher for qq-bridge on this machine.
#
# Solves three machine-specific problems:
#   1. `node` is not on PATH; the DSH-bundled node is used instead.
#   2. The DSH desktop app picks a fresh ephemeral port on every launch, and it
#      listens on TWO loopback ports (only one is the web UI; the other answers 404).
#      qq-bridge mints a cookie bound to host:port, so baseUrl must be exact.
#   3. A bridge still pointed at the previous port never recovers by itself, so
#      this script kills the stale instance before starting a fresh one.
#
# Modes:
#   (default)  sync baseUrl, kill stale bridge, run bridge in the foreground
#   -Detach    same, but relaunch itself detached via WMI and exit (for the watchdog)
#   -NoStart   only sync baseUrl and report; do not touch the bridge
#   -Force     ignore the "already running and in sync" shortcut
param([switch]$NoStart, [switch]$Force, [switch]$Detach)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$node = ''
$candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes')
) | Where-Object { $_ }
foreach ($base in $candidates) {
    if (-not (Test-Path $base)) { continue }
    $found = Get-ChildItem $base -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*dependencies\node\bin\node.exe' } |
        Select-Object -First 1
    if ($found) { $node = $found.FullName; break }
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source } else { throw 'node runtime not found (install Node.js >= 22 or keep the DSH-bundled runtime)' }
}

function Test-DshWebPort([int]$Port) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
        # A 200 alone is NOT proof: billion-context (a DSH child process) listens on
        # its own loopback port and answers {"ok":true,"upstream":...} with 200.
        # The real web app serves the DSH shell, which always carries the boot payload.
        $body = [string]$resp.Content
        if ($body -match '__DSH_BOOT__' -or $body -match 'dsh-app') { return $true }
        return $false
    } catch {
        # The DSH web app answers 401 without a session cookie; other services
        # owned by the same process answer 404/403.
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return ($code -eq 401)
    }
}

function Get-DshWebUrl {
    $procIds = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id)
    if (-not $procIds) { return $null }
    # Only the main desktop host serves the web UI. Helper/child processes of the
    # same exe (billion-context proxy, renderers, subprocess runners) must never
    # win the probe: pointing baseUrl at billion-context breaks the event stream
    # silently ("DSH 事件流已结束（本次收到 0 帧）").
    $hostPids = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } |
        Select-Object -ExpandProperty ProcessId)
    $ports = @()
    foreach ($row in (netstat -ano | Select-String 'LISTENING')) {
        $parts = @(($row.Line -split '\s+') | Where-Object { $_ })
        if ($parts.Count -lt 5) { continue }
        if ($parts[1] -notmatch '^127\.0\.0\.1:(\d+)$') { continue }
        $owner = [int]$parts[4]
        if ($owner -notin $procIds) { continue }
        if ($hostPids -and $owner -notin $hostPids) { continue }
        $ports += [int]$matches[1]
    }
    foreach ($port in ($ports | Sort-Object -Unique)) {
        if (Test-DshWebPort $port) { return "http://127.0.0.1:$port" }
    }
    return $null
}

function Get-RunningBridge {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*src\bridge.js*' })
}

$url = Get-DshWebUrl

# Ensure the QQ gateway (SnowLuma) is up. It is a SEPARATE process: when it dies
# the bridge keeps running but every read/send fails, which looks exactly like
# "the bot stopped answering". Restart it detached so a DSH restart cannot take
# it down with the session.
function Test-PortListening([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}
$snowExe = 'C:\SnowLuma\node.exe'
if ((Test-Path $snowExe) -and -not (Test-PortListening 3000)) {
    if ($NoStart) {
        Write-Host '[start] SnowLuma is down (not started because -NoStart)'
    } else {
        # Start it as OUR child process. When this script runs from the
        # QQBridge-Host scheduled task, the child belongs to the Task Scheduler
        # job -- not to DSH -- so a DSH restart cannot kill the gateway.
        Start-Process -FilePath $snowExe -ArgumentList 'C:\SnowLuma\index.mjs' -WorkingDirectory 'C:\SnowLuma' -WindowStyle Hidden
        Write-Host '[start] SnowLuma was down; launched as a child of this task'
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and -not (Test-PortListening 3000)) { Start-Sleep -Seconds 2 }
        Write-Host "[start] SnowLuma 3000 listening = $(Test-PortListening 3000)"
    }
}

# Idempotent shortcut for the watchdog: nothing to do when the bridge is alive
# and already pointed at the current DSH port.
if (-not $NoStart -and -not $Force -and $url) {
    if (@(Get-RunningBridge).Count -gt 0) {
        $cfgUrl = $null
        try { $cfgUrl = (Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).dsh.baseUrl } catch {}
        if ($cfgUrl -eq $url) {
            Write-Host "[start] bridge already running and in sync with $url; nothing to do"
            exit 0
        }
    }
}

if ($url) {
    & $node -e "const fs=require('fs');const p='config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.dsh=c.dsh||{};if(c.dsh.baseUrl!==process.argv[1]){c.dsh.baseUrl=process.argv[1];fs.writeFileSync(p,JSON.stringify(c,null,2));console.log('[start] config.json baseUrl -> '+process.argv[1]);}else{console.log('[start] baseUrl already '+process.argv[1]);}" $url
} else {
    Write-Warning '[start] DSH web app not reachable; keeping the existing baseUrl'
}

if ($NoStart) {
    Write-Host '[start] -NoStart given, bridge not launched'
    exit 0
}

# Kill the stale instance: the bridge holds a single-instance lock and the old
# one is still bound to the pre-restart port.
$old = @(Get-RunningBridge)
foreach ($proc in $old) {
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Host "[start] stopped old bridge pid $($proc.ProcessId)" } catch {}
}
if ($old.Count) { Start-Sleep -Seconds 1 }

if ($Detach) {
    # Hand the bridge to the QQBridge-Host scheduled task instead of spawning it
    # here. Task Scheduler owns that process, so a DSH restart (which kills this
    # session's children) cannot take the bridge down. WMI is the fallback when
    # the task does not exist yet.
    $taskName = 'QQBridge-Host'
    $viaTask = $false
    try {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop) {
            # 任务可能停在"Running"却没有实际进程（上次被强杀留下的状态），
            # 这种时候 /run 会直接拒绝。先 /end 把状态复位再 /run。
            schtasks /end /tn $taskName 2>$null | Out-Null
            schtasks /run /tn $taskName 2>$null | Out-Null
            # A disabled task answers with a non-zero exit code, so trust the code
            # rather than the mere existence of the task.
            if ($LASTEXITCODE -eq 0) { $viaTask = $true }
            else { Write-Host "[start] scheduled task '$taskName' refused to start (rc=$LASTEXITCODE); falling back to WMI" }
        }
    } catch {}
    if ($viaTask) {
        Write-Host "[start] bridge launch handed to scheduled task '$taskName'; watchdog exiting"
    } else {
        # WMI 创建的进程继承的是 WmiPrvSE 的环境，USERPROFILE 可能缺失，
        # 桥接会因此算错 DSH_HOME、读不到 .credentials.yaml（真实踩过）。
        # 用单层 wrapper 脚本补环境变量，避免嵌套引号把命令行拼坏。
        $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root '_bridge-launch.ps1')`""
        Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $cmd
            CurrentDirectory = $root
        } | Out-Null
        Write-Host '[start] detached bridge launch requested via WMI; watchdog exiting'
    }
    exit 0
}

Write-Host "[start] launching bridge with $node"
& $node src\bridge.js
exit $LASTEXITCODE
