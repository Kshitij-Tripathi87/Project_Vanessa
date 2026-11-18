# Vanessa Android — local-first companion

The Android launcher uses a local-first Compose interface with a restrained dark visual system, a state-aware Vanessa orb, scrollable feature screens, and explicit runtime status. The UI is organized around the user's primary flow rather than a catalog of setup cards.

## Application navigation

1. **Splash & boot** — reports real startup checks and waits for local model detection/loading. It does not use a timed fake progress bar.
2. **Assistant Home** — shows the phone, local model state, and Windows pairing state. The primary action opens Voice Interaction.
3. **Voice Interaction** — provides explicit on-device speech input and a typed fallback. Responses are shown as text; speech output is offered only when an offline TTS voice is available.
4. **Windows Pairing** — presents the pairing requirements and current implementation boundary.
5. **My PC** — shows the unpaired state until an authenticated companion connection is available.
6. **Settings** — reports model, voice, permissions, device, and build state; imports and validates local GGUF model files.

There is no onboarding flow or general capabilities catalogue in this initial release. Settings is a separate destination and includes the model-import workflow. The home, voice, PC, pairing, and settings pages use vertical scrolling for narrow devices and large text.

## Runtime truth and current boundaries

- **Model detection and import:** the app checks `files/models/installed.gguf` on startup. Settings lets the user select a GGUF through Android's document picker. Vanessa streams the selected file into app-private storage, enforces size and storage limits, validates the GGUF magic/header version, computes SHA-256, and atomically replaces the installed file only after validation succeeds. An optional expected SHA-256 must match the selected file. The validator does not inspect every tensor or establish model-publisher authenticity; use a checksum from a trusted source when one is available.
- **Model activation:** after import, Vanessa loads the model only when the native runtime is available and the conservative memory check passes. The UI distinguishes imported, loaded, unavailable-runtime, and insufficient-memory states. A failed validation or interrupted copy does not replace the previous installed model. Model weights are not embedded in the APK.
- **Local voice:** speech input uses Android's on-device recognizer only, after microphone permission is granted. If the system does not provide an on-device recognizer, typed input remains available. Speech output is enabled only for an installed TTS voice that reports no network requirement.
- **Phone tools:** the local planner is restricted to the existing device-status and calendar adapters. Calendar permission is requested only when the planner requires it.
- **Windows remote control:** the launcher opens the authenticated protocol-v2 remote-control screen. Scan the one-time QR payload displayed by Vanessa on the PC. The Android client pins the PC identity and uses signed P-256 messages; new phones require local approval on the PC. The app requires `INTERNET` and `ACCESS_NETWORK_STATE`, and the PC listener remains restricted to its verified Tailscale interface.
- **Biometric approval:** the Android remote-control screen uses a separate per-use biometric Keystore key for action-bound approvals. PC-side Android hardware-key attestation is not implemented yet, so destructive scopes such as `files.delete` remain disabled. A self-asserted public key is not proof of hardware backing.
- **Release state:** this is a development prototype. It is not a production-signed release and has not passed physical-device acceptance for the redesigned UI.

## Design implementation

The UI uses the design tokens from the Vanessa specification:

- Background `#0A0B0F`, surfaces `#111318` / `#171B22`, border `#23262D`.
- Cobalt primary `#0B5FFF`, primary text `#F5F7FA`, secondary text `#9AA6B2`.
- Green, amber, and red are reserved for semantic status.
- Reusable state-aware orb, status pills, device rows, section headers, inline notices, and navigation items.
- Minimum-height primary controls, accessible labels for icon-only controls, TalkBack orb descriptions, and responsive horizontal insets.
- All main destinations use vertical scrolling; the voice route preserves typed input as a first-class fallback.

## Build

Use JDK 17, Android SDK platform 35, build-tools 35.0.0, NDK 27.2.12479018, and CMake 3.22.1.

From this directory, with the pinned llama.cpp checkout available:

```sh
./gradlew \
  :core:protocol:test \
  :core:agent:test \
  :app:testDebugUnitTest \
  :app:verifyLocalInferenceApk \
  -PllamaCppDir=/absolute/path/to/llama.cpp
```

The debug APK is at `app/build/outputs/apk/debug/app-debug.apk`. This build gate requires both arm64 native inference libraries and asserts that model weights are not embedded in the APK.
