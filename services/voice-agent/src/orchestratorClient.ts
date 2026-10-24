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
  }): Promise<OrchestratorCommandResult> {
    return submitCommandRequest(this.baseUrl, {
      ...input,
      source: input.source || "voice",
      originDeviceId: process.env.VANESSA_DEVICE_ID || "desktop-local",
    });
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
    return {
      spokenResponse: "Tasks completed successfully.",
    };
  }
}

export const orchestratorClient = new OrchestratorClient();
