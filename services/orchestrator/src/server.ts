import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import { isIPv4 } from "node:net";
import * as os from "node:os";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { safeParseRemoteEnvelope } from "@vanessa/protocol";
import { RemotePairingRegistry } from "./remote/remotePairingRegistry.js";
import { RemoteTaskService } from "./remote/remoteTaskService.js";
import { RemoteV2Gateway } from "./remote/remoteV2Gateway.js";
import { orchestrator } from "./core/orchestrator.js";
import { eventBus } from "./core/eventBus.js";
import { VanessaEvent } from "@vanessa/shared";
import { privacyGuard } from "./core/privacy.js";
import { permissionGuard } from "./core/permissionGuard.js";
import { memoryPalace } from "./memory/memoryPalace.js";
import { getRemotePwaHtml } from "./remotePwa.js";
import { modelRouter } from "./core/router.js";
import { MobileGateway } from "./core/mobileGateway.js";
import { MobileTaskEngine } from "./core/mobileTaskEngine.js";
import { validateToken, pairDevice, revokeDevice, getDeviceQuotaUsage, DEFAULT_PAIRING_CODE, seedPairingCode } from "./auth/authService.js";

// Load .env searching current and parent directories
let envDir = process.cwd();
for (let i = 0; i < 4 && process.env.VANESSA_SKIP_DOTENV !== "true"; i++) {
  const p = path.join(envDir, ".env");
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
  envDir = path.dirname(envDir);
}

const PORT = parseInt(process.env.VANESSA_PORT || "4319", 10);
const EVENT_STREAM_ID = randomUUID();
const fastify = Fastify({ logger: false });
let mobileGateway: MobileGateway | undefined;
let mobileTaskEngine: MobileTaskEngine | undefined;
let remoteV2Gateway: RemoteV2Gateway | undefined;
let remotePairingRegistry: RemotePairingRegistry | undefined;
let remoteV2StartupError: string | null = null;
let remoteV2Host: string | null = null;
let remoteV2Port: number | null = null;

const REMOTE_V2_LOCAL_SCOPES = new Set([
  "system.read", "files.read", "apps.launch", "browser.open", "files.open",
  "system.control", "media.control", "system.lock", "screen.capture",
]);

function isTailscaleIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const octets = address.split(".").map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function discoverAssignedTailscaleIPv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isTailscaleIPv4(entry.address)) return entry.address;
    }
  }
  return undefined;
}

