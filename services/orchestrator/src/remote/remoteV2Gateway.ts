import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_ENVELOPE_BYTES,
  PRE_SESSION_ID,
  RemoteSessionGuard,
  computeKeyId,
  createRemoteEnvelope,
  decodeRemoteEnvelope,
  normalizeIdentityPublicKey,
  safeParseRemotePayload,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
  type RemoteMessageType,
  type RemotePayloadFor,
} from "@vanessa/protocol";
import {
  PairingRegistryError,
  RemotePairingRegistry,
  type CreatedPairingWindow,
  type TrustedRemoteDevice,
} from "./remotePairingRegistry.js";
import { RemoteTaskService } from "./remoteTaskService.js";

export type RemoteV2IdentitySigner = {
  keyId: string;
  publicKeySpki: string;
  sign(envelope: Omit<RemoteEnvelope, "auth">): Promise<RemoteEnvelope>;
};

export type RemoteV2TaskNotification = {
  task: {
    taskId: string;
    requestId: string;
    tool: string;
    state: string;
    result?: unknown;
    error?: string;
  };
  deviceId?: string;
  ephemeralResult?: unknown;
};

type ConnectionPhase = "pre_session" | "pairing_challenge" | "awaiting_local_approval" | "authenticated" | "closed";
type ConnectionState = {
  socket: WebSocket;
  phase: ConnectionPhase;
  serverNonce: string;
  challengeExpiresAt: number;
  serverSequence: number;
  clientKeyId?: string;
  clientPublicKeySpki?: string;
  clientNonce?: string;
  pairingId?: string;
  sessionId?: string;
  deviceId?: string;
  grantedScopes?: string[];
  sessionExpiresAt?: number;
  guard?: RemoteSessionGuard;
  messageWindowAt: number;
  messageCount: number;
  taskEventSeq: Map<string, number>;
};

export type RemoteV2GatewayOptions = {
  host?: string;
  port?: number;
  path?: string;
  pcName: string;
  publicWebSocketUrl?: string;
  identity: RemoteV2IdentitySigner;
  pairings: RemotePairingRegistry;
  tasks: RemoteTaskService;
  now?: () => number;
  challengeTtlMs?: number;
  sessionTtlMs?: number;
  maxMessagesPerMinute?: number;
};

/**
 * Protocol-v2 phone gateway. It listens on loopback only; Tailscale Serve is
 * the supported remote ingress and supplies HTTPS/WSS inside the tailnet.
 * No legacy bearer token, client-supplied device id, or client-supplied tier
 * participates in this transport.
 */
export class RemoteV2Gateway {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly now: () => number;
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxMessagesPerMinute: number;
  private readonly connections = new Set<ConnectionState>();
  private readonly pendingPairings = new Map<string, ConnectionState>();
  private readonly sessionsByDevice = new Map<string, ConnectionState>();
  private server?: WebSocketServer;
  private expiryTimer?: NodeJS.Timeout;

