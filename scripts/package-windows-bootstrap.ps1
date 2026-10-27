param(
    [string]$OutputDirectory = "artifacts/windows"
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-GitChecked([string[]]$Arguments) {
    $output = & git -C $Root @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)" }
    return ($output -join [Environment]::NewLine).Trim()
}

$commit = Invoke-GitChecked @('rev-parse', '--verify', 'HEAD^{commit}')
$shortCommit = $commit.Substring(0, 7)
$resolvedOutput = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory
} else {
    Join-Path $Root $OutputDirectory
}
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$archivePath = Join-Path $resolvedOutput "Vanessa-Windows-Bootstrap-$shortCommit.zip"
if (Test-Path $archivePath) { Remove-Item -Force $archivePath }

# Use the committed tree rather than copying the working directory. This excludes
# untracked .env files, node_modules, downloaded models, logs, and other local state.
Invoke-GitChecked @('archive', '--format=zip', '--prefix=Vanessa/', "--output=$archivePath", 'HEAD') | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    $required = @(
        'Vanessa/Launch-Vanessa.bat',
        'Vanessa/scripts/setup_windows.ps1',
        'Vanessa/scripts/verify-local-setup.ps1',
        'Vanessa/.env.example',
        'Vanessa/README.md',
        'Vanessa/pnpm-lock.yaml',
        'Vanessa/WINDOWS-QUICK-START.txt'
    )
    foreach ($path in $required) {
        if ($entries -notcontains $path) { throw "Bootstrap archive is missing required file: $path" }
    }

    $forbidden = @()
    foreach ($entry in $entries) {
        $relative = $entry -replace '^Vanessa/', ''
        $isEnvExample = $relative -eq '.env.example'
        if (-not $isEnvExample -and ($relative -match '(^|/)\.env($|/)' -or $relative -match '(^|/)\.env\.')) {
            $forbidden += $entry
            continue
        }
        if ($relative -match '(^|/)(node_modules|\.git|\.venv[^/]*|venv|logs?|models|\.cache|\.pnpm-store|artifacts|data|dist|build)(/|$)') {
            $forbidden += $entry
            continue
        }
        if ($relative -match '\.(pem|key|pfx|p12|sqlite|sqlite3|db|mp3|wav|m4a|ogg|flac|pcap)$') {
            $forbidden += $entry
        }
    }
    if ($forbidden.Count) {
        throw "Bootstrap archive contains local or sensitive artifacts: $($forbidden -join ', ')"
    }
} finally {
    $archive.Dispose()
}

$file = Get-Item $archivePath
$hash = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "[OK] Windows bootstrap ZIP created: $($file.FullName)" -ForegroundColor Green
Write-Host "Commit: $commit"
Write-Host "Size: $([Math]::Round($file.Length / 1MB, 2)) MiB"
Write-Host "SHA-256: $hash"
Write-Host "This is a source bootstrap ZIP, not a signed native installer. Local setup downloads dependencies and model assets on first run."
