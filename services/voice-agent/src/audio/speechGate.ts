/**
 * Gates quiet microphone frames before they are forwarded to Sarvam realtime STT
 * when the adapter is in manual-endpointing mode.
 *
 * Keep a short pre-roll so plosive/consonant onsets are not clipped. Continue
 * sending a bounded silence tail after speech, then retain only a local ring
 * buffer until the next speech onset.
 */
export class SpeechAudioGate {
  private readonly preRollFrames: number;
  private readonly trailingSilenceFrames: number;
  private preRoll: Int16Array[] = [];
  private speechActive = false;
  private trailingFrames = 0;

  constructor(options: { preRollFrames?: number; trailingSilenceFrames?: number } = {}) {
    this.preRollFrames = Math.max(1, Math.floor(options.preRollFrames ?? 10));
    this.trailingSilenceFrames = Math.max(0, Math.floor(options.trailingSilenceFrames ?? 12));
  }

  push(frame: Int16Array, isSpeech: boolean): Int16Array[] {
    if (frame.length === 0) return [];

    if (!this.speechActive) {
      this.remember(frame);
      if (!isSpeech) return [];
      this.speechActive = true;
      this.trailingFrames = 0;
      const frames = this.preRoll;
      this.preRoll = [];
      return frames;
    }

    if (isSpeech) {
      this.trailingFrames = 0;
      return [frame];
    }

    if (this.trailingFrames < this.trailingSilenceFrames) {
      this.trailingFrames++;
      return [frame];
    }

    this.speechActive = false;
    this.trailingFrames = 0;
    this.remember(frame);
    return [];
  }

  reset(): void {
    this.preRoll = [];
    this.speechActive = false;
    this.trailingFrames = 0;
  }

  private remember(frame: Int16Array): void {
    // Copy: callers typically reuse audio buffers after the current callback.
    this.preRoll.push(frame.slice());
    while (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
  }
}