  constructor(private readonly options: RemoteV2GatewayOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4321;
    this.path = options.path ?? "/remote-v2";
    this.now = options.now ?? Date.now;
    this.challengeTtlMs = options.challengeTtlMs ?? 120_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60_000;
    this.maxMessagesPerMinute = options.maxMessagesPerMinute ?? 120;
    const loopback = this.host === "localhost" || this.host === "127.0.0.1" || this.host === "::1";
    if (!loopback || (isIP(this.host) === 0 && this.host !== "localhost")) {
      throw new Error("Remote v2 gateway must bind to localhost; use Tailscale Serve for tailnet access.");
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new Error("Remote v2 gateway port is invalid.");
    }
    if (!this.path.startsWith("/") || this.path.length > 100) {
      throw new Error("Remote v2 WebSocket path is invalid.");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.identity.keyId)) {
      throw new Error("Remote v2 PC identity key id is invalid.");
    }
    if (!options.pcName.trim() || options.pcName.length > 80) {
      throw new Error("Remote v2 PC name is invalid.");
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    await this.options.pairings.initialize();
    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      path: this.path,
      maxPayload: MAX_ENVELOPE_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    server.on("connection", (socket, request) => {
      if (request.headers.origin) {
        socket.close(1008, "Browser origins are not accepted.");
        return;
      }
      const now = this.now();
      const state: ConnectionState = {
        socket,
        phase: "pre_session",
        serverNonce: randomBytes(32).toString("base64url"),
        challengeExpiresAt: now + this.challengeTtlMs,
        serverSequence: 0,
        messageWindowAt: now,
        messageCount: 0,
        taskEventSeq: new Map(),
      };
      this.connections.add(state);
      socket.on("message", (data) => void this.handleMessage(state, data).catch(() => {
        this.closeState(state, 1008, "Protocol validation failed.");
      }));
      socket.on("close", () => this.removeState(state));
      socket.on("error", () => this.removeState(state));
      void this.send(state, "server.challenge", {
        serverNonce: state.serverNonce,
        pcId: this.options.identity.keyId,
        pcName: this.options.pcName,
        protocolVersion: 2,
        supportedVersions: [2],
        issuedAt: now,
        expiresAt: state.challengeExpiresAt,
        pairingRequired: true,
      }, PRE_SESSION_ID).catch(() => this.closeState(state, 1011, "Could not establish a secure channel."));
    });
    server.on("error", (error) => {
      console.error("[Remote v2] WebSocket server error:", error.message);
    });
    this.expiryTimer = setInterval(() => this.expireSessions(), 10_000);
    this.expiryTimer.unref();
  }

