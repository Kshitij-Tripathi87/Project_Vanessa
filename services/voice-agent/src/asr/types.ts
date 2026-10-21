export type TranscriptResult = {
  text: string;
  isFinal: boolean;
  language: string;
  confidence?: number;
  turnId?: string;
};

export interface ProviderRuntimeStatus {
  requested: string;
  active: string;
  state: "idle" | "connecting" | "ready" | "fallback" | "error";
  detail?: string;
}

export interface AsrAdapter {
  name?: string;
  /** True when the provider, rather than local silence timing, commits turns. */
  usesServerTurnDetection?: boolean;
  connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): Promise<void> | void;
  sendAudioChunk(pcm: Int16Array): void;
  finalizeTurn?(): void;
  activateStream?(durationMs?: number): void;
  deactivateStream?(): void;
  getProviderStatus?(): ProviderRuntimeStatus;
  setStatusHandler?(handler: (status: ProviderRuntimeStatus) => void): void;
  close(): void;
}
