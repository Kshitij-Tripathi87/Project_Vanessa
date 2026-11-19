# Vanessa Android — local-first companion

The Android launcher is a local-first Compose interface built to the Vanessa visual reconstruction specification: an obsidian-black surface, a glossy 3D orb as the only brand mark, electric-cobalt lighting with lime accents, and a flowing ribbon waveform. The orb, its orbital rings, the waveform and the progress arcs are separate animated elements rather than one baked illustration, so each can react to its own state.

## Application navigation

1. **Splash & boot** — reports real startup checks and waits for local model detection/loading. It does not use a timed fake progress bar.
2. **Welcome** — orb, greeting and the primary entry point. The greeting is derived from the device clock, so it is never wrong.
3. **Onboarding** — three value propositions (voice-first, automation, on-device privacy) with a progress indicator.
4. **Permissions** — microphone and calendar, each showing its live grant state. Vanessa asks for nothing else; the screen says so rather than implying notification or location access.
5. **Assistant (chat)** — orb-first conversation surface: greeting state, transcript, composer and a listening entry point. Also reports local model state.
6. **Listening** — dedicated voice surface: orb, ribbon waveform, stop control, and the recogniser's real status. "Type instead" returns to the composer.
7. **Confirm Action** — approval gate. Appears only when an action actually needs approval: replacing an already-installed local model. The copy names the file at risk.
8. **Executing Task** — progress arcs around the orb plus a checklist of steps **actually observed**, never a fabricated percentage.
9. **Success** — reachable only when work genuinely completed; "Great!" returns to the chat.
10. **Windows Pairing / My PC** — pairing requirements and the authenticated protocol-v2 remote control boundary.
11. **Settings** — reports model, voice, permissions, device, and build state; imports and validates local GGUF model files.

Onboarding is stored in `SharedPreferences` and shown once; every destination is vertically scrollable for narrow devices and large text.

## Runtime truth and current boundaries

- **Model detection and import:** the app checks `files/models/installed.gguf` on startup. Settings lets the user select a GGUF through Android's document picker. Vanessa streams the selected file into app-private storage, enforces size and storage limits, validates the GGUF magic/header version, computes SHA-256, and atomically replaces the installed file only after validation succeeds. An optional expected SHA-256 must match the selected file. The validator does not inspect every tensor or establish model-publisher authenticity; use a checksum from a trusted source when one is available.
- **Model activation:** after import, Vanessa loads the model only when the native runtime is available and the conservative memory check passes. The UI distinguishes imported, loaded, unavailable-runtime, and insufficient-memory states. A failed validation or interrupted copy does not replace the previous installed model. Model weights are not embedded in the APK.
- **Local voice:** speech input uses Android's on-device recognizer only, after microphone permission is granted. If the system does not provide an on-device recognizer, typed input remains available. Speech output is enabled only for an installed TTS voice that reports no network requirement.
- **Phone tools:** the local planner is restricted to the existing device-status and calendar adapters. Calendar permission is requested only when the planner requires it.
- **Windows remote control:** the launcher opens the authenticated protocol-v2 remote-control screen. Scan the one-time QR payload displayed by Vanessa on the PC. The Android client pins the PC identity and uses signed P-256 messages; new phones require local approval on the PC. The app requires `INTERNET` and `ACCESS_NETWORK_STATE`, and the PC listener remains restricted to its verified Tailscale interface.
- **Biometric approval:** the Android remote-control screen uses a separate per-use biometric Keystore key for action-bound approvals. PC-side Android hardware-key attestation is not implemented yet, so destructive scopes such as `files.delete` remain disabled. A self-asserted public key is not proof of hardware backing.
- **Release state:** this is a development prototype. It is not a production-signed release and has not passed physical-device acceptance for the redesigned UI.

## Design implementation

Colour and type come from the reference board, declared once and split by
purpose:

| File | Responsibility |
|---|---|
| `ui/theme/VanessaColors.kt` | Palette and the brushes built from it |
| `ui/theme/VanessaTypography.kt` | The board's type scale, mapped onto Material's slots |
| `ui/theme/VanessaDimensions.kt` | Radii, spacing, orb size fractions, motion timings |
| `ui/theme/VanessaTheme.kt` | The Material theme (dark only, by design) |

