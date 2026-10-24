export interface VadResult {
  isSpeech: boolean;
  energy: number;
  rms: number;
  confidence: number;
}

export class SileroVadDetector {
  private energyThreshold: number;

  constructor(options?: { energyThreshold?: number }) {
    this.energyThreshold = options?.energyThreshold ?? 120;
  }

  /**
   * Process 20ms PCM audio frame (320 samples @ 16kHz)
   */
  processChunk(pcm: Int16Array): VadResult {
    if (pcm.length === 0) {
      return { isSpeech: false, energy: 0, rms: 0, confidence: 0 };
    }

    let sum = 0;
    let sumSquares = 0;

    for (let i = 0; i < pcm.length; i++) {
      const val = pcm[i];
      sum += Math.abs(val);
      sumSquares += val * val;
    }

    const average = sum / pcm.length;
    const rms = Math.sqrt(sumSquares / pcm.length) / 32768.0;
    const isSpeech = average > this.energyThreshold;
    const confidence = isSpeech ? Math.min(1.0, average / (this.energyThreshold * 2.5)) : 0.0;

    return {
      isSpeech,
      energy: average,
      rms: Math.round(rms * 1000) / 1000,
      confidence: Math.round(confidence * 100) / 100,
    };
  }
}

export const vadDetector = new SileroVadDetector();
