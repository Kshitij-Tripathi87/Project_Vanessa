# Vanessa: Zero-Key Install and Voice Reliability Plan

**Status:** Implementation plan and engineering contract  
**Target platform:** Windows 11 desktop first  
**Target branch:** feature/kshitij-voice-agent-plane  
**Primary goal:** Someone downloads and installs Vanessa, opens the app, and can type a command immediately or use the microphone without creating provider accounts or pasting API keys.

## 1. Executive decision

Vanessa must be a product with a managed runtime, not a collection of scripts that only works on the developer's machine.

The application has three explicit runtime profiles:

1. **Local / zero-key (default):** a local Ollama model for planning and conversation, local Faster-Whisper for speech recognition, and OS/browser speech synthesis as a no-key TTS path. Provider keys are not required. First installation downloads model assets and therefore needs internet, disk space, and compatible hardware. Once models are present, core speech and reasoning can operate locally.
2. **Vanessa Managed (hosted profile, follow-up release):** the desktop authenticates to a Vanessa-owned service. Provider credentials live only on that service. Users receive a supported experience without API keys, but account identity, quotas, billing, abuse protection, backend operations, and privacy/retention policy must exist before this mode is advertised.
3. **Bring Your Own Key (developer / advanced profile):** optional provider overrides. Keys remain in a per-user OS-protected store or a local development .env; keys never ship in installers, renderer bundles, source control, crash reports, or ordinary logs.

**Non-negotiable security rule:** do not put a shared provider key in .env.example, a packaged .env, a batch file, JavaScript bundle, or the installer. Obfuscation is not secret storage. A local .env is a developer configuration mechanism, not a safe distribution method for a shared secret.

A no-key product still has an operating cost if it calls a hosted provider. There are only two honest ways to ship zero-key cloud-quality AI: operate an authenticated managed backend with controls, or run supported models locally. This plan chooses local-first for the initial usable release, and treats the managed gateway as a separate production system—not as a fake endpoint or bundled credential.

## 2. What the current code shows

The current workspace has a useful foundation but does not yet provide an installer-grade zero-key experience:

- Launch-Vanessa.bat is a launcher, not a standalone installer. It delegates to scripts/launch-vanessa.cjs, which requires Node.js, workspace dependencies, builds, and local ports.
- The launcher loads the repository-root .env into its child-process environment, and the voice/orchestrator packages also load that file from source/dist-relative paths. This is suitable for development, but a packaged app needs a per-user configuration path and managed process lifecycle.
- Current provider defaults select cloud-backed LLM/voice providers. Missing keys are warnings in ordinary startup, so a service can start while actual recognition/planning is unavailable.
- A local Faster-Whisper WebSocket server already exists in services/voice-agent/voice_server.py, and the launcher can manage it when the Python virtual environment exists. The current setup script does not create that environment or install/download the model.
- The voice renderer already uses getUserMedia, a worklet, and 16-kHz PCM frames. Electron grants media permission to the trusted renderer, but Windows privacy settings, missing hardware, occupied devices, and audio initialization can still fail.
- The Fish TTS adapter already supports an explicit browser speech-synthesis fallback. Typed requests also have a direct orchestrator path in --text-only mode.
- The orchestrator's current model router supports NVIDIA and Sarvam; there is no first-class local LLM provider. That is a hard blocker for true keyless planning and conversation.
- There are deterministic launcher, voice-provider, and CI tests, but no dedicated user-facing microphone error taxonomy or real-install acceptance suite.

This work must preserve the existing permission gate, request IDs/idempotency, task verification semantics, provider redaction, and honest partial/failure statuses.

## 3. Target user experience

### First launch

1. User launches the installer-built app (the current .bat remains a developer/bootstrap path until a native installer is shipped).
2. Vanessa runs a bounded preflight and displays distinct readiness states: Desktop, Orchestrator, Local LLM, Speech recognition, Speech output, and Microphone.
3. First-run setup installs or locates the supported local runtime, prepares the Python voice environment, and downloads the configured model. Downloads show progress, can be retried, verify exit status, and never overwrite the user's existing .env.
4. Vanessa runs a playback test and a microphone capture test initiated by a user gesture. Permission errors include direct Windows privacy instructions; missing devices and busy devices are distinct.
5. User can type a command at all times, even when voice is offline. A missing provider must never make the entire desktop unusable.
6. Vanessa reports which mode/provider is active and whether a request used local or cloud services. No quiet provider switch, simulated success, or false “verified” status.

