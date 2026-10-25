import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { UsageBudget, type UsageReservation } from "@vanessa/shared";
import { ProviderRuntimeStatus } from "../asr/types.js";
import { diagnoseUpgradeRejection, providerTransportError, safeProviderDetail } from "../diagnostics/providerDiagnostics.js";
import { VoiceTtsAdapter, TtsOutputChunk } from "./types.js";
import { getVoiceUsageBudget } from "../usageBudget.js";

export interface SarvamTtsOptions {
  apiKey?: string;
  url?: string;
  model?: string;
  speaker?: string;
  language?: string;
  codec?: "mp3" | "wav";
  bitrate?: string;
  sampleRate?: number;
  minBufferSize?: number;
  maxChunkLength?: number;
  timeoutMs?: number;
  budget?: UsageBudget;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || /placeholder|replace[-_ ]with|your[_-].*key/i.test(value);
}

/**
 * Sarvam Bulbul streaming TTS adapter.
 *
 * The API key is read only in the trusted voice service. Renderer code sees
 * audio chunks and provider status, never the credential.
 */
export class SarvamTtsAdapter implements VoiceTtsAdapter {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly speaker: string;
  private language: string;
  private readonly codec: "mp3" | "wav";
  private readonly bitrate: string;
  private readonly sampleRate: number;
  private readonly minBufferSize: number;
  private readonly maxChunkLength: number;
  private readonly timeoutMs: number;
  private readonly budget: UsageBudget;
  private activeSocket: WebSocket | null = null;
  private activeAbortController: AbortController | null = null;
  private status: ProviderRuntimeStatus;
  private statusHandler?: (status: ProviderRuntimeStatus) => void;

