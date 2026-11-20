# Conversation runtime

**Status: contract and reducer implemented; on-device multi-turn context implemented;
voice bridge, memory retrieval, model routing and task handoff are not.**

This document describes the conversation layer as the code stands today. Where the
programme brief asks for a component that does not exist yet, this document says so
in [Not implemented](#not-implemented) instead of describing the intention as if it
were built.

## The separation this layer exists to enforce

Four responsibilities, which must not be mixed:

| Layer | Owns | Does not own |
|---|---|---|
| Conversation | Session identity, turns, context, what was said | Whether a request needs a device, an approval or a PC |
| Voice | Capture, VAD, ASR, turn-taking, TTS playback | Conversation state; it publishes into a turn |
| Agents | Execution of one capability | Planning, authorization, conversation |
| Orchestrator | Intent → plan → policy → execution → verification | What the conversation shows |

The rule that makes the separation real is that **the surface renders what the
runtime publishes**. The Android chat does not invent a turn, a phase or a verdict;
it folds events through the reducer in `packages/protocol/src/conversation.ts`.

## What exists

### The contract — `packages/protocol/src/conversation.ts`

Zod schemas matching the conventions of the existing v2 wire contract: strict
objects, lowercase UUIDs, epoch-millisecond timestamps, every string bounded.

| Type | Purpose |
|---|---|
| `ConversationSessionSchema` | `conversationId`, `deviceId`, `activeTurnId?`, `status`, `createdAt`, `updatedAt` |
| `ConversationTurnSchema` | One turn: role, source (`text`/`voice`), content, status |
| `ConversationEventSchema` | Discriminated union of the seven events below |

Events: `turn.received`, `transcript.partial`, `transcript.final`,
`response.chunk`, `response.completed`, `turn.interrupted`, `turn.failed`. Every
event carries `conversationId` and `turnId`.

### The reducer — `applyConversationEvent`

A pure function from `(state, event)` to state. It is the same shape as the phone's
remote-task reducer, for the same reason: one authority per piece of state, with the
ignore rules written down and tested rather than inferred.

| Rule | Why |
|---|---|
| A turn is created **only** by `turn.received` | Otherwise a replayed or late fragment manufactures a turn |
| Events for an unknown `turnId` are ignored | Late events from a dropped turn must not resurrect it |
| Events for another `conversationId` are ignored | Conversation and device isolation |
| Duplicate `turn.received` / `transcript.final` / `response.completed` are no-ops | Reconnect replay is normal, not exceptional |
| A partial after a final transcript is ignored | The final transcript is authoritative |
| A user turn completes when its final transcript is accepted | The user has stopped speaking; nothing else is pending |
| An assistant turn moves to `processing`, then `responding` | The written answer and the spoken answer are the same turn |
| The **first** `response.chunk` replaces the text, later ones append | A written answer followed by speech of the same words must not double |
| `turn.interrupted` is terminal for the turn | Speech stops; the turn cannot be resurrected by a late chunk |
| `turn.failed` is terminal and keeps text already shown | A failure does not erase what the user already heard |
| Ignored events return the **same object** | `next === state` is the test for "nothing happened" |
| Turns are capped at `MAX_CONVERSATION_TURNS` | A long call cannot grow state without limit |

**Interruption is not cancellation.** `turn.interrupted` ends the *turn*: playback
stops and late chunks are dropped. It says nothing about a task the supervisor
already owns. Cancelling work is a separate decision on a separate contract. The
desktop `VanessaVoiceSession` already distinguishes barge-in from task cancellation,
and this contract keeps that distinction rather than flattening it.

### The Android planner context — `ai.vanessa.agent.ConversationContext`

`LocalPlanCoordinator.run(prompt, context)` now receives recent turns. Before this,
the coordinator saw one request in isolation, so "and tomorrow?" reached the planner
with no referent.

| Bound | Value | Reason |
|---|---|---|
| `MAX_TURNS` | 6 | The nearest context resolves references; older turns mostly add noise |
| `MAX_TURN_CHARS` | 240 | One long message must not crowd out the others |
| `MAX_CHARS` | 1200 | Ceiling for the whole block, so the request always fits |

Trimming drops the **oldest** turn first, so the nearest context survives. Each line
is collapsed to a single line and JSON-escaped through `JsonPrimitive`, so a message
containing a quote cannot break out of the quoted region of the prompt.

Three limits are deliberate:

- The context is **advisory**. It can change which allowed tool the model picks. It
  cannot add a tool, widen a permission or relax validation, because validation runs
  on the answer rather than the question.
- The **responder does not receive it**. `respond()` output is a selection of
  verbatim evidence, never a new claim; handing it conversation to paraphrase would
  be a licence to invent.
- The planner still has exactly two tools (`android.device.status`,
  `android.calendar.search`). Context makes the planner better at *choosing*, not
  more capable.

## What the tests prove

`packages/protocol/src/conversation.test.ts` — 20 cases: creation, duplicate
creation, unknown turn, foreign conversation, partial replacement, partial-after-final,
duplicate final, user completion, assistant processing/streaming, streaming before any
transcript, chunks rejected on a user turn, content bound, interruption, completion
after interruption, idempotent completion, failure text preservation, active-turn
selection, history bound, batch-replay stability.

`apps/android/core/agent/src/test/kotlin/ai/vanessa/agent/ConversationContextSpec.kt` —
10 cases: prompt unchanged with no context, blank turns ignored, ordering,
turn cap, per-turn truncation, block ceiling keeping the newest, one-line collapsing,
quote escaping, an unsafe plan remaining unexecutable with context present, and the
allowed tool still planning and executing.

## Not implemented

Each item below is required by the brief and absent from the code. None is claimed as
done anywhere in this repository.

| Component | State | Next step |
|---|---|---|
| Voice → conversation bridge | Android surfaces a final transcript only; partials are dropped in `AndroidOnDeviceSpeechInput` | Publish `transcript.partial` / `transcript.final` into the active turn |
| Streaming TTS with playback state | Offline TTS speaks a completed string | Chunk by sentence, publish `response.chunk` as audio starts |
| Barge-in on Android | Not wired to the conversation; the desktop has it | `turn.interrupted(barge_in)` must also stop playback |
| Memory retrieval | `services/orchestrator/src/memory/memoryPalace.ts` exists; not used to build turn context | Retrieve by conversation and device, with provenance |
| Context window management | Fixed turn/character bounds only | Summarise older turns when the window is full |
| Model routing | Android uses local llama.cpp only | One inference interface with provider readiness and fallback |
| Clarification | Model may answer a question instead of acting; no explicit clarification state | A `clarification` turn outcome with the missing slot named |
| Task handoff | No `task.handoff` event exists yet | Add it, carrying the `requestId` the remote task contract already uses |
| Conversation persistence | Sessions live in memory on the device | Durable session and turn store, with separate retention for verified task outcomes |

## Where this leaves the milestone

The brief's acceptance scenario — *hear → understand → remember → clarify → plan → act
→ verify → respond*, over multiple turns, by voice and by typing, surviving an
interruption — cannot run end to end yet. What is in place is the part every other
part depends on: a turn has an identity, a bounded lifecycle and one authority that
decides what happened to it.

The next step with the highest value is the voice bridge, because it is the only
missing piece that changes what a user can do today: today the phone hears a sentence,
thinks, and speaks a paragraph with no visible middle. Publishing partial transcripts
and streaming chunks into the turn contract is what turns four disconnected features
into one conversation.
