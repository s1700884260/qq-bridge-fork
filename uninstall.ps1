# uninstall.ps1 -- clean removal of a qq-bridge installation.
#
# Default: stops the bridge, removes the scheduled tasks, keeps your files.
# -Purge : additionally deletes runtime state (state\) and config.json, but never src\.
#
# ASCII only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.
[CmdletBinding()]
param([switch]$Purge, [switch]$KeepTasks)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say([string]$message) { Write-Host "[uninstall] $message" }

# 1. stop the bridge (any node process whose command line mentions bridge.js)
$bridges = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*bridge.js*' })
if ($bridges.Count -gt 0) {
    foreach ($p in $bridges) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
    Say "stopped $($bridges.Count) bridge process(es)"
} else {
    Say 'no bridge process was running'
}

# 2. scheduled tasks registered by install.ps1 / the docs
if (-not $KeepTasks) {
    foreach ($name in @('QQBridge-Guard', 'QQBridge-Host', 'QQBridge-Offline', 'QQBridge-Online', 'QQBridge-Balance', 'QQBridge-Ollama')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) { continue }
        try {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
            Say "removed scheduled task $name"
        } catch {
            Say "could not remove task $name : $($_.Exception.Message)"
        }
    }
}

# 3. optional data purge
if ($Purge) {
    foreach ($target in @('state', 'audio')) {
        $path = Join-Path $root $target
        if (Test-Path $path) {
            try { Remove-Item $path -Recurse -Force -ErrorAction Stop; Say "deleted $target\" } catch { Say "could not delete $target\ : $($_.Exception.Message)" }
        }
    }
    $configFile = Join-Path $root 'config.json'
    if (Test-Path $configFile) {
        try { Remove-Item $configFile -Force -ErrorAction Stop; Say 'deleted config.json' } catch { Say "could not delete config.json : $($_.Exception.Message)" }
    }
    Say 'kept src\, scripts\ and docs\ (delete the folder yourself if you want them gone too)'
}

Say 'done.'
