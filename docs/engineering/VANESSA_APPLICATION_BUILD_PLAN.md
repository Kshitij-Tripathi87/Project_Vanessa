# Vanessa application implementation and SDLC plan

**Status:** Active implementation baseline  
**Repository baseline:** main at 838b51f9cbaaf039451091b7ebede12127d50dc8 (21 November 2026)  
**Delivery focus:** Windows PC execution first, followed by shared conversation and voice integration, then natural-language Android-to-PC execution.  
**Release posture:** Local testing. Public distribution paperwork is deferred until explicitly requested.

## 1. Product acceptance objective

Vanessa is not complete when the orb animates, an LLM returns text, or a task is dispatched. A user must be able to type or speak a request, continue with references to earlier turns, receive a constrained plan, authorize the required actions, observe real progress, interrupt speech without cancelling work, cancel work with process evidence, and receive a final answer grounded in verification.

The product invariant is:

- Conversation stores what was said and the request/turn correlation.
- Voice owns capture, recognition and playback.
- The orchestrator owns planning and task execution.
- The canonical action catalogue and PermissionGuard own authority.
- Handlers produce evidence; verifiers decide whether the requested postcondition was reached.
- Desktop and Android render runtime state. Neither client manufactures task truth.

There is one execution authority: VanessaOrchestrator → VanessaPlanner → PermissionGuard → TaskRunner → registered specialists → critic/verifier. Do not create a second supervisor or action registry for voice, desktop or Android.

## 2. Repository baseline: implemented versus incomplete

### Existing foundations

- Electron desktop shell, floating orb, typed composer, microphone capture, voice WebSocket, task event stream and Windows installer.
- Windows launcher, service composition and install/uninstall smoke tests.
- VanessaOrchestrator, planner, permission guard, TaskRunner, process supervisor, resource locks, event bus, result recorder, critic and Memory Palace.
- Canonical specialist registry and reviewed action catalogue.
- Remote v2 protocol, paired-device identity, signed messages, PC-side approval and Android task state reducer.
- Shared TypeScript conversation contract, Kotlin models, TypeScript/Kotlin reducers and a standalone Android-core ConversationController.
- Android Compose application, local model inference, on-device ASR, offline TTS and emulator journeys.

### Integration gaps that remain real

- The desktop renderer still presents a latest command/latest response rather than a complete durable multi-turn transcript.
- The desktop voice session has its own bounded in-memory history and does not yet fold all turns through the shared conversation reducer.
- The Android ConversationController is not wired to MainActivity, ASR callbacks, planner, TTS, or UI projection.
- Conversation persistence, user/project memory retrieval, explicit clarification and recovery across app restarts remain incomplete.
- Android remote v2 is currently a structured capability route. It is not yet a general natural-language request entering the PC orchestrator. Current v2 availability relies on the configured PC signer and Tailscale address; an anywhere-access relay is not a completed feature.
- MobileTaskEngine startup handling is conservative and does not safely resume every in-flight task.
- Some catalogue actions are intentionally blocked or narrow. Do not activate placeholders, arbitrary PowerShell or unbounded file/browser capabilities to make a demonstration appear more autonomous.
- A green build, emulator navigation suite or installer smoke test does not prove a real PC task, microphone journey, model-backed scenario or Android-to-PC journey.

## 3. Delivery sequence

| Priority | Milestone | Outcome | Completion evidence |
|---|---|---|---|
| P0 | Task-control correctness | Stop speaking, stop listening and cancel task are distinct; UI reflects real cancellation evidence | Unit tests + desktop CI |
| P1 | Windows execution vertical slice | A real read-only and a reversible multi-step Windows task complete through plan, policy, execution and independent verification | Windows integration run + evidence |
| P1 | Shared conversation runtime | Desktop typed and voice input share the same conversation/request correlation | Reducer, adapter and renderer tests |
| P1 | Voice reliability | ASR, playback, interruption, cancellation, reconnect and offline states have deterministic lifecycles | Voice integration tests + physical microphone test |
| P2 | Agent capability hardening | Every enabled Windows/browser/file action has a real handler and verifier | Action acceptance matrix |
| P2 | Durability and recovery | Restart reconciliation avoids duplicate side effects and invented success | Crash/restart drills |
| P3 | Android natural-language remote | Phone request enters the same PC orchestrator with device-scoped authority | Physical phone + paired PC run |
| P3 | Anywhere transport | Relay transports opaque, expiring requests without gaining execution authority | Threat model + fault injection |
| P4 | UI/accessibility polish | Every screen, scroll region, keyboard, loading and error state is deliberate | Emulator, Windows and device UX suite |