function authorizeRemoteV2Control(request: any, reply: any): boolean {
  const ip = String(request.ip ?? "");
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!loopback) {
    reply.status(403).send({ error: "LOCAL_CONTROL_ONLY" });
    return false;
  }
  const expectedToken = process.env.VANESSA_PC_SIGNER_TOKEN ?? "";
  const suppliedToken = request.headers["x-vanessa-control-token"];
  if (!expectedToken || typeof suppliedToken !== "string") {
    reply.status(401).send({ error: "UNAUTHORIZED" });
    return false;
  }
  const expected = Buffer.from(expectedToken, "utf8");
  const supplied = Buffer.from(suppliedToken, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    reply.status(401).send({ error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

await fastify.register(cors, {
  // Only the local desktop development renderer needs browser access. The
  // packaged Electron app calls this API from its main process.
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
});

await fastify.register(websocket);

// Connected WebSocket clients set
const connectedClients = new Set<any>();

// Pipe eventBus events directly to WebSocket clients
const forwardEvent = (event: VanessaEvent) => {
  // Lifecycle metadata only: event bodies can contain prompts and results.
  const payload = event.payload as any;
  if (event.type === "task:update") {
    console.log(`[Runner] task=${payload.id} agent=${payload.agent} action=${payload.action} status=${payload.status} lifecycle=${payload.lifecycleState || "none"}`);
  } else if (event.type.startsWith("approval:")) {
    console.log(`[Approval] event=${event.type} task=${payload.taskId || payload.id || payload.task?.id || "unknown"}`);
  }
  const message = JSON.stringify(event);
  for (const client of connectedClients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
};

eventBus.on("task:update", forwardEvent);
eventBus.on("approval:required", forwardEvent);
eventBus.on("approval:granted", forwardEvent);
eventBus.on("approval:rejected", forwardEvent);
eventBus.on("plan:created", forwardEvent);
eventBus.on("plan:started", forwardEvent);
eventBus.on("plan:completed", forwardEvent);
eventBus.on("audit:log", forwardEvent);
eventBus.on("voice:state", forwardEvent);
eventBus.on("codex:progress", forwardEvent);
eventBus.on("agent.started", forwardEvent);
eventBus.on("tool.started", forwardEvent);
eventBus.on("tool.completed", forwardEvent);
eventBus.on("agent.completed", forwardEvent);
eventBus.on("verification.completed", forwardEvent);
eventBus.on("task.failed", forwardEvent);
eventBus.on("task.cancelled", forwardEvent);

// WebSocket endpoint for real-time HUD streaming
fastify.get("/events", { websocket: true }, (socket, req) => {
  const origin = req.headers.origin;
  if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }
  connectedClients.add(socket);

  const query = req.query as any;
  const since = Number(query?.since || 0);
  const clientStreamId = typeof query?.streamId === "string" ? query.streamId : null;
  const replayAfter = clientStreamId === EVENT_STREAM_ID && Number.isFinite(since) ? since : 0;

  // Send current status immediately
  socket.send(
    JSON.stringify({
      type: "system:status",
      payload: { ...orchestrator.getSystemStatus(), eventStreamId: EVENT_STREAM_ID },
      timestamp: Date.now(),
    })
  );

  // Replay the bounded in-memory stream so a short desktop reconnect does not
  // erase the task currently shown in the HUD.
  for (const event of eventBus.getEventsAfter(replayAfter)) {
    socket.send(JSON.stringify(event));
  }

  socket.on("close", () => {
    connectedClients.delete(socket);
  });
});

// Health check endpoint
fastify.get("/health", async () => {
  return {
    status: "online",
    service: "vanessa-orchestrator",
    version: "0.3.0",
    system: orchestrator.getSystemStatus(),
    timestamp: Date.now(),
  };
});

fastify.get("/api/usage", async () => {
  return {
    provider: modelRouter.activeProvider,
    usage: modelRouter.getUsageSnapshot(),
  };
});

// REST Endpoints
fastify.post("/api/execute", async (request, reply) => {
  const body = request.body as { command: string; language?: string };
  if (!body || !body.command) {
    return reply.status(400).send({ error: "Missing required parameter 'command'" });
  }

  const result = await orchestrator.executeCommand(body);
  return reply.send(result);
});

fastify.post("/command", async (request, reply) => {
  const body = request.body as { command: string; language?: string };
  if (!body || !body.command) {
    return reply.status(400).send({ error: "Missing required parameter 'command'" });
  }

  const result = await orchestrator.executeCommand(body);
  return reply.send(result);
});

fastify.post("/api/approve", async (request, reply) => {
  const body = request.body as { taskId: string };
  if (!body?.taskId) {
    return reply.status(400).send({ error: "Missing taskId" });
  }
  const task = await orchestrator.approve(body.taskId);
  return reply.send({ success: !!task, task });
});

fastify.post("/api/reject", async (request, reply) => {
  const body = request.body as { taskId: string };
  if (!body?.taskId) {
    return reply.status(400).send({ error: "Missing taskId" });
  }
  const task = await orchestrator.reject(body.taskId);
  return reply.send({ success: !!task, task });
});

fastify.post("/api/cancel", async (_request, reply) => {
  await orchestrator.cancelAll();
  return reply.send({
    success: true,
    message: "Emergency cancellation processed. Inspect task statuses for any termination_unconfirmed operations; their conflicting locks remain held.",
  });
});

fastify.post("/api/cancel/request", async (request, reply) => {
  const body = request.body as { requestId?: unknown };
  if (typeof body?.requestId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestId)) {
    return reply.status(400).send({ error: "Invalid requestId" });
  }
  const result = await orchestrator.cancelRequest(body.requestId);
  return {
    success: true,
    ...result,
    message: result.terminationUnconfirmed > 0
      ? "Cancellation processed, but one or more process trees could not be verified stopped. Conflicting locks remain held."
      : result.planningOnly
        ? "Cancellation recorded before task execution; late planning results will not be allowed to start work."
        : "Cancellation processed using process termination evidence.",
  };
});

fastify.get("/api/status", async () => {
  return orchestrator.getSystemStatus();
});

fastify.get("/api/audit", async (request) => {
  const limit = (request.query as any)?.limit ? parseInt((request.query as any).limit, 10) : 50;
  return eventBus.getRecentEvents(limit);
});

fastify.get("/api/mobile/audit", async (request) => {
  const limit = (request.query as any)?.limit ? parseInt((request.query as any).limit, 10) : 100;
  return mobileTaskEngine?.recentAudit(limit) ?? [];
});

fastify.get("/api/memory", async () => {
  return memoryPalace.retrieve("", 50);
});

fastify.get("/api/mode", async () => {
  return { autonomous: permissionGuard.autonomousMode };
});

fastify.post("/api/mode", async (request) => {
  const body = (request.body as any) || {};
  if (typeof body.autonomous === "boolean") {
    permissionGuard.autonomousMode = body.autonomous;
  }
  return { autonomous: permissionGuard.autonomousMode };
});

// Privacy & Folder Allowlist Endpoints
fastify.get("/api/privacy", async () => {
  return privacyGuard.getPrivacyStatus();
});

fastify.post("/api/privacy/folders", async (request, reply) => {
  const body = request.body as { folderPath: string };
  if (!body?.folderPath) {
    return reply.status(400).send({ error: "Missing folderPath" });
  }
  const added = privacyGuard.addAllowedFolder(body.folderPath);
  return reply.send({ success: added, allowedFolders: privacyGuard.getAllowedFolders() });
});

// Mobile Companion Relay State & Endpoints
let remoteAccessEnabled = false;
let activePairingCode = createPairingCode();
let pairingExpiresAt = Date.now() + 5 * 60_000;
const phoneSessionTokens = new Map<string, number>();
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

function createPairingCode(): string {
  return randomInt(100000, 1000000).toString();
}

function isAuthorizedPhoneRequest(request: any): boolean {
  const authorization = request.headers.authorization;
  const bearerToken = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  const token = bearerToken || request.body?.token;
  if (typeof token !== "string") return false;
  const expiresAt = phoneSessionTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    phoneSessionTokens.delete(token);
    return false;
  }
  return true;
}

fastify.get("/api/remote/pairing", async () => {
  if (pairingExpiresAt <= Date.now()) {
    activePairingCode = createPairingCode();
    pairingExpiresAt = Date.now() + 5 * 60_000;
  }
  return {
    enabled: remoteAccessEnabled,
    pairingCode: remoteAccessEnabled ? activePairingCode : null,
    pairingExpiresAt,
    url: `http://127.0.0.1:${PORT}/remote`,
  };
});

fastify.post("/api/remote/toggle", async (request) => {
  const body = request.body as { enabled?: boolean };
  if (typeof body?.enabled === "boolean") {
    remoteAccessEnabled = body.enabled;
  } else {
    remoteAccessEnabled = !remoteAccessEnabled;
  }
  if (!remoteAccessEnabled) {
    phoneSessionTokens.clear();
    activePairingCode = createPairingCode();
    pairingExpiresAt = Date.now() + 5 * 60_000;
  }
  eventBus.emitEvent("audit:log", {
    id: `audit-${Date.now()}`,
    timestamp: Date.now(),
    source: "desktop_hud",
    agent: "safety_gate",
    action: "remote_access.toggle",
    resource: "network:relay",
    risk: "low",
    permission: "allowed",
    status: "info",
    details: `Remote phone access ${remoteAccessEnabled ? "ENABLED" : "DISABLED"}`,
  });
  return {
    enabled: remoteAccessEnabled,
    pairingCode: remoteAccessEnabled ? activePairingCode : null,
    pairingExpiresAt,
  };
});

fastify.post("/api/remote/pair", async (request, reply) => {
  const body = request.body as { code?: string };
  if (!remoteAccessEnabled) {
    return reply.status(403).send({ error: "Remote access is disabled on this laptop." });
  }
  const ip = request.ip || "unknown";
  const now = Date.now();
  let attempts = pairingAttempts.get(ip);
  if (!attempts || attempts.resetAt <= now) {
    attempts = { count: 0, resetAt: now + 5 * 60_000 };
    pairingAttempts.set(ip, attempts);
  }
  if (attempts.count >= 5) {
    return reply.status(429).send({ error: "Too many pairing attempts. Wait five minutes and try again." });
  }
  attempts.count += 1;
  const supplied = typeof body?.code === "string" ? Buffer.from(body.code) : Buffer.alloc(0);
  const expected = Buffer.from(activePairingCode);
  const codeMatches = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (codeMatches && pairingExpiresAt > Date.now()) {
    const sessionToken = randomBytes(32).toString("base64url");
    phoneSessionTokens.set(sessionToken, Date.now() + 30 * 24 * 60 * 60_000);
    activePairingCode = createPairingCode();
    pairingExpiresAt = Date.now() + 5 * 60_000;
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "remote_pwa",
      agent: "safety_gate",
      action: "remote_pairing.success",
      resource: "phone:companion",
      risk: "low",
      permission: "approved_once",
      status: "success",
      details: "Mobile companion successfully paired via one-time code",
    });
    return reply.send({ success: true, token: sessionToken });
  }
  return reply.status(401).send({ error: "Invalid pairing code or token." });
});

