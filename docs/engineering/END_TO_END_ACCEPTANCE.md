# End-to-end acceptance

**Status:** the gates are defined; most are not met. This file records what a
green run is allowed to mean, so that no future summary can quietly upgrade
"compiled" into "works".

## What each signal proves

| Signal | Proves | Does **not** prove |
|---|---|---|
| `build-and-test` | TypeScript/protocol packages typecheck and their unit tests pass | anything about Android |
| `debug-apk` | The Android app compiles, JVM unit tests pass (including all 59 reducer tests), the verified native APK builds | that any screen renders, that a journey works |
| `windows-installer` | The Windows installer builds | that the PC side runs a task |
| `Android emulator user journeys` | — | **currently nothing: this job fails before instrumentation starts** |
| A reducer unit test | the state machine | the socket, the Activity, or the pixels |

## The emulator gate

`android-ui-qa.yml` runs `reactivecircus/android-emulator-runner` and
`connectedDebugAndroidTest`, then uploads
`app/build/reports/androidTests/connected/**`. On `main` that job has failed since
#62 and the artefact is empty, so **no instrumented test has executed**.

Required change, in this order:

1. Classify the failure from the runner log: infrastructure, boot, ADB,
   installation, or instrumentation. They have different fixes and guessing has
   already cost several attempts.
2. Make a missing test report a **failure**, not a warning. A workflow that
   uploads nothing and calls itself QA is worse than no workflow, because it is
   cited as evidence.
3. Require at least one executed test in the XML before the job goes green.

Until 1–3 are done, no PR may claim UI acceptance on the strength of this job.

## Journey gates

Each journey below needs a recorded artefact (log or screenshots) before it can
be ticked. See `NAVIGATION_AND_JOURNEYS.md` for what each one involves.

| # | Journey | Gate | Status |
|---|---|---|---|
| 1 | First-time user, including restart persistence | emulator | blocked on the emulator gate |
| 2 | Local assistant with an installed GGUF | device | not started (P4) |
| 3 | Remote PC execution: pair → submit → result | device + real PC over Tailscale | not started (P4) |
| 4 | Protected operation with biometric approval | device with enrolled biometric | not started (P4) |
| 5 | Interrupted task: disconnect, process death, recovery | device + real PC | reducer covered; socket half not started |
| 6 | Agent orchestration through the UI | device + orchestrator | no UI exists |

## Release blockers, stated plainly

- Physical-device acceptance has not been performed.
- The emulator job does not execute tests.
- Visual acceptance (P2) has never been done on any screen; the P0 and P1 work
  shipped without a single rendered check.
- Offline TTS, GGUF import and Tailscale pairing have not been exercised on
  hardware in this phase.

## Definition of done for a PR in this repository

1. `debug-apk` green, and any new state logic has unit tests that fail without the
   change.
2. No new dead control, no new status the app cannot substantiate.
3. Any claim of UI working is backed by a run, not by compilation.
4. Docs in this directory updated when behaviour changes — the state machine file
   and the screen inventory in particular.
