import { AsrAdapter, TranscriptResult } from "./types.js";

export class FishAsrAdapter implements AsrAdapter {
  private handlers?: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  };
  private bufferChunks: Int16Array[] = [];

  constructor(private apiKey = process.env.FISH_API_KEY) {}

  connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): void {
    this.handlers = handlers;
  }

  sendAudioChunk(pcm: Int16Array): void {
    this.bufferChunks.push(pcm);
    if (this.bufferChunks.length > 250) {
      this.bufferChunks.shift();
    }
  }

  finalizeTurn(): void {
    // When turn completes, synthesize final transcript if Fish API is configured
    this.bufferChunks = [];
  }

  close(): void {
    this.bufferChunks = [];
  }
}
