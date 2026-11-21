# Conversation runtime

**Status: the shared wire contract, TypeScript reducer, generated Kotlin models,
Kotlin reducer and an in-memory Android-core conversation controller exist.**
The Android app and desktop conversation paths do not yet use that controller or
its reducers. The voice → conversation bridge, persistence, memory retrieval,
model routing and task handoff remain unimplemented.

The three-day implementation sequence is in
[THREE_DAY_CONVERSATION_RUNTIME_PLAN.md](THREE_DAY_CONVERSATION_RUNTIME_PLAN.md).
The detailed [VOICE_CONVERSATION_BRIDGE.md](VOICE_CONVERSATION_BRIDGE.md) remains
a design snapshot from PR #69, with PR #70's generated Kotlin contract and reducer
parity now delivered. This page reports the code's present state.

## Ownership and actual integration

The intended separation is conversation (turns and context), voice (capture and
playback), agents (capabilities), and orchestrator (planning and task authority).
The UI should ultimately project conversation state; it must not manufacture
remote task state or treat stopping speech as task cancellation.

**That conversation integration has not happened yet.** Android currently keeps
chat history in `chatMessages` and the live speech partial in `voiceDraft` in
`MainActivity`. The on-device recognizer supplies genuine partials to that draft;
the final transcript goes to the existing local assistant path. Neither the UI nor
the recognizer emits the conversation events below. The desktop voice session is
also disconnected from this contract. The standalone controller in
`apps/android/core/agent` has not yet been wired to the activity, recognizer,
planner, playback or remote tasks.

## Contract and generation

`packages/protocol/src/conversation.ts` defines strict Zod schemas for the session,
turn, and seven event shapes. Every event has `conversationId` and `turnId`;
`turn.received` also carries `requestId`, role, source and timestamp. IDs are
canonical lowercase UUID strings. Timestamps are nonnegative integer epoch
milliseconds up to `8_640_000_000_000_000`.

| Artifact | Source |
|---|---|
| `packages/protocol/schema/conversation-v1.schema.json` | Generated from those Zod schemas, independently of the legacy protocol-v1 schema |
| `apps/android/core/protocol/.../conversation/ConversationModels.kt` | Generated from the conversation JSON Schema: serializable event variants, session/turn models, enums, bounds and validation rules |
| `apps/android/core/protocol/.../conversation/ConversationCodec.kt` | Strict JSON ingress/egress for the generated models |
| `apps/android/core/protocol/.../conversation/ConversationReducer.kt` | Hand-written, pure Kotlin reducer and state DTOs |

The `@vanessa/protocol` build regenerates both new artifacts and the pre-existing
protocol-v1 artifacts. CI checks that the generated files are tracked and clean.
The generator fails on unrecognized schema constraints instead of silently
weakening Kotlin validation. There are no hand-maintained copies of the wire
models or validation bounds.

Use `decodeConversationEvent`, `decodeConversationSession`, and
`decodeConversationTurn` for TypeScript JSON ingress, and `ConversationCodec`
for Kotlin JSON ingress **and egress**. They reject duplicate member names before
JSON parsing can collapse them, reject unknown/missing fields and invalid enum,
UUID, timestamp and string bounds, and never treat these shapes as authorization.
Kotlin constructors and bare `kotlinx.serialization` decoding do not by themselves
enforce all wire constraints; callers must use the codec at the boundary. JSON
numeric forms such as `1e3` and `1000.0` are interpreted as JavaScript numbers
before integral/range validation; `-0` normalizes to `0` on JSON output.

### Unicode length caveat

The current Zod contract uses JavaScript string `.length`, and Kotlin uses
`String.length`: **both count UTF-16 code units**, not Unicode code points.
For example, one supplementary emoji occupies two units. The generated schema
includes the standard `minLength`/`maxLength` plus matching
`x-vanessa-minUtf16Length`/`x-vanessa-maxUtf16Length` annotations. Generic JSON
Schema validators count code points and ordinarily ignore those extensions; on
their own they can accept an over-limit emoji string. They also cannot detect
duplicate members after ordinary JSON parsing. Use the strict codecs above (or
implement both the extension and duplicate-member guard) for contract parity.

## Reducer behavior

The TypeScript and Kotlin reducers take a state and validated event and return a
state. They have no clock, random IDs, Android APIs, audio operations, network
operations or task-cancellation side effects. Both retain at most 200 turns and
select the newest unfinished turn as active.

