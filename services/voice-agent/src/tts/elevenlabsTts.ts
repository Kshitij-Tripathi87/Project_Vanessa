import { VoiceTtsAdapter, TtsOutputChunk } from "./types.js";
import { ProviderRuntimeStatus } from "../asr/types.js";

export class ElevenLabsTtsAdapter implements VoiceTtsAdapter {
  private activeAbortController: AbortController | null = null;
  private status: ProviderRuntimeStatus = { requested: "ElevenLabs", active: "ElevenLabs", state: "idle" };
  private statusHandler?: (status: ProviderRuntimeStatus) => void;

  constructor(
    private apiKey = process.env.ELEVENLABS_API_KEY,
    private voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"
  ) {}

  getProviderStatus(): ProviderRuntimeStatus {
    return { ...this.status };
  }

  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    this.statusHandler = handler;
    handler(this.getProviderStatus());
  }

  private setStatus(status: ProviderRuntimeStatus): void {
    this.status = status;
    this.statusHandler?.(this.getProviderStatus());
  }

  async streamSpeech(
    text: string,
    onAudioChunk: (chunk: TtsOutputChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.abort();
    this.activeAbortController = new AbortController();
    const effectiveSignal = signal || this.activeAbortController.signal;

    const clauses = text.split(/(?<=[.!?;\n])\s+/).filter(Boolean);
    const list = clauses.length > 0 ? clauses : [text];
    const configured = Boolean(this.apiKey && this.apiKey.startsWith("sk_"));
    this.setStatus(configured
      ? { requested: "ElevenLabs", active: "ElevenLabs", state: "connecting" }
      : { requested: "ElevenLabs", active: "Browser Speech Synthesis", state: "fallback", detail: "ElevenLabs API key is missing or invalid." });

    for (let i = 0; i < list.length; i++) {
      if (effectiveSignal.aborted) break;

      const clause = list[i];
      const isFinal = i === list.length - 1;
      let audioBase64: string | undefined = undefined;

      if (this.apiKey && this.apiKey.startsWith("sk_")) {
        try {
          const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": this.apiKey,
            },
            body: JSON.stringify({
              text: clause,
              model_id: "eleven_turbo_v2_5",
            }),
            signal: effectiveSignal,
          });
          if (res.ok) {
            const buffer = await res.arrayBuffer();
            audioBase64 = Buffer.from(buffer).toString("base64");
            this.setStatus({ requested: "ElevenLabs", active: "ElevenLabs", state: "ready" });
          } else {
            this.setStatus({ requested: "ElevenLabs", active: "Browser Speech Synthesis", state: "fallback", detail: `ElevenLabs returned HTTP ${res.status}.` });
          }
        } catch {
          if (!effectiveSignal.aborted) {
            this.setStatus({ requested: "ElevenLabs", active: "Browser Speech Synthesis", state: "fallback", detail: "ElevenLabs request failed; using browser speech synthesis." });
          }
        }
      }

      onAudioChunk({
        chunkIndex: i,
        text: clause,
        isFinal,
        audioBase64,
        format: audioBase64 ? "mp3" : undefined,
      });

      if (!isFinal && !audioBase64) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }

  abort(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }
}
