param(
    [string]$UserDataPath = (Join-Path $env:APPDATA "Vanessa"),
    [ValidateRange(1, 65535)]
    [int]$HttpsPort = 8443,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

function Get-TailscaleCli {
    $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if (-not $command) {
        $command = Get-Command tailscale -ErrorAction SilentlyContinue
    }
    if (-not $command) {
        throw "Tailscale CLI was not found. Install and sign in to Tailscale, then rerun this script."
    }
    return $command.Source
}

$tailscale = Get-TailscaleCli
$statusText = & $tailscale status --json
if ($LASTEXITCODE -ne 0) {
    throw "Tailscale is not connected. Run Tailscale and sign in before configuring private Serve."
}
$status = $statusText | ConvertFrom-Json
$dnsName = [string]$status.Self.DNSName
if ([string]::IsNullOrWhiteSpace($dnsName)) {
    throw "Tailscale did not return a MagicDNS name for this PC."
}
$dnsName = $dnsName.TrimEnd(".")
$endpoint = "wss://" + $dnsName + ":" + $HttpsPort + "/remote/v2"

Write-Host "Vanessa remote endpoint: $endpoint"
Write-Host "Local orchestrator listener: 127.0.0.1:4321"
Write-Host "Tailscale Serve target: http://127.0.0.1:4321"
Write-Host ""
Write-Host "This exposes the service only within your tailnet. It does not configure Funnel."

if (-not $Apply) {
    Write-Host "Preview only. Rerun with -Apply to configure Tailscale Serve and write Vanessa's user .env."
    exit 0
}

& $tailscale serve --bg --yes ("--https=" + $HttpsPort) "http://127.0.0.1:4321"
if ($LASTEXITCODE -ne 0) {
    throw "Tailscale Serve could not be configured. Existing Serve routes may conflict; inspect 'tailscale serve status'."
}

New-Item -ItemType Directory -Force -Path $UserDataPath | Out-Null
$envPath = Join-Path $UserDataPath ".env"
$lines = @()
if (Test-Path $envPath) {
    $lines = @(Get-Content -Path $envPath)
}

$keys = @(
    "VANESSA_REMOTE_V2_ENABLED",
    "VANESSA_REMOTE_V2_BIND_HOST",
    "VANESSA_REMOTE_V2_PORT",
    "VANESSA_REMOTE_V2_PUBLIC_ENDPOINT",
    "VANESSA_MOBILE_GATEWAY_ENABLED"
)
$kept = @($lines | Where-Object {
    $line = [string]$_
    foreach ($key in $keys) {
        if ($line -match "^\s*(export\s+)?$([regex]::Escape($key))\s*=") { return $false }
    }
    return $true
})

$updated = @($kept)
$updated += "VANESSA_REMOTE_V2_ENABLED=true"
$updated += "VANESSA_REMOTE_V2_BIND_HOST=127.0.0.1"
$updated += "VANESSA_REMOTE_V2_PORT=4321"
$updated += "VANESSA_REMOTE_V2_PUBLIC_ENDPOINT=$endpoint"
$updated += "VANESSA_MOBILE_GATEWAY_ENABLED=false"
Set-Content -Path $envPath -Value $updated -Encoding utf8

Write-Host ""
Write-Host "Tailscale Serve configured and Vanessa .env updated:"
Write-Host "  $envPath"
Write-Host "Restart Vanessa to start the authenticated v2 listener."
Write-Host "Then open Device settings > Manage paired devices > Generate QR."
