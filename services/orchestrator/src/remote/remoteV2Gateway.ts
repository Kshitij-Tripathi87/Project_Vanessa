import { createServer, type Server } from "node:http";
import { isIPv4 } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_ENVELOPE_BYTES,
  PRE_SESSION_ID,
  RemoteSessionGuard,
  safeParseRemoteEnvelope,
  safeParseRemotePayload,
  type RemoteEnvelope,
  type RemoteMessageType,
  type RemotePayloadFor,
} from "@vanessa/protocol";
import type { RemotePairingRegistry } from "./remotePairingRegistry.js";
import type { RemoteTaskService } from "./remoteTaskService.js";

export type RemotePcSigner = {
  keyId: string;
  publicKeySpki: string;
  sign(envelope: Omit<RemoteEnvelope, "auth">): Promise<RemoteEnvelope>;
};

export type RemoteGatewayTask = {
  taskId: string;
  requestId: string;
  tool: string;
  state: "queued" | "validating" | "awaiting_confirm" | "running" | "verifying" | "done" | "failed" | "cancelled" | "timed_out";
  result?: unknown;
  error?: string;
};

type PendingSocket = {
  socket: WebSocket;
  pairingId?: string;
  phoneKeyId?: string;
  phonePublicKeySpki?: string;
  deviceHint?: string;
  clientNonce?: string;
  pairingChallengeNonce?: string;
  preSessionServerSequence: number;
  serverNonce: string;
  approvedPayload?: RemotePayloadFor<"pairing.approved">;
  pairingFlow: boolean;
  connectedAt: number;
  inboundMessageTimes: number[];
};

type ActiveSocket = {
  socket: WebSocket;
  keyId: string;
  deviceId: string;
  sessionId: string;
  guard: RemoteSessionGuard;
  serverSequence: number;
  eventSequence: number;
  expiresAt: number;
  inboundMessageTimes: number[];
};

export type RemoteV2GatewayOptions = {
  host: string;
  port: number;
  pairings: RemotePairingRegistry;
  tasks: RemoteTaskService;
  signer: RemotePcSigner;
  now?: () => number;
  pcName?: string;
  allowTailscaleBind?: boolean;
  sessionTtlMs?: number;
  publicEndpoint?: string;
  maxMessagesPerMinute?: number;
};

/**
 * Authenticated protocol-v2 WebSocket listener.
 *
 * The PC resolves device identity and scopes from its trusted-device registry.
 * Client-controlled device IDs, permission tiers and scopes are never accepted.
 * The listener refuses wildcard binds; a non-loopback bind must be an explicit
 * Tailscale IPv4 address in 100.64.0.0/10.
 */
export class RemoteV2Gateway {
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly publicEndpoint?: string;
  private readonly maxMessagesPerMinute: number;
  private readonly server: Server;
  private readonly sockets = new Map<WebSocket, PendingSocket | ActiveSocket>();
  private readonly pendingByPairingId = new Map<string, PendingSocket>();
  private readonly activeByDeviceId = new Map<string, Set<ActiveSocket>>();
  private wss?: WebSocketServer;
  private listeningPort?: number;

