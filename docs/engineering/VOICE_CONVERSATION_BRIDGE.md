# Voice → Conversation Bridge — Engineering Plan and Implementation Specification

> **Design snapshot:** This proposal describes the baseline at PR #69 and its
> planned follow-on work. Its status and unchecked lists record the plan as
> authored, not a live implementation report. See [CONVERSATION_RUNTIME.md](CONVERSATION_RUNTIME.md)
> for current code, verification, and outstanding gaps.

- **Repository:** `Kshitij-Tripathi87/Project_Vanessa`
- **Target branch baseline:** `main` at merge commit `103965030139a12d6ec391874e9a64d90014a515` (PR #69)
- **PR #69:** merged; branch `arena/3eba4dee-project-vanessa` is no longer the implementation base
- **Phase:** Voice–Conversation Bridge v0.1
- **Status:** Design proposal; implementation not started
- **Primary platform:** Android app, on-device speech recognition, local inference, offline TTS
- **Primary owners:** Conversation runtime, Android voice, Android protocol, Android app integration
**Non-goal:** Rebuild the voice engine, replace the planner, or introduce cloud speech services

---

## 0. Executive decision

The next phase connects the existing Android voice input, the conversation event contract, the conversation reducer, local planning, assistant output, and offline speech playback into one coherent turn lifecycle.

The current product has useful but disconnected pieces:

- `packages/protocol/src/conversation.ts` defines the conversation session, turn, event schemas, and a pure TypeScript reducer.
- `AndroidOnDeviceSpeechInput` already asks Android for partial recognition results and exposes an `onPartial` callback.
- `MainActivity` currently stores the partial in a separate `voiceDraft` field, then submits only the final transcript to `runAssistant`.
- `MainActivity` stores the chat history separately in `chatMessages`; it does not use `ConversationState` as the conversation source of truth.
- `LocalPlanCoordinator` receives recent turns, but its responder returns one fully validated string.
- `LlamaCppInference.generateResult()` returns one completed `GenerationResult`; the native JNI call does not expose token deltas.
- `OfflineTtsController.speak()` accepts one bounded string and calls `TextToSpeech.speak()` once. It has no utterance progress callback or chunk queue.
- `services/voice-agent/src/session/voiceSession.ts` has a separate desktop voice lifecycle and partial/final callbacks, but it is not connected to the new conversation event contract.

The bridge should make the **conversation reducer the Android conversation state authority**. Voice recognition, typed input, local planning, response publication, and speech playback become adapters that publish events into that runtime. The UI renders projections of the reducer state; it must not create turns or maintain a second transcript history.

### 0.1 Release objective

Deliver one trustworthy Android flow:

`capture → turn.received → transcript.partial* → transcript.final → plan/execute → assistant turn → response.chunk* → response.completed`

The user can see their transcript evolve while speaking, see the final transcript in chat, receive the assistant result as a single coherent turn, and hear it through the existing offline TTS path when speech output is enabled. Typed requests use the same conversation lifecycle.

### 0.2 Important streaming truth

The first bridge release must **not claim token-level model streaming**. The current llama.cpp interface buffers the full output in native code, and the planner/responder applies validation after generation. The first release will:

1. Publish genuine incremental ASR partials as they arrive from `SpeechRecognizer`.
2. Publish the user final transcript exactly once.
3. Publish assistant response text only after `LocalPlanCoordinator` has completed and validated the response.
4. Split the validated response into bounded, ordered output chunks for the conversation reducer and optional sentence-queued TTS playback.
5. Use TTS utterance callbacks for playback lifecycle, not to pretend that native model tokens are streaming.

True model-token streaming is a separate future capability requiring native JNI changes, incremental UTF-8 decoding, cancellation fencing, and explicit rules for buffering untrusted planner/responder output until it is validated. It is not required to close this bridge gap.

### 0.3 Non-negotiable invariants

- The conversation reducer is the only authority for Android conversation turns and transcript text.
- A turn is created only through `turn.received`.
- Every non-creation event refers to an already received turn in the same conversation.
- Partial transcript events replace the current draft; they are not deltas.
- A final transcript is authoritative; later partials cannot overwrite it.
- Assistant response chunks are deltas and are appended by the reducer after the first chunk replaces the initial response text.
- User and assistant turns share one UUID `requestId`, but have different UUID `turnId` values.
- The `requestId` in the conversation contract is a lowercase UUID. Do not reuse arbitrary strings such as `voice-<hash>` as the protocol `requestId`.
- Interruption of a conversation turn is not cancellation of a task owned by the task/runtime layer.
- Late ASR/TTS callbacks from a stopped or superseded capture/playback generation must not modify conversation state.
- UI state is derived from `ConversationState`; no independent `voiceDraft` or duplicate message list remains authoritative.
- The local planner continues to receive only bounded, completed prior turns. It must not receive the current incomplete partial as conversation history.
- Planner JSON, tool arguments, and unvalidated responder JSON must never be published as assistant response chunks.
- Offline TTS must continue to use only a voice that explicitly reports no network requirement.
- Existing permission, model-readiness, tool-validation, and task-approval gates remain unchanged.
- No new remote service, cloud ASR, cloud TTS, or background ambient capture is introduced.

---

## 1. Verified baseline and current implementation map

This section records what was inspected on the PR #69 merge commit. Revalidate line-level details before changing files, but do not rediscover the architecture from scratch.

### 1.1 PR #69 merge

PR #69 is closed and merged. Its merge commit is `103965030139a12d6ec391874e9a64d90014a515`. The merged change introduced:

- `packages/protocol/src/conversation.ts` — strict Zod conversation schemas, seven event types, bounded reducer state, and event-folding functions.
- `packages/protocol/src/conversation.test.ts` — 20 reducer tests.
- `apps/android/core/agent/src/test/kotlin/ai/vanessa/agent/ConversationContextSpec.kt` — 10 Kotlin tests for bounded recent-turn context.
- `AndroidOnDeviceSpeechInput.onPartial` and live draft display on the Listening surface.
- `docs/engineering/CONVERSATION_RUNTIME.md` — current implementation and gaps.
- `docs/engineering/README.md` — engineering document index.

The PR's own description explicitly says that voice-to-conversation, streamed TTS, Android barge-in, durable conversation storage, and other runtime components remain incomplete. This plan treats them as open work.

### 1.2 Existing conversation contract

File: `packages/protocol/src/conversation.ts`

Current constants:

| Constant | Value | Meaning |
|---|---:|---|
| `CONVERSATION_PROTOCOL_VERSION` | 1 | Independent conversation contract version |
| `MAX_TURN_CONTENT` | 4,000 | Maximum final transcript / full response characters |
| `MAX_TRANSCRIPT_CHUNK` | 512 | Maximum partial or response chunk characters |
| `MAX_CONVERSATION_TURNS` | 200 | Retained turns in the reducer |

Current event union:

- `turn.received`
- `transcript.partial`
- `transcript.final`
- `response.chunk`
- `response.completed`
- `turn.interrupted`
- `turn.failed`

Each event includes `conversationId` and `turnId`. `turn.received` additionally requires a UUID `requestId`, role, source, and `createdAt`.

Current reducer guarantees:

- Unknown conversation events are ignored.
- Unknown turn events are ignored.
- A turn is created only by `turn.received`.
- Duplicate turn creation and duplicate final/completion delivery are no-ops.
- Partials replace the draft text.
- Partials arriving after a final transcript are ignored.
- A user turn becomes terminal when its final transcript is accepted.
- An assistant turn can receive a final text body, remain processing, and accept output chunks.
- The first response chunk replaces current text; later chunks append.
- Interruption and failure are terminal.
- Terminal turns ignore later chunks.
- Conversation history is bounded.

Do not weaken these rules. If this phase discovers a contract defect, add a focused amendment to the shared TypeScript contract, its schema, fixtures, Kotlin mirror, and tests before wiring the UI.

### 1.3 Android speech input

File: `apps/android/app/src/main/java/com/vanessa/mobile/voice/AndroidOnDeviceSpeechInput.kt`

Current behavior:

- Uses `SpeechRecognizer.createOnDeviceSpeechRecognizer()` only.
- Requires Android S / API 31 or later and on-device recognition availability.
- Requests `EXTRA_PARTIAL_RESULTS=true` and `EXTRA_PREFER_OFFLINE=true`.
- Exposes `onTranscript(String)`, `onState(String)`, and `onPartial(String)` callbacks.
- Emits nonblank partial text as a complete revised draft.
- Calls `onTranscript` on final result.
- Destroys recognizer after final result or error.

Current gap: the recognizer callback is not assigned to a conversation turn ID and does not publish typed conversation events. `MainActivity` receives the draft into `voiceDraft`.

### 1.4 Android activity and view state

File: `apps/android/app/src/main/java/com/vanessa/mobile/ui/MainActivity.kt`

Current relevant state:

- `chatMessages: List<VanessaChatMessage>`
- `voiceDraft: String`
- `assistantResponse: String`
- `assistantBusy: Boolean`
- `voiceListening: Boolean`
- `speechInputStatus: String`
- `speechReady: Boolean`

Current flow:

- `AndroidOnDeviceSpeechInput.onPartial` updates `voiceDraft` directly.
- Final transcript clears `voiceDraft`, returns to HOME, and calls `runAssistant(transcript)`.
- Typed composer input also calls `runAssistant`.
- `runAssistant` snapshots previous chat history into `ConversationTurn` before appending the current user message.
- It runs `LocalPlanCoordinator.run(task, conversationContext)`, then `coordinator.respond(task, outcome.results)` and appends a complete assistant message.
- Failure and permission messages are also appended as ordinary chat messages.
- `speakAssistantResponse()` passes the full assistant response to offline TTS.

Current gap: chat messages and live voice drafts are separate state systems. The TypeScript `ConversationState` reducer is not used by Android.

### 1.5 Android UI

Files:

- `apps/android/app/src/main/java/com/vanessa/mobile/ui/VanessaAssistantScreens.kt`
- `apps/android/app/src/main/java/com/vanessa/mobile/ui/MainActivity.kt`

`ListeningScreen` already renders the `draft` supplied by MainActivity. `ChatScreen` renders `VanessaChatMessage` items. Preserve the current visual composition and screen routes. This phase changes the state source and event wiring; it is not a visual redesign.

### 1.6 Local planner and inference

Files:

- `apps/android/core/agent/src/main/kotlin/ai/vanessa/agent/LocalPlanCoordinator.kt`
- `apps/android/app/src/main/java/com/vanessa/mobile/inference/LlamaCppInference.kt`
- `apps/android/app/src/main/cpp/inference.cpp`

The coordinator:

- Accepts `context: List<ConversationTurn>`.
- Renders up to six recent turns, up to 240 characters each, with a 1,200-character total bound.
- Uses context only as advisory planner context.
- Validates the generated plan against a strict allow-list before tool execution.
- Produces a response by selecting exact quotes from validated tool evidence; invalid output falls back to deterministic evidence summary.
- Does not pass conversation history into the responder.

The inference adapter exposes `generate()` / `generateResult()` as complete strings. Native C++ generation accumulates output into a `std::string`, then returns it as a single JNI `NativeGeneration`. There is no token callback, chunk callback, or streaming Kotlin API today.

Do not publish raw planner output or responder JSON to conversation events. Only publish the final validated response string or deterministic fallback.

### 1.7 Offline TTS

File: `apps/android/app/src/main/java/com/vanessa/mobile/voice/OfflineTtsController.kt`

Current behavior:

- Selects an installed TTS voice with `isNetworkConnectionRequired == false` and matching language.
- Speaks one bounded string with `QUEUE_FLUSH`.
- Does not expose `UtteranceProgressListener` events.
- Does not expose chunk-level start/done/error callbacks.

Current gap: playback progress is not connected to the conversation turn. The current `speak()` return value only tells the caller whether the request was accepted by the Android TTS API, not whether speech completed.

### 1.8 Shared Android protocol project

Files:

- `apps/android/core/protocol/build.gradle.kts`
- `packages/protocol/scripts/generate-kotlin-models.mjs`
- `packages/protocol/scripts/generate-json-schema.mjs`
- `packages/protocol/schema/protocol-v1.schema.json`

The Android app already depends on `:core:protocol`. The current Kotlin generator generates protocol-v1 wire models from a JSON Schema. The conversation Zod schema is currently not exported as a dedicated JSON Schema and the Android project does not have generated conversation event classes or a Kotlin conversation reducer.

The bridge must close that cross-language gap. Do not add a separately hand-maintained, untested Kotlin schema that can silently drift from TypeScript.

---

## 2. Scope and exclusions

### 2.1 In scope

1. Export the conversation event contract as a standalone JSON Schema from the TypeScript Zod schemas.
2. Generate strict Kotlin event models into the existing Android `core:protocol` module.
3. Implement a pure Kotlin reducer with the same invariants as the TypeScript reducer.
4. Create an Android `ConversationController` / runtime that owns `ConversationState` and accepts typed events.
5. Route Android ASR callbacks into `turn.received`, `transcript.partial`, `transcript.final`, `turn.failed`, and `turn.interrupted` events.
6. Route typed chat submissions through the same user-turn events.
7. Route final, validated local assistant output into assistant turns and response chunk events.
8. Add bounded response chunking and optional sequential offline TTS playback with lifecycle callbacks.
9. Connect Android barge-in / stop / cancel paths to conversation interruption without cancelling task execution by accident.
10. Derive Chat and Listening UI data from conversation state.
11. Derive planner context from recent completed conversation turns, keeping the current user turn out of historical context.
12. Add contract parity, reducer, adapter, UI, instrumentation, and CI tests.
13. Update `CONVERSATION_RUNTIME.md`, `docs/engineering/README.md`, and relevant test/acceptance docs to report actual implementation status.

### 2.2 Out of scope

- Conversation persistence across process death or reinstall.
- Cloud synchronization of conversation sessions.
- Desktop `VanessaVoiceSession` integration in the first Android bridge PR.
- Web/desktop UI conversation migration.
- Memory Palace retrieval or summarization of older turns.
- Agent registry changes or new tools.
- Task handoff protocol events.
- Model provider routing or remote inference.
- Native llama.cpp token-level streaming.
- Predictive turn detection, always-on wake-word capture, or ambient listening changes.
- Cloud speech recognition or cloud TTS.
- Replacing the Android local planner or changing its tool allow-list.
- Replacing the offline TTS provider.
- A new chat UI or conversation visual redesign.
- A new persistence database (Room/SQLite) for conversation turns.

### 2.3 First release boundary

Android is the first surface to integrate because PR #69 introduced the live partial UI but the actual Android path still stores it outside the conversation reducer. Keep the event contract platform-neutral so the desktop voice session can adopt it later, but do not expand the implementation to desktop during the same change unless the lead explicitly creates a second workstream with separate tests.

---

## 3. Target architecture

### 3.1 Logical architecture

```text
                 ANDROID APP SURFACE
   ChatScreen / ListeningScreen / task/permission screens
                          |
                          | state projection only
                          v
              ConversationController
          (one event ingress + reducer owner)
                          |
                          v
             Kotlin ConversationReducer
            (pure, bounded, deterministic)
                          ^
                          |
                    event publisher
                          |
   +----------------------+-----------------------+
   |                      |                       |
   v                      v                       v
ASR adapter          Text composer          Assistant runtime
   |                      |                       |
   |                      |                       +-- LocalPlanCoordinator
   |                      |                       +-- validated response
   |                      |                       +-- ResponseChunker
   |                      |                       +-- Offline TTS adapter
   |                      |                       |
   +-- partial/final -----+-- received/final -----+-- received/chunk/completed
```

### 3.2 Ownership table

| Component | Owns | Must not own |
|---|---|---|
| Speech input adapter | Android `SpeechRecognizer`, capture generation, raw partial/final callbacks | Conversation state, planner context, task decisions |
| Conversation controller | Conversation ID, request/turn IDs, event ordering, reducer state, publication methods | ASR internals, tool execution, inference, database persistence |
| Kotlin conversation reducer | Pure event-to-state transition | Android APIs, Compose, network, SQL, model calls |
| MainActivity / ViewModel | Compose-observable projection and UI orchestration | Duplicate authoritative transcript/message collections |
| LocalPlanCoordinator | Plan validation, permitted tool execution, verified evidence response | UI state, speech recognition, conversation event identity |
| Response chunker | Splits already validated assistant text into bounded ordered text chunks | Generating, validating, or rewriting claims |
| Offline TTS adapter | Offline voice selection, queued utterance playback, progress callbacks | Conversation turn creation, model/inference, task cancellation |
| UI | Render conversation state and invoke explicit actions | Creating turns by mutating state directly |
| Task/approval runtime | Existing task identity, cancellation, approval, execution lifecycle | Conversation transcript lifecycle |

### 3.3 Dependency direction

- `core:protocol` defines generated conversation event models and pure Kotlin reducer.
- Android `app` depends on `core:protocol`.
- Android voice adapters depend only on callback contracts; they do not import Compose or planner modules.
- `ConversationController` depends on `core:protocol` and Android lifecycle/runtime primitives only at the outer adapter boundary.
- `MainActivity` calls the controller and observes state.
- `LocalPlanCoordinator` remains a pure coordinator over its existing contracts and does not import Android UI or protocol reducer classes.
- TTS emits playback callbacks to its caller; the caller decides which conversation events to publish.

No circular dependency between `core:agent`, `core:protocol`, and `app` is permitted.

---

## 4. Conversation identity and lifecycle

### 4.1 Conversation ID

- Create a lowercase UUID conversation ID when the in-memory conversation runtime is created.
- The ID is stable for the lifetime of that runtime instance.
- Use `UUID.randomUUID().toString().lowercase(Locale.ROOT)`.
- Do not use the human-readable device label or Android ID as a conversation UUID.
- Durable conversation/session storage is explicitly deferred. Do not describe this release as process-restorable or cross-device synchronized.

### 4.2 Request and turn IDs

Each user interaction has:

- one `requestId` UUID shared by the user turn and the assistant turn;
- one `userTurnId` UUID;
- one `assistantTurnId` UUID after the app accepts the request for processing.

A turn ID is not a request ID. A task ID is not a request ID. Do not derive protocol UUID fields from arbitrary formatted strings.

The Android runtime must validate IDs at the controller boundary. IDs are lowercase canonical UUIDs.

### 4.3 Source

`source` is the input modality for the request:

- typed composer submit → `text`;
- on-device ASR submit → `voice`.

Use the same source on the associated assistant turn so the pair retains the originating modality.

### 4.4 Start of a voice turn

Do not create a turn merely because the listening screen opens or the microphone permission is requested. A listening surface can open without speech.

Create the voice turn on the first confirmed speech-start callback (`onBeginningOfSpeech`). The event sequence is:

1. Generate request ID and user turn ID.
2. Publish `turn.received` for role `user`, source `voice`.
3. On each nonblank partial callback, publish `transcript.partial` for that turn.
4. If the recognizer never emits `onBeginningOfSpeech` but does emit a nonblank partial, create the turn immediately before publishing the partial.
5. If final results arrive without a prior partial, create the turn immediately before publishing `transcript.final`.
6. If an error occurs before any turn was created, update the listening status only; do not manufacture an empty turn.
7. If an error occurs after a turn was created, publish `turn.failed` with a bounded user-safe reason.

This preserves the reducer invariant that only `turn.received` creates turn state.

### 4.5 Start of a typed turn

On composer submit:

1. Trim and validate the submitted text.
2. Generate `requestId` and `userTurnId`.
3. Publish `turn.received` role `user`, source `text`.
4. Publish `transcript.final` with the exact accepted text.
5. Only after publishing the user turn, start the assistant processing path.

Blank submissions create no turn. Over-limit submissions are rejected in the composer/controller with a clear UI validation message; do not silently truncate.

### 4.6 Assistant turn

When a request is accepted for local planning:

1. Capture planner context from prior completed turns only, excluding the current user turn.
2. Generate `assistantTurnId`, retaining the same `requestId` and source as the user turn.
3. Publish `turn.received` role `assistant`.
4. Run the existing local planner and tool execution unchanged.
5. On successful evidence selection/fallback, publish validated assistant response output.
6. On an execution failure that currently returns a user-facing message, publish a response with a safe user-facing summary and complete the turn unless the existing outcome requires an explicit failed task state.
7. On an actual unrecoverable runtime exception, publish `turn.failed` with a bounded, sanitized reason.

The conversation assistant turn is not a replacement for the remote task state machine. If a future request hands off to an external PC task, task identity and lifecycle remain in their existing protocol; a separate `task.handoff` event proposal is deferred.

### 4.7 Evaluation of current failure paths

Preserve current behavior but represent each path consistently:

| Current path | Conversation behavior |
|---|---|
| No local model installed | User turn completes; assistant publishes a clear response and completes. No task is claimed to have run. |
| Model is loading | User turn is accepted only if current UI already permits submit; otherwise composer remains disabled. If accepted and rejected by runtime, assistant publishes the current safe explanation. |
| Permission required | Assistant turn remains processing only while Android permission prompt is pending. On granted/denied callback, publish a response and complete the turn. Do not create a second user turn for permission result. |
| Planner validation failure | Publish the existing safe failure text as assistant response; do not publish raw model plan. |
| Tool unavailable | Publish the existing user-safe error/fallback text; do not fabricate evidence. |
| Coordinator exception | Publish bounded sanitized assistant failure or `turn.failed`, according to whether a reliable response exists. |
| Activity destroyed | Stop recognizer/TTS and fence callbacks. In-memory conversation state is discarded under current non-persistent semantics. |

---

## 5. Event publication contract

### 5.1 User input event mapping

| Source callback/action | Event | Notes |
|---|---|---|
| Confirmed speech start | `turn.received` | Role `user`, source `voice`; create once |
| First nonblank partial | `transcript.partial` | Create turn first if recognizer skipped speech-start callback |
| Subsequent partial | `transcript.partial` | Full current draft; replaces prior draft |
| Final transcript | `transcript.final` | Authoritative text; publish exactly once |
| Empty final result | No final event | Show no-speech status; if a turn exists, fail or interrupt it using the approved rule below |
| Recognition error after turn start | `turn.failed` | Safe bounded reason; no raw stack trace |
| Stop/commit capture | Final callback path | `stopListening()` allows the recognizer to return final results |
| Cancel/close/back/type-instead | `turn.interrupted` reason `user_cancel` | Must use `cancel()` / destroy, not merely `stopListening()` |
| Typed composer submit | `turn.received` + `transcript.final` | Same controller path as voice |

### 5.2 Assistant response event mapping

For an assistant response that is ready as a single validated string:

1. Validate nonblank and `<= MAX_TURN_CONTENT`.
2. Split into ordered output chunks, each `<= MAX_TRANSCRIPT_CHUNK`.
3. Publish one `response.chunk` per chunk in exact order.
4. Publish `response.completed` after the last chunk.

The reducer contract defines the first response chunk as replacement and subsequent chunks as append. Do not publish a separate assistant `transcript.final` followed by `response.chunk` unless a deliberate reducer change is made; that combination can make the first chunk replace the already rendered full answer. The first release uses chunks as the sole assistant body publication path.

If a response cannot be chunked because the text is empty or exceeds the full turn bound, handle it as a response validation error; do not truncate silently.

### 5.3 Response chunk semantics

- A response chunk is a piece of the final validated user-facing response, not a raw llama token.
- Concatenating all response chunks must reproduce the exact validated response string byte-for-byte after UTF-8 encoding.
- The chunker cannot rewrite punctuation, whitespace, numbers, identifiers, or evidence quotes.
- Each chunk must fit the 512-character schema bound.
- A chunk sequence must never be published after `response.completed`, `turn.interrupted`, or `turn.failed`.
- A playback callback is not itself sufficient authority to mutate text; the conversation controller must still validate the active turn and publication generation.

### 5.4 Ordering and deduplication

The event schema currently has no event sequence number. The Android bridge must therefore guarantee ordering at its adapter boundary:

- Each recognizer instance receives a monotonically increasing local capture generation.
- Each assistant playback/response publisher receives a monotonically increasing generation.
- Callbacks capture the generation at creation and are ignored when it no longer matches the controller's active generation.
- All reducer events are serialized through one main-thread ingress (or a single actor/channel that preserves FIFO ordering).
- Do not post reducer mutations from independent background callbacks without a shared ordered queue.
- Repeated final callbacks for the same capture must be idempotently ignored.
- If transport or persistence is added later, add explicit `eventId` / sequence semantics in a versioned contract amendment before relying on out-of-order delivery.

### 5.5 Event bounds and input policy

- Partial transcript event text: maximum 512 chars.
- Final user transcript: 1–4,000 chars.
- Assistant response full text: 1–4,000 chars.
- Response chunks: maximum 512 chars.
- Do not use `take(4000)` or `take(512)` as an invisible policy for accepted content.
- If a recognizer partial exceeds 512 characters, preserve the latest valid draft and report a bounded diagnostic; do not publish a malformed event.
- If final transcript exceeds 4,000 characters, reject the turn with a user-visible size message or a safe terminal failure; never silently drop the tail.
- If assistant text exceeds 4,000 characters, use the existing bounded response/fallback policy or fail visibly. Do not publish a partial answer and report it as complete.

---

## 6. Cross-language contract parity

### 6.1 Problem

The TypeScript conversation schema/reducer exists, but Android cannot import TypeScript at runtime. The current Android `core:protocol` module only receives generated Kotlin models for the existing protocol-v1 schema. A manual Kotlin-only event model would become a second contract and could drift.

### 6.2 Required architecture

1. Export the `ConversationEventSchema` and related conversation schemas as a standalone JSON Schema (for example `packages/protocol/schema/conversation-v1.schema.json`).
2. Keep `conversation.ts` as the source declaration for Zod validation and the TypeScript reducer.
3. Add a generator that emits Kotlin `@Serializable` sealed event classes into `apps/android/core/protocol` from that JSON Schema.
4. Add Kotlin `ConversationState` / `ConversationTurnView` DTOs and a pure reducer in `core:protocol` (hand-written reducer logic is acceptable; generated event types are not).
5. Share reducer conformance vectors between TypeScript and Kotlin tests. Do not hand-copy test cases into two unrelated fixture files.
6. Add a CI check that regenerates the JSON Schema and Kotlin models and fails on a dirty diff.

### 6.3 Suggested generated Kotlin model API

Names may follow the generator's conventions, but semantics and serialized field names must match the Zod contract:

- `ConversationEvent` sealed base.
- `TurnReceivedEvent`
- `TranscriptPartialEvent`
- `TranscriptFinalEvent`
- `ResponseChunkEvent`
- `ResponseCompletedEvent`
- `TurnInterruptedEvent`
- `TurnFailedEvent`
- `ConversationSession`
- `ConversationTurn`

Generated classes must preserve exact JSON field names using `@SerialName`. Configure Kotlin serialization to reject unknown keys and duplicate member names using the existing protocol parsing safeguards where applicable.

### 6.4 Cross-language conformance fixtures

Add shared fixtures such as:

- `packages/protocol/fixtures/conversation-events-v1.jsonl`
- `packages/protocol/fixtures/conversation-reducer-vectors-v1.json`

Vectors should cover:
- each valid event shape;
- each invalid boundary (bad UUID, uppercase UUID, missing required field, unknown field, invalid enum, overlong string);
- event sequence plus expected normalized state after each event;
- ignored events that must preserve state identity/equality;
- final-over-partial behavior;
- terminal event behavior;
- history cap behavior;
- response chunk concatenation behavior.

Android tests must consume the exact shared fixtures. A Gradle test resource path can reference the repository-level `packages/protocol/fixtures` directory; if repository layout makes this brittle, add a deterministic copy task with a byte-equality check. Do not maintain divergent copies manually.

### 6.5 Reducer parity acceptance

For every shared vector, TypeScript and Kotlin must produce equivalent normalized state:

- same conversation ID/status;
- same ordered turns;
- same role/source/request IDs;
- same text/final/streaming/status values;
- same interrupt reason;
- same active turn ID.

Timestamps and UUIDs are fixture-fixed. Do not compare runtime-generated identifiers.

---

## 7. Kotlin reducer and ConversationController

### 7.1 Kotlin reducer API

Proposed pure API:

```kotlin
fun initialConversationState(conversationId: String): ConversationState
fun applyConversationEvent(
    state: ConversationState,
    event: ConversationEvent,
): ConversationState
fun applyConversationEvents(
    state: ConversationState,
    events: List<ConversationEvent>,
): ConversationState
```

Requirements:
- No Android imports.
- No mutable input objects.
- No hidden time reads.
- No random IDs inside reducer.
- Unknown conversation/turn events return equivalent unchanged state.
- Terminal events remain terminal.
- Response chunks append exactly and respect 4,000-char total content cap.
- Retain max 200 turns and recompute active turn correctly.

### 7.2 Controller responsibilities

Create a small controller, likely in the app's conversation package, that:

- owns `conversationId` and `ConversationState`;
- creates UUID request/turn IDs;
- serializes all event publication;
- exposes observable state (`StateFlow` or `mutableStateOf` with one owner);
- tracks active capture and response generations;
- exposes methods for typed input, ASR partial/final/error/cancel, assistant response, and assistant failure;
- creates assistant turns using the request ID and source of the accepted user turn;
- derives recent planner context;
- prevents a user turn from being submitted twice;
- prevents an old callback from updating a new turn.

The controller must not own the Android `SpeechRecognizer`, native inference engine, or TTS engine. Those remain injected/owned by the existing adapters.

### 7.3 Main-thread and event ingress

For the initial Android release, use one serialization point:

- All controller method calls that apply events execute on Main dispatcher/main looper.
- ASR and TTS callbacks may arrive from platform threads; adapters dispatch callbacks through `Dispatchers.Main.immediate` / `runOnUiThread` before controller publication.
- Long-running inference stays on `Dispatchers.Default` as today.
- Do not run model inference or TTS calls synchronously on the main thread.

If `StateFlow` is selected, update `MutableStateFlow` only from the serialized controller. Do not maintain a second Compose `mutableStateOf` copy of the same conversation.

### 7.4 Activity ownership and lifecycle

- A controller may be owned by an Activity-scoped ViewModel or by a dedicated lifecycle-scoped runtime object.
- Prefer ViewModel ownership if it is a small change and preserves the activity's current lifecycle behavior.
- This release may retain the conversation only in memory; process-death persistence remains out of scope.
- On `onDestroy`, stop speech capture and TTS, invalidate all generations, and close engines as today.
- Configuration recreation should not leave recognizer callbacks targeting a destroyed Activity. The chosen owner must have explicit cleanup semantics.

### 7.5 UI projection

Replace authoritative `chatMessages` history with a projection built from `ConversationState.turns`:

- `turn.role == user` → user message.
- `turn.role == assistant` → assistant message.
- `turn.text` is the displayed text.
- `turn.turnId` is the stable UI key.
- `turn.status` controls typing/thinking/responding/completed presentation.
- `turn.final` distinguishes current draft from finalized content.

`VanessaChatMessage` may remain as a UI-only projected DTO, but it cannot be independently appended or used as the authoritative history.

The Listening screen's draft is the active, non-final user voice turn's `text`. Remove `voiceDraft` as an independent source of truth. Keep `speechInputStatus` and `voiceListening` as device-status state; they are not transcript state.

---

## 8. Speech input adapter changes

### 8.1 Add explicit capture lifecycle callbacks

Extend `AndroidOnDeviceSpeechInput` with a testable listener contract that includes:

- `onSpeechStarted(captureGeneration)`;
- `onPartial(captureGeneration, text)`;
- `onFinal(captureGeneration, text)`;
- `onFailure(captureGeneration, safeReason)`;
- optionally `onCaptureEnded(captureGeneration)` for UI status only.

Keep the Android `RecognitionListener` implementation inside the adapter. Do not pass raw `Bundle` or Android platform callback objects into the conversation controller.

### 8.2 Capture generation fencing

- Increment a generation every time a new recognizer starts.
- Each listener captures its generation when created.
- `cancel()` invalidates the generation before destroying the recognizer.
- Every callback verifies it still belongs to the active generation before forwarding.
- A final callback marks the capture terminal before calling the controller, preventing duplicate final delivery.
- Old callbacks after a new capture starts are ignored.

### 8.3 Separate stop/commit from cancel

The current `stop()` calls `stopListening()`, which may still produce final recognition results asynchronously. Preserve that as a commit/finalize action.

Add a distinct `cancel()` path:
- invalidate generation;
- call `SpeechRecognizer.cancel()`;
- destroy recognizer;
- do not accept a later final callback;
- if a user conversation turn exists, publish `turn.interrupted` with `user_cancel`.

Map UI actions clearly:

| UI action | Speech action | Conversation outcome |
|---|---|---|
| Stop listening button | stopListening / await final | final transcript if available |
| Close voice screen | cancel | interrupt current user capture turn |
| Back from Listening | cancel | interrupt current user capture turn |
| Type instead | cancel | interrupt current voice capture, then focus typed composer |
| Activity destroy | cancel + destroy | no callback may publish after lifecycle owner is gone |

Do not leave the current ambiguous behavior where UI status says "Listening stopped" while a late final callback can still call `runAssistant` without a clear commit/cancel decision.

### 8.4 Partial normalization

Android partial results are complete revised drafts. The controller publishes each as a replacement `transcript.partial` event. It must not append partial text itself.

- Ignore blank partials.
- Deduplicate identical consecutive partial text to reduce UI churn.
- Preserve original case and punctuation supplied by the recognizer.
- Do not apply a second language-model correction pass.
- Do not trim interior whitespace; trim only the recognizer boundary whitespace as the current adapter already does.
- If an invalid over-bound partial arrives, retain the latest valid draft and expose a bounded status diagnostic.

### 8.5 Finalization

- Accept exactly one nonblank final per capture generation.
- Publish `transcript.final` once.
- Clear capture state only after the reducer accepts the final event or the controller rejects it with a clear reason.
- A later `onError` for the same finalized generation must not fail the turn.
- If final is empty, show the existing no-speech message. If a turn was created at speech start, terminate it without fabricating an empty user message; choose `turn.failed` with a safe reason or `turn.interrupted` by user cancellation according to the actual callback cause.

---

## 9. Typed input and planner context

### 9.1 One conversation path

Typed composer submit must use the same controller as voice:

- `turn.received` role `user`, source `text`;
- `transcript.final` with exact accepted prompt;
- assistant turn publication using the same request ID.

There must not be one chat event path and another voice transcript path.

### 9.2 Planner context derivation

The current `ConversationContext` contract remains in place:

- maximum 6 turns;
- maximum 240 characters per turn;
- maximum 1,200 characters total;
- oldest turns are trimmed first;
- one-line normalization and JSON escaping remain.

Build planner context from conversation reducer state, not from a second `chatMessages` array.

Include only turns that:
- are user or assistant turns;
- are terminal and have accepted final content;
- belong to the same conversation;
- have nonblank text;
- are not the current request's incomplete user turn;
- are not failed/interrupted partial capture text unless the product explicitly chooses to retain those later.

The context passed to `LocalPlanCoordinator.run()` must be the state snapshot taken before the new user turn is inserted, or an equivalent filtered snapshot that explicitly excludes the active request. Do not let a partial transcript become long-term context.

### 9.3 Do not change planning authority

This phase must not:
- give the responder conversation history;
- add tools;
- relax plan validation;
- skip permission checks;
- execute a tool based on partial ASR text;
- start planning before `transcript.final` has been accepted.

Partial transcript is for live display only. It is not a command.

---

## 10. Assistant response chunking and offline TTS

### 10.1 Why output needs a separate design

The current model path returns complete strings. The responder returns a validated JSON quote selection or deterministic fallback, and only then is the final user-facing text known. The first bridge should not stream raw model output before validation.

Use a bounded post-validation response chunker. It turns one accepted response into ordered `response.chunk` events whose concatenation is exactly the accepted response. The chunker is not an LLM stream and must be documented as such.

### 10.2 Response chunker contract

Suggested pure interface:

```kotlin
interface AssistantResponseChunker {
    fun split(text: String, locale: Locale = Locale.ROOT): List<String>
}
```

Rules:
- Input must be nonblank and at most 4,000 UTF-16 code units under the current protocol definition. Confirm whether the cross-language contract means Unicode code points or JavaScript string length; do not assume Kotlin `String.length` and JavaScript `.length` always mean the same thing for supplementary characters.
- Output list is nonempty.
- Every chunk is nonempty and at most 512 protocol characters under the agreed length metric.
- `chunks.joinToString(separator = "") == text` exactly.
- Prefer sentence boundaries when possible.
- If a sentence exceeds the limit, split at a whitespace boundary without losing or normalizing the separator.
- If one unbroken token exceeds the limit, split at a Unicode-safe boundary; never split a surrogate pair or UTF-8 sequence.
- Do not change quote text, JSON, punctuation, date formats, IDs, or technical strings.
- Tests cover punctuation, abbreviations, decimal numbers, URLs, UUIDs, newlines, emoji, Indic scripts, CJK, long unbroken strings, and the 512 boundary.

Do not rely on locale-dependent Android sentence segmentation as the only correctness mechanism. A sentence segmenter may be used as a preference, but exact concatenation and hard bounds are the invariants.

### 10.3 Conversation publication

After `LocalPlanCoordinator.respond()` returns and the response passes the final bound:

1. Controller has already created the assistant turn.
2. Split response into chunks.
3. Publish `response.chunk` events in order.
4. Publish `response.completed` once after the last chunk.
5. If chunk publication fails due to active-turn mismatch/generation fencing, stop publication and do not complete a different turn.

Do not call `response.completed` from a `finally` block. A failed, interrupted, or stale response cannot be converted into a successful completion merely because code left a coroutine.

### 10.4 Offline TTS adapter

Enhance `OfflineTtsController` without changing its offline-only selection policy.

Required capabilities:
- `speak(text)` remains supported for existing explicit read-aloud calls.
- Add `speakChunks(chunks, playbackId, listener)` or an equivalent bounded queue API.
- Register an Android `UtteranceProgressListener` once the engine is ready.
- Give every utterance a deterministic unique ID scoped to `playbackId` and chunk index.
- Use `QUEUE_FLUSH` for the first chunk and `QUEUE_ADD` for subsequent chunks.
- Expose `onStart`, `onDone`, `onError`, and `onStop` callbacks with playback ID and chunk index.
- Use a playback generation to fence late callbacks after stop, replacement, or close.
- Never report completed until all queued utterances have actually finished.
- If queueing a chunk fails, stop the remaining queue and report a safe playback failure.
- TTS callback thread is not assumed to be the main thread; controller publication is marshalled to its serialized event ingress.

### 10.5 Avoid conflating response text with audio playback

The conversation reducer tracks assistant response text and turn completion. TTS playback status is a separate UI/session concern.

- `response.chunk` represents assistant response text chunks.
- `response.completed` means the assistant response text is fully published, not necessarily that every audio frame has played.
- TTS playback completion is reported through a separate playback callback / UI state, not by delaying conversation completion indefinitely.
- If voice response playback is enabled automatically, the full validated text may be published to the conversation immediately in chunks and then queued for TTS; this is honest chunked presentation, not token streaming.
- If playback is manually requested after the response is completed, it must not republish or mutate the completed conversation turn. It only plays the already stored response.
- The existing Read Aloud button remains available for typed responses.

### 10.6 Auto-speech decision

The implementation must preserve current product behavior by default: voice input does not automatically trigger TTS unless the product owner explicitly approves changing that behavior.

The first bridge therefore:
- completes the conversation assistant turn once all response text chunks have been accepted;
- keeps the existing explicit Read Aloud action;
- supports chunked TTS playback for that action;
- does not hold the active conversation turn open while waiting for optional playback.

If product later approves automatic spoken responses for voice-origin requests, implement it as a separate behavior change with explicit user setting and tests.

### 10.7 True native token streaming — deferred

Do not change `inference.cpp` or add JNI callbacks in this phase. A future native streaming PR must address:

- callback thread and JNI local/global reference lifecycle;
- cancellation and mutex behavior while native generation is active;
- incremental UTF-8 decoding because llama token byte pieces can end mid-codepoint;
- bounded callback queues and backpressure;
- stream truncation and native error propagation;
- no UI calls from the llama worker thread;
- planner JSON buffering and grammar validation;
- responder evidence-quote validation before any user-visible publication;
- deterministic cancellation after Activity destruction;
- native instrumentation and device performance.

Only after those controls exist may the product claim model token streaming.

---

## 11. Interruption, cancellation, and barge-in

### 11.1 Conversation interruption is not task cancellation

The contract intentionally distinguishes `turn.interrupted` from task cancellation. Preserve the existing remote task model's ownership rules.

- `turn.interrupted` ends visible conversation output and drops late chunks.
- It must not call the remote task cancellation API unless the user separately invokes the explicit task stop/cancel action.
- It must not infer cancellation from microphone opening, TTS stop, or a back navigation event.

### 11.2 Android playback interruption

When TTS is actively playing and the user explicitly starts a new voice capture:

1. Stop current TTS playback.
2. Invalidate the current playback generation.
3. If the assistant conversation turn is still nonterminal, publish `turn.interrupted` reason `barge_in`.
4. Do not call task cancellation.
5. Start a new capture generation and a new user request/turn only when speech is confirmed.

If the assistant text turn has already completed, stopping read-aloud playback must not change the conversation turn to interrupted. Playback can stop without rewriting completed conversational history.

### 11.3 Explicit cancel

- Closing/canceling a still-capturing user turn publishes `turn.interrupted` reason `user_cancel`.
- A separate explicit task-cancel control retains the existing task cancellation path.
- If the assistant response is already complete and only TTS playback is active, stopping playback is a playback action; it does not change completed turn status.

### 11.4 Late callbacks

After interruption/cancellation:
- ignore partials from the previous capture generation;
- ignore final results from the previous capture generation;
- ignore TTS chunk callbacks from the previous playback generation;
- ignore model output from a superseded request generation;
- do not reactivate a prior assistant turn;
- never allow a terminal reducer state to become active again from late events.

### 11.5 Android barge-in acceptance boundary

A full-duplex acoustic barge-in detector is not part of this phase because the current Android flow does not keep recognition active while offline TTS is speaking. This phase supports **explicit UI barge-in**: the user taps the microphone while TTS is speaking, which stops playback and opens a new capture. Continuous acoustic detection while the speaker is active is a future phase requiring echo cancellation / audio routing validation.

---

## 12. State projection and UI integration

### 12.1 Chat projection

`ChatScreen` receives a list derived from reducer turns. A projected row includes:

- stable `turnId` as its key;
- role-derived side/alignment;
- `text`;
- `status`;
- `final` / streaming indicator state;
- optional response metrics associated by `requestId` or a UI-side request metadata map, not a parallel transcript.

Do not create a new `VanessaChatMessage` every time a partial arrives with a new synthetic message ID. A partial updates the same user turn row.

### 12.2 Listening screen projection

The live draft is the current active user voice turn where `final == false`. The listening screen reads that value from conversation state. A separate device-status string remains valid.

### 12.3 Assistant busy state

Use the active assistant turn's status to render processing/responding state. If existing `assistantBusy` is retained temporarily for execution-screen routing, document it as task/UI operation state and never use it as conversation lifecycle truth. The long-term target is to derive visible turn activity from the reducer and retain only non-conversation operation flags separately.

### 12.4 Avoid duplicated content

- Do not append a user chat message separately from `transcript.final`.
- Do not append an assistant chat message separately from `response.chunk` events.
- Do not keep both `chatMessages` and `ConversationState.turns` as two authoritative histories.
- Do not render the same active voice draft on both Chat and Listening surfaces when the Listening surface is displayed as a separate route.
- Preserve the chat scroll behavior already implemented in `VanessaAssistantScreens.kt`.

### 12.5 Accessibility and testability

Add stable Compose test tags/content descriptions for:
- current user draft;
- finalized user turn;
- assistant response;
- assistant streaming state;
- TTS playback active/stopped state;
- cancel listening action;
- stop/finalize listening action.

Avoid selectors based only on changing full transcript text. Use tags/roles to keep instrumented journeys deterministic.

---

## 13. Persistence and recovery boundary

Conversation contract includes a session schema, but durable storage is not part of this phase.

For this release:
- conversation lives in memory;
- no Room database is added;
- no conversation history sync is added;
- no process-death restoration claim is made;
- Activity/owner destruction stops capture and playback;
- a new process creates a new conversation ID;
- task history and remote task records continue to use their existing durable source.

Before adding persistence, define retention, encryption-at-rest, device identity, conversation ownership, deletion semantics, export behavior, and how conversation references to task records survive logout/device re-pairing. Do not improvise this inside the bridge PR.

---

## 14. Proposed file-level changes

Exact locations must be rechecked before implementation. The list below is a work plan, not permission to rewrite unrelated modules.

| File / path | Planned change | Owner |
|---|---|---|
| `packages/protocol/src/conversation.ts` | Export schema components needed for JSON Schema generation; change only if conformance defect is identified | Protocol |
| `packages/protocol/scripts/generate-json-schema.mjs` | Generate `conversation-v1.schema.json` from conversation Zod schemas | Protocol |
| `packages/protocol/scripts/generate-kotlin-models.mjs` or a companion script | Generate Kotlin conversation event/session models | Protocol |
| `packages/protocol/schema/conversation-v1.schema.json` | Generated schema artifact | Generated |
| `packages/protocol/fixtures/conversation-events-v1.jsonl` | Shared valid/invalid event fixtures | Protocol |
| `packages/protocol/fixtures/conversation-reducer-vectors-v1.json` | Shared reducer sequence vectors | Protocol |
| `apps/android/core/protocol/src/main/kotlin/.../ConversationModels.kt` | Generated Kotlin event model | Generated |
| `apps/android/core/protocol/src/main/kotlin/.../ConversationReducer.kt` | Pure Kotlin reducer and state DTOs | Android protocol |
| `apps/android/core/protocol/src/test/...` | Contract and reducer parity tests | Android protocol |
| `apps/android/core/protocol/build.gradle.kts` | Shared fixture resource path if required | Android protocol |
| `apps/android/app/src/main/java/com/vanessa/mobile/conversation/ConversationController.kt` | Controller, UUID allocation, serialized event ingress, state projection | Android app |
| `apps/android/app/src/main/java/com/vanessa/mobile/voice/AndroidOnDeviceSpeechInput.kt` | Capture generation, speech-start, partial, final, failure, stop vs cancel | Android voice |
| `apps/android/app/src/main/java/com/vanessa/mobile/voice/OfflineTtsController.kt` | Utterance progress listener and bounded sequential chunk playback | Android voice |
| `apps/android/app/src/main/java/com/vanessa/mobile/conversation/AssistantResponseChunker.kt` | Pure bounded chunking with exact concatenation | Android app / protocol |
| `apps/android/app/src/main/java/com/vanessa/mobile/ui/MainActivity.kt` | Route typed/voice input and assistant output through controller; remove duplicate transcript state | Android app |
| `apps/android/app/src/main/java/com/vanessa/mobile/ui/VanessaAssistantScreens.kt` | Consume conversation projections, preserve layout | Android UI |
| `apps/android/app/src/test/...` | Controller, chunker, fake ASR/TTS adapter tests | Android app |
| `apps/android/app/src/androidTest/...` | Instrumented voice/conversation journeys with fakes | Android QA |
| `docs/engineering/CONVERSATION_RUNTIME.md` | Update status only after tests prove the implementation | Documentation |
| `docs/engineering/README.md` | Add bridge specification entry | Documentation |
| `docs/engineering/END_TO_END_ACCEPTANCE.md` | Add voice conversation journeys and gate evidence | QA/documentation |

Forbidden without separate approval:
- modifying the remote task state reducer;
- modifying agent registry or tool permissions;
- modifying desktop `VanessaVoiceSession` in the Android bridge PR;
- changing the native `inference.cpp` generation contract;
- adding a cloud provider;
- adding conversation persistence.

---

## 15. Implementation workstreams and task cards

### Workstream A — Contract parity

**A-01: Export conversation JSON Schema**

Objective:
- Produce a standalone JSON Schema from the Zod conversation schemas.

Required behavior:
- Schema captures strict object behavior, enum values, UUID format/pattern, required fields, and string bounds.
- Generated output is deterministic.
- Running the build does not modify unrelated schemas.

Tests:
- Valid and invalid fixtures pass/fail as expected in TypeScript.
- Regeneration leaves the repository clean.

Acceptance:
- `conversation-v1.schema.json` is generated from the Zod source, not manually authored.

**A-02: Generate Kotlin conversation events**

Objective:
- Extend or add a generator to create Kotlin serializable event models in `core:protocol`.

Required behavior:
- Correct sealed event hierarchy.
- Exact serialized field names.
- Strict decode; no unknown keys.
- UUID and length restrictions validated at decode/adapter boundary.

Acceptance:
- Generated code compiles on Kotlin 1.9 / Java 17 and is byte-stable on regeneration.

**A-03: Shared conformance vectors**

Objective:
- Create common event and reducer vectors consumed by TypeScript and Kotlin tests.

Acceptance:
- CI proves parity on every push; no manually duplicated fixture corpus.

### Workstream B — Kotlin conversation reducer

**B-01: Port reducer semantics**

Objective:
- Implement pure Kotlin reducer equivalent to `applyConversationEvent`.

Required behavior:
- Match all terminal-state, partial replacement, response append, history cap, and isolation semantics.
- No platform imports or clock/random calls.

Acceptance:
- Shared reducer vectors pass unchanged.

**B-02: Edge-boundary tests**

Add tests for:
- unknown conversation;
- unknown turn;
- duplicate turn receipt;
- duplicate final;
- partial after final;
- response chunks after terminal state;
- interrupt then late chunk;
- failed turn preserving accepted text;
- maximum content and chunk lengths;
- active turn selection when several turns exist;
- 200-turn retention.

Acceptance:
- Kotlin reducer parity test suite passes.

### Workstream C — Android conversation controller

**C-01: Controller and identifiers**

Objective:
- Create conversation runtime and one serialized event ingress.

Required behavior:
- Valid lowercase UUID allocation.
- User and assistant turn pairing with one request ID.
- One active capture generation and response generation.
- Event application produces one observable state.

Acceptance:
- Controller tests cover duplicate, stale, invalid, and cross-conversation events.

**C-02: Planner-context projection**

Objective:
- Derive recent context from completed reducer turns.

Required behavior:
- Preserve 6/240/1,200 current limits.
- Exclude active user turn and all partial drafts.
- Exclude failed/interrupted turns unless explicitly approved.

Acceptance:
- Context tests prove old `chatMessages` is no longer required as source of truth.

### Workstream D — ASR adapter integration

**D-01: Capture generation fencing**

Objective:
- Separate stop/finalize from cancel and fence callbacks.

Acceptance:
- Fake recognizer tests reproduce old-generation partial/final callbacks after a new capture and prove they are ignored.

**D-02: Publish voice events**

Objective:
- Publish start/partial/final/failure/interruption into controller.

Acceptance:
- Every accepted partial has an existing user turn; no partial creates a turn by itself; every final is accepted once.

**D-03: Typed input parity**

Objective:
- Route typed composer through the same event controller.

Acceptance:
- Same user/assistant turn model regardless of source; `source` distinguishes modality.

### Workstream E — Assistant response and TTS integration

**E-01: Response chunker**

Objective:
- Split validated assistant output into strict bounded chunks.

Acceptance:
- Exact concatenation, hard bounds, Unicode-safe splits; no punctuation or whitespace loss.

**E-02: Publish assistant response events**

Objective:
- Create assistant turn and publish ordered response chunks, followed by one completion event.

Acceptance:
- No raw planner/responder JSON; no duplicate full response; failed execution/permission paths complete consistently.

**E-03: TTS queue and callback integration**

Objective:
- Add sentence-queued offline playback and onStart/onDone/onError callbacks.

Acceptance:
- Voice remains offline-only; stop/replacement cancels queued utterances; stale callback cannot mutate new playback or conversation state.

**E-04: Explicit UI interruption**

Objective:
- Tapping mic while TTS is active stops playback and opens a new capture with the correct interruption semantics.

Acceptance:
- Conversation turn interruption does not cancel an existing task.

### Workstream F — State/UI migration

**F-01: Replace transcript authority**

Objective:
- Derive chat message rows and Listening draft from reducer state.

Acceptance:
- `chatMessages` and `voiceDraft` are removed as independent authoritative stores.

**F-02: Preserve screens and navigation**

Objective:
- Preserve current route behavior and visuals while rendering event-derived state.

Acceptance:
- Current navigation tests stay green; no visual regression in listening/chat layout.

**F-03: Add stable semantics and status projection**

Acceptance:
- Voice tests locate rows/status via stable tags, not brittle full-transcript matching.

### Workstream G — System validation and documentation

**G-01: Instrumented journeys**

Add deterministic faked-input journeys for:
- live partial changes;
- final transcript enters chat exactly once;
- typed input uses the same reducer;
- no model does not claim execution;
- cancel capture does not submit stale final;
- TTS output completion is independent from conversation completion;
- microphone tap during playback stops old audio and starts a new turn;
- a late callback from an old capture does not change the new turn.

**G-02: CI proof**

Require:
- TypeScript protocol tests;
- schema generation check;
- Kotlin core protocol tests;
- Android unit tests;
- debug APK build;
- instrumented emulator user journeys;
- Windows installer job remains unchanged and green.

**G-03: Documentation truth pass**

Update docs only after implementation and tests pass. Every remaining limitation must be listed, especially lack of durable conversation persistence and lack of true native token streaming.

---

## 16. Required test matrix

### 16.1 Contract and reducer tests

| Scenario | Expected result |
|---|---|
| Partial before `turn.received` | Ignored; no turn manufactured |
| Duplicate `turn.received` | Same state / one turn |
| Two partials | Second replaces first |
| Partial after final | Ignored |
| Duplicate final | No-op |
| Foreign conversation event | Ignored |
| Unknown turn response chunk | Ignored |
| First assistant response chunk | Replaces current assistant text |
| Later response chunk | Appends exactly |
| Chunk after completed | Ignored |
| Interrupt then chunk | Turn remains interrupted |
| Failure after accepted text | Existing text retained per contract |
| 201st turn | Oldest turn evicted |
| Chunk content over limit | Rejected before reducer |

### 16.2 ASR adapter tests

- `onBeginningOfSpeech` starts exactly one conversation user turn.
- Nonblank partial without speech-start creates the turn immediately before the partial.
- Blank partial never creates a turn.
- Identical consecutive partial is deduplicated.
- Revised partial replaces visible text.
- Final without partial creates the turn and finalizes it.
- Double final is ignored.
- Error before any speech produces status only.
- Error after speech start ends the active user turn once.
- Stop/finalize permits final callback.
- Cancel invalidates capture before recognizer destruction.
- `onResults` after cancel is ignored.
- Old listener callback after a new capture is ignored.
- Activity destroy prevents all future event publication.

### 16.3 Planner context tests

- Last six completed turns are used.
- Long turns are truncated using current 240-character rule.
- Total rendered history remains at or below 1,200 characters.
- Partial current voice turn is excluded.
- Active assistant turn is excluded.
- Failed/interrupted turns are excluded by default.
- `requestId` pairing does not duplicate a user turn in context.
- The context is captured before the new turn joins history.

### 16.4 Response chunking tests

- Chunks concatenate to the exact source text.
- No chunk exceeds 512.
- Sentence boundary is preferred where available.
- Spaces/newlines remain in correct positions.
- Periods in decimals and abbreviations do not create data loss.
- URLs, UUIDs, code identifiers, and long numbers remain unchanged.
- Unicode surrogate pairs are not split.
- Indic/CJK/emoji test cases pass.
- Empty, blank, and over-4,000 responses are handled explicitly.
- Deterministic same-input output.

### 16.5 TTS adapter tests

With a fake TTS engine / listener:
- Offline-only voice selection remains enforced.
- First chunk uses flush and later chunks use add.
- Each utterance ID maps to one playback generation and index.
- `onStart`/`onDone` order is respected.
- One error stops the remaining queued audio and reports failure.
- `stop()` invalidates the playback generation.
- `close()` fences callbacks.
- A stale `onDone` from playback N cannot complete playback N+1.
- TTS failure does not remove the already published assistant response text.
- TTS availability remains optional; text output works without it.

### 16.6 Activity / Compose tests

Use faked ASR and TTS dependencies. Avoid relying on emulator microphone audio for deterministic logic tests.

Journeys:
1. Typed prompt → user turn → assistant response → completed state.
2. Voice partial → revised partial → final → exactly one user chat row.
3. Voice final result arrives without partial → correct user turn.
4. Stop listening → final result accepted.
5. Close/back/type-instead → capture cancelled; late final ignored.
6. User begins a new voice input while TTS plays → old playback stops; prior assistant turn is interrupted only if still nonterminal.
7. TTS unavailable → assistant response remains visible and completed.
8. No model installed → honest assistant response; no fake execution success.
9. Permission required → one assistant turn remains correlated across permission callback.
10. App destroyed → capture/TTS teardown; no callback updates destroyed runtime.

The emulator suite should verify actual UI visibility and semantics; unit tests verify callback and reducer edge cases. Do not try to make a cloud ASR provider part of emulator CI.

---

## 17. CI and verification requirements

At minimum, all existing checks remain required:

- `pnpm --filter @vanessa/protocol test`
- `pnpm --filter @vanessa/protocol build`
- TypeScript lint/typecheck for protocol package
- Kotlin `:core:protocol:test`
- Kotlin `:core:agent:test`
- Android app unit tests
- `debug-apk`
- `Android emulator user journeys`
- `build-and-test`
- `windows-installer`

Add explicit CI gates:

1. Generate conversation JSON Schema and Kotlin models.
2. Fail if generated artifacts are dirty after generation.
3. Run shared fixture parity tests in both TypeScript and Kotlin.
4. Run reducer tests before Android instrumentation.
5. Android instrumentation must execute the new fake-input conversation journeys, not merely compile the androidTest source set.
6. A missing emulator/device must remain a CI infrastructure failure with explicit diagnostics; it cannot be counted as an executed test suite.
7. No `|| true`, pipeline-tail exit-code masking, or missing-result-XML success path may be introduced.

Run the whole existing repository verification suite as required by the project CI. Record exact job/run IDs and results in the implementation PR. A green `debug-apk` does not prove the instrumented source set compiled or that an emulator journey ran.

---

## 18. Performance and reliability budgets

This is a user-interactive mobile path. The first release should collect measurements rather than claim unsupported latency targets.

Record at least:

- time from `onBeginningOfSpeech` to first accepted partial;
- interval between consecutive partial callbacks;
- final transcript callback to `transcript.final` reducer acceptance;
- final transcript acceptance to planner start;
- planner run duration;
- response validation duration;
- first response chunk publication time;
- TTS first `onStart` and final `onDone` time;
- total memory retained by 200 turn views;
- callback count rejected by capture/playback generation fencing.

Do not log raw audio or full transcripts. Telemetry must not create a new upload path. Local debug logs may include bounded length/timing metadata only.

Operational limits:
- Conversation retains at most 200 turns.
- Existing planner context remains at six turns / 1,200 characters.
- User and assistant text remains bounded to 4,000 characters each.
- Individual event chunks remain at 512 characters.
- TTS queue depth is bounded by the maximum response chunk count derived from the 4,000-character response maximum.
- Capture and playback generations are monotonic process-local counters; overflow handling should be practically unreachable but should not use a wraparound that can accidentally revalidate stale callbacks.

---

## 19. Security and privacy boundaries

- The recognizer remains on-device and offline-only.
- The TTS voice remains offline-only.
- Do not add remote speech endpoints.
- Do not log raw audio, transcript bodies, model prompts, or tool evidence.
- Do not render model planner JSON or tool arguments into the chat.
- Do not allow a partial transcript to trigger tools or planning.
- Do not treat the conversation event contract as an authorization contract.
- Do not store conversation data in a new database in this phase.
- Any future cloud sync requires explicit session ownership, device authentication, retention, and encryption design.
- Do not infer or add conversation context from other local apps or sensors.
- If UI content is later rendered in WebView/HTML, text must be escaped; no HTML injection is permitted.

---

## 20. Rollout sequence and dependency graph

| Milestone | Deliverable | Must precede |
|---|---|---|
| M0 — Baseline freeze | Reconfirm PR #69 merge on `main`; inspect clean tree and current CI | All |
| M1 — Cross-language contract | JSON Schema + generated Kotlin models + shared event fixtures | M2 |
| M2 — Kotlin reducer parity | Pure Kotlin reducer + shared conformance tests | M3 |
| M3 — Controller | ConversationController, ID pairing, ordered ingress, state projection | M4/M5/M6 |
| M4 — ASR integration | Speech start/partial/final/error/cancel wired into controller | M7 |
| M5 — Typed integration | Composer submit uses same controller | M7 |
| M6 — Assistant/TTS | Response chunker, assistant events, queued offline TTS callbacks | M7 |
| M7 — UI migration | Chat and Listening state derived from reducer | M8 |
| M8 — Instrumented proof | Fake-ASR/TTS Android journeys, teardown, stale callbacks, no-model path | M9 |
| M9 — CI and docs | Full CI green, honest runtime docs and known gaps | M10 |
| M10 — Independent review | Contract, event semantics, lifecycle, and concurrency reviewed | Release |

Recommended PR split:

1. **PR A — Conversation schema/Kotlin parity** (no UI behavior changes).
2. **PR B — Android ConversationController + reducer integration tests** (no recognizer/TTS code yet).
3. **PR C — ASR partial/final adapter integration + typed composer path**.
4. **PR D — assistant output chunking + offline TTS progress + interruption semantics**.
5. **PR E — state projection/UI migration + emulator journeys + documentation**.

Do not combine the schema generator, JNI streaming, full UI redesign, persistence, and desktop voice runtime into one PR. Keep each PR reviewable and independently green.

---

## 21. Release gates

### 21.1 Functional gates

- [ ] Every typed and voice request creates a conversation user turn through `turn.received`.
- [ ] The first partial is never published before `turn.received`.
- [ ] ASR partials update the existing turn, not additional chat rows.
- [ ] Final transcript is authoritative and accepted once.
- [ ] Typed and voice turns share one event/reducer path.
- [ ] Planner context comes from reducer state and excludes current partial text.
- [ ] Assistant turns have distinct turn IDs but share request ID with user turn.
- [ ] Only validated response text is published.
- [ ] Response chunks remain within contract bounds and concatenate exactly.
- [ ] Response completion is emitted once and only after all text chunks.
- [ ] TTS remains offline-only and optional.
- [ ] TTS playback errors do not erase completed assistant response text.
- [ ] Explicit barge-in stops output and does not cancel a task.
- [ ] Stop/finalize and cancel are distinct paths.
- [ ] Late capture/playback callbacks are ignored.
- [ ] No duplicate authoritative transcript/message store remains.

### 21.2 Cross-language and test gates

- [ ] Conversation JSON Schema generated from TypeScript Zod definitions.
- [ ] Kotlin models generated from the shared schema.
- [ ] TypeScript/Kotlin reducer fixtures match.
- [ ] Current 20 TypeScript conversation tests remain green.
- [ ] Kotlin reducer parity tests pass.
- [ ] Existing 10 ConversationContext tests remain green.
- [ ] ASR adapter tests cover all lifecycle/fencing paths.
- [ ] Response chunker Unicode/bounds tests pass.
- [ ] Fake TTS tests cover queue/error/stop/stale callbacks.
- [ ] Compose instrumented journeys execute on emulator and assert real state.
- [ ] Existing emulator five journeys remain green.
- [ ] All four current CI jobs remain green.

### 21.3 Product and operational gates

- [ ] No new cloud audio processing.
- [ ] No planner/tool authority changes.
- [ ] No task cancellation coupling added to turn interruption.
- [ ] No durable conversation claim.
- [ ] Documentation clearly states no token-level native generation streaming.
- [ ] Independent review complete.
- [ ] Current limitations recorded and accepted.

---

## 22. Known limitations after this phase

Even after this bridge is complete, the following remain explicitly not implemented:

- Durable conversation sessions and cross-device history.
- Conversation retention/deletion and encryption design.
- Memory retrieval from Memory Palace.
- Summarization of older history beyond the current fixed context bounds.
- Desktop `VanessaVoiceSession` publication into the same conversation contract.
- Native llama.cpp token-level generation streaming.
- Acoustic full-duplex Android barge-in / echo cancellation.
- Explicit clarification outcomes / missing-slot protocol.
- `task.handoff` event and durable conversation-to-task relationship.
- Unified inference provider routing/fallback.
- Cross-process event replay / transport / server-side conversation storage.

Do not mark the full voice conversation milestone complete merely because live ASR partials show on screen or because the reducer has Kotlin tests. All release gates above must pass.

---

## 23. First task to execute

Start with **A-01 — Export conversation JSON Schema**, followed by A-02 and A-03. Do not start by modifying `MainActivity` or `AndroidOnDeviceSpeechInput`.

The first implementation PR should prove that the TypeScript and Kotlin sides agree on the exact wire contract and reducer behavior. Once this is stable, add the Android controller. The second PR should prove event identity, ordering, and stale-event rejection without involving microphone or TTS APIs. Only then wire real adapters.

### First PR acceptance checklist

- [ ] New conversation JSON Schema is generated by the TypeScript build.
- [ ] The Kotlin model generator is deterministic.
- [ ] The Kotlin event models compile in `:core:protocol`.
- [ ] Shared JSON event fixtures validate the same way on both runtimes.
- [ ] Shared reducer vectors produce equivalent TypeScript/Kotlin states.
- [ ] Existing protocol-v1 generation and fixtures remain unchanged.
- [ ] Existing tests and all relevant CI jobs pass.
- [ ] No Android UI, speech recognizer, TTS, planner, task, or JNI code is changed.

**Engineering directive:** make conversation state authoritative before connecting more interfaces. Publish only accepted transcripts and validated assistant output. Preserve request/task authority boundaries. Make every event ordered, bounded, and attributable to one turn. Never claim streaming, persistence, interruption safety, or end-to-end conversation until the corresponding behavior has been exercised and proved.
