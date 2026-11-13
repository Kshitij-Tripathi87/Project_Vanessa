import type { KeyObject } from "node:crypto";
import {
  safeParseRemoteEnvelope,
  type RemoteEnvelope,
} from "./envelope.ts";
import {
  REMOTE_MESSAGE_DIRECTIONS,
  safeParseRemotePayload,
  type RemoteMessageType,
  type RemotePayload,
} from "./messages.ts";
import {
  computeKeyId,
  isSupportedIdentityKey,
  normalizeIdentityPublicKey,
  verifyRemoteEnvelopeSignature,
  type PublicKeyInput,
} from "./signatures.ts";

export type RemoteSessionDirection = "client_to_server" | "server_to_client";

export type RemoteSessionRejectReason =
  | "invalid_envelope"
  | "wrong_session"
  | "unknown_key"
  | "wrong_direction"
  | "invalid_payload"
  | "stale_message"
  | "future_message"
  | "replayed_message"
  | "sequence_out_of_order"
  | "invalid_signature";

export type RemoteSessionGuardResult =
  | { accepted: true; envelope: RemoteEnvelope; payload: RemotePayload }
  | { accepted: false; reason: RemoteSessionRejectReason };

export type RemoteSessionGuardOptions = {
  sessionId: string;
  keyId: string;
  publicKey: PublicKeyInput;
  direction?: RemoteSessionDirection;
  lastAcceptedSequence?: number;
  maxMessageAgeMs?: number;
  maxFutureSkewMs?: number;
  maxRememberedMessageIds?: number;
};

/**
 * Stateful verifier for one authenticated v2 session and one message direction.
 *
 * Instantiate only after the handshake has pinned the peer's P-256 public key
 * and allocated a session ID. The class validates the envelope and its
 * message-specific payload, then checks direction, signature, clock skew,
 * sequence and replay. Anti-replay state changes only after every check passes.
 */
export class RemoteSessionGuard {
  private readonly publicKey: KeyObject;
  private readonly direction: RemoteSessionDirection;
  private readonly maxMessageAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly maxRememberedMessageIds: number;
  private highestAcceptedSequence: number;
  private readonly seenMessageIds = new Set<string>();
  private readonly messageOrder: string[] = [];
  private readonly options: RemoteSessionGuardOptions;

  constructor(options: RemoteSessionGuardOptions) {
    this.options = options;
    this.publicKey = normalizeIdentityPublicKey(options.publicKey);
    if (!isSupportedIdentityKey(this.publicKey)) {
      throw new Error("Remote session identity must be a public P-256 key.");
    }
    if (computeKeyId(this.publicKey) !== options.keyId) {
      throw new Error("Remote session keyId does not match its pinned public key.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.sessionId)) {
      throw new Error("Remote session ID must be a lowercase UUID.");
    }

    this.direction = options.direction ?? "client_to_server";
    this.highestAcceptedSequence = options.lastAcceptedSequence ?? -1;
    this.maxMessageAgeMs = options.maxMessageAgeMs ?? 60_000;
    this.maxFutureSkewMs = options.maxFutureSkewMs ?? 5_000;
    this.maxRememberedMessageIds = options.maxRememberedMessageIds ?? 2_048;

    if (!Number.isInteger(this.highestAcceptedSequence) ||
        this.highestAcceptedSequence < -1 ||
        this.highestAcceptedSequence > 2_147_483_647) {
      throw new Error("Initial sequence is outside protocol bounds.");
    }
    if (!Number.isSafeInteger(this.maxMessageAgeMs) || this.maxMessageAgeMs <= 0) {
      throw new Error("Maximum message age must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.maxFutureSkewMs) || this.maxFutureSkewMs < 0) {
      throw new Error("Future clock skew must be a nonnegative safe integer.");
    }
    if (!Number.isInteger(this.maxRememberedMessageIds) || this.maxRememberedMessageIds < 1) {
      throw new Error("Replay cache size must be a positive integer.");
    }
  }

  verifyAndAccept(value: unknown, nowMs = Date.now()): RemoteSessionGuardResult {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("Current time must be a nonnegative safe integer.");
    }

    const parsed = safeParseRemoteEnvelope(value);
    if (!parsed.success) return { accepted: false, reason: "invalid_envelope" };
    const envelope = parsed.data;

    if (envelope.sessionId !== this.options.sessionId) {
      return { accepted: false, reason: "wrong_session" };
    }
    if (envelope.keyId !== this.options.keyId) {
      return { accepted: false, reason: "unknown_key" };
    }

    const direction = REMOTE_MESSAGE_DIRECTIONS[envelope.type as RemoteMessageType];
    if (direction !== "bidirectional" && direction !== this.direction) {
      return { accepted: false, reason: "wrong_direction" };
    }

    const payload = safeParseRemotePayload(envelope.type, envelope.payload);
    if (!payload.success) {
      return { accepted: false, reason: "invalid_payload" };
    }

    if (envelope.sentAt < nowMs && nowMs - envelope.sentAt > this.maxMessageAgeMs) {
      return { accepted: false, reason: "stale_message" };
    }
    if (envelope.sentAt > nowMs && envelope.sentAt - nowMs > this.maxFutureSkewMs) {
      return { accepted: false, reason: "future_message" };
    }
    if (this.seenMessageIds.has(envelope.messageId)) {
      return { accepted: false, reason: "replayed_message" };
    }
    if (envelope.sequence <= this.highestAcceptedSequence) {
      return { accepted: false, reason: "sequence_out_of_order" };
    }

    if (!verifyRemoteEnvelopeSignature(this.publicKey, envelope).ok) {
      return { accepted: false, reason: "invalid_signature" };
    }

    this.highestAcceptedSequence = envelope.sequence;
    this.remember(envelope.messageId);
    return { accepted: true, envelope, payload: payload.data as RemotePayload };
  }

  getLastAcceptedSequence(): number {
    return this.highestAcceptedSequence;
  }

  private remember(messageId: string): void {
    this.seenMessageIds.add(messageId);
    this.messageOrder.push(messageId);
    while (this.messageOrder.length > this.maxRememberedMessageIds) {
      const oldest = this.messageOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }
}
