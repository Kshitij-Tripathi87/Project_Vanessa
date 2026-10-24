import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { UsageBudget, type UsageReservation } from "@vanessa/shared";
import type { AsrAdapter, ProviderRuntimeStatus } from "./types.js";
import { diagnoseUpgradeRejection, providerTransportError, safeProviderDetail } from "../diagnostics/providerDiagnostics.js";
import { getVoiceUsageBudget } from "../usageBudget.js";

export class SarvamAsrAdapter implements AsrAdapter {
  name = "sarvam";
  // Reuse Vanessa's 650ms silence detector and explicit PTT finalize control.
  usesServerTurnDetection = false;
  private handlers?: Parameters<AsrAdapter["connect"]>[0];
  private ws?: WebSocket;
  private ready = false;
  private active = false;
  private finalizing = false;
  private delivered = false;
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private timer?: NodeJS.Timeout;
  private finishConnect?: (error?: Error) => void;
  private connecting?: Promise<void>;
  private status: ProviderRuntimeStatus = { requested: "Sarvam", active: "Sarvam", state: "idle" };
  private statusHandler?: (status: ProviderRuntimeStatus) => void;
  private apiKey: string;
  private url: string;
  private model: string;
  private language: string;
  private keyterms: string[];
  private readonly budget: UsageBudget;
  private usageReservation?: UsageReservation;
  private usageRequestId?: string;
  private turnStartedAt = 0;
  private turnStarted = false;
  private keepalive?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;

  constructor(options: {
    apiKey?: string;
    url?: string;
    model?: string;
    language?: string;
    keyterms?: string[];
    budget?: UsageBudget;
    maxReconnectAttempts?: number;
    reconnectBaseDelayMs?: number;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env.SARVAM_API_KEY ?? "";
    this.url = options.url ?? process.env.SARVAM_ASR_URL ?? "wss://api.sarvam.ai/speech-to-text-realtime/ws";
    this.model = options.model || process.env.SARVAM_ASR_MODEL || "saaras:v3-realtime";
    this.language = options.language || process.env.SARVAM_ASR_LANGUAGE || "auto";
    this.keyterms = options.keyterms || (process.env.SARVAM_ASR_KEYTERMS || "").split(",").map((term) => term.trim()).filter(Boolean);
    this.budget = options.budget ?? getVoiceUsageBudget();
    this.maxReconnectAttempts = Math.max(0, Math.floor(Number(options.maxReconnectAttempts ?? process.env.SARVAM_ASR_MAX_RECONNECT_ATTEMPTS ?? 2)));
    this.reconnectBaseDelayMs = Math.max(50, Number(options.reconnectBaseDelayMs ?? process.env.SARVAM_ASR_RECONNECT_BASE_DELAY_MS ?? 250));
  }

  connect(handlers: Parameters<AsrAdapter["connect"]>[0]): void {
    this.handlers = handlers;
    if (!this.apiKey.trim() || /placeholder|your[_-].*(key|model)|replace[-_ ]with/i.test(this.apiKey)) {
      this.setStatus("error", "Set SARVAM_API_KEY in .env and restart Vanessa.");
      throw new Error(this.status.detail);
    }
    if (!this.model.trim() || /placeholder|your[_-].*model|replace[-_ ]with/i.test(this.model)) {
      this.setStatus("error", "Set SARVAM_ASR_MODEL in .env and restart Vanessa.");
      throw new Error(this.status.detail);
    }
  }

  getProviderStatus(): ProviderRuntimeStatus { return { ...this.status }; }
  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    this.statusHandler = handler;
    handler(this.getProviderStatus());
  }
  private setStatus(state: ProviderRuntimeStatus["state"], detail?: string): void {
    this.status = { requested: "Sarvam", active: state === "error" ? "Unavailable" : "Sarvam", state, detail };
    this.statusHandler?.(this.getProviderStatus());
  }

