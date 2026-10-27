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

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22+ is required by this repository bootstrap. Install Node.js LTS and rerun setup.' }
$nodeMajor = [int]((& $node.Source -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required; detected major version $nodeMajor." }
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { $pnpm = Get-Command pnpm.exe -ErrorAction SilentlyContinue }
if (-not $pnpm) { throw 'pnpm 11.24.0 is required for this repository bootstrap. Enable Corepack or install pnpm, then rerun setup.' }

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
Invoke-Checked 'pnpm install' $pnpm.Source @('install', '--frozen-lockfile')
Invoke-Checked 'pnpm build' $pnpm.Source @('build')

$needsLocalWhisper = ($asrProvider -in @('whisper', 'voice')) -or ($asrProvider -eq 'fish' -and $allowAsrFallback)
if ($needsLocalWhisper) {
    Write-Host ''
    Write-Host '[2/4] Preparing local Faster-Whisper speech recognition...' -ForegroundColor Cyan
    $venvPython = Join-Path $Root '.venv-voice/Scripts/python.exe'
    if (-not (Test-Path $venvPython)) {
        $py = Get-Command py.exe -ErrorAction SilentlyContinue
        if (-not $py) { throw 'Python 3.11 is required for local STT. Install Python 3.11 and rerun setup; no API key can replace the local speech runtime.' }
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
    if (-not $ollama) { throw 'Ollama is required by the zero-key default. Install it from https://ollama.com/download/windows, open Ollama, and rerun setup.' }
    $parsedBase = $null
    try { $parsedBase = [uri]$ollamaBase } catch { throw 'OLLAMA_BASE_URL is invalid; use http://127.0.0.1:11434.' }
    if ($parsedBase.Scheme -ne 'http' -or $parsedBase.Host -notin @('127.0.0.1', 'localhost', '::1') -or $parsedBase.AbsolutePath -ne '/') {
        throw 'OLLAMA_BASE_URL must be a loopback HTTP origin. Vanessa will not send local prompts to a remote endpoint.'
    }
    try {
        $tagResponse = Invoke-RestMethod -Method Get -Uri "$ollamaBase/api/tags" -TimeoutSec 3
    } catch {
        throw "Ollama is installed but not responding at $ollamaBase. Open Ollama from the Start menu and rerun setup."
    }
    $hasModel = $false
    foreach ($item in $tagResponse.models) { if ($item.name -eq $ollamaModel) { $hasModel = $true; break } }
    if (-not $hasModel -and -not $SkipModelDownloads) {
        Write-Host "Pulling local model '$ollamaModel' (the default qwen2.5:3b is about 2 GB)..." -ForegroundColor Yellow
        Invoke-Checked "ollama pull $ollamaModel" $ollama.Source @('pull', $ollamaModel)
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
