# End-to-end acceptance

**Baseline evidence:** PR #70 is merged and its emulator CI executed five navigation/basic-flow journeys. A standalone in-memory conversation controller now exists, but the app is not wired to it. The full voice → conversation journey and the real Android ↔ Windows PC journey remain unverified.

This document distinguishes compilation, JVM tests, emulator navigation, integrated conversation behavior and physical-device acceptance. A green build must never be upgraded into a broader product claim.

## What each signal proves

| Signal | Proves | Does **not** prove |
|---|---|---|
| `build-and-test` | TypeScript/protocol packages build and their tests pass; generated conversation and legacy protocol artifacts are current; orchestrator/voice-agent checks in this job pass | Android screen behavior or physical-device speech quality |
| `debug-apk` | Android modules compile, configured JVM tests pass, the development APK builds and the configured approval checks pass | that a complete conversation journey works on a device |
| `windows-installer` | Windows workspace/installer build and its configured smoke tests pass | that a paired real PC has completed a remote operation from Android |
| `Android emulator user journeys` | The emulator boots, instrumentation executes and the reported Compose/UI journeys pass | real microphone/voice quality, installed-user-model execution, TTS voice quality or real-PC task execution |
| Shared TypeScript/Kotlin reducer fixtures | The contract codecs and reducers agree on the shared cases | Android Activity wiring, recognizer callbacks, audio playback or durable state |
| Standalone controller/unit tests | Controller correlation, serialized state publication and generation fences under deterministic test conditions | Android platform behavior unless separately exercised through instrumentation |
| Physical-device acceptance | Only the exact device, model, permissions, ASR/TTS and PC paths exercised in the recorded run | other hardware or untested product capabilities |

## Emulator gate — now operational

The earlier statement that the emulator job executed no tests is obsolete.

PR #70 verification recorded the following successful runs:

| Job | Result | Evidence |
|---|---|---|
| `build-and-test` | success | [Run 44726068881](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44726068881) |
| `debug-apk` | success | [Run 44726068653](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44726068653) |
| `Android emulator user journeys` | success | [Run 44726068796](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44726068796) |
| `windows-installer` | success | [Run 44726068610](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44726068610) |

The PR #70 description reports **5 instrumented tests executed, 0 failing, from 1 result XML**. The emulator job steps include AVD creation, boot, UI journey execution, report upload and instrumented-result reporting. The PR author also reports that the three applicable post-merge checks on main passed.

The result is real emulator evidence, but it is scoped to the tests that were actually present. It does not mean the conversation reducer is wired into Android.

### What the five PR #70 instrumented tests covered

Those tests are in `apps/android/app/src/androidTest/java/com/vanessa/mobile/ui/VanessaNavigationTest.kt`. The current suite additionally includes a suggestion/composer regression and `MyPcPairingInputTest` for accessible pasted pairing data. Check the current run's XML-derived results for their outcome rather than extending the historic PR #70 claim.

| Test | Current evidence | Boundary |
|---|---|---|
| `firstRunFlowReachesTheAssistantWithoutClaimingAModel` | First-run route reaches Assistant and reports no active model honestly | Does not run inference |
| `typedInputIsAcceptedButCannotRunWithoutAModel` | Typed text is accepted, while send/execution remains unavailable without a model | Does not prove successful planner execution |
| `voiceSurfaceIsReachableAndDismissible` | Voice screen can be opened and closed; test tolerates unavailable on-device recognizer | Does not prove microphone capture or ASR transcript delivery |
| `settingsIsReachableAndScrollable` | Settings route and scroll regions are reachable | Does not prove model import/load on physical hardware |
| `pcDashboardKeepsTheRealRemoteControlEntryPoint` | PC dashboard and pairing entry point remain reachable | Does not pair with a real PC or execute a remote task |

The emulator gate must continue to fail if:
- the AVD fails to boot;
- connected instrumentation does not start;
- test XML is missing or empty;
- an expected test method does not execute or a case is skipped;
- result XML is malformed or a test fails.

An infrastructure failure is not a code pass. A debug APK pass is not an emulator pass. Do not use a skipped or filtered test as proof that the journey ran.

## Journey status

| # | Journey | Current status | What is still needed |
|---|---|---|---|
| 1 | Clean install → first-run flow → Assistant | **PASS (emulator)** | Restart/persistence acceptance remains a separate test |
| 2 | Typed request with no GGUF | **PASS (emulator, negative path)** | Successful local inference on a device with a supported installed model |
| 3 | Voice surface reach/dismiss | **PASS (emulator, navigation only)** | Fake-ASR event integration and physical microphone acceptance |
| 4 | Settings reach/scroll | **PASS (emulator)** | Physical model import/load acceptance |
| 5 | PC dashboard entry point | **PASS (emulator, navigation only)** | Authenticated pairing with a real Windows PC |
| 6 | Live ASR partial → final user turn | **NOT YET PROVEN** | ConversationController wiring and instrumented fake-ASR journey |
| 7 | Typed and voice input share one reducer | **NOT IMPLEMENTED** | PR C and PR E |
| 8 | Completed prior turns become planner context from reducer state | **PARTIAL (standalone controller only)** | Connect the controller projection to the app planner |
| 9 | Validated assistant response → reducer chunks → completion | **PARTIAL (standalone controller only)** | Connect validated output to the app; no token streaming claim |
| 10 | Opt-in offline TTS playback lifecycle | **PARTIAL** | Existing one-string Read Aloud exists; progress queue and callback fencing remain |
| 11 | Conversation interruption while preserving task authority | **NOT PROVEN END TO END** | Controller and adapter lifecycle tests |
| 12 | Remote PC pair → submit → approve → result | **NOT STARTED (physical end-to-end)** | Device + real PC + authenticated connection + recorded evidence |
| 13 | Disconnect/process-death recovery | **PARTIAL** | Reducer/task-state tests exist; full socket/real-device recovery evidence remains |
| 14 | Full agent orchestration through user-facing Android journey | **NOT PROVEN END TO END** | Real device + orchestrator + permitted action + verification evidence |

