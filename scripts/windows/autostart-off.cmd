@echo off
rem Stops starting the Subpair translation bridge with Windows, and stops the running one.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Off
pause
