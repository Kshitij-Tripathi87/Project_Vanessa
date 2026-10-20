import { useState, useCallback } from "react";
import { useVanessaStore } from "../stores/vanessaStore.js";

export function useFishVoice() {
  const [isStreaming, setIsStreaming] = useState(false);
  const { setVoiceState, setLastResponse } = useVanessaStore();

  const speakTextStream = useCallback(
    async (text: string) => {
      setVoiceState("speaking");
      setIsStreaming(true);

      // Simulates or connects to Fish Audio stream_websocket
      try {
        if ("speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.onend = () => {
            setIsStreaming(false);
            setVoiceState("idle");
          };
          window.speechSynthesis.speak(utterance);
        } else {
          setTimeout(() => {
            setIsStreaming(false);
            setVoiceState("idle");
          }, 2000);
        }
      } catch {
        setIsStreaming(false);
        setVoiceState("idle");
      }
    },
    [setVoiceState]
  );

  return {
    isStreaming,
    speakTextStream,
  };
}
