param(
    [Parameter(Mandatory = $true)][string]$MsiPath
)
$ErrorActionPreference = 'Stop'
$msi = (Resolve-Path -LiteralPath $MsiPath).Path
$installRoot = Join-Path $env:TEMP ("Vanessa-MSI-Smoke-" + [Guid]::NewGuid().ToString("N"))
$logPath = Join-Path $env:TEMP ("Vanessa-MSI-Smoke-" + [Guid]::NewGuid().ToString("N") + ".log")
$msiexec = Join-Path $env:WINDIR 'System32\msiexec.exe'
$programsFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Vanessa'
$shortcut = Join-Path $programsFolder 'Vanessa.lnk'
$quote = [char]34

function Invoke-Msi([string]$Arguments, [string]$Action) {
    Write-Host "[SMOKE] $Action..." -ForegroundColor Cyan
    $process = Start-Process -FilePath $msiexec -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) {
        if (Test-Path -LiteralPath $logPath) {
            Get-Content -LiteralPath $logPath -Tail 60 | ForEach-Object { Write-Host $_ }
        }
        throw "$Action failed with msiexec exit code $($process.ExitCode)."
    }
}
try {
    $installArgs = "/i $quote$msi$quote /qn /norestart INSTALLFOLDER=$quote$installRoot$quote /l*v $quote$logPath$quote"
    Invoke-Msi $installArgs 'Install Vanessa MSI into isolated per-user folder'

    foreach ($relative in @(
        'Launch-Vanessa.bat',
        'scripts\Launch-Vanessa-Installed.vbs',
        'scripts\verify-local-setup.ps1',
        'apps\desktop\assets\vanessa.ico',
        '.env.example'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative) -PathType Leaf)) {
            throw "MSI smoke test: expected installed file is missing: $relative"
        }
    }
    if (Test-Path -LiteralPath (Join-Path $installRoot '.env')) {
        throw 'MSI smoke test: actual .env must never be bundled.'
    }
    if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) {
        throw 'MSI smoke test: Vanessa Start Menu shortcut was not created.'
    }
    Write-Host '[PASS] MSI installed the launcher, repair scripts, icon and Start Menu shortcut without an actual .env.' -ForegroundColor Green

    $uninstallArgs = "/x $quote$msi$quote /qn /norestart /l*v $quote$logPath$quote"
    Invoke-Msi $uninstallArgs 'Uninstall Vanessa MSI'
    if (Test-Path -LiteralPath (Join-Path $installRoot 'Launch-Vanessa.bat')) {
        throw 'MSI smoke test: application files remain after uninstall.'
    }
    if (Test-Path -LiteralPath $shortcut) {
        throw 'MSI smoke test: Start Menu shortcut remains after uninstall.'
    }
    Write-Host '[PASS] MSI silent uninstall removed the app files and Start Menu shortcut.' -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue }
}