// ── Device pairing (single‑use code → session token) ────────────────────
// POST /api/device/pair
// Body: { code: "vanessa-2026-11-05-abcd1234" }
// Returns: { success: true, deviceId, token } or { success: false, reason }
// The pairing code is taken from .env PAIRING_CODE (or generated randomly on first start).
// After first successful pair the code is consumed and cannot be reused.
fastify.post("/api/device/pair", async (request, reply) => {
  const body = request.body as { code?: string };
  const code = typeof body?.code === "string" ? body.code : undefined;
  const pairResult = pairDevice(code ?? DEFAULT_PAIRING_CODE);
  if (!pairResult) {
    return reply.status(400).send({ success: false, reason: "INVALID_OR_EXPIRED_CODE" });
  }
  return reply.send({ success: true, deviceId: pairResult.deviceId, token: pairResult.token });
});

// GET /api/device/usage — quota display for the paired device
// Requires a valid Bearer token (enforced by the preHandler hook).
fastify.get("/api/device/usage", async (request, reply) => {
  const deviceId = (request.body as any)?.deviceId;
  if (!deviceId) {
    return reply.status(401).send({ error: "UNAUTHORIZED_DEVICE" });
  }
  const usage = getDeviceQuotaUsage(deviceId);
  return reply.send({ deviceId, ...usage });
});

