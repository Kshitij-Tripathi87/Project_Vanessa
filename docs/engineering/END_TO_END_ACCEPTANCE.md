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

### Classification so far

Steps 1–3 are done: the job now fails on a missing or empty report, and its
annotations state the boundary instead of leaving it to a log.

What the evidence says, as of the run on `62addadb`:

- All setup steps succeed: checkout, JDK 17, SDK, KVM rule, SDK packages, Gradle.
- The emulator step fails after roughly **2–3 minutes**, well under the 900 s
  boot ceiling, so this is not a hung boot.
- At failure time the diagnostic reports **`adb sees 0 device(s); AVDs: none`**.
  The action may have cleaned up its AVD by then, so this shows the emulator is
  not running — not *why* it did not start.
- No `androidTest-results` directory is produced at all, so instrumentation never
  began.

The root cause is **not yet identified**: job logs are served from blob storage
and were not retrievable from the environment that made these changes, so the
action's own error text has not been read. The next person should open the failed
step's log (Actions UI, "Run UI journeys on a clean Android emulator") before
changing any emulator parameter — the current values (API 35, `google_apis`,
x86_64, swiftshader) are internally consistent, and the last two edits to this
job were guesses that did not help.

Discarded hypotheses, so they are not retried blind:

- Not a macOS/HVF problem — this job runs on `ubuntu-latest` with `/dev/kvm`
  verified by an explicit pre-step.
- Not a missing emulator package — installing it explicitly in the SDK step
  changed nothing.
- Not a boot timeout — the step dies far too quickly.

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
