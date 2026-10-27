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
# Write a classic 32-bit BMP-backed ICO frame. System.Drawing.Icon.Save can emit
# a handle wrapper that Inno Setup rejects, so the ICO directory and DIB are written explicitly.
$sourceBitmap = [System.Drawing.Bitmap]::new($logoPath)
$canvas = [System.Drawing.Bitmap]::new(48, 48, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$memory = [System.IO.MemoryStream]::new()
$iconStream = $null
$writer = $null
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scale = [Math]::Min(48.0 / $sourceBitmap.Width, 48.0 / $sourceBitmap.Height)
    $drawWidth = [int][Math]::Round($sourceBitmap.Width * $scale)
    $drawHeight = [int][Math]::Round($sourceBitmap.Height * $scale)
    $drawX = [int][Math]::Floor((48 - $drawWidth) / 2.0)
    $drawY = [int][Math]::Floor((48 - $drawHeight) / 2.0)
    $graphics.DrawImage($sourceBitmap, $drawX, $drawY, $drawWidth, $drawHeight)

    # ICONDIR + one ICONDIRENTRY (22 bytes total), then a 48x48 32-bit DIB.
    $pixelBytes = 48 * 48 * 4
    $maskStride = [int]([Math]::Ceiling(48 / 32.0) * 4)
    $maskBytes = $maskStride * 48
    $imageBytes = 40 + $pixelBytes + $maskBytes
    $iconStream = [System.IO.File]::Create($iconPath)
    $writer = [System.IO.BinaryWriter]::new($iconStream)
    $writer.Write([UInt16]0)       # reserved
    $writer.Write([UInt16]1)       # icon resource
    $writer.Write([UInt16]1)       # one image frame
    $writer.Write([Byte]48)        # width
    $writer.Write([Byte]48)        # height
    $writer.Write([Byte]0)         # palette colors
    $writer.Write([Byte]0)         # reserved
    $writer.Write([UInt16]1)       # planes
    $writer.Write([UInt16]32)      # bits per pixel
    $writer.Write([UInt32]$imageBytes)
    $writer.Write([UInt32]22)      # image offset

    # BITMAPINFOHEADER: height is doubled because ICO DIBs include an AND mask.
    $writer.Write([UInt32]40)
    $writer.Write([Int32]48)
    $writer.Write([Int32]96)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]0)       # BI_RGB
    $writer.Write([UInt32]$pixelBytes)
    $writer.Write([Int32]0)
    $writer.Write([Int32]0)
    $writer.Write([UInt32]0)
    $writer.Write([UInt32]0)

    # DIB pixels are bottom-up BGRA; alpha is retained.
    for ($y = 47; $y -ge 0; $y--) {
        for ($x = 0; $x -lt 48; $x++) {
            $pixel = $canvas.GetPixel($x, $y)
            $writer.Write([Byte]$pixel.B)
            $writer.Write([Byte]$pixel.G)
            $writer.Write([Byte]$pixel.R)
            $writer.Write([Byte]$pixel.A)
        }
    }
    # Transparent AND mask; rows are padded to a 32-bit boundary.
    $writer.Write([byte[]]::new($maskBytes))
    $writer.Flush()
} finally {
    if ($writer) { $writer.Dispose() } elseif ($iconStream) { $iconStream.Dispose() }
    $memory.Dispose()
    $graphics.Dispose()
    $canvas.Dispose()
    $sourceBitmap.Dispose()
}
if ((Get-Item $iconPath).Length -ne (22 + 40 + (48 * 48 * 4) + ([int]([Math]::Ceiling(48 / 32.0) * 4) * 48))) {
    throw "Generated Vanessa icon has an unexpected ICO size."
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
