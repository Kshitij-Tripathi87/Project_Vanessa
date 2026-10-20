import { AudioChunk } from "../audio/capture.js";
import { TurnDetector } from "../audio/turnDetector.js";
import { SileroVadDetector, vadDetector } from "../audio/vad.js";
import { BargeInDetector } from "./bargeIn.js";
import { WakeWordDetector, wakeWordDetector } from "./wakeWord.js";
import { AsrAdapter } from "../asr/types.js";
import { VoiceAdapter } from "../asr/voiceAdapter.js";
import { FishAsrAdapter } from "../asr/fishAdapter.js";
import { ElevenLabsAsrAdapter } from "../asr/elevenlabsAdapter.js";
import { VoiceTtsAdapter } from "../tts/types.js";
import { ElevenLabsTtsAdapter } from "../tts/elevenlabsTts.js";
import { FishTtsAdapter } from "../tts/fishTts.js";
import { orchestratorClient } from "../orchestratorClient.js";

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
}

export class VanessaVoiceSession {
  private turnDetector = new TurnDetector();
  private vad = vadDetector;
  private bargeIn = new BargeInDetector();
  private wakeWord = wakeWordDetector;
  private asr: AsrAdapter;
  private tts: VoiceTtsAdapter;

  private state: SessionState = "idle";
  private partialTranscript = "";
  private isProcessing = false;
  private isSpeaking = false;
  private handlers: VoiceSessionHandlers = {};

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
  }

  setHandlers(handlers: VoiceSessionHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  getProviderInfo(): { asr: string; tts: string } {
    return {
      asr: (this.asr as any).name || (this.asr instanceof FishAsrAdapter ? "fish" : "voice"),
      tts: this.tts instanceof FishTtsAdapter ? "fish" : "elevenlabs",
    };
  }

  async start(): Promise<void> {
    await this.asr.connect({
      onPartial: (result) => {
        this.partialTranscript = result.text;
        this.handlers.onPartialTranscript?.(result.text);

        // Check if wake word activated session
        const wakeCheck = this.wakeWord.processTranscript(result.text);
        if (wakeCheck.detected) {
          this.activateSession(25000);
          this.handlers.onHudUpdate?.({ state: "listening", transcript: wakeCheck.cleanedText });
        }
      },
      onFinal: async (result) => {
        if (this.isProcessing) return;
        await this.handleFinalUtterance(result.text, result.language);
      },
    });

    this.setState("idle");
  }

  activateSession(durationMs = 25000): void {
    this.wakeWord.touchActiveSession(durationMs);
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
    this.asr.sendAudioChunk(chunk.pcm);

    // 4. Turn detection: silence threshold + transcript completion
    const turnState = this.turnDetector.process({
      isSpeech: vadRes.isSpeech,
      partialTranscript: this.partialTranscript,
    });

    if (turnState === "complete" && !this.isProcessing && !this.isFinalizingTurn) {
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

  async handleFinalUtterance(rawText: string, language = "en"): Promise<void> {
    if (this.isProcessing) return;
    this.isFinalizingTurn = false;
    console.log(`[VanessaVoiceSession] Processing utterance: "${rawText}"`);
    this.isProcessing = true;

    // Filter wake word prefix
    const wakeCheck = this.wakeWord.processTranscript(rawText);
    const command = wakeCheck.cleanedText || rawText;

    if (!command.trim()) {
      if (wakeCheck.detected) {
        // User woke up Vanessa with "Hey Vanessa"
        this.setState("responding");
        const greeting = "Hey boss, how are you? How can I help you?";
        this.handlers.onHudUpdate?.({ state: "responding", transcript: greeting });
        await this.speak(greeting);
        this.wakeWord.touchActiveSession(15000);
        this.setState("listening");
        this.handlers.onHudUpdate?.({ state: "listening", transcript: "" });
      }
      this.isProcessing = false;
      this.turnDetector.reset();
      return;
    }

    this.partialTranscript = "";
    this.setState("thinking");
    this.handlers.onFinalTranscript?.(command);
    this.handlers.onHudUpdate?.({ state: "thinking", transcript: command });

    try {
      this.setState("executing");
      this.handlers.onHudUpdate?.({ state: "executing", transcript: command });

      // Orchestrator Planner & parallel capability agent execution
      const execution = await orchestratorClient.executeCommand({
        command,
        source: "voice",
        language,
      });

      this.setState("responding");
      this.handlers.onHudUpdate?.({
        state: "responding",
        transcript: execution.spokenSummary,
        plan: execution.plan,
      });

      // Streaming TTS playback with sentence boundary chunking
      await this.speak(execution.spokenSummary);
    } catch (err: any) {
      console.error("[VanessaVoiceSession] Execution error:", err.message);
      this.setState("idle");
    } finally {
      this.isProcessing = false;
      this.turnDetector.reset();
      this.bargeIn.reset();
      if (this.state !== "listening") {
        this.setState("idle");
      }
    }
  }

  /**
   * Speak response via streaming TTS
   */
  async speak(text: string): Promise<void> {
    this.isSpeaking = true;
    try {
      await this.tts.streamSpeech(text, (chunk) => {
        if (!this.isSpeaking) return; // interrupted
        this.handlers.onAudioChunkOut?.(chunk);
      });
    } finally {
      this.isSpeaking = false;
    }
  }

  /**
   * Barge-In interrupt: immediately cancels active speech and downstream responses
   */
  interrupt(): void {
    this.isSpeaking = false;
    this.tts.abort();
    this.bargeIn.reset();
    this.setState("interrupted");
    this.handlers.onStateChange?.("interrupted");

    // Immediately transition to listening for the user's new request
    setTimeout(() => {
      this.setState("listening");
      this.turnDetector.reset();
      this.handlers.onHudUpdate?.({ state: "listening", transcript: "" });
    }, 100);
  }

  stop(): void {
    this.isSpeaking = false;
    this.tts.abort();
    this.asr.close();
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
}
