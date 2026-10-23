import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { AsrAdapter, ProviderRuntimeStatus } from "./types.js";
import { diagnoseUpgradeRejection, providerTransportError, safeProviderDetail } from "../diagnostics/providerDiagnostics.js";

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

  constructor(options: { apiKey?: string; url?: string; model?: string; language?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.SARVAM_API_KEY ?? "";
    this.url = options.url ?? "wss://api.sarvam.ai/speech-to-text-realtime/ws";
    this.model = options.model || process.env.SARVAM_ASR_MODEL || "saaras:v3-realtime";
    this.language = options.language || process.env.SARVAM_ASR_LANGUAGE || "auto";
  }

  connect(handlers: Parameters<AsrAdapter["connect"]>[0]): void {
    this.handlers = handlers;
    if (!this.apiKey.trim()) {
      this.setStatus("error", "Set SARVAM_API_KEY in .env and restart Vanessa.");
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
    const turnId = `sarvam:${randomUUID()}`;
    const url = new URL(this.url);
    for (const [key, value] of Object.entries({ model: this.model, language_code: this.language,
      stream_type: "fast", mode: "transcribe", endpointing: "manual", encoding: "linear16", sample_rate: "16000" })) {
      url.searchParams.set(key, value);
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
    const fail = (error: Error) => {
      console.error(`[Sarvam ASR] ${safeProviderDetail(error.message, [this.apiKey])}`);
      this.finishConnect?.(error);
      this.deactivateStream();
      this.setStatus("error", safeProviderDetail(error.message, [this.apiKey]));
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { "Api-Subscription-Key": this.apiKey }, handshakeTimeout: 10000 });
    } catch (error) { fail(new Error(providerTransportError(error as Error, [this.apiKey]))); return promise; }
    this.ws = ws;
    this.timer = setTimeout(() => fail(new Error("Sarvam session readiness timed out.")), 10000);
    diagnoseUpgradeRejection(ws, "ASR", this.apiKey, (error) => {
      if (this.ws === ws) fail(error);
    }, "Sarvam");
    ws.on("error", (error) => {
      if (this.ws === ws) fail(new Error(providerTransportError(error, [this.apiKey])));
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      fail(new Error(`Sarvam disconnected before transcript delivery (code ${code}). Check credentials, credits and realtime model access.`));
    });
    ws.on("message", (raw) => {
      if (this.ws !== ws || !this.active) return;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === "session.begin" && !this.ready) {
        clearTimeout(this.timer);
        this.ready = true;
        ws.send(JSON.stringify({ event: "speech_start" }));
        for (const audio of this.queued) this.sendFrame(audio);
        this.queued = []; this.queuedBytes = 0;
        this.setStatus("ready");
        console.log(`[Sarvam ASR] session ready elapsedMs=${Date.now() - started}`);
        this.finishConnect?.();
        if (this.finalizing) this.finishTurn();
        else this.timer = setTimeout(() => this.finalizeTurn(), durationMs);
      } else if (msg.event === "error") {
        fail(new Error(`Sarvam ${msg.code || "error"}: ${safeProviderDetail(msg.message, [this.apiKey])}`));
      } else if ((msg.event === "transcript.partial" || msg.event === "transcript.final") && typeof msg.text === "string") {
        const text = msg.text.trim();
        if (!text || this.delivered) return;
        const language = msg.language || (this.language === "auto" ? "en" : this.language);
        if (msg.event === "transcript.partial") this.handlers?.onPartial({ text, language, isFinal: false });
        else {
          this.delivered = true;
          console.log(`[Sarvam ASR] transcript committed characters=${text.length} elapsedMs=${Date.now() - started}`);
          this.deactivateStream();
          this.handlers?.onFinal({ text, language, isFinal: true, turnId });
        }
      }
    });
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
    this.ws?.send(JSON.stringify({ event: "speech_end" }));
    this.timer = setTimeout(() => {
      this.deactivateStream();
      this.setStatus("error", "Sarvam returned no final transcript within 10 seconds. Activate the microphone and retry.");
    }, 10000);
  }
  deactivateStream(): void {
    clearTimeout(this.timer);
    this.finishConnect?.(new Error("Sarvam capture cancelled during connection."));
    const ws = this.ws;
    this.ws = undefined;
    this.active = false; this.ready = false;
    this.queued = []; this.queuedBytes = 0;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "end" }));
      ws.close();
    } else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    this.setStatus("idle");
  }
  close(): void { this.deactivateStream(); }
}
