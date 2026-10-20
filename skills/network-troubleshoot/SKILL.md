---
name: network-troubleshoot
description: Inspect and repair Windows network adapters, restart Wi-Fi with elevation, and verify connectivity with ping
agent: system
locks:
  - network-adapter
---

# Network Troubleshoot Skill

## Objective
Diagnose and recover Windows network connectivity when Wi-Fi or Internet access fails.

## Steps
1. **Inspect Adapter State**: Run `Get-NetAdapter` to locate active Wi-Fi or Ethernet interfaces.
2. **Elevated Restart**: If requested by user, restart the interface via PowerShell:
   `Restart-NetAdapter -Name "Wi-Fi" -Confirm:$false`
3. **Wait for Association**: Allow 3-5 seconds for DHCP lease and Wi-Fi SSID re-association.
4. **Postcondition Verification**:
   - Verify interface status is `Up`.
   - Execute ping test: `Test-Connection -ComputerName 8.8.8.8 -Count 1 -Quiet`.
5. **Report Truthful Status**:
   - If ping succeeds: Return verified success.
   - If ping fails: Report manual remedy (e.g. check router or physical switch).
