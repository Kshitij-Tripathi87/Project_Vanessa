import http from "node:http";
import WebSocket from "ws";
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";

// Load .env
let envDir = process.cwd();
for (let i = 0; i < 4; i++) {
  const p = path.join(envDir, ".env");
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
  envDir = path.dirname(envDir);
}

interface ServiceCheck {
  name: string;
  port: number;
  protocol: "http" | "ws";
  url: string;
  status: "ONLINE" | "OFFLINE" | "DEGRADED";
  latencyMs: number;
  details: string;
}

async function checkHttp(url: string, timeoutMs = 2000): Promise<{ ok: boolean; statusText: string; latencyMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          ok: (res.statusCode ?? 500) < 400 || res.statusCode === 426, // 426 upgrade required is ok for WS endpoint
          statusText: `HTTP ${res.statusCode}`,
          latencyMs: Date.now() - start,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusText: "TIMEOUT", latencyMs: Date.now() - start });
    });

    req.on("error", (err) => {
      resolve({ ok: false, statusText: err.message, latencyMs: Date.now() - start });
    });
  });
}

async function checkWs(url: string, timeoutMs = 2000): Promise<{ ok: boolean; statusText: string; latencyMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });

    const finish = (ok: boolean, statusText: string) => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {}
      resolve({ ok, statusText, latencyMs: Date.now() - start });
    };

    socket.on("open", () => finish(true, "CONNECTED"));
    socket.on("error", (err) => finish(false, err.message));
    setTimeout(() => finish(false, "TIMEOUT"), timeoutMs);
  });
}

async function main() {
  console.log("==================================================");
  console.log("     VANESSA SERVICE STACK READINESS PROBE       ");
  console.log("==================================================\n");

  const services: ServiceCheck[] = [
    {
      name: "Orchestrator Brain",
      port: 4319,
      protocol: "http",
      url: "http://127.0.0.1:4319/health",
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Voice Agent Gateway",
      port: 4500,
      protocol: "http",
      url: "http://127.0.0.1:4500/health",
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Local Whisper ASR",
      port: 4505,
      protocol: "ws",
      url: "ws://127.0.0.1:4505",
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Mobile Relay WSS",
      port: Number(process.env.RELAY_PORT || 4400),
      protocol: "http",
      url: `http://127.0.0.1:${Number(process.env.RELAY_PORT || 4400)}/health`,
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
  ];

  for (const s of services) {
    if (s.protocol === "http") {
      const res = await checkHttp(s.url);
      s.status = res.ok ? "ONLINE" : "OFFLINE";
      s.latencyMs = res.latencyMs;
      s.details = res.statusText;
    } else {
      const res = await checkWs(s.url);
      s.status = res.ok ? "ONLINE" : "OFFLINE";
      s.latencyMs = res.latencyMs;
      s.details = res.statusText;
    }
  }

  // Print Readiness Table
  console.log("SERVICE STATUS MATRIX:");
  console.log("--------------------------------------------------------------------------------");
  console.log(
    "Service".padEnd(24) +
    "Port".padEnd(8) +
    "Status".padEnd(12) +
    "Latency".padEnd(12) +
    "Details"
  );
  console.log("--------------------------------------------------------------------------------");

  for (const s of services) {
    const statusIcon = s.status === "ONLINE" ? "🟢" : "🔴";
    console.log(
      `${statusIcon} ${s.name.padEnd(21)}` +
      `${s.port}`.padEnd(8) +
      s.status.padEnd(12) +
      `${s.latencyMs}ms`.padEnd(12) +
      s.details
    );
  }
  console.log("--------------------------------------------------------------------------------\n");

  // Voice Provider Configuration Summary
  const fishKey = process.env.FISH_API_KEY || "";
  const hasValidFishKey = fishKey.startsWith("sk-fish-");
  const asrProvider = process.env.VOICE_ASR_PROVIDER || "fish";
  const ttsProvider = process.env.VOICE_PROVIDER || "fish";

  console.log("VOICE PROVIDER CONFIGURATION:");
  console.log(`- Configured ASR Provider: ${asrProvider}`);
  console.log(`- Configured TTS Provider: ${ttsProvider}`);
  console.log(`- Fish Audio Key: ${hasValidFishKey ? "Valid (sk-fish-...)" : "Missing / Placeholder (Using offline fallback)"}`);
  console.log(`- Fish Model: ${process.env.FISH_MODEL || "s2.1-pro-free"}`);
  console.log(`- Offline Local ASR Fallback: ws://127.0.0.1:4505 (Faster-Whisper)`);

  const onlineCount = services.filter((s) => s.status === "ONLINE").length;
  console.log(`\nReadiness: ${onlineCount}/${services.length} services online.`);
}

main().catch(console.error);
