import { assertHostedEgress, denyHostedEgress, type HostedEgressPolicy } from "@vanessa/shared";

/** Applies to session admission, not to raw internal adapter test fixtures. */
export function assertVoiceProviderPermission(
  kind: "asr" | "tts",
  provider: string,
  policy: HostedEgressPolicy = denyHostedEgress,
): void {
  if (kind === "asr" && (provider === "whisper" || provider === "voice")) return;
  if (kind === "tts" && provider === "browser") return;
  if (provider !== "fish" && provider !== "sarvam" && provider !== "elevenlabs") return;
  const endpoint = provider === "fish"
    ? kind === "asr" ? (process.env.FISH_ASR_URL || "wss://api.fish.audio/v1/asr/realtime") : (process.env.FISH_TTS_URL || "wss://api.fish.audio/v1/tts/live")
    : provider === "sarvam"
      ? kind === "asr" ? (process.env.SARVAM_ASR_URL || "wss://api.sarvam.ai/speech-to-text-realtime/ws") : (process.env.SARVAM_TTS_URL || "wss://api.sarvam.ai/text-to-speech/ws")
      : "https://api.elevenlabs.io";
  assertHostedEgress(policy, provider, kind === "asr" ? "speech_input" : "speech_output", endpoint);
}
