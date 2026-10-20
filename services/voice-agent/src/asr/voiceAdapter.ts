import { WebSocket } from "ws";
import { AsrAdapter, TranscriptResult } from "./types.js";

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

  constructor(
    private readonly serverUrl = process.env.VOICE_URL || process.env.WHISPER_URL || "ws://127.0.0.1:4505"
  ) {}

  connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): void {
    this.handlers = handlers;
    this.shouldReconnect = true;
    this.initSocket();
  }

  private initSocket(): void {
    try {
      this.websocket = new WebSocket(this.serverUrl);

      this.websocket.on("open", () => {
        this.isConnected = true;
        console.log(`[VoiceAdapter] Connected to Voice ASR daemon at ${this.serverUrl}`);

        // Flush chunks queued during connection establishment
        while (this.queue.length > 0) {
          const chunk = this.queue.shift()!;
          this.websocket?.send(chunk);
        }

        if (this.pendingFinalize) {
          this.pendingFinalize = false;
          this.websocket?.send(JSON.stringify({ type: "finalize" }));
        }
      });

      this.websocket.on("message", (data: any) => {
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

      this.websocket.on("error", () => {
        this.isConnected = false;
      });

      this.websocket.on("close", () => {
        this.isConnected = false;
        if (this.shouldReconnect) {
          setTimeout(() => this.initSocket(), 2000);
        }
      });
    } catch {
      this.isConnected = false;
      if (this.shouldReconnect) {
        setTimeout(() => this.initSocket(), 2000);
      }
    }
  }

  sendAudioChunk(pcm: Int16Array): void {
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
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "finalize" }));
    } else {
      this.pendingFinalize = true;
    }
  }

  close(): void {
    this.shouldReconnect = false;
    this.websocket?.close();
    this.isConnected = false;
    this.queue = [];
    this.pendingFinalize = false;
  }

  isOpen(): boolean {
    return this.isConnected;
  }
}

export const WhisperAdapter = VoiceAdapter;
