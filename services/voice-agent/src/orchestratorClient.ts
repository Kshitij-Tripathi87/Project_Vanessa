import { submitCommandRequest, type ExecuteCommandPayload, type ExecuteCommandResult } from "@vanessa/shared";

export type OrchestratorCommandResult = ExecuteCommandResult;

export class OrchestratorClient {
  constructor(private baseUrl = process.env.ORCHESTRATOR_URL || "http://127.0.0.1:4319") {}

  /**
   * Execute voice command directly through Vanessa Orchestrator
   */
  async executeCommand(input: {
    command: string;
    source?: ExecuteCommandPayload["source"];
    language?: string;
    requestId?: string;
    idempotencyKey?: string;
    conversationContext?: Array<{ role: "user" | "assistant"; content: string }>;
  }, signal?: AbortSignal): Promise<OrchestratorCommandResult> {
    return submitCommandRequest(this.baseUrl, {
      ...input,
      source: input.source || "voice",
      originDeviceId: process.env.VANESSA_DEVICE_ID || "desktop-local",
    }, signal);
  }

  async cancelRequest(requestId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/cancel/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Could not confirm request cancellation. Check the task timeline.");
  }

  /**
   * Create task plan
   */
  async createPlan(input: {
    command: string;
    source?: ExecuteCommandPayload["source"];
    language?: string;
  }): Promise<any> {
    const result = await this.executeCommand(input);
    return result.plan || { id: result.planId, tasks: [] };
  }

  /**
   * Execute existing plan
   */
  async executePlan(input: { planId: string }): Promise<{ spokenResponse: string }> {
    const planId = input.planId.trim();
    return {
      spokenResponse: planId
        ? `Direct execution of plan ${planId} is not implemented; submit the original command so the orchestrator can validate and execute it.`
        : "A plan ID is required. No task was executed.",
    };
  }
}

export const orchestratorClient = new OrchestratorClient();
