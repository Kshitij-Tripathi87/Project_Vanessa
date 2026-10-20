import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
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
  origin: "*",
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

import { voiceStreamServer } from "./voice/voiceStreamServer.js";

// WebSocket endpoint for real-time HUD streaming
fastify.get("/events", { websocket: true }, (socket, req) => {
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

// Dedicated full-duplex WebSocket endpoint for live voice streaming & sentiment
fastify.get("/voice/stream", { websocket: true }, (socket, req) => {
  voiceStreamServer.handleConnection(socket);
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
let remoteAccessEnabled = true;
let activePairingCode = "VAN-892";
let activePairingToken = "vtok_" + Math.random().toString(36).substring(2, 10);
const authenticatedPhoneTokens = new Set<string>(["vtok_active_session"]);

fastify.get("/api/remote/pairing", async () => {
  return {
    enabled: remoteAccessEnabled,
    pairingCode: activePairingCode,
    pairingToken: activePairingToken,
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
  return { enabled: remoteAccessEnabled };
});

fastify.post("/api/remote/pair", async (request, reply) => {
  const body = request.body as { code?: string; token?: string };
  if (!remoteAccessEnabled) {
    return reply.status(403).send({ error: "Remote access is disabled on this laptop." });
  }
  if (body?.code === activePairingCode || body?.token === activePairingToken) {
    const sessionToken = "psess_" + Math.random().toString(36).substring(2, 12);
    authenticatedPhoneTokens.add(sessionToken);
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
    command: body.command,
    risk: "low",
    permission: "allowed",
    status: "info",
    details: { command: body.command, origin: "Phone Mobile Companion PWA" },
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
  if (!body?.taskId) {
    return reply.status(400).send({ error: "Missing taskId" });
  }
  eventBus.emitEvent("audit:log", {
    id: `audit-${Date.now()}`,
    timestamp: Date.now(),
    source: "remote_pwa",
    agent: "safety_gate",
    action: "approval.granted_remote",
    resource: body.taskId,
    risk: "medium",
    permission: "approved_once",
    status: "approved",
    details: "Task authorization confirmed via Mobile Companion PWA",
  });
  const task = await orchestrator.approve(body.taskId);
  return reply.send({ success: !!task, task });
});

// Serve Mobile Companion Phone PWA
fastify.get("/remote", async (request, reply) => {
  const html = getRemotePwaHtml(PORT, activePairingCode);
  return reply.type("text/html").send(html);
});

// Session credential minting for ElevenLabs / voice layer
fastify.get("/voice/session", async (request, reply) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!apiKey || !agentId) {
    return reply.send({
      provider: "mock",
      ready: true,
      message: "ElevenLabs credentials not configured. Running in local simulated voice mode.",
    });
  }

  try {
    // Generate signed conversation URL or token
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs error: ${res.statusText}`);
    }
    const data = (await res.json()) as any;
    return reply.send({ provider: "elevenlabs", signedUrl: data.signed_url });
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
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
