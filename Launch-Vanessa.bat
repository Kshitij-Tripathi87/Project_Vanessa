@echo off
setlocal
title Vanessa - Desktop Control Layer
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not on PATH. Install Node.js and reopen this terminal.
  pause
  exit /b 1
)
node scripts\launch-vanessa.cjs %*
set "VANESSA_EXIT=%ERRORLEVEL%"
echo.
echo [Launcher] Session ended with exit code %VANESSA_EXIT%.
if not "%VANESSA_EXIT%"=="0" pause
exit /b %VANESSA_EXIT%
