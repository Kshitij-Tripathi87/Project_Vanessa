import WebSocket from "ws";
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
        this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "ready" });
        console.log(`[FishAsrAdapter] Connected to Fish Realtime ASR at ${this.url} (${this.model})`);

        // Send initialization handshake
        ws.send(
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
          ws.send(frame);
        }
      });

      ws.on("message", (raw: WebSocket.Data) => {
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
        console.log(`[FishAsrAdapter] Disconnected (code: ${code}, reason: ${reason || "none"}).`);
        if (this.isSessionActive && !this.useFallback && !this.isReconnecting) {
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
    this.setStatus({ requested: "Fish Audio", active: "Local Whisper", state: "fallback", detail });
    if (!this.fallbackAdapter) {
      this.fallbackAdapter = new VoiceAdapter();
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
      this.deactivateStream();
    }, durationMs);
  }

  deactivateStream(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.isSessionActive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queuedFrames = [];
    this.fallbackAdapter?.deactivateStream?.();

    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      console.log("[FishAsrAdapter] Closing Fish Realtime ASR socket after the active capture window.");
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
