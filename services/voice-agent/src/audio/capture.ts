export type AudioChunk = {
  pcm: Int16Array;
  sampleRate: 16000;
  durationMs: 20;
};

export class AudioCapture {
  private audioContext?: AudioContext;
  private mediaStream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private onChunk?: (chunk: AudioChunk) => void;

  /**
   * Start live microphone capture in browser / Electron environment
   */
  async start(onChunk: (chunk: AudioChunk) => void): Promise<void> {
    this.onChunk = onChunk;

    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtx = typeof window !== "undefined" ? (window.AudioContext || (window as any).webkitAudioContext) : null;
      if (!AudioCtx) return;
      this.audioContext = new AudioCtx({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // 320 samples per buffer at 16kHz = 20ms audio frame
      this.processor = this.audioContext.createScriptProcessor(320, 1, 1);
      this.processor.onaudioprocess = (event: any) => {
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          pcm[i] = Math.max(-32768, Math.min(32767, Math.floor(input[i] * 32767)));
        }
        this.onChunk?.({ pcm, sampleRate: 16000, durationMs: 20 });
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
    }
  }

  stop(): void {
    this.processor?.disconnect();
    this.mediaStream?.getTracks().forEach((track: any) => track.stop());
    this.audioContext?.close().catch(() => {});
  }

  /**
   * Node.js streaming utility: Slices continuous incoming binary PCM buffer into fixed 20ms chunks (320 samples / 640 bytes)
   */
  static framePcmBuffer(buffer: Buffer): AudioChunk[] {
    const CHUNK_BYTES = 640; // 320 samples * 2 bytes
    const chunks: AudioChunk[] = [];

    for (let offset = 0; offset + CHUNK_BYTES <= buffer.length; offset += CHUNK_BYTES) {
      const slice = buffer.subarray(offset, offset + CHUNK_BYTES);
      const copy = Buffer.from(slice);
      const pcm = new Int16Array(
        copy.buffer,
        copy.byteOffset,
        CHUNK_BYTES / 2
      );
      chunks.push({
        pcm,
        sampleRate: 16000,
        durationMs: 20,
      });
    }

    return chunks;
  }
}

/**
 * Stateful audio frame accumulator: buffers any remaining unaligned bytes
 * between successive WebSocket messages so zero audio data is lost.
 */
export class PcmFrameAccumulator {
  private remainder = Buffer.alloc(0);
  private readonly chunkBytes: number;

  constructor(chunkSamples = 320) {
    this.chunkBytes = chunkSamples * 2;
  }

  feed(data: Buffer): AudioChunk[] {
    const combined = this.remainder.length > 0 ? Buffer.concat([this.remainder, data]) : data;
    const chunks: AudioChunk[] = [];
    let offset = 0;

    while (offset + this.chunkBytes <= combined.length) {
      const slice = combined.subarray(offset, offset + this.chunkBytes);
      const copy = Buffer.from(slice);
      const pcm = new Int16Array(
        copy.buffer,
        copy.byteOffset,
        this.chunkBytes / 2
      );
      chunks.push({
        pcm,
        sampleRate: 16000,
        durationMs: 20,
      });
      offset += this.chunkBytes;
    }

    this.remainder = Buffer.from(combined.subarray(offset));
    return chunks;
  }

  reset(): void {
    this.remainder = Buffer.alloc(0);
  }
}
