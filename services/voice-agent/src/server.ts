import "./config/env.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { VanessaVoiceSession } from "./session/voiceSession.js";
import { PcmFrameAccumulator } from "./audio/capture.js";
import { safeProviderDetail } from "./diagnostics/providerDiagnostics.js";
import { getVoiceUsageBudget } from "./usageBudget.js";

const PORT = parseInt(process.env.VOICE_AGENT_PORT || "4500", 10);
const HOST = process.env.HOST || "127.0.0.1";

function getProviderReadiness() {
  const fishKeyValid = (process.env.FISH_API_KEY || "").startsWith("sk-fish-");
  const sarvamKeyValid = Boolean(process.env.SARVAM_API_KEY && !/placeholder|replace[-_ ]with|your[_-].*(key|model|speaker)/i.test(process.env.SARVAM_API_KEY));
  const asrProvider = (process.env.VOICE_ASR_PROVIDER || "fish").toLowerCase();
  const ttsProvider = (process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish").toLowerCase();
  const asrFallbackConfigured = process.env.VOICE_ALLOW_FALLBACK === "true" && Boolean(process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505");
  const ttsFallbackConfigured = process.env.VOICE_TTS_FALLBACK_PROVIDER === "browser";
  const asrConfigured = asrProvider === "fish"
    ? fishKeyValid || asrFallbackConfigured
    : asrProvider === "elevenlabs"
      ? false // No realtime ASR implementation exists for this provider.
      : asrProvider === "sarvam"
        ? sarvamKeyValid && Boolean(process.env.SARVAM_ASR_MODEL || "saaras:v3-realtime") && !/placeholder|your[_-].*model|replace[-_ ]with/i.test(process.env.SARVAM_ASR_MODEL || "")
      : Boolean(process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505");
  const ttsConfigured = ttsProvider === "fish"
    ? (fishKeyValid && Boolean(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID)) || ttsFallbackConfigured
    : ttsProvider === "sarvam"
      ? sarvamKeyValid
        && Boolean(process.env.SARVAM_TTS_MODEL || "bulbul:v4-flash")
        && !/placeholder|your[_-].*model|replace[-_ ]with/i.test(process.env.SARVAM_TTS_MODEL || "")
        && Boolean(process.env.SARVAM_TTS_SPEAKER || "shubh_enhi_ads")
        && !/placeholder|your[_-].*speaker|replace[-_ ]with/i.test(process.env.SARVAM_TTS_SPEAKER || "")
    : Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
  const fallbackActive = (asrProvider === "fish" && !fishKeyValid && asrFallbackConfigured)
    || (ttsProvider === "fish" && !(fishKeyValid && Boolean(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID)) && ttsFallbackConfigured);
  return {
    ready: asrConfigured && ttsConfigured && validateFishConfiguration().valid,
    state: !asrConfigured || !ttsConfigured || !validateFishConfiguration().valid ? "unavailable" : fallbackActive ? "degraded" : "ready",
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
  const asrProvider = (process.env.VOICE_ASR_PROVIDER || "fish").toLowerCase();
  const ttsProvider = (process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish").toLowerCase();
  const allowFallback = process.env.VOICE_ALLOW_FALLBACK === "true";
  const ttsFallback = process.env.VOICE_TTS_FALLBACK_PROVIDER === "browser";
  const sarvamKey = process.env.SARVAM_API_KEY || "";
  const sarvamAsrModel = process.env.SARVAM_ASR_MODEL || "saaras:v3-realtime";
  const sarvamTtsModel = process.env.SARVAM_TTS_MODEL || "bulbul:v4-flash";
  const sarvamTtsSpeaker = process.env.SARVAM_TTS_SPEAKER || "shubh_enhi_ads";

  if (!["fish", "sarvam", "voice", "whisper"].includes(asrProvider)) errors.push("Unsupported or unimplemented ASR provider.");
  if (!["fish", "sarvam", "elevenlabs"].includes(ttsProvider)) errors.push("Unsupported TTS provider.");
  if (ttsProvider === "sarvam" && !["mp3", "wav"].includes(process.env.SARVAM_TTS_OUTPUT_CODEC || "mp3")) errors.push("Sarvam TTS codec must be mp3 or wav.");
  const capped = Number(process.env.VOICE_BUDGET_CAP_INR || 0) > 0 || Number(process.env.VOICE_BUDGET_PER_USER_CAP_INR || 0) > 0;
  for (const key of ["VOICE_BUDGET_CAP_INR", "VOICE_BUDGET_PER_USER_CAP_INR", "SARVAM_ASR_INR_PER_AUDIO_SECOND", "SARVAM_TTS_INR_PER_1K_CHARACTERS"]) {
    const number = Number(process.env[key] || 0);
    if (!Number.isFinite(number) || number < 0) errors.push(`${key} must be a finite nonnegative number.`);
  }
  if (capped && asrProvider === "sarvam" && !(Number(process.env.SARVAM_ASR_INR_PER_AUDIO_SECOND) > 0)) errors.push("A capped Sarvam ASR budget requires a positive audio rate.");
  if (capped && ttsProvider === "sarvam" && !(Number(process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS) > 0)) errors.push("A capped Sarvam TTS budget requires a positive character rate.");

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

  if (asrProvider === "sarvam" || ttsProvider === "sarvam") {
    if (!sarvamKey || /placeholder|replace[-_ ]with|your[_-].*(key|model|speaker)/i.test(sarvamKey)) {
      errors.push("Sarvam: SARVAM_API_KEY is required for the selected provider.");
    }
  }

  if (asrProvider === "sarvam") {
    if (!sarvamAsrModel.trim() || /placeholder|your[_-].*model|replace[-_ ]with/i.test(sarvamAsrModel)) {
      errors.push("Sarvam ASR: set SARVAM_ASR_MODEL to a supported realtime model.");
    }
    if (sarvamAsrModel === "saaras:v4" && !(process.env.SARVAM_ASR_KEYTERMS || "").trim()) {
      warnings.push("Sarvam ASR: v4 keyterm prompting is enabled only when SARVAM_ASR_KEYTERMS is populated.");
    }
  }

  if (ttsProvider === "sarvam") {
    if (!sarvamTtsModel.trim() || /placeholder|your[_-].*model|replace[-_ ]with/i.test(sarvamTtsModel)) {
      errors.push("Sarvam TTS: set SARVAM_TTS_MODEL to a supported model.");
    }
    if (!sarvamTtsSpeaker.trim() || /placeholder|your[_-].*speaker|replace[-_ ]with/i.test(sarvamTtsSpeaker)) {
      errors.push("Sarvam TTS: set SARVAM_TTS_SPEAKER to a supported speaker.");
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
      throw new Error("Selected voice provider configuration is invalid.");
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
  await fastify.register(websocket, { options: { maxPayload: 64 * 1024 } });

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
      providers: readiness.providers,
      configValidation: {
        valid: configValidation.valid,
        errors: configValidation.errors,
        warnings: configValidation.warnings,
      },
      timestamp: Date.now(),
    };
  });

  fastify.get("/usage", async () => {
    return getVoiceUsageBudget().snapshot();
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
        onError: (message) => sendJson(socket, { type: "voice_error", message }),
        onStateChange: (state) => {
          console.log(`[Voice] state=${state}`);
          sendJson(socket, { type: "state_change", state, timestamp: Date.now() });
        },
        onPartialTranscript: (text) => {
          sendJson(socket, { type: "transcript_partial", text });
        },
        onFinalTranscript: (text, requestId) => {
          console.log(`[Voice] transcript committed request=${requestId} characters=${text.length}`);
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
          for (const [kind, provider] of Object.entries(providers)) {
            console.log(`[Voice Provider] ${kind} state=${provider.state} active=${provider.active} detail=${safeProviderDetail(provider.detail || "none")}`);
          }
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
        // ws also delivers text frames as Buffers; use the protocol flag.
        if (isBinary) {
          // Slice incoming buffer into exact 20ms chunks without dropping unaligned bytes
          const chunks = accumulator.feed(Buffer.from(data));
          for (const chunk of chunks) {
            await session.processAudioChunk(chunk);
          }
        } else {
          const json = JSON.parse(data.toString());
          console.log(`[Voice] control=${String(json.type).replace(/[^a-z_]/gi, "").slice(0, 40)}`);
          if (json.type === "activate" || json.type === "reset") {
            accumulator.reset();
            try {
              await session.activateSession(25000);
              sendJson(socket, { type: "state_change", state: "listening" });
            } catch (err: any) {
              console.warn("[VoiceAgentServer] ASR activation failed:", safeProviderDetail(err.message));
              sendJson(socket, {
                type: "voice_error",
                message: `Speech recognition could not start: ${safeProviderDetail(err.message)}`,
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
          } else if (json.type === "transcript_final" && typeof json.text === "string" && json.text.trim().length > 0 && json.text.length <= 16000) {
            const language = typeof json.language === "string" && json.language.length <= 32 ? json.language : "en";
            const turnId = typeof json.turnId === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(json.turnId) ? json.turnId : undefined;
            // HUD text is explicit user intent; it does not need an ambient wake phrase.
            await session.handleFinalUtterance(json.text, language, turnId, true);
          }
        }
      } catch (err: any) {
        console.warn("[VoiceAgentServer] Message processing error:", safeProviderDetail(err.message));
        sendJson(socket, { type: "voice_error", message: "Invalid voice message. Activate the microphone to retry." });
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
