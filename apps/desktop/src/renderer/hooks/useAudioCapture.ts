import { useState, useEffect, useRef, useCallback } from "react";
import { useVanessaStore } from "../stores/vanessaStore.js";

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

export interface VoiceProviderStatus {
  asr: ProviderStatus;
  tts: ProviderStatus;
}

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
  const { voiceState, setVoiceState, setLastResponse, setActivePlan, setCurrentRequestId, setTaskStage, setPendingApproval } = useVanessaStore();

  const [isMicActive, setIsMicActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0); // 0.0 to 1.0 for VoiceOrb scaling
  const [liveSentiment, setLiveSentiment] = useState<SentimentData | null>(null);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<VoiceProviderStatus | null>(null);
  const [voiceConnectionState, setVoiceConnectionState] = useState<"connecting" | "connected" | "disconnected" | "disabled">("connecting");

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingTextCommandRef = useRef<{ type: "transcript_final"; text: string; language: string; turnId: string } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const voiceStateRef = useRef(voiceState);
  voiceStateRef.current = voiceState;
  const pttActiveRef = useRef(false);
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

  const playNextInQueue = useCallback(async () => {
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
            if (!pttActiveRef.current) stopCaptureRef.current?.(true);
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

    // 2. Client-side SpeechSynthesis fallback with emotion-modulated rate & pitch
    if (item.fallbackSpeech && "speechSynthesis" in window && item.text) {
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.rate = item.speechRate || 1.05;
      utterance.pitch = item.speechPitch || 1.02;

      utterance.onend = () => {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
          if (!pttActiveRef.current) stopCaptureRef.current?.(true);
        }
        playNextInQueue();
      };
      utterance.onerror = () => {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
          if (!pttActiveRef.current) stopCaptureRef.current?.(true);
        }
        playNextInQueue();
      };
      window.speechSynthesis.speak(utterance);
    } else {
      if (playbackGeneration !== playbackGenerationRef.current) return;
      isPlayingQueueRef.current = false;
      if (item.isFinal) {
        setVoiceState("idle");
        if (!pttActiveRef.current) stopCaptureRef.current?.(true);
      }
      playNextInQueue();
    }
  }, [setVoiceState]);

  // Barge-In interrupt handler: cancels playback immediately and notifies server
  const triggerBargeIn = useCallback(() => {
    if (pttActiveRef.current) return;
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
    if (pttActiveRef.current && socket.readyState === WebSocket.OPEN && activatedSocketRef.current !== socket) {
      bargeResumePendingRef.current = true;
      socket.send(JSON.stringify({ type: "activate" }));
      activatedSocketRef.current = socket;
    }
  }, []);

  const dispatchTextCommand = useCallback((
    socket: WebSocket,
    command: { type: "transcript_final"; text: string; language: string; turnId: string },
  ) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (pttActiveRef.current) {
      pttActiveRef.current = false;
      activatedSocketRef.current = null;
      pendingBargeAudioRef.current = [];
      preRollRef.current = [];
      bargeResumePendingRef.current = false;
      stopCaptureRef.current?.(true);
      socket.send(JSON.stringify({ type: "deactivate" }));
    }
    socket.send(JSON.stringify(command));
    setPartialTranscript(command.text);
    setLastResponse("");
    setCurrentRequestId(null);
    setTaskStage("accepted", "Request received.");
    setVoiceState("thinking");
    return true;
  }, [setCurrentRequestId, setLastResponse, setTaskStage, setVoiceState, setPartialTranscript]);

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
      const pending = pendingTextCommandRef.current;
      if (pending) {
        if (!dispatchTextCommand(ws, pending)) return;
        pendingTextCommandRef.current = null;
      } else {
        activateConnectedSocket(ws);
      }
    };

    ws.onerror = () => {
      setVoiceConnectionState("disconnected");
      setMicError("Vanessa voice service is unavailable. Start the voice agent and try again.");
      pttActiveRef.current = false;
      setVoiceState("error");
    };

    ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "session_ready" && msg.providers) {
            setProviderStatus(msg.providers);
            return;
          }

          if (msg.type === "provider_status" && msg.providers) {
            setProviderStatus(msg.providers);
            return;
          }

          if (msg.type === "hud_update") {
            if (msg.state) setVoiceState(msg.state);
            if (msg.transcript !== undefined) {
              setPartialTranscript(msg.transcript);
              if (msg.state === "responding" || msg.state === "speaking") {
                setLastResponse(msg.transcript);
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
            pttActiveRef.current = false;
            activatedSocketRef.current = null;
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
            setPartialTranscript(msg.text);
            if (typeof msg.requestId === "string") setCurrentRequestId(msg.requestId);
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
        stopCaptureRef.current?.();
        setVoiceConnectionState("disconnected");
        setMicError("Voice connection closed. Reconnecting; press push-to-talk to start a new turn.");
        activatedSocketRef.current = null;
        setTimeout(() => { if (wsRef.current === ws) connectVoiceWs(); }, 3000);
      }
    };
  }, [activateConnectedSocket, dispatchTextCommand, setVoiceConnectionState, setVoiceState, setLastResponse, setActivePlan, setCurrentRequestId, playNextInQueue]);


  const submitTextCommand = useCallback((rawText: string, language = "en") => {
    const text = rawText.trim();
    if (!text || text.length > 16000) {
      setLastResponse(text ? "That request is too long." : "Enter a request first.");
      return false;
    }

    // --text-only deliberately omits the voice service. Preserve a usable typed
    // command path through the trusted Electron main process to the same orchestrator.
    if (import.meta.env.VITE_VANESSA_VOICE_ENABLED === "false") {
      setPartialTranscript(text);
      setLastResponse("");
      setCurrentRequestId(null);
      setPendingApproval(null);
      setTaskStage("accepted", "Request received.");
      setVoiceState("thinking");
      void window.vanessa.executeCommand({ command: text, language: language.slice(0, 32) || "en", source: "desktop" })
        .then((result) => {
          if (result.requestId) setCurrentRequestId(result.requestId);
          if (result.plan) setActivePlan(result.plan);
          setLastResponse(result.spokenSummary || "The orchestrator returned without a summary.");
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
          setVoiceState("idle");
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : "Unknown connection error";
          setLastResponse(`Orchestrator request failed: ${detail}`);
          setTaskStage("failed", "The request could not be completed.");
          setVoiceState("error");
        });
      return true;
    }

    const command = {
      type: "transcript_final" as const,
      text,
      language: language.slice(0, 32) || "en",
      turnId: `desktop-${globalThis.crypto.randomUUID()}`,
    };
    const socket = wsRef.current;
    if (socket && dispatchTextCommand(socket, command)) return true;

    // Only an unsent command is buffered. An issued action is never replayed automatically.
    pendingTextCommandRef.current = command;
    setPartialTranscript(text);
    setLastResponse("Connecting to Vanessa voice service…");
    setTaskStage("accepted", "Waiting for the local voice service.");
    connectVoiceWs();
    return true;
  }, [connectVoiceWs, dispatchTextCommand, setActivePlan, setCurrentRequestId, setLastResponse, setPendingApproval, setTaskStage, setPartialTranscript, setVoiceState]);

  // Start live microphone capture
  const startRecording = useCallback(async () => {
    if (import.meta.env.VITE_VANESSA_VOICE_ENABLED === "false") {
      setMicError("Voice is disabled for this session. Restart Vanessa without --text-only to use the microphone.");
      return;
    }
    try {
      if (mediaStreamRef.current) return;
      setMicError(null);
      connectVoiceWs();

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        console.warn("[useAudioCapture] Advanced media constraints failed, using basic audio:", err);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      const audioCtx = new AudioCtx();
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      source.connect(analyser);

      // AudioWorklet replaces the deprecated ScriptProcessorNode while keeping
      // microphone processing off the renderer's main UI thread.
      await audioCtx.audioWorklet.addModule(new URL("../audio/pcmCapture.worklet.ts", import.meta.url));
      const processor = new AudioWorkletNode(audioCtx, "vanessa-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const inputData = event.data;
        // Resample from hardware rate (e.g. 48kHz or 44.1kHz) to exact 16kHz
        const resampled = resampleTo16k(inputData, audioCtx.sampleRate);

        // Convert to 16-bit linear PCM
        const pcmBuffer = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const s = Math.max(-1, Math.min(1, resampled[i]));
          pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        const audioFrame = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength);
        // Keep a short local-only lead-in during playback so barge-in does not
        // clip the user's first word. It is sent only after ASR resumes.
        if (pttActiveRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
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

      // Real-time Audio Level visualizer loop for VoiceOrb
      const updateAudioMeter = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const normalized = Math.min(1.0, avg / 128.0);
        setAudioLevel(normalized);

        // Barge-In: if user starts speaking (level > 0.35) while Vanessa is speaking, interrupt!
        if (normalized > 0.35 && voiceStateRef.current === "speaking") {
          triggerBargeIn();
        }

        animationFrameRef.current = requestAnimationFrame(updateAudioMeter);
      };
      updateAudioMeter();

      setIsMicActive(true);
      setVoiceState("idle");
    } catch (err: any) {
      console.error("[useAudioCapture] Failed to access microphone:", err);
      setMicError(err.message || "Microphone access denied");
      setIsMicActive(false);
      setVoiceState("idle");
    }
  }, [connectVoiceWs, setVoiceState, triggerBargeIn]);

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

  const cancelVoice = useCallback(() => {
    pttActiveRef.current = false;
    activatedSocketRef.current = null;
    pendingBargeAudioRef.current = [];
    preRollRef.current = [];
    bargeResumePendingRef.current = false;
    pendingTextCommandRef.current = null;
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
    stopRecording();
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
    if (pttActiveRef.current) {
      pttActiveRef.current = false;
      activatedSocketRef.current = null;
      finalizeListening();
      // Keep audio local while Vanessa responds so onset detection can support
      // barge-in; PCM is sent to ASR only while PTT is active.
    } else {
      // Acquire the microphone only after an explicit PTT action.
      await startRecording();
      if (!mediaStreamRef.current) return;
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
  }, [startRecording, setVoiceState, finalizeListening, stopRecording, activateConnectedSocket, triggerBargeIn]);

  useEffect(() => {
    if (import.meta.env.VITE_VANESSA_VOICE_ENABLED !== "false") connectVoiceWs();
    else setVoiceConnectionState("disabled");
    return () => {
      pttActiveRef.current = false;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      processorRef.current?.disconnect();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close().catch(() => {});
      pendingTextCommandRef.current = null;
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
    voiceConnectionState,
    submitTextCommand,
    cancelVoice,
    startRecording,
    stopRecording,
    toggleRecording,
    resumeAudio,
    triggerBargeIn,
  };
}