A milestone is not complete because it compiles. Every milestone has a reproducible user journey and a verification gate.

---

## 4. P0 — Correct task and voice controls

### Desired control semantics

- **Stop speaking:** stops local TTS/browser speech playback only. It retains the written response and does not change task state.
- **Stop listening:** stops microphone capture. It does not silently cancel an already accepted task.
- **Cancel task:** calls request-scoped orchestrator cancellation exactly once and renders the returned process evidence.
- **Emergency stop:** calls the global kill switch and reports aggregate cancellation evidence.
- **Barge-in:** fences the current playback generation and opens a new listening turn. It does not cancel the task that produced the interrupted response.
- **Termination unconfirmed:** remains an unresolved state, retaining request/task identity and resource-lock information. It must never be rendered as successful cancellation.

### File-level implementation

| File | Change |
|---|---|
| services/orchestrator/src/core/taskRunner.ts | Return aggregate cancelled, executionFinished and terminationUnconfirmed counts from triggerKillSwitch. Preserve existing process-supervisor proof and audit logic. |
| services/orchestrator/src/core/orchestrator.ts | Make cancelAll return the kill-switch summary. Keep cancelRequest(requestId) as the ordinary task-cancellation authority. |
| services/orchestrator/src/server.ts | Include counts from POST /api/cancel; preserve request-scoped cancellation counts from POST /api/cancel/request. |
| apps/desktop/src/renderer/taskCancellation.ts | Pure result mapper. Missing evidence or request failure remains unresolved; clear IDs only after confirmed cancellation or a planning tombstone. |
| apps/desktop/src/renderer/taskCancellation.test.ts | Cover confirmed cancellation, planning-only tombstone, already-finished operations, unconfirmed termination, mixed outcomes and missing/failed responses. |
| apps/desktop/src/renderer/vanessa.d.ts | Extend the cancelTask result type with the backend evidence counters. |
| apps/desktop/src/renderer/hooks/useAudioCapture.ts | Add local stopSpeaking with playback-generation fencing and per-response TTS suppression. Reset suppression on new user input. This function must never cancel orchestrator work. |
| apps/desktop/src/renderer/App.tsx | Split local speech/capture stop from task cancellation. Use one backend request and the pure result mapper. Retain identity and approval while cancellation is unresolved. |
| apps/desktop/src/renderer/components/CompactAssistant.tsx | Render separate Stop speaking and Cancel task controls; expose Cancelling and Termination unconfirmed states. |
| apps/desktop/src/renderer/stores/vanessaStore.ts | Add cancelling and termination_unconfirmed stages. |
| apps/desktop/src/renderer/hooks/useTaskStream.ts | Map cancel_requested and termination_unconfirmed events without treating them as terminal success. |
| package.json | Add the desktop cancellation regression command. |
| .github/workflows/desktop-release.yml | Execute the cancellation suite before packaging the Windows installer. |

### Acceptance cases

1. Stop speaking during playback; audio stops, response text remains and task state is unchanged.
2. Stop speaking before a delayed TTS chunk; the chunk is discarded.
3. Cancel an active request; exactly one request-scoped API call occurs.
4. Confirmed process termination is shown as cancelled.
5. A task that finished before cancellation remains in result verification.
6. Any unconfirmed process tree remains unresolved and retains request identity.
7. API/network failure cannot display “Stopped”.
8. Barge-in resumes capture without a task-cancel call.
9. Escape invokes the global kill switch and renders aggregate counts.
10. A cancellation tombstone received before submission prevents late planning from starting work.

---

## 5. P1 — Prove a real Windows execution vertical slice

Do not add more agents until one execution workflow is proven through the full runtime.

### Initial scenarios

**Read-only:** inspect Windows system status and report only fields returned by the approved system capability.

**Reversible multi-step task:** within a dedicated test workspace, locate a specifically named test folder, inspect contents, create a report using a typed/approved file action, read the new file back and verify exact contents. Only use actions already declared selectable and backed by real handlers. If the catalogue cannot express the scenario, add one narrowly scoped typed action and verifier. Do not substitute a generic shell command.

### File-level implementation and audit

