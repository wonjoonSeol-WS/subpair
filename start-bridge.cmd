@echo off
rem Starts the Subpair translation bridge in this window (Windows). Close the window to stop it.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo Subpair translation bridge. Keep this window open while you watch; close it to stop translating.
echo.
node bridge\server.mjs
echo.
echo The bridge has stopped.
pause