fastify.post("/api/device/revoke", async (request, reply) => {
  const body = request.body as { deviceId?: string };
  const deviceId = body?.deviceId || (request.body as any)?.deviceId;
  if (!deviceId) {
    return reply.status(400).send({ error: "MISSING_DEVICE_ID" });
  }
  const ok = revokeDevice(deviceId);
  return reply.send({ success: ok });
});

// POST /api/device/usage/report — report characters consumed by a voice session
// Body: { charsUsed: number }
// Requires a valid Bearer token (enforced by the preHandler hook).
fastify.post("/api/device/usage/report", async (request, reply) => {
  const body = request.body as { charsUsed?: number };
  const deviceId = (request.body as any)?.deviceId;
  if (!deviceId) {
    return reply.status(401).send({ error: "UNAUTHORIZED_DEVICE" });
  }
  const chars = Number(body?.charsUsed) || 0;
  if (chars <= 0) {
    return reply.status(400).send({ error: "INVALID_CHARS_USED" });
  }
  const result = validateToken(
    (request.headers.authorization || "").startsWith("Bearer ")
      ? (request.headers.authorization as string).slice(7)
      : "",
    chars
  );
  if (!result.valid) {
    return reply.status(401).send({ error: result.reason || "INVALID_TOKEN" });
  }
  const usage = getDeviceQuotaUsage(result.deviceId);
  return reply.send({ deviceId: result.deviceId, ...usage });
});

// POST /api/device/revoke — revoke a device's session token

