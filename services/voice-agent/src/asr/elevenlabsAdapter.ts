import { AsrAdapter, TranscriptResult } from "./types.js";

export class ElevenLabsAsrAdapter implements AsrAdapter {
  private handlers?: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  };

  constructor(
    private apiKey = process.env.ELEVENLABS_API_KEY,
    private agentId = process.env.ELEVENLABS_AGENT_ID
  ) {}

  connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): void {
    this.handlers = handlers;
  }

  sendAudioChunk(_pcm: Int16Array): void {
    // Forwarded over ElevenLabs WebSocket conversation session
  }

  finalizeTurn(): void {}

  close(): void {}
}