  activateStream(durationMs = 25000): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.active && this.ready && !this.finalizing) return Promise.resolve();
    this.deactivateStream();
    this.active = true;
    this.finalizing = false;
    this.delivered = false;
    this.turnStarted = false;
    this.turnStartedAt = 0;
    this.reconnectAttempts = 0;
    const turnId = `sarvam:${randomUUID()}`;
    const url = new URL(this.url);
    for (const [key, value] of Object.entries({ model: this.model, language_code: this.language,
      stream_type: "fast", mode: "transcribe", endpointing: "manual", encoding: "linear16", sample_rate: "16000" })) {
      url.searchParams.set(key, value);
    }
    if (this.model === "saaras:v4" && this.keyterms.length > 0) {
      url.searchParams.set("keyterms", JSON.stringify(this.keyterms));
    }
    this.usageRequestId = turnId;
    const estimatedSeconds = Math.max(0, durationMs / 1000);
    try {
      this.usageReservation = this.budget.reserve({
        requestId: turnId,
        model: this.model,
        kind: "stt_audio_seconds",
        estimatedCostInr: this.costInr(estimatedSeconds),
        metadata: { provider: "sarvam", language: this.language },
      });
    } catch (error: any) {
      this.active = false;
      this.setStatus("error", error.message);
      throw error;
    }
    const started = Date.now();
    console.log(`[Sarvam ASR] connecting model=${this.model} language=${this.language} sampleRate=16000`);
    this.setStatus("connecting");
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.connecting = promise;
    let settled = false;
    this.finishConnect = (error) => {
      if (settled) return;
      settled = true;
      this.connecting = undefined;
      this.finishConnect = undefined;
      if (error) reject(error); else resolve();
    };
    const isRetryable = (error: Error): boolean => {
      if (/\bfatal\b|HTTP (401|402|403|404|422)\b/i.test(error.message)) return false;
      const closeCode = error.message.match(/code\s+(\d{3,4})/i)?.[1];
      if (closeCode && (closeCode === "1003" || closeCode === "4000" || closeCode.startsWith("4"))) return false;
      return true;
    };
    const cleanupSocket = (socket?: WebSocket) => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = undefined;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.terminate();
      if (this.ws === socket) this.ws = undefined;
      this.ready = false;
    };
    const fail = (socket: WebSocket | undefined, error: Error) => {
      if (socket && this.ws !== socket) return;
      const detail = safeProviderDetail(error.message, [this.apiKey]);
      console.error(`[Sarvam ASR] ${detail}`);
      cleanupSocket(socket);

      if (this.active && !settled && isRetryable(error) && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectBaseDelayMs * (2 ** (this.reconnectAttempts - 1));
        this.setStatus("connecting", `Reconnecting to Sarvam ASR (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}).`);
        this.reconnectTimer = setTimeout(() => openSocket(this.reconnectAttempts), delay);
        return;
      }

      this.active = false;
      if (!settled) {
        settled = true;
        this.connecting = undefined;
        this.finishConnect = undefined;
        reject(error);
      }
      if (this.usageReservation) {
        this.budget.fail(this.usageReservation, detail, { requestId: this.usageRequestId });
        this.usageReservation = undefined;
      }
      this.setStatus("error", detail);
    };
    const openSocket = (attempt: number): void => {
      if (!this.active || settled) return;
      const attemptUrl = new URL(url.toString());
      let ws: WebSocket;
      try {
        ws = new WebSocket(attemptUrl, { headers: { "Api-Subscription-Key": this.apiKey }, handshakeTimeout: 10000 });
      } catch (error) {
        fail(undefined, new Error(providerTransportError(error as Error, [this.apiKey])));
        return;
      }
      this.ws = ws;
      let socketFailed = false;
      const failSocket = (error: Error) => {
        if (socketFailed) return;
        socketFailed = true;
        fail(ws, error);
      };
      this.timer = setTimeout(() => failSocket(new Error("Sarvam session readiness timed out.")), 10000);
      diagnoseUpgradeRejection(ws, "ASR", this.apiKey, failSocket, "Sarvam");
      ws.on("error", (error) => failSocket(new Error(providerTransportError(error, [this.apiKey]))));
      ws.on("close", (code) => {
        if (this.ws !== ws || socketFailed) return;
        failSocket(new Error(`Sarvam disconnected before transcript delivery (code ${code}). Check credentials, credits and realtime model access.`));
      });
      ws.on("message", (raw) => {
        if (this.ws !== ws || !this.active) return;
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.event === "session.begin" && !this.ready) {
          clearTimeout(this.timer);
          this.timer = undefined;
          this.ready = true;
          for (const audio of this.queued) this.sendFrame(audio);
          this.queued = []; this.queuedBytes = 0;
          this.keepalive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
          }, 15000);
          this.setStatus("ready");
          console.log(`[Sarvam ASR] session ready elapsedMs=${Date.now() - started} attempt=${attempt + 1}`);
          this.finishConnect?.();
          if (this.finalizing) this.finishTurn();
          else this.timer = setTimeout(() => this.finalizeTurn(), durationMs);
        } else if (msg.event === "session.end") {
          const duration = Number(msg.audio_duration_s ?? msg.data?.audio_duration_s ?? msg.data?.audioDurationS);
          if (Number.isFinite(duration) && duration >= 0) this.settleUsage(duration, { source: "session.end" });
        } else if (msg.event === "error") {
          failSocket(new Error(`Sarvam ${msg.is_fatal ? "fatal " : ""}${msg.code || "error"}: ${safeProviderDetail(msg.message, [this.apiKey])}`));
        } else if ((msg.event === "transcript.partial" || msg.event === "transcript.final") && typeof msg.text === "string") {
          const text = msg.text.trim();
          if (!text || this.delivered) return;
          const language = msg.language || (this.language === "auto" ? "en" : this.language);
          if (msg.event === "transcript.partial") this.handlers?.onPartial({ text, language, isFinal: false });
          else {
            this.delivered = true;
            console.log(`[Sarvam ASR] transcript committed characters=${text.length} elapsedMs=${Date.now() - started}`);
            this.settleUsage(this.turnStarted ? (Date.now() - this.turnStartedAt) / 1000 : 0, { source: "transcript.final" });
            this.deactivateStream();
            this.handlers?.onFinal({ text, language, isFinal: true, turnId });
          }
        }
      });
    };
    openSocket(0);
    return promise;
  }

  sendAudioChunk(pcm: Int16Array): void {
    if (!this.active || this.finalizing) return;
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.ready) this.sendFrame(audio);
    else {
      this.queued.push(Buffer.from(audio)); this.queuedBytes += audio.length;
      // At most 5 seconds of 16kHz mono PCM while connecting.
      while (this.queuedBytes > 160000) this.queuedBytes -= this.queued.shift()!.length;
    }
  }
  private sendFrame(audio: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (!this.turnStarted) {
        this.turnStarted = true;
        this.turnStartedAt = Date.now();
        this.ws.send(JSON.stringify({ event: "speech_start" }));
      }
      this.ws.send(JSON.stringify({ event: "audio_input", audio: audio.toString("base64") }));
    }
  }
  finalizeTurn(): void {
    if (!this.active || this.finalizing) return;
    this.finalizing = true;
    if (this.ready) this.finishTurn();
  }
  private finishTurn(): void {
    clearTimeout(this.timer);
    console.log("[Sarvam ASR] finalizing utterance");
    if (!this.turnStarted) {
      this.turnStarted = true;
      this.turnStartedAt = Date.now();
      this.ws?.send(JSON.stringify({ event: "speech_start" }));
    }
    this.ws?.send(JSON.stringify({ event: "speech_end" }));
    this.timer = setTimeout(() => {
      this.deactivateStream();
      this.setStatus("error", "Sarvam returned no final transcript within 10 seconds. Activate the microphone and retry.");
    }, 10000);
  }
  deactivateStream(): void {
    clearTimeout(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    if (this.usageReservation) {
      this.budget.release(this.usageReservation, { reason: "capture_closed_before_usage_reconciliation" });
      this.usageReservation = undefined;
    }
    this.usageRequestId = undefined;
    this.finishConnect?.(new Error("Sarvam capture cancelled during connection."));
    const ws = this.ws;
    this.ws = undefined;
    this.active = false; this.ready = false;
    this.turnStarted = false;
    this.turnStartedAt = 0;
    this.queued = []; this.queuedBytes = 0;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "end" }));
      ws.close();
    } else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    this.setStatus("idle");
  }
  close(): void { this.deactivateStream(); }

  private settleUsage(audioSeconds: number, metadata: Record<string, unknown>): void {
    if (!this.usageReservation) return;
    const reservation = this.usageReservation;
    this.usageReservation = undefined;
    this.budget.settle(reservation, {
      quantity: Math.max(0, audioSeconds),
      actualCostInr: this.costInr(audioSeconds),
      metadata: { requestId: this.usageRequestId, ...metadata },
    });
  }

  private costInr(audioSeconds: number): number {
    return Math.max(0, Number(process.env.SARVAM_ASR_INR_PER_AUDIO_SECOND || 0)) * Math.max(0, audioSeconds);
  }
}
