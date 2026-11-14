import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecuteCommandPayload, ExecuteCommandResult } from "@vanessa/shared";
import type { MobileTool, MobileToolContext } from "./mobileToolRegistry.js";

const AssistantCommandArgs = z.object({
  command: z.string().trim().min(1).max(4_000),
  language: z.string().trim().min(2).max(32).optional(),
}).strict();

const COMMAND_OUTCOMES = new Set(["success", "partial", "failed", "awaiting_approval", "accepted"]);

export type AssistantCommandProgress = {
  deviceId?: string;
  taskId?: string;
  state: "planning" | "running" | "verifying";
  safeSummary: string;
};

export function createMobileAssistantCommandTool(
  executeCommand: (payload: ExecuteCommandPayload) => Promise<ExecuteCommandResult>,
  cancelRequest: (requestId: string) => Promise<unknown>,
  notifyProgress?: (event: AssistantCommandProgress) => void,
): MobileTool<z.infer<typeof AssistantCommandArgs>> {
  return {
    name: "assistant_command",
    description: "Submit natural-language requests to the central Vanessa orchestrator. The orchestrator plans and routes work to specialist agents; PC policy and approvals remain authoritative.",
    argsSchema: AssistantCommandArgs,
    manifestSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 4000 },
        language: { type: "string", minLength: 2, maxLength: 32 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    tier: 1,
    timeoutMs: 9 * 60_000,
    idempotent: false,
    queue: "ui",
    handler: async (args, context: MobileToolContext) => {
      if (context.signal.aborted) {
        throw Object.assign(new Error("Remote assistant request was cancelled."), { code: "TASK_CANCELLED" });
      }
      const requestId = randomUUID();
      const owner = {
        ...(context.deviceId ? { deviceId: context.deviceId } : {}),
        ...(context.taskId ? { taskId: context.taskId } : {}),
      };
      notifyProgress?.({
        ...owner, state: "planning",
        safeSummary: "The laptop orchestrator received the request and is building an agent plan.",
      });
      const onAbort = () => { void cancelRequest(requestId).catch(() => undefined); };
      context.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await executeCommand({
          command: args.command, language: args.language ?? "en", source: "phone", requestId,
        });
        notifyProgress?.({
          ...owner, state: "verifying",
          safeSummary: "The orchestrator returned a structured outcome. Review its verification status in the result.",
        });
        return result;
      } finally {
        context.signal.removeEventListener("abort", onAbort);
      }
    },
    // Verifies delivery of a complete typed orchestrator outcome. The nested
    // status and verification are preserved rather than rewritten as success.
    verifier: async (_args, result) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return false;
      const outcome = result as Partial<ExecuteCommandResult>;
      return typeof outcome.status === "string" &&
        COMMAND_OUTCOMES.has(outcome.status) &&
        typeof outcome.spokenSummary === "string" &&
        outcome.spokenSummary.trim().length > 0;
    },
  };
}