## Three-day Conversation Runtime milestone

The implementation target and acceptance breakdown live in [THREE_DAY_CONVERSATION_RUNTIME_PLAN.md](THREE_DAY_CONVERSATION_RUNTIME_PLAN.md).

For this milestone, the Android conversation journey can be considered complete only when:
1. ConversationController owns reducer-backed state.
2. Typed and voice input publish into that controller.
3. Voice partials update one existing turn and final transcript is accepted once.
4. Planner context is derived from completed controller turns and excludes the active request.
5. Assistant output is validated in full before bounded response chunks are published.
6. Offline TTS remains opt-in and its playback lifecycle is separate from conversation completion.
7. UI history and draft are projections of reducer state, not duplicate authoritative stores.
8. New deterministic fake-ASR/TTS and Compose instrumented journeys execute on emulator.
9. All four required CI jobs pass on the final PR head.

This milestone does not complete durable memory, clarification, task handoff, desktop integration, native token streaming or the real-PC physical acceptance journey.

## Physical-device and remote-PC gates

The following remain open even while emulator CI is green:

- Test the installed local GGUF model and actual llama.cpp inference on a representative Android device.
- Verify the device's on-device speech recognition language pack and microphone lifecycle.
- Verify that the selected TTS voice is installed, reports no network requirement and speaks correctly on hardware.
- Test Activity background/foreground, rotation or recreation as applicable, screen lock, permission denial and process teardown.
- Pair a physical Android device with the real Windows companion over the supported authenticated path.
- Execute a safe, explicitly approved remote action, observe its task state, interrupt speech without cancelling the task, and verify the result.
- Disconnect/reconnect and demonstrate task recovery from the real runtime rather than from reducer fixtures alone.

Record device model, Android version, model checksum/version where applicable, app commit SHA, PC commit SHA, test steps, test outcome and sanitized evidence. Do not log audio, private transcript content or credentials.

## Release blockers and truthful reporting

Before the Conversation Runtime milestone is declared complete:
- the controller and adapter lifecycle tests must pass;
- the new emulator journeys must be present and executed;
- the current five navigation journeys must remain green;
- all required CI jobs must pass on the same final PR head;
- review comments affecting event ordering, ID pairing, privacy, task cancellation or stale callbacks must be resolved.

Before the overall Vanessa application is declared end-to-end complete:
- physical-device acceptance is required;
- the real Android ↔ Windows PC journey is required;
- agent orchestration, approval and outcome verification must be demonstrated through the actual application;
- memory, clarification, task handoff and durable supervisor authority must be implemented and tested.

## Definition of done for any PR

1. `debug-apk` is green, and changed state logic has tests that fail when the behavior is removed.
2. If UI behavior changes, the relevant emulator test actually executes and produces a nonempty report.
3. A claim about real-device or PC behavior has recorded physical acceptance evidence.
4. No new dead control or status that the app cannot substantiate.
5. No unreviewed coupling between conversation interruption and task cancellation.
6. Documentation is updated when behavior changes; the status page describes code, while plans describe intended work.


## Real Windows host acceptance (opt-in)

The deterministic CI integration test uses a fake Core Audio reader. It proves the planner → policy → task runner → Windows agent → evidence/verifier path, but it does not read the runner's actual audio device.

To run the same safe request against a real Windows host, execute from the repository root:

```powershell
pnpm run test:windows:host-acceptance
```

This opt-in test fixes only the planner output to a two-step read-only plan: `ui.inspect` followed by `volume.get`. The Windows agent must inspect bounded foreground-window metadata without reading input values, then use its real PowerShell/Core Audio implementation to return a default render device, volume percentage, mute state and `windows-audio.readback` evidence. It does not click controls or change volume/mute state.

Record the Vanessa commit SHA, Windows version, whether a default playback device was present, test outcome and sanitized evidence. Do not record audio, private transcripts, device serials or credentials. A skipped test is not acceptance evidence.

This host test still does **not** prove a multi-step write operation, physical microphone capture, ASR quality, voice interruption or Android-to-PC execution. Those require separate supervised device acceptance.

## One-week acceptance sequence

| Window | Gate | Required evidence |
|---|---|---|
| Days 1–2 | Typed Windows request | Real host read-only query, planner correlation, policy decision, Core Audio read-back and verified result |
| Day 3 | Voice and interruption | Physical microphone permission/capture, final transcript, response playback, barge-in, and proof that the underlying task continues |
| Day 4 | Android conversation and offline TTS | Physical device typed/ASR turn, explicit Read aloud, Stop reading aloud, replay and lifecycle checks |
| Day 5 | Android-to-PC | Authenticated pairing, approved safe read-only task, correlated task status and independently checked result |
| Day 6 | Recovery and regression | Disconnect/reconnect, delayed responses, pending-history retention, cancellation races and full CI |
| Day 7 | Release candidate | Installer/APK artifacts, checksums, known limitations, acceptance record and go/no-go review |

Do not promote a gate based on compilation or a mocked integration fixture. Each gate requires evidence from the environment named in the table.
