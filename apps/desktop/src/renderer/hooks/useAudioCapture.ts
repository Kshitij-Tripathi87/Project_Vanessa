import { useState, useEffect, useRef, useCallback } from "react";
import { explainMicrophoneFailure, hasMicrophoneSignal, measureMicrophoneSignal } from "./microphoneDiagnostics.js";
import { waitForLocalSpeechVoice } from "./localSpeechVoice.js";
import pcmCaptureWorkletUrl from "../audio/pcmCapture.worklet.ts?worker&url";
import { useVanessaStore } from "../stores/vanessaStore.js";
import { DesktopConversationRuntime } from "../conversation/conversationRuntime.js";
import { conversationHistory } from "../conversation/conversationHistoryInstance.js";
import { requestWakeWordPause } from "../conversation/wakeWordPause.js";
import { conversationShutdownGate } from "../conversation/shutdownGate.js";
import { DesktopVoiceConversationBridge } from "../conversation/voiceConversationBridge.js";

export interface SentimentData {
  valence: number;
  arousal: number;
  urgency: "low" | "medium" | "critical";
  emotion: "calm" | "inquisitive" | "urgent" | "frustrated" | "satisfied";
  confidence: number;
  acoustic?: {
    rms: number;
    peak: number;
    estimatedPitchHz: number;
    vocalStrain: "normal" | "elevated" | "high";
  };
}

export interface ProviderStatus {
  requested: string;
  active: string;
  state: "idle" | "connecting" | "ready" | "fallback" | "error";
  detail?: string;
}

export interface WakeWordStatus {
  available: boolean;
  ready: boolean;
  listening: boolean;
  keyword: string;
  reason?: string;
  state?: string;
}

export interface VoiceProviderStatus {

  asr: ProviderStatus;
  tts: ProviderStatus;
}

export type MicrophoneTestState = "idle" | "testing" | "passed" | "silent" | "error";
export type SpeechOutputTestState = "idle" | "testing" | "finished" | "error";

function resampleTo16k(audioBuffer: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === 16000) return audioBuffer;
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(audioBuffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const origIndex = i * ratio;
    const indexLow = Math.floor(origIndex);
    const indexHigh = Math.min(indexLow + 1, audioBuffer.length - 1);
    const fraction = origIndex - indexLow;
    result[i] = audioBuffer[indexLow] * (1 - fraction) + audioBuffer[indexHigh] * fraction;
  }
  return result;
}

