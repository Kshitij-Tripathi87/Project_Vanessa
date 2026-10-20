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
  const { voiceState, setVoiceState, setLastResponse, setActivePlan } = useVanessaStore();

  const [isMicActive, setIsMicActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0); // 0.0 to 1.0 for VoiceOrb scaling
  const [liveSentiment, setLiveSentiment] = useState<SentimentData | null>(null);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [micError, setMicError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Audio Playback Queue for low-latency streaming TTS chunks
  const audioQueueRef = useRef<Array<{
    text: string;
    audioBase64?: string;
    speechRate: number;
    speechPitch: number;
    isFinal: boolean;
  }>>([]);
  const isPlayingQueueRef = useRef<boolean>(false);
  const activeSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  const playNextInQueue = useCallback(async () => {
    if (isPlayingQueueRef.current || audioQueueRef.current.length === 0) {
      return;
    }

    const item = audioQueueRef.current.shift()!;
    isPlayingQueueRef.current = true;

    // 1. Play synthesized audio buffer if base64 provided
    if (item.audioBase64 && (window.AudioContext || (window as any).webkitAudioContext)) {
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
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
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        activeSourceNodeRef.current = source;
        source.connect(audioCtx.destination);

        source.onended = () => {
          isPlayingQueueRef.current = false;
          activeSourceNodeRef.current = null;
          if (item.isFinal) {
            setVoiceState("idle");
          }
          playNextInQueue();
        };
        source.start(0);
        return;
      } catch (err) {
        console.warn("[useAudioCapture] AudioBuffer decode/play error, fallback to SpeechSynthesis:", err);
      }
    }

    // 2. Client-side SpeechSynthesis fallback with emotion-modulated rate & pitch
    if ("speechSynthesis" in window && item.text) {
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.rate = item.speechRate || 1.05;
      utterance.pitch = item.speechPitch || 1.02;

      utterance.onend = () => {
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
        }
        playNextInQueue();
      };
      utterance.onerror = () => {
        isPlayingQueueRef.current = false;
        if (item.isFinal) {
          setVoiceState("idle");
        }
        playNextInQueue();
      };
      window.speechSynthesis.speak(utterance);
    } else {
      isPlayingQueueRef.current = false;
      if (item.isFinal) {
        setVoiceState("idle");
      }
      playNextInQueue();
    }
  }, [setVoiceState]);

  // Barge-In interrupt handler: cancels playback immediately and notifies server
  const triggerBargeIn = useCallback(() => {
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
    setVoiceState("listening");
  }, [setVoiceState]);

  // Initialize WebSocket connection to Voice Agent (Port 4500 with 4319 fallback)
  const connectVoiceWs = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Try WhisperFlow realtime service first, fallback to orchestrator voice stream
    const primaryUrl = "ws://127.0.0.1:4500/ws";
    const fallbackUrl = "ws://127.0.0.1:4319/voice/stream";

    let ws = new WebSocket(primaryUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[useAudioCapture] Connected to Vanessa Voice Real-Time WebSocket on port 4500");
    };

    ws.onerror = () => {
      if (ws.url.includes("4500")) {
        console.log("[useAudioCapture] Port 4500 unavailable, switching to orchestrator voice stream on port 4319");
        const fallbackWs = new WebSocket(fallbackUrl);
        wsRef.current = fallbackWs;
        attachMessageHandlers(fallbackWs);
      }
    };

    const attachMessageHandlers = (targetWs: WebSocket) => {
      targetWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

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
            setVoiceState(msg.state);
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
          }

          // Low-latency streaming TTS sentence chunk
          if (msg.type === "tts_chunk") {
            setVoiceState("speaking");
            audioQueueRef.current.push({
              text: msg.text,
              audioBase64: msg.audioBase64,
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

      targetWs.onclose = () => {
        setTimeout(connectVoiceWs, 3000);
      };
    };

    attachMessageHandlers(ws);
  }, [setVoiceState, setLastResponse, setActivePlan, playNextInQueue]);


  // Start live microphone capture
  const startRecording = useCallback(async () => {
    try {
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

      // Audio processor node to convert Float32 to 16-bit PCM for real-time streaming
      const processor = audioCtx.createScriptProcessor(1024, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Resample from hardware rate (e.g. 48kHz or 44.1kHz) to exact 16kHz
        const resampled = resampleTo16k(inputData, audioCtx.sampleRate);

        // Convert to 16-bit linear PCM
        const pcmBuffer = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const s = Math.max(-1, Math.min(1, resampled[i]));
          pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Stream binary 16-bit PCM buffer directly (server frames into 20ms chunks)
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(pcmBuffer.buffer);
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
        if (normalized > 0.35 && voiceState === "speaking") {
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
  const stopRecording = useCallback(() => {
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

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    setIsMicActive(false);
    setAudioLevel(0);
    if (voiceState === "listening") {
      setVoiceState("idle");
    }
  }, [voiceState, setVoiceState]);

  const resumeAudio = useCallback(async () => {
    if (audioContextRef.current && audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
      console.log("[useAudioCapture] AudioContext successfully resumed!");
    }
    if (!isMicActive) {
      await startRecording();
    }
  }, [isMicActive, startRecording]);

  const finalizeListening = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "finalize" }));
    }
    setVoiceState("thinking");
  }, [setVoiceState]);

  const toggleRecording = useCallback(async () => {
    await resumeAudio();
    if (voiceState === "listening") {
      // User tapped orb again to conclude speaking -> finalize turn immediately
      finalizeListening();
    } else {
      // User tapped orb to start speaking -> activate listening
      setVoiceState("listening");
      setPartialTranscript("");
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "activate" }));
      }
    }
  }, [resumeAudio, voiceState, setVoiceState, finalizeListening]);

  useEffect(() => {
    connectVoiceWs();
    // Auto-start ambient hands-free listening on launch (no buttons or clicks needed)
    startRecording();
    return () => {
      stopRecording();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectVoiceWs, startRecording, stopRecording]);

  return {
    isMicActive,
    audioLevel,
    liveSentiment,
    partialTranscript,
    micError,
    startRecording,
    stopRecording,
    toggleRecording,
    resumeAudio,
    triggerBargeIn,
  };
}
