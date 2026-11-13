/**
 * LEGACY — protocol v1 (unauthenticated local loopback listener).
 *
 * Superseded by the v2 remote protocol (`./envelope.ts`, `./messages.ts`,
 * `./signatures.ts`) for everything the phone and PC exchange. v1 keeps only
 * the message types the desktop's existing loopback gateway speaks, and it is
 * retained so `apps/desktop` continues to build while its UI migrates.
 *
 * Do not extend v1:
 * - no signatures, no device identity, no per-session sequence numbers;
 * - 1 MiB frames instead of the 64 KiB control bound;
 * - the client is trusted with a permission tier, which v2 forbids.
 *
 * New code must use the v2 exports. This module is deleted once the desktop
 * HUD and the legacy `/api/remote/*` surface are converted.
 */

import { z, ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Vanessa Mobile + PC Protocol v1
 * Contract-first message schemas for phone <-> PC communication
 *
 * Architecture:
 * - Phone (Kotlin): voice front-end, LFM3 router, bridge client
 * - PC (Electron + Node): gateway, execution control, tools, brain
 * - Link: Tailscale mesh, WebSocket, JSON messages, signed per message
 */

export const PROTOCOL_VERSION = 1 as const;

// Error codes enum - covers all failure modes from the plan
export const ErrorCodeSchema = z.enum([
  // Message validation
  "INVALID_MESSAGE",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_MESSAGE_TYPE",
  "PAYLOAD_TOO_LARGE",

  // Authentication & security
  "UNAUTHORIZED_DEVICE",
  "INVALID_SIGNATURE",
  "STALE_MESSAGE",
  "REPLAYED_MESSAGE",
  "REVOKED_DEVICE",

  // Rate limiting & throttling
  "RATE_LIMITED",

  // Task execution
  "INVALID_ARGUMENTS",
  "PERMISSION_DENIED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_TIMEOUT",
  "TASK_NOT_FOUND",
  "TASK_CANCELLED",
  "TASK_TIMEOUT",
  "TASK_FAILED",
  "TOOL_NOT_FOUND",
  "TOOL_DISABLED",

  // System errors
  "INTERNAL_ERROR",
  "PC_OFFLINE",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// Base message with version and id
const BaseMessageSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().uuid(),
  timestamp: z.number().int().positive(), // Unix epoch ms
});

const TaskIdSchema = z.string().uuid();

// Task lifecycle states
export const TaskStateSchema = z.enum([
  "queued",
  "validating",
  "awaiting_confirm",
  "running",
  "verifying",
  "done",
  "failed",
  "cancelled",
  "timed_out",
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

// Permission tiers (PC decides, phone never asserts)
export const PermissionTierSchema = z.enum([
  "T0", // Auto - read-only, no side effects
  "T1", // Auto, logged - system changes, logged
  "T2", // Confirm - destructive, requires biometric
]);

export type PermissionTier = z.infer<typeof PermissionTierSchema>;

// Tool definition for manifest
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  argsSchema: z.record(z.unknown()),
  tier: PermissionTierSchema,
  idempotent: z.boolean(),
  timeout: z.number().int().positive(), // seconds
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// Message types - following the plan's protocol spec
export const ProtocolMessageSchema = z.discriminatedUnion("type", [
  // task.submit - phone initiates a task
  BaseMessageSchema.extend({
    type: z.literal("task.submit"),
    idempotencyKey: z.string().min(1).max(128),
    tool: z.string().min(1).max(80),
    args: z.record(z.unknown()),
    signature: z.string().min(1), // HMAC-SHA256 signature
    nonce: z.string().min(1), // replay-prevention nonce
  }).strict(),

  // task.accepted - PC accepted the task
  BaseMessageSchema.extend({
    type: z.literal("task.accepted"),
    taskId: TaskIdSchema,
  }).strict(),

  // task.progress - streaming state updates
  BaseMessageSchema.extend({
    type: z.literal("task.progress"),
    taskId: TaskIdSchema,
    state: TaskStateSchema,
    message: z.string().max(500).optional(),
    nonce: z.string().min(1), // replay-prevention nonce
  }).strict(),

  // task.confirm_required - Tier 2 requires confirmation
  BaseMessageSchema.extend({
    type: z.literal("task.confirm_required"),
    taskId: TaskIdSchema,
    summary: z.string().min(1).max(500), // Human-readable, exact target
    actionHash: z.string().min(16).max(128), // Hash of the action to confirm
    expiresAt: z.number().int().positive(), // Unix epoch ms
  }).strict(),

  // task.confirm - phone sends biometric-backed confirmation
  BaseMessageSchema.extend({
    type: z.literal("task.confirm"),
    taskId: TaskIdSchema,
    approved: z.boolean(),
    actionHash: z.string().min(16).max(128),
    signature: z.string().min(1), // Signed confirmation
    nonce: z.string().min(1), // replay-prevention nonce
  }).strict(),

  // task.result - task completed successfully
  BaseMessageSchema.extend({
    type: z.literal("task.result"),
    taskId: TaskIdSchema,
    status: z.enum(["done", "partial"]),
    result: z.unknown(), // Tool-specific result structure
  }).strict(),

  // task.error - task failed
  BaseMessageSchema.extend({
    type: z.literal("task.error"),
    taskId: TaskIdSchema.optional(),
    code: ErrorCodeSchema,
    message: z.string().max(500),
  }).strict(),

  // task.cancel - phone cancels a running task
  BaseMessageSchema.extend({
    type: z.literal("task.cancel"),
    taskId: TaskIdSchema,
    signature: z.string().min(1),
    nonce: z.string().min(1), // replay-prevention nonce
  }).strict(),

  // manifest.sync - PC sends tool manifest to phone
  BaseMessageSchema.extend({
    type: z.literal("manifest.sync"),
    manifestVersion: z.string().min(1).max(80),
    tools: z.array(ToolDefinitionSchema),
  }).strict(),

  // event.push - PC sends proactive events
  BaseMessageSchema.extend({
    type: z.literal("event.push"),
    event: z.string().min(1).max(80),
    payload: z.record(z.unknown()),
  }).strict(),

  // ping - keepalive
  BaseMessageSchema.extend({
    type: z.literal("ping"),
    sentAt: z.number().int().nonnegative(),
  }).strict(),

  // pong - keepalive response
  BaseMessageSchema.extend({
    type: z.literal("pong"),
    receivedAt: z.number().int().nonnegative(),
  }).strict(),
]);

export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;
export type MessageType = ProtocolMessage["type"];

/**
 * Parse and validate a protocol message
 * Throws if invalid
 */
export function parseProtocolMessage(value: unknown): ProtocolMessage {
  return ProtocolMessageSchema.parse(value);
}

/**
 * Validate message size before parsing
 * Plan specifies 1 MB limit
 */
export function validateMessageSize(json: string): void {
  const MAX_MESSAGE_SIZE = 1024 * 1024; // 1 MB
  if (json.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes`);
  }
}

/**
 * Export JSON Schema for Kotlin codegen
 */
export function toJsonSchema(): Record<string, unknown> {
  // zod-to-json-schema cannot type-check the discriminated union at compile
  // time (TS2589 deep instantiation), so the schema is passed through `any`.
  // Runtime behaviour is correct and the schema is validated by the fixture
  // round-trip test in packages/shared.
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "VanessaProtocolV1",
    version: PROTOCOL_VERSION,
    ...zodToJsonSchema(ProtocolMessageSchema as any, "VanessaProtocolMessage"),
  };
}

/**
 * Helper to create base message fields
 */
export function createBaseMessage(): { v: 1; id: string; timestamp: number } {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
  };
}
