import WebSocket from "ws";
import { decode, encode } from "@msgpack/msgpack";
import { VoiceTtsAdapter, TtsOutputChunk } from "./types.js";
import { ProviderRuntimeStatus } from "../asr/types.js";

type BrowserFallback = "browser" | "none";

export interface FishTtsOptions {
  apiKey?: string;
  voiceId?: string;
  model?: string;
  url?: string;
  sampleRate?: number;
  fallback?: BrowserFallback;
  timeoutMs?: number;
}

export class FishTtsAdapter implements VoiceTtsAdapter {
  private activeAbortController: AbortController | null = null;
  private activeSocket: WebSocket | null = null;
  private apiKey: string | undefined;
  private voiceId: string | undefined;
  private model: string;
  private url: string;
  private sampleRate: number;
  private fallback: BrowserFallback;
  private timeoutMs: number;
  private status: ProviderRuntimeStatus;
  private statusHandler?: (status: ProviderRuntimeStatus) => void;

  constructor(options: FishTtsOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.FISH_API_KEY;
    const configuredVoiceId = options.voiceId ?? process.env.FISH_TTS_VOICE_ID ?? process.env.FISH_VANESSA_VOICE_ID;
    this.voiceId = configuredVoiceId?.replace(/"/g, "").trim() || undefined;
    this.model = options.model || process.env.FISH_TTS_MODEL || process.env.FISH_MODEL || "s2.1-pro-free";
    this.url = options.url || process.env.FISH_TTS_URL || "wss://api.fish.audio/v1/tts/live";
    this.sampleRate = options.sampleRate || Number(process.env.FISH_TTS_SAMPLE_RATE) || 24000;
    this.fallback = options.fallback || (process.env.VOICE_TTS_FALLBACK_PROVIDER === "browser" ? "browser" : "none");
    this.timeoutMs = options.timeoutMs || Number(process.env.FISH_TTS_TIMEOUT_MS) || 30000;

    const configurationError = this.getConfigurationError();
    this.status = configurationError
      ? this.fallback === "browser"
        ? { requested: "Fish Audio", active: "Browser Speech Synthesis", state: "fallback", detail: configurationError }
        : { requested: "Fish Audio", active: "Unavailable", state: "error", detail: configurationError }
      : { requested: "Fish Audio", active: "Fish Audio", state: "idle" };
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

  private getConfigurationError(): string | undefined {
    if (!this.apiKey || !this.apiKey.startsWith("sk-fish-")) return "Fish API key is missing or invalid.";
    if (!this.voiceId) return "Fish TTS voice ID is not configured.";
    if (!Number.isInteger(this.sampleRate) || this.sampleRate < 8000 || this.sampleRate > 48000) {
      return "Fish TTS sample rate must be a supported integer audio rate.";
    }
    return undefined;
  }

  async streamSpeech(
    text: string,
    onAudioChunk: (chunk: TtsOutputChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    const configurationError = this.getConfigurationError();
    if (configurationError) {
      if (this.fallback === "browser") {
        this.setStatus({ requested: "Fish Audio", active: "Browser Speech Synthesis", state: "fallback", detail: configurationError });
        onAudioChunk({ chunkIndex: 0, text, isFinal: true, fallbackSpeech: true });
        signal?.removeEventListener("abort", abortFromCaller);
        this.activeAbortController = null;
        return;
      }
      this.setStatus({ requested: "Fish Audio", active: "Unavailable", state: "error", detail: configurationError });
      signal?.removeEventListener("abort", abortFromCaller);
      this.activeAbortController = null;
      throw new Error(configurationError);
    }

    if (!text.trim()) {
      signal?.removeEventListener("abort", abortFromCaller);
      this.activeAbortController = null;
      return;
    }

    let receivedAudio = false;
    this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "connecting" });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(this.url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            model: this.model,
          },
        });
        this.activeSocket = socket;
        let timeout: NodeJS.Timeout | undefined;
        let settled = false;
        let lastAudio: Buffer | undefined;
        let chunkIndex = 0;

        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          controller.signal.removeEventListener("abort", onAbort);
          if (this.activeSocket === socket) this.activeSocket = null;
          if (this.activeAbortController === controller) this.activeAbortController = null;
          signal?.removeEventListener("abort", abortFromCaller);
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const emitAudio = (audio: Buffer, isFinal: boolean) => {
          if (audio.length === 0) return;
          receivedAudio = true;
          onAudioChunk({
            chunkIndex: chunkIndex++,
            text: "",
            isFinal,
            audioBase64: audio.toString("base64"),
            format: "pcm_s16le",
            sampleRate: this.sampleRate,
          });
        };
        const onAbort = () => {
          if (socket.readyState < WebSocket.CLOSING) socket.terminate();
          finish();
        };

