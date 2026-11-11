import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { ProtocolMessageSchema, PROTOCOL_VERSION, type ErrorCode, type ProtocolMessage } from "@vanessa/shared/protocol";

export const GATEWAY_MAX_PAYLOAD_BYTES = 1_048_576;
export const GATEWAY_RATE_LIMIT = 60;
export const GATEWAY_RATE_WINDOW_MS = 60_000;

export type GatewayTool = {
  name: string;
  description: string;
  argsSchema: Record<string, unknown>;
  tier: 0 | 1 | 2;
};

export type GatewayOptions = {
  host: string;
  port: number;
  getManifest: () => { version: string; tools: GatewayTool[] };
  submitTask: (message: Extract<ProtocolMessage, { type: "task.submit" }>, clientId: string) => Promise<{ taskId: string; state?: string; actionHash?: string; expiresAt?: number; summary?: string }>;
  cancelTask?: (taskId: string) => Promise<void>;
  confirmTask?: (message: Extract<ProtocolMessage, { type: "task.confirm" }>) => Promise<void>;
  now?: () => number;
  maxPayloadBytes?: number;
  rateLimit?: number;
  rateWindowMs?: number;
};

type RateState = { count: number; resetAt: number };

export function makeGatewayError(code: ErrorCode, message: string, taskId?: string): ProtocolMessage {
  return { v: PROTOCOL_VERSION, id: randomUUID(), type: "task.error", code, message, ...(taskId ? { taskId } : {}) };
}

