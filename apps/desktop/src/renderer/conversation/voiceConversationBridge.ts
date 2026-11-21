import type { PlannerConversationTurn } from "./conversationRuntime.js";
import { DesktopConversationRuntime, type ConversationRequestHandle } from "./conversationRuntime.js";

/**
 * Adapts the voice-service event contract to the same conversation reducer used
 * by typed requests. Audio/provider state remains in the voice session; this
 * bridge only commits finalized turns and their correlated assistant response.
 */
export class DesktopVoiceConversationBridge {
  private readonly requests = new Map<string, ConversationRequestHandle>();

  constructor(
    private readonly runtime: DesktopConversationRuntime,
    private readonly onPublicationFailure?: (requestId: string, text: string, reason: string) => void,
  ) {}

  acceptFinalTranscript(text: unknown, requestId: unknown): boolean {
    if (typeof text !== "string" || typeof requestId !== "string") return false;
    const request = this.runtime.submitVoiceFinal(text, requestId);
    if (!request) return false;

    // A replay after the assistant response is already committed remains
    // idempotently accepted, but must not recreate a pending-response entry.
    const hasAssistantTurn = this.runtime.state.turns.some((turn) =>
      turn.requestId === requestId && turn.role === "assistant"
    );
    if (!hasAssistantTurn) this.requests.set(request.requestId, request);
    return true;
  }

  completeAssistantResponse(requestId: unknown, response: unknown): boolean {
    if (typeof requestId !== "string" || typeof response !== "string") return false;
    const request = this.requests.get(requestId);
    if (!request) return false;
    const completed = this.runtime.completeAssistant(request, response);
    this.requests.delete(requestId);
    if (!completed) this.onPublicationFailure?.(
      requestId,
      response,
      "The voice response arrived, but bounded conversation history could not accept it. This copy is retained here for recovery.",
    );
    return completed;
  }

  failAssistantResponse(requestId: unknown, reason: string): boolean {
    if (typeof requestId !== "string") return false;
    const request = this.requests.get(requestId);
    if (!request) return false;
    const failed = this.runtime.failAssistant(request, reason);
    this.requests.delete(requestId);
    if (!failed) this.onPublicationFailure?.(
      requestId,
      reason,
      "The voice failure could not be added to bounded conversation history. This copy is retained here for recovery.",
    );
    return failed;
  }

  failPendingResponses(reason: string): number {
    let failed = 0;
    for (const [requestId, request] of this.requests) {
      const published = this.runtime.failAssistant(request, reason);
      if (published) failed += 1;
      else this.onPublicationFailure?.(
        requestId,
        reason,
        "The voice failure could not be added to bounded conversation history. This copy is retained here for recovery.",
      );
      this.requests.delete(requestId);
    }
    return failed;
  }

  buildContextFrame(): {
    type: "conversation_context";
    turns: PlannerConversationTurn[];
  } {
    return {
      type: "conversation_context",
      turns: this.runtime.plannerContext(),
    };
  }

  hasPendingRequest(requestId: string): boolean {
    return this.requests.has(requestId);
  }
}
