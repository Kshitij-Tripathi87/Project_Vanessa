# Codebase audit

Reviewed on 2026-10-21. This pass covered the desktop app, orchestrator, voice agent, relay, permission checks, process launching, and repository layout. It was a source review and package build check, not a penetration test.

## Fixed in this pass

- Restricted browser CORS access to the local desktop development UI and added origin checks to the orchestrator and voice WebSockets. The packaged Electron app makes API requests from its main process.
- Removed the relay's fixed JWT signing secret. The relay now uses a fresh random key when `JWT_SECRET` is unset; deployments that need tokens to survive restarts must set a private key.
- Added relay pairing input validation, request throttling, JSON and WebSocket message size limits, and safe handling when a token references a pairing room that has expired. Removed the duplicate health route.
- Made risky actions require approval unless `AUTONOMOUS_MODE=true` is explicitly configured.
- Stopped granting every Electron device permission and limited microphone permission to the packaged app or local development renderer.
- Passed dynamic values to PowerShell outside the script text for browser navigation, app launch and close, cloud URLs, volume, archive creation, and VS Code project launch.
- Changed remote task rendering to use `textContent`, so task data cannot become executable HTML.
- Implemented screenshot capture to a temporary file and removed the machine-specific screenshot path.
- Removed the unused fixed `ORCHESTRATOR_TOKEN` value from the root example environment file.

## Remaining issues

### High: Remote command and approval routes do not check their session token

`/api/remote/command` and `/api/remote/approve` accept requests without verifying `body.token`. The `authenticatedPhoneTokens` set is populated by pairing but never consulted, and it includes a fixed demo token. The orchestrator currently binds to loopback, which limits network exposure, but any local process can invoke these powerful routes. The mobile page also starts with the fixed demo token rather than completing the pairing flow.

### High: Claude prompt values still enter PowerShell source

`developer.agent.ts` interpolates the prompt into PowerShell command strings when opening a visible Claude Code terminal. This can break quoting and execute unintended commands. `terminal.run_command` and `tests.run` also execute arbitrary shell commands by design; this pass added confirmation requirements for those action names, but they still need a tightly scoped execution model before the assistant can safely act on untrusted plans.

### Medium: The phone companion cannot reach the current orchestrator address

The orchestrator listens only on `127.0.0.1`, and `/api/remote/pairing` constructs a `127.0.0.1` URL. A phone treats that address as its own loopback interface, so it cannot reach the laptop. Exposing the orchestrator on the LAN needs a real authentication and transport design first.

### Medium: Relay rooms and rate-limit entries have no cleanup policy

Expired rooms are removed only when someone tries to claim them, and rate-limit keys are kept in a process-wide map. A public relay can accumulate stale entries over time. Add periodic expiry and a maximum room count before operating it as a long-lived public service.

### High: Ambient audio currently leaves the device before activation

The desktop starts microphone capture automatically and streams every PCM frame to the voice service. The wake-word detector runs on ASR transcripts, so idle audio is sent to Fish to recognize the wake phrase. A transcript could also reach command dispatch without a wake phrase. The session now rejects such command dispatch, but keeping audio local until activation still needs the selected wake strategy and a local detector.

### Medium: Voice has two active execution paths and an implicit speech fallback

The desktop falls back from `services/voice-agent` to the orchestrator's separate `/voice/stream` implementation. Fish TTS failures also fall through to browser `SpeechSynthesis` without showing the provider change. The dossier calls for one canonical voice session owner and visible provider status. The root `pnpm dev` already includes the voice-agent service, so the extra orchestrator path is not needed for the normal development stack.

### Medium: Some failure drills check state instead of causing failures

The relay drill only runs a local Bluetooth/YouTube command and never stops the relay. The voice failover drill checks only `orchestratorOnline`. These are logic checks, not process-failure or provider-failover drills. Keep their current names from implying real fault injection until the drills actually stop services or sever provider connections.

### Medium: File access policy does not cover every path parameter

The permission guard checks only a small set of parameter names (`path`, `targetPath`, `filePath`, and `basePath`). Operations using `oldPath`, `newPath`, or other names can bypass that check. The workspace itself is also allowlisted in full. Centralize path validation at the file-agent boundary and resolve symlinks before checking containment.

## Structure and maintenance

- `Agents and tools/` contains its own Python, Rust, Tauri, and Node project metadata and a large independent test tree. Treat it as a documented vendored project or move it to a submodule/separate repository; the orchestrator currently searches several guessed directory names to locate it.
- `services/relay/src/` tracks generated `.js`, `.d.ts`, and source-map files alongside the TypeScript sources, while the relay build emits to `dist/`. Keep generated outputs out of `src/` to avoid stale duplicate implementations.
- The dossier is now treated as the product and architecture source of truth. Its main open implementation decisions are local wake-word versus push-to-talk behavior, visible voice-provider fallback, a single voice-session owner, authenticated remote commands, and verifiable end-to-end incident execution.
- The root README contains visible text-encoding corruption and some setup information should be checked against the current scripts and service ports.
- Several agents still invoke shell commands directly. Review `coding.agent.ts`, `incident.agent.ts`, `developer.agent.ts`, and `testing.agent.ts` for safe argument passing, especially where user-controlled branch names, paths, prompts, or commands are involved.

## Validation

TypeScript production builds pass for `@vanessa/orchestrator`, `@vanessa/relay`, `@vanessa/voice-agent`, and `@vanessa/desktop`. No test suites were run in this audit.