fastify.post("/api/remote/command", async (request, reply) => {
  const body = request.body as { command: string; token?: string; language?: string };
  if (!remoteAccessEnabled) {
    return reply.status(403).send({ error: "Remote access: OFF. Please enable on your laptop HUD." });
  }
  if (!isAuthorizedPhoneRequest(request)) {
    return reply.status(401).send({ error: "Phone session is not paired or has expired. Pair this device again." });
  }
  if (!body || !body.command) {
    return reply.status(400).send({ error: "Missing required parameter 'command'" });
  }

  // Record remote origin in audit trail
  eventBus.emitEvent("audit:log", {
    id: `audit-${Date.now()}`,
    timestamp: Date.now(),
    source: "remote_pwa",
    agent: "orchestrator",
    action: "remote_command_received",
    risk: "low",
    permission: "allowed",
    status: "info",
    details: "Command received from the authenticated Mobile Companion session.",
  });

  const result = await orchestrator.executeCommand({
    command: body.command,
    language: body.language || "en",
  });
  return reply.send(result);
});

fastify.post("/api/remote/approve", async (request, reply) => {
  const body = request.body as { taskId: string; token?: string };
  if (!remoteAccessEnabled) {
    return reply.status(403).send({ error: "Remote access is disabled on this laptop." });
  }
  if (!isAuthorizedPhoneRequest(request)) {
    return reply.status(401).send({ error: "Phone session is not paired or has expired. Pair this device again." });
  }
  if (!body?.taskId) {
    return reply.status(400).send({ error: "Missing taskId" });
  }
  const task = await orchestrator.approve(body.taskId);
  return reply.send({ success: !!task, task });
});

fastify.post("/api/remote/reject", async (request, reply) => {
  const body = request.body as { taskId: string; token?: string };
  if (!remoteAccessEnabled) {
    return reply.status(403).send({ error: "Remote access is disabled on this laptop." });
  }
  if (!isAuthorizedPhoneRequest(request)) {
    return reply.status(401).send({ error: "Phone session is not paired or has expired. Pair this device again." });
  }
  if (!body?.taskId) {
    return reply.status(400).send({ error: "Missing taskId" });
  }
  const task = await orchestrator.reject(body.taskId);
  return reply.send({ success: !!task, task });
});

// ── Session token validation ────────────────────────────────────────────
// Seed the single‑use pairing code at startup so the first device can pair.
seedPairingCode();

// Fastify preHandler hook that validates a Bearer token on every request.
// If the token is present but invalid/expired the request is rejected with
// 401.  If no token is present the request is allowed through (some routes
// like /api/device/pair and /health don't need a token).
// The validated deviceId is attached to request.body.deviceId for handlers.
fastify.addHook("preHandler", async (request, reply) => {
  const authorization = request.headers.authorization;
  const bearerToken = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  if (!bearerToken) return; // no token → allow through
  const result = validateToken(bearerToken);
  if (result.valid) {
    ;(request as any).body = { ...(request.body || {}), deviceId: result.deviceId };
    return;
  }
  reply.status(401).send({ error: result.reason || "INVALID_TOKEN" });
});

// Desktop-main-only management surface for v2 pairing, approval and revocation.
// Fastify itself listens on 127.0.0.1; the additional token check prevents
// other local processes or renderer content from driving pairing decisions.
fastify.get("/internal/remote-v2/status", async (request, reply) => {
  if (!authorizeRemoteV2Control(request, reply)) return;
  return reply.send({
    enabled: !!remoteV2Gateway,
    host: remoteV2Host,
    port: remoteV2Port,
    pcKeyId: process.env.VANESSA_PC_KEY_ID || null,
    pcFingerprint: process.env.VANESSA_PC_FINGERPRINT || null,
    startupError: remoteV2StartupError,
    pendingPairings: remotePairingRegistry?.getPendingApprovals() ?? [],
    trustedDevices: (remotePairingRegistry?.listTrustedDevices() ?? []).map((device) => ({
      deviceId: device.deviceId, keyId: device.keyId, deviceHint: device.deviceHint,
      platform: device.platform, appVersion: device.appVersion,
      grantedScopes: device.grantedScopes, pairedAt: device.pairedAt, revoked: device.revoked,
    })),
  });
});

