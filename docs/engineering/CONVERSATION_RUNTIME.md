# Conversation runtime

**Status as of the Android conversation integration PR:** the shared wire
contract, TypeScript reducer, generated Kotlin models, Kotlin reducer and
in-memory Android-core controller exist. Desktop typed conversation and voice
bridge changes are in open stacked PRs #80 and #81. Android Activity/ASR/UI wiring
is implemented on the open stacked branch for PR #82; it is not yet merged or
validated by its required Android CI/emulator runs. Durable conversation
persistence, memory retrieval, model routing, explicit clarification and task
handoff remain separate work.

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

**Android integration is now implemented on the PR #82 branch, pending
validation.** `MainActivity` owns one `ConversationController`; it no longer
stores an independent mutable `chatMessages` list or `voiceDraft` string.
Chat messages and the live ASR draft are projections of the controller's
`ConversationState`. Typed input calls `submitTyped`; the on-device recognizer
uses a capture lease and publishes replacement partials and one final transcript.
The planner receives only completed prior turns, excluding the current request.
Assistant output is published after `LocalPlanCoordinator.respond` returns its
complete response. Calendar-permission retry retains the same request handle.

The Android recognizer now fences late callbacks from a stopped/replaced capture
generation. The Listening screen distinguishes Finish (request the final
transcript) from Cancel (invalidate the lease before recognizer teardown).
Offline TTS remains explicitly user-triggered. PR #82 still needs required
Android foundation and emulator UI QA to pass before this can be called verified.

Desktop typed conversation and the voice bridge are in PRs #80 and #81, also
open and unmerged at this status cut. The desktop and Android branches share the
protocol contract, but they do not yet share one durable cross-device session.

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

`ConversationController.plannerContext(excludingRequestId)` now supplies
completed historical turns to `LocalPlanCoordinator.run(prompt, context)` on
the PR #82 branch. The controller excludes the current request and partial ASR
drafts. The existing LocalPlanCoordinator context renderer still bounds context
to six turns, 240 units per turn and 1,200 units total, collapses text to one line,
and JSON-escapes it. Context remains advisory: the existing tool allow-list,
permission gates, plan validation and evidence-only responder are unchanged.

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

PR #82 wires the Activity, typed composer, on-device ASR, local planner and
Compose projections to the existing controller. It adds pure projection tests
and capture-generation fencing. Required Android foundation and emulator QA
must pass before merge; no physical-device microphone test has yet been recorded.
The controller remains in-memory and scoped to the Activity instance. Durable
cross-process history is explicitly outside this integration slice.

Native llama.cpp still returns completed strings, not model-token streams.
The controller publishes assistant output only after the complete response has
been produced and passed to its bounded response publisher; this is not
incremental model-token streaming. Offline TTS remains a user-triggered complete
string operation; playback progress, a managed sentence queue and Android
barge-in are not yet connected. Memory Palace retrieval, explicit clarification,
task handoff, shared durable desktop/Android sessions, and the full end-to-end
hear → understand → remember → clarify → plan → act → verify → respond journey
remain open.
