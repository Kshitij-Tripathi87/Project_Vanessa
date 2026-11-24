import type { ProviderRuntimeStatus } from "../asr/types.js";
import type { TtsOutputChunk, VoiceTtsAdapter } from "./types.js";

/** Request on-device system speech in the renderer without contacting a provider. */
export class BrowserTtsAdapter implements VoiceTtsAdapter {
  getProviderStatus(): ProviderRuntimeStatus {
    return {
      requested: "On-device speech",
      active: "On-device speech",
      state: "idle",
      detail: "Requires an available local system voice in the desktop runtime.",
    };
  }

  setStatusHandler(handler: (status: ProviderRuntimeStatus) => void): void {
    handler(this.getProviderStatus());
  }

  async streamSpeech(text: string, onAudioChunk: (chunk: TtsOutputChunk) => void, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (text.trim()) onAudioChunk({ chunkIndex: 0, text, isFinal: true, fallbackSpeech: true });
  }

  abort(): void { /* Playback is fenced and cancelled by the desktop. */ }
}
