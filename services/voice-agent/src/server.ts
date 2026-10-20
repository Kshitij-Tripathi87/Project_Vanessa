import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { VanessaVoiceSession } from "./session/voiceSession.js";
import { AudioCapture, PcmFrameAccumulator } from "./audio/capture.js";

dotenv.config();

const PORT = parseInt(process.env.VOICE_AGENT_PORT || "4500", 10);
const HOST = process.env.HOST || "127.0.0.1";

export async function createVoiceAgentServer() {
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  });
  await fastify.register(websocket);

  // Health check
  fastify.get("/health", async () => {
    return {
      status: "online",
      service: "vanessa-voice-agent",
      protocol: "whisperflow-realtime-v1",
      sampleRate: 16000,
      chunkDurationMs: 20,
      chunkSamples: 320,
      defaultAsr: process.env.VOICE_ASR_PROVIDER || "fish",
      defaultTts: process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish",
      timestamp: Date.now(),
    };
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
        onFinalTranscript: (text) => {
          sendJson(socket, { type: "transcript_final", text });
        },
        onAudioChunkOut: (chunk) => {
          sendJson(socket, { type: "tts_chunk", ...chunk });
        },
        onHudUpdate: (hud) => {
          sendJson(socket, { type: "hud_update", ...hud });
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
      wakeWord: "Hey Vanessa",
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
            session.activateSession(25000);
            sendJson(socket, { type: "state_change", state: "listening" });
          } else if (json.type === "finalize") {
            session.finalizeTurn();
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
