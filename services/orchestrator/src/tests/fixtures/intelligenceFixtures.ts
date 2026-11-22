import type {
  AcceleratorProfile,
  BackendEvidence,
  HardwareProfile,
  InferenceBudget,
  MemoryPlacement,
  ModelManifest,
  ResourceEstimateInput,
  ResourcePolicy,
} from "../../intelligence/contracts.js";
import type { HardwareProbeProviders } from "../../intelligence/hardwareProbe.js";

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

export function accelerator(overrides: Partial<AcceleratorProfile> = {}): AcceleratorProfile {
  return {
    id: "gpu-0", vendor: "Fixture Vendor", name: "Fixture Accelerator", pciDeviceId: "0x0001",
    totalMemoryBytes: 8 * GiB, availableMemoryBytes: 6 * GiB, memoryTopology: "dedicated",
    driverVersion: "fixture-driver", computeCapability: null, ...overrides,
  };
}

export function cpuEvidence(): BackendEvidence {
  return { backend: "cpu", engineId: "fixture-engine", scope: "engine", acceleratorId: null, status: "supported",
    evidence: { kind: "engine-probe", detail: "Synthetic engine reports CPU support" } };
}

export function gpuEvidence(gpu: AcceleratorProfile): BackendEvidence {
  return { backend: "vulkan", engineId: "fixture-engine", scope: "device", acceleratorId: gpu.id, status: "supported",
    evidence: { kind: "backend-test", detail: "Synthetic device/backend probe" } };
}

export function profile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    profileVersion: 1, os: "linux", architecture: "x64",
    cpu: { vendor: "Fixture CPU", model: "Fixture Model", logicalCores: 4, instructionSets: ["avx2", "sse2"] },
    memory: { totalBytes: 8 * GiB, availableBytes: 6 * GiB },
    accelerators: [], acceleratorInventory: "complete", backendEvidence: [cpuEvidence()], detectedBackends: ["cpu"],
    probes: { system: "complete", cpu: "complete", memory: "complete", accelerators: "complete", backends: "complete" },
    capturedAt: "2026-01-01T00:00:00.000Z", confidence: "complete", ...overrides,
  };
}

export function providersFor(value: HardwareProfile): HardwareProbeProviders {
  return {
    system: () => ({ status: value.probes.system, value: { os: value.os, architecture: value.architecture } }),
    cpu: () => ({ status: value.probes.cpu, value: value.cpu }),
    memory: () => ({ status: value.probes.memory, value: value.memory }),
    accelerators: () => ({ status: value.probes.accelerators, value: value.accelerators }),
    backends: () => ({ status: value.probes.backends, value: value.backendEvidence }),
    now: () => new Date(value.capturedAt),
  };
}

export function model(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    modelId: "synthetic-model", revision: "1", artifactFormat: "gguf", tokenizerId: "synthetic-tokenizer",
    parameterCount: 2_000_000_000, layerCount: 2, kvHeadCount: 1, headDimension: 4,
    nativeContextTokens: 256, supportedModalities: ["text"], quantization: "synthetic",
    supportedBackends: ["cpu", "vulkan"],
    capabilities: { jsonMode: true, jsonSchemaMode: false, toolPlanning: true, multilingual: ["en"], streaming: true, cancellation: true },
    license: "fixture", trustState: "verified",
    memory: { weights: { kind: "resident-upper-bound", bytes: 1_000 }, kvCache: { kind: "conventional-transformer", bytesPerElement: 2 } },
    ...overrides,
  };
}

export function budget(overrides: Partial<InferenceBudget> = {}): InferenceBudget {
  return {
    maxInputTokens: 8, maxOutputTokens: 8, maxContextTokens: 16, maxLoadBytes: 100_000,
    maxAcceleratorBytes: 100_000, deadlineMs: 5_000, concurrency: 2, allowCpuOffload: true, allowRemote: false,
    ...overrides,
  };
}

export function cpuPlacement(overrides: Partial<MemoryPlacement> = {}): MemoryPlacement {
  return {
    acceleratorId: null, weights: { host: 1, accelerator: 0 }, kvCache: { host: 1, accelerator: 0 },
    usesCpuOffload: false,
    runtime: { hostFixedBytes: 100, hostPerSequenceBytes: 20, acceleratorFixedBytes: 0, acceleratorPerSequenceBytes: 0 },
    ...overrides,
  };
}

export function gpuPlacement(overrides: Partial<MemoryPlacement> = {}): MemoryPlacement {
  return {
    acceleratorId: "gpu-0", weights: { host: 0.5, accelerator: 0.5 }, kvCache: { host: 0.5, accelerator: 0.5 },
    usesCpuOffload: true,
    runtime: { hostFixedBytes: 100, hostPerSequenceBytes: 20, acceleratorFixedBytes: 80, acceleratorPerSequenceBytes: 10 },
    ...overrides,
  };
}

export const exactPolicy: ResourcePolicy = {
  hostReserveBytes: 0, acceleratorReserveBytes: 0, hostHeadroomFraction: 0.2, acceleratorHeadroomFraction: 0.2,
};

export function estimateInput(overrides: Partial<ResourceEstimateInput> = {}): ResourceEstimateInput {
  return { profile: profile(), model: model(), budget: budget(), placement: cpuPlacement(), policy: exactPolicy, ...overrides };
}

/** Evaluation cohorts only: these synthetic fixtures do not promise a model size. */
export function cohorts(): Array<{ name: string; profile: HardwareProfile; placement: MemoryPlacement }> {
  const fixture = (name: string, total: number, available: number, gpu?: AcceleratorProfile) => ({
    name,
    profile: profile({
      memory: { totalBytes: total * GiB, availableBytes: available * GiB },
      accelerators: gpu ? [gpu] : [],
      backendEvidence: gpu ? [cpuEvidence(), gpuEvidence(gpu)] : [cpuEvidence()],
      detectedBackends: gpu ? ["cpu", "vulkan"] : ["cpu"],
    }),
    placement: gpu ? gpuPlacement() : cpuPlacement(),
  });
  return [
    fixture("E0", 4, 3),
    fixture("E1", 8, 5, accelerator({ totalMemoryBytes: 4 * GiB, availableMemoryBytes: 3 * GiB, memoryTopology: "shared" })),
    fixture("E2", 16, 10, accelerator({ totalMemoryBytes: 8 * GiB, availableMemoryBytes: 6 * GiB })),
    fixture("E3", 32, 22, accelerator({ totalMemoryBytes: 16 * GiB, availableMemoryBytes: 12 * GiB })),
    fixture("E4", 64, 48, accelerator({ totalMemoryBytes: 48 * GiB, availableMemoryBytes: 36 * GiB, memoryTopology: "unified" })),
  ];
}
