import type { AudioChunk } from "../audio/capture.js";
import { TurnDetector } from "../audio/turnDetector.js";
import { SileroVadDetector } from "../audio/vad.js";
import { SpeechAudioGate } from "../audio/speechGate.js";
import { BargeInDetector } from "./bargeIn.js";
import { WakeWordDetector } from "./wakeWord.js";
import { AsrAdapter, ProviderRuntimeStatus } from "../asr/types.js";
import { VoiceAdapter } from "../asr/voiceAdapter.js";
import { SarvamAsrAdapter } from "../asr/sarvamAdapter.js";
import { FishAsrAdapter } from "../asr/fishAdapter.js";
import { ElevenLabsAsrAdapter } from "../asr/elevenlabsAdapter.js";
import { VoiceTtsAdapter } from "../tts/types.js";
import { ElevenLabsTtsAdapter } from "../tts/elevenlabsTts.js";
import { FishTtsAdapter } from "../tts/fishTts.js";
import { SarvamTtsAdapter } from "../tts/sarvamTts.js";
import { orchestratorClient } from "../orchestratorClient.js";
import { ConversationTurn } from "@vanessa/shared";
import { createHash, randomUUID } from "node:crypto";
import { safeProviderDetail } from "../diagnostics/providerDiagnostics.js";

export type SessionState =
  | "idle"
  | "listening"
  | "thinking"
  | "executing"
  | "responding"
  | "interrupted";

export interface VoiceSessionHandlers {
  onStateChange?: (state: SessionState) => void;
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string, requestId: string) => void;
  onAudioChunkOut?: (chunk: { text: string; audioBase64?: string; format?: "mp3" | "wav" | "pcm_s16le"; sampleRate?: number; fallbackSpeech?: boolean; isFinal: boolean }) => void;
  onTtsUnavailable?: (detail: string) => void;
  onHudUpdate?: (hud: { state: SessionState; transcript: string; plan?: any }) => void;
  onProviderStatus?: (status: VoiceProviderInfo) => void;
  onError?: (detail: string) => void;
}

export interface VoiceProviderInfo {
  asr: ProviderRuntimeStatus;
  tts: ProviderRuntimeStatus;
}

export class VanessaVoiceSession {
  private turnDetector = new TurnDetector();
  private vad = new SileroVadDetector();
  private readonly sarvamSpeechGate = new SpeechAudioGate();
  private bargeIn = new BargeInDetector();
  private wakeWord = new WakeWordDetector();
  private asr: AsrAdapter;
  private tts: VoiceTtsAdapter;

  private state: SessionState = "idle";
  private partialTranscript = "";
  private isProcessing = false;
  private isSpeaking = false;
  private isAsrConnected = false;
  private asrConnectPromise?: Promise<void>;
  private sessionGeneration = 0;
  private handlers: VoiceSessionHandlers = {};
  private conversationContext: ConversationTurn[] = [];
  private processedTurnIds = new Set<string>();
  private queuedUtterances: Array<{ text: string; language: string }> = [];
  private requestController?: AbortController;
  private activeRequestId?: string;
  private captureAuthorized = false;
  private readonly client: Pick<typeof orchestratorClient, "executeCommand" | "cancelRequest">;

