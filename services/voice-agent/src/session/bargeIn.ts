export class BargeInDetector {
  private consecutiveSpeechChunks = 0;

  /**
   * Determine if incoming speech frame should interrupt the speaking agent
   * @param isSpeech whether current 20ms chunk contains speech energy
   * @param isAgentSpeaking whether Vanessa is actively outputting audio
   * @returns true if user has spoken continuously for >= 240ms (12 chunks * 20ms)
   */
  shouldInterrupt(isSpeech: boolean, isAgentSpeaking: boolean): boolean {
    if (!isAgentSpeaking) {
      this.consecutiveSpeechChunks = 0;
      return false;
    }

    if (isSpeech) {
      this.consecutiveSpeechChunks += 1;
    } else {
      this.consecutiveSpeechChunks = 0;
    }

    // Require around 240ms of speech to avoid false interrupts (e.g., keyboard click or cough)
    return this.consecutiveSpeechChunks >= 12;
  }

  reset(): void {
    this.consecutiveSpeechChunks = 0;
  }

  getConsecutiveChunks(): number {
    return this.consecutiveSpeechChunks;
  }
}
