import type { CommandEnvelope, ConversationTurn, ExecuteCommandPayload, ExecuteCommandResult } from "./types/index.js";

export type CommandRequestInput = ExecuteCommandPayload & {
  source: NonNullable<ExecuteCommandPayload["source"]>;
  originDeviceId?: string;
};

export type CommandRequest = ExecuteCommandPayload & {
  source: CommandRequestInput["source"];
  language: string;
  requestId: string;
  idempotencyKey: string;
  conversationContext: ConversationTurn[];
  envelope: CommandEnvelope;
};

/** Voice is the reference contract. Text uses the same fields and empty history. */
export function createCommandRequest(input: CommandRequestInput, now = Date.now()): CommandRequest {
  const requestId = input.requestId || input.envelope?.requestId || globalThis.crypto.randomUUID();
  const idempotencyKey = input.idempotencyKey || input.envelope?.idempotencyKey || `${input.source}:${requestId}`;
  const language = input.language || "en";
  return {
    command: input.command,
    source: input.source,
    language,
    conversationContext: input.conversationContext || [],
    requestId,
    idempotencyKey,
    envelope: {
      requestId,
      idempotencyKey,
      originDeviceId: input.originDeviceId || input.envelope?.originDeviceId || "desktop-local",
      command: input.command,
      createdAt: input.envelope?.createdAt ?? now,
      expiresAt: input.envelope?.expiresAt ?? now + 5 * 60 * 1000,
      schemaVersion: "1.0",
      source: input.source,
      language,
    },
    // Keep unavailable optional metadata explicit rather than inventing values.
    sentiment: input.sentiment ?? null,
  };
}

/** Shared by the voice client, native text bridge, and browser text preview. */
export async function submitCommandRequest(baseUrl: string, input: CommandRequestInput): Promise<ExecuteCommandResult> {
  const body = createCommandRequest(input);
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Orchestrator error HTTP ${res.status}`);
  const result = await res.json() as ExecuteCommandResult;
  return { ...result, requestId: body.requestId };
}