### Everyday launch

- Launch is one click; no terminal and no credential fields for the default local profile.
- Services bind only to loopback by default; each service has a health/readiness endpoint.
- The launcher waits for readiness, not merely an open TCP port.
- Local Whisper and the voice agent are supervised as optional capabilities in normal mode: startup/runtime failure is reported as degraded voice state instead of shutting down the desktop/orchestrator. Strict diagnostic/test mode still fails fast. Typed requests fall back to the orchestrator over the trusted desktop IPC channel when the voice socket is not open.
- Startup failure explains the failing dependency and gives one remediation action.
- Logs use request IDs and sanitized provider/device codes. They do not record audio, full transcripts by default, or credentials.
- If microphone input fails, text remains fully usable. If external TTS fails, browser/OS speech synthesis may speak the response only when the configured fallback says so. If STT fails, Vanessa must ask the user to retry or type the command; it must not invent a transcript.

## 4. Architecture

~~~text
Install / First Run
        |
        v
Bootstrap + Runtime Manifest
  - verify Windows / architecture / disk / permissions
  - prepare Python venv + Faster-Whisper
  - install/verify Ollama + pull configured local model
  - create user config only if absent
        |
        v
Vanessa Desktop (Electron renderer)
  - compact orb + typed command path
  - mic capability/permission diagnostics
  - per-provider readiness and recovery guidance
        |
        +---- IPC (allow-listed, typed, context-isolated)
        |
        v
Local Supervisor / Launcher
  - owns child-process lifecycle
  - checks health + model availability
  - bounded startup/retry/shutdown
  - sanitized, rotating logs
        |
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
Orchestrator              Voice Service          Local LLM
- planner                 - WebSocket            - Ollama localhost
- safety/approval         - adapter lifecycle     - no provider key
- specialized agents      - safe fallback
- verify actual result          |
                               v
                       Local Whisper ASR
                       16-kHz PCM from mic

Speech output: configured provider -> explicitly permitted browser/OS fallback
Text path: Desktop -> trusted IPC -> same orchestrator, independent of mic
Optional managed profile: Desktop -> authenticated Vanessa gateway -> server-side providers
~~~

### Configuration ownership

- **Development:** repository-root .env is loaded by the launcher; .env.example contains non-secret defaults and blank optional credential fields.
- **Distributed desktop:** configuration and user preferences live under Electron's per-user app.getPath("userData"). Secrets use the platform-backed secure store (Electron safeStorage backed by Windows protection) and are only passed to trusted main/service processes. A packaged app must not depend on a repository-relative .env.
- **Managed backend:** provider keys remain in the server secret manager and are accessed only by the gateway. Desktop tokens are short-lived and scoped to a user/device. No master provider key goes to a client.
- **Never:** put provider credentials in VITE_ variables, renderer state, WebSocket payloads, logs, source code, release assets, diagnostics uploads, or a committed file.

## 5. Provider and fallback policy

| Capability | Zero-key default | Optional replacement | Failure contract |
|---|---|---|---|
| Planner + conversation | Local Ollama model | Authenticated managed provider, or explicit BYOK NVIDIA/Sarvam | Clear local-runtime/model error; never report successful planning without a plan |
| STT | Local Faster-Whisper | Fish/Sarvam with user-managed credentials or managed gateway | Distinguish permission, device, transport, provider auth/quota, empty transcript |
| TTS | Browser/OS speech synthesis | Fish/Sarvam/ElevenLabs or managed gateway | Keep the written response; label actual speech provider/fallback |
| Audio capture | Electron renderer getUserMedia on a trusted local origin | None; this is device access | Actionable Windows privacy/device guidance, cleanup tracks/context on failure |
| Text command | Always available | Same orchestrator | Connection failure is visible; no voice dependency |
| OS / browser / file actions | Existing specialized agents and permission guard | N/A | Require real execution and verification evidence |

A fallback is capability-specific. Local TTS fallback does not imply local STT fallback; local STT does not imply local LLM. The readiness report must represent these as separate capabilities.