  async close(): Promise<void> {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const state of [...this.connections]) this.closeState(state, 1001, "PC gateway shutting down.");
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  createPairingPayload(): { window: CreatedPairingWindow; payload: string } {
    const publicUrl = this.options.publicWebSocketUrl?.trim();
    if (!publicUrl) {
      throw new Error("Set VANESSA_REMOTE_V2_PUBLIC_URL to the Tailscale Serve WSS URL before creating a remote pairing code.");
    }
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.port || !parsed.hostname.toLowerCase().endsWith(".ts.net")) {
      throw new Error("Remote pairing requires a Tailscale MagicDNS wss://<node>.<tailnet>.ts.net URL.");
    }
    if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = this.path;
    if (parsed.pathname !== this.path) {
      throw new Error("Remote pairing URL path must match the configured v2 gateway path.");
    }
    const window = this.options.pairings.createPairingWindow(this.now());
    const payload = {
      type: "vanessa_remote_v2",
      version: 2,
      protocolVersion: 2,
      wsUrl: parsed.toString(),
      pcId: this.options.identity.keyId,
      pcKeyId: this.options.identity.keyId,
      pcPublicKey: this.options.identity.publicKeySpki,
      pcName: this.options.pcName,
      pairingId: window.pairingId,
      code: window.code,
      expiresAt: window.expiresAt,
    };
    return { window, payload: JSON.stringify(payload) };
  }

  listPendingPairings() {
    return this.options.pairings.getPendingApprovals();
  }

  listTrustedDevices() {
    return this.options.pairings.listTrustedDevices().map((device) => ({
      deviceId: device.deviceId,
      keyId: device.keyId,
      deviceHint: device.deviceHint,
      platform: device.platform,
      appVersion: device.appVersion,
      grantedScopes: [...device.grantedScopes],
      pairedAt: device.pairedAt,
      revoked: device.revoked,
    }));
  }

  async approvePairing(pairingId: string, scopes: string[]) {
    const approved = await this.options.pairings.approve(pairingId, scopes, this.now());
    const state = this.pendingPairings.get(pairingId);
    if (state && state.socket.readyState === WebSocket.OPEN) {
      const device = this.options.pairings.getTrustedDeviceByKeyId(approved.keyId);
      if (device) {
        await this.send(state, "pairing.approved", approved, PRE_SESSION_ID);
        await this.establishSession(state, device, approved.serverNonce, approved.clientNonce, approved.sessionExpiresAt);
      }
    }
    this.pendingPairings.delete(pairingId);
    return approved;
  }

  async rejectPairing(pairingId: string) {
    const rejected = this.options.pairings.reject(pairingId);
    const state = this.pendingPairings.get(pairingId);
    if (state && state.socket.readyState === WebSocket.OPEN) {
      await this.send(state, "pairing.rejected", rejected, PRE_SESSION_ID);
      this.closeState(state, 1008, "Pairing declined on the PC.");
    }
    this.pendingPairings.delete(pairingId);
    return rejected;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const revoked = await this.options.pairings.revokeDevice(deviceId);
    if (!revoked) return false;
    const state = this.sessionsByDevice.get(deviceId);
    if (state) {
      await this.send(state, "session.close", { reason: "revoked" }, state.sessionId).catch(() => undefined);
      this.closeState(state, 1008, "This phone was revoked on the PC.");
    }
    return true;
  }

  publishTaskUpdate(event: RemoteV2TaskNotification): void {
    const state = event.deviceId ? this.sessionsByDevice.get(event.deviceId) : undefined;
    if (!state || state.phase !== "authenticated" || !state.sessionId || state.socket.readyState !== WebSocket.OPEN) return;
    const task = event.task;
    const eventSeq = (state.taskEventSeq.get(task.taskId) ?? 0) + 1;
    state.taskEventSeq.set(task.taskId, eventSeq);
    const mappedState = this.mapTaskState(task.state);

    if (["done", "failed", "cancelled", "timed_out"].includes(task.state)) {
      const status = task.state === "done" ? "succeeded"
        : task.state === "cancelled" ? "cancelled"
          : task.state === "timed_out" ? "timed_out" : "failed";
      const resultPayload = {
        taskId: task.taskId,
        status,
        verification: {
          status: task.state === "done" ? "verified" : task.state === "failed" ? "failed" : "not_available",
          summary: task.state === "done"
            ? "The PC-side verifier accepted the task outcome."
            : "The task did not complete with a verified successful outcome.",
        },
        safeSummary: task.state === "done"
          ? "Task completed and passed PC-side verification."
          : (task.error || "The PC task did not complete.").slice(0, 500),
        ...(task.state === "done" && (task.result ?? event.ephemeralResult) !== undefined
          ? { result: task.result ?? event.ephemeralResult } : {}),
        eventSeq,
        completedAt: this.now(),
      };
      const parsed = safeParseRemotePayload("task.result", resultPayload);
      const payload = parsed.success ? parsed.data : { ...resultPayload, result: undefined };
      void this.send(state, "task.result", payload as RemotePayloadFor<"task.result">, state.sessionId)
        .catch(() => this.closeState(state, 1011, "Could not deliver task result."));
      return;
    }

    const summary = task.state === "awaiting_confirm"
      ? "Waiting for explicit approval on the phone."
      : "PC task " + task.state + ".";
    void this.send(state, "task.progress", {
      taskId: task.taskId,
      state: mappedState,
      eventSeq,
      safeSummary: summary,
    }, state.sessionId).catch(() => this.closeState(state, 1011, "Could not deliver task progress."));
  }

  private async handleMessage(state: ConnectionState, data: WebSocket.RawData): Promise<void> {
    if (state.phase === "closed" || state.socket.readyState !== WebSocket.OPEN) return;
    const now = this.now();
    if (now - state.messageWindowAt >= 60_000) {
      state.messageWindowAt = now;
      state.messageCount = 0;
    }
    state.messageCount += 1;
    if (state.messageCount > this.maxMessagesPerMinute) {
      await this.sendError(state, "RATE_LIMITED", "Too many messages. Reconnect and retry.");
      this.closeState(state, 1008, "Rate limit exceeded.");
      return;
    }

    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
      await this.sendError(state, "PAYLOAD_TOO_LARGE", "The protocol message is too large.");
      this.closeState(state, 1009, "Message too large.");
      return;
    }
    let envelope: RemoteEnvelope;
    try {
      envelope = decodeRemoteEnvelope(bytes);
    } catch {
      await this.sendError(state, "INVALID_MESSAGE", "The protocol message is invalid.");
      this.closeState(state, 1008, "Malformed protocol envelope.");
      return;
    }

    if (state.phase !== "authenticated") {
      await this.handlePreSession(state, envelope, now);
      return;
    }
    if (!state.guard || !state.sessionId || !state.clientKeyId || !state.deviceId) {
      this.closeState(state, 1008, "Session state is incomplete.");
      return;
    }
    if ((state.sessionExpiresAt ?? 0) <= now) {
      await this.send(state, "session.close", { reason: "expired" }, state.sessionId).catch(() => undefined);
      this.closeState(state, 1008, "Session expired.");
      return;
    }
    const trusted = this.options.pairings.getTrustedDeviceByKeyId(state.clientKeyId);
    if (!trusted || trusted.revoked || trusted.deviceId !== state.deviceId) {
      await this.send(state, "session.close", { reason: "revoked" }, state.sessionId).catch(() => undefined);
      this.closeState(state, 1008, "Device is no longer trusted.");
      return;
    }

    const verified = state.guard.verifyAndAccept(envelope, now);
    if (!verified.accepted) {
      await this.sendError(state, this.guardErrorCode(verified.reason), "The signed session message was rejected.");
      this.closeState(state, 1008, "Signed session validation failed.");
      return;
    }

    switch (envelope.type) {
      case "manifest.get": {
        const snapshot = this.options.tasks.manifestSnapshot(state.clientKeyId);
        await this.send(state, "manifest.snapshot", snapshot, state.sessionId);
        break;
      }
      case "task.submit": {
        try {
          const submitted = await this.options.tasks.submitTask(state.clientKeyId, envelope.payload);
          await this.send(state, "task.accepted", submitted.accepted, state.sessionId);
          if (submitted.confirmationRequired) {
            await this.send(state, "task.confirmation_required", submitted.confirmationRequired, state.sessionId);
          }
        } catch (error) {
          await this.sendError(state, this.taskErrorCode(error), this.safeErrorMessage(error), undefined, state.sessionId);
        }
        break;
      }
      case "task.cancel": {
        try {
          const acknowledgement = await this.options.tasks.cancelTask(state.clientKeyId, envelope.payload);
          await this.send(state, "task.cancel_ack", acknowledgement, state.sessionId);
        } catch (error) {
          await this.sendError(state, this.taskErrorCode(error), this.safeErrorMessage(error), undefined, state.sessionId);
        }
        break;
      }
      case "task.confirmation_response": {
        try {
          const parsed = safeParseRemotePayload("task.confirmation_response", envelope.payload);
          if (!parsed.success) throw Object.assign(new Error("Confirmation payload is invalid."), { code: "INVALID_PAYLOAD" });
          await this.options.tasks.confirmTask(state.clientKeyId, parsed.data, parsed.data.approvalProof);
        } catch (error) {
          await this.sendError(state, this.taskErrorCode(error), this.safeErrorMessage(error), undefined, state.sessionId);
        }
        break;
      }
      case "ping": {
        const parsed = safeParseRemotePayload("ping", envelope.payload);
        if (!parsed.success) {
          await this.sendError(state, "INVALID_PAYLOAD", "Ping payload is invalid.");
          break;
        }
        await this.send(state, "pong", { sentAt: parsed.data.sentAt, receivedAt: now }, state.sessionId);
        break;
      }
      case "sync.resume": {
        const parsed = safeParseRemotePayload("sync.resume", envelope.payload);
        if (!parsed.success) {
          await this.sendError(state, "INVALID_PAYLOAD", "Sync resume payload is invalid.", undefined, state.sessionId);
          break;
        }
        const sync = this.options.tasks.syncSnapshot(state.clientKeyId, parsed.data.lastEventSeq);
        await this.send(state, "sync.snapshot", sync.snapshot, state.sessionId);
        // Results are replayed before sync.complete; clients persist their cursor
        // only after this barrier so an interrupted replay is safely retried.
        for (const result of sync.results) {
          await this.send(state, "task.result", result, state.sessionId);
        }
        await this.send(state, "sync.complete", {
          lastEventSeq: sync.snapshot.lastEventSeq,
          resumedAt: now,
          sessionExpiresAt: state.sessionExpiresAt!,
        }, state.sessionId);
        break;
      }
      default:
        await this.sendError(state, "UNKNOWN_MESSAGE_TYPE", "This message is not supported from the phone.", undefined, state.sessionId);
        this.closeState(state, 1008, "Unsupported client message.");
    }
  }

  private async handlePreSession(state: ConnectionState, envelope: RemoteEnvelope, now: number): Promise<void> {
    if (envelope.sessionId !== PRE_SESSION_ID) {
      await this.sendError(state, "SESSION_REQUIRED", "Authenticate or pair this phone first.");
      this.closeState(state, 1008, "Unexpected pre-session id.");
      return;
    }
    if (state.challengeExpiresAt <= now) {
      await this.sendError(state, "SESSION_EXPIRED", "The handshake challenge expired. Reconnect.");
      this.closeState(state, 1008, "Handshake challenge expired.");
      return;
    }

    if (envelope.type === "pairing.claim") {
      if (state.phase !== "pre_session") {
        await this.sendError(state, "PAIRING_STATE_INVALID", "Pairing has already started.");
        this.closeState(state, 1008, "Invalid pairing state.");
        return;
      }
      try {
        const challenge = this.options.pairings.claim(envelope, now);
        const claim = safeParseRemotePayload("pairing.claim", envelope.payload);
        if (!claim.success) throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing claim payload is invalid.");
        state.clientKeyId = envelope.keyId;
        state.clientPublicKeySpki = claim.data.publicKey;
        state.clientNonce = claim.data.clientNonce;
        state.pairingId = challenge.pairingId;
        state.phase = "pairing_challenge";
        await this.send(state, "pairing.challenge", challenge, PRE_SESSION_ID);
      } catch (error) {
        await this.sendError(state, this.pairingErrorCode(error), this.safeErrorMessage(error));
        this.closeState(state, 1008, "Pairing claim rejected.");
      }
      return;
    }

    if (envelope.type === "pairing.complete") {
      const completion = safeParseRemotePayload("pairing.complete", envelope.payload);
      if (state.phase !== "pairing_challenge" || !state.pairingId || !completion.success ||
          completion.data.pairingId !== state.pairingId || envelope.keyId !== state.clientKeyId) {
        await this.sendError(state, "PAIRING_STATE_INVALID", "No active pairing challenge exists.");
        this.closeState(state, 1008, "Invalid pairing completion.");
        return;
      }
      try {
        const pending = this.options.pairings.complete(envelope, now);
        state.phase = "awaiting_local_approval";
        this.pendingPairings.set(state.pairingId, state);
        await this.send(state, "pairing.pending", pending, PRE_SESSION_ID);
      } catch (error) {
        await this.sendError(state, this.pairingErrorCode(error), this.safeErrorMessage(error));
        this.closeState(state, 1008, "Pairing proof rejected.");
      }
      return;
    }

    if (envelope.type === "client.authenticate") {
      if (state.phase !== "pre_session") {
        await this.sendError(state, "SESSION_REQUIRED", "This connection cannot authenticate in its current state.");
        this.closeState(state, 1008, "Invalid authentication state.");
        return;
      }
      const parsed = safeParseRemotePayload("client.authenticate", envelope.payload);
      if (!parsed.success) {
        await this.sendError(state, "INVALID_PAYLOAD", "Authentication payload is invalid.");
        this.closeState(state, 1008, "Invalid authentication payload.");
        return;
      }
      const payload = parsed.data;
      if (payload.serverNonce !== state.serverNonce || payload.clientNonce.length < 16 ||
          envelope.sequence !== 0 || Math.abs(now - envelope.sentAt) > this.challengeTtlMs) {
        await this.sendError(state, "INVALID_SIGNATURE", "The handshake nonce did not match.");
        this.closeState(state, 1008, "Handshake nonce mismatch.");
        return;
      }
      let publicKey;
      try {
        publicKey = normalizeIdentityPublicKey(payload.publicKey);
      } catch {
        await this.sendError(state, "UNKNOWN_KEY", "The phone identity key is invalid.");
        this.closeState(state, 1008, "Invalid phone identity.");
        return;
      }
      if (computeKeyId(publicKey) !== envelope.keyId || !verifyRemoteEnvelopeSignature(publicKey, envelope).ok) {
        await this.sendError(state, "INVALID_SIGNATURE", "The phone did not prove possession of its identity key.");
        this.closeState(state, 1008, "Phone signature rejected.");
        return;
      }
      const device = this.options.pairings.getTrustedDeviceByKeyId(envelope.keyId);
      if (!device) {
        await this.sendError(state, "UNKNOWN_KEY", "Pair this phone with the PC before connecting.");
        this.closeState(state, 1008, "Phone is not paired.");
        return;
      }
      if (device.revoked) {
        await this.sendError(state, "REVOKED_DEVICE", "This phone has been revoked on the PC.");
        this.closeState(state, 1008, "Phone was revoked.");
        return;
      }
      state.clientKeyId = envelope.keyId;
      state.clientPublicKeySpki = payload.publicKey;
      state.clientNonce = payload.clientNonce;
      await this.establishSession(state, device, state.serverNonce, payload.clientNonce, now + this.sessionTtlMs);
      return;
    }

    await this.sendError(state, "SESSION_REQUIRED", "Pair or authenticate using protocol v2.");
    this.closeState(state, 1008, "Expected a v2 handshake message.");
  }

  private async establishSession(
    state: ConnectionState,
    device: TrustedRemoteDevice,
    serverNonce: string,
    clientNonce: string,
    sessionExpiresAt: number,
  ): Promise<void> {
    const existing = this.sessionsByDevice.get(device.deviceId);
    if (existing && existing !== state) {
      await this.send(existing, "session.close", { reason: "client_replaced" }, existing.sessionId).catch(() => undefined);
      this.closeState(existing, 1008, "A newer connection replaced this session.");
    }
    const sessionId = randomUUID();
    const publicKey = normalizeIdentityPublicKey(device.publicKeySpki);
    state.sessionId = sessionId;
    state.deviceId = device.deviceId;
    state.clientKeyId = device.keyId;
    state.clientPublicKeySpki = device.publicKeySpki;
    state.grantedScopes = [...device.grantedScopes];
    state.sessionExpiresAt = sessionExpiresAt;
    state.serverSequence = 0;
    state.guard = new RemoteSessionGuard({
      sessionId,
      keyId: device.keyId,
      publicKey,
      direction: "client_to_server",
      lastAcceptedSequence: -1,
      maxMessageAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    });
    state.phase = "authenticated";
    this.sessionsByDevice.set(device.deviceId, state);
    const manifest = this.options.tasks.manifestSnapshot(device.keyId);
    await this.send(state, "session.ready", {
      sessionId,
      deviceId: device.deviceId,
      grantedScopes: [...device.grantedScopes],
      manifestVersion: manifest.manifestVersion,
      serverEventSeq: 0,
      serverNonce,
      clientNonce,
      issuedAt: this.now(),
      expiresAt: sessionExpiresAt,
    }, sessionId);
  }

  private async send<T extends RemoteMessageType>(
    state: ConnectionState,
    type: T,
    payload: RemotePayloadFor<T>,
    sessionId = state.sessionId ?? PRE_SESSION_ID,
  ): Promise<void> {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    const unsigned = createRemoteEnvelope({
      type,
      payload: payload as Record<string, unknown>,
      keyId: this.options.identity.keyId,
      sessionId,
      sentAt: this.now(),
      sequence: state.serverSequence++,
    });
    const signed = await this.options.identity.sign(unsigned);
    if (signed.keyId !== this.options.identity.keyId || signed.auth.algorithm !== "ES256") {
      throw new Error("PC identity signer returned an invalid envelope.");
    }
    if (state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(signed));
  }

  private async sendError(
    state: ConnectionState,
    code: RemotePayloadFor<"protocol.error">["code"],
    message: string,
    taskId?: string,
    sessionId = state.sessionId ?? PRE_SESSION_ID,
  ): Promise<void> {
    await this.send(state, "protocol.error", {
      code,
      message: message.slice(0, 300),
      ...(taskId ? { taskId } : {}),
    }, sessionId);
  }

  private guardErrorCode(reason: string): RemotePayloadFor<"protocol.error">["code"] {
    if (reason === "stale_message" || reason === "future_message") return "STALE_MESSAGE";
    if (reason === "replayed_message") return "REPLAYED_MESSAGE";
    if (reason === "sequence_out_of_order") return "SEQUENCE_OUT_OF_ORDER";
    if (reason === "unknown_key") return "UNKNOWN_KEY";
    if (reason === "wrong_session") return "SESSION_REQUIRED";
    if (reason === "invalid_signature") return "INVALID_SIGNATURE";
    return "INVALID_MESSAGE";
  }

  private pairingErrorCode(error: unknown): RemotePayloadFor<"protocol.error">["code"] {
    const code = error instanceof PairingRegistryError ? error.code : (error as { code?: string })?.code;
    if (code === "PAIRING_CODE_INVALID") return "PAIRING_CODE_INVALID";
    if (code === "PAIRING_EXPIRED") return "PAIRING_EXPIRED";
    if (code === "PAIRING_ALREADY_CLAIMED") return "PAIRING_ALREADY_CLAIMED";
    if (code === "PAIRING_DENIED") return "PAIRING_DENIED";
    if (code === "PAIRING_PROOF_INVALID") return "PAIRING_PROOF_INVALID";
    return "PAIRING_STATE_INVALID";
  }

  private taskErrorCode(error: unknown): RemotePayloadFor<"protocol.error">["code"] {
    const code = (error as { code?: string })?.code;
    const known = new Set([
      "INVALID_PAYLOAD", "INVALID_ARGUMENTS", "TASK_NOT_FOUND", "TASK_CANCELLED",
      "TASK_TIMEOUT", "TASK_NOT_CANCELLABLE", "TASK_FAILED", "PC_BUSY",
      "IDEMPOTENCY_CONFLICT", "PERMISSION_DENIED", "SCOPE_REQUIRED",
      "CAPABILITY_DISABLED", "CONFIRMATION_REQUIRED", "CONFIRMATION_EXPIRED",
      "CONFIRMATION_MISMATCH", "UNKNOWN_KEY", "REVOKED_DEVICE",
    ]);
    return known.has(String(code)) ? code as RemotePayloadFor<"protocol.error">["code"] : "INTERNAL_ERROR";
  }

  private safeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
  }

  private mapTaskState(state: string): RemotePayloadFor<"task.progress">["state"] {
    const map: Record<string, RemotePayloadFor<"task.progress">["state"]> = {
      queued: "queued",
      validating: "validating",
      awaiting_confirm: "awaiting_approval",
      running: "running",
      verifying: "verifying",
    };
    return map[state] ?? "unknown";
  }

  private expireSessions(): void {
    const now = this.now();
    for (const state of [...this.connections]) {
      if (state.phase === "authenticated") {
        const device = state.clientKeyId ? this.options.pairings.getTrustedDeviceByKeyId(state.clientKeyId) : undefined;
        if (!device || device.revoked || device.deviceId !== state.deviceId) {
          this.closeState(state, 1008, "Phone trust was revoked.");
        } else if ((state.sessionExpiresAt ?? 0) <= now) {
          void this.send(state, "session.close", { reason: "expired" }, state.sessionId).catch(() => undefined);
          this.closeState(state, 1008, "Session expired.");
        }
      } else if (state.phase !== "awaiting_local_approval" && state.challengeExpiresAt <= now) {
        this.closeState(state, 1008, "Handshake expired.");
      }
    }
  }

  private closeState(state: ConnectionState, code: number, reason: string): void {
    if (state.phase === "closed") return;
    state.phase = "closed";
    state.socket.close(code, reason.slice(0, 120));
    this.removeState(state);
  }

  private removeState(state: ConnectionState): void {
    state.phase = "closed";
    this.connections.delete(state);
    if (state.pairingId && this.pendingPairings.get(state.pairingId) === state) this.pendingPairings.delete(state.pairingId);
    if (state.deviceId && this.sessionsByDevice.get(state.deviceId) === state) this.sessionsByDevice.delete(state.deviceId);
  }
}
