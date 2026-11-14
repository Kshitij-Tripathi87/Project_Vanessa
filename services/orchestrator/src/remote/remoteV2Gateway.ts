import { randomBytes, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import {
  PRE_SESSION_ID,
  RemoteSessionGuard,
  computeKeyId,
  createRemoteEnvelope,
  decodeRemoteEnvelope,
  normalizeIdentityPublicKey,
  safeParseRemotePayload,
  type RemoteEnvelope,
  type RemoteMessageType,
  type RemoteProtocolErrorCode,
  type RemoteTaskState,
} from "@vanessa/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { MobileTaskRecord } from "../core/mobileTaskEngine.js";
import type { RemotePairingRegistry } from "./remotePairingRegistry.js";
import type { RemoteTaskService } from "./remoteTaskService.js";

const MAX_CONNECTIONS = 5;
const MAX_MESSAGES_PER_SECOND = 20;
const SESSION_TTL_MS = 30 * 60_000;
const HANDSHAKE_TTL_MS = 90_000;
const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "timed_out"]);
const REMOTE_ERROR_CODES = new Set<RemoteProtocolErrorCode>([
  "INVALID_MESSAGE", "UNSUPPORTED_VERSION", "UNKNOWN_MESSAGE_TYPE", "PAYLOAD_TOO_LARGE",
  "INVALID_PAYLOAD", "MALFORMED_SIGNATURE", "SESSION_REQUIRED", "SESSION_EXPIRED",
  "INVALID_SIGNATURE", "UNKNOWN_KEY", "REVOKED_DEVICE", "STALE_MESSAGE", "REPLAYED_MESSAGE",
  "SEQUENCE_OUT_OF_ORDER", "RATE_LIMITED", "PAIRING_CODE_INVALID", "PAIRING_EXPIRED",
  "PAIRING_ALREADY_CLAIMED", "PAIRING_DENIED", "PAIRING_STATE_INVALID", "PAIRING_PROOF_INVALID",
  "PERMISSION_DENIED", "CAPABILITY_DISABLED", "SCOPE_REQUIRED", "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED", "CONFIRMATION_MISMATCH", "INVALID_ARGUMENTS", "TASK_NOT_FOUND",
  "TASK_CANCELLED", "TASK_TIMEOUT", "TASK_NOT_CANCELLABLE", "TASK_FAILED", "PC_BUSY",
  "IDEMPOTENCY_CONFLICT", "PC_OFFLINE", "INTERNAL_ERROR",
]);

export type RemoteEnvelopeSigner = (unsignedEnvelope: Omit<RemoteEnvelope, "auth">) => Promise<RemoteEnvelope>;

export type RemoteV2GatewayOptions = {
  host: string;
  port: number;
  pcId: string;
  pcName: string;
  pcKeyId: string;
  pcPublicKeySpki: string;
  sign: RemoteEnvelopeSigner;
  pairings: RemotePairingRegistry;
  tasks: RemoteTaskService;
  now?: () => number;
  onPairingPending?: (pairingId: string) => void;
};

type ConnectionState = "awaiting_auth" | "awaiting_pairing" | "awaiting_pairing_approval" | "ready" | "closed";

type PeerConnection = {
  socket: WebSocket;
  state: ConnectionState;
  sessionId: string;
  serverNonce: string;
  inboundGuard?: RemoteSessionGuard;
  keyId?: string;
  deviceId?: string;
  sessionExpiresAt?: number;
  eventSeq: number;
  outboundSequences: Map<string, number>;
  messageTimes: number[];
  pendingPairingId?: string;
  pendingTaskEvents: Map<string, { task: MobileTaskRecord; ephemeralResult?: unknown }>;
  acceptedTasks: Set<string>;
  handshakeTimer?: NodeJS.Timeout;
  sessionTimer?: NodeJS.Timeout;
  inboundTail: Promise<void>;
  outboundTail: Promise<void>;
};

function isTailnetIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const octets = address.split(".").map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function taskState(state: string): RemoteTaskState {
  const states: Record<string, RemoteTaskState> = {
    queued: "queued", validating: "validating", awaiting_confirm: "awaiting_approval",
    running: "running", verifying: "verifying", done: "succeeded", failed: "failed",
    cancelled: "cancelled", timed_out: "timed_out",
  };
  return states[state] ?? "unknown";
}

