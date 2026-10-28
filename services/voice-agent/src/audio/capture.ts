/** Audio frame contract shared by the voice session and PCM transport. */
export type AudioChunk = {
  pcm: Int16Array;
  sampleRate: 16000;
  durationMs: 20;
};

/**
 * Stateful service-side PCM frame accumulator. It preserves unaligned bytes
 * between WebSocket messages so network packet boundaries cannot drop audio.
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
