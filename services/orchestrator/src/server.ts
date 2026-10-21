import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { orchestrator } from "./core/orchestrator.js";
import { eventBus } from "./core/eventBus.js";
import { VanessaEvent } from "@vanessa/shared";
import { privacyGuard } from "./core/privacy.js";
import { permissionGuard } from "./core/permissionGuard.js";
import { memoryPalace } from "./memory/memoryPalace.js";
import { getRemotePwaHtml } from "./remotePwa.js";

// Load .env searching current and parent directories
let envDir = process.cwd();
for (let i = 0; i < 4; i++) {
  const p = path.join(envDir, ".env");
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
  envDir = path.dirname(envDir);
}

const PORT = parseInt(process.env.VANESSA_PORT || "4319", 10);
const fastify = Fastify({ logger: false });

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
eventBus.on("plan:completed", forwardEvent);
eventBus.on("audit:log", forwardEvent);

// WebSocket endpoint for real-time HUD streaming
fastify.get("/events", { websocket: true }, (socket, req) => {
  const origin = req.headers.origin;
  if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) {
    socket.close(1008, "Origin not allowed");
    return;
  }
  connectedClients.add(socket);

  // Send current status immediately
  socket.send(
    JSON.stringify({
      type: "system:status",
      payload: orchestrator.getSystemStatus(),
      timestamp: Date.now(),
    })
  );

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

fastify.post("/api/cancel", async (request, reply) => {
  orchestrator.cancelAll();
  return reply.send({ success: true, message: "Emergency kill switch engaged." });
});

fastify.get("/api/status", async () => {
  return orchestrator.getSystemStatus();
});

fastify.get("/api/audit", async (request) => {
  const limit = (request.query as any)?.limit ? parseInt((request.query as any).limit, 10) : 50;
  return eventBus.getRecentEvents(limit);
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

// Serve Mobile Companion Phone PWA
fastify.get("/remote", async (request, reply) => {
  const html = getRemotePwaHtml(PORT);
  return reply.type("text/html").send(html);
});

// Voice service status - delegates to voice-agent service on port 4500
// Fish Audio is the selected provider; all voice configuration validated in voice-agent
fastify.get("/voice/session", async (request, reply) => {
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
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer();
}
