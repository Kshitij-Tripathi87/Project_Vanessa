param(
    [Parameter(Mandatory = $true)][string]$InstallerPath
)
$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installRoot = Join-Path $env:TEMP ("Vanessa-Installer-Smoke-" + [Guid]::NewGuid().ToString("N"))

function Assert-Path([string]$RelativePath) {
    $candidate = Join-Path $installRoot $RelativePath
    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "Installer smoke test: expected installed path is missing: $RelativePath"
    }
}

try {
    Write-Host "[SMOKE] Installing to isolated per-user test directory..." -ForegroundColor Cyan
    $installArgs = @(
        '/VERYSILENT',
        '/SUPPRESSMSGBOXES',
        '/NORESTART',
        '/SP-',
        ("/DIR=" + '"' + $installRoot + '"')
    )
    $process = Start-Process -FilePath $installer -ArgumentList $installArgs -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Setup EXE exited with code $($process.ExitCode)." }

    Assert-Path 'Launch-Vanessa.bat'
    Assert-Path 'scripts\Launch-Vanessa-Installed.vbs'
    Assert-Path 'scripts\verify-local-setup.ps1'
    Assert-Path 'apps\desktop\assets\vanessa.ico'
    Assert-Path '.env.example'
    if (Test-Path -LiteralPath (Join-Path $installRoot '.env')) {
        throw 'Installer smoke test: an actual .env file must never be bundled in the setup payload.'
    }
    Write-Host '[PASS] Setup installs the expected launcher, repair scripts, icon, and safe configuration template.' -ForegroundColor Green

    $uninstaller = Join-Path $installRoot 'unins000.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Installer smoke test: uninstaller was not created.' }
    Write-Host '[SMOKE] Uninstalling from the isolated test directory...' -ForegroundColor Cyan
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-') -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstall.ExitCode)." }
    if (Test-Path -LiteralPath $installRoot) {
        $leftovers = @(Get-ChildItem -LiteralPath $installRoot -Force -ErrorAction SilentlyContinue)
        if ($leftovers.Count -gt 0) {
            throw "Installer smoke test: uninstaller left $($leftovers.Count) item(s) in its install directory."
        }
        Remove-Item -LiteralPath $installRoot -Force -ErrorAction SilentlyContinue
    }
    Write-Host '[PASS] Setup and silent uninstall completed successfully.' -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $installRoot) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