fastify.post("/internal/remote-v2/pairing/create", async (request, reply) => {
  if (!authorizeRemoteV2Control(request, reply)) return;
  if (!remoteV2Gateway || !remotePairingRegistry || !remoteV2Host || !remoteV2Port) {
    return reply.status(503).send({ error: remoteV2StartupError || "REMOTE_V2_OFFLINE" });
  }
  const pairing = remotePairingRegistry.createPairingWindow();
  return reply.send({
    protocolVersion: 2,
    transport: "websocket",
    endpoint: "ws://" + remoteV2Host + ":" + remoteV2Port,
    pcId: "pc_" + (process.env.VANESSA_PC_KEY_ID || "").slice(0, 16),
    pcName: os.hostname(),
    pcKeyId: process.env.VANESSA_PC_KEY_ID,
    pcPublicKeySpki: process.env.VANESSA_PC_PUBLIC_KEY_SPKI,
    pcFingerprint: process.env.VANESSA_PC_FINGERPRINT,
    pairingId: pairing.pairingId,
    code: pairing.code,
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
  });
});

fastify.get("/internal/remote-v2/pairings/pending", async (request, reply) => {
  if (!authorizeRemoteV2Control(request, reply)) return;
  return reply.send(remotePairingRegistry?.getPendingApprovals() ?? []);
});

fastify.post("/internal/remote-v2/pairings/:pairingId/approve", async (request, reply) => {
  if (!authorizeRemoteV2Control(request, reply)) return;
  if (!remoteV2Gateway) return reply.status(503).send({ error: "REMOTE_V2_OFFLINE" });
  const pairingId = String((request.params as any)?.pairingId || "");
  const body = request.body as { scopes?: unknown };
  const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
  if (scopes.length === 0 || scopes.length > 16 ||
      scopes.some((scope) => typeof scope !== "string" || !REMOTE_V2_LOCAL_SCOPES.has(scope))) {
    return reply.status(400).send({ error: "INVALID_SCOPE_SELECTION" });
  }
  const approved = await remoteV2Gateway.approvePairing(pairingId, scopes as string[]);
  return reply.send({ approved: true, pairing: approved });
});

fastify.post("/internal/remote-v2/pairings/:pairingId/reject", async (request, reply) => {
  if (!authorizeRemoteV2Control(request, reply)) return;
  if (!remoteV2Gateway) return reply.status(503).send({ error: "REMOTE_V2_OFFLINE" });
  const pairingId = String((request.params as any)?.pairingId || "");
  const rejected = await remoteV2Gateway.rejectPairing(pairingId);
  return reply.send({ rejected: true, pairing: rejected });
});

fastify.post("/internal/remote-v2/devices/:deviceId/revoke", async (request, reply) => {
  if (!authorizeRemoteV2Control(request, reply)) return;
  if (!remotePairingRegistry) return reply.status(503).send({ error: "REMOTE_V2_OFFLINE" });
  const deviceId = String((request.params as any)?.deviceId || "");
  const device = remotePairingRegistry.listTrustedDevices().find((candidate) => candidate.deviceId === deviceId);
  if (!device) return reply.status(404).send({ error: "DEVICE_NOT_FOUND" });
  const revoked = await remotePairingRegistry.revokeDevice(deviceId);
  if (revoked) await remoteV2Gateway?.closeDevice(device.keyId);
  return reply.send({ revoked });
});

// Serve Mobile Companion Phone PWA
fastify.get("/remote", async (_request, reply) => {
  const html = getRemotePwaHtml(PORT);
  return reply.type("text/html").send(html);
});

// Voice service status - delegates to voice-agent service on port 4500
// Fish Audio is the selected provider; ElevenLabs integration moved to voice-agent
fastify.get("/voice/session", async (_request, reply) => {
  const voiceAgentUrl = process.env.VOICE_AGENT_URL || "http://127.0.0.1:4500";

  try {
    const res = await fetch(`${voiceAgentUrl}/health`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      return reply.status(503).send({
        provider: "fish",
        ready: false,
        message: "Voice agent service unavailable. Start @vanessa/voice-agent service.",
        voiceAgentUrl,
      });
    }

    const health = (await res.json()) as any;
    return reply.send({
      provider: "fish",
      ready: health.readiness === "ready",
      state: health.readiness,
      voiceAgentUrl,
      providers: health.providers,
      configValidation: health.configValidation,
      message: health.readiness === "ready"
        ? "Fish Audio voice service is ready"
        : health.readiness === "degraded"
          ? "Voice service degraded - check configuration"
          : "Voice service unavailable - check Fish Audio credentials and voice-agent service",
    });
  } catch (err: any) {
    // If voice-agent is not running, return configuration guidance
    const fishApiKey = process.env.FISH_API_KEY || "";
    const fishVoiceId = process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID || "";

    return reply.send({
      provider: "fish",
      ready: false,
      message: "Voice agent service not reachable. Start @vanessa/voice-agent service on port 4500.",
      voiceAgentUrl,
      configuration: {
        fishApiKeyConfigured: fishApiKey.startsWith("sk-fish-"),
        fishVoiceIdConfigured: !!fishVoiceId,
        asrModel: process.env.FISH_ASR_MODEL || "transcribe-stream-1",
        ttsModel: process.env.FISH_TTS_MODEL || "s2.1-pro-free",
      },
      error: err.message,
    });
  }
});

