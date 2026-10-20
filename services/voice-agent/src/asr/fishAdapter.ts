import WebSocket from "ws";
import { AsrAdapter, TranscriptResult } from "./types.js";
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
  private ws: WebSocket | null = null;
  private handlers?: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  };
  private isConnected = false;
  private isReconnecting = false;
  private fallbackAdapter: VoiceAdapter | null = null;
  private useFallback = false;
  private allowFallback = true;
  private queuedFrames: Buffer[] = [];
  private apiKey: string;
  private url: string;
  private model: string;
  private sampleRate: number;
  private isSessionActive = false;
  private idleTimer: NodeJS.Timeout | null = null;

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
        this.name = "faster-whisper (fallback)";
        console.warn(
          "[FishAsrAdapter] Fish Audio ASR requested, but FISH_API_KEY is not configured or invalid (must start with 'sk-fish-'). " +
          "Fallback policy permits local ASR: engaging faster-whisper. Active provider: " + this.name
        );
        this.initFallback();
        return;
      } else {
        const errorMsg = "[FishAsrAdapter] Configuration Error: Fish Audio is the designated ASR provider, but FISH_API_KEY is missing or invalid. Fallback is disabled.";
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    }

    this.initWebSocket();
  }

  private initWebSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      this.ws.on("open", () => {
        if (!this.isSessionActive) {
          this.ws?.close();
          return;
        }
        this.isConnected = true;
        this.isReconnecting = false;
        this.useFallback = false;
        console.log(`[FishAsrAdapter] Connected to Fish Realtime ASR at ${this.url} (${this.model})`);

        // Send initialization handshake
        this.ws?.send(
          JSON.stringify({
            type: "start",
            model: this.model,
            sample_rate: this.sampleRate,
            language: "en",
          })
        );

        // Flush queued frames
        while (this.isSessionActive && this.queuedFrames.length > 0) {
          const frame = this.queuedFrames.shift()!;
          this.ws?.send(frame);
        }
      });

      this.ws.on("message", (raw: WebSocket.Data) => {
        try {
          const msg = JSON.parse(raw.toString());
          // Fish Audio Realtime ASR events: draft vs committed
          const eventType = msg.type || msg.event;
          const text = (msg.text || msg.transcript || "").trim();

          if (!text) return;

          if (eventType === "draft" || msg.is_final === false) {
            // Draft = HUD display only. INVARIANT: never triggers planning!
            this.handlers?.onPartial({
              text,
              isFinal: false,
              language: msg.language || "en",
              confidence: msg.confidence ?? 0.88,
            });
          } else if (eventType === "committed" || msg.is_final === true) {
            // Committed turn = Command ready for planner
            console.log(`[FishAsrAdapter] Committed Turn: "${text}"`);
            this.handlers?.onFinal({
              text,
              isFinal: true,
              language: msg.language || "en",
              confidence: msg.confidence ?? 0.98,
            });
          }
        } catch {
          // Binary message or non-json ping
        }
      });

      this.ws.on("error", (err) => {
        console.warn(`[FishAsrAdapter] WebSocket error: ${err.message}. Engaging local fallback.`);
        this.isConnected = false;
        this.initFallback();
      });

      this.ws.on("close", (code, reason) => {
        this.isConnected = false;
        console.log(`[FishAsrAdapter] Disconnected (code: ${code}, reason: ${reason || "none"}).`);
        if (this.isSessionActive && !this.useFallback && !this.isReconnecting) {
          this.isReconnecting = true;
          setTimeout(() => this.initWebSocket(), 3000);
        }
      });
    } catch (err: any) {
      console.warn(`[FishAsrAdapter] Init failed: ${err.message}. Switching to local ASR fallback.`);
      this.initFallback();
    }
  }

  private initFallback(): void {
    if (!this.fallbackAdapter) {
      this.useFallback = true;
      this.fallbackAdapter = new VoiceAdapter();
      if (this.handlers) {
        this.fallbackAdapter.connect(this.handlers);
      }
      if (this.isSessionActive) {
        this.fallbackAdapter.activateStream?.();
      }
      console.log("[FishAsrAdapter] Active ASR is now Local Voice ASR Fallback (faster-whisper).");
    }
  }

  sendAudioChunk(pcm: Int16Array): void {
    if (!this.isSessionActive) return;

    if (this.useFallback && this.fallbackAdapter) {
      this.fallbackAdapter.sendAudioChunk(pcm);
      return;
    }

    const buffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    } else {
      this.queuedFrames.push(buffer);
      if (this.queuedFrames.length > 100) {
        this.queuedFrames.shift(); // retain max ~8-10 seconds
      }
    }
  }

  finalizeTurn(): void {
    if (this.useFallback && this.fallbackAdapter) {
      this.fallbackAdapter.finalizeTurn?.();
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "finish" }));
    }
  }

  activateStream(durationMs = 25000): void {
    this.isSessionActive = true;
    this.fallbackAdapter?.activateStream?.();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.useFallback && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
      this.initWebSocket();
    }

    this.idleTimer = setTimeout(() => {
      this.deactivateStream();
    }, durationMs);
  }

  deactivateStream(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.isSessionActive = false;
    this.queuedFrames = [];
    this.fallbackAdapter?.deactivateStream?.();

    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      console.log("[FishAsrAdapter] Closing Fish Realtime ASR socket after the active capture window.");
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.isSessionActive = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.fallbackAdapter?.close();
    this.fallbackAdapter = null;
    this.queuedFrames = [];
  }
}
