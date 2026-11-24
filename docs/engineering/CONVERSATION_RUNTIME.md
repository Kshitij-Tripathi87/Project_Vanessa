# Conversation runtime

**Status at branch `1dd201b`:** the shared contract, TypeScript/Kotlin reducers,
in-memory Android controller and desktop typed/voice integration are present.
PRs #85–#87 merged the desktop conversation/voice bridge and Android
Activity/ASR/UI/offline-TTS wiring. Earlier stacked PR numbers below describe
historical development, not open delivery branches. Durable conversation
persistence, memory retrieval, adaptive model routing, explicit clarification,
task handoff and physical-device journeys remain separate work. iPhone/iOS is
also in product scope, but no iOS app was found under `apps/`; its shared-contract
integration and acceptance remain unimplemented. See the
[integrated plan](VANESSA_INTEGRATED_PRODUCTION_PLAN.md) and [S0 baseline](S0_BASELINE.md).

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

**Android integration is present in the PR #87 merge.** `MainActivity` owns one
`ConversationController`; it no longer
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
Offline TTS remains explicitly user-triggered. PR #82 passed Agent Workflow CI,
Android foundation, Android emulator QA and Windows Release on its latest
validated head. The emulator report contained seven executed instrumented tests,
zero failures and zero skipped cases. No physical-device microphone acceptance
has been recorded.

The offline TTS playback lifecycle (starting, speaking, completed, stopped and
error), response-card Stop-reading control and preemption behavior were included
in PR #87. Android foundation and emulator QA passed on the earlier `e359680`
main commit; real microphone, playback quality and physical-device behavior
remain unverified.

Desktop typed conversation and the voice bridge were merged through PRs #85 and
#86. Desktop and Android share the protocol contract, but they do not yet prove
one durable cross-device session.

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
validate response content before supplying it. Unit results alone do not prove
that app lifecycle and audio behavior work on a physical device.

## Existing Android planner context

`ConversationController.plannerContext(excludingRequestId)` now supplies
completed historical turns to `LocalPlanCoordinator.run(prompt, context)` in
the Android integration merged through PR #87. The controller excludes the current request and partial ASR
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

PR #87 merged the Activity, typed composer, on-device ASR, local planner and
Compose projections with projection tests and capture-generation fencing.
Android foundation and emulator QA passed at `e359680`; no physical-device
microphone test has been recorded. The controller remains in-memory and scoped
to the Activity instance. Durable cross-process history is outside this slice.

Native llama.cpp still returns completed strings, not model-token streams.
The controller publishes assistant output only after the complete response has
been produced and passed to its bounded response publisher; this is not
incremental model-token streaming. Offline TTS remains a user-triggered complete
string operation; playback start/completion/stop/error and stale-callback
rejection were merged through PR #87. A sentence queue, streaming
model-token synthesis and acoustic Android barge-in are still not connected. Memory Palace retrieval, explicit clarification,
task handoff, shared durable desktop/Android sessions, and the full end-to-end
hear → understand → remember → clarify → plan → act → verify → respond journey
remain open.
