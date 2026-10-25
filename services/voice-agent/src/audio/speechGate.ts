/** Suppress leading silence only. Preserve pauses/trailing silence for endpointing. */
export class SpeechGate {
  private preRoll: Int16Array[] = [];
  private open = false;

  process(pcm: Int16Array, isSpeech: boolean): Int16Array[] {
    if (this.open) return [pcm];
    this.preRoll.push(pcm.slice());
    // Ten exact 20ms frames, local only until speech onset.
    if (this.preRoll.length > 10) this.preRoll.shift();
    if (!isSpeech) return [];
    this.open = true;
    const frames = this.preRoll;
    this.preRoll = [];
    return frames;
  }

  reset(): void { this.open = false; this.preRoll = []; }
}
