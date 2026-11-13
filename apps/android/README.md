# Vanessa Android — local-first development build

The Android launcher now provides a **local Qwen3 agent**, native llama.cpp inference, on-device voice adapters, and a small permission-gated phone tool set. It is a functional development build, not yet the complete phone-to-Windows companion release.

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
- The Android manifest explicitly removes `INTERNET` and `ACCESS_NETWORK_STATE`. No phone-to-PC networking is enabled by this build.
- **Authenticated phone-to-Windows pairing and PC delegation are not yet implemented in this launcher.** The canonical shared protocol is v2/ES256; the existing v1/HMAC bridge is legacy code and must not be exposed as a remote listener. Do not enable the optional unauthenticated mobile gateway for remote access.
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

1. Install the debug APK on a supported arm64 phone.
2. Open **Import model** and select a compatible Qwen3 GGUF. Keep the app open while the file is copied and hashed.
3. Confirm the checksum/import result, then select **Load model**.
4. Enter a request or use the speech-input control when on-device recognition is available.
5. Vanessa may inspect device status or today's calendar. Android requests calendar permission when required; the tool checks it again before reading.
6. Review the evidence-based response. Use speech output only when an offline TTS voice is ready.

The local agent is intentionally narrow at this stage. Remote PC capabilities should be added only after the v2 pairing, identity, approval, replay-protection, and per-device authorization path is implemented and tested end to end.
