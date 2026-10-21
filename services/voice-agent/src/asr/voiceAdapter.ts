import { WebSocket } from "ws";
import { AsrAdapter, ProviderRuntimeStatus, TranscriptResult } from "./types.js";

export class VoiceAdapter implements AsrAdapter {
  private websocket?: WebSocket;
  private handlers?: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  };
  private isConnected = false;
  private shouldReconnect = true;
  private queue: Uint8Array[] = [];
  private pendingFinalize = false;
  private streamActive = false;
  private statusHandler?: (status: ProviderRuntimeStatus) => void;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly serverUrl = process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505"
  ) {}

  connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): void {
    this.handlers = handlers;
    this.shouldReconnect = true;
    if (this.streamActive) this.initSocket();
  }

  getProviderStatus(): ProviderRuntimeStatus {
    return { requested: "Local Whisper", active: "Local Whisper", state: this.streamActive ? (this.isConnected ? "ready" : "connecting") : "idle" };
  }

  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    this.statusHandler = handler;
    handler(this.getProviderStatus());
  }

  private initSocket(): void {
    if (!this.streamActive || !this.shouldReconnect) return;
    try {
      const websocket = new WebSocket(this.serverUrl);
      this.websocket = websocket;

      websocket.on("open", () => {
        if (!this.streamActive || this.websocket !== websocket) {
          websocket.close();
          return;
        }
        this.isConnected = true;
        this.statusHandler?.(this.getProviderStatus());
        console.log(`[VoiceAdapter] Connected to Voice ASR daemon at ${this.serverUrl}`);

        // Flush chunks queued during connection establishment
        while (this.queue.length > 0) {
          const chunk = this.queue.shift()!;
          websocket.send(chunk);
        }

        if (this.pendingFinalize) {
          this.pendingFinalize = false;
          websocket.send(JSON.stringify({ type: "finalize" }));
        }
      });

      websocket.on("message", (data: any) => {
        try {
          const message = JSON.parse(data.toString());
          const result: TranscriptResult = {
            text: message.text || "",
            isFinal: message.is_final ?? false,
            language: message.language ?? "en",
            confidence: message.confidence ?? 0.9,
          };
          if (result.isFinal) {
            this.handlers?.onFinal(result);
          } else {
            this.handlers?.onPartial(result);
          }
        } catch {}
      });

      websocket.on("error", () => {
        if (this.websocket !== websocket) return;
        this.isConnected = false;
        this.statusHandler?.(this.getProviderStatus());
      });

      websocket.on("close", () => {
        if (this.websocket !== websocket) return;
        this.isConnected = false;
        this.statusHandler?.(this.getProviderStatus());
        if (this.shouldReconnect && this.streamActive) {
          this.reconnectTimer = setTimeout(() => this.initSocket(), 1500);
        }
      });
    } catch {
      this.isConnected = false;
      this.statusHandler?.(this.getProviderStatus());
      if (this.shouldReconnect && this.streamActive) {
        this.reconnectTimer = setTimeout(() => this.initSocket(), 1500);
      }
    }
  }

  sendAudioChunk(pcm: Int16Array): void {
    if (!this.streamActive) return;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(bytes);
    } else {
      this.queue.push(bytes);
      if (this.queue.length > 500) {
        this.queue.shift(); // retain max 10s of audio
      }
    }
  }

  finalizeTurn(): void {
    if (!this.streamActive) return;
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "finalize" }));
    } else {
      this.pendingFinalize = true;
    }
  }

  activateStream(): void {
    this.streamActive = true;
    this.shouldReconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!this.websocket || this.websocket.readyState === WebSocket.CLOSED) {
      this.initSocket();
    }
    this.statusHandler?.(this.getProviderStatus());
  }

  deactivateStream(): void {
    this.streamActive = false;
    this.queue = [];
    this.pendingFinalize = false;
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.websocket?.close();
    this.websocket = undefined;
    this.isConnected = false;
    this.statusHandler?.(this.getProviderStatus());
  }

  close(): void {
    this.deactivateStream();
  }

  isOpen(): boolean {
    return this.isConnected;
  }
}

export const WhisperAdapter = VoiceAdapter;