- Obsidian `#03050A` background, midnight navy `#080F22`, card surface `#151C2D`.
- Electric blue `#0755FF`, cyan `#35A5FF`, lime `#A8F443` reserved for highlights, active states and completion.
- Cool grey `#B9C5DA` secondary text, `#7C879B` dim labels, white primary text.

### The sphere is an asset; the light is not

`res/drawable-nodpi/vanessa_sphere.png` is an original render: a black glass
body, cobalt rim on the upper left, a lime spill on the lower right, on a black
field. Its alpha is baked in and feathered just outside the silhouette, so it
composites onto any background without a visible edge — no black pad, no
clipping artefact.

Everything that has to move is drawn in Compose on top of it:

| File | Responsibility |
|---|---|
| `ui/components/VanessaOrb.kt` | Bloom, orbits (behind and in front), particles, travelling rim light, cyan glint, lime spill, completion check |
| `ui/components/OrbitalRings.kt` | Elliptical orbits split across the sphere's equator, with a light node per ring |
| `ui/components/EnergyWave.kt` | Ribbon waveform (four superposed sines), progress ring, top light beam |
| `ui/components/NeonButton.kt` | Primary sweep, secondary outline, circular icon control; 170 ms press response |
| `ui/VanessaMotion.kt` | Per-element frame clock; honours the system animator duration scale |

The division is deliberate. A still image carries sub-surface falloff and glass
sheen better than a canvas can, but a still image cannot respond to the
microphone, the model or the task runtime. Baked lighting plus animated overlays
is the only arrangement that keeps both the depth and the *statefulness*.

The Compose canvas has no `shadowBlur`, so soft glow is rebuilt from stacked
translucent strokes and gradients that fall to zero before their own edges — no
hard seams and no card-like glow boxes.

### The task lifecycle

`ui/state/RemoteTaskUi.kt` folds protocol-v2 events into the phase the screens
render. It is pure, and unit-tested in `app/src/test/.../RemoteTaskUiTest.kt`:

| File | Responsibility |
|---|---|
| `ui/screens/TaskApprovalScreen.kt` | Consequence, target and expiry as separate facts; biometric-only approval |
| `ui/screens/TaskExecutionScreen.kt` | The PC's own state label and summaries; a ring only if a percentage was reported |
| `ui/screens/TaskResultScreen.kt` | Five tones (success, partial, unverified, failure, unknown) and a protocol-error screen |

The invariants it enforces, because they are the ones a polished UI is tempted
to break: no percentage that the PC did not send; no green tick on a result the
PC never verified; no approvable button for an approval that cannot be bound to
an action hash; and no task outcome for a connection that simply went away.

### Deviations from the reference brief, and why

- **Permissions.** The brief lists Microphone / File Access / Notifications /
  Location. This build requests only the microphone and the calendar. Files are
  chosen through the system document picker, which needs no blanket storage
  permission, and the app has no notification or location feature. The screen
  shows the three rows it can honour and states the omission explicitly rather
  than drawing four ticks for access that was never requested.
- **Confirm Action.** The brief's copy describes deleting folders. Vanessa has
  no folder-deletion capability, so the same gate guards the destructive action
  it does have: replacing an installed model.
- **Executing.** The brief shows a three-step checklist for a known task. The
  checklist here lists only steps the app can actually observe (copy/validate,
  then load).
- **Waveform amplitude.** The recogniser does not expose an input level, so the
  waveform is driven by assistant state (idle, listening, working, complete).
  It is an indication of state, not a claimed measurement of the microphone.
- **Stop control.** The protocol defines `task.cancel`, but the phone's bridge
  client does not expose it yet. The execution screen therefore draws no stop
  button instead of drawing one that does nothing. Wiring cancel — including
  waiting for `task.cancel_ack` before claiming the task stopped — is the next
  piece of work.
- **Fonts.** The board asks for Inter / SF Pro Display / Manrope / Google Sans.
  None is bundled: that means owning a licence and a download, and a
  downloadable font silently falls back on a device with no network. The
  platform sans is used with metrics tuned to the board's line heights.
- **Pairing and settings screens.** Still on Material defaults in
  `RemoteControlActivity`; they are migrated in the next pass. The lifecycle
  screens that replace them for task work are fully on the new components.

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
