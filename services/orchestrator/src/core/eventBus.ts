import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { EventType, VanessaEvent, AgentMessage } from "@vanessa/shared";

function safeCodexParams(params: any) {
  return {
    projectPath: params?.projectPath,
    expectedBranch: params?.expectedBranch,
    timeoutMs: params?.timeoutMs,
    prompt: "[redacted]",
    promptCharacters: typeof params?.prompt === "string" ? params.prompt.length : 0,
    acceptanceCriteriaCount: Array.isArray(params?.acceptanceCriteria) ? params.acceptanceCriteria.length : 0,
    allowedPathsCount: Array.isArray(params?.allowedPaths) ? params.allowedPaths.length : 0,
  };
}

function sanitizeEventPayload(type: EventType, payload: any): any {
  // Coding prompts may contain proprietary source context. Keep them in the active
  // process only; never broadcast or persist the full prompt through task events.
  if (payload && typeof payload === "object" && payload.action === "codex.run_task" && payload.params) {
    return { ...payload, params: safeCodexParams(payload.params) };
  }
  if (type === "tool.started" && payload?.tool === "codex.run_task" && payload.params) {
    return { ...payload, params: safeCodexParams(payload.params) };
  }
  return payload;
}

class VanessaEventBus extends EventEmitter {
  private auditLog: Array<VanessaEvent> = [];
  private sequence = 0;

  emitEvent<T = any>(type: EventType, payload: T): boolean {
    const safePayload = sanitizeEventPayload(type, payload);
    const event: VanessaEvent<T> = {
      type,
      payload: safePayload,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      eventId: randomUUID(),
      requestId: (payload as any)?.requestId,
      taskId: (payload as any)?.taskId || (payload as any)?.id,
    };
    this.auditLog.push(event);
    if (this.auditLog.length > 500) {
      this.auditLog.shift();
    }
    return this.emit(type, event);
  }

  onEvent<T = any>(type: EventType, listener: (event: VanessaEvent<T>) => void): this {
    return this.on(type, listener);
  }

  getRecentEvents(limit: number = 50): Array<VanessaEvent> {
    return this.auditLog.slice(-limit);
  }

  getEventsAfter(sequence: number): Array<VanessaEvent> {
    return this.auditLog.filter((event) => (event.sequence || 0) > sequence);
  }

  publishAgentMessage(message: AgentMessage) {
    this.emitEvent("agent:message", message);
  }
}

export const eventBus = new VanessaEventBus();
export const publishAgentMessage = (message: AgentMessage) => eventBus.publishAgentMessage(message);
