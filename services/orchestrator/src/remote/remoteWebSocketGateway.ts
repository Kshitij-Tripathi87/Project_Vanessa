import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PRE_SESSION_ID,
  decodeRemoteEnvelope,
  RemoteSessionGuard,
  computeKeyId,
  normalizeIdentityPublicKey,
  safeParseRemoteEnvelope,
  safeParseRemotePayload,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
  type RemoteMessageType,
  type RemotePayloadFor,
} from "@vanessa/protocol";
import type { RemotePairingRegistry, TrustedRemoteDevice } from "./remotePairingRegistry.js";
import type { RemoteTaskService } from "./remoteTaskService.js";

export type RemotePcPublicIdentity = {
  keyId: string;
  publicKeySpki: string;
  pcId: string;
  pcName: string;
};

export type RemoteEnvelopeSigner = {
  getIdentity(): Promise<RemotePcPublicIdentity>;
  sign(input: {
    type: RemoteMessageType;
    payload: Record<string, unknown>;
    sessionId: string;
    sequence: number;
  }): Promise<RemoteEnvelope>;
};

export type RemoteWebSocketGatewayOptions = {
  host: string;
  port: number;
  maxConnections?: number;
  maxMessagesPerSecond?: number;
  sessionTtlMs?: number;
  signer: RemoteEnvelopeSigner;
  pairings: RemotePairingRegistry;
  tasks: RemoteTaskService;
  now?: () => number;
};

type Connection = {
  id: string;
  ws: WebSocket;
  serverNonce: string;
  preSessionSequence: number;
  pairingId?: string;
  pairingClientNonce?: string;
  clientKeyId?: string;
  device?: TrustedRemoteDevice;
  sessionId?: string;
  sessionExpiresAt?: number;
  inboundGuard?: RemoteSessionGuard;
  outboundSequence: number;
  eventSequence: number;
  messageTimes: number[];
  authenticated: boolean;
  /** Serializes async signing/writes so clients always observe monotonic sequence order. */
  outboundTail: Promise<void>;
  /** Serializes inbound processing so guard acceptance and task dispatch preserve socket order. */
  inboundTail: Promise<void>;
  sessionExpiringTimer?: NodeJS.Timeout;
  sessionExpiryTimer?: NodeJS.Timeout;
};

const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_MESSAGES_PER_SECOND = 20;

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as any);
}

function isFresh(sentAt: number, now: number): boolean {
  return Number.isSafeInteger(sentAt) && sentAt <= now + 5_000 && now - sentAt <= 60_000;
}

function publicKeyMatches(stored: TrustedRemoteDevice, supplied: string): boolean {
  try {
    const publicKey = normalizeIdentityPublicKey(supplied);
    return computeKeyId(publicKey) === stored.keyId &&
      computeKeyId(stored.publicKeySpki) === stored.keyId;
  } catch {
    return false;
  }
}

function safeTransportResult(value: unknown): unknown {
  const visit = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") return input.slice(0, 1200);
    if (depth >= 6) return "[depth limit]";
    if (Array.isArray(input)) return input.slice(0, 40).map((item) => visit(item, depth + 1));
    if (input && typeof input === "object") {
      const entries = Object.entries(input as Record<string, unknown>).slice(0, 40);
      return Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 64), visit(item, depth + 1)]));
    }
    return null;
  };

  const candidate = visit(value, 0);
  try {
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= 8 * 1024) return candidate;
  } catch { /* omit unsupported values */ }
  return "[verified result omitted because it exceeds the remote result size limit]";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "INTERNAL_ERROR";
}

/**
 * Authenticated protocol-v2 WebSocket transport.
 *
 * The PC owns all authorization decisions. The only public listener is bound
 * to the exact address supplied by the caller (production must use the PC's
 * Tailscale IPv4 address); there is no wildcard bind and no v1/HMAC fallback.
 */
export class RemoteWebSocketGateway {
  private httpServer?: Server;
  private sockets?: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private readonly pairingConnections = new Map<string, string>();
  private readonly deviceConnections = new Map<string, string>();
  private readonly now: () => number;
  private readonly maxConnections: number;
  private readonly maxMessagesPerSecond: number;
  private readonly sessionTtlMs: number;
  private actualPort = 0;
  private pcIdentity?: RemotePcPublicIdentity;

