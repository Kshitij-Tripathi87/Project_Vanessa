export interface AcousticFeatures {
  rms: number;
  peak: number;
  zeroCrossingRate: number;
  estimatedPitchHz: number;
  vocalStrain: "normal" | "elevated" | "high";
}

export interface SentimentResult {
  valence: number; // -1.0 to 1.0
  arousal: number; // 0.0 to 1.0
  urgency: "low" | "medium" | "critical";
  emotion: "calm" | "inquisitive" | "urgent" | "frustrated" | "satisfied";
  confidence: number;
  acoustic: AcousticFeatures;
}

export class SentimentAnalyzer {
  /**
   * Analyze raw 16-bit PCM buffer for acoustic prosody and vocal strain
   */
  analyzeAcousticBuffer(pcmBuffer: Buffer | Int16Array): AcousticFeatures {
    const samples = pcmBuffer instanceof Int16Array
      ? pcmBuffer
      : new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);

    if (samples.length === 0) {
      return {
        rms: 0,
        peak: 0,
        zeroCrossingRate: 0,
        estimatedPitchHz: 120,
        vocalStrain: "normal",
      };
    }

    let sumSquares = 0;
    let peak = 0;
    let zeroCrossings = 0;

    for (let i = 0; i < samples.length; i++) {
      const val = samples[i];
      const absVal = Math.abs(val);
      if (absVal > peak) peak = absVal;
      sumSquares += val * val;

      if (i > 0 && ((samples[i - 1] >= 0 && val < 0) || (samples[i - 1] < 0 && val >= 0))) {
        zeroCrossings++;
      }
    }

    const rms = Math.sqrt(sumSquares / samples.length) / 32768.0;
    const normalizedPeak = peak / 32768.0;
    const zeroCrossingRate = zeroCrossings / samples.length;

    // Approximate fundamental frequency (F0) from zero-crossing rate at 16kHz
    const estimatedPitchHz = Math.min(600, Math.max(70, Math.round((zeroCrossingRate * 16000) / 2)));

    let vocalStrain: "normal" | "elevated" | "high" = "normal";
    if (rms > 0.45 || (estimatedPitchHz > 320 && rms > 0.25)) {
      vocalStrain = "high";
    } else if (rms > 0.25 || estimatedPitchHz > 250) {
      vocalStrain = "elevated";
    }

    return {
      rms: Math.round(rms * 1000) / 1000,
      peak: Math.round(normalizedPeak * 1000) / 1000,
      zeroCrossingRate: Math.round(zeroCrossingRate * 1000) / 1000,
      estimatedPitchHz,
      vocalStrain,
    };
  }

  /**
   * Combine acoustic metrics with transcript text for unified emotion & urgency detection
   */
  analyze(text: string, acoustic?: AcousticFeatures): SentimentResult {
    const lower = text.toLowerCase();
    const ac = acoustic || {
      rms: 0.15,
      peak: 0.3,
      zeroCrossingRate: 0.05,
      estimatedPitchHz: 150,
      vocalStrain: "normal",
    };

    let valence = 0.0;
    let arousal = 0.3;
    let urgency: "low" | "medium" | "critical" = "low";
    let emotion: SentimentResult["emotion"] = "calm";
    let confidence = 0.85;

    // Frustration cues
    const frustrationWords = ["stop", "no", "fail", "broken", "cancel", "wrong", "not working", "why", "again", "hate"];
    const isFrustrated = frustrationWords.some((w) => lower.includes(w));

    // Urgency cues
    const urgencyWords = ["urgent", "immediately", "asap", "fast", "emergency", "now", "critical", "outage", "quick"];
    const isUrgent = urgencyWords.some((w) => lower.includes(w));

    // Inquiry cues
    const inquiryWords = ["how", "what", "where", "can you", "check", "tell me", "status", "who"];
    const isInquiry = inquiryWords.some((w) => lower.includes(w));

    // Satisfaction cues
    const satisfactionWords = ["thanks", "thank you", "great", "good", "perfect", "awesome", "done", "nice"];
    const isSatisfied = satisfactionWords.some((w) => lower.includes(w));

    if (isUrgent || ac.vocalStrain === "high") {
      urgency = isUrgent && ac.vocalStrain === "high" ? "critical" : "medium";
      emotion = "urgent";
      arousal = 0.85;
      valence = -0.1;
      confidence = 0.92;
    } else if (isFrustrated) {
      urgency = "medium";
      emotion = "frustrated";
      arousal = 0.75;
      valence = -0.6;
      confidence = 0.9;
    } else if (isSatisfied) {
      urgency = "low";
      emotion = "satisfied";
      arousal = 0.4;
      valence = 0.8;
      confidence = 0.95;
    } else if (isInquiry) {
      urgency = "low";
      emotion = "inquisitive";
      arousal = 0.45;
      valence = 0.2;
      confidence = 0.88;
    }

    return {
      valence,
      arousal,
      urgency,
      emotion,
      confidence,
      acoustic: ac,
    };
  }
}

export const sentimentAnalyzer = new SentimentAnalyzer();
