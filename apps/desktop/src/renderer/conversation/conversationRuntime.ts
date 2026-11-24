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
  source: "text" | "voice";
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
  private readonly activeRequests = new Set<string>();
  // Restored history is visible locally, but is not silently sent to a model.
  private readonly sessionRequestIds = new Set<string>();
  private historyClearPending = false;

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

  get isHistoryClearPending(): boolean {
    return this.historyClearPending;
  }

  /** In-flight responses must not be lost behind an acknowledged history flush. */
  get hasPendingRequests(): boolean {
    return this.activeRequests.size > 0;
  }

  /** Fence new conversation turns while an explicit history clear is in progress. */
  beginHistoryClear(): boolean {
    if (this.historyClearPending || this.activeRequests.size > 0 ||
        this.currentState.turns.some((turn) => !isTerminalTurnStatus(turn.status))) return false;
    this.historyClearPending = true;
    return true;
  }

  /** Clearing conversation text never cancels or changes orchestrator task state. */
  finishHistoryClear(clearSucceeded: boolean): void {
    if (!this.historyClearPending) return;
    try {
      if (clearSucceeded) {
        this.currentState = initialConversationState(this.nextId());
        this.sessionRequestIds.clear();
        this.onStateChange(this.currentState);
      }
    } finally {
      this.historyClearPending = false;
    }
  }

  /** Creates one completed user turn for a typed request. */
  submitTyped(text: string): ConversationRequestHandle | null {
    if (this.historyClearPending) return null;
    const content = text.trim();
    if (!content || content.length > MAX_TURN_CONTENT) return null;
    return this.createUserTurn(content, this.nextId(), "text");
  }

  /**
   * Commits the final transcript of a voice request. The voice service supplies
   * the canonical request ID used by its orchestrator submission so the user
   * turn, task timeline and assistant response share one correlation key.
   * Duplicate delivery returns the existing handle only when the final text is
   * identical; it can never create a second transcript turn.
   */
  submitVoiceFinal(text: string, requestId: string): ConversationRequestHandle | null {
    if (this.historyClearPending) return null;
    const content = text.trim();
    if (!content || content.length > MAX_TURN_CONTENT || !UUID.test(requestId)) return null;

    const existing = this.currentState.turns.find((turn) =>
      turn.requestId === requestId && turn.role === "user" && turn.source === "voice"
    );
    if (existing) {
      // A restored turn is display-only: a replay must not reactivate an old
      // request or attach a late response after a restart.
      if (!this.sessionRequestIds.has(requestId) || existing.text !== content) return null;
      return {
        conversationId: this.currentState.conversationId,
        requestId,
        userTurnId: existing.turnId,
        source: "voice",
      };
    }
    return this.createUserTurn(content, requestId, "voice");
  }

  private createUserTurn(
    content: string,
    requestId: string,
    source: "text" | "voice",
  ): ConversationRequestHandle | null {
    if (!this.canReceiveTurn() || this.activeRequests.has(requestId)) return null;
    const userTurnId = this.nextId();
    const received = this.dispatch({
      type: "turn.received",
      conversationId: this.currentState.conversationId,
      turnId: userTurnId,
      requestId,
      role: "user",
      source,
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

    this.activeRequests.add(requestId);
    this.sessionRequestIds.add(requestId);
    if (this.sessionRequestIds.size > MAX_CONVERSATION_TURNS) {
      const retained = new Set(this.currentState.turns.map((turn) => turn.requestId));
      for (const id of this.sessionRequestIds) if (!retained.has(id) && !this.activeRequests.has(id)) this.sessionRequestIds.delete(id);
    }
    return {
      conversationId: this.currentState.conversationId,
      requestId,
      userTurnId,
      source,
    };
  }

  /**
   * Stores a fully returned assistant answer. The entire response is validated
   * before any response chunk is published, then chunked without splitting a
   * UTF-16 surrogate pair.
   */
  completeAssistant(request: ConversationRequestHandle, responseText: string): boolean {
    const assistantTurnId = this.beginAssistantTurn(request);
    if (!assistantTurnId) {
      this.activeRequests.delete(request.requestId);
      return false;
    }

    const content = responseText.trim();
    if (!content || content.length > MAX_TURN_CONTENT) {
      const reason = !content
        ? "No validated assistant response is available."
        : "Assistant response exceeded the conversation limit.";
      const failed = this.dispatch({
        type: "turn.failed",
        conversationId: this.currentState.conversationId,
        turnId: assistantTurnId,
        reason,
      });
      if (failed) this.activeRequests.delete(request.requestId);
      return failed;
    }

    for (const chunk of splitResponse(content)) {
      if (!this.dispatch({
        type: "response.chunk",
        conversationId: this.currentState.conversationId,
        turnId: assistantTurnId,
        text: chunk,
      })) return false;
    }

    const completed = this.dispatch({
      type: "response.completed",
      conversationId: this.currentState.conversationId,
      turnId: assistantTurnId,
    });
    if (completed) this.activeRequests.delete(request.requestId);
    return completed;
  }

  /** Ends the response turn without changing the task's execution state. */
  interruptAssistant(
    request: ConversationRequestHandle,
    reason: "barge_in" | "user_cancel" = "user_cancel",
  ): boolean {
    const assistantTurnId = this.beginAssistantTurn(request);
    if (!assistantTurnId) {
      this.activeRequests.delete(request.requestId);
      return false;
    }
    const interrupted = this.dispatch({
      type: "turn.interrupted",
      conversationId: this.currentState.conversationId,
      turnId: assistantTurnId,
      reason,
    });
    if (interrupted) this.activeRequests.delete(request.requestId);
    return interrupted;
  }

  /** Adds an explicit failed assistant turn without inventing a task result. */
  failAssistant(request: ConversationRequestHandle, reason: string): boolean {
    const assistantTurnId = this.beginAssistantTurn(request);
    if (!assistantTurnId) {
      this.activeRequests.delete(request.requestId);
      return false;
    }
    const safeReason = reason.trim().slice(0, 300) || "The assistant response failed.";
    const failed = this.dispatch({
      type: "turn.failed",
      conversationId: this.currentState.conversationId,
      turnId: assistantTurnId,
      reason: safeReason,
    });
    if (failed) this.activeRequests.delete(request.requestId);
    return failed;
  }

  /**
   * Supplies only completed historical turns. The current request is excluded;
   * turns are newest-first for budgeting, then returned oldest-first.
   */
  plannerContext(excludingRequestId?: string): PlannerConversationTurn[] {
    const completed = this.currentState.turns
      .filter((turn) => turn.status === "completed" && turn.text.trim())
      .filter((turn) => this.sessionRequestIds.has(turn.requestId))
      .filter((turn) => !this.activeRequests.has(turn.requestId))
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
    // The reducer evicts the oldest turn when a new turn arrives. Preserve an
    // in-flight request and its originating user turn instead of losing context.
    const turns = this.currentState.turns;
    if (turns.length >= MAX_CONVERSATION_TURNS) {
      const oldest = turns[0];
      if (
        !oldest ||
        !isTerminalTurnStatus(oldest.status) ||
        oldest.turnId === request.userTurnId ||
        this.activeRequests.has(oldest.requestId)
      ) return null;
    }
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
      source: request.source,
      createdAt: this.now(),
    });
    return accepted ? turnId : null;
  }

  private canReceiveTurn(): boolean {
    const turns = this.currentState.turns;
    if (turns.length < MAX_CONVERSATION_TURNS) return true;
    const oldest = turns[0];
    return Boolean(oldest && isTerminalTurnStatus(oldest.status) && !this.activeRequests.has(oldest.requestId));
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
