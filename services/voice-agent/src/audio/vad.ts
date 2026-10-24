export interface VadResult {
  isSpeech: boolean;
  energy: number;
  rms: number;
  confidence: number;
}

export class SileroVadDetector {
  private energyThreshold: number;
  private calibrationFrames = 0;
  private calibrationSum = 0;
  private calibrationComplete = false;
  private readonly calibrationFrameCount: number;
  private readonly skipCalibration: boolean;

  constructor(options?: { energyThreshold?: number; calibrationFrames?: number; skipCalibration?: boolean }) {
    this.energyThreshold = options?.energyThreshold ?? (Number(process.env.VOICE_VAD_THRESHOLD) || 120);
    this.calibrationFrameCount = options?.calibrationFrames ?? (Number(process.env.VOICE_VAD_CALIBRATE_MS) ? Math.ceil(Number(process.env.VOICE_VAD_CALIBRATE_MS) / 20) : 25); // default 500ms = 25 frames
    this.skipCalibration = options?.skipCalibration ?? false;
    if (this.skipCalibration) {
      this.calibrationComplete = true;
    }
  }

  /**
   * Get current threshold (after calibration if applicable)
   */
  getThreshold(): number {
    return this.energyThreshold;
  }

  /**
   * Check if calibration is complete
   */
  isCalibrated(): boolean {
    return this.calibrationComplete;
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

    // Calibration phase: measure noise floor
    if (!this.calibrationComplete && this.calibrationFrames < this.calibrationFrameCount) {
      this.calibrationSum += average;
      this.calibrationFrames++;
      if (this.calibrationFrames >= this.calibrationFrameCount) {
        // Set threshold to 3x the average noise floor, minimum 120
        const noiseFloor = this.calibrationSum / this.calibrationFrames;
        this.energyThreshold = Math.max(120, noiseFloor * 3);
        this.calibrationComplete = true;
        console.log(`[VAD] Calibration complete. Noise floor: ${Math.round(noiseFloor)}, threshold set to: ${Math.round(this.energyThreshold)}`);
      }
      // During calibration, treat as silence
      return { isSpeech: false, energy: average, rms: Math.round(rms * 1000) / 1000, confidence: 0 };
    }

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
