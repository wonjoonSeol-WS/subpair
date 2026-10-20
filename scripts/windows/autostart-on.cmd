@echo off
rem Starts the Subpair translation bridge hidden at every Windows sign-in, and now.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1"
pause
