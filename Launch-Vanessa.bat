@echo off
title Vanessa AI - Desktop Control Layer
echo ========================================================
echo           Starting Vanessa AI Desktop App
echo ========================================================

cd /d "%~dp0"

echo [1/5] Checking Node.js and pnpm...
node --version >nul 2>&1 || (echo ERROR: Node.js not found in PATH && pause && exit /b 1)
pnpm --version >nul 2>&1 || (echo ERROR: pnpm not found in PATH && pause && exit /b 1)

echo [2/5] Starting Vanessa Orchestrator (port 4319)...
powershell -Command "if (!(Get-NetTCPConnection -LocalPort 4319 -ErrorAction SilentlyContinue)) { Start-Process -NoNewWindow powershell -ArgumentList '-Command \"pnpm --filter @vanessa/orchestrator dev\"' }"

echo [3/5] Starting Vanessa Voice Agent (port 4500)...
powershell -Command "if (!(Get-NetTCPConnection -LocalPort 4500 -ErrorAction SilentlyContinue)) { Start-Process -NoNewWindow powershell -ArgumentList '-Command \"pnpm --filter @vanessa/voice-agent dev\"' }"

echo [4/5] Starting Mobile Relay (port 4400)...
powershell -Command "if (!(Get-NetTCPConnection -LocalPort 4400 -ErrorAction SilentlyContinue)) { Start-Process -NoNewWindow powershell -ArgumentList '-Command \"pnpm --filter @vanessa/relay dev\"' }"

echo [5/5] Waiting for services to be ready...
powershell -Command "Start-Sleep -Seconds 3"

echo [6/6] Launching Vanessa Native Desktop App...
pnpm --filter @vanessa/desktop start

echo Vanessa Desktop session closed.