| File | Work required |
|---|---|
| services/orchestrator/src/core/orchestrator.ts | Verify request lifecycle, expiry, idempotency, plan correlation and final outcome. Test cancel-during-planning and duplicate submissions. |
| services/orchestrator/src/core/planner.ts | Test decomposition, exact action selection, dependencies, bounded context and unavailable capabilities. Model output must not create tools or permissions. |
| services/orchestrator/src/core/permissionGuard.ts | Test scope, risk floors, approval rules and policy-version binding. Planner-supplied risk cannot lower catalogue risk. |
| services/orchestrator/src/core/taskRunner.ts | Test DAG scheduling, dependency failures, locks, cancellation races, task checkpoints and final state. |
| services/orchestrator/src/core/agentResult.ts | Reject generic success prose, process launch and partial output as proof of completion. |
| services/orchestrator/src/core/critic.ts | Add independent postcondition checks for the read-only and reversible workflows. |
| services/orchestrator/src/core/narrator.ts | Narrate success only from verified results; preserve partial, blocked, failed and unverified distinctions. |
| services/orchestrator/src/agents/agentCatalog.ts | Generate an action matrix from the canonical catalogue: schema, handler, scope, risk, idempotency, timeout, evidence, verifier, platform and tests. |
| services/orchestrator/src/agents/windows.agent.ts | Verify returned Windows values against observed state. Distinguish requested, issued, observed and verified. |
| services/orchestrator/src/agents/file.agent.ts | Validate canonical roots, traversal, reparse points/symlinks, operation scope and post-write read-back. |
| services/orchestrator/src/agents/browser.agent.ts | Distinguish browser process start, navigation, page load and verified page condition. |
| services/orchestrator/src/core/processSupervisor.ts | Exercise process-tree termination, timeouts, output caps, orphan cleanup and unconfirmed termination locks. |
| services/orchestrator/src/memory/memoryPalace.ts | Verify durable task/idempotency/checkpoint rows, retention, restart reconciliation and secret redaction. |

**Acceptance evidence:** exact input, request ID, plan ID, task IDs, handlers, policy decisions, state before/after, verifier output, timestamps, build SHA and test report. Store redacted logs and a reproducible fixture.

---

## 6. P1 — Shared conversation runtime for desktop

The shared contract and reducers already exist. Reuse them; do not duplicate message models or reducer semantics.

### Lifecycle contract

1. Committed input creates one user turn and one request ID.
2. ASR partials update that turn and never start planning.
3. Final ASR commits the same turn exactly once.
4. Bounded, privacy-redacted previous turns become planner context; the current turn is not duplicated into its own context.
5. The orchestrator receives one request with the same request ID and an idempotency key.
6. Validate the complete assistant response before publication. Do not claim token streaming when the model returns a completed string.
7. Commit a distinct assistant turn correlated to the same request.
8. Task status remains owned by orchestrator events, not the conversation reducer.

### Files

| File | Work required |
|---|---|
| packages/protocol/src/conversation.ts | Canonical wire contract. Change only for a documented requirement; regenerate Kotlin artifacts and fixtures. |
| packages/protocol/src/conversation.test.ts | Replay, ordering, bounds, interruption and overflow cases. |
| packages/protocol/src/conversation-conformance.test.ts | Keep TypeScript/Kotlin parity and generated-artifact drift in CI. |
| packages/shared/src/commandRequest.ts | Validate request ID, idempotency, source, expiry and bounded context at orchestrator ingress. |
| apps/desktop/src/renderer/stores/vanessaStore.ts | One conversation projection and bounded message selectors; no competing latest-response/transcript authorities. |
| apps/desktop/src/renderer/hooks/useConversation.ts (new) | Adapt shared reducer to renderer; create IDs, serialize submissions and fence stale callbacks. |
| apps/desktop/src/renderer/hooks/useAudioCapture.ts | Route ASR partial/final callbacks through the conversation adapter; audio lifecycle remains separate from task authority. |
| apps/desktop/src/renderer/App.tsx | Route typed input and voice input through one conversation submission path. |
| apps/desktop/src/renderer/components/ChatPanel.tsx | Render multi-turn history, partial transcript, task reference, approvals and result. Only auto-scroll when the reader is near the bottom; provide jump-to-latest. |
| apps/desktop/src/renderer/components/CompactAssistant.tsx | Keep the orb as entry surface and render store state only. |
| services/voice-agent/src/session/voiceSession.ts | Integrate request/turn identity without owning task state or a second planner. |
| services/voice-agent/src/orchestratorClient.ts | Pass identity, idempotency and validated context once; map results consistently. |