        controller.signal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => finish(new Error("Fish TTS stream timed out.")), this.timeoutMs);

        socket.on("open", () => {
          try {
            this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "ready" });
            socket.send(encode({
              event: "start",
              request: {
                text: "",
                format: "pcm",
                sample_rate: this.sampleRate,
                reference_id: this.voiceId,
                latency: "balanced",
              },
            }));
            socket.send(encode({ event: "text", text }));
            socket.send(encode({ event: "flush" }));
            socket.send(encode({ event: "stop" }));
          } catch (err: any) {
            finish(new Error(`Could not start Fish TTS: ${err.message}`));
          }
        });

        socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
          if (!isBinary) return;
          try {
            const packed = Buffer.isBuffer(raw)
              ? raw
              : Array.isArray(raw)
                ? Buffer.concat(raw)
                : Buffer.from(raw as ArrayBuffer);
            const message = decode(packed) as Record<string, any>;
            if (message.event === "audio") {
              const audio = message.audio;
              if (!(audio instanceof Uint8Array) && !Buffer.isBuffer(audio)) return;
              const current = Buffer.from(audio);
              if (lastAudio) emitAudio(lastAudio, false);
              lastAudio = current;
              return;
            }
            if (message.event === "finish") {
              if (message.reason === "error") {
                finish(new Error(typeof message.message === "string" ? message.message : "Fish TTS synthesis failed."));
                return;
              }
              if (!lastAudio) {
                finish(new Error("Fish TTS finished without returning audio."));
                return;
              }
              emitAudio(lastAudio, true);
              this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "ready" });
              finish();
              if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "synthesis complete");
            }
          } catch (err: any) {
            finish(new Error(`Invalid Fish TTS response: ${err.message}`));
          }
        });

        socket.on("unexpected-response", (_request, response) => {
          const statusCode = response.statusCode || "unknown";
          response.resume();
          finish(new Error(`Fish TTS WebSocket handshake failed with HTTP ${statusCode}.`));
        });
        socket.on("error", (err) => finish(new Error(`Fish TTS WebSocket error: ${err.message}`)));
        socket.on("close", (code, reason) => {
          if (controller.signal.aborted) return finish();
          if (!settled) finish(new Error(`Fish TTS closed before completion (${code}: ${reason.toString()}).`));
        });
      });
    } catch (err: any) {
      if (controller.signal.aborted) return;
      const detail = err.message || "Fish Audio TTS request failed.";
      if (this.fallback === "browser" && !receivedAudio) {
        this.setStatus({ requested: "Fish Audio", active: "Browser Speech Synthesis", state: "fallback", detail });
        onAudioChunk({ chunkIndex: 0, text, isFinal: true, fallbackSpeech: true });
        return;
      }
      this.setStatus({ requested: "Fish Audio", active: "Unavailable", state: "error", detail });
      throw err;
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.activeAbortController === controller) this.activeAbortController = null;
    }
  }

  abort(): void {
    this.activeAbortController?.abort();
    if (this.activeSocket && this.activeSocket.readyState < WebSocket.CLOSING) {
      this.activeSocket.terminate();
    }
    this.activeSocket = null;
    this.activeAbortController = null;
  }
}
