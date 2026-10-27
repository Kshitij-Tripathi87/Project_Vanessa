param([string]$OutputDirectory = "artifacts/windows-installer")
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
function Invoke-Checked([string]$Label, [string]$Executable, [string[]]$Arguments) {
    Write-Host "  > $Label" -ForegroundColor DarkCyan
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { $pnpm = Get-Command pnpm.exe -ErrorAction SilentlyContinue }
if (-not $pnpm) { throw "pnpm 11.24.0 is required. Run this script in Windows CI or install pnpm." }
Invoke-Checked "Create sanitized source payload" $pnpm.Source @('run', 'package:bootstrap')
$bootstrap = Get-ChildItem -LiteralPath (Join-Path $Root 'artifacts/windows') -Filter 'Vanessa-Windows-Bootstrap-*.zip' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $bootstrap) { throw "No sanitized bootstrap ZIP found." }
$payloadParent = Join-Path $Root 'artifacts/windows-installer-payload'
if (Test-Path $payloadParent) { Remove-Item -LiteralPath $payloadParent -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payloadParent | Out-Null
Expand-Archive -LiteralPath $bootstrap.FullName -DestinationPath $payloadParent -Force
$payloadRoot = Join-Path $payloadParent 'Vanessa'
if (-not (Test-Path (Join-Path $payloadRoot 'Launch-Vanessa.bat')) -or -not (Test-Path (Join-Path $payloadRoot 'scripts/Launch-Vanessa-Installed.vbs'))) { throw "Sanitized payload is missing launcher files." }
Add-Type -AssemblyName System.Drawing
$logoPath = Join-Path $payloadRoot 'apps/desktop/assets/vanessa.png'
$iconPath = Join-Path $payloadRoot 'apps/desktop/assets/vanessa.ico'
if (-not (Test-Path $logoPath)) { throw "Vanessa logo is missing: $logoPath" }
$bitmap = [System.Drawing.Bitmap]::new($logoPath)
$iconHandle = $bitmap.GetHicon()
try {
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
    try { $stream = [System.IO.File]::Create($iconPath); try { $icon.Save($stream) } finally { $stream.Dispose() } } finally { $icon.Dispose() }
} finally {
    $bitmap.Dispose()
    if (-not ('VanessaNativeIcon' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VanessaNativeIcon {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
'@
    }
    [VanessaNativeIcon]::DestroyIcon($iconHandle) | Out-Null
}
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$isccPath = if ($iscc) { $iscc.Source } else { $null }
if (-not $isccPath) { $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); $candidate = Join-Path $pf86 'Inno Setup 6/ISCC.exe'; if (Test-Path $candidate) { $isccPath = $candidate } }
if (-not $isccPath) { throw "Inno Setup 6 is required. CI installs it with chocolatey." }
$output = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $Root $OutputDirectory }
New-Item -ItemType Directory -Force -Path $output | Out-Null
Invoke-Checked 'Compile Vanessa Setup EXE' $isccPath @("/DRepoRoot=$Root","/DPayloadRoot=$payloadRoot","/DOutputDirectory=$output",(Join-Path $Root 'scripts/vanessa-installer.iss'))
$installer = Join-Path $output 'Vanessa-Setup-x64.exe'
if (-not (Test-Path $installer) -or (Get-Item $installer).Length -lt 1MB) { throw "No usable Setup EXE generated at $installer" }
Write-Host "[OK] Created $installer" -ForegroundColor Green
Write-Host "[NOTE] First-run setup downloads local runtimes/models. This installer is not yet signed or fully offline." -ForegroundColor Yellow
