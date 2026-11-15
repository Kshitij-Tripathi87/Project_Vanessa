[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)]
    [int] $Port = 4321,
    [switch] $Remove
)

$ErrorActionPreference = "Stop"
$ruleName = "Vanessa Remote v2 - Tailscale only"
$peerRange = "100.64.0.0/10"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell session. No firewall changes were made."
    }
}

Assert-Administrator

if ($Remove) {
    $existingRules = @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)
    if ($existingRules.Count -eq 0) {
        Write-Output "No '$ruleName' firewall rule exists."
        return
    }
    if ($PSCmdlet.ShouldProcess($ruleName, "Remove the Vanessa remote v2 firewall rule")) {
        $existingRules | Remove-NetFirewallRule
        Write-Output "Removed '$ruleName'."
    }
    return
}

$tailscaleCommand = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
$tailscalePath = $null
if ($null -ne $tailscaleCommand) {
    $tailscalePath = $tailscaleCommand.Source
} else {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"),
        "C:\Program Files (x86)\Tailscale\tailscale.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $tailscalePath = $candidate
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($tailscalePath)) {
    throw "tailscale.exe was not found. Install Tailscale and sign in before configuring the firewall."
}

$tailscaleOutput = & $tailscalePath ip -4 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "The Tailscale CLI could not return an IPv4 address. Confirm Tailscale is connected."
}
$tailscaleIpText = ([string]($tailscaleOutput | Select-Object -First 1)).Trim()
try {
    $tailscaleIp = [System.Net.IPAddress]::Parse($tailscaleIpText)
} catch {
    throw "Tailscale returned an invalid IPv4 address. No firewall changes were made."
}

$octets = $tailscaleIp.GetAddressBytes()
if ($octets.Length -ne 4 -or $octets[0] -ne 100 -or $octets[1] -lt 64 -or $octets[1] -gt 127) {
    throw "The returned address is not in Tailscale's 100.64.0.0/10 IPv4 range. No firewall changes were made."
}
$assignedAddress = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $tailscaleIpText -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $assignedAddress) {
    throw "The Tailscale IPv4 address is not assigned to a local interface. No firewall changes were made."
}

$existingRules = @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)
if ($existingRules.Count -gt 0) {
    if ($PSCmdlet.ShouldProcess($ruleName, "Replace the existing Vanessa remote v2 firewall rule")) {
        $existingRules | Remove-NetFirewallRule
    } else {
        Write-Output "WhatIf: would replace '$ruleName' for $tailscaleIpText TCP/$Port."
        return
    }
}

if ($PSCmdlet.ShouldProcess("$tailscaleIpText TCP/$Port", "Allow inbound remote v2 traffic only from $peerRange")) {
    New-NetFirewallRule -DisplayName $ruleName -Description "Vanessa protocol-v2 WebSocket listener on the verified Tailscale interface only." -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalAddress $tailscaleIpText -LocalPort $Port -RemoteAddress $peerRange | Out-Null
    Write-Output "Created '$ruleName'."
    Write-Output "Local address: $tailscaleIpText"
    Write-Output "Protocol/port: TCP/$Port"
    Write-Output "Allowed peer range: $peerRange"
    Write-Output "Tailscale ACLs must still restrict which tailnet devices may connect."
    Write-Output "No LAN, wildcard, public, Tailscale Serve, or Funnel listener was configured."
}
