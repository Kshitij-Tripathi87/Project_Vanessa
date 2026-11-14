# Vanessa Android — local-first development build

The Android launcher now provides a **local Qwen3 agent**, native llama.cpp inference, on-device voice adapters, permission-gated phone tools, and an authenticated protocol-v2 connection to a paired Windows PC. This is an integrated development build; physical tailnet/device validation and production signing remain release gates.

## Included capabilities

- **Local model import:** select a GGUF through Android's document picker. The importer streams into app-private storage, checks the GGUF magic and supported header version, computes SHA-256, enforces an 8 GiB file limit and storage reserve, writes to a temporary file, and atomically replaces the installed model only after validation succeeds.
- **Native local inference:** the debug APK contains the arm64 llama.cpp runtime. The model is not embedded in the APK; the user supplies a compatible Qwen3 GGUF. The runtime is loaded only after the model is re-verified.
- **Constrained local planning:** the planner uses Qwen3 ChatML and a native GBNF allow-list. It can select only `android.device.status` and `android.calendar.search`; the phone executes those read-only adapters and validates current permission at execution time. It cannot execute arbitrary shell commands or PC tools.
- **Phone device status:** reads current device profile and runtime information.
- **Calendar lookup:** reads today's phone calendar only after the user grants `READ_CALENDAR`. Calendar data is not persisted by the agent.
- **Offline speech output:** uses an installed Android TTS voice only when the voice reports that network access is not required.
- **On-device speech input:** uses Android's on-device speech recognizer on supported Android versions and devices. If one is unavailable, typed input remains available; the app does not fall back to a cloud recognizer.

## Requirements and limitations

- The APK installs on Android API 26+, but **local inference requires arm64-v8a and Android API 28+**.
- On-device STT requires Android API 31+ and a system on-device recognizer. Offline TTS requires an installed offline voice for the selected language.
- Choose a Qwen3 GGUF compatible with the pinned llama.cpp runtime and the phone's available memory. Import validation checks the GGUF header and file checksum; the native runtime performs the actual model-load compatibility check.
- The APK contains the native arm64 libraries, not model weights. Model download and selection happen outside the APK and remain under the user's control.
- The Android launcher includes a **protocol-v2/ES256 WSS bridge**. It verifies the PC P-256 public-key pin from the pairing QR, signs with a non-exportable Android Keystore identity key, receives a PC-owned capability manifest, and submits typed tasks. It does not send arbitrary shell commands.
- The PC must be online in the same Tailscale tailnet. Configure Windows Tailscale Serve using [the remote v2 setup guide](../../docs/remote-v2-setup.md), then scan the v2 QR from **Scan PC pairing QR** in the Android app. The PC owner must approve the new device and choose its scopes.
- **PC destructive file actions require a separate strong-biometric approval signature.** The Android app creates a dedicated P-256 approval key only when the handset can keep it hardware-backed in Android Keystore and require per-use strong biometric authentication. Without that key, read-only remote pairing remains available but the PC refuses to grant the file-delete capability.
- The protocol-v1/HMAC bridge is legacy and is not used by this launcher. The unauthenticated legacy mobile gateway remains disabled and loopback-only.
- CI and source tests are not proof of operation on a real tailnet. Real Windows/Android tests across Wi-Fi/mobile-data transitions, biometric hardware validation and signed release installation remain required.
- This CI artifact proves build and test success. It does not substitute for testing model load, inference latency, temperature, memory pressure, and offline voice availability on a physical phone. Release signing is also still outstanding.

## Build

Use JDK 17, Android SDK platform 35, build-tools 35.0.0, NDK 27.2.12479018, and CMake 3.22.1.

From this directory, with a pinned llama.cpp checkout available:

```sh
./gradlew \
  :core:protocol:test \
  :core:agent:test \
  :app:testDebugUnitTest \
  :app:verifyLocalInferenceApk \
  -PllamaCppDir=/absolute/path/to/llama.cpp
```

The debug APK is at `app/build/outputs/apk/debug/app-debug.apk`. Install it on an attached device with:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The Android CI workflow fetches the pinned llama.cpp source, runs these checks, verifies both native libraries are packaged and asserts that no GGUF is embedded. The latest merged build artifact is available from [Android CI run 43477637853](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/43477637853) as `vanessa-android-debug-arm64`.

## User flow

### Local agent
1. Install the debug APK on a supported arm64 phone.
2. Import a compatible Qwen3 GGUF, verify the checksum, then load the model.
3. Enter a request or use on-device speech input when supported.
4. Vanessa may inspect phone status or today's calendar. Android requests calendar permission when required and checks it again at execution.

### Remote Windows PC
1. Install and sign in to Tailscale on both devices; use the same tailnet.
2. On Windows, follow [the remote v2 setup guide](../../docs/remote-v2-setup.md) and restart Vanessa.
3. In Android, tap **Scan PC pairing QR** and scan the QR displayed by the desktop under **Manage paired devices**.
4. The phone proves possession of its Keystore identity. Approve it on the PC and select the minimum required scopes.
5. Once connected, use **PC status**, **Open Chrome**, **Find file on PC**, or **Open URL on PC**. The app shows task acceptance, progress and the PC's verified result.
6. File deletion is only shown when the PC grants that scope. The exact target and consequence are shown before strong-biometric approval. Cancel/deny means no approval is sent.
7. Use **Forget PC** to remove the stored PC pin and pairing from this handset. Revoke the device from the desktop to close active sessions.

Do not treat CI as physical-network evidence. Run the acceptance checklist in the remote v2 guide on a real Windows PC and Android handset before production release.
