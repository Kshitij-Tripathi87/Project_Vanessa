import WebSocket from "ws";
import { decode, encode } from "@msgpack/msgpack";
import { AsrAdapter, ProviderRuntimeStatus, TranscriptResult } from "./types.js";
import { VoiceAdapter } from "./voiceAdapter.js";

export interface FishAsrOptions {
  apiKey?: string;
  url?: string;
  model?: string;
  sampleRate?: number;
  allowFallback?: boolean;
}

export class FishAsrAdapter implements AsrAdapter {
  name = "fish";
  get usesServerTurnDetection(): boolean {
    return !this.useFallback;
  }
  private ws: WebSocket | null = null;
  private handlers?: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  };
  private isConnected = false;
  private isReconnecting = false;
  private fallbackAdapter: VoiceAdapter | null = null;
  private useFallback = false;
  private fallbackReason = "";
  private allowFallback = true;
  private queuedFrames: Buffer[] = [];
  private pendingAudio = Buffer.alloc(0);
  private sessionStarted = false;
  private providerSessionId?: string;
  private finalizing = false;
  private apiKey: string;
  private url: string;
  private model: string;
  private sampleRate: number;
  private isSessionActive = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private status: ProviderRuntimeStatus = { requested: "Fish Audio", active: "Fish Audio", state: "idle" };
  private statusHandler?: (status: ProviderRuntimeStatus) => void;

  constructor(options?: FishAsrOptions) {
    this.apiKey = options?.apiKey || process.env.FISH_API_KEY || "";
    this.url = options?.url || process.env.FISH_ASR_URL || "wss://api.fish.audio/v1/asr/realtime";
    this.model = options?.model || process.env.FISH_ASR_MODEL || "transcribe-stream-1";
    this.sampleRate = options?.sampleRate || 16000;
    this.allowFallback = options?.allowFallback ?? (process.env.VOICE_ALLOW_FALLBACK !== "false");
  }

  async connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): Promise<void> {
    this.handlers = handlers;

    if (!this.apiKey || !this.apiKey.startsWith("sk-fish-")) {
      if (this.allowFallback) {
        this.initFallback("Fish API key is missing or invalid; local Whisper fallback is enabled.");
        return;
      } else {
        const errorMsg = "[FishAsrAdapter] Configuration Error: Fish Audio is the designated ASR provider, but FISH_API_KEY is missing or invalid. Fallback is disabled.";
        console.error(errorMsg);
        this.setStatus({ requested: "Fish Audio", active: "Unavailable", state: "error", detail: "Fish API key is missing or invalid and fallback is disabled." });
        throw new Error(errorMsg);
      }
    }
  }

  getProviderStatus(): ProviderRuntimeStatus {
    return { ...this.status };
  }

  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    this.statusHandler = handler;
    handler(this.getProviderStatus());
  }

  private setStatus(status: ProviderRuntimeStatus): void {
    this.status = status;
    this.statusHandler?.(this.getProviderStatus());
  }

  private initWebSocket(): void {
    if (!this.isSessionActive) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const ws = new WebSocket(this.url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.ws = ws;
      this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "connecting" });

      ws.on("open", () => {
        if (!this.isSessionActive || this.ws !== ws) {
          ws.close();
          return;
        }
        this.isConnected = true;
        this.isReconnecting = false;
        this.useFallback = false;
        this.sessionStarted = false;
        this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "connecting", detail: "Waiting for Fish Audio to initialize the transcription session." });
        console.log(`[FishAsrAdapter] Connected to Fish Realtime ASR at ${this.url} (${this.model})`);

        // Fish realtime ASR uses MessagePack control/audio messages and waits
        // for session_started before accepting audio.
        ws.send(encode({
          type: "config",
          audio: { format: "pcm_s16le", sample_rate: this.sampleRate, channels: 1 },
          turn_detection: { mode: "auto", eager: true },
          results: { drafts: true },
        }));
      });

      ws.on("message", (raw: WebSocket.Data) => {
        try {
          const packed = Buffer.isBuffer(raw)
            ? raw
            : Array.isArray(raw)
              ? Buffer.concat(raw)
              : Buffer.from(raw as ArrayBuffer);
          const msg = decode(packed) as Record<string, any>;
          const eventType = msg.type;

          if (eventType === "session_started") {
            this.sessionStarted = true;
            this.providerSessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
            this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "ready" });
            this.flushQueuedFrames(ws);
            return;
          }

          if (eventType === "error") {
            const detail = typeof msg.message === "string" ? msg.message : "Fish Audio returned an ASR session error.";
            this.isConnected = false;
            if (this.allowFallback) this.initFallback(`${detail} Local Whisper fallback is enabled.`);
            else this.setStatus({ requested: "Fish Audio", active: "Unavailable", state: "error", detail });
            return;
          }

          const text = (msg.text || "").trim();
          if (!text) return;

          if (eventType === "draft") {
            // Draft = HUD display only. INVARIANT: never triggers planning!
            this.handlers?.onPartial({
              text,
              isFinal: false,
              language: msg.language_code || "en",
            });
          } else if (eventType === "committed" && msg.user_turn !== false) {
            // Committed turn = Command ready for planner
            console.log(`[FishAsrAdapter] Committed Turn: "${text}"`);
            this.handlers?.onFinal({
              text,
              isFinal: true,
              language: msg.language_code || "en",
              turnId: `${this.providerSessionId || "fish"}:${msg.turn_index ?? text}`,
            });
          }
        } catch {
          // Ignore malformed MessagePack frames and non-session control data.
        }
      });

      ws.on("error", (err) => {
        if (this.ws !== ws) return;
        console.warn(`[FishAsrAdapter] WebSocket error: ${err.message}`);
        this.isConnected = false;
        if (this.allowFallback) {
          this.initFallback("Fish Audio connection failed; local Whisper fallback is enabled.");
        } else {
          this.setStatus({ requested: "Fish Audio", active: "Unavailable", state: "error", detail: "Fish Audio connection failed and fallback is disabled." });
        }
      });

      ws.on("close", (code, reason) => {
        if (this.ws !== ws) return;
        this.isConnected = false;
        this.sessionStarted = false;
        console.log(`[FishAsrAdapter] Disconnected (code: ${code}, reason: ${reason || "none"}).`);
        if (this.isSessionActive && !this.finalizing && !this.useFallback && !this.isReconnecting) {
          this.isReconnecting = true;
          this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "connecting", detail: "Reconnecting to Fish Audio." });
          this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.initWebSocket();
          }, 1500);
        } else if (!this.isSessionActive && !this.useFallback) {
          this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "idle" });
        }
      });
    } catch (err: any) {
      console.warn(`[FishAsrAdapter] Init failed: ${err.message}`);
      if (this.allowFallback) {
        this.initFallback("Fish Audio could not be initialized; local Whisper fallback is enabled.");
      } else {
        this.setStatus({ requested: "Fish Audio", active: "Unavailable", state: "error", detail: "Fish Audio could not be initialized and fallback is disabled." });
      }
    }
  }

  private initFallback(detail: string): void {
    this.useFallback = true;
    this.fallbackReason = detail;
    this.isConnected = false;
    this.sessionStarted = false;
    this.queuedFrames = [];
    this.pendingAudio = Buffer.alloc(0);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const failedSocket = this.ws;
    this.ws = null;
    if (failedSocket && failedSocket.readyState < WebSocket.CLOSING) {
      try { failedSocket.close(); } catch {}
    }
    this.setStatus({ requested: "Fish Audio", active: "Local Whisper", state: "fallback", detail });
    if (!this.fallbackAdapter) {
      this.fallbackAdapter = new VoiceAdapter();
      this.fallbackAdapter.setStatusHandler((providerStatus) => {
        if (!this.useFallback) return;
        const state = providerStatus.state === "error"
          ? "error"
          : providerStatus.state === "connecting"
            ? "connecting"
            : "fallback";
        this.setStatus({
          requested: "Fish Audio",
          active: "Local Whisper",
          state,
          detail: [this.fallbackReason, providerStatus.detail].filter(Boolean).join(" "),
        });
      });
      if (this.handlers) {
        this.fallbackAdapter.connect(this.handlers);
      }
      if (this.isSessionActive) {
        this.fallbackAdapter.activateStream?.();
      }
      console.log("[FishAsrAdapter] Active ASR is now Local Voice ASR fallback.");
    }
  }

  sendAudioChunk(pcm: Int16Array): void {
    if (!this.isSessionActive) return;

    if (this.useFallback && this.fallbackAdapter) {
      this.fallbackAdapter.sendAudioChunk(pcm);
      return;
    }

    const buffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.pendingAudio = this.pendingAudio.length ? Buffer.concat([this.pendingAudio, buffer]) : Buffer.from(buffer);
    const messageBytes = Math.round(this.sampleRate * 0.1) * 2; // Fish expects 80–100 ms per message.
    while (this.pendingAudio.length >= messageBytes) {
      const audio = this.pendingAudio.subarray(0, messageBytes);
      this.pendingAudio = this.pendingAudio.subarray(messageBytes);
      this.sendAudioMessage(Buffer.from(audio));
    }
  }

  finalizeTurn(): void {
    if (!this.isSessionActive) return;
    if (this.useFallback && this.fallbackAdapter) {
      this.fallbackAdapter.finalizeTurn?.();
      return;
    }

    this.finalizing = true;
    if (this.pendingAudio.length) {
      const messageBytes = Math.round(this.sampleRate * 0.1) * 2;
      const tail = Buffer.alloc(messageBytes);
      this.pendingAudio.copy(tail);
      this.pendingAudio = Buffer.alloc(0);
      this.sendAudioMessage(tail);
    }
    this.queueOrSend(Buffer.from(encode({ type: "audio_done" })));
  }

  private sendAudioMessage(audio: Buffer): void {
    this.queueOrSend(Buffer.from(encode({ type: "audio", data: audio })));
  }

  private queueOrSend(message: Buffer): void {
    if (this.sessionStarted && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
      return;
    }
    this.queuedFrames.push(message);
    // Bound pre-handshake buffering to five seconds of audio/control messages.
    if (this.queuedFrames.length > 50) this.queuedFrames.shift();
  }

  private flushQueuedFrames(ws: WebSocket): void {
    while (this.isSessionActive && this.sessionStarted && ws === this.ws && ws.readyState === WebSocket.OPEN && this.queuedFrames.length) {
      ws.send(this.queuedFrames.shift()!);
    }
  }

  activateStream(durationMs = 25000): void {
    if (this.finalizing && this.ws && this.ws.readyState < WebSocket.CLOSING) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isSessionActive = true;
    this.finalizing = false;
    this.sessionStarted = false;
    this.providerSessionId = undefined;
    this.pendingAudio = Buffer.alloc(0);
    this.isReconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.useFallback && this.fallbackAdapter) {
      this.fallbackAdapter.connect(this.handlers!);
      this.fallbackAdapter.activateStream?.();
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.useFallback && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
      this.initWebSocket();
    } else if (this.useFallback) {
      this.setStatus({ ...this.status, state: "fallback" });
    }

    this.idleTimer = setTimeout(() => {
      this.finalizeTurn();
    }, durationMs);
  }

  deactivateStream(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const finishProviderSession = this.sessionStarted && this.ws?.readyState === WebSocket.OPEN && !this.finalizing;
    this.isSessionActive = false;
    this.isConnected = false;
    this.finalizing = true;
    if (finishProviderSession && this.ws) {
      this.ws.send(Buffer.from(encode({ type: "audio_done" })));
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queuedFrames = [];
    this.pendingAudio = Buffer.alloc(0);
    this.fallbackAdapter?.deactivateStream?.();

    if (!finishProviderSession && this.ws && this.ws.readyState < WebSocket.CLOSING) {
      console.log("[FishAsrAdapter] Closing Fish Realtime ASR socket after the active capture window.");
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    if (finishProviderSession) {
      // The provider closes after sending session_done. Retain the socket ref
      // until its close event so its final lifecycle signal can be consumed.
      this.sessionStarted = false;
    }
    if (!this.useFallback && this.status.state !== "error") {
      this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "idle" });
    }
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.isSessionActive = false;
    this.finalizing = true;
    this.sessionStarted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.fallbackAdapter?.close();
    this.fallbackAdapter = null;
    this.useFallback = false;
    this.isReconnecting = false;
    this.queuedFrames = [];
    this.pendingAudio = Buffer.alloc(0);
    this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "idle" });
  }
}
