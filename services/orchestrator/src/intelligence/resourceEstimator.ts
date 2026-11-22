import type {
  AllocationFractions,
  LoadEstimate,
  ResourceEstimateInput,
  ResourcePolicy,
  ResourceRejection,
  ResourceRejectionCode,
} from "./contracts.js";

const MiB = 1024 * 1024;

/** Reserves are in addition to the currently observed OS/process usage. */
export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = Object.freeze({
  hostReserveBytes: 512 * MiB,
  acceleratorReserveBytes: 128 * MiB,
  hostHeadroomFraction: 0.25,
  acceleratorHeadroomFraction: 0.25,
});

const isBytes = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => isBytes(value) && value > 0;
const isFraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isHeadroom = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0.20 && value < 1;

function safeSum(...values: number[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (!isBytes(value) || value > Number.MAX_SAFE_INTEGER - sum) return null;
    sum += value;
  }
  return sum;
}

function safeProduct(...values: number[]): number | null {
  let product = 1n;
  for (const value of values) {
    if (!isBytes(value)) return null;
    product *= BigInt(value);
    if (product > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  }
  return Number(product);
}

function isAllocation(value: AllocationFractions | undefined | null): value is AllocationFractions {
  return !!value && isFraction(value.host) && isFraction(value.accelerator);
}

// Convert the caller's decimal number to a rational. Multiplying large safe
// integers as floating point can round a load DOWN or a pool limit UP by a byte.
function decimalRatio(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const [whole, fractional = ""] = mantissa.split(".");
  const digits = BigInt(`${whole}${fractional}`);
  const exponent = Number(exponentText ?? "0") - fractional.length;
  return exponent >= 0
    ? { numerator: digits * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-exponent) };
}

