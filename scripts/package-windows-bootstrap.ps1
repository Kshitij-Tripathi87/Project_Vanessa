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

function Test-ExampleEnvFile([string]$Name) {
    return $Name -match '^\.env(\..+)?\.example$'
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

# Use the committed tree, then sanitize a temporary extracted copy. This keeps the
# user's working directory untouched and allows tracked logs/private artifacts to
# be excluded from the distributable rather than accidentally shipped.
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("vanessa-bootstrap-" + [Guid]::NewGuid().ToString("N"))
$rawZip = Join-Path $tempRoot "committed-tree.zip"
$extractRoot = Join-Path $tempRoot "extracted"
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

try {
    Invoke-GitChecked @('archive', '--format=zip', '--prefix=Vanessa/', "--output=$rawZip", 'HEAD') | Out-Null
    Expand-Archive -LiteralPath $rawZip -DestinationPath $extractRoot -Force
    $stageRoot = Join-Path $extractRoot "Vanessa"
    if (-not (Test-Path $stageRoot -PathType Container)) { throw "Git archive did not contain the expected Vanessa root." }

    # Remove directories that only belong to a developer machine or build output.
    $directoryNames = @('node_modules', '.git', '.venv', 'venv', 'logs', 'log', '.cache', '.pnpm-store', 'artifacts', 'dist', 'build')
    $directories = @(Get-ChildItem -LiteralPath $stageRoot -Directory -Recurse -Force |
        Where-Object {
            $name = $_.Name
            ($directoryNames -contains $name) -or $name.StartsWith('.venv', [StringComparison]::OrdinalIgnoreCase)
        } |
        Sort-Object { $_.FullName.Length } -Descending)
    foreach ($directory in $directories) {
        if (Test-Path -LiteralPath $directory.FullName) {
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        }
    }

    # Keep safe sample templates at any depth; strip actual environment files,
    # credential stores, local databases, logs and downloaded model-weight blobs.
    $files = @(Get-ChildItem -LiteralPath $stageRoot -File -Recurse -Force)
    foreach ($item in $files) {
        $name = $item.Name
        $remove = $false
        if (($name -eq '.env' -or $name -like '.env.*') -and -not (Test-ExampleEnvFile $name)) {
            $remove = $true
        }
        if ($name -match '\.(log|pem|key|pfx|p12|sqlite|sqlite3|db|mp3|wav|m4a|ogg|flac|pcap|gguf|safetensors|onnx|pt|pth)$') {
            $remove = $true
        }
        if ($remove) { Remove-Item -LiteralPath $item.FullName -Force }
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $extractRoot,
        $archivePath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        $required = @(
            'Vanessa/Launch-Vanessa.bat',
            'Vanessa/scripts/setup_windows.ps1',
            'Vanessa/scripts/verify-local-setup.ps1',
            'Vanessa/.env.example',
            'Vanessa/README.md',
            'Vanessa/pnpm-lock.yaml',
            'Vanessa/WINDOWS-QUICK-START.txt'
        )
        foreach ($requiredPath in $required) {
            if ($entries -notcontains $requiredPath) { throw "Bootstrap archive is missing required file: $requiredPath" }
        }

        $forbidden = @()
        foreach ($entry in $entries) {
            $relative = $entry -replace '^Vanessa/', ''
            $name = [IO.Path]::GetFileName($relative)
            $isEnvExample = Test-ExampleEnvFile $name
            if (($name -eq '.env' -or $name -like '.env.*') -and -not $isEnvExample) {
                $forbidden += $entry
                continue
            }
            if ($relative -match '(^|/)(node_modules|\.git|\.venv[^/]*|venv|logs?|\.cache|\.pnpm-store|artifacts|dist|build)(/|$)') {
                $forbidden += $entry
                continue
            }
            if ($relative -match '\.(log|pem|key|pfx|p12|sqlite|sqlite3|db|mp3|wav|m4a|ogg|flac|pcap|gguf|safetensors|onnx|pt|pth)$') {
                $forbidden += $entry
            }
        }
        if ($forbidden.Count) {
            throw "Bootstrap archive still contains forbidden local or sensitive artifacts: $($forbidden -join ', ')"
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
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