### Tests

- Typed input → one user turn → one orchestrator request → one assistant turn.
- Partial transcript N updates one turn; final commits it once.
- Duplicate final and stale partial cannot revive a turn.
- “And tomorrow?” gets bounded earlier context without replaying the previous task.
- Concurrent submissions remain correctly correlated.
- Late response chunks after interruption are rejected.
- Oversized response is rejected before publication.
- Conversation interruption does not cancel a running task.
- Older messages remain available when a new turn starts.
- Persistence is marked incomplete until restart restoration is implemented and tested.

---

## 7. P1 — Voice runtime correctness

### State ownership

- ASR owns capture, partial/final transcript and language metadata.
- Conversation owns the committed transcript and assistant response.
- TTS owns playback queue, generation fence and output device.
- Orchestrator owns task execution and cancellation.
- Barge-in stops playback and starts a new listening turn; it does not call task cancellation.
- Explicit Cancel task sends one request to the orchestrator and uses termination evidence.
- Voice WebSocket loss must not lose the written result or duplicate a submitted request.

### Files

| File | Work required |
|---|---|
| services/voice-agent/src/server.ts | Validate controls and payload bounds; keep capture deactivation separate from task cancellation where required. |
| services/voice-agent/src/session/voiceSession.ts | Separate playback interruption, capture stop, conversation failure and task cancellation. Fence stale callbacks by generation and request ID. |
| services/voice-agent/src/session/bargeIn.ts | Test false activation, latency, cooldown and repeated interruption. |
| services/voice-agent/src/audio/vad.ts | Test silence, noise, clipping and speech boundaries against fixed audio fixtures. |
| services/voice-agent/src/audio/turnDetector.ts | Test pauses, long turns and finalization races. |
| services/voice-agent/src/asr/*.ts | Normalize partial/final/error/readiness contracts. Unavailable providers fail explicitly. |
| services/voice-agent/src/tts/*.ts | Normalize chunks, provider failures, abort and final-chunk semantics. |
| apps/desktop/src/renderer/hooks/useAudioCapture.ts | One audio queue, generation fence, stop-speaking path and deterministic capture teardown. Audio controls never represent task cancellation. |
| apps/desktop/src/renderer/components/VoiceOrb.tsx | Map actual state events; remove speculative emotional states and fake activity. |
| apps/desktop/src/renderer/components/CompactAssistant.tsx | Show listening, transcribing, thinking, executing, verifying, speaking, interrupted, failed and offline distinctly. |
| apps/desktop/src/renderer/hooks/microphoneDiagnostics.ts | Distinguish local signal detection from real ASR acceptance. |

**Acceptance:** physical Windows microphone and selected output device; one spoken request; live partials; one committed final; verified task result; barge-in during playback; Stop speaking while the task continues; Cancel task with process evidence; provider disconnect/reconnect; no duplicate execution.

---

## 8. P2 — Agent capability completion

The target is dependable capability, not a larger agent count.

For every selectable catalogue action record its handler, schema, platform, scope, risk floor, idempotency, timeout, cancellation behavior, evidence, independent verifier, tests and known failure modes.

| File | Work required |
|---|---|
| services/orchestrator/src/agents/agentCatalog.ts | Canonical action declarations; no duplicate frontend catalogue. |
| services/orchestrator/src/agents/registry.ts | Every selectable action resolves to exactly one specialist. |
| services/orchestrator/src/core/actionRegistry.ts | Handler key, typed arguments and runtime resolver must agree. |
| services/orchestrator/src/core/agentRouting.ts | Deterministic routes for exact resource requests; never bypass planner policy. |
| services/orchestrator/src/agents/windows.agent.ts | Read-only system and Windows controls with observed-state verification. |
| services/orchestrator/src/agents/windows-ui-automation.ts | UIA target matching, visible/enabled checks and postcondition verification. |
| services/orchestrator/src/agents/browser.agent.ts and browser-playwright.agent.ts | Navigation, locator and loaded-state evidence. |
| services/orchestrator/src/agents/file.agent.ts and folder.agent.ts | Root containment, traversal, reparse points, confirmation and read-back. |
| services/orchestrator/src/agents/developer.agent.ts, codex-task-runner.ts and repairWorkspace.ts | Keep general coding blocked/interactive until isolated worktree execution and independent tests exist. |
| services/orchestrator/src/core/permissionGuard.ts | Enforce device/user scopes and risk floors. |
| services/orchestrator/src/core/agentResult.ts and critic.ts | Verify postconditions rather than trusting agent prose. |

Roll out in this order: read-only Windows status; bounded filesystem read/search; browser open/navigate; reversible workspace file create/update with read-back; one deterministic Windows UIA flow; document productivity; coding only after sandbox/worktree proof. External communications remain draft-first.

---

## 9. P2 — Persistence, memory and restart recovery

| File | Work required |
|---|---|
| services/orchestrator/src/memory/memoryPalace.ts | Audit SQLite schema, durable task rows, checkpoints, conversation storage, retention and secret policy. |
| services/orchestrator/src/core/workingMemory.ts | Explicitly classify process-local versus durable fields. |
| services/orchestrator/src/core/taskRunner.ts | Resume only idempotent actions after checking preconditions; reconcile uncertain non-idempotent work; retain conflicting locks if termination is unconfirmed. |
| services/orchestrator/src/core/orchestrator.ts | Persist parent request and idempotency mapping before acceptance. |
| services/orchestrator/src/remote/remoteTaskService.ts | Persist remote ownership and parent request before acknowledging acceptance. |
| services/orchestrator/src/core/mobileTaskEngine.ts | Replace blanket in-flight failure only with state-aware recovery; never blindly replay a previously running action. |
| apps/desktop/src/main/auditLog.ts | Bounded/redactable audit history; UI state is not audit history. |
| packages/protocol/src/conversation.ts | Add persistence/replay semantics only when the schema and conformance rules are specified. |

**Recovery drill:** stop the orchestrator during planning, an idempotent read, a reversible write, an approval wait and an unconfirmed process. Restart and prove there are no duplicate side effects or invented success.

---

## 10. P3 — Android-to-PC natural-language execution

- Android authenticates the paired PC; the phone never becomes execution authority.
- Remote intent enters the existing PC orchestrator as a parent request with a trusted principal and device scopes.
- Every child action is checked on the PC against the canonical catalogue and policy.
- Relay is transport only; it cannot interpret or execute commands.
- Signed messages are not encrypted messages. Do not claim end-to-end confidentiality without an authenticated session-key/AEAD protocol.
- Keep Tailscale direct transport while an outbound relay is designed and tested.
- Pending requests need expiry, idempotency, deduplication, durable acceptance and sequenced replay/snapshot recovery.
- PC offline reports queued/waiting. Reconnect rechecks expiry, scope and policy before execution.

| File | Work required |
|---|---|
| services/orchestrator/src/remote/remoteV2Gateway.ts | Transport, identity, session, replay defense and event delivery only. |
| services/orchestrator/src/remote/remoteTaskService.ts | Route authorized remote parent requests into one orchestrator entrypoint. |
| services/orchestrator/src/core/mobileTaskEngine.ts | Retain narrow structured capability route; do not turn it into a second planner. |
| services/orchestrator/src/remote/relayClient.ts | Transport client only; authenticated, encrypted, retry-safe envelopes. |
| services/relay/src/** | Opaque routing, TTL, quota, disconnect queue and receipts; no task interpretation or credential storage. |
| apps/android/app/src/main/java/com/vanessa/mobile/remote/RemoteV2BridgeClient.kt | Request identity, idempotency, sequence and reconnect recovery. |
| apps/android/app/src/main/java/com/vanessa/mobile/ui/RemoteControlActivity.kt | Render real pairing, connection, capability, task and approval state. |
| apps/android/app/src/main/java/com/vanessa/mobile/ui/state/RemoteTaskUi.kt | Correlate request/task IDs; late or foreign events cannot mutate active task. |

**Acceptance:** physical Android device paired to a Windows PC; natural-language request; per-action permission check; approval where required; returned result/evidence; disconnect/reconnect; duplicate replay; PC restart; no duplicate execution.

---

## 11. P4 — UI quality and accessibility

Preserve the existing orb-first dark visual identity. No unsolicited redesign, gradients or generic glassmorphism.

### Windows surfaces

- Collapsed orb: truthful idle/listening/thinking/executing/verifying/speaking/needs-attention/offline states.
- Expanded panel: multi-turn transcript, live partial, composer, task state, separate Stop speaking and Cancel task, approval and verified recent activity.
- Task details: request/plan/task IDs, action, policy state, approval expiry, evidence and outcome.
- Settings: model/provider readiness, local inference, microphone capture vs ASR readiness, output test vs actual playback, privacy mode and workspace.
- Connection: orchestrator, voice service and PC/phone link separately. One healthy service must not imply the others are healthy.

### Android screens and scrolling

Use docs/engineering/ANDROID_SCREEN_INVENTORY.md and docs/engineering/SCROLL_AND_LAYOUT_SPEC.md as source of truth. Audit each scroll area for content bounds, system insets, IME behavior, focus, scroll-to-focused-field, scroll restoration, TalkBack order, small displays and font scaling.

Screens: Welcome, Onboarding, Permissions, Home/Chat, Listening, Confirmation, Task Execution, Task Recovery, Task Result, My PC/Pairing and Settings. Preserve current navigation and orb asset.

### Desktop components

apps/desktop/src/renderer/components/CompactAssistant.tsx, ChatPanel.tsx, VoiceOrb.tsx, ControlDeck.tsx, TaskCard.tsx, TaskPlan.tsx, ApprovalModal.tsx, AuditLog.tsx, MemoryPalaceViewer.tsx and apps/desktop/src/renderer/index.css.

No component owns task truth; each consumes store projections and runtime events.

---

## 12. Full SDLC and quality gates

### A. Discovery and requirements
- Review current main, commits, open issues and failure logs.
- Record existing behavior, assumptions, gaps and the acceptance journey.
- Trace each request through UI, IPC, service, orchestrator, catalogue, handler and verifier.
- Freeze state ownership and interface contracts before coding.

### B. Design
- Record architecture decisions and API/state diagrams.
- Define event ordering, IDs, timeout, cancellation, retry and recovery.
- Threat-model model output, remote devices, files, processes and provider content.
- Specify error and degraded modes before polishing UI.

### C. Implementation
- Small reviewable changes on feature branches.
- Types/schemas first; regenerate Kotlin artifacts via the checked-in generator.
- Pure logic before UI glue.
- Every privileged action remains behind typed handlers and policy checks.
- No unrelated theme/UI changes.

### D. Verification
- Unit tests for pure functions, validators, reducers and policy.
- Contract/conformance tests across TypeScript/Kotlin.
- Integration tests with deterministic fake providers/handlers.
- Fault injection for timeout, abort, duplicate requests, stale events, restart, network loss and permission denial.
- Windows process/UI integration tests.
- Android emulator journeys with required XML tests asserted executed.
- Physical microphone, speaker, model and Android/PC acceptance.

### E. CI and release engineering
- Build all workspace packages with frozen lockfile.
- Run relevant deterministic suites on every change.
- Preserve test reports and failing logs.
- Package installer only after code gates pass.
- Install, launch, smoke test, uninstall and check residual files/services.
- Record artifact SHA with commit SHA.
- A green build or installer smoke test is not a functional execution claim.

### F. Local operational readiness
- Doctor/readiness report for orchestrator, voice, ASR/TTS, model, native runtime, signer and remote network.
- UI shows explicit unavailable/degraded states.
- Logs remain redacted and bounded.
- Task timeline and verifier evidence remain inspectable.
- Local test configuration is separated from any future public-release configuration.

### Deferred until public-install/distribution is explicitly requested

Store policies, public terms/privacy policy, disclosures, support process, app-store metadata, platform-specific release paperwork and public compliance review are out of the current local-testing scope. Security and privacy engineering inside the app remains in scope now.

---

## 13. Definition of done

Mark a feature as **implemented** when code exists, **unit-verified** when deterministic tests pass, **integration-verified** when service boundaries pass, **device-verified** when the real hardware journey passes, and **release-verified** when the packaged build is installed and smoke-tested.

Vanessa is not complete until:
- one multi-turn conversation path works across text and voice;
- task creation, approval, cancellation and result correlate end to end;
- a real Windows multi-step task is independently verified;
- interruption does not cancel tasks and task cancellation never falsely claims termination;
- selected agents have real handlers and verifiers;
- restart and duplicate-request drills pass;
- Android sends natural-language requests to the same PC execution authority;
- the physical Android ↔ Windows journey passes;
- all required CI checks are green and expected tests are reported executed;
- UI state is a projection of runtime evidence, never an optimistic placeholder.

**Delivery discipline:** report only what changed and was tested on the current branch. A PR, green compile or passing mock is not proof of the complete application.