  constructor(options: SarvamTtsOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SARVAM_API_KEY ?? "";
    this.url = options.url ?? process.env.SARVAM_TTS_URL ?? "wss://api.sarvam.ai/text-to-speech/ws";
    this.model = options.model ?? process.env.SARVAM_TTS_MODEL ?? "bulbul:v4-flash";
    this.speaker = options.speaker ?? process.env.SARVAM_TTS_SPEAKER ?? "shubh_enhi_ads";
    this.language = options.language ?? process.env.SARVAM_TTS_LANGUAGE ?? "en-IN";
    this.codec = (options.codec ?? process.env.SARVAM_TTS_OUTPUT_CODEC ?? "mp3") as "mp3" | "wav";
    this.bitrate = options.bitrate ?? process.env.SARVAM_TTS_BITRATE ?? "128k";
    this.sampleRate = Math.max(8000, Math.floor(Number(options.sampleRate ?? process.env.SARVAM_TTS_SAMPLE_RATE ?? 24000)));
    this.minBufferSize = Math.max(0, Number(options.minBufferSize ?? process.env.SARVAM_TTS_MIN_BUFFER_SIZE ?? 50));
    this.maxChunkLength = Math.max(1, Number(options.maxChunkLength ?? process.env.SARVAM_TTS_MAX_CHUNK_LENGTH ?? 200));
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs ?? process.env.SARVAM_TTS_TIMEOUT_MS ?? 30000));
    this.budget = options.budget ?? getVoiceUsageBudget();

    const configurationError = this.getConfigurationError();
    this.status = configurationError
      ? { requested: "Sarvam", active: "Unavailable", state: "error", detail: configurationError }
      : { requested: "Sarvam", active: "Sarvam", state: "idle" };
  }

  getProviderStatus(): ProviderRuntimeStatus {
    return { ...this.status };
  }

  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    this.statusHandler = handler;
    handler(this.getProviderStatus());
  }

  setLanguage(language: string): void {
    if (language.trim()) this.language = language.trim();
  }

  private setStatus(status: ProviderRuntimeStatus): void {
    this.status = status;
    this.statusHandler?.(this.getProviderStatus());
  }

  private getConfigurationError(): string | undefined {
    if (isPlaceholder(this.apiKey)) return "Set SARVAM_API_KEY in the root .env file.";
    if (!this.model.trim() || /placeholder|your[_-].*model|replace[-_ ]with/i.test(this.model)) return "Set SARVAM_TTS_MODEL in the root .env file.";
    if (!this.speaker.trim() || /placeholder|your[_-].*speaker|replace[-_ ]with/i.test(this.speaker)) return "Set SARVAM_TTS_SPEAKER in the root .env file.";
    if (!["mp3", "wav"].includes(this.codec)) return "SARVAM_TTS_OUTPUT_CODEC must be mp3 or wav.";
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
    if (signal?.aborted) {
      this.activeAbortController = null;
      return;
    }
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const requestId = `sarvam-tts-${randomUUID()}`;
    let reservation: UsageReservation | undefined;
    try {
      reservation = this.reserveBudget(requestId, text.length);
    } catch (error) {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.activeAbortController === controller) this.activeAbortController = null;
      throw error;
    }

    if (!text.trim()) {
      if (reservation) this.budget.release(reservation, { reason: "empty_text" });
      signal?.removeEventListener("abort", abortFromCaller);
      this.activeAbortController = null;
      return;
    }

    const configurationError = this.getConfigurationError();
    if (configurationError) {
      if (reservation) this.budget.fail(reservation, configurationError);
      this.setStatus({ requested: "Sarvam", active: "Unavailable", state: "error", detail: configurationError });
      signal?.removeEventListener("abort", abortFromCaller);
      this.activeAbortController = null;
      throw new Error(configurationError);
    }

    this.setStatus({ requested: "Sarvam", active: "Sarvam", state: "connecting" });
    let receivedAudio = false;
    const characterCount = text.length;
    let requestStarted = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const endpoint = new URL(this.url);
        endpoint.searchParams.set("model", this.model);
        endpoint.searchParams.set("send_completion_event", "true");
        const socket = new WebSocket(endpoint, {
          headers: { "Api-Subscription-Key": this.apiKey },
          handshakeTimeout: Math.min(this.timeoutMs, 10000),
        });
        this.activeSocket = socket;
        let timeout: NodeJS.Timeout | undefined;
        let settled = false;
        let chunkIndex = 0;
        const isCurrent = () => this.activeSocket === socket
          && this.activeAbortController === controller
          && !controller.signal.aborted
          && !settled;

        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          controller.signal.removeEventListener("abort", onAbort);
          if (this.activeSocket === socket) this.activeSocket = null;
          signal?.removeEventListener("abort", abortFromCaller);
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error && socket.readyState < WebSocket.CLOSING) socket.terminate();
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => {
          if (this.activeAbortController === controller) {
            this.setStatus({ requested: "Sarvam", active: "Sarvam", state: "idle" });
          }
          if (socket.readyState < WebSocket.CLOSING) socket.terminate();
          finish();
        };
        const emitAudio = (audio: string) => {
          if (!isCurrent()) return;
          receivedAudio = true;
          // Compressed WS fragments are not necessarily independently decodable.
          // Assemble a bounded complete utterance before browser decodeAudioData.
          const bytes = Buffer.from(audio, "base64");
          audioBytes += bytes.length;
          if (audioBytes > 16 * 1024 * 1024) return finish(new Error("Sarvam TTS audio exceeded the utterance size limit."));
          audioParts.push(bytes);
        };
        const audioParts: Buffer[] = [];
        let audioBytes = 0;

        diagnoseUpgradeRejection(socket, "TTS", this.apiKey, (error) => {
          if (isCurrent()) finish(error);
        }, "Sarvam");
        timeout = setTimeout(() => finish(new Error("Sarvam TTS stream timed out.")), this.timeoutMs);
        controller.signal.addEventListener("abort", onAbort, { once: true });

        socket.on("open", () => {
          if (!isCurrent()) return;
          try {
            this.setStatus({ requested: "Sarvam", active: "Sarvam", state: "ready" });
            socket.send(JSON.stringify({
              type: "config",
              data: {
                speaker: this.speaker,
                language_code: this.language,
                output_audio_codec: this.codec,
                output_audio_bitrate: this.bitrate,
                speech_sample_rate: this.sampleRate,
                min_buffer_size: this.minBufferSize,
                max_chunk_length: this.maxChunkLength,
              },
            }));
            requestStarted = true;
            const characters = Array.from(text);
            for (let offset = 0; offset < characters.length; offset += 2500) {
              socket.send(JSON.stringify({ type: "text", data: { text: characters.slice(offset, offset + 2500).join("") } }));
            }
            socket.send(JSON.stringify({ type: "flush" }));
          } catch (error: any) {
            finish(new Error(`Could not start Sarvam TTS: ${error.message}`));
          }
        });

        socket.on("message", (raw: WebSocket.RawData) => {
          if (!isCurrent()) return;
          try {
            const message = JSON.parse(raw.toString()) as Record<string, any>;
            const type = typeof message.type === "string" ? message.type : message.event;
            const data = message.data && typeof message.data === "object" ? message.data : message.data;
            const audio = typeof data === "string"
              ? data
              : typeof data?.audio === "string"
                ? data.audio
                : typeof message.audio === "string"
                  ? message.audio
                  : undefined;

            if (type === "audio") {
              if (!audio || !this.isValidAudioBase64(audio)) {
                finish(new Error("Sarvam TTS returned malformed or empty audio."));
                return;
              }
              emitAudio(audio);
              return;
            }

            if (type === "error" || message.error) {
              const detail = safeProviderDetail(
                typeof message.message === "string" ? message.message : typeof message.error === "string" ? message.error : "Sarvam TTS returned an error.",
                [this.apiKey],
              );
              finish(new Error(detail));
              return;
            }

            const eventType = message.event_type || data?.event_type;
            if (
              String(type).toLowerCase() === "event"
              && ["final", "completion", "completed", "done", "flush_done", "synthesis_complete"].includes(String(eventType || type).toLowerCase())
            ) {
              if (!receivedAudio) {
                finish(new Error("Sarvam TTS completed without returning audio."));
                return;
              }
              onAudioChunk({
                chunkIndex: chunkIndex++,
                text,
                isFinal: true,
                audioBase64: Buffer.concat(audioParts).toString("base64"),
                format: this.codec,
                sampleRate: this.sampleRate,
              });
              if (!isCurrent()) return;
              if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "synthesis complete");
              finish();
            }
          } catch (error: any) {
            finish(new Error(`Invalid Sarvam TTS response: ${error.message}`));
          }
        });

        socket.on("error", (error) => {
          if (isCurrent()) finish(new Error(`Sarvam TTS WebSocket error: ${providerTransportError(error, [this.apiKey])}`));
        });
        socket.on("close", (code, reason) => {
          if (!isCurrent()) return;
          if (controller.signal.aborted) return finish();
          finish(new Error(`Sarvam TTS closed before completion (${code}: ${safeProviderDetail(reason.toString(), [this.apiKey])}).`));
        });
      });

      if (controller.signal.aborted) {
        this.settleOrRelease(reservation, requestId, characterCount, requestStarted, "aborted", receivedAudio);
        return;
      }
      this.budgetSettle(reservation, characterCount, { requestId, receivedAudio, outcome: "completed" });
      if (this.activeAbortController === controller) {
        this.setStatus({ requested: "Sarvam", active: "Sarvam", state: "ready" });
      }
    } catch (error: any) {
      if (controller.signal.aborted) {
        this.settleOrRelease(reservation, requestId, characterCount, requestStarted, "aborted", receivedAudio);
        return;
      }
      const detail = safeProviderDetail(error?.message || "Sarvam TTS request failed.", [this.apiKey]);
      this.failOrSettle(reservation, requestId, characterCount, requestStarted, detail, receivedAudio);
      if (this.activeAbortController === controller) {
        this.setStatus({ requested: "Sarvam", active: "Unavailable", state: "error", detail });
      }
      throw new Error(detail);
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.activeAbortController === controller) this.activeAbortController = null;
    }
  }

  abort(): void {
    this.activeAbortController?.abort();
    if (this.activeSocket && this.activeSocket.readyState < WebSocket.CLOSING) this.activeSocket.terminate();
    this.activeSocket = null;
    this.activeAbortController = null;
  }

  private reserveBudget(requestId: string, characters: number): UsageReservation | undefined {
    const rate = Math.max(0, Number(process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS || 0));
    try {
      return this.budget.reserve({
        requestId,
        model: this.model,
        kind: "tts_characters",
        estimatedCostInr: rate * Math.max(0, characters) / 1000,
        metadata: { provider: "sarvam", costBasis: "estimate", providerUsageReported: false },
      });
    } catch (error: any) {
      throw new Error(error.message);
    }
  }

  private budgetSettle(reservation: UsageReservation | undefined, characters: number, metadata: Record<string, unknown>): void {
    if (!reservation) return;
    const rate = Math.max(0, Number(process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS || 0));
    this.budget.settle(reservation, {
      quantity: characters,
      actualCostInr: rate * Math.max(0, characters) / 1000,
      metadata: { ...metadata, costBasis: "estimate", providerUsageReported: false },
    });
  }

  private settleOrRelease(
    reservation: UsageReservation | undefined,
    requestId: string,
    characters: number,
    requestStarted: boolean,
    reason: string,
    receivedAudio: boolean,
  ): void {
    if (!reservation) return;
    if (requestStarted || receivedAudio) {
      this.budgetSettle(reservation, characters, {
        requestId,
        outcome: "cancelled",
        reason,
        receivedAudio,
        potentiallyBillable: true,
      });
    } else {
      this.budget.release(reservation, { requestId, reason });
    }
  }

  private failOrSettle(
    reservation: UsageReservation | undefined,
    requestId: string,
    characters: number,
    requestStarted: boolean,
    error: string,
    receivedAudio: boolean,
  ): void {
    if (!reservation) return;
    if (requestStarted || receivedAudio) {
      this.budgetSettle(reservation, characters, {
        requestId,
        outcome: "failed",
        error,
        receivedAudio,
        potentiallyBillable: true,
      });
    } else {
      this.budget.fail(reservation, error, { requestId, receivedAudio, potentiallyBillable: false });
    }
  }

  private isValidAudioBase64(value: string): boolean {
    const normalized = value.replace(/\s+/g, "");
    if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return false;
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length === 0) return false;
    return bytes.toString("base64").replace(/=+$/, "") === normalized.replace(/=+$/, "");
  }
}
