param([switch]$SkipModelDownloads)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Checked([string]$Label, [string]$Executable, [string[]]$Arguments) {
    Write-Host "  > $Label" -ForegroundColor DarkCyan
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}
function Get-EnvSetting([string]$Name, [string]$DefaultValue) {
    if (Test-Path (Join-Path $Root '.env')) {
        $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)$'
        foreach ($line in Get-Content (Join-Path $Root '.env')) {
            if ($line -match $pattern) {
                $value = $Matches[1].Trim().Trim('"').Trim("'")
                if ($value) { return $value }
            }
        }
    }
    return $DefaultValue
}

Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ' VANESSA - LOCAL VOICE AND MODEL SETUP (WINDOWS) ' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
if ($env:OS -ne 'Windows_NT') { throw 'This setup script supports Windows only.' }

$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    if (-not $winget) { throw 'Node.js is missing and winget is unavailable. Install Node.js LTS, reopen PowerShell, and rerun setup.' }
    Invoke-Checked 'Install Node.js LTS' $winget.Source @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $env:PATH = "$machinePath;$userPath"
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
}
if (-not $node) {
    $knownNode = Join-Path $env:ProgramFiles 'nodejs/node.exe'
    if (Test-Path $knownNode) { $script:NodeExecutable = $knownNode } else { throw 'Node.js installation finished but node.exe is not visible. Reopen PowerShell and rerun setup.' }
} else {
    $script:NodeExecutable = $node.Source
}
$nodeMajor = [int]((& $script:NodeExecutable -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required; detected major version $nodeMajor." }

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { $pnpm = Get-Command pnpm.exe -ErrorAction SilentlyContinue }
if ($pnpm) {
    $script:PnpmExecutable = $pnpm.Source
    $script:PnpmPrefix = @()
} else {
    $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $npx) { $npx = Get-Command npx.exe -ErrorAction SilentlyContinue }
    if (-not $npx) { throw 'pnpm is missing and npx is unavailable. Install pnpm 11.24.0 and rerun setup.' }
    $script:PnpmExecutable = $npx.Source
    $script:PnpmPrefix = @('--yes', 'pnpm@11.24.0')
}

if (-not (Test-Path (Join-Path $Root '.env'))) {
    Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env')
    Write-Host '[OK] Created .env from .env.example; no provider API key is needed for the default local profile.' -ForegroundColor Green
} else {
    Write-Host '[OK] Preserved existing .env; explicit provider selections are not overwritten.' -ForegroundColor Green
}

$asrProvider = (Get-EnvSetting 'VOICE_ASR_PROVIDER' 'whisper').ToLowerInvariant()
$allowAsrFallback = (Get-EnvSetting 'VOICE_ALLOW_FALLBACK' 'true').ToLowerInvariant() -eq 'true'
$plannerProvider = (Get-EnvSetting 'PLANNER_PROVIDER' 'ollama').ToLowerInvariant()
$conversationProvider = (Get-EnvSetting 'CONVERSATION_PROVIDER' (Get-EnvSetting 'SARVAM_CHAT_PROVIDER' $plannerProvider)).ToLowerInvariant()
$voiceModel = Get-EnvSetting 'VOICE_MODEL' 'base'
$ollamaModel = Get-EnvSetting 'OLLAMA_MODEL' 'qwen2.5:3b'
$ollamaBase = Get-EnvSetting 'OLLAMA_BASE_URL' 'http://127.0.0.1:11434'

Write-Host ''
Write-Host '[1/4] Installing workspace dependencies and building Vanessa...' -ForegroundColor Cyan
function Invoke-Pnpm([string[]]$Arguments) {
    $allArguments = @()
    if ($script:PnpmPrefix) { $allArguments += $script:PnpmPrefix }
    $allArguments += $Arguments
    & $script:PnpmExecutable @allArguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}
Invoke-Pnpm @('install', '--frozen-lockfile')
Invoke-Pnpm @('build')

$needsLocalWhisper = ($asrProvider -in @('whisper', 'voice')) -or ($asrProvider -eq 'fish' -and $allowAsrFallback)
if ($needsLocalWhisper) {
    Write-Host ''
    Write-Host '[2/4] Preparing local Faster-Whisper speech recognition...' -ForegroundColor Cyan
    $venvPython = Join-Path $Root '.venv-voice/Scripts/python.exe'
    if (-not (Test-Path $venvPython)) {
        $py = Get-Command py.exe -ErrorAction SilentlyContinue
        if (-not $py) {
            if (-not $winget) { throw 'Python 3.11 is required for local STT and winget is unavailable. Install Python 3.11 and rerun setup.' }
            Invoke-Checked 'Install Python 3.11 for local speech recognition' $winget.Source @('install', '--id', 'Python.Python.3.11', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
            $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
            $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
            $env:PATH = "$machinePath;$userPath"
            $py = Get-Command py.exe -ErrorAction SilentlyContinue
        }
        if (-not $py) { throw 'Python 3.11 was installed but py.exe is not visible. Reopen PowerShell and rerun setup.' }
        & $py.Source -3.11 -m venv .venv-voice
        if ($LASTEXITCODE -ne 0) { throw 'Could not create .venv-voice with Python 3.11.' }
    }
    if (-not (Test-Path $venvPython)) { throw 'The local speech virtual environment could not be created.' }
    Invoke-Checked 'Install Python speech dependencies' $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'services/voice-agent/requirements.txt')
    if (-not $SkipModelDownloads) {
        Write-Host "Downloading Faster-Whisper model '$voiceModel' (first-run download; size depends on model)..." -ForegroundColor Yellow
        Invoke-Checked 'Download/warm local speech model' $venvPython @('-c', 'import sys; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1], device="cpu", compute_type="int8"); print("Local speech model is ready.")', $voiceModel)
    }
} else {
    Write-Host "[SKIP] Local Whisper is not selected (VOICE_ASR_PROVIDER=$asrProvider)." -ForegroundColor DarkGray
}

$needsOllama = ($plannerProvider -eq 'ollama') -or ($conversationProvider -eq 'ollama')
if ($needsOllama) {
    Write-Host ''
    Write-Host '[3/4] Checking the local Ollama runtime...' -ForegroundColor Cyan
    $ollama = Get-Command ollama.exe -ErrorAction SilentlyContinue
    $ollamaExePath = if ($ollama) { $ollama.Source } else { $null }
    if (-not $ollamaExePath) {
        if (-not $winget) { throw 'Ollama is required by the zero-key default and winget is unavailable. Install it from https://ollama.com/download/windows, then rerun setup.' }
        Invoke-Checked 'Install Ollama local model runtime' $winget.Source @('install', '--id', 'Ollama.Ollama', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
        $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
        $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        $env:PATH = "$machinePath;$userPath"
        $ollama = Get-Command ollama.exe -ErrorAction SilentlyContinue
        if ($ollama) { $ollamaExePath = $ollama.Source }
        if (-not $ollamaExePath) {
            $knownOllama = Join-Path $env:LOCALAPPDATA 'Programs/Ollama/ollama.exe'
            if (Test-Path $knownOllama) { $ollamaExePath = $knownOllama }
        }
    }
    if (-not $ollamaExePath) { throw 'Ollama install finished but its executable could not be found. Reopen PowerShell and rerun setup.' }
    $parsedBase = $null
    try { $parsedBase = [uri]$ollamaBase } catch { throw 'OLLAMA_BASE_URL is invalid; use http://127.0.0.1:11434.' }
    if ($parsedBase.Scheme -ne 'http' -or $parsedBase.Host -notin @('127.0.0.1', 'localhost', '::1') -or $parsedBase.AbsolutePath -ne '/') {
        throw 'OLLAMA_BASE_URL must be a loopback HTTP origin. Vanessa will not send local prompts to a remote endpoint.'
    }
    try {
        $tagResponse = Invoke-RestMethod -Method Get -Uri "$ollamaBase/api/tags" -TimeoutSec 3
    } catch {
        Write-Host 'Ollama is installed but its local service is not responding; starting ollama serve...' -ForegroundColor Yellow
        Start-Process -FilePath $ollamaExePath -ArgumentList @('serve') -WindowStyle Minimized | Out-Null
        $deadline = (Get-Date).AddSeconds(30)
        $tagResponse = $null
        while ((Get-Date) -lt $deadline -and -not $tagResponse) {
            try { $tagResponse = Invoke-RestMethod -Method Get -Uri "$ollamaBase/api/tags" -TimeoutSec 2 } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $tagResponse) { throw "Ollama did not become ready at $ollamaBase. Open Ollama from the Start menu and rerun setup." }
    }
    $hasModel = $false
    foreach ($item in $tagResponse.models) { if ($item.name -eq $ollamaModel) { $hasModel = $true; break } }
    if (-not $hasModel -and -not $SkipModelDownloads) {
        Write-Host "Pulling local model '$ollamaModel' (the default qwen2.5:3b is about 2 GB)..." -ForegroundColor Yellow
        Invoke-Checked "ollama pull $ollamaModel" $ollamaExePath @('pull', $ollamaModel)
    } elseif (-not $hasModel) {
        Write-Host "[SKIP] Model '$ollamaModel' not installed because -SkipModelDownloads was provided." -ForegroundColor Yellow
    } else {
        Write-Host "[OK] Model '$ollamaModel' is already installed." -ForegroundColor Green
    }
} else {
    Write-Host '[SKIP] Ollama is not selected by the current .env.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '[4/4] Setup steps finished.' -ForegroundColor Green
Write-Host 'Run Launch-Vanessa.bat to start the local stack. The default profile needs no API key.' -ForegroundColor Green
Write-Host 'Note: Launch-Vanessa.bat remains a repository bootstrap, not a self-contained signed installer.' -ForegroundColor Yellow
