import type { HardwareProfile, InferenceBudget, LoadEstimate, ModelManifest } from "./engineAdapter.js";

export interface ResourceEstimateOptions {
  placement: { kind: "cpu" } | { kind: "dedicated"; acceleratorId: string; weightFraction: number } |
    { kind: "unified"; acceleratorId: string };
  /** Required per-engine TOTAL overhead for the requested concurrency, including workspace. */
  runtimeOverheadBytes: number;
  headroomFraction?: number;
  hostReserveBytes?: number;
  acceleratorReserveBytes?: number;
}
const MiB = 1024 * 1024;
const integer = (n: unknown, min = 0): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
const unknown = (reason: string): LoadEstimate => ({ status: "unknown", scope: "memory-only", reasons: [reason] });

/** Pure preflight only. Adapters must enforce the result and recheck before load.
 * Does not authorize remote calls, qualify a model, or reserve physical memory.
 */
export function estimateResources(model: ModelManifest, budget: InferenceBudget,
  hardware: HardwareProfile, options: ResourceEstimateOptions): LoadEstimate {
  const headroom = options.headroomFraction ?? 0.25;
  const hostReserve = options.hostReserveBytes ?? 512 * MiB;
  const gpuReserve = options.acceleratorReserveBytes ?? 256 * MiB;
  if (!Number.isFinite(headroom) || headroom < 0.2 || headroom >= 1 ||
    !integer(hostReserve) || !integer(gpuReserve) || !integer(options.runtimeOverheadBytes, 1)) {
    return unknown("Invalid reserve, headroom or runtime overhead.");
  }
  if (![budget.maxInputTokens, budget.maxOutputTokens, budget.maxContextTokens, budget.concurrency,
    budget.deadlineMs, model.nativeContextTokens].every((n) => integer(n, 1)) ||
    !integer(budget.maxLoadBytes) || !integer(budget.maxAcceleratorBytes)) return unknown("Invalid inference budget.");
  if (budget.maxInputTokens + budget.maxOutputTokens > budget.maxContextTokens ||
    budget.maxContextTokens > model.nativeContextTokens) return unknown("Context exceeds token budget or model limit.");
  if (model.artifactFormat === "remote") return unknown("Local memory estimation cannot qualify a remote model.");
  let weights = model.weightBytes;
  if (weights === undefined) {
    // Use total parameters, never active MoE parameters. No guessed Q4 metadata.
    if (!integer(model.parameterCount, 1) || !Number.isFinite(model.effectiveBitsPerWeight) ||
      model.effectiveBitsPerWeight! <= 0 || model.effectiveBitsPerWeight! > 64 ||
      !Number.isFinite(model.quantizationOverheadFraction) || model.quantizationOverheadFraction! < 0) {
      return unknown("Resident weight bytes or complete weight estimation metadata required.");
    }
    weights = Math.ceil(model.parameterCount * model.effectiveBitsPerWeight! / 8 * (1 + model.quantizationOverheadFraction!));
  }
  if (!integer(weights, 1)) return unknown("Invalid or overflowing weight footprint.");
  const kv = model.kvCache;
  if (!kv) return unknown("KV cache layout is unknown; architecture-specific metadata required.");
  let perToken: number;
  if (kv.kind === "custom") {
    perToken = kv.bytesPerTokenPerSequence;
    if (!integer(perToken, 1)) return unknown("Invalid custom KV cache estimate.");
  } else {
    if (![kv.layerCount, kv.kvHeadCount, kv.headDimension].every((n) => integer(n, 1)) ||
      !Number.isFinite(kv.bytesPerElement) || kv.bytesPerElement <= 0 || kv.bytesPerElement > 8) {
      return unknown("Invalid transformer KV cache layout.");
    }
    perToken = 2 * kv.layerCount * kv.kvHeadCount * kv.headDimension * kv.bytesPerElement;
  }
  const kvCacheBytes = Math.ceil(perToken * budget.maxContextTokens * budget.concurrency);
  const runtimeBytes = options.runtimeOverheadBytes;
  if (!integer(kvCacheBytes, 1) || !integer(weights + kvCacheBytes + runtimeBytes, 1)) return unknown("Memory estimate overflow.");
  let hostBytes = weights + kvCacheBytes + runtimeBytes;
  let acceleratorBytes = 0;
  const reasons: string[] = [];
  const placement = options.placement;
  const device = placement.kind === "cpu" ? undefined : hardware.accelerators.find((gpu) => gpu.id === placement.acceleratorId);
  if (placement.kind !== "cpu" && !device) return unknown("Selected accelerator has no observation.");
  if (placement.kind === "dedicated") {
    if (device!.memoryKind !== "dedicated") return unknown("Dedicated accelerator memory has not been established.");
    const fraction = placement.weightFraction;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1 || (fraction < 1 && !budget.allowCpuOffload)) {
      return unknown("Invalid or disallowed partial offload.");
    }
    // Conservative host staging retains ALL weights; KV and workspace charged to both pools.
    acceleratorBytes = Math.ceil(weights * fraction) + kvCacheBytes + runtimeBytes;
    if (!integer(device!.totalMemoryBytes, 1) || !integer(device!.availableMemoryBytes) ||
      device!.availableMemoryBytes! > device!.totalMemoryBytes!) return unknown("Accelerator free memory is unknown or invalid.");
    if (acceleratorBytes > Math.floor(Math.max(0, device!.availableMemoryBytes! - gpuReserve) * (1 - headroom))) {
      reasons.push("Accelerator memory headroom exceeded.");
    }
  } else if (placement.kind === "unified") {
    if (device!.memoryKind !== "unified") return unknown("Unified memory topology has not been established.");
    // One physical pool: never add advertised GPU memory to system memory.
    acceleratorBytes = hostBytes;
  }
  if (!integer(hardware.memory.totalBytes, 1) || !integer(hardware.memory.availableBytes) ||
    hardware.memory.availableBytes > hardware.memory.totalBytes) return unknown("Host free memory is unknown or invalid.");
  if (!integer(acceleratorBytes)) return unknown("Accelerator estimate overflow.");
  if (hostBytes > Math.floor(Math.max(0, hardware.memory.availableBytes - (placement.kind === "unified" ? Math.max(hostReserve, gpuReserve) : hostReserve)) * (1 - headroom))) {
    reasons.push("Host memory headroom exceeded.");
  }
  if (hostBytes > budget.maxLoadBytes) reasons.push("Host load budget exceeded.");
  if (acceleratorBytes > budget.maxAcceleratorBytes) reasons.push("Accelerator load budget exceeded.");
  return { status: reasons.length ? "over-budget" : "fits", scope: "memory-only", weightsBytes: weights,
    kvCacheBytes, runtimeBytes, hostBytes, acceleratorBytes, reasons };
}