## 6. Installer and runtime lifecycle

The production release should be a signed Windows installer (MSIX or a well-tested NSIS-based Electron package), not merely a .bat file over a source checkout.

Installer responsibilities:
- Include the Electron app, required Node runtime, and service assets; the user should not need a global Node/pnpm installation for a normal release.
- Provide a first-run bootstrap for local model components. Verify installer signatures/checksums where available; pin versions and record them in a runtime manifest.
- Offer a local model download step with size estimate, disk check, progress, retry, cancellation, and clear offline behavior.
- Never download and immediately execute an unverified script in a privileged shell.
- Install to a user-writable location where practical and avoid unnecessary administrator elevation.
- Upgrade without deleting user configuration, stored credentials, logs, or downloaded models.
- Cleanly stop only processes started by Vanessa, never arbitrary processes occupying a port.
- Provide repair/reset actions that distinguish app state from user secrets and model cache.

The current .bat is kept as a development/portable bootstrap until packaged releases exist. Documentation must not call it a self-contained installer.

## 7. Microphone failure handling

Implement a pure error classifier with deterministic tests for browser/Electron error names. At minimum:

- NotAllowedError / PermissionDeniedError: Windows Settings → Privacy & security → Microphone; verify device access and “Let desktop apps access your microphone”, then restart Vanessa.
- NotFoundError / DevicesNotFoundError: no capture device; connect/select an input in Windows Sound settings.
- NotReadableError / TrackStartError: device is busy, disconnected, blocked by OS policy, or unavailable; close apps using the microphone and retry.
- SecurityError / missing navigator.mediaDevices: untrusted/insecure renderer origin or runtime issue; use Vanessa's local origin and restart the packaged app.
- AudioContextUnavailableError / worklet failure: local audio pipeline could not initialize; release the opened stream, close the context, and present a distinct audio-engine message.
- AbortError: capture was interrupted; offer retry.
- Unknown errors: safe, concise fallback message with a diagnostic code; do not dump raw exception details into the UI.

Resource cleanup is mandatory on every failure path: stop acquired media tracks, disconnect worklet/source/analyser nodes, cancel animation frames, close an unneeded AudioContext, reset active flags, and retain typed-command usability. Permission checks must never bypass Windows OS privacy policy.

The expanded HUD menu also provides an explicit local-only microphone self-test: it samples the input for 1.6 seconds, reports signal versus silence, never opens the ASR WebSocket or transmits test audio, and always releases tracks/audio nodes. A passing test proves capture signal only; users still need one real command to verify STT and downstream orchestration. The menu also tests the browser/OS speech-synthesis fallback without provider credentials. The completion callback cannot prove the user physically heard the sound, so the UI asks them to confirm it. Input-device selection and a direct Windows Settings shortcut remain follow-up work.

## 8. Model and hardware policy

- Default local LLM model is configurable. Start with a small instruction-following model suitable for common desktop hardware; install it once, then verify the exact model tag is present before launching.
- The local model may be slower or less capable than a hosted frontier model. The application must report model identity and performance mode honestly.
- Faster-Whisper's model download is separate from the LLM download and must be verified independently.
- The installer checks free disk space and offers a smaller/larger model selection in a later iteration. Do not automatically download multi-gigabyte assets without disclosing the size.
- Local models do not remove action safety requirements. The same server-side schema validation, allowed-action catalog, permission guard, approval checks, and result verification apply.

## 9. Security, privacy, reliability, and cost

- Local services bind to loopback; WebSocket origin checks and Electron context isolation remain enabled.
- Validate external LLM URLs, provider names, configured models, timeouts, payload sizes, and ports before use.
- Secrets are redacted from provider errors and process output. Do not hash-log API keys or print any key fragments.
- Local ASR logs utterance length and language only by default; raw transcript logging requires explicit opt-in via VANESSA_LOG_TRANSCRIPTS=true for local debugging and should not be enabled in normal use.
- No user audio/transcript telemetry by default. Diagnostic bundles are opt-in, previewable, and redact paths/tokens.
- Managed profile needs authentication, per-user/device authorization, request quotas/spend, abuse controls, provider failover policy, audit records, data retention/deletion, incident response, and key rotation before production.
- Retry idempotent health checks, not arbitrary execution requests. Do not replay a task when a connection is lost after submission; reconcile by request ID.
- Degraded mode must be explicit. Do not claim tasks were completed without verification; do not report fallback speech as provider TTS.

