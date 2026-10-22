import dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  createDeviceToken,
  createPairingCode,
  createTotpSecret,
  verifyDeviceToken,
  verifyTotp,
} from "./pairing.js";
import type { DeviceRole, RelayMessage } from "./types.js";

// Load .env from project root. Prefer cwd (Launch-Vanessa.bat sets it to repo root),
// fall back to resolving relative to this file's location.
const cwdEnv = path.join(process.cwd(), ".env");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envPath = fs.existsSync(cwdEnv) ? cwdEnv : path.join(projectRoot, ".env");
dotenv.config({ path: envPath });

const app = express();
app.use(express.json({ limit: "32kb" }));

const pairingRateLimits = new Map<string, { count: number; resetAt: number }>();
function rateLimitPairing(scope: string, maximum: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const key = `${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    let state = pairingRateLimits.get(key);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      pairingRateLimits.set(key, state);
    }
    state.count++;
    if (state.count > maximum) {
      return res.status(429).json({ error: "Too many pairing requests. Try again later." });
    }
    next();
  };
}

const allowedOrigins = new Set(
  (process.env.RELAY_ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

// Allow only explicitly configured browser clients. Native clients without an
// Origin header still authenticate with their signed device token.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return origin && !allowedOrigins.has(origin) ? res.sendStatus(403) : res.sendStatus(204);
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

type DeviceSocket = {
  ws: WebSocket;
  deviceId: string;
  deviceName: string;
  role: DeviceRole;
  pairingCode: string;
};

type Room = {
  pairingCode: string;
  totpSecret: string;
  laptopName?: string;
  laptop?: DeviceSocket;
  phones: Map<string, DeviceSocket>;
  createdAt: number;
  nextSequence: number;
  eventHistory: RelayMessage[];
};

const rooms = new Map<string, Room>();

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "vanessa-relay" });
});

// Laptop requests pairing initiation
app.post("/pairing/create", rateLimitPairing("create", 5, 60 * 60 * 1000), (req, res) => {
  const requestedName = (req.body as any)?.deviceName;
  if (typeof requestedName !== "undefined" && (typeof requestedName !== "string" || requestedName.length > 80)) {
    return res.status(400).json({ error: "Invalid device name" });
  }
  const deviceName = requestedName || "Vanessa Laptop";
  const pairingCode = createPairingCode();
  const totpSecret = createTotpSecret();

  rooms.set(pairingCode, {
    pairingCode,
    totpSecret,
    laptopName: deviceName,
    phones: new Map(),
    createdAt: Date.now(),
    nextSequence: 1,
    eventHistory: [],
  });

  res.json({
    pairingCode,
    deviceName,
    totpSecret,
    instructions: [
      "Open Vanessa on your phone.",
      "Enter the device name and pairing code.",
      "Enter the 6-digit code from your authenticator app (optional)."
    ],
  });
});

// Phone or Laptop claims pairing code
app.post("/pairing/claim", rateLimitPairing("claim", 10, 15 * 60 * 1000), (req, res) => {
  const { pairingCode, deviceName, role, totpCode } = req.body as {
    pairingCode: string;
    deviceName: string;
    role: DeviceRole;
    totpCode?: string;
  };

  if (
    typeof pairingCode !== "string" ||
    !/^\d{6}$/.test(pairingCode) ||
    (role !== "phone" && role !== "laptop") ||
    (typeof deviceName !== "undefined" && (typeof deviceName !== "string" || deviceName.length > 80)) ||
    (typeof totpCode !== "undefined" && (typeof totpCode !== "string" || !/^\d{6}$/.test(totpCode)))
  ) {
    return res.status(400).json({ error: "Invalid pairing request" });
  }

  const room = rooms.get(pairingCode);
  if (!room) {
    return res.status(404).json({ error: "Invalid pairing code" });
  }

  // 10 minutes expiry
  if (room.createdAt + 10 * 60 * 1000 < Date.now()) {
    rooms.delete(pairingCode);
    return res.status(410).json({ error: "Pairing code expired" });
  }

  // If TOTP provided, verify; otherwise device name + 6-digit code is verified
  if (totpCode) {
    const isValidTotp = verifyTotp(room.totpSecret, totpCode);
    if (!isValidTotp) {
      return res.status(401).json({ error: "Invalid authenticator code" });
    }
  }

  if (role === "laptop" && room.laptop) {
    return res.status(409).json({ error: "Laptop already paired" });
  }

  const deviceId = randomUUID();
  const token = createDeviceToken({ deviceId, deviceName: deviceName || "Vanessa Device", role, pairingCode });

  return res.json({
    deviceId,
    deviceName,
    role,
    token,
    expiresInSeconds: Number(process.env.TOKEN_TTL_SECONDS ?? 900),
  });
});

function send(device: DeviceSocket, message: RelayMessage) {
  if (device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify(message));
  }
}

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    ws.close(1008, "Origin not allowed");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(4001, "Missing token");
    return;
  }

  let payload;
  try {
    payload = verifyDeviceToken(token);
  } catch {
    ws.close(4001, "Invalid or expired token");
    return;
  }

  const room = rooms.get(payload.pairingCode);
  if (!room) {
    ws.close(4004, "Pairing room no longer exists");
    return;
  }
  const device: DeviceSocket = {
    ws,
    deviceId: payload.sub,
    deviceName: payload.deviceName,
    role: payload.role,
    pairingCode: payload.pairingCode,
  };

  if (payload.role === "laptop") {
    room.laptop = device;
  } else {
    room.phones.set(payload.sub, device);
  }

  ws.send(
    JSON.stringify({
      type: "connected",
      role: payload.role,
      deviceName: payload.deviceName,
      pairingCode: payload.pairingCode,
    })
  );

  ws.on("message", (raw) => {
    let message: RelayMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "command") {
      if (device.role !== "phone" || !room.laptop) return;
      send(room.laptop, message);
      return;
    }

    if (message.type === "task_update" || message.type === "approval_request") {
      if (device.role !== "laptop") return;
      message.sequence = room.nextSequence++;
      room.eventHistory.push(message);
      if (room.eventHistory.length > 200) {
        room.eventHistory.shift();
      }
      for (const phone of room.phones.values()) {
        send(phone, message);
      }
      return;
    }

    if (message.type === "resume") {
      const lastSeen = message.lastSeenSequence || 0;
      const missed = room.eventHistory.filter((e) => (e as any).sequence && (e as any).sequence > lastSeen);
      for (const event of missed) {
        send(device, event);
      }
      send(device, { type: "replay_complete", lastSequence: room.nextSequence - 1 });
      return;
    }

    if (message.type === "approval_response") {
      if (device.role !== "phone" || !room.laptop) return;
      send(room.laptop, message);
      return;
    }
  });

  ws.on("close", () => {
    if (device.role === "laptop" && room.laptop?.deviceId === device.deviceId) {
      room.laptop = undefined;
    }
    room.phones.delete(device.deviceId);
  });
});

const PORT = Number(process.env.PORT ?? 4400);
server.listen(PORT, () => {
  console.log(`[Vanessa Relay] Running on port ${PORT}`);
});
