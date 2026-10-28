# Sarvam acceptance record — 2026-10-25

## Release decision

**Not release-certified.** Deterministic local protocol/integration checks pass;
live speech recognition, audible Windows playback, packaged-app acceptance and
hosted shared-key distribution remain unverified or unimplemented. Do not turn
these checks into claims that speech quality or production security passed.

Work stays on `Vanessa-Prototype-1-MAIN`; no merge into main or force push.
Pre-existing local changes in `Launch-Vanessa.bat` and `scripts/sarvam_chat.py`
are excluded from this implementation.

## Implemented and exercised

- Configurable Sarvam STT/chat/TTS without a Python SDK or second voice stack.
- Bounded connection/finalization timeouts, cancellation and pre-ready retry;
  established audio sessions are not blindly replayed after failure.
- Partial transcripts never submit work; committed turns get stable identities.
- Real planner, policy and task runner exercised behind mock Sarvam transports:
  a read-only status action succeeds; Wi-Fi restart pauses for approval and
  cannot be approved after request cancellation.
- Request-scoped cancellation, including cancellation overtaking HTTP submit,
  late planner results, stale spoken replies and playback decode races.
- Complete, bounded encoded utterances assembled before browser decoding.
  This deliberately trades some time-to-first-audio for complete MP3/WAV
  delivery; it is not sample-streamed PCM playback.
- Speech onset pre-roll and local audio gating; no idle audio submitted.
- Ledger validates finite rates/caps, preserves in-flight reservations despite
  bounded history, and conservatively accounts for potentially billable aborted
  streams. STT waits briefly for `session.end.audio_duration_s`, otherwise uses
  sent PCM duration. Provider-reported quantities and estimated currency costs
  are explicitly distinguished.
- Renderer build checked with a dummy secret canary; private env/database files
  checked against tracked paths. This is a boundary regression check, not a
  repository-history secret audit or packaged-distribution security proof.

## Local evidence

Environment: Windows, Node v26.4.0, pnpm 11.24.0. Commands use at most 300 seconds.

- `pnpm run test:sarvam:gate`: deterministic launcher, STT, TTS, lifecycle,
  integration, diagnostics, command contract, usage and chat tests: **48 passed**
  (9 launcher + 35 voice/shared/integration + 4 chat), after same-branch integration.
- `SARVAM_API_KEY=vanessa-build-secret-canary pnpm build`: TypeScript and renderer
  production builds: **passed**. The canary is test data, not a credential.
- `node --test scripts/security.test.cjs`: **2 passed**, renderer/credential boundary checks.
- `pnpm run lint`: **cannot run**; root invokes `pnpm -r run lint`, but no selected
  workspace defines a lint script (`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`). This
  pre-existing setup gap has not been hidden or replaced with a passing no-op.
- Authorized live smoke on 2026-10-25 using `test_wifi.wav` and the private local
  `.env`: Sarvam STT connected and matched `restart` and `wi-fi`; Sarvam chat
  returned the expected response; Sarvam TTS returned complete audio (`30,720`
  bytes on the final run). No key, transcript, or audio payload was printed or
  committed. This validates provider connectivity and one synthetic phrase, not
  general speech accuracy or physical speaker playback.
- The older live-planner scenario/process suites are not a deterministic release
  gate. Previous review observed 17/23 scenarios, 6/7 skills and 6/7 process drills.
  They were not rerun here: they can invoke real Windows actions and live models.

The new CI workflow is `.github/workflows/sarvam.yml`. It builds and runs the
isolated gate on Windows without real provider credentials. Workflow creation
is not a successful remote run; GitHub CLI is unavailable in this environment.

Remote reconciliation: fetched and retained same-branch commits `b6c44e4`,
`57dc19b`, `9b5da6b`, and `703c34c`. Retained their explicit model/persona
validation, selected-provider readiness output, model/rate examples, TTS buffer
tuning, and Sarvam-specific `SpeechAudioGate` implementation and tests. The
example rates remain indicative, not independently verified billing prices.

## Definition-of-done matrix

| Requirement | Evidence/status |
| --- | --- |
| STT returns spoken words reliably | Protocol/events verified with mock audio; real speech accuracy **not run** |
| Transcript becomes correct response/authorized action | Mock providers + real planner/policy/runner passed; live model correctness **not run** |
| Complete audible TTS | Fragment reassembly/completion verified; real speakers/headphones **not run** |
| Interruptions cancel old work/audio | Stale replies suppressed, request abort and pending work cancellation tested; already-started OS processes cannot be rolled back or universally terminated |
| Recoverable failures | Auth rejection, malformed events, incomplete stream, timeout, retry and reactivation tested |
| Secrets excluded | Renderer canary/tracked-file checks passed; no shared embedded key; hosted authentication/credential backend and packaged artifact audit **not implemented/verified** |
| Usage/budgets | Local ledger tests passed; currency is estimated, rates supplied by configuration; voice and chat ledgers are separate, in-process and reset on restart—not a durable shared quota |
| Local/CI/manual results recorded | Local evidence recorded; CI execution pending; physical Windows acceptance not run |

## Manual/live acceptance still required

Use a developer-owned/BYOK key through the existing private `.env`, never in
chat, a command argument, a screenshot, or a tracked file. A shared production
key requires an authenticated hosted backend with server-side quotas; bundling
an SDK does not provide that boundary.

1. Confirm provider model/speaker/language and current dashboard rates. Set
   positive estimated caps and obtain authorization for billable live calls.
2. Start the canonical launcher with `node scripts/launch-vanessa.cjs`; the
   pre-existing modified batch wrapper is not used by this validation.
3. Run `pnpm readiness`: only selected local ASR/optional relay dependencies
   should be required. Readiness is configuration/health, not live accuracy.
4. Grant microphone permission. PTT: say a short predetermined phrase in English
   and then Hindi/Hinglish. Record expected vs actual text and end-of-turn latency.
5. Ask a harmless status question. Verify correct contextual response and complete
   audible speech. Repeat with speakers/headphones and the intended microphone.
6. During playback, interrupt. Verify old audio stops and the next turn works.
   Check the task timeline before repeating any possibly completed external action.
7. Disconnect network during STT, planning and TTS separately. Verify bounded
   error reporting and explicit PTT recovery without automatic action replay.
8. Restart the app and test microphone denial, device changes, no-speech PTT,
   long utterances, missing/invalid key, exhausted quota and denied approval.
9. Repeat on the actual packaged executable; inspect package contents for `.env`,
   keys and runtime data. No packaging or physical microphone results are claimed.
10. Reconcile usage quantities with Sarvam dashboard receipts, recording estimates
    separately from billed amounts. Do not rely on process-local caps as an
    account-wide or restart-resistant limit.

## Protocol references consulted

- Sarvam documentation: `api/api-guides-tutorials/speech-to-text/realtime-streaming`
  (manual endpointing, 16kHz linear16, transcript and session-end events).
- Sarvam documentation: `api/api-guides-tutorials/text-to-speech/streaming-api`
  (config/text/flush, base64 fragments, completion events and socket-close barge-in).