| Event or condition | Result |
|---|---|
| `turn.received` | The only event that creates a turn; duplicate receipt is ignored |
| Unknown turn or other conversation | Ignored; no turn is synthesized |
| `transcript.partial` | A nonempty complete draft replaces previous text; late partials after a final or terminal state are ignored |
| `transcript.final` | Authoritative; completes a user turn or puts an assistant turn in `processing` |
| `response.chunk` | Assistant only; the first chunk replaces existing text, later chunks append |
| Response exceeds 4,000 UTF-16 units | Turn becomes terminal `failed`; previously accepted text remains, the overflowing chunk is not sliced or appended, and a late completion cannot report success |
| `response.completed` | Completes an assistant response in processing/responding; subsequent delivery is ignored |
| `turn.interrupted` | Ends the turn with its reason; late output is ignored, but no task is cancelled and the reducer itself does not stop audio |
| `turn.failed` | Ends the turn; retains accepted text, or displays its reason if no text exists |

Ignored events return the *same state object* on both runtimes. A repeated,
nonempty partial before finalization is applied again and may return a new but
equal state. The event schema currently has no sequence or event ID; the standalone
controller serializes its operations and fences stale capture and response
handles. The contract does not provide transport ordering or persistence.

Wire ingress rejects individual partials/chunks over 512 units and final
transcripts over 4,000; the reducer also guards the accumulated response. The
future assistant output adapter must validate the complete response **before**
event publication. A terminal failure on aggregate overflow is a safety net,
not permission to publish unvalidated model output.

## Standalone controller and its limits

`ConversationController` generates request and distinct turn IDs, accepts typed
input or capture leases, folds events through the strict codec and reducer, and
exposes completed prior turns for planner context. It serializes mutations and
publishes a coherent state only after updating its handles; this prevents inline
StateFlow observers from reviving stale capture or assistant generations. It
also refuses a new turn when the 200-turn window would evict an unfinished turn.
A bounded completed turn may still age out, and callers must handle rejected or
no-longer-retained request handles.

`StateFlow` is a conflated state projection, not an event log. A fully validated
assistant response is reduced from bounded logical chunks and committed as one
state update; this is not incremental model-token streaming. The controller
contains no audio, task cancellation or execution authority, and the caller must
validate response content before supplying it. These are standalone JVM behaviors,
not evidence that the app uses them.

## Existing Android planner context

`LocalPlanCoordinator.run(prompt, context)` currently gets its bounded context
from the activity's existing chat list: up to six turns, 240 units each, and
1,200 units total, dropping oldest turns first. Text is collapsed to one line and
JSON-escaped. Context is advisory: the existing tool allow-list, permission gates,
plan validation and evidence-only responder remain unchanged. It is **not yet**
derived from the conversation reducer.

## Verification and CI

The same checked-in files under `packages/protocol/fixtures/` are consumed by
both TypeScript and Kotlin tests:

- `conversation-events-v1.jsonl` covers all event families and session/turn
  shapes, accepted and rejected boundaries, UUIDs, duplicate keys, numeric JSON,
  and UTF-16 supplementary characters.
- `conversation-reducer-vectors-v1.json` specifies normalized state and object
  identity after every step, including final/partial ordering, first-chunk
  replacement, interruption, failure, overflow and the 201st turn.

Gradle reads those same repository-level files as test resources; there is no
manually copied Android fixture. The Android foundation job runs
`:core:protocol:test` and is triggered by protocol changes as well as Android
changes. The main CI job builds and tests the TypeScript protocol and verifies
generated artifact drift. A green debug APK is not evidence of an instrumented
journey; emulator results must be checked separately.

```sh
pnpm --filter @vanessa/protocol build
pnpm --filter @vanessa/protocol test
cd apps/android && ./gradlew :core:protocol:test :core:agent:test
```

## Remaining work

The standalone `ConversationController` is implemented and unit-tested without
microphone or TTS APIs. The next slices wire typed/ASR input, planner context,
validated assistant output, offline TTS playback and UI projections, then execute
integrated emulator journeys. Do not remove `chatMessages`/`voiceDraft` or claim a
single app-level conversation authority until those paths are actually migrated.

Native llama.cpp currently returns completed strings, not token streams. The
future bridge may publish bounded chunks **after** validating the whole response;
that is not model-token streaming. Offline TTS currently speaks one complete
string with explicit Read Aloud; playback progress, queueing and Android barge-in
are not yet connected. Conversation persistence, Memory Palace retrieval,
clarification outcomes, task handoff, desktop integration and the end-to-end
hear → understand → remember → clarify → plan → act → verify → respond journey
also remain open.
