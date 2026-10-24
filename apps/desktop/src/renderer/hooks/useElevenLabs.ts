import { useState, useCallback } from "react";
import { useVanessaStore } from "../stores/vanessaStore.js";

export function useElevenLabs() {
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const { setVoiceState, setLastResponse, setActivePlan } = useVanessaStore();

  const startSession = useCallback(async () => {
    try {
      setVoiceState("listening");
      // Connect to ElevenLabs session endpoint or local bridge
      const res = await fetch("http://127.0.0.1:4139/voice/session");
      const data = (await res.json()) as any;

      if (data.signedUrl) {
        // Initialize ElevenLabs WebSocket or WebRTC
        setIsConnected(true);
      } else {
        // Local mode
        setIsConnected(true);
      }
    } catch {
      setIsConnected(false);
    }
  }, [setVoiceState]);

  const executeSpeechCommand = useCallback(
    async (command: string, language: string = "en") => {
      setVoiceState("thinking");
      try {
        const result = await window.vanessa.executeCommand({ command, language });
        if (result.plan) {
          setActivePlan(result.plan);
        }
        setLastResponse(result.spokenSummary);
        setVoiceState(result.status === "awaiting_approval" ? "listening" : "speaking");

        // Speech synthesis if Web Speech API available
        if ("speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(result.spokenSummary);
          utterance.rate = 1.05;
          utterance.pitch = 1.02;
          utterance.onstart = () => setIsSpeaking(true);
          utterance.onend = () => {
            setIsSpeaking(false);
            setVoiceState("idle");
          };
          window.speechSynthesis.speak(utterance);
        } else {
          setTimeout(() => setVoiceState("idle"), 2500);
        }

        // Match the voice client's complete result instead of dropping plan,
        // pendingTasks, requestId, and verification at this boundary.
        return result;
      } catch (err: any) {
        setVoiceState("error");
        setLastResponse(`Error executing command: ${err.message}`);
        return { status: "failed", spokenSummary: "Could not execute task." };
      }
    },
    [setVoiceState, setActivePlan, setLastResponse]
  );

  return {
    isConnected,
    isSpeaking,
    startSession,
    executeSpeechCommand,
  };
}
