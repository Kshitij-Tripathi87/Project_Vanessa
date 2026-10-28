param(
    [string]$OutputDirectory = "artifacts/windows-installer",
    [string]$WixVersion = "5.0.2"
)
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

# Reuse the established sanitized-payload/icon pipeline so MSI and EXE install
# precisely the same committed source payload and never package a real .env.
Invoke-Checked "Prepare sanitized Windows payload and build the companion EXE" $pnpm.Source @('run', 'package:windows-installer')

$payloadRoot = Join-Path $Root 'artifacts/windows-installer-payload/Vanessa'
$iconPath = Join-Path $payloadRoot 'apps/desktop/assets/vanessa.ico'
$sourceFile = Join-Path $Root 'scripts/vanessa-installer.wxs'
if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) { throw "Sanitized installer payload is missing: $payloadRoot" }
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw "Installer icon is missing: $iconPath" }
if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "WiX source file is missing: $sourceFile" }

$resolvedOutput = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $Root $OutputDirectory }
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$msiPath = Join-Path $resolvedOutput 'Vanessa-Setup-x64.msi'

$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnet) { $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue }
if (-not $dotnet) { throw '.NET SDK is required to install the WiX CLI.' }
$wixExe = Join-Path $env:USERPROFILE '.dotnet/tools/wix.exe'
$env:PATH = "$env:USERPROFILE\.dotnet\tools;$env:PATH"
if (Test-Path -LiteralPath $wixExe) {
    Invoke-Checked "Update WiX Toolset $WixVersion" $dotnet.Source @('tool', 'update', '--global', 'wix', '--version', $WixVersion)
} else {
    Invoke-Checked "Install WiX Toolset $WixVersion" $dotnet.Source @('tool', 'install', '--global', 'wix', '--version', $WixVersion)
}
if (-not (Test-Path -LiteralPath $wixExe)) { throw "WiX CLI was not found after installation: $wixExe" }

$arguments = @(
    'build',
    $sourceFile,
    '-arch', 'x64',
    '-d', "PayloadRoot=$payloadRoot",
    '-d', 'AppVersion=0.1.0',
    '-o', $msiPath
)
Invoke-Checked 'Compile WiX x64 MSI package' $wixExe $arguments
if (-not (Test-Path -LiteralPath $msiPath -PathType Leaf)) { throw 'WiX reported success but no MSI was created.' }
$size = [Math]::Round((Get-Item -LiteralPath $msiPath).Length / 1MB, 2)
$hash = (Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "[OK] Vanessa MSI created: $msiPath" -ForegroundColor Green
Write-Host "Size: $size MiB"
Write-Host "SHA-256: $hash"
Write-Host 'Note: MSI contains the sanitized app payload; first-run setup still downloads runtime/model dependencies.'
