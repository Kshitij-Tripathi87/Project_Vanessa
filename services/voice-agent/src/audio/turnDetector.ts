export type TurnState = "idle" | "listening" | "speaking" | "complete";

export interface TurnDetectorOptions {
  silenceThresholdMs?: number;
  minSpeechMs?: number;
}

export class TurnDetector {
  private silenceMs = 0;
  private speechMs = 0;
  private state: TurnState = "idle";
  private options: Required<TurnDetectorOptions>;

  constructor(options?: TurnDetectorOptions) {
    this.options = {
      silenceThresholdMs: options?.silenceThresholdMs ?? 650,
      minSpeechMs: options?.minSpeechMs ?? 350,
    };
  }

  process(input: { isSpeech: boolean; partialTranscript: string }): TurnState {
    if (input.isSpeech) {
      this.silenceMs = 0;
      this.speechMs += 20;
      if (this.state !== "speaking") {
        this.state = "listening";
      }
      return this.state;
    }

    if (this.state === "listening" || this.state === "speaking") {
      this.silenceMs += 20;
    }

    const hasEnoughSpeech = this.speechMs >= this.options.minSpeechMs;
    const looksComplete =
      this.silenceMs >= this.options.silenceThresholdMs &&
      hasEnoughSpeech;

    if (looksComplete) {
      this.state = "complete";
      return this.state;
    }

    return this.state;
  }

  reset(): void {
    this.silenceMs = 0;
    this.speechMs = 0;
    this.state = "idle";
  }

  getState(): TurnState {
    return this.state;
  }

  getMetrics() {
    return {
      silenceMs: this.silenceMs,
      speechMs: this.speechMs,
      state: this.state,
    };
  }
}
