import "dotenv/config";
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

const app = express();
app.use(express.json());

// Enable CORS for web apps & PWA
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
};

const rooms = new Map<string, Room>();

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "vanessa-relay" });
});

// Laptop requests pairing initiation
app.post("/pairing/create", (req, res) => {
  const deviceName = (req.body as any)?.deviceName || "Kshitij-Laptop";
  const pairingCode = createPairingCode();
  const totpSecret = createTotpSecret();

  rooms.set(pairingCode, {
    pairingCode,
    totpSecret,
    laptopName: deviceName,
    phones: new Map(),
    createdAt: Date.now(),
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
app.post("/pairing/claim", (req, res) => {
  const { pairingCode, deviceName, role, totpCode } = req.body as {
    pairingCode: string;
    deviceName: string;
    role: DeviceRole;
    totpCode?: string;
  };

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

function getRoom(pairingCode: string) {
  const room = rooms.get(pairingCode);
  if (!room) {
    throw new Error("Room not found");
  }
  return room;
}

function send(device: DeviceSocket, message: RelayMessage) {
  if (device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify(message));
  }
}

wss.on("connection", (ws, req) => {
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

  const room = getRoom(payload.pairingCode);
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
      for (const phone of room.phones.values()) {
        send(phone, message);
      }
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
