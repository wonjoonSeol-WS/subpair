<#
.SYNOPSIS
    Starts the Subpair bridge hidden at every Windows sign-in, and now; with -Off, stops doing so and stops it.
.DESCRIPTION
    Puts a shortcut to run-bridge.ps1 in the current user's Startup folder, so no administrator rights are needed. The bridge
    uses run-bridge.ps1's default port, which is the extension's default bridge address.
.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\autostart.ps1 -Off
#>
[CmdletBinding()]
param([switch]$Off)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$Runner = Join-Path $PSScriptRoot 'run-bridge.ps1'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Subpair bridge.lnk'
$PowerShell = Join-Path $PSHOME 'powershell.exe'
$Arguments = '-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $Runner

# The runner first, so it cannot restart the bridge, then the bridge it started.
function Stop-Bridge {
    $runners = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$Runner*" })
    $bridges = @(foreach ($r in $runners) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$($r.ProcessId)" })
    foreach ($p in $runners + $bridges) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Off) {
    Remove-Item -LiteralPath $Shortcut -ErrorAction SilentlyContinue
    Stop-Bridge
    Write-Host 'Subpair bridge: it no longer starts with Windows, and it has been stopped.'
    return
}

$link = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
$link.TargetPath = $PowerShell
$link.Arguments = $Arguments
$link.WindowStyle = 7                       # minimized
$link.Save()
Start-Process -FilePath $PowerShell -ArgumentList $Arguments -WindowStyle Hidden    # a copy already running keeps running
Write-Host 'Subpair bridge: it now starts when you sign in to Windows, and it is running now.'
