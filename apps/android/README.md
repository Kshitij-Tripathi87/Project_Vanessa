# Vanessa Android — local-first companion

The Android app uses a local-first Jetpack Compose interface with a first-run onboarding flow, an orb-first assistant home, a unified voice/chat conversation screen, My PC, and Settings. The UI uses solid near-black surfaces, cobalt interaction accents, a restrained lime signal colour, and a floating near-black sphere as the assistant identity. It does not use gradient surfaces, glassmorphism, or a logo mark.

## Application navigation

1. **Splash & boot** — reports real startup checks and waits for local model detection/loading; it does not use a timed fake progress bar.
2. **First-run onboarding** — three short screens introduce Vanessa, explain the voice/chat interaction model, and clarify that local model import and Windows pairing can be completed later. The completion state is persisted on-device.
3. **Assistant Home** — places the floating orb at the centre, with a compact text composer, microphone entry point, one planning shortcut, and a My PC shortcut.
4. **Conversation** — keeps typed input, explicit on-device speech input, text responses, and optional offline speech output in one route.
5. **My PC / Pairing** — exposes the authenticated PC pairing entry point and does not display fabricated live telemetry.
6. **Settings** — reports model, voice, permissions, device, and build state; imports and validates local GGUF model files.

A persistent three-destination bottom navigation connects Assistant, My PC, and Settings. Onboarding is intentionally outside that navigation. Main destinations scroll on narrow devices and respect safe drawing and keyboard insets.

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

- Background `#07090D`, surfaces `#10141B` / `#171E29`, border `#252E3B`.
- Cobalt primary `#1B5FFF`, lime accent `#C8F23F`, primary text `#F2F5F8`, secondary text `#98A3B2`.
- The orb is drawn from solid near-black layers with a cobalt upper-left rim, a small lime lower-right arc, and a restrained specular point. No gradient fills are used.
- Reusable state-aware orb, status pills, section headers, inline notices, quick actions, and bottom navigation.
- Minimum 48 dp navigation targets, accessible icon labels, TalkBack orb descriptions, and responsive horizontal insets.
- Main destinations use vertical scrolling and apply safe-drawing plus IME insets; the conversation route keeps typed input available when speech is unavailable.

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
