import { z } from "zod";

/**
 * Protocol v2 payload schemas for the authenticated phone <-> PC listener.
 *
 * Two rules are load-bearing and are enforced by the shapes below:
 * 1. The PC resolves permission tier, scope and policy. A payload that tries to
 *    assert them is rejected — every payload object is `.strict()`, so an
 *    unexpected field fails validation instead of being trusted or ignored.
 * 2. Nothing here may carry a secret or raw content. `task.submit` carries
 *    normalized arguments only; `task.result` carries a compact, safe summary.
 *    Length bounds are tight so one control message cannot displace the rest.
 */

/** Protocol version for the authenticated remote listener (gateway/relay). */
export const REMOTE_PROTOCOL_VERSION = 2 as const;

/** Versions this package can speak. The first entry is the preferred one. */
export const SUPPORTED_REMOTE_PROTOCOL_VERSIONS = [2] as const;

/** Maximum nesting depth accepted in a bounded JSON value (arguments, results). */
export const MAX_JSON_DEPTH = 6;

/* ------------------------------------------------------------------ *
 * Primitives shared by every payload
 * ------------------------------------------------------------------ */

/**
 * Canonical lowercase UUID text. Zod's `.uuid()` alone accepts mixed case, and
 * two spellings of one id would canonicalize to different bytes — and therefore
 * different signatures — so lowercase is enforced here.
 */
export const UuidSchema = z.string().uuid().regex(/^[0-9a-f-]+$/, "Expected a lowercase UUID.");

/** Unix epoch milliseconds. Bounded so the value always fits a JS safe integer. */
export const EpochMsSchema = z.number().int().min(0).max(8.64e15);

/** Base64url without padding (RFC 4648 §5). */
export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "Expected unpadded base64url.");

/** Lowercase hex of fixed length (SHA-256 digests, action hashes). */
export const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a 64-character hex digest.");

/** Opaque identifier: no whitespace, printable ASCII only. */
export const OpaqueIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** A declared permission scope, e.g. `media_control` or `files.read`. */
export const ScopeSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

/** Capability name: the stable id of an executable action. */
export const CapabilityNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Short human-readable text that the phone is allowed to display aloud. */
export const SafeTextSchema = z.string().min(1).max(300);

const jsonLeaf: z.ZodTypeAny = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function jsonValueAtDepth(depth: number): z.ZodTypeAny {
  if (depth <= 0) return jsonLeaf;
  return z.union([jsonLeaf, z.array(jsonValueAtDepth(depth - 1)), z.record(jsonValueAtDepth(depth - 1))]);
}

/**
 * A JSON value nested at most MAX_JSON_DEPTH levels deep. The 64 KiB envelope
 * bound caps total size; this caps structural depth so parsing, canonicalizing
 * and rendering cannot be driven into unbounded recursion by a hostile peer.
 */
export const BoundedJsonSchema = jsonValueAtDepth(MAX_JSON_DEPTH);

/** A record with a hard bound on member count and key length. */
function boundedRecord<V extends z.ZodTypeAny>(
  value: V,
  maxKeys: number,
  keyMaxLength = 64,
): z.ZodEffects<z.ZodRecord<z.ZodString, V>> {
  return z
    .record(value)
    .refine(
      (record) => {
        const keys = Object.keys(record);
        return keys.length <= maxKeys && keys.every((key) => key.length <= keyMaxLength);
      },
      { message: `object exceeds ${maxKeys} members or a ${keyMaxLength}-character key.` },
    );
}

/* ------------------------------------------------------------------ *
 * Enums carried by more than one message
 * ------------------------------------------------------------------ */

/**
 * Permission tiers. The PC NEVER accepts a tier from the client: the tier in a
 * manifest entry is a description of what the PC will do, resolved PC-side from
 * capability + actual target. T3 is blacklisted to PC-local execution only.
 */
export const RemotePermissionTierSchema = z.enum(["T0", "T1", "T2", "T3"]);
export type RemotePermissionTier = z.infer<typeof RemotePermissionTierSchema>;

/** Task lifecycle states (protocol v2). */
export const RemoteTaskStateSchema = z.enum([
  "accepted",
  "queued",
  "planning",
  "validating",
  "awaiting_input",
  "awaiting_approval",
  "running",
  "verifying",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "unknown",
]);
export type RemoteTaskState = z.infer<typeof RemoteTaskStateSchema>;