function compactResult(capability: string, value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, any>;
  let compact: Record<string, unknown> | undefined;
  switch (capability) {
    case "system_status": {
      const cpu = result.cpu && typeof result.cpu === "object" ? result.cpu : {};
      const memory = result.memory && typeof result.memory === "object" ? result.memory : {};
      compact = {
        ...(typeof result.platform === "string" ? { platform: result.platform.slice(0, 30) } : {}),
        ...(typeof cpu.model === "string" ? { cpu: {
          model: cpu.model.slice(0, 100),
          ...(Number.isFinite(cpu.logicalCores) ? { logicalCores: cpu.logicalCores } : {}),
          ...(Number.isFinite(cpu.usagePercent) || cpu.usagePercent === null ? { usagePercent: cpu.usagePercent } : {}),
        } } : {}),
        ...(Number.isFinite(memory.totalBytes) ? { memory: {
          totalBytes: memory.totalBytes,
          ...(Number.isFinite(memory.freeBytes) ? { freeBytes: memory.freeBytes } : {}),
          ...(Number.isFinite(memory.usedPercent) ? { usedPercent: memory.usedPercent } : {}),
        } } : {}),
        ...(result.battery && typeof result.battery === "object" ? { battery: {
          ...(Number.isFinite(result.battery.chargePercent) ? { chargePercent: result.battery.chargePercent } : {}),
          ...(Number.isFinite(result.battery.estimatedRunTimeMinutes) ? { estimatedRunTimeMinutes: result.battery.estimatedRunTimeMinutes } : {}),
        } } : {}),
        ...(Number.isFinite(result.capturedAt) ? { capturedAt: result.capturedAt } : {}),
      };
      break;
    }
    case "find_file":
      compact = {
        files: Array.isArray(result.files) ? result.files.slice(0, 20).flatMap((file: any) =>
          file && typeof file.name === "string"
            ? [{ name: file.name.slice(0, 180), ...(Number.isFinite(file.modifiedAt) ? { modifiedAt: file.modifiedAt } : {}), ...(Number.isFinite(file.size) ? { size: file.size } : {}) }]
            : [],
        ) : [],
        truncated: result.truncated === true,
      };
      break;
    case "open_app":
    case "open_url":
      compact = { launched: result.launched === true };
      break;
    case "open_file":
      compact = { opened: result.launched === true };
      break;
    case "set_volume":
      compact = { changed: result.changed === true || result.success === true, ...(Number.isFinite(result.volumePercent) ? { volumePercent: result.volumePercent } : {}) };
      break;
    case "media_control":
      compact = { completed: result.completed === true || result.success === true };
      break;
    case "lock_pc":
      compact = { locked: result.locked === true || result.success === true };
      break;
    case "take_screenshot":
      compact = { captured: result.captured === true || result.success === true };
      break;
  }
  return compact ? JSON.parse(JSON.stringify(compact)) as Record<string, unknown> : undefined;
}

/**
 * Authenticated protocol-v2 phone/PC gateway. It accepts only signed P-256
 * envelopes, pins device keys from the PC pairing registry, and resolves
 * capabilities/scopes in RemoteTaskService. No legacy HMAC route is exposed.
 */
export class RemoteV2Gateway {
  private server?: WebSocketServer;
  private readonly connections = new Set<PeerConnection>();
  private readonly pairingConnections = new Map<string, PeerConnection>();
  private readonly now: () => number;

