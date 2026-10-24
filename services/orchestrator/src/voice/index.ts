import { fishConfig } from "./fish/fishConfig.js";

/**
 * Voice service configuration - Fish Audio is the selected provider
 * ElevenLabs integration has been moved to the dedicated voice-agent service
 */
export class VanessaVoiceService {
  getProviderName(): string {
    return "fish";
  }

  getFishConfig() {
    return fishConfig;
  }
}

export const voiceService = new VanessaVoiceService();
export * from "./types.js";
export * from "./sentimentAnalyzer.js";
