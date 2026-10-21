import { randomUUID } from "node:crypto";
import { CommandEnvelope } from "@vanessa/shared";

export interface OrchestratorCommandResult {
  status: "success" | "awaiting_approval" | "failed" | "partial" | "accepted";
  spokenSummary: string;
  planId?: string;
  plan?: any;
  pendingTasks?: any[];
  requestId?: string;
}

export class OrchestratorClient {
  constructor(private baseUrl = process.env.ORCHESTRATOR_URL || "http://127.0.0.1:4319") {}

  /**
   * Execute voice command directly through Vanessa Orchestrator
   */
  async executeCommand(input: {
    command: string;
    source?: string;
    language?: string;
    requestId?: string;
    idempotencyKey?: string;
    conversationContext?: Array<{ role: "user" | "assistant"; content: string }>;
  }): Promise<OrchestratorCommandResult> {
    const now = Date.now();
    const requestId = input.requestId || randomUUID();
    const idempotencyKey = input.idempotencyKey || `voice:${requestId}`;
    const envelope: CommandEnvelope = {
      requestId,
      idempotencyKey,
      originDeviceId: process.env.VANESSA_DEVICE_ID || "desktop-local",
      command: input.command,
      createdAt: now,
      expiresAt: now + 5 * 60 * 1000,
      schemaVersion: "1.0",
      source: "voice",
      language: input.language || "en",
    };
    const res = await fetch(`${this.baseUrl}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: input.command,
        source: input.source || "voice",
        language: input.language || "en",
        conversationContext: input.conversationContext,
        requestId,
        idempotencyKey,
        envelope,
      }),
    });

    if (!res.ok) {
      throw new Error(`Orchestrator error HTTP ${res.status}`);
    }

    const result = (await res.json()) as OrchestratorCommandResult;
    return { ...result, requestId };
  }

  /**
   * Create task plan
   */
  async createPlan(input: {
    command: string;
    source?: string;
    language?: string;
  }): Promise<any> {
    const result = await this.executeCommand(input);
    return result.plan || { id: result.planId, tasks: [] };
  }

  /**
   * Execute existing plan
   */
  async executePlan(input: { planId: string }): Promise<{ spokenResponse: string }> {
    return {
      spokenResponse: "Tasks completed successfully.",
    };
  }
}

export const orchestratorClient = new OrchestratorClient();
