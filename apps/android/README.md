# Vanessa Android foundation

This is an **installable development APK**, not the finished distributed assistant. The launcher provides live device diagnostics and a read-only phone calendar query with an Android runtime permission. It does **not** have local Qwen inference, offline voice, authenticated v2 pairing, PC delegation or Drive uploads. The legacy HMAC/cleartext pairing code remains in the source for migration work but is not exposed by the launcher or manifest; do not re-enable it for remote access.

## Build

Install JDK 17 and Android SDK platform 35/build-tools 35.0.0. Set `JAVA_HOME` and `ANDROID_HOME` (or provide `local.properties` with `sdk.dir` locally), then:

```sh
./gradlew :core:protocol:test :app:testDebugUnitTest :app:assembleDebug
```

The installable development APK is at `app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r app/build/outputs/apk/debug/app-debug.apk` on an API 26+ device. Android CI runs the same Gradle tasks. Release signing and real-device verification are not included.

The launcher never requests network access. For calendar search it requests `READ_CALENDAR` when the user taps “Check today's meetings,” rechecks permission inside the adapter, does not store events, and reports provider errors or missing permission distinctly from an empty calendar. The device profile uses runtime measurements; model readiness remains false until an inference runtime and model load have actually been validated.

Next security-dependent step: finish the signed v2 Kotlin protocol and PC Host Agent identity/approval path before exposing QR pairing or PC tools on the phone. See `docs/architecture/distributed-agent-p0-p3.md` for the implementation contract.