  constructor(private readonly options: RemoteV2GatewayOptions) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60_000;
    this.publicEndpoint = options.publicEndpoint;
    this.maxMessagesPerMinute = options.maxMessagesPerMinute ?? 120;
    if (!Number.isInteger(this.maxMessagesPerMinute) || this.maxMessagesPerMinute < 10 || this.maxMessagesPerMinute > 10_000) {
      throw new Error("Remote v2 rate limit must be between 10 and 10000 messages per minute.");
    }
    if (this.publicEndpoint) {
      const endpoint = new URL(this.publicEndpoint);
      if (endpoint.protocol !== "wss:" || !endpoint.hostname || endpoint.pathname !== "/remote/v2" ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error("Remote v2 public endpoint must be a clean wss:// URL ending in /remote/v2.");
      }
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error("Remote v2 gateway port must be between 0 and 65535.");
    }
    this.assertSafeBind(options.host, options.allowTailscaleBind === true);
    this.server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    });
  }

  async start(): Promise<void> {
    if (this.wss) throw new Error("Remote v2 gateway is already started.");
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_ENVELOPE_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      // Native Android clients do not send Origin. Reject browser-origin sockets
      // so a hostile website cannot use a user's PC session cross-site.
      if (url.pathname !== "/remote/v2" || request.headers.origin) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(request, socket, head, (websocket) => {
        this.wss!.emit("connection", websocket, request);
      });
    });
    this.wss.on("connection", (socket) => {
      void this.onConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") return reject(new Error("Remote v2 gateway did not obtain a TCP address."));
        this.listeningPort = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.close(1001, "PC shutting down");
    this.sockets.clear();
    this.pendingByPairingId.clear();
    this.activeByDeviceId.clear();
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = undefined;
    }
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
  }

  createPairingWindow(): {
    pairingId: string;
    expiresAt: number;
    endpoint: string;
    pcKeyId: string;
    pcPublicKey: string;
    qrPayload: string;
  } {
    if (this.listeningPort === undefined) throw new Error("Remote v2 gateway is not listening.");
    const created = this.options.pairings.createPairingWindow(this.now());
    const endpoint = this.publicEndpoint ?? ("ws://" + this.options.host + ":" + this.listeningPort + "/remote/v2");
    const value = {
      version: 2,
      endpoint,
      pairingId: created.pairingId,
      code: created.code,
      expiresAt: created.expiresAt,
      pcKeyId: this.options.signer.keyId,
      pcPublicKey: this.options.signer.publicKeySpki,
    };
    return {
      pairingId: created.pairingId,
      expiresAt: created.expiresAt,
      endpoint,
      pcKeyId: this.options.signer.keyId,
      pcPublicKey: this.options.signer.publicKeySpki,
      qrPayload: JSON.stringify(value),
    };
  }

  async approvePairing(pairingId: string, scopes: string[]): Promise<void> {
    const pending = this.pendingByPairingId.get(pairingId);
    if (!pending || pending.socket.readyState !== WebSocket.OPEN || !pending.phoneKeyId) {
      throw Object.assign(new Error("The phone is no longer connected to this pairing request."), { code: "PAIRING_STATE_INVALID" });
    }
    const approved = await this.options.pairings.approve(pairingId, scopes, this.now());
    pending.approvedPayload = approved;
    await this.sendSigned(pending.socket, "pairing.approved", PRE_SESSION_ID, approved, pending.preSessionServerSequence++);
  }

  rejectPairing(pairingId: string): void {
    const pending = this.pendingByPairingId.get(pairingId);
    const rejected = this.options.pairings.reject(pairingId);
    if (pending?.socket.readyState === WebSocket.OPEN) {
      void this.sendSigned(pending.socket, "pairing.rejected", PRE_SESSION_ID, rejected, pending.preSessionServerSequence++);
      pending.socket.close(1008, "Pairing declined on PC");
    }
    this.pendingByPairingId.delete(pairingId);
  }

  /** Called by the durable PC task engine after every state transition. */
  publishTask(event: { task: RemoteGatewayTask; deviceId?: string; ephemeralResult?: unknown }): void {
    if (!event.deviceId) return;
    const sessions = this.activeByDeviceId.get(event.deviceId);
    if (!sessions) return;
    for (const session of sessions) {
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      if (session.expiresAt <= this.now()) {
        void this.sendSigned(session.socket, "session.close", session.sessionId, { reason: "expired" }, session.serverSequence++);
        session.socket.close(1008, "Session expired");
        continue;
      }
      void this.publishTaskToSession(session, event.task, event.ephemeralResult);
    }
  }

  private async onConnection(socket: WebSocket): Promise<void> {
    const context: PendingSocket = {
      socket,
      serverNonce: randomBytes(32).toString("base64url"),
      preSessionServerSequence: 0,
      pairingFlow: false,
      connectedAt: this.now(),
      inboundMessageTimes: [],
    };
    this.sockets.set(socket, context);
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text frames only");
        return;
      }
      void this.onMessage(socket, raw.toString()).catch(() => socket.close(1008, "Protocol error"));
    });
    socket.on("close", () => this.dropSocket(socket));
    socket.on("error", () => this.dropSocket(socket));

    await this.sendSigned(socket, "server.challenge", PRE_SESSION_ID, {
      serverNonce: context.serverNonce,
      pcId: this.options.signer.keyId,
      pcName: (this.options.pcName ?? "Vanessa PC").slice(0, 80),
      protocolVersion: 2,
      supportedVersions: [2],
      issuedAt: this.now(),
      expiresAt: this.now() + 90_000,
      pairingRequired: true,
    }, context.preSessionServerSequence++);
  }

  private async onMessage(socket: WebSocket, text: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES) {
      await this.sendProtocolError(socket, "PAYLOAD_TOO_LARGE", "The message exceeds the protocol size limit.");
      return;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch {
      await this.sendProtocolError(socket, "INVALID_MESSAGE", "The message is not valid JSON.");
      return;
    }
    const parsed = safeParseRemoteEnvelope(value);
    if (!parsed.success) {
      await this.sendProtocolError(socket, "INVALID_MESSAGE", "The message envelope is invalid.");
      return;
    }
    const envelope = parsed.data;
    const state = this.sockets.get(socket);
    if (!state) return;
    const cutoff = this.now() - 60_000;
    state.inboundMessageTimes = state.inboundMessageTimes.filter((time) => time > cutoff);
    if (state.inboundMessageTimes.length >= this.maxMessagesPerMinute) {
      await this.sendProtocolError(socket, "RATE_LIMITED", "Too many messages were sent on this connection.", "sessionId" in state ? state.sessionId : PRE_SESSION_ID);
      socket.close(1008, "Rate limited");
      return;
    }
    state.inboundMessageTimes.push(this.now());
    if (!("sessionId" in state) && this.now() - state.connectedAt > 90_000) {
      await this.sendProtocolError(socket, "SESSION_EXPIRED", "The handshake timed out.");
      socket.close(1008, "Handshake timed out");
      return;
    }

    if ("sessionId" in state) {
      await this.handleAuthenticatedMessage(state, envelope);
      return;
    }
    if (envelope.sessionId !== PRE_SESSION_ID) {
      await this.sendProtocolError(socket, "SESSION_REQUIRED", "Complete the v2 handshake before sending commands.");
      return;
    }
    if (envelope.type === "pairing.claim") {
      if (envelope.sequence !== 0) {
        await this.sendProtocolError(socket, "SEQUENCE_OUT_OF_ORDER", "The pairing sequence must begin at zero.");
        return;
      }
      if (state.pairingFlow || state.pairingId) {
        await this.sendProtocolError(socket, "PAIRING_ALREADY_CLAIMED", "This connection already has a pairing attempt.");
        return;
      }
      const challenge = this.options.pairings.claim(envelope, this.now());
      const payload = safeParseRemotePayload("pairing.claim", envelope.payload);
      if (!payload.success) return;
      state.pairingFlow = true;
      state.pairingId = challenge.pairingId;
      state.phoneKeyId = envelope.keyId;
      state.phonePublicKeySpki = payload.data.publicKey;
      state.deviceHint = payload.data.deviceHint;
      state.clientNonce = payload.data.clientNonce;
      state.pairingChallengeNonce = challenge.nonce;
      this.pendingByPairingId.set(challenge.pairingId, state);
      await this.sendSigned(socket, "pairing.challenge", PRE_SESSION_ID, challenge, state.preSessionServerSequence++);
      return;
    }
    if (envelope.type === "pairing.complete") {
      if (envelope.sequence !== 1) {
        await this.sendProtocolError(socket, "SEQUENCE_OUT_OF_ORDER", "The pairing completion sequence is invalid.");
        return;
      }
      if (!state.pairingFlow) {
        await this.sendProtocolError(socket, "PAIRING_STATE_INVALID", "No pairing challenge is active.");
        return;
      }
      const pending = this.options.pairings.complete(envelope, this.now());
      await this.sendSigned(socket, "pairing.pending", PRE_SESSION_ID, pending, state.preSessionServerSequence++);
      return;
    }
    if (envelope.type === "client.authenticate") {
      const expectedSequence = state.pairingFlow ? 2 : 0;
      if (envelope.sequence !== expectedSequence) {
        await this.sendProtocolError(socket, "SEQUENCE_OUT_OF_ORDER", "The authentication sequence is invalid.");
        return;
      }
      await this.authenticate(state, envelope);
      return;
    }
    await this.sendProtocolError(socket, "SESSION_REQUIRED", "The v2 session is not authenticated.");
  }

  private async authenticate(state: PendingSocket, envelope: RemoteEnvelope): Promise<void> {
    const payloadResult = safeParseRemotePayload("client.authenticate", envelope.payload);
    if (!payloadResult.success) {
      await this.sendProtocolError(state.socket, "INVALID_PAYLOAD", "Authentication payload is invalid.");
      return;
    }
    const payload = payloadResult.data;
    const device = this.options.pairings.getTrustedDeviceByKeyId(envelope.keyId);
    if (!device) {
      await this.sendProtocolError(state.socket, "UNKNOWN_KEY", "This phone has not been approved on the PC.");
      return;
    }
    if (device.revoked) {
      await this.sendProtocolError(state.socket, "REVOKED_DEVICE", "This phone has been revoked on the PC.");
      state.socket.close(1008, "Device revoked");
      return;
    }
    if (payload.publicKey !== device.publicKeySpki || envelope.keyId !== device.keyId) {
      await this.sendProtocolError(state.socket, "INVALID_SIGNATURE", "Phone identity does not match the trusted device.");
      return;
    }
    const pairingApproval = state.approvedPayload;
    const expectedServerNonce = pairingApproval?.serverNonce ?? state.serverNonce;
    const expectedClientNonce = pairingApproval?.clientNonce;
    if (payload.serverNonce !== expectedServerNonce || (expectedClientNonce && payload.clientNonce !== expectedClientNonce)) {
      await this.sendProtocolError(state.socket, "INVALID_SIGNATURE", "The handshake nonce does not match this connection.");
      return;
    }
    const guard = new RemoteSessionGuard({
      sessionId: PRE_SESSION_ID,
      keyId: device.keyId,
      publicKey: device.publicKeySpki,
      direction: "client_to_server",
      lastAcceptedSequence: envelope.sequence - 1,
      maxMessageAgeMs: 90_000,
    });
    const verified = guard.verifyAndAccept(envelope, this.now());
    if (!verified.accepted) {
      await this.sendProtocolError(state.socket, "INVALID_SIGNATURE", "Phone authentication signature or freshness check failed.");
      return;
    }

    const sessionId = randomUUID();
    const manifest = this.options.tasks.manifestSnapshot(device.keyId);
    const expiresAt = this.now() + this.sessionTtlMs;
    const active: ActiveSocket = {
      socket: state.socket,
      keyId: device.keyId,
      deviceId: device.deviceId,
      sessionId,
      guard: new RemoteSessionGuard({
        sessionId,
        keyId: device.keyId,
        publicKey: device.publicKeySpki,
        direction: "client_to_server",
        lastAcceptedSequence: 0,
      }),
      serverSequence: 0,
      eventSequence: 0,
      expiresAt,
      inboundMessageTimes: [],
    };
    this.sockets.set(state.socket, active);
    const sessions = this.activeByDeviceId.get(device.deviceId) ?? new Set<ActiveSocket>();
    sessions.add(active);
    this.activeByDeviceId.set(device.deviceId, sessions);

    await this.sendSigned(state.socket, "session.ready", sessionId, {
      sessionId,
      deviceId: device.deviceId,
      grantedScopes: [...device.grantedScopes],
      manifestVersion: manifest.manifestVersion,
      serverEventSeq: 0,
      serverNonce: expectedServerNonce,
      clientNonce: payload.clientNonce,
      issuedAt: this.now(),
      expiresAt,
    }, active.serverSequence++);
    if (state.pairingId) this.pendingByPairingId.delete(state.pairingId);
  }

  private async handleAuthenticatedMessage(state: ActiveSocket, envelope: RemoteEnvelope): Promise<void> {
    if (state.expiresAt <= this.now()) {
      await this.sendSigned(state.socket, "session.close", state.sessionId, { reason: "expired" }, state.serverSequence++);
      state.socket.close(1008, "Session expired");
      return;
    }
    const trusted = this.options.pairings.getTrustedDeviceByKeyId(state.keyId);
    if (!trusted || trusted.revoked || trusted.deviceId !== state.deviceId) {
      await this.sendSigned(state.socket, "session.close", state.sessionId, { reason: "revoked" }, state.serverSequence++);
      state.socket.close(1008, "Device trust changed");
      return;
    }
    const verified = state.guard.verifyAndAccept(envelope, this.now());
    if (!verified.accepted) {
      await this.sendProtocolError(state.socket, "INVALID_SIGNATURE", "The message failed session signature, sequence or replay checks.", state.sessionId);
      return;
    }

    switch (envelope.type) {
      case "manifest.get": {
        const manifest = this.options.tasks.manifestSnapshot(state.keyId);
        await this.sendSigned(state.socket, "manifest.snapshot", state.sessionId, manifest, state.serverSequence++);
        return;
      }
      case "task.submit": {
        const submitted = await this.options.tasks.submitTask(state.keyId, envelope.payload);
        await this.sendSigned(state.socket, "task.accepted", state.sessionId, submitted.accepted, state.serverSequence++);
        if (submitted.confirmationRequired) {
          await this.sendSigned(state.socket, "task.confirmation_required", state.sessionId, submitted.confirmationRequired, state.serverSequence++);
        }
        return;
      }
      case "task.cancel": {
        const ack = await this.options.tasks.cancelTask(state.keyId, envelope.payload);
        await this.sendSigned(state.socket, "task.cancel_ack", state.sessionId, ack, state.serverSequence++);
        return;
      }
      case "task.confirmation_response": {
        await this.options.tasks.confirmTask(state.keyId, envelope.payload);
        return;
      }
      case "ping": {
        const ping = safeParseRemotePayload("ping", envelope.payload);
        if (!ping.success) return;
        await this.sendSigned(state.socket, "pong", state.sessionId, {
          sentAt: ping.data.sentAt,
          receivedAt: this.now(),
        }, state.serverSequence++);
        return;
      }
      default:
        await this.sendProtocolError(state.socket, "UNKNOWN_MESSAGE_TYPE", "This message is not supported in the authenticated session.", state.sessionId);
    }
  }

  private async publishTaskToSession(session: ActiveSocket, task: RemoteGatewayTask, ephemeralResult?: unknown): Promise<void> {
    const stateMap: Record<RemoteGatewayTask["state"], RemotePayloadFor<"task.progress">["state"]> = {
      queued: "queued",
      validating: "validating",
      awaiting_confirm: "awaiting_approval",
      running: "running",
      verifying: "verifying",
      done: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
      timed_out: "timed_out",
    };
    const state = stateMap[task.state];
    if (["done", "failed", "cancelled", "timed_out"].includes(task.state)) {
      const result = task.result ?? ephemeralResult;
      let safeResult: unknown;
      if (result !== undefined) {
        try {
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded, "utf8") <= 12 * 1024) safeResult = JSON.parse(encoded);
        } catch {
          safeResult = undefined;
        }
      }
      const status: RemotePayloadFor<"task.result">["status"] =
        task.state === "done" ? "succeeded" :
          task.state === "cancelled" ? "cancelled" :
            task.state === "timed_out" ? "timed_out" : "failed";
      await this.sendSigned(session.socket, "task.result", session.sessionId, {
        taskId: task.taskId,
        status,
        verification: task.state === "done"
          ? { status: "verified", summary: "PC-side verification passed." }
          : { status: "failed", summary: "The PC did not produce a verified successful result." },
        safeSummary: task.state === "done"
          ? "Task completed and passed PC-side verification."
          : (task.error ?? "Task did not complete successfully.").slice(0, 500),
        ...(safeResult !== undefined ? { result: safeResult } : {}),
        eventSeq: ++session.eventSequence,
        completedAt: this.now(),
      }, session.serverSequence++);
      return;
    }
    await this.sendSigned(session.socket, "task.progress", session.sessionId, {
      taskId: task.taskId,
      state,
      eventSeq: ++session.eventSequence,
      safeSummary: ({
        queued: "Task queued on the PC.",
        validating: "PC is validating the requested action.",
        awaiting_confirm: "Waiting for user approval.",
        running: "PC is executing the action.",
        verifying: "PC is independently verifying the result.",
      } as Record<string, string>)[task.state],
    }, session.serverSequence++);
  }

  private async sendProtocolError(
    socket: WebSocket,
    code: RemotePayloadFor<"protocol.error">["code"],
    message: string,
    sessionId = PRE_SESSION_ID,
  ): Promise<void> {
    const state = this.sockets.get(socket);
    const sequence = state && "serverSequence" in state
      ? state.serverSequence++
      : state && "preSessionServerSequence" in state
        ? state.preSessionServerSequence++
        : 0;
    if (socket.readyState === WebSocket.OPEN) {
      await this.sendSigned(socket, "protocol.error", sessionId, { code, message }, sequence).catch(() => undefined);
    }
  }

  private async sendSigned<T extends RemoteMessageType>(
    socket: WebSocket,
    type: T,
    sessionId: string,
    payload: RemotePayloadFor<T>,
    sequence: number,
  ): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    const unsigned = {
      v: 2 as const,
      messageId: randomUUID(),
      sessionId,
      type,
      sentAt: this.now(),
      sequence,
      keyId: this.options.signer.keyId,
      payload,
    };
    const signed = await this.options.signer.sign(unsigned);
    const parsed = safeParseRemoteEnvelope(signed);
    if (!parsed.success || parsed.data.keyId !== this.options.signer.keyId || parsed.data.type !== type) {
      throw new Error("PC signing provider returned an invalid envelope.");
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(signed));
  }

  private dropSocket(socket: WebSocket): void {
    const state = this.sockets.get(socket);
    if (state && "deviceId" in state) {
      const sessions = this.activeByDeviceId.get(state.deviceId);
      sessions?.delete(state);
      if (sessions?.size === 0) this.activeByDeviceId.delete(state.deviceId);
    }
    if (state && "pairingId" in state && state.pairingId) this.pendingByPairingId.delete(state.pairingId);
    this.sockets.delete(socket);
  }

  private assertSafeBind(host: string, allowTailscale: boolean): void {
    if (!host || ["0.0.0.0", "::", "::0", "*"].includes(host)) {
      throw new Error("Remote v2 gateway cannot bind to a wildcard address.");
    }
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (loopback) return;
    const octets = host.split(".").map(Number);
    const tailscale = isIPv4(host) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    if (!tailscale || !allowTailscale) {
      throw new Error("A non-loopback bind requires explicit opt-in and one Tailscale IPv4 address in 100.64.0.0/10.");
    }
  }
}
