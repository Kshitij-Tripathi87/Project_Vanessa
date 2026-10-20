# Vanessa Windows 11 Environment Setup Script
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   PROJECT VANESSA - ENVIRONMENT SETUP (WIN 11)   " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# 1. Verify Node and pnpm
$nodeVer = node -v
$pnpmVer = pnpm -v
Write-Host "[✓] Node.js Version: $nodeVer" -ForegroundColor Green
Write-Host "[✓] pnpm Version: $pnpmVer" -ForegroundColor Green

# 2. Check Administrator Elevation
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host "[✓] Elevated Administrator: YES (Wi-Fi adapter restart enabled)" -ForegroundColor Green
} else {
    Write-Host "[!] Elevated Administrator: NO (Wi-Fi restart will run in simulated/safe mode without admin elevation)" -ForegroundColor Yellow
}

# 3. Install Dependencies
Write-Host "`n[*] Installing workspace dependencies with pnpm..." -ForegroundColor Cyan
pnpm install

# 4. Build Shared Types
Write-Host "`n[*] Building @vanessa/shared package..." -ForegroundColor Cyan
pnpm --filter @vanessa/shared build

Write-Host "`n[✓] Vanessa setup complete! Run 'pnpm dev' or '.\scripts\dev.ps1' to launch." -ForegroundColor Green
