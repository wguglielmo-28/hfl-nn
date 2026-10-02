@echo off
title HFL-NN
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing HFL-NN (first run only, this can take a few minutes)...
  call npm install
)

echo.
echo Starting HFL-NN on http://localhost:3000  (control room: http://localhost:3000/control)
echo The control room password is printed below unless ADMIN_PASSWORD is set.
echo.
start "" http://localhost:3000/control
node server.js
pause
