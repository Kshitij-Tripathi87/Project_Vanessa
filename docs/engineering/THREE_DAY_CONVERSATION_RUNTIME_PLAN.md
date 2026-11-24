# Three-Day Conversation Runtime Completion Plan

> **Historical planning snapshot:** Subsequent PRs #85–#87 merged desktop and Android conversation/voice wiring. The dated three-day sequence below is not the current schedule or evidence of physical acceptance. The [integrated product plan](VANESSA_INTEGRATED_PRODUCTION_PLAN.md) takes precedence where plans conflict; see [CONVERSATION_RUNTIME.md](CONVERSATION_RUNTIME.md) and the [S0 baseline](S0_BASELINE.md) for current scope and limits.

**Status:** Original execution specification — not evidence of a completed journey<br>
**Baseline:** main at 22ba127ce9ebe8dfefb250a6fa97e9875fe163e3 (PR #70 merged)  
**Target dates:** 21–23 November 2026 (Asia/Kolkata)  
**Target deliverable:** Integrated Android voice-and-text conversation MVP  
**Owner:** Engineering lead  
**Delivery rule:** No merge or completion claim without tests and an executed emulator journey

> This is a three-day delivery plan for the Android conversation bridge, not a claim that the entire Vanessa product—including durable memory, clarification, desktop parity, remote-PC acceptance and production task persistence—can be completed in three days. The target is a usable, integrated Android conversation runtime using the already-existing local planner and approved local capabilities. Remaining product gaps stay visible.

---

## 0. Executive decision

The next phase is a vertical integration milestone, not another isolated foundation PR.

PR #70 has already completed the cross-platform contract and reducer parity. Do not reimplement those capabilities. Build the Android runtime controller above the merged protocol module, then connect the existing recognizer, typed composer, current local planner, validated response output, optional offline TTS, and Compose UI to that one authority.

The three-day target is to ship the following coherent path:

1. Typed and voice input enter through the same request lifecycle.
2. A conversation user turn is created exactly once and has a unique turn ID.
3. Voice partials revise that same turn; a final transcript commits it exactly once.
4. Planner context comes from completed prior turns in the controller-owned state and excludes the current incomplete turn.
5. The existing local planner and its existing allow-listed tools execute with current validation and permission rules unchanged.
6. A distinct assistant turn shares the user request ID and publishes only a fully validated response.
7. Assistant response text is represented by bounded conversation events. The current local model remains whole-response generation; no token-streaming claim is permitted.
8. Offline TTS remains opt-in through the existing Read Aloud affordance. Playback has explicit start/done/error/stop state and stale-callback protection.
9. The UI projects chat history and live draft from the reducer state. The separate chat-history and voice-draft stores cease to be authoritative.
10. New deterministic tests and instrumented emulator journeys prove typed input, voice partial/final, follow-up context, stop/cancel behavior, output and stale callback rejection.

### 0.1 Timebox

The target is end of Monday, 23 November 2026 (IST). Use the three calendar days as a fixed timebox:

- **Day 1 — Saturday, 21 November:** ConversationController and controller tests (PR B).
- **Day 2 — Sunday, 22 November:** ASR + typed input integration and assistant output/TTS adapter (PRs C and D).
- **Day 3 — Monday, 23 November:** UI projection, instrumented journeys, CI, docs, independent review and release decision (PR E).

Work should run in small reviewable changes. A red required check, an unexecuted emulator suite or a critical correctness defect blocks the relevant merge. The date is a target, not a reason to bypass those gates.

### 0.2 Definition of the three-day release

The release is complete only when the Android app has one reducer-backed conversation state for typed and voice input, the current local planner can consume completed prior turns, assistant responses are validated before publication, optional offline read-aloud works without corrupting conversation state, and the new emulator journeys pass.

The following are not included in this three-day definition: durable cross-process conversation persistence, Memory Palace retrieval, summarization of long-term history, explicit clarification protocol, desktop conversation-controller integration, native llama.cpp token streaming, new remote services, and full real-PC execution acceptance. These remain planned follow-on milestones and must not be described as complete.

---

## 1. Verified baseline after PR #70

PR #70 is merged into main as commit 22ba127ce9ebe8dfefb250a6fa97e9875fe163e3.

The PR added:
- Generated conversation-v1 JSON Schema from the existing Zod contract.
- Generated Kotlin serializable conversation models and generated validation rules.
- Strict TypeScript and Kotlin JSON codecs, including duplicate-member rejection and strict bounds.
- A pure Kotlin conversation reducer.
- Shared wire fixtures and reducer vectors consumed by both TypeScript and Kotlin.
- Cross-language conformance checks in CI.
- Five existing emulator user journeys executed with zero failures in the PR #70 CI run.
- An explicit correction to the prior response-overflow behavior: an overflowing response fails terminally instead of silently slicing text and reporting completion.

The four PR #70 CI jobs were green:
- build-and-test
- debug-apk
- Android emulator user journeys
- windows-installer

The Android emulator suite executed five existing instrumented tests. Those tests prove basic navigation and clean-install behavior. They do not prove that the new controller is used, that voice partials enter the reducer, that typed and voice input share the reducer, that assistant output is event-driven, or that playback interruption works.

### 1.1 Current application facts

| Area | Existing implementation | Current gap |
|---|---|---|
| Conversation wire contract | TypeScript Zod schema, generated JSON Schema, generated Kotlin models, strict codecs | No Android runtime owns it yet |
| Reducer | TypeScript and Kotlin reducers with shared fixtures | Android surfaces do not dispatch through it |
| Android history | MainActivity chatMessages | Independent authority; must be replaced |
| Live voice draft | MainActivity voiceDraft | Independent authority; must be projected from reducer |
| ASR | Android on-device recognizer with real partial callback | Callback does not publish conversation events or a capture lease |
| Typed input | Composer submits to runAssistant | Does not create the same conversation events as voice |
| Planner context | LocalPlanCoordinator gets bounded ConversationTurn history | History is sourced from chatMessages, not reducer state |
| Local inference | llama.cpp returns one completed GenerationResult string | No token-level stream |
| Response composition | LocalPlanCoordinator.respond returns one complete validated string | Not published through ConversationController |
| TTS | OfflineTtsController speaks one string via TextToSpeech | No utterance progress callback, queue generation or reducer integration |
| Task authority | Existing remote task state and correlation model | Must remain independent from conversation interruption |
| Memory and persistence | Memory Palace and other foundations exist in repository | Not integrated into Android turn context or durable conversation storage |

### 1.2 Relevant source files

Revalidate paths on the current branch before each PR. Known baseline paths:

- packages/protocol/src/conversation.ts
- packages/protocol/src/conversation.test.ts
- packages/protocol/schema/conversation-v1.schema.json
- packages/protocol/fixtures/conversation-events-v1.jsonl
- packages/protocol/fixtures/conversation-reducer-vectors-v1.json
- apps/android/core/protocol/src/main/kotlin/com/vanessa/protocol/conversation/ConversationModels.kt
- apps/android/core/protocol/src/main/kotlin/com/vanessa/protocol/conversation/ConversationCodec.kt
- apps/android/core/protocol/src/main/kotlin/com/vanessa/protocol/conversation/ConversationReducer.kt
- apps/android/core/protocol/src/test/kotlin/com/vanessa/protocol/conversation/ConversationConformanceTest.kt
- apps/android/core/agent/src/main/kotlin/ai/vanessa/agent/LocalPlanCoordinator.kt
- apps/android/core/agent/src/test/kotlin/ai/vanessa/agent/ConversationContextSpec.kt
- apps/android/app/src/main/java/com/vanessa/mobile/ui/MainActivity.kt
- apps/android/app/src/main/java/com/vanessa/mobile/ui/VanessaAssistantScreens.kt
- apps/android/app/src/main/java/com/vanessa/mobile/voice/AndroidOnDeviceSpeechInput.kt
- apps/android/app/src/main/java/com/vanessa/mobile/voice/OfflineTtsController.kt
- apps/android/app/src/main/java/com/vanessa/mobile/inference/LlamaCppInference.kt
- apps/android/app/src/androidTest/java/com/vanessa/mobile/ui/VanessaNavigationTest.kt
- docs/engineering/CONVERSATION_RUNTIME.md
- docs/engineering/END_TO_END_ACCEPTANCE.md

Read the current versions on the latest main before editing. Never assume this plan's initial file map is newer than the branch.

---

## 2. Scope and hard boundaries

### 2.1 Included

- One in-memory Android ConversationController per active conversation.
- Controller-owned immutable reducer state exposed to UI using StateFlow or the app's approved observable-state convention.
- Injectable ID and clock providers for deterministic tests.
- Serialized event application.
- Request and turn ID pairing.
- Capture-generation fencing.
- Typed input and ASR input publishing into the same event path.
- Planner-context projection from completed reducer turns.
- A response validator/chunker for the existing complete response string.
- Assistant turn lifecycle and error publication.
- Offline TTS progress callbacks and bounded playback queue, remaining opt-in.
- Reducer-derived Chat and Listening projections.
- Fake input/output dependencies for deterministic tests.
- New emulator journeys for the actual integrated behavior.
- Honest documentation and limitation updates.

### 2.2 Explicitly excluded

Do not add these to this timebox:

- Native llama.cpp token callbacks or JNI streaming.
- Automatic speech playback. Read Aloud remains user-initiated unless the product owner makes a separate, explicit decision.
- Cloud ASR, cloud TTS, remote audio transport or ambient recording.
- Durable conversation database, server synchronization or cross-device conversation history.
- Memory Palace retrieval or long-term summarization.
- Clarification turn outcomes or a missing-slot schema.
- A new task.handoff protocol event.
- New supervisor/task persistence infrastructure.
- Desktop VanessaVoiceSession integration with the Android controller.
- New model routing or inference provider fallback.
- New tools, permissions or widening of planner/tool authority.
- Redesigning the Android visual system or changing navigation outside the necessary conversation projection.
- Real-PC execution acceptance. Existing PC remote-control entry points and task state remain separate.
- A claim of production readiness or completion of the overall Vanessa Definition of Done.

### 2.3 Freeze existing authority boundaries

1. Conversation owns what was said, turn IDs, transcript text, response text and conversational status.
2. ASR owns microphone capture and recognized text only.
3. TTS owns audio playback lifecycle only.
4. LocalPlanCoordinator owns plan selection/validation and local tool invocation.
5. Existing approval and permission checks remain authoritative.
6. Existing remote task state owns remote execution, recovery, approval and cancellation.
7. The UI projects state. It must not manufacture turn or task state.
8. The controller does not decide whether a task is permitted.
9. Ending or interrupting a conversation turn must never implicitly cancel a remote task.
10. Stopping capture and cancelling capture are distinct operations.

---

## 3. Target architecture

### 3.1 Logical flow

    User voice / typed composer
              |
              v
    Android input adapters
      - offline SpeechRecognizer
      - typed composer
              |
              v
    ConversationController
      - request / turn identities
      - capture generation
      - serialized event ingress
      - reducer state
      - completed-turn context
              |
              +-------------------------+
              |                         |
              v                         v
    ConversationStateFlow       PlannerContext projection
              |                         |
              v                         v
    Compose UI projection       LocalPlanCoordinator
                                        |
                                        v
                              Existing allow-listed tools
                                        |
                                        v
                              Existing permission checks
                                        |
                                        v
                              Validated result / evidence
                                        |
                                        v
                              Validated assistant response
                                        |
                                        v
                              response.chunk events
                                        |
                                        v
                              Conversation reducer
                                        |
                        +---------------+---------------+
                        |                               |
                        v                               v
                 Chat UI projection              Explicit Read Aloud
                                                        |
                                                        v
                                                Offline TTS adapter
                                                        |
                                                        v
                                                Playback state callbacks

The task state machine remains a separate authority. The conversation controller references the request correlation ID; it does not own a task's execution state.

### 3.2 Module placement

Place the platform-neutral controller in the existing testable Android core layer, preferably:

- apps/android/core/agent/src/main/kotlin/ai/vanessa/agent/ConversationController.kt
- apps/android/core/agent/src/test/kotlin/ai/vanessa/agent/ConversationControllerSpec.kt

Add the existing core protocol project dependency to core:agent if it is not already present. Do not duplicate generated models or reducer code. Do not place business logic in MainActivity.

The controller may use Kotlin coroutines StateFlow because core:agent already uses kotlinx-coroutines-core. Keep the reducer itself pure and unchanged unless a conformance defect is discovered. If the controller is placed elsewhere after reviewing module direction, document why and prove there is no dependency cycle.

The Android app module continues to own:
- Android SpeechRecognizer integration.
- TextToSpeech and utterance callbacks.
- MainActivity lifecycle wiring.
- Compose projections.

### 3.3 State ownership

The ConversationController exposes:
- conversationId
- current ConversationState
- active request/capture metadata required for fencing
- current immutable state snapshot
- bounded completed-turn planner context

The Activity may retain non-conversation UI state such as:
- current destination/screen
- typed composer text
- model load/import state
- model inference metrics
- local device profile
- PC pairing screen state
- explicit TTS playback state
- transient permission dialog state

The Activity must not retain a second authoritative chat-history list or live transcript string after PR E.

---

## 4. ConversationController contract

### 4.1 Responsibilities

The controller must:
- allocate IDs;
- start user and assistant turns;
- enforce event ordering;
- apply all events through the merged Kotlin reducer;
- publish one state stream;
- reject stale capture callbacks;
- reject duplicate finals and completed callbacks;
- expose planner context made only from completed historical turns;
- preserve the interruption/cancellation boundary;
- provide deterministic tests through injected ID and clock sources.

It must not:
- know about Android Context, SpeechRecognizer, TextToSpeech, Compose or Activity lifecycle;
- call inference or LocalPlanCoordinator;
- call network or database services;
- make permission or policy decisions;
- invoke remote cancellation;
- create task state.

### 4.2 IDs

Every conversation and request ID must be canonical lowercase UUID strings accepted by ConversationCodec.

For each user request:
- one requestId;
- one user turnId;
- one distinct assistant turnId;
- the user and assistant TurnReceivedEvent carry the same requestId;
- the role differs;
- source is text or voice according to the actual entry point.

Do not reuse strings such as voice-hash, timestamp strings or provider turn IDs as the contract requestId. Provider turn IDs may be retained as adapter metadata only, not as a replacement for contract IDs.

Inject:
- IdProvider.newUuid(): String
- Clock.nowEpochMillis(): Long

Production defaults may use java.util.UUID.randomUUID() and System.currentTimeMillis(), but tests must inject fixed sequences. IDs must be lowercase and validate with the existing strict codec.

### 4.3 Recommended public API shape

These names are an implementation guide, not a demand to preserve exact signatures:

- createConversation(): ConversationState
- beginCapture(source = VOICE): CaptureLease
- publishPartial(lease, text): PublishResult
- publishFinal(lease, text): FinalizedRequest?
- finalizeCapture(lease): Unit
- cancelCapture(lease): Unit
- submitTyped(text): FinalizedRequest?
- beginAssistant(request, source): AssistantTurnHandle
- publishValidatedResponse(handle, fullText): PublishResult
- failAssistant(handle, reason): PublishResult
- plannerContext(excludingRequestId): List<ConversationTurn>
- state: StateFlow<ConversationState>

Every handle must contain the conversation ID, request ID, turn ID and generation required to prove that a callback still belongs to the current request. Avoid passing bare turn IDs through every callback where a typed handle can be used.

### 4.4 Event creation and event order

Voice capture can start before any words are recognized. Do not create an empty user turn merely because the microphone opened.

Required behavior:
1. beginCapture allocates a new monotonically increasing capture generation and returns a lease. It creates no conversation turn yet.
2. The first nonblank ASR partial calls publishPartial.
3. publishPartial verifies that the lease is current. If no user turn exists for that lease, it first publishes turn.received, then transcript.partial.
4. Later partials replace the draft on that same turn.
5. A final callback without any partial first creates turn.received, then publishes transcript.final.
6. A final callback after an accepted final is ignored.
7. A late partial after final is ignored by the reducer and controller.
8. A callback from an older generation is ignored before it can dispatch an event.
9. A blank partial never creates a turn and never clears a valid existing partial.
10. A blank final is an ASR error/empty-result path, not a successful transcript.

For typed input:
1. Trim only the UI's intentional outer whitespace. Do not rewrite interior whitespace or content.
2. Reject empty text.
3. Create the user turn with source=text.
4. Publish transcript.final once.
5. Capture the planner context before this request joins history, or explicitly exclude the current requestId from the context projection.

### 4.5 Request lifecycle and pairing

A user request is finalized before local planning begins.

- The user turn becomes completed when transcript.final is accepted.
- The planner receives the request text and the completed prior context.
- Once a validated final response or a user-visible terminal failure is ready, create one assistant turn using the same requestId and a different turnId.
- The assistant turn must not reuse the user turnId.
- The assistant response turn is independent from remote task state. The requestId is correlation, not authorization.
- A permission-required path must preserve the original request context while the OS permission prompt is open. It must not append the same user turn again on callback.
- If a permission callback causes a retry, the original user turn and requestId remain stable.
- A denied permission produces a truthful assistant result and no tool execution.
- A timeout/failure must terminally resolve the relevant conversation turn without manufacturing task success.

### 4.6 Serialized event ingress

The reducer is pure, but callbacks may arrive from Android recognizer threads, main thread UI callbacks, coroutine continuations and TTS binder callbacks.

Serialize state mutation in the controller:
- Use one synchronized ingress lock or a single-threaded actor/dispatcher with explicit ordering.
- State transition and current-handle checks must occur atomically.
- Do not call UI listeners or arbitrary external callbacks while holding the lock.
- Expose immutable state snapshots.
- Do not allow multiple concurrent callbacks to reorder final and partial events.
- Duplicate accepted finals must be idempotent.
- No ignored stale event may allocate a turn.
- The StateFlow state must be updated only after successful validation and reducer application.

All locally generated events must pass the strict codec egress validator before entering the reducer or have an equally strict typed validation path demonstrably equivalent to it. Do not bypass UTF-16 bounds, UUID rules or event field validation because the event originated inside the app.

### 4.7 Generation fencing

Use independent monotonic generations for:
- microphone capture;
- assistant response publication, if asynchronous work can be superseded;
- TTS playback.

Each callback captures its generation/lease when registered. Before state mutation or playback action, compare it with the currently active generation. A stale callback must become a no-op.

When cancelling capture:
- invalidate the generation before invoking platform cancel/destroy;
- cancel/destroy the recognizer;
- reject any callback that arrives after cancellation.

When finalizing capture:
- call SpeechRecognizer.stopListening();
- keep the current capture lease valid until onResults/onError resolves;
- accept the final callback once;
- close the lease after its terminal callback;
- apply a bounded timeout or explicit failure path if a platform callback never arrives. Do not keep a capture active indefinitely.

When starting a new capture:
- invalidate prior capture generation;
- stop current TTS playback if it is active;
- do not send remote task cancellation;
- create the next capture lease.

### 4.8 Planner context

The context source must be ConversationController state, not MainActivity.chatMessages.

Use the existing policy:
- at most six turns;
- at most 240 characters per turn after whitespace normalization;
- at most 1,200 total characters;
- newest turns survive trimming;
- user/assistant ordering remains chronological;
- only completed turns are included;
- the current requestId is excluded;
- active partial, processing, responding, interrupted and failed turns are excluded by default.

Reuse the existing ConversationContext.render implementation and tests. Do not create a second competing context renderer. Add controller projection tests that prove the data originates from reducer state.

---

## 5. ASR integration contract

### 5.1 Preserve offline recognition

AndroidOnDeviceSpeechInput remains the only recognizer in this Android milestone. Keep:
- on-device SpeechRecognizer creation;
- EXTRA_PREFER_OFFLINE;
- on-device availability check;
- current language selection;
- current microphone permission flow;
- typed-input fallback.

No network recognizer fallback is allowed.

### 5.2 Callback mapping

| Android callback | Controller action |
|---|---|
| start succeeds / onReadyForSpeech | Capture lease remains active; no turn yet |
| onBeginningOfSpeech | Optional UI state only; do not create a turn without text |
| onPartialResults with nonblank draft | publishPartial(lease, draft) |
| onPartialResults with blank text | Ignore |
| onEndOfSpeech | UI says processing; do not finalize until final result |
| onResults with nonblank text | publishFinal(lease, result) |
| onResults with blank text | Fail/empty-recognition status; no successful turn |
| onError before a turn exists | Report status only |
| onError after a turn exists | fail the active user turn once |
| stopListening | Keep lease open for final callback |
| cancel/destroy | Invalidate lease before platform teardown |

### 5.3 Stop versus cancel

Use separate named operations and UI wiring:

- **Stop / Done speaking:** finalize capture. Call stopListening and wait for the recognizer's onResults/onError. The final result is accepted if it arrives for the active lease.
- **Close / Back / Type instead:** cancel capture. Invalidate generation first, cancel/destroy recognizer, reject any late final/partial, and return to the appropriate screen.
- **Microphone pressed during TTS:** stop playback first, then create a new capture generation. This is playback interruption, not cancellation of an existing task.
- **Explicit task Cancel control:** continues to use the existing task cancellation contract. Do not route it through turn.interrupted alone.

The current stopSpeechInput() helper must be split. Do not leave ambiguous stop behavior hidden behind one helper.

### 5.4 Test seam

The Activity must not require real audio in automated CI.

Extract a narrow speech-input interface/factory around the Android recognizer callbacks. Production uses AndroidOnDeviceSpeechInput; tests inject a fake that emits ready, partial, final, error and delayed stale callbacks. The seam must not introduce a network implementation or a test-only production backdoor.

Test the Android adapter's platform lifecycle separately from the pure controller. A fake adapter should be able to deliberately deliver a callback after cancel to prove generation fencing.

---

## 6. Typed input and local planner integration

### 6.1 One submission path

The typed composer and voice recognizer must both produce a FinalizedRequest from ConversationController.

MainActivity must stop independently:
- appending a user message to chatMessages;
- storing live ASR draft in voiceDraft as authoritative content;
- deriving planner context from chatMessages.

The typed input path should:
1. snapshot completed prior context from controller;
2. submit typed text through controller;
3. use the returned request ID and user turn ID through planning;
4. publish the validated outcome as the assistant turn;
5. leave screen navigation behavior unchanged except for reducer-derived content.

Voice should use the exact same planning function after its final transcript is accepted.

### 6.2 Existing local tool authority

Keep LocalPlanCoordinator unchanged in capability scope:
- android.device.status
- android.calendar.search

Keep its strict GBNF output shape and LocalPlanValidator.
Keep AndroidLocalToolExecutor execution-time permission checks.
Keep evidence validation and responder's verbatim-evidence behavior.
Conversation context remains advisory and may not introduce a tool or permission.

Do not implement additional tools, arbitrary function calling, a new agent catalogue or a remote PC task route as part of this three-day bridge.

### 6.3 Permission flow

Existing calendar permission behavior must remain correct.

The user request is created once. The controller retains the FinalizedRequest while the OS permission dialog is active. If permission is granted, the same logical request resumes with the same requestId and user turn. The app must not append a duplicate user turn or read a second copy of history. If denied, publish one explanatory assistant outcome and leave the task unexecuted.

Test permission granted, denied, and callback after Activity teardown. Do not persist permission-pending state to a new database in this phase.

### 6.4 No-model and unavailable-runtime paths

A missing GGUF, unavailable native inference library or unloaded model must remain an honest failure/notice:
- no fake assistant success;
- no task execution;
- no fabricated response evidence;
- user turn remains visible;
- assistant turn reports a truthful unavailable/failure result;
- user can continue typing or install a model.

---

## 7. Assistant output and response chunking

### 7.1 Validate before publication

LocalPlanCoordinator.respond currently returns one completed string after validating its evidence-selection response. Use that result as the only publishable assistant content.

Before emitting the first response.chunk:
- reject blank result;
- reject a response longer than MAX_TURN_CONTENT (4,000 UTF-16 code units);
- reject invalid/unexpected responder shape through existing validation;
- do not publish planner JSON, tool arguments, unvalidated output or partial responder JSON;
- preserve the exact accepted string.

If validation fails, publish turn.failed. Do not publish partial fragments from an invalid response.

### 7.2 Deterministic bounded chunker

Implement one pure Kotlin chunker, covered by unit tests.

Requirements:
- Every chunk is nonempty.
- Maximum chunk length is MAX_TRANSCRIPT_CHUNK (512 UTF-16 code units).
- Concatenating all chunks yields the exact original response string.
- No whitespace, newline, punctuation or code-point content is lost.
- A high/low surrogate pair is never split across chunks.
- Prefer a sentence or paragraph boundary within the maximum where practical.
- If no suitable boundary exists, cut at the last Unicode-safe boundary before the limit.
- Output is deterministic.
- No trimming or normalization is performed by the chunker.
- Empty or oversized response is rejected before any chunk is published.

This is logical chunking of a completed, validated response. It is not model-token streaming, and UI copy/documentation must not imply token-level live generation.

### 7.3 Assistant turn sequence

For a successful response:
1. Create a distinct assistant turn with source matching the user request and the same requestId.
2. Publish response.chunk events in deterministic order.
3. Publish exactly one response.completed event.
4. The reducer owns the concatenated assistant text and terminal completion status.
5. TTS playback can begin only from the already validated complete response; it has a separate playback lifecycle.

For a terminal failure:
1. Create or reuse the request's assistant outcome turn according to the frozen implementation contract.
2. Publish turn.failed with a bounded safe reason.
3. Do not publish a fake response.completed.

No external callback may publish more output after the assistant turn is terminal.

---

## 8. Offline TTS integration

### 8.1 Product decision for this milestone

Automatic speech is not part of this delivery. Keep the explicit Read Aloud button. The new implementation improves playback management and reports playback state, but does not automatically speak every answer.

### 8.2 TTS adapter

Retain offline-only voice selection:
- installed voice only;
- voice must report no network connection requirement;
- language must match the active locale according to existing behavior;
- no cloud fallback.

Add an utterance progress listener with bounded chunks:
- unique utterance ID per playback generation and chunk index;
- first queued utterance uses QUEUE_FLUSH;
- later utterances use QUEUE_ADD;
- onStart updates playback state;
- onDone advances to the next chunk;
- onError stops the remainder and reports a playback error;
- completion is emitted only when the active generation's last chunk is done;
- stop/close increments playback generation before platform stop/shutdown;
- stale onDone/onError callbacks are ignored.

Use the platform's supported utterance ID callback rather than timestamps as sole identity. Do not block the main thread waiting for playback completion.

### 8.3 Separate conversation from audio lifecycle

The assistant conversation turn completes when its validated text has been accepted and response.completed is reduced. TTS completion is separate playback state.

If the user stops audio after the text response is complete:
- stop TTS;
- mark playback stopped;
- keep the assistant text and completed turn intact;
- do not call turn.interrupted merely to indicate audio was stopped.

If output generation itself is still active and is explicitly interrupted, use the conversation interruption contract. Do not confuse already-completed text with still-playing audio.

### 8.4 TTS test seam

Tests must use a fake TTS engine or adapter:
- no audio network;
- no timing sleeps;
- deterministic onStart/onDone/onError callbacks;
- callback from prior generation after stop is ignored;
- playback error does not remove assistant response;
- unavailable TTS keeps text output usable.

---

## 9. UI projection migration

### 9.1 Single source of truth

After PR E:
- Chat message rows are derived from ConversationState.turns.
- Listening draft is derived from the active user voice turn when it is non-final.
- Assistant response is derived from the active/latest assistant turn.
- Active request state is derived from the controller/request handle and existing local execution state.
- Playback progress remains separate TTS UI state.
- Typed composer text remains local UI input state.

Remove chatMessages and voiceDraft as authoritative history/content stores. If a temporary compatibility projection is required during the migration PR, mark it derived and do not write independent messages into it.

### 9.2 Preserve current visual design

Do not redesign the app. Keep:
- existing orb-first visual hierarchy;
- current dark theme and typography;
- navigation and screen routing;
- Chat/Listening screen composition;
- model readiness notices;
- permission prompts;
- PC pairing dashboard and existing task screens.

Only rewire displayed transcript, conversation history, active turn status and playback indicators to controller-derived state.

### 9.3 Accessibility and UI test semantics

Add stable test tags or content descriptions for:
- active conversation turn;
- user turn transcript;
- assistant response;
- listening draft;
- listening/finalizing state;
- Read Aloud control;
- playback state (speaking, stopped, failed);
- cancellation affordance.

Do not make tests dependent on exact full transcript text when a semantic role or stable tag is more reliable.

### 9.4 Recomposition and list behavior

ConversationState is immutable. Avoid rebuilding the whole screen for every unrelated task-state update. Use stable turn IDs as keys. Keep the existing scroll policy: follow the bottom only when the reader is already at the live end; do not yank the reader away from older content when a partial updates.

The reducer's 200-turn cap remains authoritative. Do not introduce a second unbounded list in the Activity or composable.

---

## 10. Three-day execution schedule

## Day 1 — Saturday, 21 November 2026
**Goal:** PR B — controller, identity, ordering and deterministic controller tests. No ASR, TTS or UI integration changes.

### 09:00–10:00 — Baseline and contract freeze
- Fetch current main and confirm HEAD is the PR #70 merge or a fast-forward descendant.
- Check working tree/branch is clean before creating the implementation branch.
- Read ConversationReducer, generated models and ConversationCodec.
- Verify core module dependency direction.
- Confirm no existing controller or state holder has appeared since this plan.
- Freeze controller method contract and result/error types before coding.

**Exit:** a reviewed list of exact controller API signatures and no schema changes.

### 10:00–13:00 — Implement ConversationController
- Add controller to core:agent, not MainActivity.
- Add dependency on core:protocol if required.
- Expose StateFlow<ConversationState>.
- Add injectable IdProvider and Clock.
- Add capture lease / request / assistant handles.
- Implement one serialized event ingress.
- Add current-conversation and current-generation guards.
- Apply every state mutation with the existing Kotlin reducer.
- Ensure generated event codec validation occurs before reduction.
- Do not change recognizer, TTS or composables.

**Exit:** controller compiles with pure JVM dependencies; no Android imports.

### 13:00–15:30 — Request lifecycle and context projection
- Implement lazy user-turn creation on first nonblank partial/final, not at microphone open.
- Implement typed submission through the same user-turn path.
- Preserve same requestId across user and assistant turns.
- Keep distinct turnId values.
- Implement completed-turn context projection using the existing 6/240/1,200 limits.
- Exclude current request and unfinished/interrupted/failed turns.
- Add permission-retry handle semantics, or document the exact service-owned holder that will retain the handle through the OS permission callback.

**Exit:** deterministic lifecycle tests prove ID pairing and context exclusion.

### 15:30–18:00 — Controller test suite
Add tests:
- fixed lowercase UUID and timestamp injection;
- beginCapture creates no empty turn;
- first partial creates turn.received before transcript.partial;
- partial replaces previous draft;
- final without prior partial creates and finalizes once;
- duplicate final no-op;
- stale generation partial/final ignored;
- cancel invalidates before callback;
- submitTyped uses source=text and same lifecycle;
- user/assistant share requestId but have distinct turn IDs;
- planner context only contains completed older turns;
- current request excluded;
- 200-turn history cap respected;
- foreign conversation ignored;
- malformed UUID/oversized event rejected;
- interruption does not invoke any task cancellation API;
- concurrent event publication is serialized.

**Day 1 gate**
- PR B code compiles.
- Core agent/controller tests pass.
- Core protocol conformance tests remain green.
- No Android Activity/ASR/TTS/UI changes are included in PR B.
- Independent review finds no dependency-cycle or authority-boundary issue.

If PR B fails this gate, do not start Day 2 integration on an unstable controller contract.

---

## Day 2 — Sunday, 22 November 2026
**Goal:** PR C + PR D — connect ASR and typed input, then validated assistant response and opt-in offline playback.

### 09:00–12:00 — Voice input adapter (PR C)
- Add a capture lease to AndroidOnDeviceSpeechInput callback registration.
- Every partial/final/error callback carries its captured lease.
- Route nonblank partials into ConversationController.
- Route final transcript into the same controller request and then into the existing runAssistant/local planner workflow.
- Split finalize/stop from cancel/close.
- Invalidate generation before recognizer cancel/destroy.
- Ignore delayed callbacks after cancel/new generation.
- Preserve on-device recognition only; no network fallback.
- Preserve current blank-partial behavior.

**Exit:** fake adapter tests pass for partial, final, error, stop, cancel and stale callback.

### 12:00–14:00 — Typed input and one planner entry path
- Composer submit creates a finalized text request in ConversationController.
- Voice final calls the same submit-to-planner function.
- Remove chatMessages from planner context derivation.
- Derive context from completed reducer turns before the new request is added, or exclude the active request ID explicitly.
- Keep current LocalPlanCoordinator and its exact tool allow-list.
- Preserve permission and no-model behavior.
- Preserve the request handle across calendar permission grant/deny so retry does not duplicate a user turn.

**Exit:** typed and voice sources create the same event lifecycle with different source metadata.

### 14:00–16:00 — Validated response publication
- Create assistant turn linked to the same requestId.
- Publish only the final validated result from LocalPlanCoordinator.respond.
- Build pure response chunker with max 512 UTF-16 code units and surrogate-pair safety.
- Validate the full response against 4,000 code-unit contract limit before any response.chunk.
- Preserve exact concatenation.
- Emit response.completed exactly once.
- Publish turn.failed for inference, validation, unavailable model and terminal tool failures.
- Ensure delayed planner completion from superseded request cannot publish into a newer request.

**Exit:** chunker and assistant lifecycle tests pass; no native token-streaming claim.

### 16:00–18:30 — Offline TTS playback (PR D)
- Extend OfflineTtsController with utterance progress listener.
- Preserve offline-only voice filter.
- Add bounded sequential queue and unique utterance IDs.
- Add playback generation fencing.
- Keep playback opt-in through Read Aloud.
- Stop playback on new microphone activation, Activity close and explicit stop.
- Ensure TTS failure leaves completed assistant text intact.
- Keep TTS playback state separate from conversation turn completion.

**Exit:** fake TTS tests prove queue, start, done, error, stop and stale callback behavior.

### 18:30–19:00 — Day 2 regression gate
- Run protocol build/test and generation drift check.
- Run core agent tests and Android unit tests.
- Build debug APK.
- Fix any regression in current five navigation journeys.
- Keep PR C and PR D independently reviewable where possible; never combine generated models, JNI streaming or unrelated refactors.

**Day 2 gate**
- Voice and typed input both publish into controller.
- Partial/final semantics pass.
- Permission retry does not duplicate turns.
- Assistant output is fully validated before response events.
- TTS is optional/offline/opt-in.
- No task cancellation is triggered by conversation or playback stop.

---

## Day 3 — Monday, 23 November 2026
**Goal:** PR E — reducer-driven UI, end-to-end emulator proof, documentation and release decision.

### 09:00–12:00 — UI state migration
- Replace chatMessages authority with a projection of controller state.
- Replace voiceDraft authority with the active non-final user voice turn projection.
- Render assistant response from assistant turn state.
- Preserve message ordering and stable turn IDs.
- Preserve current scroll behavior and screen layout.
- Keep prompt text, model install state, device state, approval state, route and TTS playback as separate non-conversation state.
- Add stable Compose test tags/content descriptions.

**Exit:** no separate authoritative chat or draft content store remains.

### 12:00–14:30 — Fake ASR/TTS and integration journeys
Add deterministic tests using faked input/output adapters. Avoid relying on microphone audio or cloud providers in CI.

Required journeys:
1. Typed request → user turn → planner → assistant turn → completed state.
2. Voice capture → partial A → revised partial B → final C → exactly one user turn.
3. Final callback arrives without any partial → one correct user turn.
4. Stop/Done speaking waits for final callback and accepts it.
5. Close/Back/Type instead cancels capture and late final is ignored.
6. Typed follow-up uses completed prior context and excludes its own current text.
7. Voice follow-up uses the same context policy.
8. Assistant output chunks concatenate exactly to validated full response.
9. A chunk overflow/invalid response emits failure and never success.
10. Read Aloud uses offline TTS and playback progress is visible.
11. TTS error leaves assistant text in conversation.
12. New microphone activation stops old TTS and stale playback callbacks cannot affect new playback.
13. No model / unavailable inference does not claim execution success.
14. Calendar permission granted resumes the original request without duplicate user turn.
15. Calendar permission denied reports no tool execution.
16. Activity destruction cancels resources and rejects callbacks after teardown.

### 14:30–16:00 — Existing and new emulator suite
- Keep the five existing VanessaNavigationTest journeys.
- Add the new conversation journeys to Android instrumentation using test seams.
- Ensure test methods exercise actual composables/runtime wiring rather than only isolated helper objects.
- Report marker text, semantics tree, current turn IDs/status and failure reason on instrumentation failure.
- Make missing/empty result XML a hard failure.
- Make the report prove that new conversation tests executed, not only that the emulator job booted.
- Do not count a skipped or filtered conversation journey as passed.

**Exit:** emulator report shows all old and new test methods executed, with zero failures.

### 16:00–18:00 — Full CI and remediation
Required jobs:
- build-and-test
- debug-apk
- Android emulator user journeys
- windows-installer

Required local/module checks:
- protocol TypeScript tests;
- protocol generation and generated-artifact drift;
- Kotlin core:protocol tests;
- Kotlin core:agent tests;
- Android JVM unit tests;
- Android debug APK build;
- Android instrumented user journeys.

Do not merge on a red job. If a runner cannot boot an emulator, classify it as an infrastructure failure, retain evidence, and rerun on the new head only after correcting/retriggering the job through the normal repository process. Do not use empty commits solely to hide a failure or change the conclusion of a test.

### 18:00–19:00 — Documentation, review and release decision
Update:
- CONVERSATION_RUNTIME.md — actual implementation map and remaining gaps.
- END_TO_END_ACCEPTANCE.md — emulator evidence and new journey outcomes.
- engineering README index — links to current specifications.
- implementation PR descriptions — exact tests executed and limitations.

Independent reviewer checks:
- event ordering and IDs;
- generation fencing;
- stop vs cancel behavior;
- reducer as sole content authority;
- planner context bounds and source;
- validated response before chunks;
- TTS queue and stale callback behavior;
- no task cancellation coupling;
- test report demonstrates execution.

**Day 3 release gate**
All required CI jobs green on the final PR head; all new emulator journeys executed; review blockers resolved; documentation matches the implementation. If a critical test is red, the bridge is not complete on the target date. Do not claim otherwise.

---

## 11. Pull request structure

### PR B — Android ConversationController

**Scope:** controller and pure controller tests only.

Allowed:
- core:agent ConversationController and supporting pure types;
- core:agent build dependency on core:protocol, if required;
- ConversationControllerSpec and focused test fixtures;
- minimal docs describing the controller API once implemented.

Forbidden:
- MainActivity;
- AndroidOnDeviceSpeechInput;
- OfflineTtsController;
- Compose screen changes;
- JNI/native code;
- planner capability expansion;
- protocol schema changes unless a real contract defect is discovered and separately reviewed.

Acceptance:
- StateFlow-backed state;
- injectible IDs and clock;
- serialized validated event ingress;
- request/user/assistant ID pairing;
- capture generation fencing;
- completed prior context projection;
- all controller tests passing.

### PR C — ASR and typed-input integration

**Scope:** Android speech and composer adapters into the existing controller.

Allowed:
- speech input interface/factory seam;
- AndroidOnDeviceSpeechInput callback correlation;
- MainActivity wiring to controller;
- typed composer submission;
- permission-pending request handle;
- focused unit/instrumented tests.

Forbidden:
- TTS queue implementation;
- UI visual redesign;
- model/JNI streaming;
- task state machine changes;
- new network speech provider.

Acceptance:
- real ASR callbacks enter the reducer;
- partials update the same turn;
- final accepted once;
- cancel rejects late callbacks;
- typed input shares event path;
- context comes from controller state.

### PR D — Assistant response and offline playback

**Scope:** complete validated response publication, bounded chunker and playback callbacks.

Allowed:
- pure response chunker;
- ConversationController assistant response methods;
- OfflineTtsController listener/queue changes;
- playback state projection model;
- deterministic fake TTS tests.

Forbidden:
- automatic speech;
- token-level streaming;
- remote TTS;
- changes to planner tools or task authority.

Acceptance:
- validate complete string before first chunk;
- exact concatenation and Unicode safety;
- completion once;
- TTS queue and playback generation tested;
- text remains if playback fails.

### PR E — UI projection and system proof

**Scope:** reducer-driven conversation surfaces and instrumented acceptance.

Allowed:
- MainActivity conversation state projection;
- VanessaAssistantScreens projection inputs;
- removal of duplicate chat/draft authority;
- Compose semantics/test tags;
- fake ASR/TTS integration harness;
- new Android instrumented tests;
- docs and evidence.

Forbidden:
- architectural additions outside the approved scope;
- memory or durable session implementation;
- remote-PC route rewrite;
- visual redesign.

Acceptance:
- old five navigation journeys remain green;
- new conversation journeys execute;
- all four jobs green;
- documentation updated honestly;
- independent review complete.

---

## 12. Data and state contracts

### 12.1 Conversation event usage

Do not alter the PR #70 schema for convenience. Use these existing event forms:

- TurnReceivedEvent
- TranscriptPartialEvent
- TranscriptFinalEvent
- ResponseChunkEvent
- ResponseCompletedEvent
- TurnInterruptedEvent
- TurnFailedEvent

Every generated event must carry the same conversation ID and the intended turn ID. TurnReceivedEvent requires its UUID request ID, role, source and timestamp. Use ConversationCodec at the trust boundary.

### 12.2 User and assistant turn pairing

For a user command:
- requestId = one new UUID;
- userTurnId = another new UUID;
- source = voice or text;
- role = USER.

For its assistant outcome:
- requestId = exactly the user's requestId;
- assistantTurnId = a new distinct UUID;
- source = same source modality;
- role = ASSISTANT.

Do not reuse turn IDs. Do not place request IDs in turnId fields. Do not infer user/assistant roles from the current UI screen.

### 12.3 State transitions

User voice turn:
- absent → received (first nonblank partial/final)
- received → transcript.partial (one or more replacements)
- received/processing → completed on transcript.final
- received/processing → failed on terminal ASR failure
- received/processing → interrupted on explicit capture cancellation after a turn exists

Typed user turn:
- absent → received → completed

Assistant turn:
- absent → received
- received/processing/responding → responding via response.chunk
- processing/responding → completed via response.completed
- nonterminal → failed via turn.failed
- nonterminal → interrupted only if response generation itself is actually interrupted

TTS playback state is independent:
- idle → queued → speaking → completed
- speaking/queued → stopped
- speaking/queued → failed

Do not represent TTS playback as assistant response generation. The assistant message can be completed while the user listens to its audio.

### 12.4 Error semantics

- Malformed event: reject before reduction; do not crash Activity.
- Wrong conversation: reducer no-op.
- Unknown turn: reducer no-op.
- Duplicate final: controller no-op.
- Late partial after final: no-op.
- Old capture callback: generation fence no-op.
- Invalid/overlong assistant response: fail before emitting any chunks.
- TTS failure: playback error; preserve response text and assistant completion.
- Inference unavailable: user-visible failure, no success claim.
- Permission denied: user-visible result, no tool invocation.
- Explicit task cancellation: existing task cancellation path only.

Error details shown in UI must be safe, bounded and not expose stack traces or provider secrets.

---

## 13. Testing strategy

### 13.1 PR B unit tests

Controller tests are pure JVM tests with injected ID/clock sources. No Android emulator or microphone is needed.

| Test | Assertion |
|---|---|
| New capture | No empty user turn |
| First partial | Creates received then partial |
| Partial revision | Replaces text |
| Final without partial | Creates and completes one user turn |
| Duplicate final | No state change |
| Old generation partial | Ignored |
| Old generation final | Ignored |
| Cancel before callback | Callback rejected |
| Typed submit | One text user turn |
| Pairing | Same request ID, different turn IDs |
| Context | Completed prior turns only |
| Active turn exclusion | Current request absent from context |
| Context limits | Six turns, 240 each, 1,200 total |
| Cross conversation | No change |
| Event overflow | Rejected, no success |
| Parallel publication | Stable serialized state |
| Interruption boundary | No task-cancel API call |

### 13.2 PR C tests

- fake speech input can emit every callback;
- partial/final callbacks carry the correct capture lease;
- partial-before-turn is prevented by controller creating TurnReceived first;
- multiple partial revisions produce one turn;
- final arrives once;
- no partial still supports a final-only recognizer response;
- blank drafts ignored;
- blank final does not create completed turn;
- stopListening allows final callback;
- cancel invalidates callback generation first;
- old listener after new capture cannot mutate state;
- permission grant resumes same request handle;
- permission denied does not invoke calendar tool;
- typed input uses the same controller and context source;
- Activity teardown stops/destroys recognizer and fences callbacks.

### 13.3 PR D tests

Chunker:
- empty input rejected;
- over 4,000 UTF-16 units rejected before first chunk;
- every chunk <=512 units;
- concatenation equals original;
- surrogate pairs remain intact;
- punctuation and whitespace preserved;
- newlines and long unbroken tokens preserved;
- repeated input yields deterministic chunks;
- Indic, CJK and supplementary Unicode cases covered.

Assistant:
- response uses distinct assistant turn ID;
- assistant shares user request ID;
- first chunk replaces the initial assistant text per reducer;
- later chunks append;
- completed emitted once;
- late chunk after completion is ignored;
- output error becomes failed, not completed.

TTS:
- offline voice filter unchanged;
- queue first item flushes, later items append;
- callbacks ordered;
- one error stops the remainder;
- stop fences old generation;
- close fences old callbacks;
- stale done from playback N cannot complete playback N+1;
- TTS unavailable leaves text;
- TTS completion does not change the completed conversation turn.

### 13.4 PR E emulator journeys

The five existing instrumented journeys remain in place. Add journeys that prove integrated state and event behavior.

Minimum additional journeys:
1. typed request creates one user turn and an assistant outcome;
2. voice partial is displayed from reducer state and revisions update the same turn;
3. final transcript is accepted once and produces one user turn;
4. typed follow-up context is derived from previous completed reducer turns;
5. voice cancel/back/close rejects a delayed final callback;
6. response text is visible after validation and status completes once;
7. Read Aloud starts offline playback and displays playback state;
8. playback stop does not cancel a task or erase assistant text;
9. no model path does not claim execution;
10. calendar permission callback does not duplicate the request.

Use fake ASR/TTS sources. Do not make CI depend on the hosted network, a real microphone, external speech credentials, or an installed user model.

For each journey assert:
- visible screen marker;
- user/assistant turn count;
- expected role, source and status;
- expected request/turn correlation;
- no duplicate turn;
- no stale callback effect;
- relevant playback state;
- task state remains independent.

### 13.5 Mutation / fault-injection cases

Where practical add a small targeted set of mutation or fault-injection tests:
- remove the generation check;
- finalize twice;
- publish partial after final;
- assign a new requestId to assistant instead of user requestId;
- include active partial in planner context;
- publish response chunk before full-response validation;
- split a surrogate pair;
- emit completion after an output error;
- let stale TTS onDone complete new playback;
- call task cancellation on conversation interruption;
- do not invalidate capture before recognizer cancel;
- preserve chatMessages as an independent write path.

The targeted test must fail for each introduced defect. Do not weaken an existing conformance fixture to make implementation pass.

---

## 14. Required CI and local verification

The final PR head must pass all current required jobs:
- build-and-test
- debug-apk
- Android emulator user journeys
- windows-installer

Run the module checks using the exact repository scripts and Gradle wrapper:
- pnpm --filter @vanessa/protocol build
- pnpm --filter @vanessa/protocol test
- pnpm --filter @vanessa/protocol lint
- apps/android: ./gradlew :core:protocol:test
- apps/android: ./gradlew :core:agent:test
- apps/android: ./gradlew testDebugUnitTest
- apps/android: ./gradlew assembleDebug
- apps/android: ./gradlew connectedDebugAndroidTest

Use the root scripts if they are the repository's canonical entry points. Do not invent or assume a script exists. Inspect package.json, Makefile, Gradle tasks and workflows before running commands.

A successful debug APK is not proof of instrumented behavior. The emulator job must:
- boot an emulator;
- execute the new instrumented tests;
- produce at least one result XML;
- prove the expected test methods executed;
- fail when the report is missing or empty.

Do not change job conditions to skip the emulator journey while keeping a green status. Do not mask Gradle exit codes with tail, 