export function useAudioCapture() {
  const {
    voiceState,
    conversationState,
    setConversationState,
    setVoiceState,
    setLastResponse,
    setActivePlan,
    setCurrentRequestId,
    setTaskStage,
    setPendingApproval,
    addConversationRecovery,
  } = useVanessaStore();

  const [isMicActive, setIsMicActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0); // 0.0 to 1.0 for VoiceOrb scaling
  const [liveSentiment, setLiveSentiment] = useState<SentimentData | null>(null);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [microphoneTestState, setMicrophoneTestState] = useState<MicrophoneTestState>("idle");
  const [microphoneTestMessage, setMicrophoneTestMessage] = useState("");
  const [speechOutputTestState, setSpeechOutputTestState] = useState<SpeechOutputTestState>("idle");
  const [speechOutputTestMessage, setSpeechOutputTestMessage] = useState("");
  const [providerStatus, setProviderStatus] = useState<VoiceProviderStatus | null>(null);
  const [voiceConnectionState, setVoiceConnectionState] = useState<"connecting" | "connected" | "disconnected" | "disabled">("connecting");
  const [wakeWordModeAvailable, setWakeWordModeAvailable] = useState(false);
  const [wakeWordActive, setWakeWordActive] = useState(false);
  const [wakeWordPausePending, setWakeWordPausePending] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeTextOnlyRequestRef = useRef<string | null>(null);
  const conversationRuntimeRef = useRef<DesktopConversationRuntime | null>(null);
  if (!conversationRuntimeRef.current) {
    conversationRuntimeRef.current = new DesktopConversationRuntime(conversationState, (state) => {
      setConversationState(state);
      conversationHistory.record(state);
    });
  }
  const voiceConversationBridgeRef = useRef<DesktopVoiceConversationBridge | null>(null);
  if (!voiceConversationBridgeRef.current && conversationRuntimeRef.current) {
    voiceConversationBridgeRef.current = new DesktopVoiceConversationBridge(
      conversationRuntimeRef.current,
      (requestId, text, reason) => addConversationRecovery({ requestId, text, reason, createdAt: Date.now() }),
    );
  }
  const animationFrameRef = useRef<number | null>(null);
  const voiceStateRef = useRef(voiceState);
  voiceStateRef.current = voiceState;
  const pttActiveRef = useRef(false);
  const pttStartingRef = useRef(false);
  const wakePausePendingRef = useRef(false);
  const wakePauseUnconfirmedRef = useRef(false);
  const wakeWordModeRef = useRef(false);
  const wakeWordStartupAttemptedRef = useRef(false);
  const activatedSocketRef = useRef<WebSocket | null>(null);
  const preRollRef = useRef<ArrayBuffer[]>([]);
  const pendingBargeAudioRef = useRef<ArrayBuffer[]>([]);
  const bargeResumePendingRef = useRef(false);
  const stopCaptureRef = useRef<((preservePlaybackContext?: boolean) => void) | null>(null);

  // Audio Playback Queue for low-latency streaming TTS chunks
  const audioQueueRef = useRef<Array<{
    text: string;
    audioBase64?: string;
    format?: "mp3" | "wav" | "pcm_s16le";
    sampleRate?: number;
    fallbackSpeech?: boolean;
    speechRate: number;
    speechPitch: number;
    isFinal: boolean;
  }>>([]);
  const isPlayingQueueRef = useRef<boolean>(false);
  const activeSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackGenerationRef = useRef(0);
  // Stopping speech fences late chunks from the same response without cancelling its task.
  const suppressSpeechOutputRef = useRef(false);

  const playNextInQueue = useCallback(async () => {
    if (suppressSpeechOutputRef.current) {
      audioQueueRef.current = [];
      isPlayingQueueRef.current = false;
      return;
    }
    if (isPlayingQueueRef.current || audioQueueRef.current.length === 0) {
      return;
    }

    const item = audioQueueRef.current.shift()!;
    const playbackGeneration = playbackGenerationRef.current;
    isPlayingQueueRef.current = true;

    // 1. Play synthesized audio buffer if base64 provided
    if (item.audioBase64 && (window.AudioContext || (window as any).webkitAudioContext)) {
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        const audioCtx = audioContextRef.current;
        if (audioCtx.state === "suspended") {
          await audioCtx.resume();
        }

        const binaryStr = atob(item.audioBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        let audioBuffer: AudioBuffer;
        if (item.format === "pcm_s16le") {
          const sampleCount = Math.floor(bytes.byteLength / 2);
          const samples = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
          audioBuffer = audioCtx.createBuffer(1, sampleCount, item.sampleRate || 24000);
          const channel = audioBuffer.getChannelData(0);
          for (let i = 0; i < sampleCount; i++) channel[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff);
        } else {
          audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
        }
        if (playbackGeneration !== playbackGenerationRef.current) return;
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        activeSourceNodeRef.current = source;
        source.connect(audioCtx.destination);

        source.onended = () => {
          if (playbackGeneration !== playbackGenerationRef.current) return;
          isPlayingQueueRef.current = false;
          activeSourceNodeRef.current = null;
          if (item.isFinal) {
            setVoiceState("idle");
            if (!pttActiveRef.current && !wakeWordModeRef.current) stopCaptureRef.current?.(true);
          }
          playNextInQueue();
        };
        source.start(0);
        return;
      } catch (err) {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        setMicError("Speech audio could not be decoded or played. The response remains available as text.");
      }
    }

    // 2. Never send text to an implicit or remote OS speech voice. When no
    // locally marked voice exists, retain the written response instead.
    if (item.fallbackSpeech && "speechSynthesis" in window && item.text) {
      const localVoice = await waitForLocalSpeechVoice(window.speechSynthesis, navigator.language);
      if (playbackGeneration !== playbackGenerationRef.current || suppressSpeechOutputRef.current) return;
      if (!localVoice) {
        setMicError("No on-device speech voice is available. The response remains available as text.");
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
          if (!pttActiveRef.current && !wakeWordModeRef.current) stopCaptureRef.current?.(true);
        }
        playNextInQueue();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.voice = localVoice;
      utterance.rate = item.speechRate || 1.05;
      utterance.pitch = item.speechPitch || 1.02;

      utterance.onend = () => {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
          if (!pttActiveRef.current && !wakeWordModeRef.current) stopCaptureRef.current?.(true);
        }
        playNextInQueue();
      };
      utterance.onerror = () => {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
          if (!pttActiveRef.current && !wakeWordModeRef.current) stopCaptureRef.current?.(true);
        }
        playNextInQueue();
      };
      window.speechSynthesis.speak(utterance);
    } else {
      if (playbackGeneration !== playbackGenerationRef.current) return;
      isPlayingQueueRef.current = false;
      if (item.isFinal) {
        setVoiceState("idle");
        if (!pttActiveRef.current && !wakeWordModeRef.current) stopCaptureRef.current?.(true);
      }
      playNextInQueue();
    }
  }, [setVoiceState]);

  // Barge-In interrupt handler: cancels playback immediately and notifies server
  const triggerBargeIn = useCallback(() => {
    if (pttActiveRef.current || wakePausePendingRef.current || conversationRuntimeRef.current?.isHistoryClearPending || useVanessaStore.getState().appClosing) return;
    playbackGenerationRef.current += 1;
    audioQueueRef.current = [];
    isPlayingQueueRef.current = false;
    if (activeSourceNodeRef.current) {
      try {
        activeSourceNodeRef.current.stop();
      } catch {}
      activeSourceNodeRef.current = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "barge_in", timestamp: Date.now() }));
    }
    pendingBargeAudioRef.current = preRollRef.current;
    preRollRef.current = [];
    bargeResumePendingRef.current = true;
    pttActiveRef.current = true;
    setVoiceState("listening");
  }, [setVoiceState]);

  const activateConnectedSocket = useCallback((socket: WebSocket) => {
    if (!useVanessaStore.getState().appClosing && pttActiveRef.current && socket.readyState === WebSocket.OPEN && activatedSocketRef.current !== socket) {
      bargeResumePendingRef.current = true;
      // Context arrives before capture activation, so the first recognized
      // utterance already has the same history as the typed composer.
      const contextFrame = voiceConversationBridgeRef.current?.buildContextFrame();
      if (contextFrame) socket.send(JSON.stringify(contextFrame));
      socket.send(JSON.stringify({ type: "activate" }));
      activatedSocketRef.current = socket;
    }
  }, []);

  // Keep the control channel ready; ASR/capture starts only after explicit PTT.
  const connectVoiceWs = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    setVoiceConnectionState("connecting");
    const ws = new WebSocket("ws://127.0.0.1:4500/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[useAudioCapture] Connected to Vanessa Voice Real-Time WebSocket on port 4500");
      setMicError(null);
      setVoiceConnectionState("connected");
      activateConnectedSocket(ws);
    };

    ws.onerror = () => {
      voiceConversationBridgeRef.current?.failPendingResponses(
        "The voice connection failed before a response arrived. The underlying task may still be running; check its task status.",
      );
      wakeWordModeRef.current = false;
      wakeWordStartupAttemptedRef.current = false;
      setWakeWordActive(false);
      setVoiceConnectionState("disconnected");
      setMicError("Vanessa voice service is unavailable. Start the voice agent and try again.");
      pttActiveRef.current = false;
      setVoiceState("error");
    };

    ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "session_ready" && msg.providers) {
            const contextFrame = voiceConversationBridgeRef.current?.buildContextFrame();
            if (contextFrame) ws.send(JSON.stringify(contextFrame));
            setProviderStatus(msg.providers);
            setWakeWordModeAvailable(msg.wakeWord?.enabled === true && msg.wakeWord?.mode === "local-whisper");
            if (msg.wakeWord?.enabled !== true || msg.wakeWord?.mode !== "local-whisper") {
              wakeWordModeRef.current = false;
              setWakeWordActive(false);
            }
            return;
          }

          if (msg.type === "wake_word_ready" && msg.enabled === true && msg.mode === "local-whisper") {
            setWakeWordActive(true);
            setMicError(null);
            return;
          }

          if (msg.type === "provider_status" && msg.providers) {
            setProviderStatus(msg.providers);
            return;
          }

          if (msg.type === "conversation_context_rejected") {
            setMicError(msg.message || "The voice service rejected conversation context.");
            return;
          }

          if (msg.type === "hud_update") {
            if (msg.state) setVoiceState(msg.state);
            if (msg.transcript !== undefined) {
              if (msg.state === "responding" && typeof msg.requestId === "string") {
                const committed = voiceConversationBridgeRef.current?.completeAssistantResponse(
                  msg.requestId,
                  msg.transcript,
                ) === true;
                if (committed) {
                  setPartialTranscript("");
                  setLastResponse(msg.transcript);
                }
              } else if (msg.state === "speaking" || msg.state === "responding") {
                // Older voice servers may not provide correlation. Keep their
                // status visible, but never attach an uncorrelated answer to a turn.
                setLastResponse(msg.transcript);
              } else {
                setPartialTranscript(msg.transcript);
              }
            }
            if (msg.plan) setActivePlan(msg.plan);
            return;
          }

          if (msg.type === "state_change") {
            // Synthesis can finish before local playback; do not mark the UI
            // idle or disable barge-in while the audio queue is still playing.
            if (msg.state !== "idle" || (!isPlayingQueueRef.current && audioQueueRef.current.length === 0)) setVoiceState(msg.state);
            if (msg.state === "listening" && bargeResumePendingRef.current && ws.readyState === WebSocket.OPEN) {
              for (const frame of pendingBargeAudioRef.current) ws.send(frame);
              pendingBargeAudioRef.current = [];
              bargeResumePendingRef.current = false;
            }
            return;
          }

          if (msg.type === "voice_error") {
            voiceConversationBridgeRef.current?.failPendingResponses(
              msg.message || "The voice service failed before a response arrived. The underlying task may still be running; check its task status.",
            );
            pttActiveRef.current = false;
            activatedSocketRef.current = null;
            wakeWordModeRef.current = false;
            setWakeWordActive(false);
            stopCaptureRef.current?.();
            setMicError(msg.message || "Speech recognition could not start.");
            setVoiceState("error");
            return;
          }

          if (msg.type === "tts_unavailable") {
            setMicError(`Speech playback is unavailable. ${msg.detail || "The response remains available as text."}`);
            setVoiceState("idle");
            return;
          }

          if (msg.type === "sentiment_update" || msg.sentiment) {
            setLiveSentiment(msg.sentiment);
          }

          if (msg.type === "transcript_partial") {
            setPartialTranscript(msg.text);
          }

          if (msg.type === "transcript_final") {
            const accepted = voiceConversationBridgeRef.current?.acceptFinalTranscript(
              msg.text,
              msg.requestId,
            ) === true;
            if (accepted && typeof msg.requestId === "string") {
              setCurrentRequestId(msg.requestId);
              setPartialTranscript("");
            } else {
              setMicError("The recognized voice turn could not be correlated with this conversation. No transcript was added.");
            }
            // Fish may commit before PTT release. Stop cloud streaming while
            // retaining local capture for an interruption during TTS playback.
            pttActiveRef.current = false;
            activatedSocketRef.current = null;
          }

          // Low-latency streaming TTS sentence chunk
          if (msg.type === "tts_chunk") {
            if (pttActiveRef.current || bargeResumePendingRef.current) return;
            setVoiceState("speaking");
            audioQueueRef.current.push({
              text: msg.text,
              audioBase64: msg.audioBase64,
              format: msg.format,
              sampleRate: msg.sampleRate,
              fallbackSpeech: msg.fallbackSpeech === true,
              speechRate: msg.speechRate || 1.05,
              speechPitch: msg.speechPitch || 1.02,
              isFinal: msg.isFinal ?? false,
            });
            playNextInQueue();
          }

          if (msg.type === "agent_state") {
            if (msg.state === "thinking") {
              setVoiceState("thinking");
            } else if (msg.state === "speaking") {
              setVoiceState("speaking");
              setLastResponse(msg.spokenSummary);
              if (msg.plan) {
                setActivePlan(msg.plan);
              }

              // Fallback for non-chunked response if queue is empty
              if (audioQueueRef.current.length === 0 && !isPlayingQueueRef.current && msg.spokenSummary) {
                audioQueueRef.current.push({
                  text: msg.spokenSummary,
                  speechRate: msg.sentiment?.urgency === "critical" ? 1.18 : 1.05,
                  speechPitch: msg.sentiment?.emotion === "frustrated" ? 0.98 : 1.02,
                  isFinal: true,
                });
                playNextInQueue();
              }
            } else if (msg.state === "error") {
              setVoiceState("error");
              setLastResponse(msg.error || "Voice command processing failed.");
            }
          }
        } catch (err) {
          console.warn("[useAudioCapture] WS message error:", err);
        }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        voiceConversationBridgeRef.current?.failPendingResponses(
          "The voice service disconnected before a response arrived. The underlying task may still be running; check its task status.",
        );
        wakeWordModeRef.current = false;
        wakeWordStartupAttemptedRef.current = false;
        setWakeWordActive(false);
        stopCaptureRef.current?.();
        setVoiceConnectionState("disconnected");
        setMicError("Voice connection closed. Reconnecting; press push-to-talk to start a new turn.");
        activatedSocketRef.current = null;
        setTimeout(() => { if (wsRef.current === ws) connectVoiceWs(); }, 3000);
      }
    };
  }, [activateConnectedSocket, setVoiceConnectionState, setVoiceState, setLastResponse, setActivePlan, setCurrentRequestId, playNextInQueue]);


  const submitTextCommand = useCallback((rawText: string, language = "en") => {
    if (useVanessaStore.getState().appClosing) return false;
    const text = rawText.trim();
    if (!text || text.length > 4000) {
      setLastResponse(text ? "That request is too long." : "Enter a request first.");
      return false;
    }

    suppressSpeechOutputRef.current = false;
    const conversation = conversationRuntimeRef.current;
    const request = conversation?.submitTyped(text);
    if (!conversation || !request) {
      setLastResponse("A new conversation turn could not be created. The existing conversation is unchanged.");
      return false;
    }

    const requestId = request.requestId;
    activeTextOnlyRequestRef.current = requestId;
    setPartialTranscript("");
    setLastResponse("");
    setCurrentRequestId(requestId);
    setPendingApproval(null);
    setTaskStage("accepted", "Request received.");
    setVoiceState("thinking");

    // Typed input always uses trusted Electron IPC. Voice WebSocket availability
    // must not change how text is submitted or which completed turns reach planning.
    void window.vanessa.executeCommand({
      command: text,
      language: language.slice(0, 32) || "en",
      source: "desktop",
      requestId,
      idempotencyKey: `desktop:${requestId}`,
      conversationContext: conversation.plannerContext(requestId),
    })
      .then((result) => {
        if (result.requestId !== requestId) {
          const detail = "The orchestrator response did not match the submitted request. Its result was not attached to this conversation.";
          const published = conversation.failAssistant(request, detail);
          if (!published) addConversationRecovery({
            requestId, text: detail,
            reason: "The request correlation failure could not be added to bounded conversation history.",
            createdAt: Date.now(),
          });
          if (activeTextOnlyRequestRef.current !== requestId) return;
          activeTextOnlyRequestRef.current = null;
          setLastResponse(detail);
          setCurrentRequestId(null);
          setTaskStage("failed", "Request correlation failed.");
          setVoiceState("error");
          return;
        }

        if (result.plan) {
          if (activeTextOnlyRequestRef.current === requestId) setActivePlan(result.plan);
        }
        const responseText = result.spokenSummary?.trim() ||
          "The orchestrator returned without an assistant summary.";
        // Append to the originating turn even when a newer request has taken
        // focus. Only update the global task/voice surface for the current one.
        const published = conversation.completeAssistant(request, responseText);
        if (!published) addConversationRecovery({
          requestId, text: responseText,
          reason: "The assistant response arrived, but bounded conversation history could not accept it. This copy is retained here for recovery.",
          createdAt: Date.now(),
        });
        if (activeTextOnlyRequestRef.current !== requestId) return;
        activeTextOnlyRequestRef.current = null;
        setLastResponse(responseText);

        if (result.status === "awaiting_approval") {
          setPendingApproval(result.pendingTasks?.[0] || null);
          setTaskStage("executing", "I need your approval before continuing.");
        } else if (result.status === "success" && result.verification?.verified === true) {
          setTaskStage("completed", "Done — result verified.");
        } else if (result.status === "partial" || result.status === "accepted" || result.status === "success") {
          setTaskStage("partial", result.status === "accepted"
            ? "The request is already being processed."
            : "Execution returned without a fully verified result.");
        } else {
          setTaskStage("failed", "The request failed or could not be verified.");
        }

        const canSpeakFallback =
          import.meta.env.VITE_VANESSA_VOICE_ENABLED !== "false" &&
          Boolean(responseText) &&
          "speechSynthesis" in window;
        if (canSpeakFallback) {
          audioQueueRef.current.push({
            text: responseText,
            fallbackSpeech: true,
            speechRate: 1.05,
            speechPitch: 1.02,
            isFinal: true,
          });
          setVoiceState("speaking");
          playNextInQueue();
        } else {
          setVoiceState("idle");
        }
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : "Unknown connection error";
        const message = `Orchestrator request failed: ${detail}`;
        const published = conversation.failAssistant(request, message);
        if (!published) addConversationRecovery({
          requestId, text: message,
          reason: "The failure response could not be added to bounded conversation history. This copy is retained here for recovery.",
          createdAt: Date.now(),
        });
        if (activeTextOnlyRequestRef.current !== requestId) return;
        activeTextOnlyRequestRef.current = null;
        setLastResponse(message);
        setCurrentRequestId(null);
        setTaskStage("failed", "The request could not be completed.");
        setVoiceState("error");
      });
    return true;
  }, [playNextInQueue, setActivePlan, setCurrentRequestId, setLastResponse, setPendingApproval, setTaskStage, setPartialTranscript, setVoiceState, addConversationRecovery]);

  // A local-only mic check. It never opens the voice WebSocket or sends audio for transcription.
  const testMicrophone = useCallback(async () => {
    if (microphoneTestState === "testing") return;
    if (pttActiveRef.current) {
      setMicrophoneTestState("error");
      setMicrophoneTestMessage("Finish the current voice turn before testing the microphone.");
      return;
    }

    setMicrophoneTestState("testing");
    setMicrophoneTestMessage("Speak normally for about two seconds. Test audio stays on this device and is not sent to Vanessa or a speech provider.");
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let silentGain: GainNode | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        const error = new Error("Microphone capture API is unavailable.");
        error.name = "NotSupportedError";
        throw error;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) {
        const error = new Error("Web Audio is unavailable.");
        error.name = "AudioContextUnavailableError";
        throw error;
      }
      context = new AudioCtx();
      if (context.state === "suspended") await context.resume();

      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      silentGain = context.createGain();
      silentGain.gain.value = 0; // Keep the graph active without monitoring mic audio through speakers.
      source.connect(analyser);
      analyser.connect(silentGain);
      silentGain.connect(context.destination);

      const samples = new Uint8Array(analyser.fftSize);
      const deadline = Date.now() + 1600;
      let signalDetected = false;
      let peak = 0;
      while (Date.now() < deadline) {
        analyser.getByteTimeDomainData(samples);
        const measurement = measureMicrophoneSignal(samples);
        peak = Math.max(peak, measurement.peak);
        if (hasMicrophoneSignal(measurement)) signalDetected = true;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
      }

      if (signalDetected) {
        setMicrophoneTestState("passed");
        setMicrophoneTestMessage(`Microphone input signal detected (peak ${Math.round(peak * 100)}%). This verifies capture only; speech recognition is checked by a real voice command.`);
      } else {
        setMicrophoneTestState("silent");
        setMicrophoneTestMessage("The microphone opened, but no input signal was detected. Unmute it and check Windows Settings → System → Sound → Input while speaking, then retry.");
      }
    } catch (error) {
      setMicrophoneTestState("error");
      setMicrophoneTestMessage(explainMicrophoneFailure(error));
    } finally {
      try { source?.disconnect(); } catch {}
      try { analyser?.disconnect(); } catch {}
      try { silentGain?.disconnect(); } catch {}
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") await context.close().catch(() => {});
    }
  }, [microphoneTestState]);

  // Test the no-key browser/OS speech fallback. "Finished" means the browser
  // completed its utterance callback; the user still confirms they heard audio.
  const testSpeechOutput = useCallback(async () => {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setSpeechOutputTestState("error");
      setSpeechOutputTestMessage("This runtime does not expose local speech synthesis. Typed responses remain available; check the Vanessa runtime.");
      return;
    }

    try {
      window.speechSynthesis.cancel();
      setSpeechOutputTestState("testing");
      setSpeechOutputTestMessage("Looking for an on-device speech voice.");
      const localVoice = await waitForLocalSpeechVoice(window.speechSynthesis, navigator.language);
      if (!localVoice) {
        setSpeechOutputTestState("error");
        setSpeechOutputTestMessage("No on-device system voice is available. Written responses remain available.");
        return;
      }
      setSpeechOutputTestMessage("Playing a short on-device test phrase.");
      const utterance = new SpeechSynthesisUtterance(
        "This is Vanessa's local speech output test. If you hear this, local speech playback is working."
      );
      utterance.voice = localVoice;
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = () => {
        setSpeechOutputTestState("finished");
        setSpeechOutputTestMessage("The speech engine finished playback. Confirm you heard it; if not, check Windows volume and the selected output device.");
      };
      utterance.onerror = () => {
        setSpeechOutputTestState("error");
        setSpeechOutputTestMessage("Local speech playback reported an error. Check Windows volume and the selected output device. Written responses remain available.");
      };
      window.speechSynthesis.speak(utterance);
    } catch {
      setSpeechOutputTestState("error");
      setSpeechOutputTestMessage("Local speech playback could not start. Check Windows volume/output settings; written responses remain available.");
    }
  }, []);

  // Start live microphone capture
  const startRecording = useCallback(async () => {
    if (import.meta.env.VITE_VANESSA_VOICE_ENABLED === "false") {
      setMicError("Voice is disabled for this session. Restart Vanessa without --text-only to use the microphone.");
      return;
    }

    let acquiredStream: MediaStream | null = null;
    let openedContext: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let analyserNode: AnalyserNode | null = null;
    let workletNode: AudioWorkletNode | null = null;
    try {
      if (mediaStreamRef.current) return;
      setMicError(null);
      connectVoiceWs();

      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        const error = new Error("Microphone capture API is unavailable.");
        error.name = "NotSupportedError";
        throw error;
      }

      let stream: MediaStream;
      try {
        stream = await mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name || "";
        // Only retry without optional processing constraints. Permission/device
        // failures should be reported directly rather than prompting twice.
        if (!["OverconstrainedError", "ConstraintNotSatisfiedError", "TypeError"].includes(name)) throw error;
        stream = await mediaDevices.getUserMedia({ audio: true });
      }
      acquiredStream = stream;
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) {
        const error = new Error("Web Audio is unavailable.");
        error.name = "AudioContextUnavailableError";
        throw error;
      }
      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      openedContext = new AudioCtx();
      audioContextRef.current = openedContext;
      if (openedContext.state === "suspended") await openedContext.resume();

      sourceNode = openedContext.createMediaStreamSource(stream);
      analyserNode = openedContext.createAnalyser();
      analyserNode.fftSize = 256;
      analyserRef.current = analyserNode;
      sourceNode.connect(analyserNode);

      // AudioWorklet keeps PCM conversion away from the renderer's main UI thread.
      // Compile TypeScript as a separate same-origin JavaScript module, never an inlined asset.
      await openedContext.audioWorklet.addModule(pcmCaptureWorkletUrl);
      workletNode = new AudioWorkletNode(openedContext, "vanessa-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      processorRef.current = workletNode;
      sourceNode.connect(workletNode);
      workletNode.connect(openedContext.destination);

      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const inputData = event.data;
        const resampled = resampleTo16k(inputData, openedContext!.sampleRate);
        const pcmBuffer = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const sample = Math.max(-1, Math.min(1, resampled[i]));
          pcmBuffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const audioFrame = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength);
        const ambientWakeListening = wakeWordModeRef.current && !["thinking", "executing", "responding", "speaking"].includes(voiceStateRef.current);
        if (!useVanessaStore.getState().appClosing && (pttActiveRef.current || ambientWakeListening) && wsRef.current?.readyState === WebSocket.OPEN) {
          if (bargeResumePendingRef.current) {
            pendingBargeAudioRef.current.push(audioFrame);
            if (pendingBargeAudioRef.current.length > 80) pendingBargeAudioRef.current.shift();
          } else {
            wsRef.current.send(audioFrame);
          }
          preRollRef.current = [];
        } else if (voiceStateRef.current === "speaking") {
          preRollRef.current.push(audioFrame);
          if (preRollRef.current.length > 16) preRollRef.current.shift();
        } else {
          preRollRef.current = [];
        }
      };

      const updateAudioMeter = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const normalized = Math.min(1.0, (sum / dataArray.length) / 128.0);
        setAudioLevel(normalized);
        if (normalized > 0.35 && voiceStateRef.current === "speaking") triggerBargeIn();
        animationFrameRef.current = requestAnimationFrame(updateAudioMeter);
      };
      updateAudioMeter();

      setIsMicActive(true);
      setVoiceState("idle");
    } catch (error: unknown) {
      const name = (error as { name?: string } | null)?.name || "UnknownError";
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[useAudioCapture] Microphone initialization failed (${name}): ${detail}`);
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch { /* best-effort cleanup */ }
      try { sourceNode?.disconnect(); } catch { /* best-effort cleanup */ }
      try { analyserNode?.disconnect(); } catch { /* best-effort cleanup */ }
      acquiredStream?.getTracks().forEach(track => track.stop());
      if (processorRef.current === workletNode) processorRef.current = null;
      if (analyserRef.current === analyserNode) analyserRef.current = null;
      if (mediaStreamRef.current === acquiredStream) mediaStreamRef.current = null;
      if (audioContextRef.current === openedContext) audioContextRef.current = null;
      if (openedContext) await openedContext.close().catch(() => {});
      pttActiveRef.current = false;
      activatedSocketRef.current = null;
      setMicError(explainMicrophoneFailure(error));
      setIsMicActive(false);
      setAudioLevel(0);
      setVoiceState("idle");
    }
  }, [connectVoiceWs, setVoiceState, triggerBargeIn]);

  useEffect(() => {
    if (useVanessaStore.getState().appClosing || !wakeWordModeAvailable || voiceConnectionState !== "connected" || wakeWordStartupAttemptedRef.current) return;
    wakeWordStartupAttemptedRef.current = true;
    wakeWordModeRef.current = true;
    void startRecording().then(() => {
      if (useVanessaStore.getState().appClosing) {
        wakeWordModeRef.current = false;
        stopCaptureRef.current?.();
        return;
      }
      const socket = wsRef.current;
      if (mediaStreamRef.current && socket?.readyState === WebSocket.OPEN) {
        const contextFrame = voiceConversationBridgeRef.current?.buildContextFrame();
        if (contextFrame) socket.send(JSON.stringify(contextFrame));
        socket.send(JSON.stringify({ type: "enable_wake_word" }));
      } else {
        wakeWordModeRef.current = false;
        setWakeWordActive(false);
        setMicError("Wake-word listening could not start. Allow microphone access in Windows Settings, then click the orb to retry voice input.");
        wakeWordStartupAttemptedRef.current = false;
      }
    });
  }, [wakeWordModeAvailable, voiceConnectionState, startRecording]);

  // Stop microphone capture
  const stopRecording = useCallback((preservePlaybackContext = false) => {
    pttActiveRef.current = false;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current && !preservePlaybackContext) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    setIsMicActive(false);
    setAudioLevel(0);
  }, []);
  stopCaptureRef.current = stopRecording;

  const stopSpeaking = useCallback(() => {
    suppressSpeechOutputRef.current = true;
    playbackGenerationRef.current += 1;
    audioQueueRef.current = [];
    isPlayingQueueRef.current = false;
    if (activeSourceNodeRef.current) {
      try { activeSourceNodeRef.current.stop(); } catch {}
      activeSourceNodeRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (voiceStateRef.current === "speaking" || voiceStateRef.current === "responding") {
      setVoiceState("idle");
    }
  }, [setVoiceState]);

  const cancelVoice = useCallback(() => {
    suppressSpeechOutputRef.current = true;
    pttActiveRef.current = false;
    activatedSocketRef.current = null;
    pendingBargeAudioRef.current = [];
    preRollRef.current = [];
    bargeResumePendingRef.current = false;
    // Keep the in-flight request correlation until the orchestrator returns
    // its actual terminal outcome after task cancellation.
    playbackGenerationRef.current += 1;
    audioQueueRef.current = [];
    isPlayingQueueRef.current = false;
    if (activeSourceNodeRef.current) {
      try { activeSourceNodeRef.current.stop(); } catch {}
      activeSourceNodeRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "deactivate" }));
    }
    if (!wakeWordModeRef.current) stopRecording();
    setVoiceState("idle");
  }, [setVoiceState, stopRecording]);

  const resumeAudio = useCallback(async () => {
    if (audioContextRef.current && audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
      console.log("[useAudioCapture] AudioContext successfully resumed!");
    }
  }, []);

  const finalizeListening = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "finalize" }));
    }
    setVoiceState("thinking");
  }, [setVoiceState]);

  const toggleRecording = useCallback(async () => {
    if (useVanessaStore.getState().appClosing || conversationRuntimeRef.current?.isHistoryClearPending || pttStartingRef.current || wakePausePendingRef.current) {
      setLastResponse("Wait for the conversation history operation to finish before starting voice input.");
      return;
    }
    if (pttActiveRef.current) {
      pttActiveRef.current = false;
      activatedSocketRef.current = null;
      finalizeListening();
      // Keep audio local while Vanessa responds so onset detection can support
      // barge-in; PCM is sent to ASR only while PTT is active.
    } else {
      suppressSpeechOutputRef.current = false;
      // Acquire the microphone only after an explicit PTT action. A pending
      // permission prompt must not race a history clear.
      pttStartingRef.current = true;
      try { await startRecording(); } finally { pttStartingRef.current = false; }
      if (!mediaStreamRef.current) return;
      if (useVanessaStore.getState().appClosing || conversationRuntimeRef.current?.isHistoryClearPending) {
        if (!wakeWordModeRef.current) stopRecording();
        return;
      }
      if (voiceStateRef.current === "speaking") {
        triggerBargeIn();
        return;
      }
      preRollRef.current = [];
      pendingBargeAudioRef.current = [];
      bargeResumePendingRef.current = false;
      pttActiveRef.current = true;
      setVoiceState("listening");
      setPartialTranscript("");
      if (wsRef.current) activateConnectedSocket(wsRef.current);
    }
  }, [startRecording, setVoiceState, setLastResponse, finalizeListening, stopRecording, activateConnectedSocket, triggerBargeIn]);

  const pauseWakeWordListening = useCallback(async (forShutdown = false): Promise<boolean> => {
    const current = useVanessaStore.getState();
    const activeStages = ["accepted", "planning", "executing", "verifying", "cancelling", "termination_unconfirmed"];
    const socket = wsRef.current;
    if (!wakeWordModeRef.current || wakePausePendingRef.current || (current.appClosing && !forShutdown) || current.pendingApproval ||
        activeStages.includes(current.taskStage) || !["idle", "error", "interrupted"].includes(current.voiceState) ||
        pttActiveRef.current || pttStartingRef.current || conversationRuntimeRef.current?.isHistoryClearPending ||
        !socket || socket.readyState !== WebSocket.OPEN) {
      if (!forShutdown) setLastResponse("Finish the current voice turn and task before pausing wake-word listening. No task was cancelled.");
      return false;
    }
    wakePausePendingRef.current = true;
    setWakeWordPausePending(true);
    // Stop sending ambient audio before requesting the server-side fence.
    wakeWordModeRef.current = false;
    const result = await requestWakeWordPause(socket, globalThis.crypto.randomUUID());
    wakePausePendingRef.current = false;
    setWakeWordPausePending(false);
    if (result === "paused") {
      wakePauseUnconfirmedRef.current = false;
      setWakeWordActive(false);
      stopRecording();
      if (!forShutdown) setLastResponse("Wake-word listening is paused for this session. Push-to-talk still works; restart Vanessa to restore wake-word listening.");
      return true;
    } else if (result === "busy" && socket === wsRef.current) {
      // The service did not pause. Restore the local mode so a cancelled close
      // can resume without pretending that the active voice turn stopped.
      wakeWordModeRef.current = true;
      if (!forShutdown) setLastResponse("Wake-word listening could not pause while a voice turn is active. No task was cancelled.");
    } else {
      wakePauseUnconfirmedRef.current = true;
      setWakeWordActive(false);
      stopRecording();
      setLastResponse("Wake-word pause could not be confirmed. Restart with wake-word disabled before clearing history; no task was cancelled.");
    }
    return false;
  }, [setLastResponse, stopRecording]);

  const clearConversationHistory = useCallback(async () => {
    const current = useVanessaStore.getState();
    const activeStages = ["accepted", "planning", "executing", "verifying", "cancelling", "termination_unconfirmed"];
    const runtime = conversationRuntimeRef.current;
    if (!runtime || current.appClosing || activeStages.includes(current.taskStage) || current.pendingApproval ||
        !["idle", "error", "interrupted"].includes(current.voiceState) || pttActiveRef.current || pttStartingRef.current ||
        wakeWordModeRef.current || wakePausePendingRef.current || wakePauseUnconfirmedRef.current || !runtime.beginHistoryClear()) {
      setLastResponse("Finish the active conversation and task, and disable wake-word listening before clearing. No task was cancelled.");
      return;
    }
    try {
      const result = await conversationHistory.clear();
      runtime.finishHistoryClear(result !== "failed");
      if (result !== "failed") {
        setPartialTranscript("");
        useVanessaStore.getState().clearConversationRecovery();
      }
      setLastResponse(result === "cleared"
        ? "Conversation history was cleared on this device. Task records and backups are unchanged."
        : result === "session_only"
          ? "The current conversation was cleared. Inaccessible saved history was not deleted."
          : "Conversation history could not be cleared; the current conversation was kept.");
    } catch {
      runtime.finishHistoryClear(false);
      setLastResponse("Conversation history could not be cleared; the current conversation was kept.");
    }
  }, [setLastResponse]);

  useEffect(() => conversationShutdownGate.register(async () => {
    const busy = () => {
      const current = useVanessaStore.getState();
      return !conversationRuntimeRef.current || conversationRuntimeRef.current.hasPendingRequests ||
        pttActiveRef.current || pttStartingRef.current || bargeResumePendingRef.current ||
        wakePausePendingRef.current || wakePauseUnconfirmedRef.current || current.pendingApproval !== null ||
        current.conversationRecovery.length > 0 ||
        ["accepted", "planning", "executing", "verifying", "cancelling", "termination_unconfirmed"].includes(current.taskStage) ||
        ["listening", "thinking", "executing", "responding"].includes(current.voiceState);
    };
    if (busy()) return false;
    // Ambient audio may have already reached the service. A correlated pause
    // acknowledgement fences it before we seal the renderer's write queue.
    if (wakeWordModeRef.current && !await pauseWakeWordListening(true)) return false;
    // An in-flight final transcript or task event can arrive during the pause.
    return !busy() && !wakeWordModeRef.current;
  }), [pauseWakeWordListening]);

  useEffect(() => {
    if (import.meta.env.VITE_VANESSA_VOICE_ENABLED !== "false") connectVoiceWs();
    else setVoiceConnectionState("disabled");
    return () => {
      pttActiveRef.current = false;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      processorRef.current?.disconnect();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close().catch(() => {});
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.close();
      }
    };
  }, [connectVoiceWs]);

  return {
    isMicActive,
    audioLevel,
    liveSentiment,
    partialTranscript,
    providerStatus,
    micError,
    microphoneTestState,
    microphoneTestMessage,
    testMicrophone,
    speechOutputTestState,
    speechOutputTestMessage,
    testSpeechOutput,
    voiceConnectionState,
    wakeWordActive,
    wakeWordPausePending,
    pauseWakeWordListening,
    submitTextCommand,
    clearConversationHistory,
    cancelVoice,
    stopSpeaking,
    startRecording,
    stopRecording,
    toggleRecording,
    resumeAudio,
    triggerBargeIn,
  };
}
