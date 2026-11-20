import { z } from "zod";

import { EpochMsSchema, UuidSchema } from "./messages.ts";

/**
 * Conversation contract.
 *
 * The programme's central rule is that conversation is the foundation, voice is
 * an interface, agents are execution capabilities and the orchestrator is the
 * authority. This module is the wire and state contract for the first of those:
 * what a conversation is, what a turn is, and which events may move a turn.
 *
 * Two properties are deliberate:
 *
 * 1. **Turns are created only by `turn.received`.** A partial transcript, a
 *    response chunk or a completion naming a turn that was never received is
 *    dropped. If any event could create a turn, a replayed or arriving-late
 *    fragment would manufacture conversational state, which is exactly the class
 *    of bug the remote-task model was consolidated to remove.
 *
 * 2. **Interruption is not cancellation.** `turn.interrupted` ends the *turn*:
 *    speech stops and late chunks are ignored. It says nothing about a task the
 *    supervisor already owns. Cancelling work is a separate decision on a
 *    separate contract, and conflating the two would let "stop talking" silently
 *    abort a running Windows operation.
 *
 * Everything is bounded. Transcript text, chunk sizes and the number of retained
 * turns all have ceilings, so a long call or a hostile replay cannot grow the
 * state without limit.
 */

/** Version of the conversation contract. Independent of the wire protocol. */
export const CONVERSATION_PROTOCOL_VERSION = 1 as const;

/** Longest accepted final transcript or completed response, in characters. */
export const MAX_TURN_CONTENT = 4000;

/** Longest accepted partial transcript or response chunk, in characters. */
export const MAX_TRANSCRIPT_CHUNK = 512;

/** Turns retained per conversation. Older turns are dropped from the head. */
export const MAX_CONVERSATION_TURNS = 200;

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

export const ConversationStatusSchema = z.enum(["active", "paused", "closed"]);

export const ConversationTurnRoleSchema = z.enum(["user", "assistant"]);

/** Where a turn came from. The conversation is the same either way. */
export const ConversationTurnSourceSchema = z.enum(["text", "voice"]);

export const ConversationTurnStatusSchema = z.enum([
  "received",
  "processing",
  "responding",
  "completed",
  "interrupted",
  "failed",
]);

export const InterruptReasonSchema = z.enum(["barge_in", "user_cancel"]);

export const ConversationSessionSchema = z
  .object({
    conversationId: UuidSchema,
    deviceId: UuidSchema,
    activeTurnId: UuidSchema.optional(),
    status: ConversationStatusSchema,
    createdAt: EpochMsSchema,
    updatedAt: EpochMsSchema,
  })
  .strict();

export const ConversationTurnSchema = z
  .object({
    turnId: UuidSchema,
    conversationId: UuidSchema,
    requestId: UuidSchema,
    role: ConversationTurnRoleSchema,
    source: ConversationTurnSourceSchema,
    content: z.string().min(1).max(MAX_TURN_CONTENT),
    status: ConversationTurnStatusSchema,
    createdAt: EpochMsSchema,
  })
  .strict();

const conversationId = UuidSchema;
const turnId = UuidSchema;
const at = EpochMsSchema;

const base = { conversationId, turnId } as const;

export const TurnReceivedEventSchema = z
  .object({
    ...base,
    type: z.literal("turn.received"),
    requestId: UuidSchema,
    role: ConversationTurnRoleSchema,
    source: ConversationTurnSourceSchema,
    createdAt: at,
  })
  .strict();

export const TranscriptPartialEventSchema = z
  .object({
    ...base,
    type: z.literal("transcript.partial"),
    text: z.string().max(MAX_TRANSCRIPT_CHUNK),
  })
  .strict();

export const TranscriptFinalEventSchema = z
  .object({
    ...base,
    type: z.literal("transcript.final"),
    text: z.string().min(1).max(MAX_TURN_CONTENT),
  })
  .strict();

export const ResponseChunkEventSchema = z
  .object({
    ...base,
    type: z.literal("response.chunk"),
    text: z.string().max(MAX_TRANSCRIPT_CHUNK),
  })
  .strict();

export const ResponseCompletedEventSchema = z
  .object({ ...base, type: z.literal("response.completed") })
  .strict();

export const TurnInterruptedEventSchema = z
  .object({ ...base, type: z.literal("turn.interrupted"), reason: InterruptReasonSchema })
  .strict();

export const TurnFailedEventSchema = z
  .object({
    ...base,
    type: z.literal("turn.failed"),
    reason: z.string().min(1).max(300),
  })
  .strict();

export const ConversationEventSchema = z.discriminatedUnion("type", [
  TurnReceivedEventSchema,
  TranscriptPartialEventSchema,
  TranscriptFinalEventSchema,
  ResponseChunkEventSchema,
  ResponseCompletedEventSchema,
  TurnInterruptedEventSchema,
  TurnFailedEventSchema,
]);

export type ConversationSession = z.infer<typeof ConversationSessionSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type ConversationTurnStatus = z.infer<typeof ConversationTurnStatusSchema>;
export type InterruptReason = z.infer<typeof InterruptReasonSchema>;

/* ------------------------------------------------------------------ *
 * Reducer state
 * ------------------------------------------------------------------ */

/**
 * A turn as the surface renders it. `text` is whatever the runtime last
 * published about this turn — a draft transcript, the final transcript, or the
 * response so far — and `final` says whether that text may still change.
 */
