import { WakeWordResult } from "./wakeWord.js";

export interface PorcupineWakeWordOptions {
  accessKey: string;
  keywords?: string[];
  modelPath?: string;
  sensitivity?: number;
}

export class PorcupineWakeWordDetector {
  private porcupine: any = null;
  private isInitialized = false;
  private accessKey: string;
  private keywords: string[];
  private modelPath?: string;
  private sensitivity: number;

  constructor(options: PorcupineWakeWordOptions) {
    this.accessKey = options.accessKey;
    this.keywords = options.keywords || ["hey vanessa", "vanessa"];
    this.modelPath = options.modelPath;
    this.sensitivity = options.sensitivity ?? 0.5;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Dynamic import - Porcupine is optional
      const porcupineModule = await import("@picovoice/porcupine-node");
      const Porcupine = porcupineModule.Porcupine || porcupineModule.default;

      if (!Porcupine) {
        throw new Error("Porcupine class not found in module");
      }

      // Porcupine API: new Porcupine(accessKey, keywords, sensitivities, modelPath)
      // where keywords: string[], sensitivities: number[]
      const sensitivities = this.keywords.map(() => this.sensitivity);
      this.porcupine = new Porcupine(this.accessKey, this.keywords, sensitivities, this.modelPath);
      this.isInitialized = true;
      console.log("[PorcupineWakeWord] Initialized with keywords:", this.keywords);
    } catch (err: any) {
      console.warn("[PorcupineWakeWord] Failed to initialize:", err.message);
      throw err;
    }
  }

  /**
   * Process 20ms PCM audio frame (512 samples @ 16kHz for Porcupine)
   * Returns true if wake word detected
   */
  processChunk(pcm: Int16Array): boolean {
    if (!this.isInitialized || !this.porcupine) return false;

    // Porcupine expects 512 samples per frame at 16kHz
    if (pcm.length !== 512) {
      // We need to accumulate or resize - for now, just check if we have enough
      return false;
    }

    try {
      const keywordIndex = this.porcupine.process(pcm);
      return keywordIndex >= 0;
    } catch (err) {
      return false;
    }
  }

  release(): void {
    if (this.porcupine) {
      this.porcupine.release();
      this.porcupine = null;
      this.isInitialized = false;
    }
  }
}

/**
 * Create wake word detector based on configuration
 */
export async function createWakeWordDetector(): Promise<{
  detector: { processChunk(pcm: Int16Array): boolean; release(): void };
  type: "porcupine" | "transcript";
} | null> {
  const provider = process.env.VOICE_WAKE_PROVIDER?.toLowerCase();

  if (provider === "porcupine") {
    const accessKey = process.env.PORCUPINE_ACCESS_KEY;
    if (!accessKey) {
      console.warn("[WakeWord] VOICE_WAKE_PROVIDER=porcupine but PORCUPINE_ACCESS_KEY not set; falling back to transcript-based");
      return null;
    }

    const keywords = (process.env.PORCUPINE_KEYWORDS || "hey vanessa,vanessa").split(",");
    const sensitivity = Number(process.env.PORCUPINE_SENSITIVITY) || 0.5;
    const modelPath = process.env.PORCUPINE_MODEL_PATH;

    const detector = new PorcupineWakeWordDetector({
      accessKey,
      keywords,
      modelPath,
      sensitivity,
    });

    await detector.initialize();
    return { detector, type: "porcupine" };
  }

  return null;
}