/** Terminal outcome reported by `task.result`. */
export const TaskResultStatusSchema = z.enum([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "unknown",
]);
export type TaskResultStatus = z.infer<typeof TaskResultStatusSchema>;

/** Typed error codes. Every rejection the remote listener can produce is listed. */
export const RemoteProtocolErrorCodeSchema = z.enum([
  // Message-level
  "INVALID_MESSAGE",
  "UNSUPPORTED_VERSION",
  "UNKNOWN_MESSAGE_TYPE",
  "PAYLOAD_TOO_LARGE",
  "INVALID_PAYLOAD",
  "MALFORMED_SIGNATURE",
  // Authentication & replay
  "SESSION_REQUIRED",
  "SESSION_EXPIRED",
  "INVALID_SIGNATURE",
  "UNKNOWN_KEY",
  "REVOKED_DEVICE",
  "STALE_MESSAGE",
  "REPLAYED_MESSAGE",
  "SEQUENCE_OUT_OF_ORDER",
  "RATE_LIMITED",
  // Pairing
  "PAIRING_CODE_INVALID",
  "PAIRING_EXPIRED",
  "PAIRING_ALREADY_CLAIMED",
  "PAIRING_DENIED",
  "PAIRING_STATE_INVALID",
  "PAIRING_PROOF_INVALID",
  // Authorization & policy
  "PERMISSION_DENIED",
  "CAPABILITY_DISABLED",
  "SCOPE_REQUIRED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_MISMATCH",
  // Task
  "INVALID_ARGUMENTS",
  "TASK_NOT_FOUND",
  "TASK_CANCELLED",
  "TASK_TIMEOUT",
  "TASK_NOT_CANCELLABLE",
  "TASK_FAILED",
  "PC_BUSY",
  "IDEMPOTENCY_CONFLICT",
  // System
  "PC_OFFLINE",
  "INTERNAL_ERROR",
]);
export type RemoteProtocolErrorCode = z.infer<typeof RemoteProtocolErrorCodeSchema>;

/* ------------------------------------------------------------------ *
 * Domain objects
 * ------------------------------------------------------------------ */

/** What an action will touch, stated plainly for display before approval. */
export const TargetDescriptorSchema = z
  .object({
    kind: z.enum(["app", "url", "file", "setting", "media", "system", "other"]),
    value: z.string().min(1).max(300),
  })
  .strict();
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;

/**
 * One executable capability as advertised to the phone.
 * `argumentsSchema` is the JSON Schema the PC will validate `arguments` against.
 */
export const RemoteCapabilitySchema = z
  .object({
    name: CapabilityNameSchema,
    version: z.number().int().min(1).max(1000),
    description: z.string().min(1).max(300),
    tier: RemotePermissionTierSchema,
    scopes: z.array(ScopeSchema).max(32),
    idempotent: z.boolean(),
    timeoutMs: z.number().int().min(1).max(600_000),
    argumentsSchema: z.record(z.unknown()),
  })
  .strict();
export type RemoteCapability = z.infer<typeof RemoteCapabilitySchema>;

