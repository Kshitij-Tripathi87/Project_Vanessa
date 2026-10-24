import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { VanessaVoiceSession } from "./session/voiceSession.js";
import { AudioCapture, PcmFrameAccumulator, type AudioChunk } from "./audio/capture.js";
import { createWakeWordDetector, getWakeWordReadiness } from "./session/porcupineWakeWord.js";

// Load .env from project root. Prefer cwd (Launch-Vanessa.bat sets it to repo root),
// fall back to resolving relative to this file's location.
const cwdEnv = path.join(process.cwd(), ".env");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envPath = fs.existsSync(cwdEnv) ? cwdEnv : path.join(projectRoot, ".env");
dotenv.config({ path: envPath });

const PORT = parseInt(process.env.VOICE_AGENT_PORT || "4500", 10);
const HOST = process.env.HOST || "127.0.0.1";

function getProviderReadiness() {
  const fishKeyValid = (process.env.FISH_API_KEY || "").startsWith("sk-fish-");
  const asrProvider = process.env.VOICE_ASR_PROVIDER || "fish";
  const ttsProvider = process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish";
  const asrFallbackConfigured = process.env.VOICE_ALLOW_FALLBACK === "true" && Boolean(process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505");
  const ttsFallbackConfigured = process.env.VOICE_TTS_FALLBACK_PROVIDER === "browser";
  const asrConfigured = asrProvider === "fish"
    ? fishKeyValid || asrFallbackConfigured
    : asrProvider === "elevenlabs"
      ? Boolean(process.env.ELEVENLABS_API_KEY)
      : Boolean(process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505");
  const ttsConfigured = ttsProvider === "fish"
    ? (fishKeyValid && Boolean(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID)) || ttsFallbackConfigured
    : Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
  const fallbackActive = (asrProvider === "fish" && !fishKeyValid && asrFallbackConfigured)
    || (ttsProvider === "fish" && !(fishKeyValid && Boolean(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID)) && ttsFallbackConfigured);
  return {
    ready: asrConfigured && ttsConfigured,
    state: !asrConfigured || !ttsConfigured ? "unavailable" : fallbackActive ? "degraded" : "ready",
    providers: {
      asr: { requested: asrProvider, configured: asrConfigured, fallbackConfigured: asrFallbackConfigured },
      tts: { requested: ttsProvider, configured: ttsConfigured, fallbackConfigured: ttsFallbackConfigured },
    },
  } as const;
}

// Fish configuration validation at startup
function validateFishConfiguration(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const fishApiKey = process.env.FISH_API_KEY || "";
  const fishAsrModel = process.env.FISH_ASR_MODEL || "transcribe-stream-1";
  const fishTtsModel = process.env.FISH_TTS_MODEL || "s2.1-pro-free";
  const fishTtsVoiceId = process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID || "";
  const asrProvider = process.env.VOICE_ASR_PROVIDER || "fish";
  const ttsProvider = process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish";
  const allowFallback = process.env.VOICE_ALLOW_FALLBACK === "true";
  const ttsFallback = process.env.VOICE_TTS_FALLBACK_PROVIDER === "browser";

  if (asrProvider === "fish") {
    if (!fishApiKey || !fishApiKey.startsWith("sk-fish-")) {
      if (allowFallback) {
        warnings.push("Fish ASR: FISH_API_KEY missing or invalid; VOICE_ALLOW_FALLBACK=true enables local Whisper fallback");
      } else {
        errors.push("Fish ASR: FISH_API_KEY is required (must start with 'sk-fish-'). Set VOICE_ALLOW_FALLBACK=true to enable local Whisper fallback instead.");
      }
    }
  }

  if (ttsProvider === "fish") {
    if (!fishApiKey || !fishApiKey.startsWith("sk-fish-")) {
      if (ttsFallback) {
        warnings.push("Fish TTS: FISH_API_KEY missing or invalid; VOICE_TTS_FALLBACK_PROVIDER=browser enables browser SpeechSynthesis fallback");
      } else {
        errors.push("Fish TTS: FISH_API_KEY is required (must start with 'sk-fish-'). Set VOICE_TTS_FALLBACK_PROVIDER=browser to enable browser SpeechSynthesis fallback instead.");
      }
    }
    if (!fishTtsVoiceId) {
      if (ttsFallback) {
        warnings.push("Fish TTS: FISH_TTS_VOICE_ID (or FISH_VANESSA_VOICE_ID) not configured; browser SpeechSynthesis fallback will be used");
      } else {
        errors.push("Fish TTS: FISH_TTS_VOICE_ID (or FISH_VANESSA_VOICE_ID) is required for Fish Audio TTS. Set VOICE_TTS_FALLBACK_PROVIDER=browser to use browser fallback instead.");
      }
    }
  }

  // Validate model names
  if (asrProvider === "fish" && fishAsrModel !== "transcribe-stream-1") {
    warnings.push(`Fish ASR: FISH_ASR_MODEL="${fishAsrModel}" may not be a valid realtime model. Recommended: "transcribe-stream-1"`);
  }

  if (ttsProvider === "fish" && !["s2.1-pro", "s2.1-pro-free", "s2.1", "s2.1-free"].includes(fishTtsModel)) {
    warnings.push(`Fish TTS: FISH_TTS_MODEL="${fishTtsModel}" may not be a valid model. Recommended: "s2.1-pro-free" or "s2.1-pro"`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// Export for testing
export { validateFishConfiguration };

export async function createVoiceAgentServer() {
  const fastify = Fastify({ logger: false });

  // Validate configuration at startup
  const configValidation = validateFishConfiguration();
  if (configValidation.errors.length > 0) {
    console.error("========================================================");
    console.error("[Vanessa Voice Agent] CONFIGURATION ERRORS:");
    configValidation.errors.forEach((e) => console.error(`  ✗ ${e}`));
    console.error("========================================================");
    if (process.env.VOICE_STRICT_CONFIG === "true") {
      process.exit(1);
    }
  }
  if (configValidation.warnings.length > 0) {
    console.warn("========================================================");
    console.warn("[Vanessa Voice Agent] CONFIGURATION WARNINGS:");
    configValidation.warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
    console.warn("========================================================");
  }

  await fastify.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  });
  await fastify.register(websocket);

  // Health check
  fastify.get("/health", async () => {
    const readiness = getProviderReadiness();
    const configValidation = validateFishConfiguration();
    return {
      status: "online",
      service: "vanessa-voice-agent",
      protocol: "whisperflow-realtime-v1",
      sampleRate: 16000,
      chunkDurationMs: 20,
      chunkSamples: 320,
      defaultAsr: process.env.VOICE_ASR_PROVIDER || "fish",
      defaultTts: process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish",
      readiness: readiness.state,
      wakeWord: getWakeWordReadiness(),
      providers: readiness.providers,
      configValidation: {
        valid: configValidation.valid,
        errors: configValidation.errors,
        warnings: configValidation.warnings,
      },
      timestamp: Date.now(),
    };
  });

  // Liveness probe - process is alive
  fastify.get("/live", async () => {
    return { status: "alive", timestamp: Date.now() };
  });

  // Readiness probe - service can handle requests
  fastify.get("/ready", async (_request, reply) => {
    const readiness = getProviderReadiness();
    // Also check if Fish ASR WebSocket is actually connected when required
    if (!readiness.ready) {
      reply.status(503);
      return { status: readiness.state, providers: readiness.providers, timestamp: Date.now() };
    }
    return { status: readiness.state, providers: readiness.providers, timestamp: Date.now() };
  });

  // Local microphone frames are processed on-device for wake detection. Audio is
  // forwarded to the configured ASR provider only after a wake word or explicit PTT.
  fastify.get("/ws", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !["http://localhost:5173", "http://127.0.0.1:5173", "file://"].includes(origin)) {
      socket.close(1008, "Origin not allowed");
      return;
    }

    let asrListening = false;
    let wakeMonitoringEnabled = false;
    let wakeActivationPending = false;
    let wakeDetectorResult: Awaited<ReturnType<typeof createWakeWordDetector>> = null;
    let wakeDetectorError: string | undefined;
    const wakeReadiness = getWakeWordReadiness();
    const wakePreRoll: AudioChunk[] = [];
    const maxPreRollChunks = 150; // 3 seconds of 20ms 16kHz mono PCM, kept on this machine only.
    const accumulator = new PcmFrameAccumulator(320);

    const session = new VanessaVoiceSession({
      handlers: {
        onStateChange: (state) => {
          asrListening = state === "listening";
          sendJson(socket, { type: "state_change", state, timestamp: Date.now() });
          if (state === "idle" && wakeMonitoringEnabled) {
            sendJson(socket, { type: "wake_status", available: Boolean(wakeDetectorResult), ready: Boolean(wakeDetectorResult), listening: Boolean(wakeDetectorResult), keyword: wakeDetectorResult?.keyword || wakeReadiness.keyword, reason: wakeDetectorError || wakeReadiness.reason });
          }
        },
        onPartialTranscript: (text) => {
          sendJson(socket, { type: "transcript_partial", text, timestamp: Date.now() });
        },
        onFinalTranscript: (text, requestId) => {
          sendJson(socket, { type: "transcript_final", text, requestId, timestamp: Date.now() });
        },
        onAudioChunkOut: (chunk) => {
          sendJson(socket, { type: "tts_chunk", ...chunk, timestamp: Date.now() });
        },
        onTtsUnavailable: (detail) => {
          sendJson(socket, { type: "tts_unavailable", detail, timestamp: Date.now() });
        },
        onHudUpdate: (hud) => {
          sendJson(socket, { type: "hud_update", ...hud, timestamp: Date.now() });
        },
        onProviderStatus: (providers) => {
          sendJson(socket, { type: "provider_status", providers, timestamp: Date.now() });
        },
      },
    });

    void session.start().catch((err) => {
      console.warn("[VoiceAgentServer] Session start error:", err.message);
    });

    sendJson(socket, {
      type: "session_ready",
      sampleRate: 16000,
      chunkDurationMs: 20,
      chunkSamples: 320,
      chunkBytes: 640,
      bargeInEnabled: true,
      activationMode: "push_to_talk_or_local_wake_word",
      wakeWord: { ...wakeReadiness, state: wakeReadiness.available ? "starting" : "unavailable" },
      providers: session.getProviderInfo(),
      timestamp: Date.now(),
    });

    const emitWakeStatus = () => {
      sendJson(socket, {
        type: "wake_status",
        available: Boolean(wakeDetectorResult),
        ready: Boolean(wakeDetectorResult),
        listening: wakeMonitoringEnabled && Boolean(wakeDetectorResult),
        keyword: wakeDetectorResult?.keyword || wakeReadiness.keyword,
        reason: wakeDetectorError || (!wakeDetectorResult ? wakeReadiness.reason : undefined),
        timestamp: Date.now(),
      });
    };

    // Initialization is asynchronous; install the message handler first so that
    // a very fast PTT click cannot be lost while the native model loads.
    void (async () => {
      if (!wakeReadiness.available) {
        emitWakeStatus();
        return;
      }
      try {
        wakeDetectorResult = await createWakeWordDetector();
        if (!wakeDetectorResult) wakeDetectorError = getWakeWordReadiness().reason || "The local wake-word engine is not configured.";
      } catch (error) {
        wakeDetectorError = error instanceof Error ? error.message : String(error);
        console.warn("[VoiceAgentServer] Local wake-word initialization failed:", wakeDetectorError);
      }
      emitWakeStatus();
    })();

    console.log("[VoiceAgentServer] Desktop client connected to /ws session");

    const activateFromWakeWord = async () => {
      if (!wakeDetectorResult || wakeActivationPending || asrListening || session.getState() !== "idle") return;
      wakeActivationPending = true;
      const replay = wakePreRoll.slice(-125); // Replay only the recent 2.5s around the wake phrase.
      try {
        await session.activateSession(25000);
        sendJson(socket, {
          type: "wake_word_detected",
          keyword: wakeDetectorResult.keyword,
          state: "listening",
          timestamp: Date.now(),
        });
        // This short ring buffer never leaves the local process until wake is detected.
        for (const chunk of replay) {
          await session.processAudioChunk(chunk);
        }
        wakePreRoll.length = 0;
      } catch (error) {
        asrListening = false;
        sendJson(socket, {
          type: "voice_error",
          message: "Wake word detected, but speech recognition could not start. Check ASR configuration.",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        wakeActivationPending = false;
      }
    };

    socket.on("message", async (data: any, isBinary: boolean) => {
      try {
        if (isBinary || Buffer.isBuffer(data)) {
          const chunks = accumulator.feed(Buffer.from(data));
          for (const chunk of chunks) {
            if (asrListening) {
              await session.processAudioChunk(chunk);
              continue;
            }

            // Wake monitoring consumes local PCM only; it does not send audio to ASR.
            if (wakeMonitoringEnabled && wakeDetectorResult && session.getState() === "idle") {
              wakePreRoll.push(chunk);
              if (wakePreRoll.length > maxPreRollChunks) wakePreRoll.shift();
              if (wakeDetectorResult.detector.processChunk(chunk.pcm)) {
                await activateFromWakeWord();
              }
            }
          }
          return;
        }

        const json = JSON.parse(data.toString());
        if (json.type === "activate" || json.type === "reset") {
          accumulator.reset();
          asrListening = true;
          try {
            await session.activateSession(25000);
            sendJson(socket, { type: "state_change", state: "listening", timestamp: Date.now() });
          } catch (err: any) {
            asrListening = false;
            console.warn("[VoiceAgentServer] ASR activation failed:", err.message);
            sendJson(socket, {
              type: "voice_error",
              message: "Speech recognition could not start. Check the configured ASR provider and try again.",
            });
          }
        } else if (json.type === "wake_monitor_start") {
          if (!wakeDetectorResult) {
            emitWakeStatus();
          } else {
            wakeMonitoringEnabled = true;
            wakePreRoll.length = 0;
            sendJson(socket, {
              type: "wake_status",
              available: true,
              ready: true,
              listening: true,
              keyword: wakeDetectorResult.keyword,
              timestamp: Date.now(),
            });
          }
        } else if (json.type === "wake_monitor_stop") {
          wakeMonitoringEnabled = false;
          wakePreRoll.length = 0;
          sendJson(socket, { type: "wake_status", available: Boolean(wakeDetectorResult), ready: Boolean(wakeDetectorResult), listening: false, keyword: wakeDetectorResult?.keyword || wakeReadiness.keyword, timestamp: Date.now() });
        } else if (json.type === "finalize") {
          session.finalizeTurn();
        } else if (json.type === "deactivate") {
          accumulator.reset();
          asrListening = false;
          session.stop();
        } else if (json.type === "barge_in" || json.type === "interrupt") {
          asrListening = false;
          session.interrupt();
          sendJson(socket, { type: "barge_in_acknowledged", timestamp: Date.now() });
        } else if (json.type === "transcript_final" && json.text) {
          await session.handleFinalUtterance(json.text, json.language || "en");
        }
      } catch (err: any) {
        console.warn("[VoiceAgentServer] Message processing error:", err.message);
      }
    });

    socket.on("close", () => {
      wakeMonitoringEnabled = false;
      wakePreRoll.length = 0;
      wakeDetectorResult?.detector.release();
      wakeDetectorResult = null;
      session.stop();
    });
  });

  return fastify;
}

function sendJson(socket: any, payload: any) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

// Start standalone if run directly
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  createVoiceAgentServer().then(async (app) => {
    try {
      await app.listen({ port: PORT, host: HOST });
      console.log(`[Vanessa Voice Agent] WhisperFlow Real-Time Service Online at ws://${HOST}:${PORT}/ws`);
    } catch (err) {
      console.error("[Vanessa Voice Agent] Failed to start:", err);
      process.exit(1);
    }
  });
}
