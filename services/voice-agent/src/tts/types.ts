import { ProviderRuntimeStatus } from "../asr/types.js";

export interface TtsOutputChunk {
  chunkIndex: number;
  text: string;
  isFinal: boolean;
  audioBase64?: string;
  format?: "mp3" | "pcm_s16le";
  sampleRate?: number;
  fallbackSpeech?: boolean;
}

export interface VoiceTtsAdapter {
  streamSpeech(
    text: string,
    onAudioChunk: (chunk: TtsOutputChunk) => void,
    signal?: AbortSignal
  ): Promise<void>;
  abort(): void;
  getProviderStatus?(): ProviderRuntimeStatus;
  setStatusHandler?(handler: (status: ProviderRuntimeStatus) => void): void;
}
