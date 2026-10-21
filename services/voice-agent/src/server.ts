import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { VanessaVoiceSession } from "./session/voiceSession.js";
import { AudioCapture, PcmFrameAccumulator } from "./audio/capture.js";

dotenv.config();

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

export async function createVoiceAgentServer() {
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  });
  await fastify.register(websocket);

  // Health check
  fastify.get("/health", async () => {
    const readiness = getProviderReadiness();
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
      providers: readiness.providers,
      timestamp: Date.now(),
    };
  });

  fastify.get("/ready", async (_request, reply) => {
    const readiness = getProviderReadiness();
    if (!readiness.ready) reply.status(503);
    return { status: readiness.state, providers: readiness.providers, timestamp: Date.now() };
  });

  // WhisperFlow-compatible Real-time WebSocket streaming endpoint
  fastify.get("/ws", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) {
      socket.close(1008, "Origin not allowed");
      return;
    }
    const session = new VanessaVoiceSession({
      handlers: {
        onStateChange: (state) => {
          sendJson(socket, { type: "state_change", state, timestamp: Date.now() });
        },
        onPartialTranscript: (text) => {
          sendJson(socket, { type: "transcript_partial", text });
        },
        onFinalTranscript: (text, requestId) => {
          sendJson(socket, { type: "transcript_final", text, requestId });
        },
        onAudioChunkOut: (chunk) => {
          sendJson(socket, { type: "tts_chunk", ...chunk });
        },
        onTtsUnavailable: (detail) => {
          sendJson(socket, { type: "tts_unavailable", detail });
        },
        onHudUpdate: (hud) => {
          sendJson(socket, { type: "hud_update", ...hud });
        },
        onProviderStatus: (providers) => {
          sendJson(socket, { type: "provider_status", providers });
        },
      },
    });

    session.start().catch((err) => {
      console.warn("[VoiceAgentServer] Session start error:", err.message);
    });

    // Session ready handshake
    sendJson(socket, {
      type: "session_ready",
      sampleRate: 16000,
      chunkDurationMs: 20,
      chunkSamples: 320,
      chunkBytes: 640,
      bargeInEnabled: true,
      activationMode: "push_to_talk",
      wakeWord: null,
      providers: session.getProviderInfo(),
      timestamp: Date.now(),
    });

    console.log(`[VoiceAgentServer] Desktop client connected to /ws session`);
    const accumulator = new PcmFrameAccumulator(320);

    socket.on("message", async (data: any, isBinary: boolean) => {
      try {
        if (isBinary || Buffer.isBuffer(data)) {
          // Slice incoming buffer into exact 20ms chunks without dropping unaligned bytes
          const chunks = accumulator.feed(Buffer.from(data));
          for (const chunk of chunks) {
            await session.processAudioChunk(chunk);
          }
        } else {
          const json = JSON.parse(data.toString());
          if (json.type === "activate" || json.type === "reset") {
            accumulator.reset();
            try {
              await session.activateSession(25000);
              sendJson(socket, { type: "state_change", state: "listening" });
            } catch (err: any) {
              console.warn("[VoiceAgentServer] ASR activation failed:", err.message);
              sendJson(socket, {
                type: "voice_error",
                message: "Speech recognition could not start. Check the configured ASR provider and try again.",
              });
            }
          } else if (json.type === "finalize") {
            session.finalizeTurn();
          } else if (json.type === "deactivate") {
            accumulator.reset();
            session.stop();
          } else if (json.type === "barge_in" || json.type === "interrupt") {
            session.interrupt();
            sendJson(socket, { type: "barge_in_acknowledged" });
          } else if (json.type === "transcript_final" && json.text) {
            await session.handleFinalUtterance(json.text, json.language || "en");
          }
        }
      } catch (err: any) {
        console.warn("[VoiceAgentServer] Message processing error:", err.message);
      }
    });

    socket.on("close", () => {
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
