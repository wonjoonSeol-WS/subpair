<#
.SYNOPSIS
    Runs the Subpair bridge in the background on Windows: restarts it when it dies and appends its output to a log.
.DESCRIPTION
    Meant for a scheduled task at logon (see the README). Only one copy runs at a time, and a bridge left behind by an earlier
    copy on the same port is stopped first. Restarts wait RestartDelay seconds, doubling up to MaxRestartDelay; a bridge that
    ran for HealthySeconds counts as healthy and resets the wait. After MaxQuickFailures runs in a row that each ended within
    QuickSeconds the script gives up (exit 1). The bridge exiting with code 0 (stopped on purpose) ends the script.
.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\run-bridge.ps1 -Port 8777
#>
[CmdletBinding()]
param(
    [string]$Repo = '',
    [ValidateRange(1, 65535)][int]$Port = 8765,
    [string]$Log = (Join-Path $env:LOCALAPPDATA 'subpair\bridge.log'),
    [string]$Node = '',
    [ValidateRange(1, 100)][int]$MaxQuickFailures = 8
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'

$RestartDelay = 5
$MaxRestartDelay = 60
$QuickSeconds = 15
$HealthySeconds = 60
$WriteAttempts = 5
$WriteRetryMs = 200
$Server = 'bridge\server.mjs'

function Write-Log([string]$Text) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    for ($i = 1; $i -le $WriteAttempts; $i++) {
        try { [IO.File]::AppendAllText($script:Log, $line + [Environment]::NewLine); return }
        catch { Start-Sleep -Milliseconds $WriteRetryMs }           # the log is being rotated
    }
}

function Stop-LeftoverBridge {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($owner in $listeners | Select-Object -ExpandProperty OwningProcess -Unique) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -like "*$Server*") {
            Write-Log "stopping a bridge left behind on port $Port (pid $owner)"
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        }
    }
}

$mutex = New-Object Threading.Mutex($false, "Global\subpair-bridge-$Port")
try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) { exit 0 }

try { New-Item -ItemType Directory -Force -Path (Split-Path $Log) -ErrorAction Stop | Out-Null }
catch { $Log = Join-Path $env:TEMP 'subpair-bridge.log' }                # the log drive is offline
$script:Log = $Log
if (-not $Repo) { $Repo = Split-Path (Split-Path $PSScriptRoot) }             # this script lives in <repo>\scripts\windows
if (-not $Node) {
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    $Node = if ($found) { $found.Source } else { '' }
}
foreach ($path in $Node, (Join-Path $Repo $Server)) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { Write-Log "cannot start: '$path' does not exist (is Node.js installed?)"; exit 2 }
}
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }    # no console: nothing to set
$env:BRIDGE_PORT = $Port
Set-Location -LiteralPath $Repo
Stop-LeftoverBridge

$wait = $RestartDelay
$quick = 0
while ($true) {
    Write-Log "starting bridge on port $Port from $Repo"
    $started = Get-Date
    & $Node $Server 2>&1 | ForEach-Object {
        $prefix = if ($_ -is [Management.Automation.ErrorRecord]) { 'ERR ' } else { '' }
        Write-Log ($prefix + $_.ToString())
    }
    $code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
    $ranFor = ((Get-Date) - $started).TotalSeconds
    Write-Log "bridge exited with code $code after $([int]$ranFor) s"
    if ($code -eq 0) { exit 0 }
    if ($ranFor -ge $HealthySeconds) { $wait = $RestartDelay; $quick = 0 }
    elseif ($ranFor -lt $QuickSeconds) { $quick++ }
    else { $quick = 0 }
    if ($quick -ge $MaxQuickFailures) { Write-Log "giving up: $quick quick failures in a row"; exit 1 }
    Write-Log "restarting in $wait s"
    Start-Sleep -Seconds $wait
    $wait = [math]::Min($MaxRestartDelay, $wait * 2)
}
