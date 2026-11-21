# Vanessa — Application Build Plan and SDLC

**Baseline:** 21 November 2026. **Mode:** local engineering and testing. **Objective:** deliver one reliable assistant across Windows and Android. This is a delivery plan, not proof that the listed work is complete.

## 1. Product acceptance

A complete milestone demonstrates: typed or spoken request → correlated conversation turn → bounded context and clarification → reviewed plan → policy decision → approval where required → registered agent execution → structured evidence → independent verification → truthful response → recoverable task state.

**Conversation is the interaction foundation. Voice is an input/output adapter. Agents provide bounded capabilities. The orchestrator owns execution authority. The UI is a projection of accepted state.**

### Invariants

- One canonical action catalogue; no UI/model/agent may invent executable capabilities.
- Validate schema, permission, scope, approval and resource locks before execution.
- Every request, turn and task has stable, distinct IDs and explicit lifecycle state.
- Cancellation requested is not process stopped; process exit is not verified success.
- Late ASR/TTS callbacks, stale events, duplicate requests and replays cannot mutate a newer turn/task.
- Validate the full assistant response before publishing chunks.
- Conversation interruption and playback stop never imply task cancellation.
- Missing/ambiguous state is reported as unknown, not fabricated.
- Keep Android recognition on-device; preserve local-first data boundaries.
- Improve the current UI without an unrequested redesign.

## 2. Current implementation baseline

### Windows desktop

Electron/React floating assistant, typed input, voice transport, orchestrator, approval controls, task stream and Windows/browser/file capabilities exist. Windows CI run 44882416703 proved workspace build, combined orchestrator/voice/Electron smoke, selected desktop tests, EXE build and install/uninstall smoke. It did not prove a real user task or physical microphone.

Key files:
- apps/desktop/src/renderer/App.tsx
- renderer/components/CompactAssistant.tsx, ChatPanel.tsx, VoiceOrb.tsx, TaskPlan.tsx, TaskCard.tsx, ApprovalModal.tsx, AuditLog.tsx, ControlDeck.tsx, MemoryPalaceViewer.tsx
- renderer/hooks/useAudioCapture.ts, useTaskStream.ts, useFishVoice.ts, useElevenLabs.ts
- renderer/stores/vanessaStore.ts
- main/ipc.ts, gateway.ts, toolRegistry.ts, tools.ts, executionControl.ts
- services/orchestrator/src/core/orchestrator.ts, planner.ts, taskRunner.ts

PR #77 adds a read-only Windows execution integration test through planner → catalogue → policy → task runner → Windows agent → evidence/narration, with Core Audio read-back injected. It is not physical-host acceptance. PR #78 is the focused Stop/cancellation correction; its latest-head CI must pass before merge.

### Android

The main application is a single-Activity Compose app with enum-driven destinations. Authenticated remote control uses its own Activity/state machine. The inventory records 18 screen surfaces across main, remote and QR activities. The scroll specification records 14 verticalScroll call sites across 8 files and no LazyColumn/LazyRow in that snapshot. Recount against source before UI work.