function ceilProduct(bytes: number, factor: number, divisor = 1n): number | null {
  const { numerator, denominator } = decimalRatio(factor);
  const bottom = denominator * divisor;
  const result = (BigInt(bytes) * numerator + bottom - 1n) / bottom;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function poolLimit(available: number, reserve: number, headroom: number): number {
  const { numerator, denominator } = decimalRatio(headroom);
  return Number(BigInt(Math.max(0, available - reserve)) * (denominator - numerator) / denominator);
}

/**
 * Estimate a local load from explicit upper bounds. This is pure: it neither
 * probes hardware nor loads a model. It checks memory only, not engine/model
 * compatibility, artifact trust, task quality or remote consent.
 *
 * Availability can change after this calculation. A future loader must take
 * a fresh profile, coordinate concurrent loads/reservations and handle allocation
 * failure; this function cannot make an OS-level reservation.
 */
export function estimateResourceFit(input: ResourceEstimateInput): LoadEstimate {
  let weightsBytes: number | null = null;
  let kvCacheBytes: number | null = null;
  let hostBytes: number | null = null;
  let acceleratorBytes: number | null = null;
  let totalBytes: number | null = null;
  let hostLimitBytes: number | null = null;
  let acceleratorLimitBytes: number | null = null;
  const reasons: ResourceRejection[] = [];

  const result = (): LoadEstimate => ({
    decision: reasons.length === 0 ? "within-budget" : "reject",
    reasons,
    weightsBytes,
    kvCacheBytes,
    hostBytes,
    acceleratorBytes,
    totalBytes,
    hostLimitBytes,
    acceleratorLimitBytes,
  });
  const reject = (code: ResourceRejectionCode, detail: string): LoadEstimate => {
    reasons.push({ code, detail });
    return result();
  };

  if (!input || typeof input !== "object" || !input.profile || !input.model || !input.budget || !input.placement) {
    return reject("invalid-input", "A profile, model, budget and placement are required.");
  }
  const { profile, model, budget, placement } = input;
  const policy = input.policy === undefined ? DEFAULT_RESOURCE_POLICY : input.policy;
  if (!policy || !isBytes(policy.hostReserveBytes) || !isBytes(policy.acceleratorReserveBytes)
    || !isHeadroom(policy.hostHeadroomFraction) || !isHeadroom(policy.acceleratorHeadroomFraction)) {
    return reject("invalid-policy", "Reserves must be nonnegative byte counts and each headroom fraction must be at least 0.20 and less than 1.");
  }
  if (!isPositiveInteger(budget.maxInputTokens) || !isPositiveInteger(budget.maxOutputTokens)
    || !isPositiveInteger(budget.maxContextTokens) || !isPositiveInteger(budget.maxLoadBytes)
    || !isBytes(budget.maxAcceleratorBytes) || !isPositiveInteger(budget.deadlineMs)
    || !isPositiveInteger(budget.concurrency) || typeof budget.allowCpuOffload !== "boolean"
    || typeof budget.allowRemote !== "boolean") {
    return reject("invalid-budget", "Token, memory, deadline and concurrency limits must be valid finite integers.");
  }
  const requestedTokens = safeSum(budget.maxInputTokens, budget.maxOutputTokens);
  if (requestedTokens === null || requestedTokens > budget.maxContextTokens
    || !isPositiveInteger(model.nativeContextTokens) || budget.maxContextTokens > model.nativeContextTokens) {
    return reject("context-limit", "Input plus output must fit the requested context and the model's native context.");
  }
  if (model.artifactFormat === "remote") {
    return reject("remote-model", "A remote model cannot be admitted by the local resource estimator.");
  }
  if (!["gguf", "safetensors", "onnx"].includes(model.artifactFormat)) {
    return reject("invalid-model", "The local artifact format is unknown.");
  }

  const memory = profile.memory;
  if (profile.profileVersion !== 1 || profile.probes?.memory !== "complete" || !memory
    || !isPositiveInteger(memory.totalBytes) || !isBytes(memory.availableBytes)
    || memory.availableBytes > memory.totalBytes) {
    return reject("unknown-host-memory", "A complete host-memory probe with valid total and currently available memory is required.");
  }
  hostLimitBytes = poolLimit(memory.availableBytes, policy.hostReserveBytes, policy.hostHeadroomFraction);
  if (model.minimumRamBytes !== undefined) {
    if (!isPositiveInteger(model.minimumRamBytes)) return reject("invalid-model", "The minimum host memory must be a positive byte count.");
    if (memory.totalBytes < model.minimumRamBytes) return reject("minimum-host-memory", "Host capacity is below the manifest minimum.");
  }

  const weights = model.memory?.weights;
  if (!weights) return reject("unknown-weights", "A conservative resident weight estimate is required.");
  if (weights.kind === "resident-upper-bound") {
    if (!isPositiveInteger(weights.bytes)) return reject("invalid-weights", "Resident weight bytes must be a positive safe integer.");
    weightsBytes = weights.bytes;
  } else if (weights.kind === "parameter-estimate") {
    if (!isPositiveInteger(model.parameterCount) || typeof weights.effectiveBitsPerParameter !== "number"
      || !Number.isFinite(weights.effectiveBitsPerParameter) || weights.effectiveBitsPerParameter <= 0
      || !isBytes(weights.extraBytes)) {
      return reject("invalid-weights", "Total stored parameter count, effective bits and explicit metadata overhead are required.");
    }
    const packedBytes = ceilProduct(model.parameterCount, weights.effectiveBitsPerParameter, 8n);
    if (packedBytes === null) return reject("arithmetic-overflow", "Weight estimate exceeds safe numeric precision.");
    weightsBytes = safeSum(packedBytes, weights.extraBytes);
    if (!weightsBytes || !isPositiveInteger(weightsBytes)) return reject("arithmetic-overflow", "Weight estimate exceeds safe numeric precision.");
  } else {
    return reject("unknown-weights", "The weight layout has no supported upper-bound estimate.");
  }

  const kv = model.memory?.kvCache;
  if (!kv) return reject("unknown-kv-cache", "A layout-specific KV cache upper bound is required.");
  if (kv.kind === "conventional-transformer") {
    if (!isPositiveInteger(model.layerCount) || !isPositiveInteger(model.kvHeadCount)
      || !isPositiveInteger(model.headDimension) || ![2, 4, 8].includes(kv.bytesPerElement)) {
      return reject("invalid-kv-cache", "Conventional full-attention cache dimensions and non-quantized element size are required.");
    }
    kvCacheBytes = safeProduct(2, model.layerCount, model.kvHeadCount, model.headDimension,
      kv.bytesPerElement, budget.maxContextTokens, budget.concurrency);
  } else if (kv.kind === "sequence-upper-bound") {
    if (!isPositiveInteger(kv.maxContextTokens) || !isPositiveInteger(kv.bytesPerSequence)) {
      return reject("invalid-kv-cache", "The per-sequence upper bound and its covered context are required.");
    }
    if (budget.maxContextTokens > kv.maxContextTokens) {
      return reject("kv-context-limit", "The cache upper bound does not cover the requested context.");
    }
    kvCacheBytes = safeProduct(kv.bytesPerSequence, budget.concurrency);
  } else {
    return reject("unknown-kv-cache", "The cache layout has no supported upper-bound estimate.");
  }
  if (kvCacheBytes === null) return reject("arithmetic-overflow", "KV cache estimate exceeds safe numeric precision.");

  if (!isAllocation(placement.weights) || !isAllocation(placement.kvCache)
    || typeof placement.usesCpuOffload !== "boolean"
    || !(placement.acceleratorId === null || (typeof placement.acceleratorId === "string" && placement.acceleratorId.trim().length > 0))) {
    return reject("invalid-placement", "Placement must account for all weights and KV bytes with explicit host and accelerator fractions.");
  }
  const runtime = placement.runtime;
  if (!runtime || !isBytes(runtime.hostFixedBytes) || !isBytes(runtime.hostPerSequenceBytes)
    || !isBytes(runtime.acceleratorFixedBytes) || !isBytes(runtime.acceleratorPerSequenceBytes)) {
    return reject("unknown-runtime-overhead", "Explicit nonnegative host and accelerator runtime upper bounds are required.");
  }
  const hostPerSequence = safeProduct(runtime.hostPerSequenceBytes, budget.concurrency);
  const acceleratorPerSequence = safeProduct(runtime.acceleratorPerSequenceBytes, budget.concurrency);
  const hostRuntime = hostPerSequence === null ? null : safeSum(runtime.hostFixedBytes, hostPerSequence);
  const acceleratorRuntime = acceleratorPerSequence === null ? null : safeSum(runtime.acceleratorFixedBytes, acceleratorPerSequence);
  if (hostRuntime === null || acceleratorRuntime === null) return reject("arithmetic-overflow", "Runtime overhead exceeds safe numeric precision.");
  if (hostRuntime === 0) return reject("unknown-runtime-overhead", "Local runtime host overhead must have a nonzero upper bound.");

  const hostWeights = ceilProduct(weightsBytes, placement.weights.host);
  const acceleratorWeights = ceilProduct(weightsBytes, placement.weights.accelerator);
  const hostKv = ceilProduct(kvCacheBytes, placement.kvCache.host);
  const acceleratorKv = ceilProduct(kvCacheBytes, placement.kvCache.accelerator);
  if (hostWeights === null || acceleratorWeights === null || hostKv === null || acceleratorKv === null) {
    return reject("arithmetic-overflow", "Placement estimate exceeds safe numeric precision.");
  }
  const placedWeights = safeSum(hostWeights, acceleratorWeights);
  const placedKv = safeSum(hostKv, acceleratorKv);
  if (placedWeights === null || placedKv === null) return reject("arithmetic-overflow", "Placement estimate exceeds safe numeric precision.");
  if (placedWeights < weightsBytes || placedKv < kvCacheBytes) {
    return reject("invalid-placement", "Host and accelerator allocations must cover every weight and KV byte.");
  }
  const hostPrivateBytes = safeSum(hostWeights, hostKv, hostRuntime);
  acceleratorBytes = safeSum(acceleratorWeights, acceleratorKv, acceleratorRuntime);
  if (hostPrivateBytes === null || acceleratorBytes === null) return reject("arithmetic-overflow", "Placement estimate exceeds safe numeric precision.");
  totalBytes = safeSum(hostPrivateBytes, acceleratorBytes);
  if (totalBytes === null) return reject("arithmetic-overflow", "Total load exceeds safe numeric precision.");

  if (placement.acceleratorId === null) {
    if (acceleratorBytes !== 0 || placement.usesCpuOffload) {
      return reject("invalid-placement", "CPU-only placement cannot include accelerator allocations or offload.");
    }
    if (model.minimumVramBytes !== undefined) {
      if (!isPositiveInteger(model.minimumVramBytes)) return reject("invalid-model", "The minimum accelerator memory must be a positive byte count.");
      return reject("accelerator-required", "The manifest requires an accelerator.");
    }
    hostBytes = hostPrivateBytes;
    acceleratorLimitBytes = 0;
  } else {
    if (acceleratorBytes === 0 || acceleratorRuntime === 0) {
      return reject("unknown-runtime-overhead", "An accelerator load requires a nonzero accelerator allocation and runtime upper bound.");
    }
    const needsOffload = placement.weights.accelerator < 1 || placement.kvCache.accelerator < 1;
    if (needsOffload && !placement.usesCpuOffload) return reject("offload-not-declared", "Partial accelerator placement must declare CPU offload.");
    if (placement.usesCpuOffload && !budget.allowCpuOffload) return reject("offload-disallowed", "The budget does not permit CPU offload.");
    if (!["complete", "partial"].includes(profile.acceleratorInventory)
      || !["complete", "partial"].includes(profile.probes?.accelerators)) {
      return reject("unknown-accelerator", "The accelerator inventory is unavailable.");
    }
    const candidates = Array.isArray(profile.accelerators)
      ? profile.accelerators.filter((item) => item?.id === placement.acceleratorId) : [];
    if (candidates.length !== 1) return reject("unknown-accelerator", "The selected accelerator must have exactly one unambiguous observation.");
    const accelerator = candidates[0];
    if (!isPositiveInteger(accelerator.totalMemoryBytes) || !isBytes(accelerator.availableMemoryBytes)
      || accelerator.availableMemoryBytes > accelerator.totalMemoryBytes) {
      return reject("unknown-accelerator-memory", "Valid total and currently available accelerator memory are required.");
    }
    if (model.minimumVramBytes !== undefined) {
      if (!isPositiveInteger(model.minimumVramBytes)) return reject("invalid-model", "The minimum accelerator memory must be a positive byte count.");
      if (accelerator.totalMemoryBytes < model.minimumVramBytes) return reject("minimum-accelerator-memory", "Accelerator capacity is below the manifest minimum.");
    }
    if (!["dedicated", "shared", "unified"].includes(accelerator.memoryTopology)) {
      return reject("unknown-memory-topology", "The selected accelerator's memory pool topology must be evidenced.");
    }
    acceleratorLimitBytes = poolLimit(accelerator.availableMemoryBytes, policy.acceleratorReserveBytes, policy.acceleratorHeadroomFraction);
    // Shared/unified allocations consume BOTH the device limit and host pool;
    // totalBytes counts each physical allocation once, not once per pool.
    hostBytes = accelerator.memoryTopology === "dedicated" ? hostPrivateBytes : totalBytes;
  }

  if (hostBytes > hostLimitBytes) reasons.push({ code: "host-headroom", detail: "The host allocation exceeds available memory after reserve and headroom." });
  if (acceleratorBytes > acceleratorLimitBytes) reasons.push({ code: "accelerator-headroom", detail: "The accelerator allocation exceeds available memory after reserve and headroom." });
  if (totalBytes > budget.maxLoadBytes) reasons.push({ code: "max-load-exceeded", detail: "The total physical allocation exceeds the load budget." });
  if (acceleratorBytes > budget.maxAcceleratorBytes) reasons.push({ code: "max-accelerator-exceeded", detail: "The accelerator allocation exceeds its budget." });
  return result();
}

export class ResourceBudgetError extends Error {
  constructor(readonly estimate: LoadEstimate) {
    super(`Resource admission rejected: ${estimate.reasons.map((reason) => reason.code).join(", ")}`);
    this.name = "ResourceBudgetError";
  }
}

/**
 * Optional admission helper for future loaders. It never invokes load on a
 * rejected/unknown estimate. It does not perform compatibility, authorization,
 * locking or an OS reservation, and is NOT wired into today's provider path.
 */
export async function loadAfterResourceCheck<T>(
  input: ResourceEstimateInput,
  load: (estimate: LoadEstimate) => Promise<T>,
): Promise<T> {
  const estimate = estimateResourceFit(input);
  if (estimate.decision !== "within-budget") throw new ResourceBudgetError(estimate);
  return load(estimate);
}
