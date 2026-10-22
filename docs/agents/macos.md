# macOS Capability Adapter

**Status:** Planned. Current report describes Windows-only adapters.

## Requirements
Implement shared capability IDs with native macOS execution for supported app launch, browser navigation, approved file access and automation via appropriate supported APIs, AppleScript, Shortcuts or Accessibility.

Declare and handle Accessibility, Automation, microphone, screen-recording and file permissions. Missing permission returns blocked/needs-permission. Do not claim Windows parity for missing features.

Use user-session context, signing/notarization and narrow entitlements. Avoid privileged agents unless necessary.

## Tests
App launch, exact URL, permitted file access, missing Accessibility permission, automation prompt, cancellation, signed package/entitlements and unsupported action.