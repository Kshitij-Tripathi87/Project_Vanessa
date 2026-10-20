import { EventEmitter } from "node:events";
import { EventType, VanessaEvent, AgentMessage } from "@vanessa/shared";

class VanessaEventBus extends EventEmitter {
  private auditLog: Array<{ timestamp: number; type: EventType; payload: any }> = [];

  emitEvent<T = any>(type: EventType, payload: T): boolean {
    const event: VanessaEvent<T> = {
      type,
      payload,
      timestamp: Date.now(),
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

  publishAgentMessage(message: AgentMessage) {
    this.emitEvent("agent:message", message);
  }
}

export const eventBus = new VanessaEventBus();
export const publishAgentMessage = (message: AgentMessage) => eventBus.publishAgentMessage(message);
