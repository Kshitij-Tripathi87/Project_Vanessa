import { VoiceTtsAdapter, TtsOutputChunk } from "./types.js";
import { ProviderRuntimeStatus } from "../asr/types.js";

export class FishTtsAdapter implements VoiceTtsAdapter {
  private activeAbortController: AbortController | null = null;
  private apiKey: string | undefined;
  private voiceId: string | undefined;
  private model: string;
  private status: ProviderRuntimeStatus = { requested: "Fish Audio", active: "Fish Audio", state: "idle" };
  private statusHandler?: (status: ProviderRuntimeStatus) => void;

  constructor(
    apiKey = process.env.FISH_API_KEY,
    voiceId = process.env.FISH_VANESSA_VOICE_ID,
    model = process.env.FISH_MODEL || "s2.1-pro-free"
  ) {
    this.apiKey = apiKey ? apiKey.replace(/"/g, "").trim() : undefined;
    this.voiceId = voiceId ? voiceId.replace(/"/g, "").trim() : undefined;
    this.model = model;
  }

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

    // Sentence/clause boundary chunking for low TTFA
    const clauses = text.split(/(?<=[.!?;\n])\s+/).filter(Boolean);
    const list = clauses.length > 0 ? clauses : [text];
    let useBrowserFallback = !this.apiKey || !this.apiKey.startsWith("sk-fish-");
    if (useBrowserFallback) {
      this.setStatus({ requested: "Fish Audio", active: "Browser Speech Synthesis", state: "fallback", detail: "Fish API key is missing or invalid." });
    } else {
      this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "connecting" });
    }

    for (let i = 0; i < list.length; i++) {
      if (effectiveSignal.aborted) break;

      const clause = list[i];
      const isFinal = i === list.length - 1;
      let audioBase64: string | undefined = undefined;

      if (!useBrowserFallback) {
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
            this.setStatus({ requested: "Fish Audio", active: "Fish Audio", state: "ready" });
          } else {
            console.warn(`[FishTtsAdapter] HTTP ${response.status} from Fish Audio`);
            useBrowserFallback = true;
            this.setStatus({ requested: "Fish Audio", active: "Browser Speech Synthesis", state: "fallback", detail: `Fish Audio returned HTTP ${response.status}.` });
          }
        } catch (err: any) {
          if (!effectiveSignal.aborted) {
            console.warn(`[FishTtsAdapter] Fish Audio fetch error: ${err.message}`);
            useBrowserFallback = true;
            this.setStatus({ requested: "Fish Audio", active: "Browser Speech Synthesis", state: "fallback", detail: "Fish Audio request failed; using browser speech synthesis." });
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
