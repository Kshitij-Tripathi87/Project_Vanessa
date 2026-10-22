# Windows System Agent

**ID:** windows; compatibility alias: system. Primary target: Windows 11.

## Scope
Typed actions for Wi-Fi state/restart, Bluetooth state/toggle, volume, app launch/close and screenshots through explicit PowerShell/WinRT/native adapters.

## Rules
- Never expose arbitrary PowerShell to the model.
- Validate parameters and use allowlisted commands.
- Run as the logged-in user; elevation is a separate approval-gated action.
- Persist state before network-changing operations because Wi-Fi reset may disconnect relay.
- Query actual state after acting; process exit code alone may not prove the change.
- Honor cancellation/timeouts. Unsupported platform/capability returns unsupported, never fake success.

## Tests
State query, permitted toggle, denied operation, adapter missing, timeout, network reconnect, argument injection, cancellation, no admin by default and unsupported capability.