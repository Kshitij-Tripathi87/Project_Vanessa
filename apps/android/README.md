# Vanessa Android — UI prototype

The Android launcher uses a local-first Compose interface with a restrained dark visual system, a state-aware Vanessa orb, scrollable feature screens, and explicit runtime status. The UI is organized around the user's primary flow rather than a catalog of setup cards.

## Application navigation

1. **Splash & boot** — reports real startup checks and waits for local model detection/loading. It does not use a timed fake progress bar.
2. **Assistant Home** — shows the phone, local model state, and Windows pairing state. The primary action opens Voice Interaction.
3. **Voice Interaction** — provides explicit on-device speech input and a typed fallback. Responses are shown as text; speech output is offered only when an offline TTS voice is available.
4. **Windows Pairing** — presents the pairing requirements and current implementation boundary.
5. **My PC** — shows the unpaired state until an authenticated companion connection is available.
6. **Settings** — reports model, voice, permissions, device, and build state.

There is no onboarding flow, model-import screen, capabilities catalog, or biometric-approval screen in this UI prototype. Settings is a separate destination. The home, voice, PC, pairing, and settings pages use vertical scrolling for narrow devices and large text.

## Runtime truth and current boundaries

- **Model detection:** the app checks the existing app-private `files/models/installed.gguf` location on startup. If the file is valid and the native runtime is present, Vanessa attempts to load it automatically when available memory is above the conservative startup threshold. The UI shows the detected filename, size, computed SHA-256 prefix, and actual runtime/load state.
- **No import flow:** users are not prompted to browse for a GGUF file. Model weights are not embedded in the APK. If the expected app-private model file has not been provisioned, the app reports that no model is active and does not run an inference request.
- **Local voice:** speech input uses Android's on-device recognizer only, after microphone permission is granted. If the system does not provide an on-device recognizer, typed input remains available. Speech output is enabled only for an installed TTS voice that reports no network requirement.
- **Phone tools:** the local planner is restricted to the existing device-status and calendar adapters. Calendar permission is requested only when the planner requires it.
- **Windows connection:** this launcher build removes `INTERNET` and `ACCESS_NETWORK_STATE` from the manifest. The visible pairing and PC dashboard screens are navigable prototype surfaces, but authenticated v2 pairing, QR redemption, live PC telemetry, remote actions, and result delivery are not connected here. The UI does not present the old legacy HMAC bridge as secure pairing and does not fabricate connected state or PC metrics.
- **Biometric approval:** no approval screen is shown in this prototype UI. Protected remote operations must be connected to the action-bound v2 approval contract before they are exposed.
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
./gradlew \\
  :core:protocol:test \\
  :core:agent:test \\
  :app:testDebugUnitTest \\
  :app:verifyLocalInferenceApk \\
  -PllamaCppDir=/absolute/path/to/llama.cpp
```

The debug APK is at `app/build/outputs/apk/debug/app-debug.apk`. This build gate requires both arm64 native inference libraries and asserts that model weights are not embedded in the APK.