export class MobileGateway {
  private readonly rateStates = new Map<string, RateState>();
  private readonly taskOwners = new Map<string, WebSocket>();
  private readonly pendingTaskEvents = new Map<string, Array<{ taskId: string; state: string; result?: unknown; error?: string; ephemeralResult?: unknown }>>();
  private readonly now: () => number;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? Date.now;
    this.maxPayloadBytes = options.maxPayloadBytes ?? GATEWAY_MAX_PAYLOAD_BYTES;
    this.rateLimit = options.rateLimit ?? GATEWAY_RATE_LIMIT;
    this.rateWindowMs = options.rateWindowMs ?? GATEWAY_RATE_WINDOW_MS;
  }

  createServer(): WebSocketServer {
    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      // Allow the application-level guard to return a protocol error for a
      // slightly oversize frame; larger frames are still rejected by ws.
      maxPayload: this.maxPayloadBytes + 64 * 1024,
      perMessageDeflate: false,
      clientTracking: true,
    });
    server.on("connection", (socket, request) => {
      const client = request.socket.remoteAddress || "unknown";
      socket.on("message", (raw) => void this.receive(socket, client, raw));
      socket.on("close", () => {
        for (const [taskId, owner] of this.taskOwners) if (owner === socket) this.taskOwners.delete(taskId);
      });
    });
    return server;
  }

  private consumeRate(client: string): boolean {
    const timestamp = this.now();
    let state = this.rateStates.get(client);
    if (!state || state.resetAt <= timestamp) {
      state = { count: 0, resetAt: timestamp + this.rateWindowMs };
      this.rateStates.set(client, state);
    }
    state.count++;
    if (this.rateStates.size > 10_000) {
      for (const [key, candidate] of this.rateStates) if (candidate.resetAt <= timestamp) this.rateStates.delete(key);
    }
    return state.count <= this.rateLimit;
  }

  private send(socket: WebSocket, value: ProtocolMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }

  publishTask(task: { taskId: string; state: string; result?: unknown; error?: string; ephemeralResult?: unknown }): void {
    const socket = this.taskOwners.get(task.taskId);
    if (!socket) {
      if (task.state !== "awaiting_confirm") {
        const pending = this.pendingTaskEvents.get(task.taskId) ?? [];
        pending.push(task);
        this.pendingTaskEvents.set(task.taskId, pending);
        while (this.pendingTaskEvents.size > 1000) this.pendingTaskEvents.delete(this.pendingTaskEvents.keys().next().value!);
      }
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    const id = randomUUID();
    if (task.state === "done") this.send(socket, { v: PROTOCOL_VERSION, id, type: "task.result", taskId: task.taskId, status: "done", result: task.result ?? task.ephemeralResult ?? null });
    else if (["failed", "cancelled", "timed_out"].includes(task.state)) this.send(socket, makeGatewayError(task.state === "cancelled" ? "TASK_CANCELLED" : "TASK_FAILED", task.error ?? `Task ${task.state}.`, task.taskId));
    else this.send(socket, { v: PROTOCOL_VERSION, id, type: "task.progress", taskId: task.taskId, state: task.state as "queued" | "validating" | "awaiting_confirm" | "running" | "verifying", message: task.state });
  }

  private async receive(socket: WebSocket, client: string, raw: RawData): Promise<void> {
    const bytes = rawBytes(raw);
    if (bytes.byteLength > this.maxPayloadBytes) {
      this.send(socket, makeGatewayError("PAYLOAD_TOO_LARGE", "Message exceeds the gateway size limit."));
      return;
    }
    if (!this.consumeRate(client)) {
      this.send(socket, makeGatewayError("RATE_LIMITED", "Too many requests from this device."));
      return;
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch {
      this.send(socket, makeGatewayError("INVALID_MESSAGE", "Message must contain valid JSON."));
      return;
    }
    if (value && typeof value === "object" && "v" in value && (value as { v?: unknown }).v !== PROTOCOL_VERSION) {
      this.send(socket, makeGatewayError("UNSUPPORTED_VERSION", "Protocol version is not supported."));
      return;
    }
    const parsed = ProtocolMessageSchema.safeParse(value);
    if (!parsed.success) {
      const unknownType = Boolean(value && typeof value === "object" && "type" in value && typeof (value as { type?: unknown }).type === "string" && !KNOWN_TYPES.has((value as { type: string }).type));
      this.send(socket, makeGatewayError(unknownType ? "UNKNOWN_MESSAGE_TYPE" : "INVALID_MESSAGE", unknownType ? "Message type is not supported." : "Message does not match the protocol schema."));
      return;
    }
    await this.dispatch(socket, client, parsed.data);
  }

  private async dispatch(socket: WebSocket, clientId: string, message: ProtocolMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ping":
          this.send(socket, { v: PROTOCOL_VERSION, id: message.id, type: "ping", sentAt: this.now() });
          break;
        case "manifest.sync": {
          const manifest = this.options.getManifest();
          this.send(socket, { v: PROTOCOL_VERSION, id: message.id, type: "manifest.sync", manifestVersion: manifest.version, tools: manifest.tools });
          break;
        }
        case "task.submit": {
          const result = await this.options.submitTask(message, clientId);
          this.taskOwners.set(result.taskId, socket);
          this.send(socket, { v: PROTOCOL_VERSION, id: message.id, type: "task.accepted", taskId: result.taskId });
          if (result.state === "awaiting_confirm" && result.actionHash && result.expiresAt) this.send(socket, { v: PROTOCOL_VERSION, id: randomUUID(), type: "task.confirm_required", taskId: result.taskId, summary: result.summary ?? "This action needs confirmation on the PC.", actionHash: result.actionHash, expiresAt: result.expiresAt });
          const pending = this.pendingTaskEvents.get(result.taskId);
          if (pending) { this.pendingTaskEvents.delete(result.taskId); for (const event of pending) this.publishTask(event); }
          break;
        }
        case "task.cancel":
          if (!this.options.cancelTask) throw Object.assign(new Error("Task cancellation is unavailable."), { code: "TASK_NOT_FOUND" });
          await this.options.cancelTask(message.taskId);
          break;
        case "task.confirm":
          if (!this.options.confirmTask) throw Object.assign(new Error("Confirmation handling is unavailable."), { code: "PERMISSION_DENIED" });
          await this.options.confirmTask(message);
          break;
        default:
          this.send(socket, makeGatewayError("INVALID_MESSAGE", "This message is not a client request."));
      }
    } catch (error) {
      const candidate = error as { code?: unknown; message?: unknown };
      const knownCodes = new Set<ErrorCode>(["INVALID_ARGUMENTS", "PERMISSION_DENIED", "CONFIRMATION_REQUIRED", "CONFIRMATION_EXPIRED", "TASK_NOT_FOUND", "TASK_CANCELLED", "TASK_FAILED"]);
      const code = typeof candidate.code === "string" && knownCodes.has(candidate.code as ErrorCode) ? candidate.code as ErrorCode : "INTERNAL_ERROR";
      const messageText = typeof candidate.message === "string" ? candidate.message.slice(0, 500) : "Gateway request failed.";
      this.send(socket, makeGatewayError(code, messageText, "taskId" in message ? message.taskId : undefined));
    }
  }
}

const KNOWN_TYPES = new Set(["task.submit", "task.accepted", "task.progress", "task.confirm_required", "task.confirm", "task.result", "task.error", "task.cancel", "manifest.sync", "event.push", "ping"]);

function rawBytes(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}
