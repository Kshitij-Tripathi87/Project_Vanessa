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
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    for (const phrase of this.wakeWords) {
      if (lower.startsWith(phrase)) {
        this.touchActiveSession();
        // Clean off the wake word prefix and punctuation
        const remainder = lower.substring(phrase.length).replace(/^[,\s.!?\-]+/, "").replace(/[.!?]+$/, "").trim();
        return {
          detected: true,
          cleanedText: remainder,
        };
      }
      if (lower.includes(phrase)) {
        this.touchActiveSession();
        const parts = lower.split(phrase);
        const remainder = parts.slice(1).join(" ").replace(/^[,\s.!?\-]+/, "").replace(/[.!?]+$/, "").trim();
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