export interface ConversationTurnView {
  turnId: string;
  conversationId: string;
  requestId: string;
  role: "user" | "assistant";
  source: "text" | "voice";
  text: string;
  final: boolean;
  /**
   * True once the response for this turn has started streaming. The first
   * chunk replaces `text`; later chunks append to it. Without this, an
   * assistant turn that publishes a written answer and then speaks the same
   * words would show (and say) everything twice.
   */
  streaming: boolean;
  status: ConversationTurnStatus;
  createdAt: number;
  interruptReason?: InterruptReason;
}

export interface ConversationState {
  conversationId: string;
  status: "active" | "paused" | "closed";
  turns: ConversationTurnView[];
  /** The newest turn that has not finished, or null when the conversation is idle. */
  activeTurnId: string | null;
}

const TERMINAL: ReadonlySet<ConversationTurnStatus> = new Set(["completed", "interrupted", "failed"]);

export function isTerminalTurnStatus(status: ConversationTurnStatus): boolean {
  return TERMINAL.has(status);
}

export function initialConversationState(conversationId: string): ConversationState {
  return { conversationId, status: "active", turns: [], activeTurnId: null };
}

function activeTurnOf(turns: readonly ConversationTurnView[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!TERMINAL.has(turns[index].status)) return turns[index].turnId;
  }
  return null;
}

/**
 * Applies one event.
 *
 * Returns the same state object when the event is ignored, so callers can tell
 * "nothing changed" by identity alone and a dropped event is cheap.
 */
export function applyConversationEvent(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  // A conversation never learns about another conversation's turns. This is the
  // isolation rule: a device or session that receives a stray event cannot fold
  // it into its own transcript.
  if (event.conversationId !== state.conversationId) return state;

  const index = state.turns.findIndex((turn) => turn.turnId === event.turnId);

  if (event.type === "turn.received") {
    // Already known: a duplicate delivery is a no-op, not a new turn.
    if (index >= 0) return state;
    const turn: ConversationTurnView = {
      turnId: event.turnId,
      conversationId: state.conversationId,
      requestId: event.requestId,
      role: event.role,
      source: event.source,
      text: "",
      final: false,
      streaming: false,
      status: "received",
      createdAt: event.createdAt,
    };
    // Bounded history: the oldest turn is dropped once the cap is reached.
    const turns = [...state.turns, turn].slice(-MAX_CONVERSATION_TURNS);
    return { ...state, turns, activeTurnId: activeTurnOf(turns) };
  }

  // Every remaining event names an existing turn. Without one there is nothing
  // to update, and inventing a turn here would manufacture state.
  if (index < 0) return state;
  const turn = state.turns[index];
  if (TERMINAL.has(turn.status)) return state;

  const replace = (patch: Partial<ConversationTurnView>): ConversationState => {
    const turns = state.turns.map((current, at) =>
      at === index ? { ...current, ...patch } : current,
    );
    return { ...state, turns, activeTurnId: activeTurnOf(turns) };
  };

  switch (event.type) {
    case "transcript.partial": {
      // A final transcript is authoritative; a late draft must not overwrite it.
      if (turn.final) return state;
      if (turn.status !== "received" && turn.status !== "processing") return state;
      if (event.text.length === 0) return state;
      return replace({ text: event.text });
    }

    case "transcript.final": {
      if (turn.final) return state;
      // A user turn is finished once its final transcript is accepted - the
      // user has stopped speaking. An assistant turn that carries a written
      // answer and then streams speech is not: it moves to `processing` so the
      // following chunks have somewhere to land.
      return replace({
        text: event.text,
        final: true,
        status: turn.role === "user" ? "completed" : "processing",
      });
    }

    case "response.chunk": {
      // Responses stream for the assistant; a user turn has no response body.
      if (turn.role !== "assistant") return state;
      // `received` is a legitimate entry point: a spoken answer can stream
      // before any final transcript of the assistant's own words exists.
      if (turn.status !== "received" && turn.status !== "processing" && turn.status !== "responding") {
        return state;
      }
      if (event.text.length === 0) return state;
      const text = turn.streaming ? `${turn.text}${event.text}` : event.text;
      return replace({
        text: text.slice(0, MAX_TURN_CONTENT),
        status: "responding",
        streaming: true,
      });
    }

    case "response.completed": {
      if (turn.status !== "processing" && turn.status !== "responding") return state;
      return replace({ status: "completed", final: true });
    }

    case "turn.interrupted": {
      // Terminal for the turn only. Any task handed off earlier keeps its own
      // lifecycle; stopping speech is not cancelling work.
      return replace({ status: "interrupted", interruptReason: event.reason, final: true });
    }

    case "turn.failed": {
      return replace({ status: "failed", text: turn.text === "" ? event.reason : turn.text, final: true });
    }

    default: {
      // Exhaustive over the union: adding an event type without handling it
      // fails to compile here rather than silently doing nothing at runtime.
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Folds a batch in order. Deliberately a thin loop: callers that need replay
 * guarantees get them from `applyConversationEvent`'s ignore rules rather than
 * from batch-level deduplication.
 */
export function applyConversationEvents(
  state: ConversationState,
  events: readonly ConversationEvent[],
): ConversationState {
  return events.reduce(applyConversationEvent, state);
}
