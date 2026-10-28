param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [switch]$RequireSignature
)
$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$encodedCertificate = [Environment]::GetEnvironmentVariable('WINDOWS_SIGNING_CERTIFICATE_BASE64')
$certificatePassword = [Environment]::GetEnvironmentVariable('WINDOWS_SIGNING_CERTIFICATE_PASSWORD')

if ([string]::IsNullOrWhiteSpace($encodedCertificate) -and [string]::IsNullOrWhiteSpace($certificatePassword)) {
    if ($RequireSignature) {
        throw 'Refusing to publish an unsigned tagged release. Configure WINDOWS_SIGNING_CERTIFICATE_BASE64 and WINDOWS_SIGNING_CERTIFICATE_PASSWORD in repository Actions secrets.'
    }
    Write-Warning 'No signing certificate configured; producing an unsigned CI/test artifact only.'
    exit 0
}
if ([string]::IsNullOrWhiteSpace($encodedCertificate) -or [string]::IsNullOrWhiteSpace($certificatePassword)) {
    throw 'Signing needs both WINDOWS_SIGNING_CERTIFICATE_BASE64 and WINDOWS_SIGNING_CERTIFICATE_PASSWORD. No secret values were displayed.'
}

$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$kitRoot = Join-Path $programFilesX86 'Windows Kits\10\bin'
$signTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signTool -and (Test-Path -LiteralPath $kitRoot)) {
    $signTool = Get-ChildItem -LiteralPath $kitRoot -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) { throw 'Microsoft SignTool x64 was not found on this Windows runner. Install Windows SDK signing tools and rerun.' }

$tempPfx = Join-Path ([IO.Path]::GetTempPath()) ("vanessa-signing-" + [Guid]::NewGuid().ToString('N') + '.pfx')
try {
    $bytes = [Convert]::FromBase64String($encodedCertificate)
    [IO.File]::WriteAllBytes($tempPfx, $bytes)
    Write-Host '[SIGN] Signing Windows installer package with SHA-256 and RFC3161 timestamp...' -ForegroundColor Cyan
    & $signTool sign /fd SHA256 /td SHA256 /tr 'http://timestamp.digicert.com' /f $tempPfx /p $certificatePassword $installer
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE." }
    & $signTool verify /pa /all $installer
    if ($LASTEXITCODE -ne 0) { throw 'Installer Authenticode signature verification failed.' }
    $signature = Get-AuthenticodeSignature -FilePath $installer
    if ($signature.Status -ne 'Valid') { throw "Windows does not consider the Setup EXE signature valid (status: $($signature.Status))." }
    Write-Host "[PASS] Installer package has a valid Authenticode signature. Signer: $($signature.SignerCertificate.Subject)" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempPfx) { Remove-Item -LiteralPath $tempPfx -Force -ErrorAction SilentlyContinue }
}
