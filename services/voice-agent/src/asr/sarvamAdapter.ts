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
  private connectionTimer?: NodeJS.Timeout;
  private finishConnect?: (error?: Error) => void;
  private connecting?: Promise<void>;
  private lifecycleId = 0;
  private sendFailure?: (error: Error) => void;
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
  private turnStarted = false;
  private sentBytes = 0;
  private maxAudioBytes = 800000;
  private keepalive?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly finalizationTimeoutMs: number;

  constructor(options: {
    apiKey?: string;
    url?: string;
    model?: string;
    language?: string;
    keyterms?: string[];
    budget?: UsageBudget;
    maxReconnectAttempts?: number;
    reconnectBaseDelayMs?: number;
    connectionTimeoutMs?: number;
    finalizationTimeoutMs?: number;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env.SARVAM_API_KEY ?? "";
    this.url = options.url ?? process.env.SARVAM_ASR_URL ?? "wss://api.sarvam.ai/speech-to-text-realtime/ws";
    this.model = options.model || process.env.SARVAM_ASR_MODEL || "saaras:v3-realtime";
    this.language = options.language || process.env.SARVAM_ASR_LANGUAGE || "auto";
    this.keyterms = options.keyterms || (process.env.SARVAM_ASR_KEYTERMS || "").split(",").map((term) => term.trim()).filter(Boolean);
    this.budget = options.budget ?? getVoiceUsageBudget();
    const maxReconnectAttempts = Number(options.maxReconnectAttempts ?? process.env.SARVAM_ASR_MAX_RECONNECT_ATTEMPTS ?? 2);
    const reconnectBaseDelayMs = Number(options.reconnectBaseDelayMs ?? process.env.SARVAM_ASR_RECONNECT_BASE_DELAY_MS ?? 250);
    const connectionTimeoutMs = Number(options.connectionTimeoutMs ?? process.env.SARVAM_ASR_CONNECTION_TIMEOUT_MS ?? 10000);
    const finalizationTimeoutMs = Number(options.finalizationTimeoutMs ?? process.env.SARVAM_ASR_FINALIZATION_TIMEOUT_MS ?? 10000);
    this.maxReconnectAttempts = Number.isFinite(maxReconnectAttempts) ? Math.max(0, Math.floor(maxReconnectAttempts)) : 2;
    this.reconnectBaseDelayMs = Number.isFinite(reconnectBaseDelayMs) ? Math.max(50, reconnectBaseDelayMs) : 250;
    this.connectionTimeoutMs = Number.isFinite(connectionTimeoutMs) ? Math.max(1, connectionTimeoutMs) : 10000;
    this.finalizationTimeoutMs = Number.isFinite(finalizationTimeoutMs) ? Math.max(1, finalizationTimeoutMs) : 10000;
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
    const lifecycleId = this.lifecycleId;
    this.active = true;
    this.finalizing = false;
    this.delivered = false;
    this.turnStarted = false;
    this.sentBytes = 0;
    this.reconnectAttempts = 0;
    const turnId = `sarvam:${randomUUID()}`;
    const turnTimeoutMs = Number.isFinite(durationMs) ? Math.max(1, durationMs) : 25000;
    this.maxAudioBytes = Math.floor(turnTimeoutMs * 32);
    let url: URL;
    try {
      url = new URL(this.url);
    } catch (error) {
      this.active = false;
      this.setStatus("error", safeProviderDetail((error as Error).message, [this.apiKey]));
      throw error;
    }
    for (const [key, value] of Object.entries({ model: this.model, language_code: this.language,
      stream_type: "fast", mode: "transcribe", endpointing: "manual", encoding: "linear16", sample_rate: "16000" })) {
      url.searchParams.set(key, value);
    }
    if (this.model === "saaras:v4" && this.keyterms.length > 0) {
      url.searchParams.set("keyterms", JSON.stringify(this.keyterms));
    }
    this.usageRequestId = turnId;
    const estimatedSeconds = Math.max(0, turnTimeoutMs / 1000);
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
    const isCurrent = (): boolean => this.active && this.lifecycleId === lifecycleId;
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
      if (socket && this.ws !== socket) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = undefined;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.terminate();
      if (this.ws === socket) this.ws = undefined;
      this.ready = false;
    };
    const fail = (socket: WebSocket | undefined, error: Error) => {
      if (!isCurrent() || (socket && this.ws !== socket)) return;
      const detail = safeProviderDetail(error.message, [this.apiKey]);
      console.error(`[Sarvam ASR] ${detail}`);
      cleanupSocket(socket);

      if (this.active && !settled && isRetryable(error) && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectBaseDelayMs * (2 ** (this.reconnectAttempts - 1));
        this.setStatus("connecting", `Reconnecting to Sarvam ASR (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}).`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          if (isCurrent() && !settled) openSocket(this.reconnectAttempts);
        }, delay);
        return;
      }

      this.active = false;
      this.finalizing = false;
      this.sendFailure = undefined;
      if (!settled) {
        settled = true;
        this.connecting = undefined;
        this.finishConnect = undefined;
        reject(error);
      }
      if (this.usageReservation) {
        if (this.sentBytes) this.settleUsage(this.sentBytes / 32000, { outcome: "failed", potentiallyBillable: true, source: "sent_pcm" });
        else this.budget.fail(this.usageReservation, detail, { requestId: this.usageRequestId });
        this.usageReservation = undefined;
      }
      this.setStatus("error", detail);
    };
    const openSocket = (attempt: number): void => {
      if (!isCurrent() || settled) return;
      const attemptUrl = new URL(url.toString());
      let ws: WebSocket;
      try {
        ws = new WebSocket(attemptUrl, { headers: { "Api-Subscription-Key": this.apiKey }, handshakeTimeout: this.connectionTimeoutMs });
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
      this.connectionTimer = setTimeout(() => failSocket(new Error("Sarvam session readiness timed out.")), this.connectionTimeoutMs);
      diagnoseUpgradeRejection(ws, "ASR", this.apiKey, failSocket, "Sarvam");
      ws.on("error", (error) => failSocket(new Error(providerTransportError(error, [this.apiKey]))));
      ws.on("close", (code) => {
        if (!isCurrent() || this.ws !== ws || socketFailed) return;
        failSocket(new Error(`Sarvam disconnected before transcript delivery (code ${code}). Check credentials, credits and realtime model access.`));
      });
      ws.on("message", (raw) => {
        if (!isCurrent() || this.ws !== ws) return;
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.event !== "string") return;
        if (msg.event === "session.begin" && !this.ready) {
          if (this.connectionTimer) clearTimeout(this.connectionTimer);
          this.connectionTimer = undefined;
          this.ready = true;
          this.sendFailure = (error) => failSocket(error);
          for (const audio of this.queued) {
            if (!isCurrent()) return;
            this.sendFrame(audio);
          }
          this.queued = []; this.queuedBytes = 0;
          this.keepalive = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            try { ws.ping(); } catch (error) { failSocket(new Error(providerTransportError(error as Error, [this.apiKey]))); }
          }, 15000);
          this.setStatus("ready");
          console.log(`[Sarvam ASR] session ready elapsedMs=${Date.now() - started} attempt=${attempt + 1}`);
          this.finishConnect?.();
          if (this.finalizing) this.finishTurn();
          else if (isCurrent()) this.timer = setTimeout(() => {
            if (isCurrent()) this.finalizeTurn();
          }, turnTimeoutMs);
        } else if (msg.event === "session.end") {
          const duration = Number(msg.audio_duration_s ?? msg.data?.audio_duration_s ?? msg.data?.audioDurationS);
          if (Number.isFinite(duration) && duration >= 0) this.settleUsage(duration, { source: "session.end" });
        } else if (msg.event === "error") {
          const code = typeof msg.code === "string" || typeof msg.code === "number" ? String(msg.code) : "error";
          const message = typeof msg.message === "string" ? msg.message : "Provider reported an error.";
          failSocket(new Error(`Sarvam ${msg.is_fatal === true ? "fatal " : ""}${code}: ${safeProviderDetail(message, [this.apiKey])}`));
        } else if ((msg.event === "transcript.partial" || msg.event === "transcript.final") && typeof msg.text === "string") {
          const text = msg.text.trim();
          if (!text || this.delivered) return;
          if (msg.language !== undefined && typeof msg.language !== "string") return;
          const language = typeof msg.language === "string" && msg.language.trim()
            ? msg.language.trim()
            : (this.language === "auto" ? "en" : this.language);
          if (msg.event === "transcript.partial") this.handlers?.onPartial({ text, language, isFinal: false });
          else {
            this.delivered = true;
            console.log(`[Sarvam ASR] transcript committed characters=${text.length} elapsedMs=${Date.now() - started}`);
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
    if (!this.active || this.finalizing || !(pcm instanceof Int16Array) || pcm.byteLength <= 0) return;
    let audio: Buffer;
    try {
      audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    } catch {
      return;
    }
    if (this.ready) this.sendFrame(audio);
    else {
      this.queued.push(Buffer.from(audio)); this.queuedBytes += audio.length;
      // At most 5 seconds of 16kHz mono PCM while connecting.
      while (this.queuedBytes > 160000) this.queuedBytes -= this.queued.shift()!.length;
    }
  }
  private sendFrame(audio: Buffer): void {
    const ws = this.ws;
    if (!this.active || !this.ready || !audio.length || ws?.readyState !== WebSocket.OPEN) return;
    if (this.sentBytes + audio.length > this.maxAudioBytes) { this.finalizeTurn(); return; }
    try {
      if (!this.turnStarted) {
        this.turnStarted = true;
        ws.send(JSON.stringify({ event: "speech_start" }));
      }
      ws.send(JSON.stringify({ event: "audio_input", audio: audio.toString("base64") }));
      this.sentBytes += audio.length;
    } catch (error) {
      this.sendFailure?.(new Error(providerTransportError(error as Error, [this.apiKey])));
    }
  }
  finalizeTurn(): void {
    if (!this.active || this.finalizing) return;
    this.finalizing = true;
    if (this.ready) this.finishTurn();
  }
  private finishTurn(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    console.log("[Sarvam ASR] finalizing utterance");
    const ws = this.ws;
    if (!this.active || !this.finalizing || !this.ready || ws?.readyState !== WebSocket.OPEN) {
      if (this.active && this.finalizing) this.sendFailure?.(new Error("Sarvam socket closed before finalization."));
      return;
    }
    try {
      if (!this.turnStarted) {
        this.turnStarted = true;
        ws.send(JSON.stringify({ event: "speech_start" }));
      }
      ws.send(JSON.stringify({ event: "speech_end" }));
      const lifecycleId = this.lifecycleId;
      this.timer = setTimeout(() => {
        if (!this.active || this.lifecycleId !== lifecycleId || !this.finalizing) return;
        this.deactivateStream();
        this.setStatus("error", `Sarvam returned no final transcript within ${Math.ceil(this.finalizationTimeoutMs / 1000)} seconds. Activate the microphone and retry.`);
      }, this.finalizationTimeoutMs);
    } catch (error) {
      this.sendFailure?.(new Error(providerTransportError(error as Error, [this.apiKey])));
    }
  }
  deactivateStream(): void {
    this.lifecycleId++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    const reservation = this.usageReservation;
    const seconds = this.sentBytes / 32000;
    this.usageReservation = undefined;
    this.usageRequestId = undefined;
    const finishConnect = this.finishConnect;
    this.finishConnect = undefined;
    finishConnect?.(new Error("Sarvam capture cancelled during connection."));
    this.sendFailure = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.active = false; this.ready = false; this.finalizing = false;
    this.turnStarted = false;
    this.queued = []; this.queuedBytes = 0;
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        // Allow a short shutdown grace period for authoritative billed duration.
        let reconciled = false;
        const reconcile = (quantity: number, reported: boolean) => {
          if (reconciled) return;
          reconciled = true;
          clearTimeout(grace);
          if (reservation) this.budget.settle(reservation, {
            quantity, actualCostInr: this.costInr(quantity),
            metadata: { costBasis: "estimate", providerUsageReported: reported, source: reported ? "session.end" : "sent_pcm", potentiallyBillable: seconds > 0 },
          });
          ws.close();
        };
        const grace = setTimeout(() => reconcile(seconds, false), 500);
        ws.on("message", raw => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg?.event === "session.end" && typeof msg.audio_duration_s === "number" && Number.isFinite(msg.audio_duration_s) && msg.audio_duration_s >= 0) reconcile(msg.audio_duration_s, true);
          } catch { /* malformed shutdown metadata uses local estimate */ }
        });
        ws.once("close", () => reconcile(seconds, false));
        ws.send(JSON.stringify({ event: "end" }));
      } catch { ws.terminate(); }
    } else {
      if (reservation) {
        if (seconds > 0) this.budget.settle(reservation, { quantity: seconds, actualCostInr: this.costInr(seconds), metadata: { costBasis: "estimate", providerUsageReported: false, potentiallyBillable: true } });
        else this.budget.release(reservation, { reason: "no_audio_sent" });
      }
      if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    }
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
      metadata: { requestId: this.usageRequestId, costBasis: "estimate", providerUsageReported: metadata.source === "session.end", ...metadata },
    });
  }

  private costInr(audioSeconds: number): number {
    return Math.max(0, Number(process.env.SARVAM_ASR_INR_PER_AUDIO_SECOND || 0)) * Math.max(0, audioSeconds);
  }
}
