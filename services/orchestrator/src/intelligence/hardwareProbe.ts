import * as os from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { AcceleratorObservation, HardwareProfile } from "./engineAdapter.js";

export interface HardwareProbeSources {
  platform(): string;
  architecture(): string;
  cpus(): Array<{ model: string }>;
  totalMemory(): number;
  freeMemory(): number;
  cpuInfo(): Promise<string>;
  nvidiaInfo(): Promise<string>;
  now(): Date;
}
const defaults: HardwareProbeSources = {
  platform: os.platform, architecture: os.arch, cpus: os.cpus,
  totalMemory: os.totalmem, freeMemory: os.freemem,
  cpuInfo: () => readFile("/proc/cpuinfo", "utf8"),
  // Fixed executable/arguments; no shell, user input, network or prompt payload.
  nvidiaInfo: () => new Promise((resolve, reject) => {
    execFile("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.free,driver_version",
      "--format=csv,noheader,nounits"], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
  now: () => new Date(),
};
const bytes = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined;
  const result = Number(value) * 1024 * 1024;
  return Number.isSafeInteger(result) ? result : undefined;
};

/** Parses observations only. nvidia-smi success does not prove CUDA model support. */
export function parseNvidiaObservations(text: string): AcceleratorObservation[] {
  if (text.length > 64 * 1024) throw new Error("GPU report exceeds limit");
  const rows = text.trim() ? text.trim().split(/\r?\n/) : [];
  if (rows.length > 64) throw new Error("GPU report exceeds device limit");
  const seen = new Set<string>();
  return rows.map((row) => {
    const fields = row.split(",").map((field) => field.trim());
    const [index, name, total, free, driver] = fields;
    if (fields.length !== 5 || !/^\d+$/.test(index) || !name || seen.has(index)) {
      throw new Error("Malformed GPU report");
    }
    seen.add(index);
    const totalMemoryBytes = bytes(total);
    const availableMemoryBytes = bytes(free);
    if (totalMemoryBytes !== undefined && availableMemoryBytes !== undefined && availableMemoryBytes > totalMemoryBytes) {
      throw new Error("Inconsistent GPU memory report");
    }
    return { id: `nvidia:${index}`, vendor: "NVIDIA", name, memoryKind: "unknown" as const,
      totalMemoryBytes, availableMemoryBytes, driverVersion: driver || undefined };
  });
}

/** Local, on-demand snapshot. Never logs or uploads the collected profile. */
export async function probeHardware(overrides: Partial<HardwareProbeSources> = {}): Promise<HardwareProfile> {
  const source = { ...defaults, ...overrides };
  const platform = source.platform();
  const cpus = source.cpus();
  const totalBytes = source.totalMemory();
  const availableBytes = source.freeMemory();
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 || availableBytes > totalBytes) throw new Error("Invalid host memory observation");
  const diagnostics = ["Accelerator discovery covers NVIDIA only; other devices and engine compatibility remain unknown.",
    "Host memory is an OS snapshot, not an allocation guarantee or container memory limit."];
  let instructionSets: string[] = [];
  if (platform === "linux") {
    try {
      const report = await source.cpuInfo();
      const flags = [...report.matchAll(/^(?:flags|Features)\s*:\s*(.*)$/gm)]
        .map((match) => new Set(match[1].trim().split(/\s+/)));
      // Intersection avoids advertising an ISA available on only some cores.
      instructionSets = flags.length ? [...flags[0]].filter((flag) => flags.every((set) => set.has(flag))).sort() : [];
    } catch { /* Missing evidence stays unknown, not inferred from CPU name. */ }
  }
  if (!instructionSets.length) diagnostics.push("CPU instruction sets are unknown.");
  let accelerators: AcceleratorObservation[] = [];
  if (platform === "linux" || platform === "win32") {
    try { accelerators = parseNvidiaObservations(await source.nvidiaInfo()); }
    catch { diagnostics.push("NVIDIA probe unavailable or invalid; this does not prove that no accelerator exists."); }
  }
  return { profileVersion: 1, os: platform, architecture: source.architecture(),
    cpu: { model: cpus[0]?.model, logicalCores: cpus.length, instructionSets },
    memory: { totalBytes, availableBytes }, accelerators, detectedBackends: ["cpu"],
    capturedAt: source.now().toISOString(), confidence: "partial", diagnostics };
}
