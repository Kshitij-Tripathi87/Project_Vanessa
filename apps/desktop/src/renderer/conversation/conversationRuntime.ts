import {
  applyConversationEvent,
  initialConversationState,
  isTerminalTurnStatus,
  MAX_CONVERSATION_TURNS,
  MAX_TRANSCRIPT_CHUNK,
  MAX_TURN_CONTENT,
  type ConversationEvent,
  type ConversationState,
} from "@vanessa/protocol/conversation";

export interface ConversationRequestHandle {
  conversationId: string;
  requestId: string;
  userTurnId: string;
  source: "text";
}

export interface PlannerConversationTurn {
  role: "user" | "assistant";
  content: string;
}

type IdProvider = () => string;
type Clock = () => number;
type StateListener = (state: ConversationState) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CONTEXT_TURNS = 6;
const MAX_CONTEXT_TURN_CHARS = 240;
const MAX_CONTEXT_CHARS = 1200;

/**
 * Desktop's typed-conversation adapter over the shared protocol reducer.
 *
 * It owns turn identity and transcript state only. It does not own task
 * execution, cancellation, approval or verification; those remain with the
 * orchestrator. The controller publishes immutable reducer snapshots to the
 * renderer store.
 */
export class DesktopConversationRuntime {
  private currentState: ConversationState;

  constructor(
    initialState: ConversationState,
    private readonly onStateChange: StateListener,
    private readonly idProvider: IdProvider = () => globalThis.crypto.randomUUID(),
    private readonly clock: Clock = () => Date.now(),
  ) {
    if (!UUID.test(initialState.conversationId)) {
      throw new Error("Conversation ID must be a canonical lowercase UUID.");
    }
    this.currentState = initialState;
  }

  get state(): ConversationState {
    return this.currentState;
  }

  /** Creates one completed user turn for a typed request. */
  submitTyped(text: string): ConversationRequestHandle | null {
    const content = text.trim();
    if (!content || content.length > MAX_TURN_CONTENT || !this.canReceiveTurn()) return null;

    const requestId = this.nextId();
    const userTurnId = this.nextId();
    const received = this.dispatch({
      type: "turn.received",
      conversationId: this.currentState.conversationId,
      turnId: userTurnId,
      requestId,
      role: "user",
      source: "text",
      createdAt: this.now(),
    });
    if (!received) return null;

    const finalized = this.dispatch({
      type: "transcript.final",
      conversationId: this.currentState.conversationId,
      turnId: userTurnId,
      text: content,
    });
    if (!finalized) return null;

    return {
      conversationId: this.currentState.conversationId,
      requestId,
      userTurnId,
      source: "text",
    };
  }

  /**
   * Stores a fully returned assistant answer. The entire response is validated
   * before any response chunk is published, then chunked without splitting a
   * UTF-16 surrogate pair.
   */
  completeAssistant(request: ConversationRequestHandle, responseText: string): boolean {
    const assistantTurnId = this.beginAssistantTurn(request);
    if (!assistantTurnId) return false;

    const content = responseText.trim();
    if (!content || content.length > MAX_TURN_CONTENT) {
      const reason = !content
        ? "No validated assistant response is available."
        : "Assistant response exceeded the conversation limit.";
      return this.dispatch({
        type: "turn.failed",
        conversationId: this.currentState.conversationId,
        turnId: assistantTurnId,
        reason,
      });
    }

    for (const chunk of splitResponse(content)) {
      if (!this.dispatch({
        type: "response.chunk",
        conversationId: this.currentState.conversationId,
        turnId: assistantTurnId,
        text: chunk,
      })) return false;
    }

    return this.dispatch({
      type: "response.completed",
      conversationId: this.currentState.conversationId,
      turnId: assistantTurnId,
    });
  }

  /** Adds an explicit failed assistant turn without inventing a task result. */
  failAssistant(request: ConversationRequestHandle, reason: string): boolean {
    const assistantTurnId = this.beginAssistantTurn(request);
    if (!assistantTurnId) return false;
    const safeReason = reason.trim().slice(0, 300) || "The assistant response failed.";
    return this.dispatch({
      type: "turn.failed",
      conversationId: this.currentState.conversationId,
      turnId: assistantTurnId,
      reason: safeReason,
    });
  }

  /**
   * Supplies only completed historical turns. The current request is excluded;
   * turns are newest-first for budgeting, then returned oldest-first.
   */
  plannerContext(excludingRequestId?: string): PlannerConversationTurn[] {
    const completed = this.currentState.turns
      .filter((turn) => turn.status === "completed" && turn.text.trim())
      .filter((turn) => !excludingRequestId || turn.requestId !== excludingRequestId)
      .slice(-MAX_CONTEXT_TURNS);

    const kept: PlannerConversationTurn[] = [];
    let remaining = MAX_CONTEXT_CHARS;
    for (const turn of completed.reverse()) {
      const role = turn.role;
      const prefixLength = role === "user" ? 6 : 9; // "User: " or "Vanessa: "
      const content = turn.text.replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_TURN_CHARS);
      const cost = prefixLength + content.length + 1;
      if (cost > remaining) break;
      kept.unshift({ role, content });
      remaining -= cost;
    }
    return kept;
  }

  private beginAssistantTurn(request: ConversationRequestHandle): string | null {
    if (request.conversationId !== this.currentState.conversationId) return null;
    const userTurn = this.currentState.turns.find((turn) =>
      turn.turnId === request.userTurnId &&
      turn.requestId === request.requestId &&
      turn.role === "user" &&
      turn.source === request.source
    );
    if (!userTurn || userTurn.status !== "completed") return null;
    if (this.currentState.turns.some((turn) =>
      turn.requestId === request.requestId && turn.role === "assistant"
    )) return null;

    const turnId = this.nextId();
    const accepted = this.dispatch({
      type: "turn.received",
      conversationId: this.currentState.conversationId,
      turnId,
      requestId: request.requestId,
      role: "assistant",
      source: "text",
      createdAt: this.now(),
    });
    return accepted ? turnId : null;
  }

  private canReceiveTurn(): boolean {
    const turns = this.currentState.turns;
    return turns.length < MAX_CONVERSATION_TURNS ||
      (turns.length > 0 && isTerminalTurnStatus(turns[0].status));
  }

  private dispatch(event: ConversationEvent): boolean {
    const next = applyConversationEvent(this.currentState, event);
    if (next === this.currentState) return false;
    this.currentState = next;
    this.onStateChange(next);
    return true;
  }

  private nextId(): string {
    const id = this.idProvider();
    if (!UUID.test(id)) throw new Error("Conversation ID provider returned a non-canonical UUID.");
    return id;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new Error("Conversation clock is outside the supported epoch range.");
    }
    return value;
  }
}

function splitResponse(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_TRANSCRIPT_CHUNK, text.length);
    if (
      end < text.length &&
      end > start &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    ) end -= 1;
    if (end <= start) return [];
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function createDesktopConversationState(): ConversationState {
  return initialConversationState(globalThis.crypto.randomUUID());
}
