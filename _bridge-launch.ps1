# Wrapper used by start-qq-bridge.ps1 -Detach when it falls back to WMI.
#
# Why this file exists: a process created through Win32_Process.Create inherits the
# environment of WmiPrvSE.exe, not the caller's shell. USERPROFILE can be missing there,
# so Node resolves the home directory to C:\Windows\system32, the bridge cannot read
# %USERPROFILE%\.dsh\.credentials.yaml and every DSH request fails with
# "DSH 鉴权不可用". Setting the variables here (one process level, no nested -Command
# quoting) keeps the WMI path working without touching the bridge's own discovery logic.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $root 'state\bridge-launch.log'
function Write-LaunchLog([string]$message) {
    # One line per attempt: WMI-created processes have no console, so without this a
    # "the bridge never came up" report has nothing to look at.
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -LiteralPath $logFile -Value "[$stamp] $message" -Encoding UTF8
    } catch {}
}
Write-LaunchLog 'wrapper start'
if (-not $env:USERPROFILE) { $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile') }
if (-not $env:USERPROFILE -and $env:HOMEDRIVE -and $env:HOMEPATH) { $env:USERPROFILE = "$env:HOMEDRIVE$env:HOMEPATH" }
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }
if (-not $env:PATH) { $env:PATH = "$env:SystemRoot\system32;$env:SystemRoot" }
Set-Location -LiteralPath $root
& (Join-Path $root 'start-qq-bridge.ps1') -Force 2>&1 | ForEach-Object { Write-LaunchLog "  $_" }
Write-LaunchLog "launcher exit=$LASTEXITCODE"
exit $LASTEXITCODE
