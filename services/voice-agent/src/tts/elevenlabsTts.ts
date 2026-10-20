import { VoiceTtsAdapter, TtsOutputChunk } from "./types.js";

export class ElevenLabsTtsAdapter implements VoiceTtsAdapter {
  private activeAbortController: AbortController | null = null;

  constructor(
    private apiKey = process.env.ELEVENLABS_API_KEY,
    private voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"
  ) {}

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
          }
        } catch {}
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