Main files:
- apps/android/app/src/main/java/com/vanessa/mobile/ui/MainActivity.kt
- VanessaApp.kt, VanessaAssistantScreens.kt, VanessaWelcomeFlow.kt, VanessaFlowState.kt, VanessaMotion.kt
- RemoteControlActivity.kt, RemotePairingQrScannerActivity.kt, QrScannerActivity.kt
- ui/screens/MyPcScreen.kt, TaskApprovalScreen.kt, TaskExecutionScreen.kt, TaskResultScreen.kt, TaskRecoveryScreen.kt
- ui/state/RemoteTaskUi.kt, PcUiState.kt; ui/components/*; ui/theme/*
- voice/AndroidOnDeviceSpeechInput.kt, OfflineTtsController.kt
- apps/android/core/agent/.../ConversationController.kt, LocalPlanCoordinator.kt

Android has local inference, on-device ASR and offline TTS. Conversation protocol/reducers and a standalone ConversationController exist; Activity/composer/recognizer/UI are not yet wholly driven by that controller. Chat and voice-draft state still have separate paths. Existing emulator navigation tests do not prove physical microphone, local model or real-PC execution.

### Orchestrator and agents

The repository already has a supervisor, planner, policy guard, scheduler, resource locks, digest-bound approvals, critic, evidence-aware result mapper, remote v2 gateway, mobile task engine and SQLite persistence. Do not create a second orchestrator or parallel agent framework.

The agent registry snapshot reports 12 agent IDs, 62 actions, 46 selectable, 16 blocked and 23 high-risk; regenerate figures from agentCatalog.ts on change.

Key files:
- services/orchestrator/src/agents/agentCatalog.ts, registry.ts and existing specialist files
- services/orchestrator/src/core/orchestrator.ts, planner.ts, agentRouting.ts, router.ts, contextBuilder.ts
- permissionGuard.ts, actionRegistry.ts, taskRunner.ts, processSupervisor.ts, resourceLocks.ts
- agentResult.ts, critic.ts, narrator.ts, workingMemory.ts, privacy.ts, mobileTaskEngine.ts, mobileGateway.ts
- services/orchestrator/src/remote/remoteV2Gateway.ts, remoteTaskService.ts, remotePairingRegistry.ts

SQLite is the current persistence layer. PostgreSQL and Redis are not current runtime dependencies. Do not migrate databases without measured need and a reviewed migration plan.

### Voice

Desktop voice has ASR/TTS adapters, VAD, speech gate, turn detector, wake word, barge-in and bounded in-memory context. Android has separate local ASR/TTS.

Key files:
- services/voice-agent/src/server.ts, orchestratorClient.ts
- src/session/voiceSession.ts, bargeIn.ts, wakeWord.ts
- src/audio/capture.ts, speechGate.ts, turnDetector.ts, vad.ts
- src/asr/*, src/tts/*, src/tests/*
- Desktop renderer/hooks/useAudioCapture.ts
- Android AndroidOnDeviceSpeechInput.kt, OfflineTtsController.kt

## 3. System responsibilities

| Concern | Authority | Must not be owned by |
|---|---|---|
| Conversation turns/context | Shared contract/reducer + session adapter | Chat bubble state or agent |
| Audio capture/ASR/TTS | Platform voice adapter/session | Task runner |
| Intent/routing | Existing router/agent-routing | Duplicate Intent agent |
| Plan | VanessaPlanner + catalogue | UI/voice service |
| Permission/approval | PermissionGuard + digest | Model/agent/UI |
| Execution/concurrency | Orchestrator/taskRunner/processSupervisor/locks | Individual agent |
| Capabilities | Registered specialist/handler | Arbitrary shell |
| Verification | Postconditions/recordAgentResult/CriticEngine | Agent claim |
| Rendering | Desktop/Android state projection | UI-manufactured facts |

Use distinct requestId, turnId and taskId. Preserve correlation across all events and remote envelopes.

## 4. Ordered SDLC

### Phase 0 — Baseline and CI reliability

**Goal:** one clean baseline; no false green tests or repeat-failure noise.

1. Record main SHA and all open application PR heads.
2. Reconcile PR #77 and PR #78 one at a time.
3. Check workflows for masked exit codes, missing/empty JUnit reports, skipped tests treated as passes, wrong paths and stale lockfiles.
4. Reproduce before fixing historical failures: Android instrumentation/report path, pnpm lockfile drift, Gauntlet summary path contract, remote gateway frame-reader ordering and Windows ZIP extraction compatibility.
5. Treat Codex usage-limit comments as a separate service/account quota, not application build failures. Do not repeatedly trigger paid reviews while exhausted; any change to repository automation requires explicit owner decision.

Files: .github/workflows/ci.yml, android.yml, android-ui-qa.yml, desktop-release.yml; pnpm-lock.yaml; root/workspace package.json; evals/vanessa-gauntlet/run.mjs and tests/runner.test.mjs; services/orchestrator/src/remote/remoteV2Gateway.test.ts; scripts/package-windows-bootstrap.ps1.

Tests: frozen-lockfile install on Linux and Windows; protocol generation drift; agent build/test; Android unit tests, APK and connected instrumentation; Windows package and install/uninstall smoke. Every emulator journey must appear in JUnit XML and report as executed.

**Exit:** recorded baseline; current PRs based on current main; required jobs green; remaining defects have reproducers and owners.

### Phase 1 — Windows read-only vertical slice

**Goal:** one real request performs a harmless Windows operation and returns independently checked evidence.

Sequence: parse request → select existing catalogue action → validate schema → PermissionGuard → acquire lock → run with timeout/supervision → capture structured observation → read back state → verify postcondition → narrate actual result.

Start with audio default device/volume/mute, system status and file metadata. No arbitrary shell. Use injected boundaries for CI, then verify on the physical Windows host.

Files:
- services/orchestrator/src/core/planner.ts, permissionGuard.ts, taskRunner.ts, processSupervisor.ts, agentResult.ts, critic.ts, narrator.ts
- services/orchestrator/src/agents/agentCatalog.ts, windows.agent.ts, windows-audio.ts
- services/orchestrator/src/tests/windowsReadOnlyExecution.integration.test.ts (PR #77), audio/controls tests
- apps/desktop/src/renderer/hooks/useTaskStream.ts
- apps/desktop/src/renderer/components/TaskPlan.tsx, TaskCard.tsx

Tests: valid/invalid action; unavailable endpoint; missing evidence; handler exception; false-success rejection; duplicate request/idempotency; real Windows read-back report.

**Exit:** one physical Windows read-only request passes; CI proves deterministic path; UI never claims an unobserved value.

### Phase 2 — Task lifecycle, Stop, approval and recovery

**Goal:** Stop speech, interrupt response, cancel one task and emergency stop are distinct operations.

Semantics:
- Stop speech ends local audio only.
- Finalize speech permits final ASR callback; cancel capture invalidates old callbacks.
- Response interruption does not cancel a task.
- Task cancellation is request/task scoped and awaits terminal plan state.
- Emergency stop reports per-task outcomes.
- termination_unconfirmed remains visible and locks stay held.
- Work completed before cancellation retains its actual outcome.
- Cancellation tombstones prevent late planning from starting work.
- Reconnect restores only authenticated snapshots/replay; history gaps become unrecoverable.

Files:
- Desktop renderer/App.tsx, taskCancellation.ts, taskCancellation.test.ts, stores/vanessaStore.ts, hooks/useTaskStream.ts, components/CompactAssistant.tsx, vanessa.d.ts
- main/ipc.ts and preload/index.ts
- Orchestrator core/orchestrator.ts, taskRunner.ts, processSupervisor.ts, resourceLocks.ts, server.ts
- Android RemoteTaskUi.kt, RemoteControlActivity.kt, RemoteV2BridgeClient.kt and remote screens

Tests: cancel before submit/during planning/queued/running/verifying/after completion; cancellation-completion race; confirmed/unconfirmed process-tree stop; task A cannot cancel task B; speech stop leaves task; global stop counts; reconnect/history gap/process death; digest/expiry approval.

**Exit:** PR #78 full Linux+Windows CI green and manual Windows Stop acceptance proves no false “Stopped”.

### Phase 3 — One conversation runtime

**Goal:** desktop typed/voice and Android typed/voice share the same turn contract, correlation and context policy.

1. Preserve and test the existing conversation protocol first.
2. Define a session interface and adapter boundary; UI draft is local input state, not conversation authority.
3. Store conversation/session data locally only after inspecting existing SQLite/MemoryPalace schema. Do not assume Postgres or casually add a second database.
4. Typed request publishes one finalized user turn and enters orchestrator.
5. Voice partial replaces active user turn; final is accepted once and calls the same request path.
6. Android composer and on-device recognizer use existing ConversationController; remove duplicate chatMessages/voiceDraft authority only after tests.
7. Validate complete assistant text before publishing chunks; bounded context includes completed turns only.
8. Clarification, provider failure, permission denial and task handoff become explicit states.

Contract files: packages/protocol/src/conversation.ts, conversation.test.ts, conversation-conformance.test.ts; schema and fixture files under packages/protocol/schema and fixtures; Kotlin ConversationModels.kt, ConversationCodec.kt, ConversationReducer.kt; Android ConversationController.kt and ConversationContextSpec.kt.

Integration files:
- Android MainActivity.kt, VanessaAssistantScreens.kt, AndroidOnDeviceSpeechInput.kt
- Desktop renderer/App.tsx, ChatPanel.tsx, vanessaStore.ts; add renderer/conversation/* only after interface contract review
- Voice voiceSession.ts, orchestratorClient.ts
- Orchestrator contextBuilder.ts, orchestrator.ts

Tests: same TS/Kotlin fixtures; typed one turn; partial A/B/final C one turn; final-only recognizer; duplicate final; stale capture/conversation ignored; bounded context (six turns/1,200 chars initially); active request excluded; user/assistant turn IDs distinct but share requestId; overlong response rejected before chunk; Unicode chunking; interruption preserves task state.

**Exit:** one typed and one voice multi-turn journey on both platforms pass shared conformance tests.

### Phase 4 — Voice lifecycle

**Goal:** real voice reliability, not just a reachable microphone screen.

Desktop: preserve VAD/ASR/TTS/wake word/barge-in; connect to shared conversation session; generation-fence stale callbacks; serialize/bound TTS queue; display true provider readiness.
Android: keep ASR on-device; handle onPartialResults, onResults, errors, permission loss, Activity destruction, capture leases and stale callbacks; offline TTS is opt-in and independent of turn completion.

Files:
- services/voice-agent/src/session/voiceSession.ts, bargeIn.ts, wakeWord.ts
- src/audio/capture.ts, speechGate.ts, turnDetector.ts, vad.ts, src/asr/*, src/tts/*, src/server.ts
- Desktop hooks/useAudioCapture.ts, useFishVoice.ts, useElevenLabs.ts, VoiceOrb.tsx
- Android AndroidOnDeviceSpeechInput.kt, OfflineTtsController.kt, MainActivity.kt, VanessaAssistantScreens.kt

Tests: fake ASR partial/final/error/cancel; VAD silence/noise; PTT/wake permissions; barge-in; TTS queue lifecycle/stale callbacks; voice disconnect with task active; physical mic and offline TTS acceptance on Windows and Android.

**Exit:** physical devices complete a real voice request; barge-in/stop/task cancel remain distinct.

### Phase 5 — Agent capability and orchestration hardening

**Goal:** extend quality of existing 12-agent/62-action registry, not create duplicate framework.

Only add a specialist when it has schema, explicit scope/risk, bounded handler, timeout, lock, cancellation, evidence, independent verifier, tests and user-visible limitations.

Priority: regenerate catalogue report; review selectable/blocked actions; keep arbitrary terminal/Codex actions blocked until repair-worktree/verifier contract; improve clarification/routing; dependency scheduling/idempotency/retry; structured truthful progress; action-specific read-back verification; provenance-based context/memory; crash reconciliation; evidence timeline projections.

Files:
- services/orchestrator/src/agents/agentCatalog.ts, registry.ts and existing specialist files
- core/agentRouting.ts, router.ts, planner.ts, contextBuilder.ts, permissionGuard.ts, actionRegistry.ts, taskRunner.ts, processSupervisor.ts, resourceLocks.ts, agentResult.ts, critic.ts, narrator.ts, privacy.ts, workingMemory.ts
- corresponding orchestrator tests for catalogue/routing/result/trustworthy execution/specialists

**Exit:** every selectable action has a real handler and verified postconditions; blocked actions have explicit reasons; multi-step/approval/failure/cancel/recovery have integration coverage.

### Phase 6 — Android UI engineering and scroll polish

**Goal:** refine every current screen and scroll container while preserving the existing design language.

Create screenshot/state baseline first. Every UI PR includes before/after screenshots for affected surfaces and Compose test evidence.

Main surfaces:
- Splash/boot, Pairing, My PC dashboard, Settings: ui/VanessaApp.kt
- Welcome, Onboarding, Permissions: ui/VanessaWelcomeFlow.kt
- Chat, Listening, local Confirm Action, local Executing, local Success: ui/VanessaAssistantScreens.kt
- QR scanner activities: ui/RemotePairingQrScannerActivity.kt, QrScannerActivity.kt
- host: ui/MainActivity.kt, ui/RemoteControlActivity.kt

Remote surfaces:
- ui/screens/MyPcScreen.kt
- TaskApprovalScreen.kt
- TaskExecutionScreen.kt
- TaskResultScreen.kt
- TaskRecoveryScreen.kt
- reducers ui/state/RemoteTaskUi.kt and PcUiState.kt

Scroll accounting: SCROLL_AND_LAYOUT_SPEC.md reports 14 verticalScroll call sites across 8 files. Its screen table and count must be checked against live source. Logical areas include shared Welcome/Onboarding/Permissions, Chat, Listening, Confirm Action, local Executing, dashboard, Settings, Pairing, remote My PC, remote Approval, remote Execution, two Task Result regions, Task Recovery and RemoteControlActivity. Reconcile this inventory; do not pretend the count is resolved when the document and screen list differ.

For every actual scroll call site test:
- exact owner/lifetime of ScrollState;
- scroll-to-visible before automated clicks;
- system bars/IME/safe drawing;
- no accidental nested scrolling;
- compact 320×640 dp; standard 411×891 dp; large font 200%; landscape;
- state/scroll restoration on Activity recreation;
- loading/empty/error/long content;
- focus order, semantics and TalkBack.

Chat retains up to 100 messages. Do not raise the cap while keeping a Column composing all entries; assess LazyColumn, stable turn keys and reader-aware auto-scroll after reducer integration. Never auto-scroll a reader away from old messages; provide a New Messages affordance. Hoist/restore per destination only where semantics are clear. Insets are centralized in VanessaApp.kt; every new Activity/dialog must own correct insets.

Theme/components: ui/theme/VanessaColors.kt, Dimensions.kt, Theme.kt, Typography.kt; ui/components/*.kt. Preserve palette/orb/motion/layout. Tests: apps/android/app/src/androidTest/java/com/vanessa/mobile/ui/VanessaNavigationTest.kt and focused state tests.

**Exit:** every surface has clear states/handlers; actual scroll regions pass device-size/font/keyboard/accessibility checks; no dead CTA/clipped approval/false success.

### Phase 7 — Physical Android ↔ Windows journey

**Goal:** one real authenticated paired journey.

Pairing window → signed challenge → identity verification → PC-local scope approval → authenticated session → manifest → task submit → persisted acceptance → execution → verified result → reconnect snapshot/replay → revoke/forget test.

Files:
- Orchestrator remote/remoteV2Gateway.ts, remoteTaskService.ts, remotePairingRegistry.ts
- Protocol messages.ts, envelope.ts, sessionGuard.ts, signatures.ts
- Android remote/RemoteV2BridgeClient.kt, ui/RemoteControlActivity.kt, ui/state/RemoteTaskUi.kt and remote screens
- Desktop main/remotePairingWindowController.ts, electronRemoteIdentityStore.ts, remotePcIdentityStore.ts, remotePcSignerServer.ts, pairing.ts; renderer/components/MobilePairingModal.tsx

Physical report records both SHAs, Android model/OS, Windows build, scopes, capability, task identity, sanitized evidence and reconnect/cancel result.

**Exit:** real Android paired to real Windows, performs a safe approved action, receives verified result and recovers after disconnect.

### Phase 8 — Desktop UX parity

Replace last-command/last-response with reducer-backed chronological turns. Keep conversation messages separate from request/task/agent/approval/evidence state. Add clarification controls, real provider/mic diagnostics, reader-aware history, keyboard/accessibility tests and task evidence timeline. Keep established UI language; targeted polish only.

Files: Desktop App.tsx; components/CompactAssistant.tsx, ChatPanel.tsx, VoiceOrb.tsx, ControlDeck.tsx, TaskCard.tsx, TaskPlan.tsx, ApprovalModal.tsx, AuditLog.tsx, MemoryPalaceViewer.tsx; hooks/useAudioCapture.ts, useTaskStream.ts, useFishVoice.ts, useElevenLabs.ts; stores/vanessaStore.ts; index.css.

**Exit:** desktop supports multi-turn typed/voice use and real task lifecycle without debug-only status interpretation.

### Phase 9 — Local release candidate

Root install/build, protocol drift, orchestrator suite, voice suite, desktop build/runtime smoke, Android core/unit/APK/instrumentation, physical Windows read-only + approved reversible action, physical Android local model/on-device speech, physical Android↔Windows task/approval/reconnect.

Files: .github/workflows/ci.yml, android.yml, android-ui-qa.yml, desktop-release.yml; scripts/launch-vanessa.cjs, doctor.cjs, verify-local-setup.ps1, build-windows-installer.ps1, package-windows-bootstrap.ps1, test-windows-installer.ps1, test-windows-msi.ps1; Android Gradle config/README; docs/engineering/END_TO_END_ACCEPTANCE.md.

**Exit:** reproducible local candidate and acceptance report; no critical/high defect open; unsupported features explicitly unavailable.

## 5. File-by-file ownership ledger

### Conversation
- packages/protocol/src/conversation.ts: preserve strict session/turn/event contract; change only via contract review.
- conversation.test.ts and conversation-conformance.test.ts: bounds, malformed events, duplicate/stale ordering and shared vectors.
- packages/protocol/schema/*conversation* and fixtures/*conversation*: deterministic generated schema/fixtures.
- Kotlin ConversationModels.kt, ConversationCodec.kt, ConversationReducer.kt: strict parity at trust boundary.
- Android ConversationController.kt and ConversationContextSpec.kt: one turn/session source, generation fence, bounded context.
- Desktop new renderer/conversation/*: add only after interface contract review; adapt existing store/voice events instead of building another authority.

### Orchestrator
- core/orchestrator.ts: request lifecycle/correlation/tombstones.
- core/planner.ts, agentRouting.ts, router.ts: intent, route, bounded plan and clarification.
- core/contextBuilder.ts: bounded provenance context.
- core/permissionGuard.ts, actionRegistry.ts, agents/agentCatalog.ts: authority and action contract.
- core/taskRunner.ts, processSupervisor.ts, resourceLocks.ts: scheduling, process proof, checkpoints and locks.
- core/agentResult.ts, critic.ts, narrator.ts: independent outcome and truthful response.
- core/privacy.ts, workingMemory.ts, memory/memoryPalace.ts: redaction, provenance and persistence review.

### Desktop
- renderer/App.tsx: coordinate surface handlers; no execution authority.
- stores/vanessaStore.ts: view projection; migrate authoritative transcript/task data to controller/session.
- hooks/useTaskStream.ts: validate/dedupe/correlate stream and plan terminal state.
- hooks/useAudioCapture.ts: capture generation and typed/voice request adapter.
- components/ChatPanel.tsx, CompactAssistant.tsx: real turns, draft, progress, approval and error.
- VoiceOrb.tsx: map actual runtime state.
- TaskPlan.tsx, TaskCard.tsx, ApprovalModal.tsx, AuditLog.tsx: plan/evidence/approval/result.
- main/ipc.ts, preload and vanessa.d.ts: typed validated IPC.
- main/runtimeConfig.ts and security/runtime startup files: local origin and service lifecycle.

### Voice
- session/voiceSession.ts: shared conversation adapter, request correlation and task handoff.
- bargeIn.ts, wakeWord.ts: playback vs capture lifecycle.
- audio/vad.ts, turnDetector.ts, speechGate.ts, capture.ts: turn boundaries and stale callback guard.
- asr/* and tts/*: provider contracts/errors, queue and lifecycle.
- server.ts and orchestratorClient.ts: local transport and typed failure responses.

### Android
- ui/MainActivity.kt: Activity/resource lifecycle/navigation/controller owner.
- ui/VanessaApp.kt: main screen projection/insets.
- ui/VanessaAssistantScreens.kt: Chat/Listening/local task flows.
- ui/VanessaWelcomeFlow.kt: welcome/onboarding/permission reachability.
- ui/RemoteControlActivity.kt: remote task host lifecycle/back.
- ui/screens/*.kt: remote My PC/Approval/Execution/Result/Recovery.
- ui/state/RemoteTaskUi.kt: reducer/replay invariants.
- voice/AndroidOnDeviceSpeechInput.kt: partial/final/error/cancel with generation fencing.
- voice/OfflineTtsController.kt: offline queue and playback fence.
- inference/LlamaCppInference.kt and Qwen3PromptTemplate.kt: model availability/bounded inference.
- agent/AndroidLocalToolExecutor.kt: narrow explicit local allow-list.
- ui/theme/* and ui/components/*: targeted polish, no full redesign.

## 6. Test and evidence standards

| Test layer | Proves | Does not prove |
|---|---|---|
| Unit | schemas, reducers, planners, guards, classifiers | platform interaction |
| Component/Compose | visible state/click/scroll semantics | OS side effects |
| Integration with injected boundary | production module wiring | physical hardware/provider quality |
| CI emulator | tests included in actual JUnit XML | physical mic/local model/real PC |
| Windows runner | packaging and deterministic runtime tests | user's real audio endpoints |
| Physical acceptance | exact device/build/provider/action tested | untested hardware/config |

Every action test includes positive verified result, unavailable device/permission/provider, malformed result, timeout/cancel race, duplicate/idempotency, unauthorized input and false-success rejection.

Every voice test includes partial/final ordering, late callback, duplicate final, previous generation, stop vs finalize vs cancel, provider disconnect, response validation, TTS failure and proof that task state remains independent.

Every UI PR includes screen inventory updates, named scroll owner/state, stable semantics, before/after screenshots, compact/standard/large-font evidence and JUnit XML showing instrumentation executed.

CI rules:
- no swallowed exit code, tail pipeline masking or || true on decisive commands;
- missing/empty JUnit XML is failure;
- skipped tests are not counted as passed;
- record exact SHA, run ID, job, executed/skipped/failure counts;
- do not repeatedly trigger exhausted paid Codex reviews.

## 7. PR sequence and Definition of Done

| PR | Scope | Exclusions |
|---|---|---|
| A | CI baseline and existing PR reconciliation | UI redesign |
| B | Windows read-only verified vertical slice | risky writes |
| C | Stop/cancel correctness and request recovery | conversation schema rewrite |
| D | Conversation adapter/controller | model/JNI rewrite |
| E | Desktop typed/voice shared conversation | agent proliferation |
| F | Android ASR + composer integration | redesign |
| G | Validated assistant output + TTS lifecycle | task state machine changes |
| H | Compose projection + scroll polish | new remote protocol |
| I | Agent capability/evidence improvements | arbitrary shell enablement |
| J | Android↔Windows physical acceptance | public-store package |
| K | Local candidate and end-to-end regression | public legal release claims |

A PR is Done only when scope/files are named before coding; changes are typed/reviewable; tests fail if the defect returns; affected module tests and full CI pass on latest head; UI claims match backend evidence; no unrelated/generated drift; docs match actual tests; and physical behavior is called physical only with a recorded device run.

## 8. Work tracking format

Each PR records: requirement; current behavior; target behavior; files; decisions; tests; CI run IDs/results; physical acceptance (if applicable); remaining limitations; merge decision.

Do not report a phase complete because it compiles. Use the acceptance criteria and evidence standards above.

## 9. Explicitly deferred

Until explicitly requested, public-store listing, public Terms of Use/Privacy Policy, distribution disclosures, marketing claims, public onboarding and customer-support promises are deferred. This does not suspend engineering security: local permission enforcement, authentication, least privilege, safe logging, key storage, data minimization, truthful local-feature disclosures and correct permissions remain in scope for local testing.