  constructor(private readonly options: RemoteWebSocketGatewayOptions) {
    this.now = options.now ?? Date.now;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxMessagesPerSecond = options.maxMessagesPerSecond ?? DEFAULT_MESSAGES_PER_SECOND;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!options.host || ["0.0.0.0", "::", "::0"].includes(options.host)) {
      throw new Error("Remote v2 listener requires an explicit loopback or Tailscale interface address.");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error("Remote v2 listener port is invalid.");
    }
  }

  async start(): Promise<void> {
    if (this.httpServer) throw new Error("Remote v2 gateway is already running.");
    const identity = await this.options.signer.getIdentity();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(identity.keyId) || computeKeyId(identity.publicKeySpki) !== identity.keyId) {
      throw new Error("The desktop signer returned an invalid PC identity.");
    }
    this.pcIdentity = identity;

    this.httpServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ status: "ok", protocol: 2, connections: this.connections.size }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/remote-v2") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (this.connections.size >= this.maxConnections) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.sockets!.handleUpgrade(request, socket, head, (ws) => {
        this.sockets!.emit("connection", ws, request);
      });
    });
    this.sockets.on("connection", (ws) => this.acceptSocket(ws));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(this.options.port, this.options.host, () => {
        this.httpServer!.off("error", reject);
        const address = this.httpServer!.address();
        this.actualPort = typeof address === "object" && address ? address.port : this.options.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.connections.values()) {
      this.clearSessionTimers(connection);
      try { connection.ws.close(1001, "Server shutting down"); } catch { /* best effort */ }
    }
    this.connections.clear();
    this.pairingConnections.clear();
    this.deviceConnections.clear();
    if (this.sockets) {
      await new Promise<void>((resolve) => this.sockets!.close(() => resolve()));
      this.sockets = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
  }

  getActualPort(): number { return this.actualPort; }

  getStatus(): { host: string; port: number; connections: number } {
    return { host: this.options.host, port: this.actualPort || this.options.port, connections: this.connections.size };
  }

  async approvePairing(
    pairingId: string,
    approved: RemotePayloadFor<"pairing.approved">,
  ): Promise<void> {
    const connectionId = this.pairingConnections.get(pairingId);
    const connection = connectionId ? this.connections.get(connectionId) : undefined;
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return;
    await this.sendPreSession(connection, "pairing.approved", approved as unknown as Record<string, unknown>);
    const device = this.options.pairings.getTrustedDeviceByKeyId(approved.keyId);
    if (!device || device.revoked) {
      await this.sendError(connection, "UNKNOWN_KEY", "The approved device is no longer trusted.");
      connection.ws.close(1008, "Device trust could not be established");
      return;
    }
    await this.establishSession(connection, device, approved.serverNonce, approved.clientNonce, approved.sessionExpiresAt);
    this.pairingConnections.delete(pairingId);
  }

  async rejectPairing(pairingId: string, rejected: RemotePayloadFor<"pairing.rejected">): Promise<void> {
    const connectionId = this.pairingConnections.get(pairingId);
    const connection = connectionId ? this.connections.get(connectionId) : undefined;
    this.pairingConnections.delete(pairingId);
    if (!connection) return;
    await this.sendPreSession(connection, "pairing.rejected", rejected as unknown as Record<string, unknown>);
    connection.ws.close(1008, "Pairing rejected on PC");
  }

  revokeDevice(deviceId: string): void {
    const connectionId = this.deviceConnections.get(deviceId);
    const connection = connectionId ? this.connections.get(connectionId) : undefined;
    if (!connection) return;
    void this.sendSession(connection, "session.close", {
      reason: "revoked",
      detail: "This phone was revoked on the PC.",
    }).finally(() => connection.ws.close(1008, "Device revoked"));
  }

  /** Publish task lifecycle only to the authenticated socket that owns the task. */
  publishTask(event: { task: { taskId: string; requestId: string; tool: string; state: string; error?: string; result?: unknown }; deviceId?: string }): void {
    if (!event.deviceId) return;
    const connectionId = this.deviceConnections.get(event.deviceId);
    const connection = connectionId ? this.connections.get(connectionId) : undefined;
    if (!connection?.authenticated || !connection.sessionId || connection.ws.readyState !== WebSocket.OPEN) return;
    const state = event.task.state;
    const safeSummary = (event.task.error ??
      (state === "done" ? `PC verified ${event.task.tool}.` : `PC task ${state.replace(/_/g, " ")}.`)).slice(0, 500);
    connection.eventSequence += 1;
    if (["done", "failed", "cancelled", "timed_out"].includes(state)) {
      void this.sendSession(connection, "task.result", {
        taskId: event.task.taskId,
        status: state === "done" ? "succeeded" : state === "cancelled" ? "cancelled" : state === "timed_out" ? "timed_out" : "failed",
        verification: {
          status: state === "done" ? "verified" : "failed",
          summary: state === "done" ? "The PC-side postcondition verifier passed." : "The task ended without a verified successful outcome.",
        },
        safeSummary,
        ...(state === "done" && event.task.result !== undefined
          ? { result: safeTransportResult(event.task.result) }
          : {}),
        eventSeq: connection.eventSequence,
        completedAt: this.now(),
      }).catch(() => undefined);
      return;
    }
    void this.sendSession(connection, "task.progress", {
      taskId: event.task.taskId,
      state: state === "awaiting_confirm" ? "awaiting_approval" : state,
      eventSeq: connection.eventSequence,
      safeSummary,
    }).catch(() => undefined);
  }

  private acceptSocket(ws: WebSocket): void {
    const connection: Connection = {
      id: randomUUID(),
      ws,
      serverNonce: randomBytes(32).toString("base64url"),
      preSessionSequence: 0,
      outboundSequence: 0,
      eventSequence: 0,
      messageTimes: [],
      authenticated: false,
      outboundTail: Promise.resolve(),
      inboundTail: Promise.resolve(),
    };
    this.connections.set(connection.id, connection);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "Binary frames are not supported");
        return;
      }
      connection.inboundTail = connection.inboundTail
        .then(() => this.handleFrame(connection, data))
        .catch(() => undefined);
    });
    ws.on("close", () => this.removeConnection(connection));
    ws.on("error", () => this.removeConnection(connection));
    void this.sendPreSession(connection, "server.challenge", {
      serverNonce: connection.serverNonce,
      pcId: this.pcIdentity?.pcId ?? "pc_unknown",
      pcName: this.pcIdentity?.pcName ?? "Vanessa PC",
      protocolVersion: 2,
      supportedVersions: [2],
      issuedAt: this.now(),
      expiresAt: this.now() + 60_000,
      pairingRequired: true,
    }).catch(() => ws.close(1011, "Could not establish the server challenge"));
  }

  private async handleFrame(connection: Connection, raw: RawData): Promise<void> {
    try {
      const now = this.now();
      connection.messageTimes = connection.messageTimes.filter((at) => at > now - 1000);
      if (connection.messageTimes.length >= this.maxMessagesPerSecond) {
        await this.sendError(connection, "RATE_LIMITED", "Too many messages.");
        connection.ws.close(1008, "Rate limit exceeded");
        return;
      }
      connection.messageTimes.push(now);

      const envelope = decodeRemoteEnvelope(asBuffer(raw));
      if (connection.authenticated) {
        await this.handleAuthenticatedFrame(connection, envelope);
      } else {
        await this.handlePreSessionFrame(connection, envelope);
      }
    } catch (error) {
      const code = errorCode(error);
      await this.sendError(connection, code, "The remote request was rejected.");
      if (["PAIRING_EXPIRED", "PAIRING_CODE_INVALID", "PAIRING_PROOF_INVALID", "INVALID_SIGNATURE", "REVOKED_DEVICE"].includes(code)) {
        connection.ws.close(1008, "Authentication failed");
      }
    }
  }

  private async handlePreSessionFrame(connection: Connection, envelope: RemoteEnvelope): Promise<void> {
    if (envelope.sessionId !== PRE_SESSION_ID || !isFresh(envelope.sentAt, this.now())) {
      throw Object.assign(new Error("Pre-session message is not fresh."), { code: "STALE_MESSAGE" });
    }

    if (envelope.type === "pairing.claim") {
      let response:
        | { type: "pairing.challenge"; payload: RemotePayloadFor<"pairing.challenge"> }
        | { type: "pairing.pending"; payload: RemotePayloadFor<"pairing.pending"> };
      try {
        const challenge = this.options.pairings.claim(envelope);
        response = { type: "pairing.challenge", payload: challenge };
      } catch (error) {
        if (errorCode(error) !== "PAIRING_ALREADY_CLAIMED") throw error;
        response = this.options.pairings.resumeClaim(envelope);
      }
      connection.pairingId = response.payload.pairingId;
      connection.clientKeyId = envelope.keyId;
      this.pairingConnections.set(response.payload.pairingId, connection.id);
      await this.sendPreSession(connection, response.type, response.payload as unknown as Record<string, unknown>);
      return;
    }

    if (envelope.type === "pairing.complete") {
      if (!connection.pairingId || envelope.keyId !== connection.clientKeyId) {
        throw Object.assign(new Error("Pairing completion does not match the claimed phone."), { code: "PAIRING_STATE_INVALID" });
      }
      const pending = this.options.pairings.complete(envelope);
      await this.sendPreSession(connection, "pairing.pending", pending as unknown as Record<string, unknown>);
      return;
    }

    if (envelope.type === "client.authenticate") {
      const parsed = safeParseRemotePayload("client.authenticate", envelope.payload);
      if (!parsed.success) throw Object.assign(new Error("Authentication payload is invalid."), { code: "INVALID_PAYLOAD" });
      const payload = parsed.data;
      if (payload.serverNonce !== connection.serverNonce) {
        throw Object.assign(new Error("Server challenge was not echoed."), { code: "PAIRING_PROOF_INVALID" });
      }
      const device = this.options.pairings.getTrustedDeviceByKeyId(envelope.keyId);
      if (!device) throw Object.assign(new Error("Phone is not paired with this PC."), { code: "UNKNOWN_KEY" });
      if (device.revoked) throw Object.assign(new Error("Phone has been revoked."), { code: "REVOKED_DEVICE" });
      if (!publicKeyMatches(device, payload.publicKey)) throw Object.assign(new Error("Phone identity does not match the trusted key."), { code: "INVALID_SIGNATURE" });
      const publicKey = normalizeIdentityPublicKey(device.publicKeySpki);
      if (!verifyRemoteEnvelopeSignature(publicKey, envelope).ok) {
        throw Object.assign(new Error("Phone authentication signature is invalid."), { code: "INVALID_SIGNATURE" });
      }
      connection.clientKeyId = device.keyId;
      connection.pairingClientNonce = payload.clientNonce;
      connection.device = device;
      await this.establishSession(connection, device, connection.serverNonce, payload.clientNonce, this.now() + this.sessionTtlMs);
      return;
    }

    throw Object.assign(new Error("Only pairing or authentication is allowed before a session is established."), { code: "SESSION_REQUIRED" });
  }

  private async establishSession(
    connection: Connection,
    device: TrustedRemoteDevice,
    serverNonce: string,
    clientNonce: string,
    expiresAt: number,
  ): Promise<void> {
    if (connection.clientKeyId && connection.clientKeyId !== device.keyId) {
      throw Object.assign(new Error("Authenticated phone identity changed during handshake."), { code: "INVALID_SIGNATURE" });
    }
    const previousId = this.deviceConnections.get(device.deviceId);
    if (previousId && previousId !== connection.id) {
      const previous = this.connections.get(previousId);
      if (previous) {
        await this.sendSession(previous, "session.close", { reason: "client_replaced" }).catch(() => undefined);
        previous.ws.close(1008, "A newer session replaced this connection");
      }
    }

    const sessionId = randomUUID();
    const manifest = this.options.tasks.manifestSnapshot(device.keyId);
    connection.device = device;
    connection.clientKeyId = device.keyId;
    connection.sessionId = sessionId;
    const boundedExpiry = Math.min(expiresAt, this.now() + this.sessionTtlMs);
    if (boundedExpiry <= this.now()) {
      throw Object.assign(new Error("The remote pairing session has expired."), { code: "SESSION_EXPIRED" });
    }
    this.clearSessionTimers(connection);
    connection.sessionExpiresAt = boundedExpiry;
    connection.inboundGuard = new RemoteSessionGuard({
      sessionId,
      keyId: device.keyId,
      publicKey: device.publicKeySpki,
      direction: "client_to_server",
      lastAcceptedSequence: -1,
      maxMessageAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    });
    connection.outboundSequence = 0;
    connection.authenticated = true;
    this.deviceConnections.set(device.deviceId, connection.id);

    await this.sendSession(connection, "session.ready", {
      sessionId,
      deviceId: device.deviceId,
      grantedScopes: device.grantedScopes,
      manifestVersion: manifest.manifestVersion,
      serverEventSeq: 0,
      serverNonce,
      clientNonce,
      issuedAt: this.now(),
      expiresAt: boundedExpiry,
    });
    this.armSessionTimers(connection, boundedExpiry);
  }

  private armSessionTimers(connection: Connection, expiresAt: number): void {
    const remaining = expiresAt - this.now();
    const expiringIn = remaining - 60_000;
    if (expiringIn > 0) {
      connection.sessionExpiringTimer = setTimeout(() => {
        if (!connection.authenticated || !connection.sessionId) return;
        void this.sendSession(connection, "session.expiring", {
          expiresAt,
          renewWithinMs: Math.min(60_000, Math.max(1_000, expiresAt - this.now())),
          reason: "expiring",
        }).catch(() => undefined);
      }, expiringIn);
    }
    connection.sessionExpiryTimer = setTimeout(() => {
      if (!connection.authenticated) return;
      void this.sendSession(connection, "session.close", { reason: "expired" })
        .finally(() => connection.ws.close(1008, "Session expired"));
    }, Math.max(1, remaining));
  }

  private clearSessionTimers(connection: Connection): void {
    if (connection.sessionExpiringTimer) clearTimeout(connection.sessionExpiringTimer);
    if (connection.sessionExpiryTimer) clearTimeout(connection.sessionExpiryTimer);
    connection.sessionExpiringTimer = undefined;
    connection.sessionExpiryTimer = undefined;
  }

  private async handleAuthenticatedFrame(connection: Connection, envelope: RemoteEnvelope): Promise<void> {
    if (!connection.inboundGuard || !connection.device || !connection.sessionId ||
        !connection.sessionExpiresAt || connection.sessionExpiresAt <= this.now()) {
      await this.sendSession(connection, "session.close", { reason: "expired" }).catch(() => undefined);
      connection.ws.close(1008, "Session expired");
      return;
    }
    const verified = connection.inboundGuard.verifyAndAccept(envelope, this.now());
    if (!verified.accepted) {
      throw Object.assign(new Error("Session envelope rejected."), {
        code: verified.reason === "replayed_message" ? "REPLAYED_MESSAGE"
          : verified.reason === "sequence_out_of_order" ? "SEQUENCE_OUT_OF_ORDER"
            : verified.reason === "stale_message" || verified.reason === "future_message" ? "STALE_MESSAGE"
              : "INVALID_SIGNATURE",
      });
    }

    const keyId = connection.device.keyId;
    switch (envelope.type) {
      case "manifest.get": {
        const snapshot = this.options.tasks.manifestSnapshot(keyId);
        await this.sendSession(connection, "manifest.snapshot", snapshot as unknown as Record<string, unknown>);
        return;
      }
      case "task.submit": {
        const result = await this.options.tasks.submitTask(keyId, envelope.payload);
        await this.sendSession(connection, "task.accepted", result.accepted as unknown as Record<string, unknown>);
        if (result.confirmationRequired) {
          await this.sendSession(connection, "task.confirmation_required", result.confirmationRequired as unknown as Record<string, unknown>);
        }
        return;
      }
      case "task.cancel": {
        const result = await this.options.tasks.cancelTask(keyId, envelope.payload);
        await this.sendSession(connection, "task.cancel_ack", result as unknown as Record<string, unknown>);
        return;
      }
      case "task.confirmation_response": {
        const proof = (envelope.payload as Record<string, unknown>).biometricProof;
        await this.options.tasks.confirmTask(keyId, envelope.payload, proof);
        return;
      }
      case "ping": {
        const payload = safeParseRemotePayload("ping", envelope.payload);
        if (!payload.success) throw Object.assign(new Error("Invalid ping."), { code: "INVALID_PAYLOAD" });
        await this.sendSession(connection, "pong", {
          sentAt: payload.data.sentAt,
          receivedAt: this.now(),
        });
        return;
      }
      case "pong":
        return;
      case "sync.resume":
        await this.sendSession(connection, "sync.snapshot", {
          lastEventSeq: 0,
          historyGap: true,
          tasks: [],
          events: [],
        });
        await this.sendSession(connection, "sync.complete", {
          lastEventSeq: 0,
          resumedAt: this.now(),
          sessionExpiresAt: connection.sessionExpiresAt,
        });
        return;
      default:
        throw Object.assign(new Error("Message type is not supported in an authenticated session."), { code: "UNKNOWN_MESSAGE_TYPE" });
    }
  }

  private queueSignedEnvelope(
    connection: Connection,
    type: RemoteMessageType,
    payload: Record<string, unknown>,
    sessionId: string,
    nextSequence: () => number,
  ): Promise<void> {
    const operation = connection.outboundTail.then(async () => {
      if (connection.ws.readyState !== WebSocket.OPEN) return;
      const sequence = nextSequence();
      const envelope = await this.options.signer.sign({ type, payload, sessionId, sequence });
      this.writeEnvelope(connection, envelope);
    });
    // Keep the chain usable after a transient signer/network failure while
    // returning the original error to the caller that issued this message.
    connection.outboundTail = operation.catch(() => undefined);
    return operation;
  }

  private sendPreSession(connection: Connection, type: RemoteMessageType, payload: Record<string, unknown>): Promise<void> {
    return this.queueSignedEnvelope(
      connection, type, payload, PRE_SESSION_ID, () => connection.preSessionSequence++,
    );
  }

  private sendSession(connection: Connection, type: RemoteMessageType, payload: Record<string, unknown>): Promise<void> {
    const sessionId = connection.sessionId;
    if (!sessionId) return Promise.reject(new Error("Cannot send a session message before authentication."));
    return this.queueSignedEnvelope(
      connection, type, payload, sessionId, () => connection.outboundSequence++,
    );
  }

  private writeEnvelope(connection: Connection, envelope: RemoteEnvelope): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    const wire = JSON.stringify(envelope);
    if (Buffer.byteLength(wire, "utf8") > MAX_FRAME_BYTES) {
      connection.ws.close(1009, "Message exceeds protocol size limit");
      return;
    }
    connection.ws.send(wire, { compress: false });
  }

  private async sendError(connection: Connection, code: string, message: string): Promise<void> {
    const validCodes = new Set([
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
    const safeCode = validCodes.has(code) ? code : "INTERNAL_ERROR";
    const payload = { code: safeCode, message: message.slice(0, 300) };
    if (connection.sessionId && connection.authenticated) {
      await this.sendSession(connection, "protocol.error", payload).catch(() => undefined);
    } else {
      await this.sendPreSession(connection, "protocol.error", payload).catch(() => undefined);
    }
  }

  private removeConnection(connection: Connection): void {
    this.clearSessionTimers(connection);
    this.connections.delete(connection.id);
    if (connection.pairingId) this.pairingConnections.delete(connection.pairingId);
    if (connection.device && this.deviceConnections.get(connection.device.deviceId) === connection.id) {
      this.deviceConnections.delete(connection.device.deviceId);
    }
  }
}

