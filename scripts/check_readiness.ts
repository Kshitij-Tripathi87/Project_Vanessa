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
  status: "ONLINE" | "OFFLINE" | "DEGRADED" | "STARTING";
  latencyMs: number;
  details: string;
}

async function checkHttp(url: string, timeoutMs = 3000): Promise<{ ok: boolean; statusText: string; statusCode: number; latencyMs: number; body?: any }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res: http.IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer | string) => (data += chunk));
      res.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(data); } catch {}
        resolve({
          ok: (res.statusCode ?? 500) < 400 || res.statusCode === 426,
          statusText: `HTTP ${res.statusCode}`,
          statusCode: res.statusCode ?? 500,
          latencyMs: Date.now() - start,
          body,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusText: "TIMEOUT", statusCode: 0, latencyMs: Date.now() - start });
    });

    req.on("error", (err: Error) => {
      resolve({ ok: false, statusText: err.message, statusCode: 0, latencyMs: Date.now() - start });
    });
  });
}

async function checkWs(url: string, timeoutMs = 3000): Promise<{ ok: boolean; statusText: string; latencyMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });

    const finish = (ok: boolean, statusText: string) => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
      resolve({ ok, statusText, latencyMs: Date.now() - start });
    };

    socket.on("open", () => finish(true, "CONNECTED"));
    socket.on("error", (err: Error) => finish(false, err.message));
    setTimeout(() => finish(false, "TIMEOUT"), timeoutMs);
  });
}

async function checkServiceWithRetry(s: ServiceCheck, retries = 3, delayMs = 1000): Promise<ServiceCheck> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (s.protocol === "http") {
      const res = await checkHttp(s.url);
      if (res.statusCode === 503) {
        s.status = "DEGRADED";
        s.latencyMs = res.latencyMs;
        s.details = `${res.statusText} (${res.body?.message || "degraded"})`;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        return s;
      }
      s.status = res.ok ? "ONLINE" : "OFFLINE";
      s.latencyMs = res.latencyMs;
      s.details = res.statusText;
      return s;
    } else {
      const res = await checkWs(s.url);
      s.status = res.ok ? "ONLINE" : "OFFLINE";
      s.latencyMs = res.latencyMs;
      s.details = res.statusText;
      return s;
    }
  }
  return s;
}

async function main() {
  console.log("==================================================");
  console.log("     VANESSA SERVICE STACK READINESS PROBE       ");
  console.log("==================================================\n");

  const orchestratorPort = Number(process.env.VANESSA_PORT || 4319);
  const voiceAgentPort = Number(process.env.VOICE_AGENT_PORT || 4500);
  const localAsrUrl = process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505";
  const localAsrPort = Number(new URL(localAsrUrl).port || 4505);
  const relayPort = Number(process.env.RELAY_PORT || process.env.PORT || 4400);

  const services: ServiceCheck[] = [
    {
      name: "Orchestrator Brain",
      port: orchestratorPort,
      protocol: "http",
      url: `http://127.0.0.1:${orchestratorPort}/health`,
      status: "STARTING",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Voice Agent Gateway",
      port: voiceAgentPort,
      protocol: "http",
      url: `http://127.0.0.1:${voiceAgentPort}/ready`,
      status: "STARTING",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Voice Agent Liveness",
      port: voiceAgentPort,
      protocol: "http",
      url: `http://127.0.0.1:${voiceAgentPort}/live`,
      status: "STARTING",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Local Whisper ASR",
      port: localAsrPort,
      protocol: "ws",
      url: localAsrUrl,
      status: "STARTING",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Mobile Relay WSS",
      port: relayPort,
      protocol: "http",
      url: `http://127.0.0.1:${relayPort}/health`,
      status: "STARTING",
      latencyMs: 0,
      details: "",
    },
  ];

  // Check services in dependency order
  const checkOrder = [
    "Orchestrator Brain",
    "Voice Agent Gateway",
    "Voice Agent Liveness",
    "Local Whisper ASR",
    "Mobile Relay WSS",
  ];

  for (const name of checkOrder) {
    const svc = services.find(s => s.name === name);
    if (svc) {
      const checked = await checkServiceWithRetry(svc);
      Object.assign(svc, checked);
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
    const statusIcon = s.status === "ONLINE" ? "🟢" : s.status === "DEGRADED" ? "🟡" : "🔴";
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
  const ttsProvider = process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish";
  const fallbackEnabled = process.env.VOICE_ALLOW_FALLBACK === "true";

  console.log("VOICE PROVIDER CONFIGURATION:");
  console.log(`- Configured ASR Provider: ${asrProvider}`);
  console.log(`- Configured TTS Provider: ${ttsProvider}`);
  const hasFishVoice = Boolean(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID);
  console.log(`- Fish Audio Key: ${hasValidFishKey ? "Configured" : fallbackEnabled ? "Missing (explicit local ASR fallback enabled)" : "Missing (Fish ASR unavailable)"}`);
  console.log(`- Fish ASR Model: ${process.env.FISH_ASR_MODEL || "transcribe-stream-1"}`);
  console.log(`- Fish TTS Model: ${process.env.FISH_TTS_MODEL || "s2.1-pro-free"}`);
  console.log(`- Fish TTS Voice ID: ${hasFishVoice ? "Configured" : "Missing"}`);
  console.log(`- Offline Local ASR Fallback: ${localAsrUrl} (${fallbackEnabled ? "enabled" : "disabled"})`);

  // Voice Agent Provider Status (if online)
  const voiceAgent = services.find(s => s.name === "Voice Agent Gateway");
  if (voiceAgent?.status === "ONLINE" && voiceAgent?.body?.providers) {
    console.log("\nVOICE AGENT PROVIDER STATUS:");
    const providers = voiceAgent.body.providers;
    console.log(`- ASR: ${providers.asr?.requested} (${providers.asr?.configured ? "configured" : "not configured"})`);
    console.log(`- TTS: ${providers.tts?.requested} (${providers.tts?.configured ? "configured" : "not configured"})`);
    if (voiceAgent.body.configValidation) {
      const cv = voiceAgent.body.configValidation;
      if (cv.errors.length > 0) console.log(`- Config Errors: ${cv.errors.join("; ")}`);
      if (cv.warnings.length > 0) console.log(`- Config Warnings: ${cv.warnings.join("; ")}`);
    }
  }

  const onlineCount = services.filter((s) => s.status === "ONLINE").length;
  const degradedCount = services.filter((s) => s.status === "DEGRADED").length;
  console.log(`\nReadiness: ${onlineCount}/${services.length} services online${degradedCount > 0 ? `, ${degradedCount} degraded` : ""}.`);

  // Exit code for CI/CD
  const allCriticalOnline = services
    .filter(s => ["Orchestrator Brain", "Voice Agent Gateway", "Voice Agent Liveness"].includes(s.name))
    .every(s => s.status === "ONLINE");

  process.exit(allCriticalOnline ? 0 : 1);
}

main().catch((err) => {
  console.error("Readiness probe failed:", err);
  process.exit(1);
});