  constructor(private readonly options: RemoteV2GatewayOptions) {
    this.now = options.now ?? Date.now;
    if (!(options.host === "127.0.0.1" || isTailnetIPv4(options.host))) {
      throw new Error("Remote v2 gateway may bind only to loopback tests or an assigned 100.64.0.0/10 Tailscale IPv4 address.");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error("Remote v2 gateway port is invalid.");
    }
    if (computeKeyId(normalizeIdentityPublicKey(options.pcPublicKeySpki)) !== options.pcKeyId) {
      throw new Error("PC public identity key does not match the configured keyId.");
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Remote v2 gateway is already running.");
    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      clientTracking: true,
      backlog: 16,
      // Browser-origin requests have no legitimate use: Android is a native
      // Ktor client. Reject them before allocating a peer slot (CSWSH/DoS).
      verifyClient: (info, callback) => {
        if (info.origin) {
          callback(false, 403, "Browser origins are not accepted");
          return;
        }
        callback(true);
      },
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
      });
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
    server.on("connection", (socket) => this.accept(socket));
  }

  address(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Remote v2 gateway is not listening.");
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const peer of this.connections) this.closePeer(peer, 1001, "Server shutting down");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async approvePairing(pairingId: string, grantedScopes: string[]) {
    const approved = await this.options.pairings.approve(pairingId, grantedScopes, this.now());
    const peer = this.pairingConnections.get(pairingId);
    this.pairingConnections.delete(pairingId);
    if (peer && peer.socket.readyState === WebSocket.OPEN && peer.state === "awaiting_pairing_approval") {
      await this.send(peer, "pairing.approved", approved, PRE_SESSION_ID);
      peer.pendingPairingId = undefined;
      await this.beginHandshake(peer);
    }
    return approved;
  }

  async rejectPairing(pairingId: string) {
    const rejected = this.options.pairings.reject(pairingId);
    const peer = this.pairingConnections.get(pairingId);
    this.pairingConnections.delete(pairingId);
    if (peer && peer.socket.readyState === WebSocket.OPEN) {
      await this.send(peer, "pairing.rejected", rejected, PRE_SESSION_ID);
      this.closePeer(peer, 1008, "Pairing rejected");
    }
    return rejected;
  }

  async closeDevice(keyId: string): Promise<void> {
    const targets = [...this.connections].filter((peer) => peer.keyId === keyId);
    for (const peer of targets) {
      if (peer.state === "ready") {
        await this.send(peer, "session.close", { reason: "revoked" }, peer.sessionId).catch(() => undefined);
      }
      this.closePeer(peer, 1008, "Device revoked");
    }
  }

  /** Called after the task engine has committed a state transition and audit row. */
  publishTask(event: { task: MobileTaskRecord; deviceId?: string; ephemeralResult?: unknown }): void {
    if (!event.deviceId) return;
    const peer = [...this.connections].find((candidate) => candidate.deviceId === event.deviceId && candidate.state === "ready");
    if (!peer) return;
    if (!peer.acceptedTasks.has(event.task.taskId)) {
      peer.pendingTaskEvents.set(event.task.taskId, event);
      return;
    }
    void this.publishTaskNow(peer, event).catch(() => this.closePeer(peer, 1011, "Task event delivery failed"));
  }

  private accept(socket: WebSocket): void {
    if (this.connections.size >= MAX_CONNECTIONS) {
      socket.close(1013, "Connection limit reached");
      return;
    }
    const peer: PeerConnection = {
      socket,
      state: "awaiting_auth",
      sessionId: randomUUID(),
      serverNonce: randomBytes(32).toString("base64url"),
      eventSeq: 0,
      outboundSequences: new Map(),
      messageTimes: [],
      pendingTaskEvents: new Map(),
      acceptedTasks: new Set(),
      inboundTail: Promise.resolve(),
      outboundTail: Promise.resolve(),
    };
    this.connections.add(peer);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.closePeer(peer, 1003, "Only UTF-8 JSON text frames are accepted");
        return;
      }
      peer.inboundTail = peer.inboundTail.then(() => this.handleFrame(peer, data)).catch(async (error: unknown) => {
        const candidate = (error as { code?: unknown } | null)?.code;
        const code = typeof candidate === "string" && REMOTE_ERROR_CODES.has(candidate as RemoteProtocolErrorCode)
          ? candidate as RemoteProtocolErrorCode
          : "INVALID_MESSAGE";
        const safeMessage = code === "INVALID_MESSAGE"
          ? "The remote message could not be processed."
          : error instanceof Error ? error.message.slice(0, 240) : "The remote message was rejected.";
        await this.sendError(peer, code, safeMessage).catch(() => undefined);
        this.closePeer(peer, 1008, "Remote protocol message rejected");
      });
    });
    socket.on("close", () => this.cleanupPeer(peer));
    socket.on("error", () => this.cleanupPeer(peer));
    peer.handshakeTimer = setTimeout(() => {
      if (peer.state !== "ready" && peer.state !== "awaiting_pairing_approval") {
        this.closePeer(peer, 1008, "Handshake expired");
      }
    }, HANDSHAKE_TTL_MS);
    void this.beginHandshake(peer).catch(() => this.closePeer(peer, 1011, "Unable to establish a signed challenge"));
  }

  private async beginHandshake(peer: PeerConnection): Promise<void> {
    peer.sessionId = randomUUID();
    peer.serverNonce = randomBytes(32).toString("base64url");
    peer.inboundGuard = undefined;
    peer.keyId = undefined;
    peer.deviceId = undefined;
    peer.sessionExpiresAt = undefined;
    peer.state = "awaiting_auth";
    if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer);
    const now = this.now();
    await this.send(peer, "server.challenge", {
      serverNonce: peer.serverNonce,
      pcId: this.options.pcId,
      pcName: this.options.pcName.slice(0, 80) || "Vanessa PC",
      protocolVersion: 2,
      supportedVersions: [2],
      issuedAt: now,
      expiresAt: now + HANDSHAKE_TTL_MS,
      pairingRequired: true,
    }, peer.sessionId);
    peer.handshakeTimer = setTimeout(() => {
      if (peer.state === "awaiting_auth" || peer.state === "awaiting_pairing") {
        this.closePeer(peer, 1008, "Handshake expired");
      }
    }, HANDSHAKE_TTL_MS);
  }

  private async handleFrame(peer: PeerConnection, data: RawData): Promise<void> {
    if (peer.socket.readyState !== WebSocket.OPEN || peer.state === "closed") return;
    const now = this.now();
    peer.messageTimes = peer.messageTimes.filter((stamp) => now - stamp < 1000);
    if (peer.messageTimes.length >= MAX_MESSAGES_PER_SECOND) {
      await this.sendError(peer, "RATE_LIMITED", "Too many messages. Slow down.");
      this.closePeer(peer, 1008, "Rate limited");
      return;
    }
    peer.messageTimes.push(now);

    const envelope = decodeRemoteEnvelope(rawDataToBuffer(data));
    if (peer.state === "awaiting_auth" || peer.state === "awaiting_pairing") {
      if (envelope.type === "pairing.claim" && envelope.sessionId === PRE_SESSION_ID) {
        const challenge = this.options.pairings.claim(envelope, now);
        peer.state = "awaiting_pairing";
        peer.pendingPairingId = challenge.pairingId;
        await this.send(peer, "pairing.challenge", challenge, PRE_SESSION_ID);
        return;
      }
      if (envelope.type === "pairing.complete" && envelope.sessionId === PRE_SESSION_ID) {
        if (peer.state !== "awaiting_pairing" || !peer.pendingPairingId) {
          await this.sendError(peer, "PAIRING_STATE_INVALID", "No active pairing challenge exists.");
          return;
        }
        const pending = this.options.pairings.complete(envelope, now);
        peer.state = "awaiting_pairing_approval";
        this.pairingConnections.set(pending.pairingId, peer);
        peer.pendingPairingId = pending.pairingId;
        if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer);
        peer.handshakeTimer = setTimeout(() => {
          if (peer.state === "awaiting_pairing_approval") this.closePeer(peer, 1008, "Pairing approval expired");
        }, Math.max(1000, pending.expiresAt - now));
        await this.send(peer, "pairing.pending", pending, PRE_SESSION_ID);
        this.options.onPairingPending?.(pending.pairingId);
        return;
      }
      if (envelope.type === "client.authenticate") {
        await this.authenticate(peer, envelope);
        return;
      }
      await this.sendError(peer, "SESSION_REQUIRED", "Complete pairing or session authentication first.");
      return;
    }

    if (peer.state === "awaiting_pairing_approval") {
      await this.sendError(peer, "PAIRING_STATE_INVALID", "The PC must approve this phone before a session is created.");
      return;
    }
    if (peer.state !== "ready" || !peer.inboundGuard || !peer.keyId || !peer.deviceId) {
      await this.sendError(peer, "SESSION_REQUIRED", "An authenticated session is required.");
      return;
    }

    const trusted = this.options.pairings.getTrustedDeviceByKeyId(peer.keyId);
    if (!trusted || trusted.revoked) {
      await this.send(peer, "session.close", { reason: "revoked" }, peer.sessionId).catch(() => undefined);
      this.closePeer(peer, 1008, "Device revoked");
      return;
    }
    if ((peer.sessionExpiresAt ?? 0) <= now) {
      await this.send(peer, "session.close", { reason: "expired" }, peer.sessionId).catch(() => undefined);
      this.closePeer(peer, 1008, "Session expired");
      return;
    }

    const verified = peer.inboundGuard.verifyAndAccept(envelope, now);
    if (!verified.accepted) {
      const code: RemoteProtocolErrorCode =
        verified.reason === "replayed_message" ? "REPLAYED_MESSAGE" :
        verified.reason === "sequence_out_of_order" ? "SEQUENCE_OUT_OF_ORDER" :
        verified.reason === "stale_message" || verified.reason === "future_message" ? "STALE_MESSAGE" :
        verified.reason === "unknown_key" ? "UNKNOWN_KEY" :
        verified.reason === "wrong_session" ? "SESSION_REQUIRED" :
        verified.reason === "wrong_direction" ? "INVALID_MESSAGE" :
        verified.reason === "invalid_payload" ? "INVALID_PAYLOAD" : "INVALID_SIGNATURE";
      await this.sendError(peer, code, "The signed message did not pass session verification.");
      this.closePeer(peer, 1008, "Session verification failed");
      return;
    }
    await this.dispatch(peer, verified.envelope.type, verified.payload as Record<string, unknown>);
  }

  private async authenticate(peer: PeerConnection, envelope: RemoteEnvelope): Promise<void> {
    if (peer.state !== "awaiting_auth" || envelope.sessionId !== peer.sessionId) {
      await this.sendError(peer, "SESSION_REQUIRED", "The session challenge is no longer active.");
      return;
    }
    const parsed = safeParseRemotePayload("client.authenticate", envelope.payload);
    if (!parsed.success) {
      await this.sendError(peer, "INVALID_PAYLOAD", "Authentication payload is invalid.");
      this.closePeer(peer, 1008, "Invalid authentication payload");
      return;
    }
    const payload = parsed.data;
    if (payload.serverNonce !== peer.serverNonce) {
      await this.sendError(peer, "INVALID_SIGNATURE", "The server challenge does not match this connection.");
      this.closePeer(peer, 1008, "Challenge mismatch");
      return;
    }

    const publicKey = normalizeIdentityPublicKey(payload.publicKey);
    const derivedKeyId = computeKeyId(publicKey);
    if (derivedKeyId !== envelope.keyId) {
      await this.sendError(peer, "INVALID_SIGNATURE", "Phone key ID does not match its public key.");
      this.closePeer(peer, 1008, "Identity mismatch");
      return;
    }
    const device = this.options.pairings.getTrustedDeviceByKeyId(derivedKeyId);
    if (!device) {
      await this.sendError(peer, "UNKNOWN_KEY", "This phone is not paired with this PC.");
      this.closePeer(peer, 1008, "Unknown phone identity");
      return;
    }
    if (device.revoked) {
      await this.sendError(peer, "REVOKED_DEVICE", "This phone has been revoked on the PC.");
      this.closePeer(peer, 1008, "Device revoked");
      return;
    }

    const guard = new RemoteSessionGuard({
      sessionId: peer.sessionId,
      keyId: derivedKeyId,
      publicKey,
      direction: "client_to_server",
      lastAcceptedSequence: envelope.sequence - 1,
      maxMessageAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    });
    const result = guard.verifyAndAccept(envelope, this.now());
    if (!result.accepted) {
      await this.sendError(peer, "INVALID_SIGNATURE", "Phone authentication signature was rejected.");
      this.closePeer(peer, 1008, "Authentication failed");
      return;
    }

    peer.inboundGuard = guard;
    peer.keyId = derivedKeyId;
    peer.deviceId = device.deviceId;
    peer.state = "ready";
    peer.sessionExpiresAt = this.now() + SESSION_TTL_MS;
    if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer);
    peer.handshakeTimer = undefined;
    peer.sessionTimer = setTimeout(() => {
      if (peer.state === "ready") {
        void this.send(peer, "session.expiring", {
          expiresAt: peer.sessionExpiresAt,
          renewWithinMs: 60_000,
          reason: "expiring",
        }, peer.sessionId).catch(() => undefined);
        this.closePeer(peer, 1008, "Session expired");
      }
    }, SESSION_TTL_MS);

    const manifest = this.options.tasks.manifestSnapshot(derivedKeyId);
    await this.send(peer, "session.ready", {
      sessionId: peer.sessionId,
      deviceId: device.deviceId,
      grantedScopes: device.grantedScopes,
      manifestVersion: manifest.manifestVersion,
      serverEventSeq: peer.eventSeq,
      serverNonce: peer.serverNonce,
      clientNonce: payload.clientNonce,
      issuedAt: this.now(),
      expiresAt: peer.sessionExpiresAt,
    }, peer.sessionId);
  }

  private async dispatch(peer: PeerConnection, type: RemoteMessageType, payload: Record<string, unknown>): Promise<void> {
    if (!peer.keyId) return;
    try {
      switch (type) {
        case "manifest.get": {
          const snapshot = this.options.tasks.manifestSnapshot(peer.keyId);
          await this.send(peer, "manifest.snapshot", snapshot, peer.sessionId);
          return;
        }
        case "task.submit": {
          const submitted = await this.options.tasks.submitTask(peer.keyId, payload);
          peer.acceptedTasks.add(submitted.accepted.taskId);
          await this.send(peer, "task.accepted", submitted.accepted, peer.sessionId);
          if (submitted.confirmationRequired) {
            await this.send(peer, "task.confirmation_required", {
              ...submitted.confirmationRequired,
              eventSeq: ++peer.eventSeq,
            }, peer.sessionId);
          }
          const pending = peer.pendingTaskEvents.get(submitted.accepted.taskId);
          peer.pendingTaskEvents.delete(submitted.accepted.taskId);
          if (pending) await this.publishTaskNow(peer, pending);
          return;
        }
        case "task.cancel": {
          const acknowledgement = await this.options.tasks.cancelTask(peer.keyId, payload);
          await this.send(peer, "task.cancel_ack", acknowledgement, peer.sessionId);
          return;
        }
        case "task.confirmation_response":
          // Approved destructive work remains blocked until a separate,
          // enrolled Android Keystore biometric proof is wired and verified.
          await this.options.tasks.confirmTask(peer.keyId, payload);
          return;
        case "sync.resume":
          await this.send(peer, "sync.snapshot", {
            lastEventSeq: peer.eventSeq,
            historyGap: true,
            tasks: [],
            events: [],
          }, peer.sessionId);
          await this.send(peer, "sync.complete", {
            lastEventSeq: peer.eventSeq,
            resumedAt: this.now(),
            sessionExpiresAt: peer.sessionExpiresAt ?? this.now(),
          }, peer.sessionId);
          return;
        case "ping":
          await this.send(peer, "pong", { sentAt: Number(payload.sentAt), receivedAt: this.now() }, peer.sessionId);
          return;
        default:
          await this.sendError(peer, "INVALID_MESSAGE", "This message is not supported by the remote PC gateway.");
      }
    } catch (error) {
      const rawCode = (error as { code?: unknown })?.code;
      const code = typeof rawCode === "string" && REMOTE_ERROR_CODES.has(rawCode as RemoteProtocolErrorCode)
        ? rawCode as RemoteProtocolErrorCode
        : "INTERNAL_ERROR";
      const message = code === "INTERNAL_ERROR"
        ? "The PC could not complete this remote request."
        : (error instanceof Error ? error.message : "The request was rejected.").slice(0, 300);
      if (type === "task.submit" || type === "task.confirmation_response" || type === "task.cancel") {
        await this.send(peer, "task.error", {
          ...(typeof payload.taskId === "string" ? { taskId: payload.taskId } : {}),
          code,
          message,
          retryable: ["PC_BUSY", "PC_OFFLINE"].includes(code),
        }, peer.sessionId);
      } else {
        await this.sendError(peer, code, message);
      }
    }
  }

  private async publishTaskNow(peer: PeerConnection, event: { task: MobileTaskRecord; ephemeralResult?: unknown }): Promise<void> {
    const task = event.task;
    const state = taskState(task.state);
    const eventSeq = ++peer.eventSeq;
    if (TERMINAL_STATES.has(task.state)) {
      const succeeded = task.state === "done";
      const result = compactResult(task.tool, task.result ?? event.ephemeralResult);
      await this.send(peer, "task.result", {
        taskId: task.taskId,
        status: succeeded ? "succeeded" : task.state === "cancelled" ? "cancelled" : task.state === "timed_out" ? "timed_out" : "failed",
        verification: {
          status: succeeded ? "verified" : "failed",
          summary: succeeded ? "The PC-side verifier accepted the operation result." : "The task ended without a verified successful result.",
        },
        safeSummary: succeeded ? `"${task.tool}" completed and passed PC verification.` : `"${task.tool}" did not complete successfully.`,
        ...(result ? { result } : {}),
        eventSeq,
        completedAt: this.now(),
      }, peer.sessionId);
      return;
    }
    if (task.state === "awaiting_confirm") return;
    await this.send(peer, "task.progress", {
      taskId: task.taskId,
      state,
      eventSeq,
      safeSummary: `"${task.tool}" is ${task.state.replace(/_/g, " ")} on the PC.`,
    }, peer.sessionId);
  }

  private async sendError(peer: PeerConnection, code: RemoteProtocolErrorCode, message: string): Promise<void> {
    await this.send(peer, "protocol.error", { code, message: message.slice(0, 300) }, peer.state === "ready" ? peer.sessionId : PRE_SESSION_ID);
  }

  private send(
    peer: PeerConnection,
    type: RemoteMessageType,
    payload: Record<string, unknown>,
    sessionId = peer.sessionId,
  ): Promise<void> {
    // Serialize signature requests and wire writes per socket. Without this,
    // concurrent task and heartbeat events could leave the receiver observing
    // valid signatures in sequence order 2,1 and rejecting the second frame.
    const queued = peer.outboundTail.then(async () => {
      if (peer.socket.readyState !== WebSocket.OPEN || peer.state === "closed") return;
      const sequence = peer.outboundSequences.get(sessionId) ?? 0;
      peer.outboundSequences.set(sessionId, sequence + 1);
      const unsigned = createRemoteEnvelope({
        type,
        payload,
        keyId: this.options.pcKeyId,
        sessionId,
        sequence,
      });
      const signed = await this.options.sign(unsigned);
      if (peer.socket.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve, reject) => {
          peer.socket.send(JSON.stringify(signed), (error) => error ? reject(error) : resolve());
        });
      }
    });
    peer.outboundTail = queued.catch(() => undefined);
    return queued;
  }

  private cleanupPeer(peer: PeerConnection): void {
    this.connections.delete(peer);
    if (peer.pendingPairingId && this.pairingConnections.get(peer.pendingPairingId) === peer) {
      this.pairingConnections.delete(peer.pendingPairingId);
    }
    peer.state = "closed";
    if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer);
    if (peer.sessionTimer) clearTimeout(peer.sessionTimer);
  }

  private closePeer(peer: PeerConnection, code: number, reason: string): void {
    if (peer.state === "closed") return;
    peer.state = "closed";
    if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer);
    if (peer.sessionTimer) clearTimeout(peer.sessionTimer);
    try {
      if (peer.socket.readyState === WebSocket.OPEN || peer.socket.readyState === WebSocket.CONNECTING) {
        peer.socket.close(code, reason.slice(0, 120));
      }
    } catch {
      peer.socket.terminate();
    }
    this.cleanupPeer(peer);
  }
}
