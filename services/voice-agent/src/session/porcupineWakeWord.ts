import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PorcupineWakeWordOptions {
  accessKey: string;
  keywordPaths: string[];
  modelPath?: string;
  sensitivity?: number;
}

export interface WakeWordReadiness {
  provider: string;
  available: boolean;
  reason?: string;
  keyword: string;
}

export interface WakeWordEngine {
  frameLength: number;
  process(frame: Int16Array): number;
  release(): void;
}

export class PcmSampleFrameAccumulator {
  private remainder = new Int16Array(0);

  constructor(readonly frameLength: number) {
    if (!Number.isInteger(frameLength) || frameLength <= 0) throw new Error("frameLength must be a positive integer");
  }

  feed(input: Int16Array, processFrame: (frame: Int16Array) => boolean): boolean {
    if (!input.length) return false;
    const combined = new Int16Array(this.remainder.length + input.length);
    combined.set(this.remainder, 0);
    combined.set(input, this.remainder.length);

    let detected = false;
    let offset = 0;
    while (offset + this.frameLength <= combined.length) {
      const frame = combined.slice(offset, offset + this.frameLength);
      detected = processFrame(frame) || detected;
      offset += this.frameLength;
    }
    this.remainder = combined.slice(offset);
    return detected;
  }

  reset(): void {
    this.remainder = new Int16Array(0);
  }

  get pendingSamples(): number {
    return this.remainder.length;
  }
}

function getWorkspaceRoot(): string {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return process.cwd();
    candidate = parent;
  }
}

function resolveConfiguredPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(getWorkspaceRoot(), value);
}

export function getWakeWordReadiness(env: NodeJS.ProcessEnv = process.env): WakeWordReadiness {
  const provider = (env.VOICE_WAKE_PROVIDER || "porcupine").trim().toLowerCase();
  const keyword = (env.VOICE_WAKE_PHRASE || "Hey Vanessa").trim() || "Hey Vanessa";
  if (provider !== "porcupine") {
    return { provider, available: false, keyword, reason: "Local always-on wake detection is disabled. Set VOICE_WAKE_PROVIDER=porcupine." };
  }

  if (!(env.PORCUPINE_ACCESS_KEY || "").trim()) {
    return { provider, available: false, keyword, reason: "PORCUPINE_ACCESS_KEY is not configured." };
  }

  const keywordPaths = (env.PORCUPINE_KEYWORD_PATHS || env.PORCUPINE_KEYWORD_PATH || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(resolveConfiguredPath);
  if (keywordPaths.length === 0) {
    return { provider, available: false, keyword, reason: "A custom Porcupine .ppn keyword model for Hey Vanessa is not configured." };
  }

  for (const keywordPath of keywordPaths) {
    if (path.extname(keywordPath).toLowerCase() !== ".ppn" || !fs.existsSync(keywordPath) || !fs.statSync(keywordPath).isFile()) {
      return { provider, available: false, keyword, reason: "Configured keyword model is missing or is not a .ppn file: " + path.basename(keywordPath) };
    }
  }

  const modelPath = (env.PORCUPINE_MODEL_PATH || "").trim();
  if (modelPath) {
    const resolvedModelPath = resolveConfiguredPath(modelPath);
    if (!fs.existsSync(resolvedModelPath) || !fs.statSync(resolvedModelPath).isFile()) {
      return { provider, available: false, keyword, reason: "Configured Porcupine language model does not exist: " + path.basename(resolvedModelPath) };
    }
  }

  return { provider, available: true, keyword };
}

export class PorcupineWakeWordDetector {
  private porcupine: WakeWordEngine | null = null;
  private isInitialized = false;
  private readonly accessKey: string;
  private readonly keywordPaths: string[];
  private readonly modelPath?: string;
  private readonly sensitivity: number;
  private frameAccumulator: PcmSampleFrameAccumulator | null = null;

  constructor(options: PorcupineWakeWordOptions) {
    this.accessKey = options.accessKey;
    this.keywordPaths = options.keywordPaths;
    this.modelPath = options.modelPath;
    this.sensitivity = options.sensitivity ?? 0.55;
    if (!this.keywordPaths.length) throw new Error("At least one custom Porcupine .ppn keyword path is required.");
    if (this.keywordPaths.some((keywordPath) => path.extname(keywordPath).toLowerCase() !== ".ppn")) {
      throw new Error("Porcupine keywordPaths must point to custom .ppn files; language models use the separate modelPath option.");
    }
    if (!Number.isFinite(this.sensitivity) || this.sensitivity < 0 || this.sensitivity > 1) {
      throw new Error("Porcupine sensitivity must be between 0 and 1.");
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    const porcupineModule: any = await import("@picovoice/porcupine-node");
    const Porcupine = porcupineModule.Porcupine || porcupineModule.default;
    if (!Porcupine) throw new Error("Porcupine class not found in @picovoice/porcupine-node.");

    const sensitivities = this.keywordPaths.map(() => this.sensitivity);
    this.porcupine = new Porcupine(
      this.accessKey,
      this.keywordPaths,
      sensitivities,
      this.modelPath ? { modelPath: resolveConfiguredPath(this.modelPath) } : {},
    ) as WakeWordEngine;

    this.frameAccumulator = new PcmSampleFrameAccumulator(this.porcupine.frameLength || 512);
    this.isInitialized = true;
    console.log("[PorcupineWakeWord] Local wake-word engine initialized.");
  }

  get frameLength(): number {
    return this.porcupine?.frameLength || 512;
  }

  /** Accept arbitrary 16 kHz mono chunks and internally reframe to Porcupine's native frame length. */
  processChunk(pcm: Int16Array): boolean {
    if (!this.isInitialized || !this.porcupine || !this.frameAccumulator) return false;
    return this.frameAccumulator.feed(pcm, (frame) => {
      try {
        return this.porcupine!.process(frame) >= 0;
      } catch (error) {
        console.warn("[PorcupineWakeWord] Frame processing failed:", error instanceof Error ? error.message : String(error));
        return false;
      }
    });
  }

  release(): void {
    this.frameAccumulator?.reset();
    this.frameAccumulator = null;
    if (this.porcupine) {
      this.porcupine.release();
      this.porcupine = null;
    }
    this.isInitialized = false;
  }
}

export async function createWakeWordDetector(): Promise<{
  detector: PorcupineWakeWordDetector;
  type: "porcupine";
  keyword: string;
} | null> {
  const readiness = getWakeWordReadiness();
  if (!readiness.available) {
    if (readiness.provider === "porcupine") {
      console.info("[WakeWord] Waiting for local wake-word configuration:", readiness.reason);
    }
    return null;
  }

  const keywordPaths = (process.env.PORCUPINE_KEYWORD_PATHS || process.env.PORCUPINE_KEYWORD_PATH || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(resolveConfiguredPath);
  const sensitivityValue = Number(process.env.PORCUPINE_SENSITIVITY);
  const sensitivity = Number.isFinite(sensitivityValue) && process.env.PORCUPINE_SENSITIVITY
    ? Math.min(1, Math.max(0, sensitivityValue))
    : 0.55;
  const detector = new PorcupineWakeWordDetector({
    accessKey: process.env.PORCUPINE_ACCESS_KEY!.trim(),
    keywordPaths,
    modelPath: process.env.PORCUPINE_MODEL_PATH?.trim() || undefined,
    sensitivity,
  });
  await detector.initialize();
  return { detector, type: "porcupine", keyword: readiness.keyword };
}
