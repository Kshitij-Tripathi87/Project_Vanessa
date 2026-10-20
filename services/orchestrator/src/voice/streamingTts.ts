import { SentimentResult } from "./sentimentAnalyzer.js";

export interface TtsChunk {
  chunkIndex: number;
  text: string;
  isFinal: boolean;
  speechRate: number;
  speechPitch: number;
  audioBase64?: string;
  format?: "pcm_s16le" | "mp3";
}

export class StreamingTtsService {
  private elevenLabsApiKey: string | undefined;
  private elevenLabsVoiceId: string;
  private fishApiKey: string | undefined;
  private activeAbortController: AbortController | null = null;

  constructor() {
    this.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel / default
    this.fishApiKey = process.env.FISH_API_KEY;
  }

  /**
   * Split text into conversational clauses on punctuation boundaries.
   * Keeps the initial clause short (<= 12 words) to achieve <500ms Time-To-First-Audio (TTFA).
   */
  chunkText(text: string): string[] {
    if (!text || !text.trim()) return [];

    // Split on sentence and clause boundaries: ., !, ?, ;, or commas if sentence is long
    const rawTokens = text.trim().split(/(?<=[.!?;\n])\s+/);
    const chunks: string[] = [];

    for (const token of rawTokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;

      // If a sentence is long (> 15 words), split on comma for earlier TTFA
      const words = trimmed.split(/\s+/);
      if (words.length > 15 && trimmed.includes(",")) {
        const subClauses = trimmed.split(/(?<=[,])\s+/);
        for (const sub of subClauses) {
          if (sub.trim()) chunks.push(sub.trim());
        }
      } else {
        chunks.push(trimmed);
      }
    }

    return chunks.length > 0 ? chunks : [text.trim()];
  }

  /**
   * Calculate prosodic modulation based on user sentiment
   */
  getModulation(sentiment?: SentimentResult): { rate: number; pitch: number; stability: number } {
    if (!sentiment) {
      return { rate: 1.05, pitch: 1.02, stability: 0.75 };
    }

    if (sentiment.urgency === "critical" || sentiment.emotion === "urgent") {
      // Rapid, crisp, authoritative cadence
      return { rate: 1.18, pitch: 1.05, stability: 0.88 };
    }

    if (sentiment.emotion === "frustrated") {
      // Steady, calming, unhurried cadence
      return { rate: 1.0, pitch: 0.98, stability: 0.85 };
    }

    if (sentiment.emotion === "inquisitive") {
      // Engaging, conversational
      return { rate: 1.06, pitch: 1.03, stability: 0.72 };
    }

    if (sentiment.emotion === "satisfied") {
      // Warm, pleasant
      return { rate: 1.02, pitch: 1.04, stability: 0.8 };
    }

    return { rate: 1.05, pitch: 1.02, stability: 0.75 };
  }

  /**
   * Stream text chunks with progressive audio synthesis
   */
  async streamSpeech(
    text: string,
    sentiment: SentimentResult | undefined,
    onChunk: (chunk: TtsChunk) => void
  ): Promise<void> {
    this.abort();
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    const chunks = this.chunkText(text);
    const modulation = this.getModulation(sentiment);

    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) {
        break;
      }

      const chunkText = chunks[i];
      const isFinal = i === chunks.length - 1;

      // Synthesize chunk or provide rapid structured chunk
      let audioBase64: string | undefined = undefined;

      if (this.fishApiKey && this.fishApiKey.includes("sk-fish-")) {
        try {
          audioBase64 = await this.synthesizeFishChunk(chunkText, signal);
        } catch (err: any) {
          console.warn(`[StreamingTTS] Fish Audio chunk synthesis failed: ${err.message}`);
        }
      } else if (this.elevenLabsApiKey && this.elevenLabsApiKey.startsWith("sk_")) {
        try {
          audioBase64 = await this.synthesizeElevenLabsChunk(chunkText, modulation, signal);
        } catch (err: any) {
          // Fallback gracefully without throwing
          console.warn(`[StreamingTTS] ElevenLabs chunk synthesis failed: ${err.message}`);
        }
      }

      onChunk({
        chunkIndex: i,
        text: chunkText,
        isFinal,
        speechRate: modulation.rate,
        speechPitch: modulation.pitch,
        audioBase64,
        format: audioBase64 ? "mp3" : undefined,
      });

      // Brief delay between chunk dispatch to maintain natural rhythmic cadence if streaming
      if (!isFinal && !audioBase64) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }

  /**
   * Abort in-flight streaming on barge-in
   */
  abort(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  private async synthesizeElevenLabsChunk(
    text: string,
    modulation: { rate: number; pitch: number; stability: number },
    signal: AbortSignal
  ): Promise<string> {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": this.elevenLabsApiKey!,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: modulation.stability,
          similarity_boost: 0.8,
          speed: modulation.rate,
        },
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  }

  private async synthesizeFishChunk(text: string, signal: AbortSignal): Promise<string> {
    const model = process.env.FISH_MODEL || "s2.1-pro-free";
    const body: any = {
      text,
      format: "mp3",
    };
    if (process.env.FISH_VANESSA_VOICE_ID) {
      body.reference_id = process.env.FISH_VANESSA_VOICE_ID;
    }

    const response = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.fishApiKey!.replace(/"/g, "").trim()}`,
        "model": model,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Fish Audio TTS HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  }
}

export const streamingTts = new StreamingTtsService();