  constructor(options?: {
    asrProvider?: "voice" | "whisper" | "fish" | "elevenlabs" | "sarvam";
    ttsProvider?: "elevenlabs" | "fish" | "sarvam";
    handlers?: VoiceSessionHandlers;
    asr?: AsrAdapter;
    tts?: VoiceTtsAdapter;
    client?: Pick<typeof orchestratorClient, "executeCommand" | "cancelRequest">;
  }) {
    this.handlers = options?.handlers || {};
    this.client = options?.client || orchestratorClient;

    const asrType = String(options?.asrProvider || process.env.VOICE_ASR_PROVIDER || "fish").toLowerCase() as "voice" | "whisper" | "fish" | "elevenlabs" | "sarvam";
    if (asrType === "sarvam") {
      this.asr = new SarvamAsrAdapter();
    } else if (asrType === "fish") {
      this.asr = new FishAsrAdapter();
    } else if (asrType === "elevenlabs") {
      this.asr = new ElevenLabsAsrAdapter();
    } else {
      this.asr = new VoiceAdapter();
    }

    if (!options?.ttsProvider && !process.env.VOICE_TTS_PROVIDER && process.env.VOICE_PROVIDER) {
      console.warn("[VanessaVoiceSession] VOICE_PROVIDER is deprecated; use VOICE_TTS_PROVIDER.");
    }
    const ttsType = String(options?.ttsProvider || process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish").toLowerCase() as "elevenlabs" | "fish" | "sarvam";
    if (ttsType === "fish") {
      this.tts = new FishTtsAdapter();
    } else if (ttsType === "sarvam") {
      this.tts = new SarvamTtsAdapter();
    } else {
      this.tts = new ElevenLabsTtsAdapter();
    }
    console.log(`[VanessaVoiceSession] Initialized with ASR: "${this.asr.name || asrType}", TTS: "${ttsType}"`);
    this.asr = options?.asr || this.asr;
    this.tts = options?.tts || this.tts;
    this.asr.setStatusHandler?.((status) => {
      this.notifyProviderStatus();
      if (status.state === "error") {
        this.captureAuthorized = false;
        this.wakeWord.resetSession();
        this.isAsrConnected = false;
        this.asrConnectPromise = undefined;
        if (this.state === "listening") this.setState("idle");
        this.handlers.onError?.(safeProviderDetail(status.detail || "Speech recognition failed; activate the microphone to retry."));
      }
    });
    this.tts.setStatusHandler?.(() => this.notifyProviderStatus());
  }

  setHandlers(handlers: VoiceSessionHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  getProviderInfo(): VoiceProviderInfo {
    return {
      asr: this.asr.getProviderStatus?.() || {
        requested: (this.asr as any).name || (this.asr instanceof FishAsrAdapter ? "Fish Audio" : "Local Whisper"),
        active: (this.asr as any).name || (this.asr instanceof FishAsrAdapter ? "Fish Audio" : "Local Whisper"),
        state: "idle",
      },
      tts: this.tts.getProviderStatus?.() || {
        requested: this.tts instanceof FishTtsAdapter
          ? "Fish Audio"
          : this.tts instanceof SarvamTtsAdapter
            ? "Sarvam"
            : "ElevenLabs",
        active: this.tts instanceof FishTtsAdapter
          ? "Fish Audio"
          : this.tts instanceof SarvamTtsAdapter
            ? "Sarvam"
            : "ElevenLabs",
        state: "idle",
      },
    };
  }

  private notifyProviderStatus(): void {
    this.handlers.onProviderStatus?.(this.getProviderInfo());
  }

  async start(): Promise<void> {
    // Keep the ASR provider disconnected until an explicit push-to-talk action.
    this.setState("idle");
  }

  private async ensureAsrConnected(): Promise<void> {
    if (this.isAsrConnected) return;
    if (this.asrConnectPromise) return this.asrConnectPromise;

    this.asrConnectPromise = Promise.resolve().then(() => this.asr.connect({
      onPartial: (result) => {
        this.partialTranscript = result.text;
        this.handlers.onPartialTranscript?.(result.text);
      },
      onFinal: async (result) => {
        // Endpoint finalization may arrive after the capture window expires.
        // Authorization belongs to the activated turn, not provider latency.
        if (this.captureAuthorized) await this.handleFinalUtterance(result.text, result.language, result.turnId, true);
      },
    })).then(() => {
      this.isAsrConnected = true;
    }).catch((err) => {
      this.asrConnectPromise = undefined;
      throw err;
    });
    return this.asrConnectPromise;
  }

  async activateSession(durationMs = 25000): Promise<void> {
    if (this.isProcessing || this.isSpeaking) this.cancelCurrentTurn();
    const generation = this.sessionGeneration;
    this.captureAuthorized = true;
    this.sarvamSpeechGate.reset();
    this.wakeWord.touchActiveSession(durationMs);
    try {
      await this.ensureAsrConnected();
      if (generation !== this.sessionGeneration) return;
      await this.asr.activateStream?.(durationMs);
    } catch (err) {
      if (generation !== this.sessionGeneration) return;
      this.captureAuthorized = false;
      this.wakeWord.resetSession();
      this.asr.deactivateStream?.();
      this.setState("idle");
      throw err;
    }
    if (generation !== this.sessionGeneration) return;
    this.setState("listening");
    this.turnDetector.reset();
    console.log(`[VanessaVoiceSession] Session explicitly activated for ${durationMs}ms`);
  }

  private isFinalizingTurn = false;

  /**
   * Process incoming continuous 20ms audio chunk (320 samples @ 16kHz)
   */
  async processAudioChunk(chunk: AudioChunk): Promise<void> {
    // 1. VAD speech detection
    const vadRes = this.vad.processChunk(chunk.pcm);

    // 2. Hardware Barge-In check: interrupt Vanessa if user starts speaking
    if (this.bargeIn.shouldInterrupt(vadRes.isSpeech, this.isSpeaking)) {
      this.interrupt();
      return;
    }

    // 3. Forward only active speech and a short acoustic tail to Sarvam.
    // Manual endpointing is owned by Vanessa, so local gating prevents long
    // PTT silence from being sent upstream. Other providers keep their contract.
    if (this.wakeWord.isSessionActive()) {
      if (this.asr instanceof SarvamAsrAdapter) {
        for (const frame of this.sarvamSpeechGate.push(chunk.pcm, vadRes.isSpeech)) {
          this.asr.sendAudioChunk(frame);
        }
      } else {
        this.asr.sendAudioChunk(chunk.pcm);
      }
    }

    // 4. Turn detection: silence threshold + transcript completion
    const turnState = this.turnDetector.process({
      isSpeech: vadRes.isSpeech,
      partialTranscript: this.partialTranscript,
    });

    if (turnState === "complete" && !this.asr.usesServerTurnDetection && !this.isProcessing && !this.isFinalizingTurn) {
      this.isFinalizingTurn = true;
      console.log("[VanessaVoiceSession] Turn complete detected by VAD, finalizing turn...");
      this.finalizeTurn();
      setTimeout(() => {
        this.isFinalizingTurn = false;
      }, 1200);
    }
  }

  public finalizeTurn(): void {
    this.turnDetector.reset();
    this.asr.finalizeTurn?.();
  }

  async handleFinalUtterance(rawText: string, language = "en", turnId?: string, alreadyAccepted = false): Promise<void> {
    if (turnId && this.processedTurnIds.has(turnId)) return;
    if (turnId) {
      this.processedTurnIds.add(turnId);
      if (this.processedTurnIds.size > 32) {
        const oldest = this.processedTurnIds.values().next().value;
        if (oldest) this.processedTurnIds.delete(oldest);
      }
    }
    if (this.isProcessing) {
      // PTT or a barge-in explicitly opened this ASR window. Queue a couple of
      // follow-up turns while the current response/task finishes, then route
      // them through the same orchestrator path in order.
      const wakeCheck = this.wakeWord.processTranscript(rawText);
      if (wakeCheck.detected && wakeCheck.cleanedText.trim() && this.queuedUtterances.length < 2) {
        this.queuedUtterances.push({ text: wakeCheck.cleanedText, language });
      }
      return;
    }
    const generation = this.sessionGeneration;
    this.isFinalizingTurn = false;
    console.log(`[VanessaVoiceSession] Processing utterance characters=${rawText.length}`);
    this.isProcessing = true;

    // Filter wake word prefix
    const wakeCheck = alreadyAccepted ? { detected: true, cleanedText: rawText } : this.wakeWord.processTranscript(rawText);
    if (!wakeCheck.detected) {
      // Ignore transcripts unless an explicit push-to-talk activation is active.
      this.isProcessing = false;
      this.turnDetector.reset();
      return;
    }
    const command = wakeCheck.cleanedText;
    this.captureAuthorized = false;
    // A committed transcript ends the capture window. Close provider streaming
    // before planning/execution so command latency does not extend ASR billing.
    this.wakeWord.resetSession();
    this.asr.deactivateStream?.();

    if (!command.trim()) {
      if (wakeCheck.detected) {
        // User woke up Vanessa with "Hey Vanessa"
        this.setState("responding");
        const greeting = "Hey boss, how are you? How can I help you?";
        this.handlers.onHudUpdate?.({ state: "responding", transcript: greeting });
        try { await this.speak(greeting); }
        catch { if (generation === this.sessionGeneration) this.handlers.onTtsUnavailable?.("Speech generation failed; activate the microphone to retry."); }
        if (generation !== this.sessionGeneration) return;
        this.setState("idle");
        this.handlers.onHudUpdate?.({ state: "idle", transcript: "" });
      }
      this.isProcessing = false;
      this.turnDetector.reset();
      return;
    }

    this.partialTranscript = "";
    this.setState("thinking");
    this.handlers.onHudUpdate?.({ state: "thinking", transcript: command });
    this.conversationContext.push({ role: "user", content: command });
    this.conversationContext = this.conversationContext.slice(-8);
    this.asr.setConversationContext?.(this.conversationContext);
    const requestId = turnId
      ? `voice-${createHash("sha256").update(turnId).digest("hex").slice(0, 32)}`
      : `voice-${randomUUID()}`;
    const idempotencyKey = `voice:${requestId}`;
    const controller = new AbortController();
    this.requestController = controller;
    this.activeRequestId = requestId;
    this.handlers.onFinalTranscript?.(command, requestId);

    let responseText: string;
    try {
      try {
        this.setState("executing");
        this.handlers.onHudUpdate?.({ state: "executing", transcript: command });

        // The voice service submits one correlated turn; planning and all tool
        // dispatch remain owned by the orchestrator.
        const submitStarted = Date.now();
        console.log(`[Voice] submitting request=${requestId} historyTurns=${this.conversationContext.length}`);
        const execution = await this.client.executeCommand({
          command,
          requestId,
          idempotencyKey,
          source: "voice",
          language,
          conversationContext: this.conversationContext,
        }, controller.signal);

        if (generation !== this.sessionGeneration) return;

        console.log(`[Voice] response request=${requestId} status=${execution.status} plan=${execution.planId || "none"} elapsedMs=${Date.now() - submitStarted}`);
        this.setState("responding");
        this.handlers.onHudUpdate?.({
          state: "responding",
          transcript: execution.spokenSummary,
          plan: execution.plan,
        });
        responseText = execution.spokenSummary;
      } catch (err: any) {
        if (generation !== this.sessionGeneration) return;
        console.error("[VanessaVoiceSession] Execution error:", safeProviderDetail(err.message));
        responseText = "I couldn't confirm the task result. Check the task timeline before retrying; the request may already be running.";
        this.setState("responding");
        this.handlers.onHudUpdate?.({ state: "responding", transcript: responseText });
      }

      if (responseText) {
        if (!responseText.startsWith("I couldn't confirm the task result.")) {
          this.conversationContext.push({ role: "assistant", content: responseText });
          this.conversationContext = this.conversationContext.slice(-8);
          this.asr.setConversationContext?.(this.conversationContext);
        }
        try {
          console.log(`[Voice] TTS start request=${requestId} characters=${responseText.length}`);
          await this.speak(responseText);
          console.log(`[Voice] TTS complete request=${requestId}`);
        } catch (err: any) {
          console.warn("[VanessaVoiceSession] Response is available as text but speech failed:", safeProviderDetail(err.message));
          if (generation === this.sessionGeneration) this.handlers.onTtsUnavailable?.(safeProviderDetail(err.message || "Voice speech generation is unavailable."));
        }
      }
    } finally {
      if (generation !== this.sessionGeneration) return;
      this.requestController = undefined;
      this.isProcessing = false;
      this.turnDetector.reset();
      if (generation === this.sessionGeneration) {
        this.bargeIn.reset();
        this.wakeWord.resetSession();
        this.asr.deactivateStream?.();
      }
      if (this.state !== "listening") {
        this.setState("idle");
      }
      const queuedTurn = this.queuedUtterances.shift();
      if (queuedTurn) {
        queueMicrotask(() => {
          void this.handleFinalUtterance(queuedTurn.text, queuedTurn.language, undefined, true);
        });
      }
    }
  }

  /**
   * Speak response via streaming TTS
   */
  async speak(text: string): Promise<void> {
    const generation = this.sessionGeneration;
    this.isSpeaking = true;
    try {
      await this.tts.streamSpeech(text, (chunk) => {
        if (!this.isSpeaking || generation !== this.sessionGeneration) return; // interrupted or superseded
        this.handlers.onAudioChunkOut?.(chunk);
      });
    } finally {
      if (generation === this.sessionGeneration) this.isSpeaking = false;
    }
  }

  /**
   * Barge-In interrupt: immediately cancels active speech and downstream responses
   */
  interrupt(): void {
    this.cancelCurrentTurn();
    this.bargeIn.reset();
    this.setState("interrupted");

    // Local speech onset is an explicit conversational interruption. Re-open
    // ASR immediately; old response cleanup is generation-guarded above.
    this.turnDetector.reset();
    this.resumeSessionAfterInterruption(this.sessionGeneration).then((resumed) => {
      if (resumed) this.handlers.onHudUpdate?.({ state: "listening", transcript: "" });
    }).catch((err) => {
      console.warn("[VanessaVoiceSession] Could not resume ASR after interruption:", err.message);
      if (this.state === "interrupted") this.setState("idle");
    });
  }

  stop(): void {
    this.cancelCurrentTurn();
    this.asr.close();
    this.isAsrConnected = false;
    this.asrConnectPromise = undefined;
    this.wakeWord.resetSession();
    this.turnDetector.reset();
    this.bargeIn.reset();
    this.setState("idle");
  }

  private cancelCurrentTurn(): void {
    this.sessionGeneration++;
    this.requestController?.abort();
    this.requestController = undefined;
    const requestId = this.activeRequestId;
    this.activeRequestId = undefined;
    if (requestId) void this.client.cancelRequest(requestId).catch(() => {
      this.handlers.onError?.("Cancellation could not be confirmed. Check the task timeline; already-started actions may continue.");
    });
    this.isProcessing = false;
    this.isSpeaking = false;
    this.queuedUtterances = [];
    this.partialTranscript = "";
    this.tts.abort();
    this.sarvamSpeechGate.reset();
    this.captureAuthorized = false;
  }

  getState(): SessionState {
    return this.state;
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private async resumeSessionAfterInterruption(generation: number): Promise<boolean> {
    this.captureAuthorized = true;
    this.wakeWord.touchActiveSession(25000);
    await this.ensureAsrConnected();
    if (generation !== this.sessionGeneration) return false;
    await this.asr.activateStream?.(25000);
    if (generation !== this.sessionGeneration) return false;
    this.setState("listening");
    this.turnDetector.reset();
    return true;
  }
}
