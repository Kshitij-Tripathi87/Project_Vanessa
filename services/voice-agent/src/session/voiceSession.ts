import { AudioChunk } from "../audio/capture.js";
import { TurnDetector } from "../audio/turnDetector.js";
import { SileroVadDetector } from "../audio/vad.js";
import { BargeInDetector } from "./bargeIn.js";
import { WakeWordDetector } from "./wakeWord.js";
import { AsrAdapter, ProviderRuntimeStatus } from "../asr/types.js";
import { VoiceAdapter } from "../asr/voiceAdapter.js";
import { FishAsrAdapter } from "../asr/fishAdapter.js";
import { ElevenLabsAsrAdapter } from "../asr/elevenlabsAdapter.js";
import { VoiceTtsAdapter } from "../tts/types.js";
import { ElevenLabsTtsAdapter } from "../tts/elevenlabsTts.js";
import { FishTtsAdapter } from "../tts/fishTts.js";
import { orchestratorClient } from "../orchestratorClient.js";
import { ConversationTurn } from "@vanessa/shared";

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
  onFinalTranscript?: (text: string) => void;
  onAudioChunkOut?: (chunk: { text: string; audioBase64?: string; isFinal: boolean }) => void;
  onHudUpdate?: (hud: { state: SessionState; transcript: string; plan?: any }) => void;
  onProviderStatus?: (status: VoiceProviderInfo) => void;
}

export interface VoiceProviderInfo {
  asr: ProviderRuntimeStatus;
  tts: ProviderRuntimeStatus;
}

export class VanessaVoiceSession {
  private turnDetector = new TurnDetector();
  private vad = new SileroVadDetector();
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

  constructor(options?: {
    asrProvider?: "voice" | "whisper" | "fish" | "elevenlabs";
    ttsProvider?: "elevenlabs" | "fish";
    handlers?: VoiceSessionHandlers;
  }) {
    this.handlers = options?.handlers || {};

    const asrType = options?.asrProvider || (process.env.VOICE_ASR_PROVIDER as any) || "fish";
    if (asrType === "fish") {
      this.asr = new FishAsrAdapter();
    } else if (asrType === "elevenlabs") {
      this.asr = new ElevenLabsAsrAdapter();
    } else {
      this.asr = new VoiceAdapter();
    }

    const ttsType = options?.ttsProvider || (process.env.VOICE_TTS_PROVIDER as any) || (process.env.VOICE_PROVIDER as any) || "fish";
    if (ttsType === "fish") {
      this.tts = new FishTtsAdapter();
    } else {
      this.tts = new ElevenLabsTtsAdapter();
    }
    console.log(`[VanessaVoiceSession] Initialized with ASR: "${this.asr.name || asrType}", TTS: "${ttsType}"`);
    this.asr.setStatusHandler?.(() => this.notifyProviderStatus());
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
        requested: this.tts instanceof FishTtsAdapter ? "Fish Audio" : "ElevenLabs",
        active: this.tts instanceof FishTtsAdapter ? "Fish Audio" : "ElevenLabs",
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

    this.asrConnectPromise = Promise.resolve(this.asr.connect({
      onPartial: (result) => {
        this.partialTranscript = result.text;
        this.handlers.onPartialTranscript?.(result.text);
      },
      onFinal: async (result) => {
        await this.handleFinalUtterance(result.text, result.language, result.turnId);
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
    this.wakeWord.touchActiveSession(durationMs);
    try {
      await this.ensureAsrConnected();
    } catch (err) {
      this.wakeWord.resetSession();
      this.asr.deactivateStream?.();
      this.setState("idle");
      throw err;
    }
    this.asr.activateStream?.(durationMs);
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

    // 3. Stream audio chunk to ASR
    if (this.wakeWord.isSessionActive()) {
      this.asr.sendAudioChunk(chunk.pcm);
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
    console.log(`[VanessaVoiceSession] Processing utterance: "${rawText}"`);
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
        await this.speak(greeting);
        this.setState("idle");
        this.handlers.onHudUpdate?.({ state: "idle", transcript: "" });
      }
      this.isProcessing = false;
      this.turnDetector.reset();
      return;
    }

    this.partialTranscript = "";
    this.setState("thinking");
    this.handlers.onFinalTranscript?.(command);
    this.handlers.onHudUpdate?.({ state: "thinking", transcript: command });
    this.conversationContext.push({ role: "user", content: command });
    this.conversationContext = this.conversationContext.slice(-8);

    try {
      this.setState("executing");
      this.handlers.onHudUpdate?.({ state: "executing", transcript: command });

      // Orchestrator Planner & parallel capability agent execution
      const execution = await orchestratorClient.executeCommand({
        command,
        source: "voice",
        language,
        conversationContext: this.conversationContext,
      });

      this.setState("responding");
      this.handlers.onHudUpdate?.({
        state: "responding",
        transcript: execution.spokenSummary,
        plan: execution.plan,
      });

      // Streaming TTS playback with sentence boundary chunking
      await this.speak(execution.spokenSummary);
      this.conversationContext.push({ role: "assistant", content: execution.spokenSummary });
      this.conversationContext = this.conversationContext.slice(-8);
    } catch (err: any) {
      console.error("[VanessaVoiceSession] Execution error:", err.message);
      const message = "I couldn't reach the task coordinator. Your request was not submitted; please try again.";
      this.setState("responding");
      this.handlers.onHudUpdate?.({ state: "responding", transcript: message });
      await this.speak(message).catch(() => {});
    } finally {
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
    this.sessionGeneration += 1;
    this.isSpeaking = false;
    this.tts.abort();
    this.bargeIn.reset();
    this.setState("interrupted");
    this.handlers.onStateChange?.("interrupted");

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
    this.sessionGeneration += 1;
    this.isSpeaking = false;
    this.tts.abort();
    this.asr.close();
    this.isAsrConnected = false;
    this.wakeWord.resetSession();
    this.turnDetector.reset();
    this.bargeIn.reset();
    this.setState("idle");
  }

  getState(): SessionState {
    return this.state;
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private async resumeSessionAfterInterruption(generation: number): Promise<boolean> {
    this.wakeWord.touchActiveSession(25000);
    await this.ensureAsrConnected();
    if (generation !== this.sessionGeneration) return false;
    this.asr.activateStream?.(25000);
    this.setState("listening");
    this.turnDetector.reset();
    return true;
  }
}
