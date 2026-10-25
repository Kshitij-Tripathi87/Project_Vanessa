import { AsrAdapter, ProviderRuntimeStatus, TranscriptResult } from "./types.js";

export class ElevenLabsAsrAdapter implements AsrAdapter {
  private statusHandler?: (status: ProviderRuntimeStatus) => void;

  connect(_handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): void {
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
