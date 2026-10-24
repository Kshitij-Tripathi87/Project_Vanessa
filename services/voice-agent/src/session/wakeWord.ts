export interface WakeWordResult {
  detected: boolean;
  cleanedText: string;
}

const WAKE_PREFIX = /^\s*(?:(?:hey|hi|hello|okay|ok)\s+vanessa|vanessa)\b[\s,.:;!?—-]*/i;

/** Transcript-level fallback/parser. The production background detector is the local Porcupine engine. */
export class WakeWordDetector {
  private isActiveSession = false;
  private sessionTimeout: NodeJS.Timeout | null = null;

  processTranscript(text: string): WakeWordResult {
    const input = String(text || "").trim();
    const prefix = input.match(WAKE_PREFIX);
    if (prefix) {
      this.touchActiveSession();
      return {
        detected: true,
        cleanedText: input.slice(prefix[0].length).replace(/^[,\s.!?;:—-]+/, "").replace(/[.!?]+$/, "").trim(),
      };
    }

    if (this.isActiveSession) {
      return { detected: true, cleanedText: input };
    }
    return { detected: false, cleanedText: input };
  }

  touchActiveSession(durationMs = 15000): void {
    this.isActiveSession = true;
    if (this.sessionTimeout) clearTimeout(this.sessionTimeout);
    this.sessionTimeout = setTimeout(() => {
      this.isActiveSession = false;
      this.sessionTimeout = null;
    }, Math.max(0, durationMs));
    this.sessionTimeout.unref?.();
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
