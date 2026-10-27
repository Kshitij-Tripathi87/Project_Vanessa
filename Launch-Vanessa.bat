@echo off
setlocal
title Vanessa - Desktop Control Layer
cd /d "%~dp0"

set "ENV_FILE=%~dp0.env"
if defined VANESSA_CONFIG_HOME (
  if not exist "%VANESSA_CONFIG_HOME%" mkdir "%VANESSA_CONFIG_HOME%" >nul 2>nul
  set "ENV_FILE=%VANESSA_CONFIG_HOME%\.env"
)

rem Explicit diagnostics bypass automatic repair so users can inspect the failure first.
if /I "%~1"=="--doctor" goto doctor

rem The first launch bootstraps dependencies and local models; later launches go straight to the app.
set "NEEDS_SETUP=0"
if not exist "%ENV_FILE%" set "NEEDS_SETUP=1"
if not exist "node_modules\dotenv\package.json" set "NEEDS_SETUP=1"
if not exist "apps\desktop\node_modules\electron\package.json" set "NEEDS_SETUP=1"
if not exist "services\orchestrator\node_modules\tsx\package.json" set "NEEDS_SETUP=1"

if not exist ".venv-voice\Scripts\python.exe" if exist "%ENV_FILE%" (
  findstr /I /R /C:"^[ ]*VOICE_ASR_PROVIDER[ ]*=[ ]*whisper" "%ENV_FILE%" >nul
  if not errorlevel 1 set "NEEDS_SETUP=1"
  findstr /I /R /C:"^[ ]*VOICE_ASR_PROVIDER[ ]*=[ ]*voice" "%ENV_FILE%" >nul
  if not errorlevel 1 set "NEEDS_SETUP=1"
  findstr /I /R /C:"^[ ]*VOICE_ASR_PROVIDER[ ]*=[ ]*fish" "%ENV_FILE%" >nul
  if not errorlevel 1 (
    findstr /I /R /C:"^[ ]*VOICE_ALLOW_FALLBACK[ ]*=[ ]*true" "%ENV_FILE%" >nul
    if not errorlevel 1 set "NEEDS_SETUP=1"
  )
)

if "%NEEDS_SETUP%"=="0" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify-local-setup.ps1" >nul
  if errorlevel 1 set "NEEDS_SETUP=1"
)

if "%NEEDS_SETUP%"=="1" (
  echo.
  echo [Vanessa Setup] First-run dependencies or local voice runtime are missing.
  echo [Vanessa Setup] This may install Node.js, Python, and Ollama with Windows Package Manager,
  echo [Vanessa Setup] then download speech and language models. Model downloads need internet and disk space.
  echo [Vanessa Setup] No cloud provider API key is required for the default local profile.
  echo.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_windows.ps1"
  if errorlevel 1 (
    echo.
    echo [ERROR] Vanessa setup failed. Read the message above, fix that prerequisite, and run this file again.
    pause
    exit /b 1
  )
  rem Refresh common user-scope install locations in this CMD process after setup.
  set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Programs\Ollama;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not on PATH after setup. Reopen Windows Terminal and run this file again.
  pause
  exit /b 1
)

node scripts\launch-vanessa.cjs %*
set "VANESSA_EXIT=%ERRORLEVEL%"
echo.
echo [Launcher] Session ended with exit code %VANESSA_EXIT%.
if not "%VANESSA_EXIT%"=="0" pause
exit /b %VANESSA_EXIT%

:doctor
where node >nul 2>nul
if errorlevel 1 goto doctor_no_node
node "%~dp0scripts\doctor.cjs" %*
exit /b %ERRORLEVEL%

:doctor_no_node
echo [Doctor] Node.js is not available yet, so diagnostics cannot run.
echo [Doctor] Run Launch-Vanessa.bat without --doctor once to install required prerequisites.
exit /b 2
