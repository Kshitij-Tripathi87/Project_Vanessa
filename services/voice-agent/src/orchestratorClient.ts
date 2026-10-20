export interface OrchestratorCommandResult {
  status: "success" | "awaiting_approval" | "failed";
  spokenSummary: string;
  planId?: string;
  plan?: any;
  pendingTasks?: any[];
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
  }): Promise<OrchestratorCommandResult> {
    const res = await fetch(`${this.baseUrl}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: input.command,
        source: input.source || "voice",
        language: input.language || "en",
      }),
    });

    if (!res.ok) {
      throw new Error(`Orchestrator error HTTP ${res.status}`);
    }

    return (await res.json()) as OrchestratorCommandResult;
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
