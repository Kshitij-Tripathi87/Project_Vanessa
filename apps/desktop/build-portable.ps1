<#
.SYNOPSIS
Build Vanessa portable executable without electron-builder's winCodeSign step
#>

param(
    [string]$OutputDir = "dist/portable",
    [string]$AppName = "Vanessa",
    [string]$Version = "0.1.0"
)

Write-Host "Building Vanessa Portable Executable..." -ForegroundColor Green

# 1. Build the app with Vite (already done)
Write-Host "Step 1: Vite frontend already built..." -ForegroundColor Cyan

# 2. Create portable structure
$PortableDir = "dist\portable\$AppName"
$ElectronDir = "$PortableDir\resources\app"

Write-Host "Step 2: Creating portable structure at $PortableDir..." -ForegroundColor Cyan

# Remove existing
if (Test-Path $PortableDir) {
    Remove-Item -Recurse -Force $PortableDir
}

New-Item -ItemType Directory -Path $ElectronDir -Force | Out-Null

# Copy built app from the correct dist locations
Write-Host "Copying built app..." -ForegroundColor Cyan
# Create dist directory structure first
New-Item -ItemType Directory -Path "$ElectronDir\dist" -Force | Out-Null
Copy-Item "apps\desktop\dist\main" -Destination "$ElectronDir\dist\main" -Recurse -Force
Copy-Item "apps\desktop\dist\preload" -Destination "$ElectronDir\dist\preload" -Recurse -Force
Copy-Item "apps\desktop\dist\renderer" -Destination "$ElectronDir\dist\renderer" -Recurse -Force

# Copy package.json
Copy-Item "apps\desktop\package.json" -Destination "$ElectronDir\package.json" -Force

# Copy node_modules (production only)
Write-Host "Copying production dependencies..." -ForegroundColor Cyan
if (Test-Path "apps\desktop\node_modules") {
    $Exclude = @("*.md", "*.ts", "*.map", "*.d.ts", "test*", "spec*", "*.test.*", "docs*", "examples*", "docs*")
    Copy-Item "apps\desktop\node_modules" -Destination "$ElectronDir\node_modules" -Recurse -Force -Exclude $Exclude
}

# Copy Electron binary
Write-Host "Copying Electron binary..." -ForegroundColor Cyan
$ElectronPaths = @(
    "node_modules\.pnpm\electron@34.5.8_supports-color@8.1.1\node_modules\electron\dist\electron.exe",
    "node_modules\electron\dist\electron.exe",
    "C:\Program Files\nodejs\node_modules\electron\dist\electron.exe",
    (Join-Path (Get-Location) "node_modules\electron\dist\electron.exe")
)

$Found = $false
foreach ($path in $ElectronPaths) {
    if (Test-Path $path) {
        Write-Host "Found Electron at: $path" -ForegroundColor Green
        $ElectronDirPath = Split-Path $path
        $ElectronFiles = Get-ChildItem (Split-Path $path) -File
        foreach ($file in $ElectronFiles) {
            Copy-Item $file.FullName -Destination "$PortableDir\$($file.Name)" -Force
        }

        # Copy electron resources
        $ElectronResources = Join-Path (Split-Path $path) "resources"
        if (Test-Path $ElectronResources) {
            Copy-Item "$ElectronResources\*" -Destination "$PortableDir\resources" -Recurse -Force
        }
        break
    }
}
if (-not (Test-Path "$PortableDir\electron.exe")) {
    Write-Warning "Electron binary not found, skipping Electron copy"
}

# Create launch script
Write-Host "Creating launch script..." -ForegroundColor Cyan
$LaunchScript = @"
@echo off
title Vanessa AI - Voice-native AI Control Layer
cd /d "%~dp0"
.\Vanessa.exe
"@
Set-Content -Path "$PortableDir\Launch-Vanessa.bat" -Value $LaunchScript -Encoding ASCII

# Create uninstaller
Write-Host "Creating uninstaller..." -ForegroundColor Cyan
$UninstallScript = @"
@echo off
echo Uninstalling Vanessa...
rmdir /s /q "%~dp0..\Vanessa"
echo Vanessa uninstalled successfully.
pause
"@
Set-Content -Path "$PortableDir\Uninstall-Vanessa.bat" -Value $UninstallScript -Encoding ASCII

# Create README
Write-Host "Creating README..." -ForegroundColor Cyan
$Readme = @"
# Vanessa Portable
Voice-native AI control layer for Windows

## Launch
Double-click Launch-Vanessa.bat or run Vanessa.exe directly.

## Requirements
- Windows 10/11 (64-bit)
- .NET Framework 4.8+ (included in Windows 10/11)

## Configuration
Copy your .env file to this directory or set environment variables.

## Uninstall
Run Uninstall-Vanessa.bat as Administrator.
"@
Set-Content -Path "$PortableDir\README.md" -Value $Readme -Encoding UTF8

# Create version file
$VersionInfo = @"
{
  "name": "Vanessa",
  "version": "0.1.0",
  "description": "Voice-native AI control layer for Windows",
  "author": "Vanessa Labs",
  "electronVersion": "34.5.8",
  "buildDate": "$(Get-Date -Format 'yyyy-MM-dd')"
}
"@
Set-Content -Path "$PortableDir\version.json" -Value $VersionInfo -Encoding UTF8

Write-Host "`nPortable build complete at: $PortableDir" -ForegroundColor Green
Write-Host "Size: $(Get-ChildItem $PortableDir -Recurse | Measure-Object -Property Length -Sum).Sum MB" -ForegroundColor Cyan