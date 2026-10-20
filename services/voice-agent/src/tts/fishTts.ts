import { VoiceTtsAdapter, TtsOutputChunk } from "./types.js";

export class FishTtsAdapter implements VoiceTtsAdapter {
  private activeAbortController: AbortController | null = null;
  private apiKey: string | undefined;
  private voiceId: string | undefined;
  private model: string;

  constructor(
    apiKey = process.env.FISH_API_KEY,
    voiceId = process.env.FISH_VANESSA_VOICE_ID,
    model = process.env.FISH_MODEL || "s2.1-pro-free"
  ) {
    this.apiKey = apiKey ? apiKey.replace(/"/g, "").trim() : undefined;
    this.voiceId = voiceId ? voiceId.replace(/"/g, "").trim() : undefined;
    this.model = model;
  }

  async streamSpeech(
    text: string,
    onAudioChunk: (chunk: TtsOutputChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.abort();
    this.activeAbortController = new AbortController();
    const effectiveSignal = signal || this.activeAbortController.signal;

    // Sentence/clause boundary chunking for low TTFA
    const clauses = text.split(/(?<=[.!?;\n])\s+/).filter(Boolean);
    const list = clauses.length > 0 ? clauses : [text];

    for (let i = 0; i < list.length; i++) {
      if (effectiveSignal.aborted) break;

      const clause = list[i];
      const isFinal = i === list.length - 1;
      let audioBase64: string | undefined = undefined;

      if (this.apiKey && this.apiKey.startsWith("sk-fish-")) {
        try {
          const body: any = {
            text: clause,
            format: "mp3",
          };
          if (this.voiceId) {
            body.reference_id = this.voiceId;
          }

          const response = await fetch("https://api.fish.audio/v1/tts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${this.apiKey}`,
              "model": this.model,
            },
            body: JSON.stringify(body),
            signal: effectiveSignal,
          });

          if (response.ok) {
            const buffer = await response.arrayBuffer();
            audioBase64 = Buffer.from(buffer).toString("base64");
          } else {
            console.warn(`[FishTtsAdapter] HTTP ${response.status} from Fish Audio`);
          }
        } catch (err: any) {
          if (!effectiveSignal.aborted) {
            console.warn(`[FishTtsAdapter] Fish Audio fetch error: ${err.message}`);
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
