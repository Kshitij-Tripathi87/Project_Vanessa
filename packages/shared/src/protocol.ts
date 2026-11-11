import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const PROTOCOL_VERSION = 1 as const;

export const ErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_MESSAGE_TYPE",
  "UNAUTHORIZED_DEVICE",
  "INVALID_SIGNATURE",
  "STALE_MESSAGE",
  "REPLAYED_MESSAGE",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "INVALID_ARGUMENTS",
  "PERMISSION_DENIED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "TASK_NOT_FOUND",
  "TASK_CANCELLED",
  "TASK_FAILED",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const BaseMessage = z.object({ v: z.literal(PROTOCOL_VERSION), id: z.string().uuid() }).strict();
const TaskId = z.string().uuid();

export const ProtocolMessageSchema = z.discriminatedUnion("type", [
  BaseMessage.extend({ type: z.literal("task.submit"), idempotencyKey: z.string().min(1).max(128), tool: z.string().min(1).max(80), args: z.record(z.unknown()), createdAt: z.number().int().nonnegative() }).strict(),
  BaseMessage.extend({ type: z.literal("task.accepted"), taskId: TaskId }).strict(),
  BaseMessage.extend({ type: z.literal("task.progress"), taskId: TaskId, state: z.enum(["queued", "validating", "awaiting_confirm", "running", "verifying"]), message: z.string().max(500).optional() }).strict(),
  BaseMessage.extend({ type: z.literal("task.confirm_required"), taskId: TaskId, summary: z.string().min(1).max(500), actionHash: z.string().min(16).max(128), expiresAt: z.number().int().positive() }).strict(),
  BaseMessage.extend({ type: z.literal("task.confirm"), taskId: TaskId, approved: z.boolean(), actionHash: z.string().min(16).max(128) }).strict(),
  BaseMessage.extend({ type: z.literal("task.result"), taskId: TaskId, status: z.enum(["done", "partial"]), result: z.unknown() }).strict(),
  BaseMessage.extend({ type: z.literal("task.error"), taskId: TaskId.optional(), code: ErrorCodeSchema, message: z.string().max(500) }).strict(),
  BaseMessage.extend({ type: z.literal("task.cancel"), taskId: TaskId }).strict(),
  BaseMessage.extend({ type: z.literal("manifest.sync"), manifestVersion: z.string().min(1).max(80), tools: z.array(z.object({ name: z.string().min(1), description: z.string().min(1), argsSchema: z.record(z.unknown()), tier: z.number().int().min(0).max(2) }).strict()) }).strict(),
  BaseMessage.extend({ type: z.literal("event.push"), event: z.string().min(1).max(80), payload: z.record(z.unknown()) }).strict(),
  BaseMessage.extend({ type: z.literal("ping"), sentAt: z.number().int().nonnegative() }).strict(),
]);

export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;
export type MessageType = ProtocolMessage["type"];

export function parseProtocolMessage(value: unknown): ProtocolMessage {
  return ProtocolMessageSchema.parse(value);
}

export function toJsonSchema(): Record<string, unknown> {
  return {
    title: "VanessaProtocolMessage",
    ...zodToJsonSchema(ProtocolMessageSchema, "VanessaProtocolMessage") as Record<string, unknown>,
  };
}
