import http from "node:http";
import WebSocket from "ws";
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
const { buildReadinessConfig } = createRequire(path.join(__dirname, "check_readiness.ts"))("./readiness-config.cjs");
const { probeOllama } = createRequire(path.join(__dirname, "check_readiness.ts"))("./ollama-readiness.cjs");

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
  protocol: "http" | "ws" | "ollama";
  url: string;
  status: "ONLINE" | "OFFLINE" | "DEGRADED";
  latencyMs: number;
  details: string;
}

async function checkHttp(url: string, timeoutMs = 2000): Promise<{ ok: boolean; statusText: string; statusCode: number; latencyMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res: http.IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer | string) => (data += chunk));
      res.on("end", () => {
        resolve({
          ok: (res.statusCode ?? 500) < 400 || res.statusCode === 426, // 426 upgrade required is ok for WS endpoint
          statusText: `HTTP ${res.statusCode}`,
          statusCode: res.statusCode ?? 500,
          latencyMs: Date.now() - start,
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

async function checkWs(url: string, timeoutMs = 2000): Promise<{ ok: boolean; statusText: string; latencyMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });

    const finish = (ok: boolean, statusText: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve({ ok, statusText, latencyMs: Date.now() - start });
    };

    socket.once("open", () => finish(true, "CONNECTED"));
    socket.once("error", (err: Error) => finish(false, err.message));
    timer = setTimeout(() => finish(false, "TIMEOUT"), timeoutMs);
  });
}

async function main() {
  console.log("==================================================");
  console.log("     VANESSA SERVICE STACK READINESS PROBE       ");
  console.log("==================================================\n");

  // Use the same normalized provider defaults as launch-vanessa.cjs. The readiness
  // probe must not silently report Fish/Gemini when a clean install uses local Whisper/Ollama.
  const config = buildReadinessConfig(process.env, process.cwd(), fs.existsSync);
  const orchestratorPort = Number(process.env.VANESSA_PORT || 4319);
  const voiceAgentPort = Number(process.env.VOICE_AGENT_PORT || 4500);
  const localAsrUrl = config.localAsrUrl;
  const localAsrPort = Number(new URL(localAsrUrl).port || 4505);
  const relayPort = Number(process.env.RELAY_PORT || process.env.PORT || 4400);
  const asrProvider = config.asrProvider;
  const ttsProvider = config.ttsProvider;
  const fallbackEnabled = process.env.VOICE_ALLOW_FALLBACK === "true";
  const usesLocalAsr = config.usesLocalAsr;

  const services: ServiceCheck[] = [
    {
      name: "Orchestrator Brain",
      port: orchestratorPort,
      protocol: "http",
      url: `http://127.0.0.1:${orchestratorPort}/health`,
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Voice Agent Gateway",
      port: voiceAgentPort,
      protocol: "http",
      url: `http://127.0.0.1:${voiceAgentPort}/ready`,
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
    {
      name: "Mobile Relay WSS",
      port: relayPort,
      protocol: "http",
      url: `http://127.0.0.1:${relayPort}/health`,
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    },
  ];

  if (config.usesOllama) {
    let ollamaPort = 11434;
    try { ollamaPort = Number(new URL(config.ollamaBaseUrl).port || 11434); } catch { /* probe reports invalid endpoint */ }
    services.splice(0, 0, {
      name: "Local Ollama",
      port: ollamaPort,
      protocol: "ollama",
      url: config.ollamaBaseUrl,
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    });
  }

  if (usesLocalAsr) {
    services.splice(2, 0, {
      name: "Local Whisper ASR",
      port: localAsrPort,
      protocol: "ws",
      url: localAsrUrl,
      status: "OFFLINE",
      latencyMs: 0,
      details: "",
    });
  }

  const selectedServices = services.filter(s => s.name !== "Mobile Relay WSS" || process.env.VANESSA_REQUIRE_RELAY === "true");
  for (const s of selectedServices) {
    if (s.protocol === "ollama") {
      const res = await probeOllama(config.ollamaBaseUrl, config.ollamaModel);
      s.status = res.status;
      s.latencyMs = res.latencyMs;
      s.details = res.message;
    } else if (s.protocol === "http") {
      const res = await checkHttp(s.url);
      s.status = res.statusCode === 503 ? "DEGRADED" : res.ok ? "ONLINE" : "OFFLINE";
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

  for (const s of selectedServices) {
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
  const sarvamKey = process.env.SARVAM_API_KEY || "";
  const hasValidSarvamKey = Boolean(sarvamKey.trim()) && !/placeholder|replace[-_ ]with|your[_-].*(key|model|speaker)/i.test(sarvamKey);

  console.log("VOICE PROVIDER CONFIGURATION:");
  console.log(`- Configured ASR Provider: ${asrProvider}`);
  console.log(`- Configured TTS Provider: ${ttsProvider}`);
  if (asrProvider === "fish" || ttsProvider === "fish") {
    const hasFishVoice = Boolean(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID);
    console.log(`- Fish Audio Key: ${hasValidFishKey ? "Configured" : fallbackEnabled ? "Missing (explicit local ASR fallback enabled)" : "Missing (Fish provider unavailable)"}`);
    if (asrProvider === "fish") console.log(`- Fish ASR Model: ${process.env.FISH_ASR_MODEL || "transcribe-stream-1"}`);
    if (ttsProvider === "fish") {
      console.log(`- Fish TTS Model: ${process.env.FISH_TTS_MODEL || "s2.1-pro-free"}`);
      console.log(`- Fish TTS Voice ID: ${hasFishVoice ? "Configured" : "Missing"}`);
    }
  }
  if (asrProvider === "sarvam" || ttsProvider === "sarvam") {
    console.log(`- Sarvam API Key: ${hasValidSarvamKey ? "Configured" : "Missing or placeholder"}`);
    if (asrProvider === "sarvam") console.log(`- Sarvam ASR Model: ${process.env.SARVAM_ASR_MODEL || "saaras:v3-realtime"}`);
    if (ttsProvider === "sarvam") {
      console.log(`- Sarvam TTS Model: ${process.env.SARVAM_TTS_MODEL || "bulbul:v4-flash"}`);
      console.log(`- Sarvam TTS Speaker: ${process.env.SARVAM_TTS_SPEAKER || "shubh_enhi_ads"}`);
    }
  }
  console.log(`- Local ASR: ${usesLocalAsr ? `${localAsrUrl} (selected)` : "not selected for the active ASR provider"}`);

  console.log(`- Planner: ${config.plannerProvider}`);
  console.log(`- Conversation: ${config.conversationProvider}`);
  console.log(`- Selected-provider configuration: ${config.missing.length ? "INCOMPLETE" : "configured (not live-provider verification)"}`);
  for (const missing of config.missing) console.log(`  Missing: ${missing}`);
  const onlineCount = selectedServices.filter((s) => s.status === "ONLINE").length;
  console.log(`\nReadiness: ${onlineCount}/${selectedServices.length} required services online.`);
  if (config.missing.length || onlineCount !== selectedServices.length) process.exitCode = 1;
}

main().catch(() => { console.error("Readiness configuration invalid; check selected provider settings."); process.exitCode = 1; });