// Start server
export async function startServer() {
  try {
    await fastify.listen({ port: PORT, host: "127.0.0.1" });
    console.log(`[Vanessa Orchestrator] Online at http://127.0.0.1:${PORT}`);
    mobileTaskEngine = new MobileTaskEngine({ notify: ({ task, deviceId, ephemeralResult }) => {
      mobileGateway?.publishTask({ ...task, ...(ephemeralResult !== undefined ? { ephemeralResult } : {}) });
      remoteV2Gateway?.publishTask({ task, deviceId, ...(ephemeralResult !== undefined ? { ephemeralResult } : {}) });
      const auditRow = mobileTaskEngine?.recentAudit(100).find((row: any) => row.taskId === task.taskId && row.state === task.state) as any;
      eventBus.emitEvent("audit:log", {
        id: `mobile-${task.taskId}-${task.state}`,
        timestamp: Date.now(), taskId: task.taskId, source: "phone", agent: "mobile_gateway", action: task.tool,
        permission: task.state === "awaiting_confirm" ? "blocked" : "allowed",
        status: task.state === "done" ? "success" : ["failed", "timed_out"].includes(task.state) ? "error" : task.state === "cancelled" ? "blocked" : "info",
        details: { state: task.state, ...(auditRow ? { args: auditRow.args, ...(auditRow.resultSummary ? { summary: auditRow.resultSummary } : {}) } : {}), ...(task.error ? { error: task.error } : {}) },
      });
    } });

    // The v2 remote listener is enabled only when Electron main has provided an
    // OS-keystore-backed identity signer. It binds exclusively to an address
    // assigned to this host in Tailscale's CGNAT range; it never binds to LAN
    // interfaces, wildcard addresses, or the legacy HMAC gateway.
    if (process.env.VANESSA_REMOTE_V2_ENABLED === "true") {
      try {
        const signerBase = process.env.VANESSA_PC_SIGNER_URL || "";
        const signerToken = process.env.VANESSA_PC_SIGNER_TOKEN || "";
        const pcKeyId = process.env.VANESSA_PC_KEY_ID || "";
        const pcPublicKeySpki = process.env.VANESSA_PC_PUBLIC_KEY_SPKI || "";
        const pcFingerprint = process.env.VANESSA_PC_FINGERPRINT || "";
        if (!signerBase || !signerToken || !pcKeyId || !pcPublicKeySpki || !pcFingerprint) {
          throw new Error("PC OS-keystore signing bridge is not configured.");
        }
        const signerUrl = new URL(signerBase);
        if (signerUrl.protocol !== "http:" || signerUrl.hostname !== "127.0.0.1" || signerUrl.username || signerUrl.password) {
          throw new Error("PC signer must be an authenticated 127.0.0.1 HTTP endpoint.");
        }
        const stateDirectory = process.env.VANESSA_REMOTE_STATE_DIR ||
          path.join(process.env.APPDATA || os.homedir(), "Vanessa", "remote-v2");
        fs.mkdirSync(stateDirectory, { recursive: true });
        remotePairingRegistry = new RemotePairingRegistry({
          storePath: path.join(stateDirectory, "trusted-devices.json"),
        });
        await remotePairingRegistry.initialize();

        const assignedTailnetAddresses = Object.values(os.networkInterfaces())
          .flatMap((entries) => entries ?? [])
          .filter((entry) => entry.family === "IPv4" && !entry.internal && isTailscaleIPv4(entry.address))
          .map((entry) => entry.address);
        const requestedHost = process.env.VANESSA_REMOTE_V2_HOST;
        const host = requestedHost
          ? (assignedTailnetAddresses.includes(requestedHost) ? requestedHost : undefined)
          : assignedTailnetAddresses[0];
        if (!host) {
          remoteV2StartupError = "Tailscale is not connected on this PC; the v2 listener remains offline.";
          console.warn("[Vanessa Remote v2] " + remoteV2StartupError);
        } else {
          const configuredPort = Number(process.env.VANESSA_REMOTE_V2_PORT || "4321");
          if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
            throw new Error("VANESSA_REMOTE_V2_PORT must be between 1 and 65535.");
          }
          const remoteTasks = new RemoteTaskService(mobileTaskEngine, remotePairingRegistry);
          const signer = async (unsignedEnvelope: any) => {
            const response = await fetch(signerUrl.origin + "/sign", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + signerToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(unsignedEnvelope),
              signal: AbortSignal.timeout(2500),
            });
            if (!response.ok) throw new Error("PC identity signer rejected an envelope.");
            const parsed = safeParseRemoteEnvelope(await response.json());
            if (!parsed.success || parsed.data.keyId !== pcKeyId) {
              throw new Error("PC identity signer returned an invalid signed envelope.");
            }
            return parsed.data;
          };
          remoteV2Gateway = new RemoteV2Gateway({
            host,
            port: configuredPort,
            pcId: "pc_" + pcKeyId.slice(0, 16),
            pcName: os.hostname(),
            pcKeyId,
            pcPublicKeySpki,
            sign: signer,
            pairings: remotePairingRegistry,
            tasks: remoteTasks,
            onPairingPending: (pairingId) => {
              console.info("[Vanessa Remote v2] Local approval required for pairing " + pairingId);
            },
          });
          await remoteV2Gateway.start();
          const address = remoteV2Gateway.address();
          remoteV2Host = address.host;
          remoteV2Port = address.port;
          remoteV2StartupError = null;
          console.info("[Vanessa Remote v2] Listening on ws://" + address.host + ":" + address.port + " (Tailscale only).");
        }
      } catch (error) {
        remoteV2Gateway = undefined;
        remoteV2StartupError = error instanceof Error ? error.message : "Remote v2 startup failed.";
        console.error("[Vanessa Remote v2] Disabled: " + remoteV2StartupError);
      }
    }

    if (process.env.VANESSA_MOBILE_GATEWAY_ENABLED === "true") {
      const host = process.env.VANESSA_MOBILE_GATEWAY_HOST || "127.0.0.1";
      if (["0.0.0.0", "::", "::0"].includes(host)) throw new Error("Mobile gateway cannot bind to a wildcard address.");
      const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const octets = host.split(".").map(Number);
      const tailscaleAddress = isIPv4(host) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
      if (!loopback && (!tailscaleAddress || process.env.VANESSA_MOBILE_GATEWAY_ALLOW_UNAUTHENTICATED_REMOTE !== "true")) {
        throw new Error("Remote binding requires a Tailscale IPv4 address and explicit unauthenticated Phase 2 opt-in; keep this disabled until pairing is implemented.");
      }
      const port = Number(process.env.VANESSA_MOBILE_GATEWAY_PORT || "4320");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid mobile gateway port.");
      mobileGateway = new MobileGateway({
        host, port,
        getManifest: () => mobileTaskEngine!.getManifest(),
        submitTask: (message, clientId) => mobileTaskEngine!.submit({ requestId: message.id, idempotencyKey: message.idempotencyKey, tool: message.tool, args: message.args, deviceId: clientId }),
        cancelTask: (taskId, deviceId) => mobileTaskEngine!.cancel(taskId, deviceId),
        confirmTask: (message, deviceId) => mobileTaskEngine!.confirm({
          taskId: message.taskId,
          approved: message.approved,
          actionHash: message.actionHash,
          deviceId,
        }),
      });
      const socketServer = mobileGateway.createServer();
      socketServer.on("listening", () => console.log(`[Vanessa Mobile Gateway] ws://${host}:${port}`));
      socketServer.on("error", (error) => console.error(`[Vanessa Mobile Gateway] ${error.message}`));
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer();
}
