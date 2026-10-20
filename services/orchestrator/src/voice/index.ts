import { VoiceProvider } from "./types.js";
import { fishConfig } from "./fish/fishConfig.js";
import { ELEVENLABS_CONFIG, ELEVENLABS_TOOLS } from "./elevenlabs/clientTools.js";

export class VanessaVoiceService {
  private activeProviderName: string;

  constructor() {
    this.activeProviderName = process.env.VOICE_PROVIDER || "elevenlabs";
  }

  getProviderName(): string {
    return this.activeProviderName;
  }

  getElevenLabsConfig() {
    return {
      config: ELEVENLABS_CONFIG,
      tools: ELEVENLABS_TOOLS,
    };
  }

  getFishConfig() {
    return fishConfig;
  }
}

export const voiceService = new VanessaVoiceService();
export * from "./types.js";
export * from "./streamingTts.js";
export * from "./sentimentAnalyzer.js";
export * from "./voiceStreamServer.js";
