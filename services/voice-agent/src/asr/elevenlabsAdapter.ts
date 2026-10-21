import { AsrAdapter, ProviderRuntimeStatus, TranscriptResult } from "./types.js";

export class ElevenLabsAsrAdapter implements AsrAdapter {
  private statusHandler?: (status: ProviderRuntimeStatus) => void;
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
    this.statusHandler?.({ requested: "ElevenLabs", active: "Unavailable", state: "error", detail: "ElevenLabs realtime ASR is not implemented in this build." });
    throw new Error("ElevenLabs realtime ASR is not implemented in this build.");
  }

  getProviderStatus(): ProviderRuntimeStatus {
    return { requested: "ElevenLabs", active: "Unavailable", state: "error", detail: "ElevenLabs realtime ASR is not implemented in this build." };
  }

  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    this.statusHandler = handler;
    handler(this.getProviderStatus());
  }

  sendAudioChunk(_pcm: Int16Array): void {
    // Forwarded over ElevenLabs WebSocket conversation session
  }

  finalizeTurn(): void {}

  close(): void {}
}