## 10. Phased delivery plan

### Phase 0 — Contract and default architecture (this change set)
- Record the local-first / managed / BYOK decision in this plan.
- Add first-class Ollama support to the trusted orchestrator model router.
- Change the default sample and launcher settings to local Whisper + Ollama + browser TTS fallback.
- Provision or validate the local speech and LLM runtimes in the Windows setup path.
- Improve the microphone diagnostic classification and guarantee capture cleanup.
- Add deterministic tests for Ollama transport/response validation, launcher defaults, and microphone error mapping.
- Wire focused tests into Windows CI. Keep all current security and verification tests.

### Phase 1 — First-run readiness UX
- Add a desktop diagnostics view for each capability, including last failure and repair action.
- Add input-device name/selection and open-Windows-settings action; local microphone-signal and OS/browser speech-output self-tests are now present in the expanded HUD.
- Add /ready contracts with structured reason codes, provider/model identity, and redacted guidance.
- Add service supervision: startup timeout, readiness polling, process ownership, reconnect backoff, and no duplicate service processes.
- Keep text entry usable while voice checks or model downloads fail.

### Phase 2 — Real release packaging
- Choose and pin Electron packaging/signing approach.
- Bundle the desktop and local service assets; replace repository-relative runtime assumptions with explicit user-data/install paths.
- Install/update/repair local dependencies and models atomically.
- Test clean Windows 10/11 machines and supported x64/ARM64 targets if required.
- Create upgrade/uninstall behavior that preserves user data and optionally preserves model caches.

### Phase 3 — Managed no-key hosted mode
- Build a separate authenticated API gateway; keep provider secrets in server-side secret management.
- Implement device registration, refreshable short-lived tokens, per-user quotas/spend, request audit, data-retention controls, and abuse protection.
- Route planning, STT, and TTS via the gateway with capability-level timeouts and bounded retries.
- Add release-time security review, privacy policy, billing model, and incident runbooks.
- Only then advertise “no API key required for hosted high-quality voice.”

### Phase 4 — Release gates and telemetry
- Automated tests for install/upgrade/repair/uninstall, missing models, denied microphone permission, no device, busy device, offline startup, Ollama absent, model absent, provider quota, invalid key, and TTS fallback.
- Manual physical Windows acceptance: microphone capture/playback, default and USB/Bluetooth devices, privacy disabled/enabled, sleep/resume, repeated launch/exit, CPU/GPU load, and voice interruption.
- Track crash-free launch, successful mic-start rate, time-to-first-transcript, planner success, TTS playback success, task verification rate, local resource usage, and cost only where authorized. Telemetry is opt-in and privacy-preserving.

## 11. Acceptance gates

The local-first milestone is not complete until:

1. A clean Windows test machine with no API keys can type a request and successfully execute supported actions through the local planner; unsupported actions fail honestly.
2. With Ollama + the selected model and local Whisper installed, a microphone command yields an actual transcript, a real execution result, and audible speech through the configured fallback.
3. No API key is required in the normal path, and no key is bundled or logged.
4. Missing Ollama/model/Python/model files produce actionable first-run failures, not a misleading “Vanessa online” state.
5. Microphone permission/device/pipeline failures map to tested, actionable messages and release every acquired resource.
6. Text submission remains usable when the microphone or voice service is unavailable.
7. The exact CI run passes for build, focused unit tests, type-check, docking, deterministic voice gate, and security tests.
8. A separate human-run hardware acceptance record exists before claiming microphone reliability across customer devices.

## 12. Current deliverable and known limitation

The first implementation milestone will establish the no-key local runtime path and reliable diagnostics. It does not, by itself, constitute a signed end-user installer or a hosted managed service. The existing .bat/repository launcher remains a developer bootstrap path until Phase 2 packages the application. Generic local task quality depends on model capability, supported action contracts, local hardware, and runtime readiness; no universal success claim should be made before the clean-machine acceptance tests pass.
