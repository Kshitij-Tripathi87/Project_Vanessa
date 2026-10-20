@echo off
title Vanessa AI - Desktop Control Layer
echo ========================================================
echo           Starting Vanessa AI Desktop App
echo ========================================================

cd /d "%~dp0"

echo [1/4] Checking Faster-Whisper ASR daemon (port 4505)...
powershell -Command "if (!(Get-NetTCPConnection -LocalPort 4505 -ErrorAction SilentlyContinue)) { Start-Process -NoNewWindow powershell -ArgumentList '-Command \".venv-whisper\Scripts\python.exe services/voice-agent/whisper_server.py\"'; Start-Sleep -Seconds 2 }"

echo [2/4] Checking Vanessa Orchestrator daemon (port 4319)...
powershell -Command "if (!(Get-NetTCPConnection -LocalPort 4319 -ErrorAction SilentlyContinue)) { Start-Process -NoNewWindow powershell -ArgumentList '-Command \"pnpm --filter @vanessa/orchestrator dev\"'; Start-Sleep -Seconds 2 }"

echo [3/4] Checking Vanessa Voice Agent daemon (port 4500)...
powershell -Command "if (!(Get-NetTCPConnection -LocalPort 4500 -ErrorAction SilentlyContinue)) { Start-Process -NoNewWindow powershell -ArgumentList '-Command \"pnpm --filter @vanessa/voice-agent dev\"'; Start-Sleep -Seconds 2 }"

echo [4/4] Launching Vanessa Native Desktop App...
pnpm --filter @vanessa/desktop start

echo Vanessa Desktop session closed.
