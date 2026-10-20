export type TranscriptResult = {
  text: string;
  isFinal: boolean;
  language: string;
  confidence?: number;
};

export interface AsrAdapter {
  name?: string;
  connect(handlers: {
    onPartial: (result: TranscriptResult) => void;
    onFinal: (result: TranscriptResult) => void;
  }): Promise<void> | void;
  sendAudioChunk(pcm: Int16Array): void;
  finalizeTurn?(): void;
  activateStream?(durationMs?: number): void;
  deactivateStream?(): void;
  close(): void;
}
