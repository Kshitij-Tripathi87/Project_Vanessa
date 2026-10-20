export interface VoiceProvider {
  name: "elevenlabs" | "fish" | "mock";
  init(): Promise<void>;
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}