/** How a result was verified, plus the evidence a human can check. */
export const VerificationSchema = z
  .object({
    status: z.enum(["verified", "partial", "not_available", "failed"]),
    summary: z.string().min(1).max(300),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;

/** A snapshot of one task, sent on connect and after every state change. */
export const TaskSnapshotSchema = z
  .object({
    taskId: UuidSchema,
    requestId: UuidSchema,
    capability: CapabilityNameSchema,
    state: RemoteTaskStateSchema,
    tier: RemotePermissionTierSchema,
    taskVersion: z.number().int().min(1).max(1_000_000),
    acceptedAt: EpochMsSchema,
    updatedAt: EpochMsSchema,
    completedAt: EpochMsSchema.optional(),
    safeSummary: z.string().min(1).max(500),
  })
  .strict();
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

/**
 * One workflow event. `safePayload` is a flat description for the timeline —
 * never raw tool output, never file contents, never secrets.
 */
export const TaskEventSchema = z
  .object({
    eventId: UuidSchema,
    eventSeq: z.number().int().min(0),
    taskId: UuidSchema,
    type: z.string().min(1).max(40),
    state: RemoteTaskStateSchema,
    safePayload: boundedRecord(z.string().min(1).max(200), 16, 40),
    at: EpochMsSchema,
  })
  .strict();
export type TaskEvent = z.infer<typeof TaskEventSchema>;

/**
 * An approval request. `actionHash` binds the approval to the exact arguments,
 * target, capability and policy version, so a confirmation cannot be replayed
 * against a different action.
 */
export const ApprovalRequestSchema = z
  .object({
    approvalId: UuidSchema,
    taskId: UuidSchema,
    taskVersion: z.number().int().min(1).max(1_000_000),
    deviceId: OpaqueIdSchema,
    capability: CapabilityNameSchema,
    capabilityVersion: z.number().int().min(1).max(1000),
    consequence: z.string().min(1).max(500),
    target: TargetDescriptorSchema,
    actionHash: HexSha256Schema,
    policyVersion: z.string().min(1).max(40),
    expiresAt: EpochMsSchema,
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * The exact field set that `computeActionHash` hashes. `canonicalArguments`
 * must be the parsed `task.submit` arguments object (not a JSON string), so the
 * PC and the phone hash the same value. The JCS bytes of this object are the
 * SHA-256 preimage.
 */
export const ApprovalBindingSchema = z
  .object({
    taskId: UuidSchema,
    taskVersion: z.number().int().min(1).max(1_000_000),
    capability: CapabilityNameSchema,
    capabilityVersion: z.number().int().min(1).max(1000),
    canonicalArguments: z.record(z.unknown()),
    target: TargetDescriptorSchema,
    policyVersion: z.string().min(1).max(40),
    expiresAt: EpochMsSchema,
  })
  .strict();
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

/** A pairing nonce exchange record, used for challenge/response proof. */
export const PairingNonceSchema = z
  .object({
    nonce: Base64UrlSchema.min(16).max(128),
    issuedAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Message types and payload schemas
 * ------------------------------------------------------------------ */

export const REMOTE_MESSAGE_TYPES = [
  // handshake / session
  "server.challenge",
  "client.authenticate",
  "session.ready",
  "session.expiring",
  "session.close",
  "protocol.error",
  // pairing
  "pairing.claim",
  "pairing.challenge",
  "pairing.complete",
  "pairing.pending",
  "pairing.approved",
  "pairing.rejected",
  "pairing.expired",
  // capabilities
  "manifest.get",
  "manifest.snapshot",
  "manifest.changed",
  // tasks
  "task.submit",
  "task.accepted",
  "task.snapshot",
  "task.progress",
  "task.confirmation_required",
  "task.confirmation_response",
  "task.cancel",
  "task.cancel_ack",
  "task.result",
  "task.error",
  // reconnect
  "sync.resume",
  "sync.snapshot",
  "sync.event",
  "sync.complete",
  // keepalive
  "ping",
  "pong",
] as const;

export const RemoteMessageTypeSchema = z.enum(REMOTE_MESSAGE_TYPES);
export type RemoteMessageType = z.infer<typeof RemoteMessageTypeSchema>;

/** Who is allowed to send each type. The listener rejects the wrong direction. */
export const REMOTE_MESSAGE_DIRECTIONS: Record<RemoteMessageType, "client_to_server" | "server_to_client" | "bidirectional"> = {
  "server.challenge": "server_to_client",
  "client.authenticate": "client_to_server",
  "session.ready": "server_to_client",
  "session.expiring": "server_to_client",
  "session.close": "server_to_client",
  "protocol.error": "server_to_client",
  "pairing.claim": "client_to_server",
  "pairing.challenge": "server_to_client",
  "pairing.complete": "client_to_server",
  "pairing.pending": "server_to_client",
  "pairing.approved": "server_to_client",
  "pairing.rejected": "server_to_client",
  "pairing.expired": "server_to_client",
  "manifest.get": "client_to_server",
  "manifest.snapshot": "server_to_client",
  "manifest.changed": "server_to_client",
  "task.submit": "client_to_server",
  "task.accepted": "server_to_client",
  "task.snapshot": "server_to_client",
  "task.progress": "server_to_client",
  "task.confirmation_required": "server_to_client",
  "task.confirmation_response": "client_to_server",
  "task.cancel": "client_to_server",
  "task.cancel_ack": "server_to_client",
  "task.result": "server_to_client",
  "task.error": "server_to_client",
  "sync.resume": "client_to_server",
  "sync.snapshot": "server_to_client",
  "sync.event": "server_to_client",
  "sync.complete": "server_to_client",
  ping: "bidirectional",
  pong: "bidirectional",
};

const DeviceHintSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const PlatformSchema = z.enum(["android", "desktop", "web", "unknown"]);

/* ---------------------------- handshake/session --------------------------- */

const ServerChallengePayload = z
  .object({
    serverNonce: Base64UrlSchema.min(16).max(128),
    pcId: OpaqueIdSchema,
    pcName: z.string().min(1).max(80),
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    supportedVersions: z.array(z.number().int()).max(8),
    issuedAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
    /** Loopback pairing hint; never a LAN address that could be probed. */
    pairingRequired: z.boolean(),
  })
  .strict();

const ClientAuthenticatePayload = z
  .object({
    serverNonce: Base64UrlSchema.min(16).max(128),
    clientNonce: Base64UrlSchema.min(16).max(128),
    publicKey: Base64UrlSchema.min(46).max(400),
    /** Hint only; the PC looks the device up by the envelope keyId. */
    deviceHint: DeviceHintSchema.optional(),
    platform: PlatformSchema,
    appVersion: z.string().min(1).max(40),
    requestedScopes: z.array(ScopeSchema).max(32).optional(),
  })
  .strict();

const SessionReadyPayload = z
  .object({
    sessionId: UuidSchema,
    deviceId: OpaqueIdSchema,
    grantedScopes: z.array(ScopeSchema).max(32),
    manifestVersion: z.string().min(1).max(80),
    serverEventSeq: z.number().int().min(0),
    serverNonce: Base64UrlSchema.min(16).max(128),
    clientNonce: Base64UrlSchema.min(16).max(128),
    issuedAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
  })
  .strict();

const SessionExpiringPayload = z
  .object({
    expiresAt: EpochMsSchema,
    renewWithinMs: z.number().int().min(1000).max(86_400_000),
    reason: z.enum(["expiring", "policy_changed", "device_revoked"]),
  })
  .strict();

const SessionClosePayload = z
  .object({
    reason: z.enum(["revoked", "expired", "protocol_error", "server_shutdown", "client_replaced"]),
    detail: z.string().max(200).optional(),
  })
  .strict();

const ProtocolErrorPayload = z
  .object({
    code: RemoteProtocolErrorCodeSchema,
    /** Safe to display. Never a stack trace, path or internal identifier. */
    message: z.string().min(1).max(300),
    taskId: UuidSchema.optional(),
    approvalId: UuidSchema.optional(),
  })
  .strict();

/* -------------------------------- pairing --------------------------------- */

const PairingClaimPayload = z
  .object({
    pairingId: OpaqueIdSchema,
    code: z.string().min(10).max(64).regex(/^[A-Za-z0-9-]+$/),
    publicKey: Base64UrlSchema.min(46).max(400),
    keyId: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
    deviceHint: DeviceHintSchema,
    platform: PlatformSchema,
    appVersion: z.string().min(1).max(40),
    /** Fresh phone nonce echoed by the PC to bind the proof exchange. */
    clientNonce: Base64UrlSchema.min(16).max(128).optional(),
    /** Optional separate P-256 key used only for biometric-bound approvals. */
    approvalPublicKey: Base64UrlSchema.min(46).max(400).optional(),
    approvalKeyId: OpaqueIdSchema.optional(),
  })
  .strict()
  .refine((value) => (value.approvalPublicKey === undefined) === (value.approvalKeyId === undefined), {
    message: "Biometric approval public key and keyId must be supplied together.",
  });

const PairingChallengePayload = z
  .object({
    pairingId: OpaqueIdSchema,
    nonce: Base64UrlSchema.min(16).max(128),
    issuedAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
    clientNonce: Base64UrlSchema.min(16).max(128),
  })
  .strict();

const PairingCompletePayload = z
  .object({
    pairingId: OpaqueIdSchema,
    challengeNonce: Base64UrlSchema.min(16).max(128),
  })
  .strict();

const PairingPendingPayload = z
  .object({
    pairingId: OpaqueIdSchema,
    state: z.enum(["awaiting_approval", "approved", "rejected"]),
    expiresAt: EpochMsSchema,
  })
  .strict();

const PairingApprovedPayload = z
  .object({
    deviceId: OpaqueIdSchema,
    keyId: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
    grantedScopes: z.array(ScopeSchema).max(32),
    sessionExpiresAt: EpochMsSchema,
    serverNonce: Base64UrlSchema.min(16).max(128),
    clientNonce: Base64UrlSchema.min(16).max(128),
  })
  .strict();

const PairingRejectedPayload = z
  .object({
    pairingId: OpaqueIdSchema,
    reason: z.enum(["declined_on_pc", "code_mismatch", "pc_locked", "too_many_devices"]),
  })
  .strict();

const PairingExpiredPayload = z
  .object({
    pairingId: OpaqueIdSchema,
  })
  .strict();

/* ------------------------------- capabilities ----------------------------- */

const ManifestGetPayload = z.object({}).strict();

const ManifestSnapshotPayload = z
  .object({
    manifestVersion: z.string().min(1).max(80),
    generatedAt: EpochMsSchema,
    capabilities: z.array(RemoteCapabilitySchema).max(200),
    policyVersion: z.string().min(1).max(40),
  })
  .strict();

const ManifestChangedPayload = z
  .object({
    manifestVersion: z.string().min(1).max(80),
    policyVersion: z.string().min(1).max(40),
    changedAt: EpochMsSchema,
  })
  .strict();

/* ---------------------------------- tasks -------------------------------- */

const TaskSubmitPayload = z
  .object({
    requestId: UuidSchema,
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/),
    capability: CapabilityNameSchema,
    /** Normalized action arguments. No secrets, no secrets-bearing paths. */
    canonicalArguments: boundedRecord(z.unknown(), 32),
    /** Optional natural-language hint from the router; never a command line. */
    intent: z.string().max(300).optional(),
  })
  .strict();

const TaskAcceptedPayload = z
  .object({
    requestId: UuidSchema,
    taskId: UuidSchema,
    state: z.literal("accepted"),
    taskVersion: z.number().int().min(1).max(1_000_000),
    eventSeq: z.number().int().min(0),
    acceptedAt: EpochMsSchema,
  })
  .strict();

const TaskSnapshotPayload = z
  .object({
    task: TaskSnapshotSchema,
    eventSeq: z.number().int().min(0),
  })
  .strict();

const TaskProgressPayload = z
  .object({
    taskId: UuidSchema,
    state: RemoteTaskStateSchema,
    eventSeq: z.number().int().min(0),
    safeSummary: z.string().min(1).max(500),
    percentComplete: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const TaskConfirmationRequiredPayload = z
  .object({
    approval: ApprovalRequestSchema,
    eventSeq: z.number().int().min(0),
  })
  .strict();

const TaskConfirmationResponsePayload = z
  .object({
    approvalId: UuidSchema,
    taskId: UuidSchema,
    actionHash: HexSha256Schema,
    decision: z.enum(["approved", "denied"]),
    approvedAt: EpochMsSchema,
    /** Method used to authorize, e.g. `biometric_strong` or `pc_local`. */
    method: z.string().min(3).max(40),
    /** Signature made by a distinct per-use biometric-authenticated key. */
    biometricProof: z.object({
      approvalKeyId: OpaqueIdSchema,
      signature: Base64UrlSchema.min(16).max(200),
    }).strict().optional(),
  })
  .strict();

const TaskCancelPayload = z
  .object({
    taskId: UuidSchema,
    requestId: UuidSchema,
    reason: z.string().max(120).optional(),
  })
  .strict();

const TaskCancelAckPayload = z
  .object({
    taskId: UuidSchema,
    outcome: z.enum(["cancelled", "completed", "too_late", "partially_effective"]),
    state: RemoteTaskStateSchema,
    detail: z.string().max(200).optional(),
  })
  .strict();

const TaskResultPayload = z
  .object({
    taskId: UuidSchema,
    status: TaskResultStatusSchema,
    verification: VerificationSchema,
    /** Compact outcome text. Raw tool output is not sent over this message. */
    safeSummary: z.string().min(1).max(500),
    result: BoundedJsonSchema.optional(),
    eventSeq: z.number().int().min(0),
    completedAt: EpochMsSchema,
  })
  .strict();

const TaskErrorPayload = z
  .object({
    taskId: UuidSchema.optional(),
    code: RemoteProtocolErrorCodeSchema,
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
  })
  .strict();

/* -------------------------------- reconnect ------------------------------- */

const SyncResumePayload = z
  .object({
    lastEventSeq: z.number().int().min(0),
    activeTaskIds: z.array(UuidSchema).max(50),
    clientNonce: Base64UrlSchema.min(16).max(128),
  })
  .strict();

const SyncSnapshotPayload = z
  .object({
    lastEventSeq: z.number().int().min(0),
    /** True when the PC no longer holds events the client missed. */
    historyGap: z.boolean(),
    tasks: z.array(TaskSnapshotSchema).max(50),
    events: z.array(TaskEventSchema).max(200),
  })
  .strict();

const SyncEventPayload = z
  .object({
    event: TaskEventSchema,
  })
  .strict();

const SyncCompletePayload = z
  .object({
    lastEventSeq: z.number().int().min(0),
    resumedAt: EpochMsSchema,
    sessionExpiresAt: EpochMsSchema,
  })
  .strict();

/* ------------------------------- keepalive -------------------------------- */

const PingPayload = z
  .object({
    sentAt: EpochMsSchema,
    nonce: Base64UrlSchema.min(8).max(64).optional(),
  })
  .strict();

const PongPayload = z
  .object({
    sentAt: EpochMsSchema,
    receivedAt: EpochMsSchema,
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Payload registry
 * ------------------------------------------------------------------ */

/**
 * Payload schema for each message type, keyed by `type`.
 * Validate a payload with `parseRemotePayload(type, payload)`.
 */
export const REMOTE_PAYLOAD_SCHEMAS = {
  "server.challenge": ServerChallengePayload,
  "client.authenticate": ClientAuthenticatePayload,
  "session.ready": SessionReadyPayload,
  "session.expiring": SessionExpiringPayload,
  "session.close": SessionClosePayload,
  "protocol.error": ProtocolErrorPayload,
  "pairing.claim": PairingClaimPayload,
  "pairing.challenge": PairingChallengePayload,
  "pairing.complete": PairingCompletePayload,
  "pairing.pending": PairingPendingPayload,
  "pairing.approved": PairingApprovedPayload,
  "pairing.rejected": PairingRejectedPayload,
  "pairing.expired": PairingExpiredPayload,
  "manifest.get": ManifestGetPayload,
  "manifest.snapshot": ManifestSnapshotPayload,
  "manifest.changed": ManifestChangedPayload,
  "task.submit": TaskSubmitPayload,
  "task.accepted": TaskAcceptedPayload,
  "task.snapshot": TaskSnapshotPayload,
  "task.progress": TaskProgressPayload,
  "task.confirmation_required": TaskConfirmationRequiredPayload,
  "task.confirmation_response": TaskConfirmationResponsePayload,
  "task.cancel": TaskCancelPayload,
  "task.cancel_ack": TaskCancelAckPayload,
  "task.result": TaskResultPayload,
  "task.error": TaskErrorPayload,
  "sync.resume": SyncResumePayload,
  "sync.snapshot": SyncSnapshotPayload,
  "sync.event": SyncEventPayload,
  "sync.complete": SyncCompletePayload,
  ping: PingPayload,
  pong: PongPayload,
} as const satisfies Record<RemoteMessageType, z.ZodTypeAny>;

export type RemotePayloadFor<T extends RemoteMessageType> = z.infer<(typeof REMOTE_PAYLOAD_SCHEMAS)[T]>;
export type RemotePayload = { [K in RemoteMessageType]: RemotePayloadFor<K> }[RemoteMessageType];

/** Parse a payload for a known message type. Throws a ZodError when invalid. */
export function parseRemotePayload<T extends RemoteMessageType>(type: T, payload: unknown): RemotePayloadFor<T> {
  return REMOTE_PAYLOAD_SCHEMAS[type].parse(payload) as RemotePayloadFor<T>;
}

/** Non-throwing variant returning the field paths that failed. */
export function safeParseRemotePayload<T extends RemoteMessageType>(
  type: T,
  payload: unknown,
): { success: true; data: RemotePayloadFor<T> } | { success: false; error: z.ZodError } {
  return REMOTE_PAYLOAD_SCHEMAS[type].safeParse(payload) as
    | { success: true; data: RemotePayloadFor<T> }
    | { success: false; error: z.ZodError };
}
