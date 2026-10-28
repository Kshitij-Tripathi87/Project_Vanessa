export interface WakeWordResult {
  detected: boolean;
  cleanedText: string;
}

export class WakeWordDetector {
  private wakeWords = ["hey vanessa", "vanessa", "ok vanessa", "okay vanessa"];
  private isActiveSession = false;
  private sessionTimeout: NodeJS.Timeout | null = null;

  /**
   * Check if transcript contains the wake word "Hey Vanessa"
   */
  processTranscript(text: string): WakeWordResult {
    const lower = text.toLowerCase().trim();

    for (const phrase of this.wakeWords) {
      const suffix = lower.slice(phrase.length, phrase.length + 1);
      const hasWakeBoundary = lower === phrase || /^[\s,!.?;:'"-]$/.test(suffix);
      if (lower.startsWith(phrase) && hasWakeBoundary) {
        this.touchActiveSession();
        // Clean off the wake word prefix and punctuation
        const remainder = lower.substring(phrase.length).replace(/^[,\s.!?;:'"-]+/, "").replace(/[.!?]+$/, "").trim();
        return {
          detected: true,
          cleanedText: remainder,
        };
      }
    }

    if (this.isActiveSession) {
      // Already in an active conversation turn, no need to repeat "Hey Vanessa"
      return {
        detected: true,
        cleanedText: text,
      };
    }

    return {
      detected: false,
      cleanedText: text,
    };
  }

  touchActiveSession(durationMs = 15000): void {
    this.isActiveSession = true;
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
    }
    this.sessionTimeout = setTimeout(() => {
      this.isActiveSession = false;
    }, durationMs);
  }

  resetSession(): void {
    this.isActiveSession = false;
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }
  }

  isSessionActive(): boolean {
    return this.isActiveSession;
  }
}

export const wakeWordDetector = new WakeWordDetector();
