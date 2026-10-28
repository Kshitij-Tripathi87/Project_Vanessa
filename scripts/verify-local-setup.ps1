$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$ConfigHome = if ($env:VANESSA_CONFIG_HOME) { [System.IO.Path]::GetFullPath($env:VANESSA_CONFIG_HOME) } else { $Root }
$ConfigPath = Join-Path $ConfigHome '.env'

function Get-EnvSetting([string]$Name, [string]$DefaultValue) {
    $envFile = $ConfigPath
    if (-not (Test-Path $envFile)) { return $DefaultValue }
    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)$'
    foreach ($line in Get-Content $envFile) {
        if ($line -match $pattern) {
            $value = $Matches[1].Trim().Trim('"').Trim("'")
            if ($value) { return $value }
        }
    }
    return $DefaultValue
}

function Fail-Preflight([string]$Reason) {
    Write-Host "[Setup required] $Reason" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $ConfigPath)) { Fail-Preflight 'Local configuration does not exist yet.' }
foreach ($relativePath in @('node_modules/dotenv/package.json', 'apps/desktop/node_modules/electron/package.json', 'services/orchestrator/node_modules/tsx/package.json')) {
    if (-not (Test-Path (Join-Path $Root $relativePath))) { Fail-Preflight 'Workspace dependencies are missing.' }
}

$asr = (Get-EnvSetting 'VOICE_ASR_PROVIDER' 'whisper').ToLowerInvariant()
$allowFallback = (Get-EnvSetting 'VOICE_ALLOW_FALLBACK' 'true').ToLowerInvariant() -eq 'true'
$needsWhisper = ($asr -in @('whisper', 'voice')) -or ($asr -eq 'fish' -and $allowFallback)
if ($needsWhisper) {
    $python = Join-Path $Root '.venv-voice/Scripts/python.exe'
    if (-not (Test-Path $python)) { Fail-Preflight 'The local speech runtime is not installed.' }
    & $python -c 'import faster_whisper, numpy, websockets, huggingface_hub' 2>$null
    if ($LASTEXITCODE -ne 0) { Fail-Preflight 'The local speech dependencies are incomplete.' }

    $voiceModel = Get-EnvSetting 'VOICE_MODEL' 'base'
    $modelChecker = Join-Path $Root 'scripts/check_local_whisper_model.py'
    if (-not (Test-Path $modelChecker)) { Fail-Preflight 'The local speech model checker is missing; rerun setup to repair the installation.' }
    & $python $modelChecker --model $voiceModel 2>$null
    if ($LASTEXITCODE -ne 0) { Fail-Preflight "The local speech model '$voiceModel' is missing or incomplete; rerun setup to download or repair it." }
}

$planner = (Get-EnvSetting 'PLANNER_PROVIDER' 'ollama').ToLowerInvariant()
$conversation = (Get-EnvSetting 'CONVERSATION_PROVIDER' (Get-EnvSetting 'SARVAM_CHAT_PROVIDER' $planner)).ToLowerInvariant()
if (($planner -eq 'ollama') -or ($conversation -eq 'ollama')) {
    $ollama = Get-Command ollama.exe -ErrorAction SilentlyContinue
    $ollamaPath = if ($ollama) { $ollama.Source } else { Join-Path $env:LOCALAPPDATA 'Programs/Ollama/ollama.exe' }
    if (-not (Test-Path $ollamaPath)) { Fail-Preflight 'The local Ollama runtime is missing.' }

    $base = Get-EnvSetting 'OLLAMA_BASE_URL' 'http://127.0.0.1:11434'
    try { $uri = [uri]$base } catch { Fail-Preflight 'OLLAMA_BASE_URL is invalid.' }
    if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1', 'localhost', '::1') -or $uri.AbsolutePath -ne '/') {
        Fail-Preflight 'The local LLM endpoint must be a loopback HTTP origin.'
    }
    try { $tags = Invoke-RestMethod -Method Get -Uri "$base/api/tags" -TimeoutSec 3 }
    catch { Fail-Preflight 'The Ollama local service is not ready.' }
    $model = Get-EnvSetting 'OLLAMA_MODEL' 'qwen2.5:3b'
    $found = $false
    foreach ($item in $tags.models) { if ($item.name -eq $model) { $found = $true; break } }
    if (-not $found) { Fail-Preflight "The local language model '$model' is not installed." }
}

Write-Host '[OK] Local runtime and workspace preflight passed.' -ForegroundColor Green
exit 0
