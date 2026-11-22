/**
 * Provider-neutral contracts for the future intelligence runtime.
 *
 * These types do not give an engine permission to invoke tools, authorize an
 * action, or send local hardware information to a hosted provider. The current
 * planner and provider clients do not use these contracts yet.
 */
export type ComputeBackend =
  | "cpu" | "cuda" | "rocm" | "vulkan" | "metal"
  | "directml" | "openvino" | "qnn" | "coreml" | "unknown";

export type ProbeStatus = "complete" | "partial" | "unavailable";
export type MemoryTopology = "dedicated" | "shared" | "unified" | "unknown";

export interface CpuProfile {
  readonly vendor: string | null;
  readonly model: string | null;
  /** Logical CPUs available to this process, not necessarily the whole host. */
  readonly logicalCores: number | null;
  /** Observed ISA flags, not necessarily exhaustive. null means not probed. */
  readonly instructionSets: readonly string[] | null;
}

export interface MemoryProfile {
  readonly totalBytes: number | null;
  /** Free/available to this process at capture time, not advertised capacity. */
  readonly availableBytes: number | null;
}

export interface AcceleratorProfile {
  /** Local identifier scoped to this profile; never infer usability from it. */
  readonly id: string;
  readonly vendor: string | null;
  readonly name: string | null;
  readonly pciDeviceId: string | null;
  readonly totalMemoryBytes: number | null;
  readonly availableMemoryBytes: number | null;
  readonly memoryTopology: MemoryTopology;
  readonly driverVersion: string | null;
  readonly computeCapability: string | null;
}

/**
 * A report from an actual engine/backend probe, not a vendor or OS inference.
 * Engine-scoped evidence does not prove support for a particular device/model.
 */
export interface BackendEvidence {
  readonly backend: Exclude<ComputeBackend, "unknown">;
  readonly engineId: string;
  readonly scope: "engine" | "device";
  readonly acceleratorId: string | null;
  readonly status: "supported" | "unsupported" | "unknown";
  readonly evidence: { readonly kind: "engine-probe" | "backend-test"; readonly detail: string } | null;
}

export interface HardwareProfile {
  readonly profileVersion: 1;
  readonly os: string | null;
  readonly architecture: string | null;
  readonly cpu: CpuProfile;
  readonly memory: MemoryProfile;
  readonly accelerators: readonly AcceleratorProfile[];
  /** Distinguishes a known empty inventory from an incomplete/unavailable scan. */
  readonly acceleratorInventory: ProbeStatus;
  readonly backendEvidence: readonly BackendEvidence[];
  /** Positive reports only; still not proof of model/engine/device compatibility. */
  readonly detectedBackends: readonly Exclude<ComputeBackend, "unknown">[];
  readonly probes: {
    readonly system: ProbeStatus;
    readonly cpu: ProbeStatus;
    readonly memory: ProbeStatus;
    readonly accelerators: ProbeStatus;
    readonly backends: ProbeStatus;
  };
  readonly capturedAt: string;
  readonly confidence: "complete" | "partial";
}

export type WeightFootprint =
  /** Upper bound on resident weight bytes for this engine, including metadata. */
  | { readonly kind: "resident-upper-bound"; readonly bytes: number }
  /**
   * Uses the TOTAL stored parameter count, not the active MoE parameter count.
   * extraBytes must bound scales, metadata and non-quantized tensors not already
   * included in effectiveBitsPerParameter. Unknown overhead is not zero.
   */
  | { readonly kind: "parameter-estimate"; readonly effectiveBitsPerParameter: number; readonly extraBytes: number };

export type KvCacheFootprint =
  /** Only for verified conventional, non-quantized full-attention layouts. */
  | { readonly kind: "conventional-transformer"; readonly bytesPerElement: 2 | 4 | 8 }
  /**
   * Manifest/backend upper bound, including layout/quantization metadata, for
   * any one sequence at or below maxContextTokens. Use for MLA, sliding-window,
   * quantized KV, or other layouts which cannot use the conventional formula.
   */
  | { readonly kind: "sequence-upper-bound"; readonly maxContextTokens: number; readonly bytesPerSequence: number };

export interface ModelManifest {
  readonly modelId: string;
  readonly revision: string;
  readonly artifactFormat: "gguf" | "safetensors" | "onnx" | "remote";
  readonly artifactSha256?: string;
  readonly tokenizerId: string;
  readonly tokenizerRevision?: string;
  readonly parameterCount?: number;
  readonly activeParameterCount?: number;
  readonly layerCount?: number;
  readonly hiddenSize?: number;
  readonly kvHeadCount?: number;
  readonly headDimension?: number;
  readonly nativeContextTokens: number;
  readonly supportedModalities: readonly string[];
  readonly quantization: string;
  /** Minimum physical host capacity, if required. */
  readonly minimumRamBytes?: number;
  readonly recommendedRamBytes?: number;
  /** If specified, an accelerator is required even for CPU-only placement. */
  readonly minimumVramBytes?: number;
  readonly supportedBackends: readonly ComputeBackend[];
  readonly supportedEngineIds?: readonly string[];
  readonly capabilities: {
    readonly jsonMode: boolean;
    readonly jsonSchemaMode: boolean;
    readonly toolPlanning: boolean;
    readonly multilingual: readonly string[];
    readonly streaming: boolean;
    readonly cancellation: boolean;
  };
  readonly license: string;
  readonly trustState: "verified" | "user-imported" | "unverified";
  /** Missing or unqualified estimates are unknown and must fail closed. */
  readonly memory?: { readonly weights?: WeightFootprint; readonly kvCache?: KvCacheFootprint };
}

export interface EngineDescriptor {
  readonly engineId: string;
  readonly version: string;
  readonly locality: "local" | "remote";
  readonly artifactFormats: readonly ModelManifest["artifactFormat"][];
  readonly backends: readonly ComputeBackend[];
  readonly operatingSystems: readonly string[];
  readonly architectures: readonly string[];
  readonly capabilities: {
    readonly streaming: boolean;
    readonly cancellation: boolean;
    readonly jsonMode: boolean;
    readonly jsonSchemaMode: boolean;
  };
}

export interface InferenceBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxContextTokens: number;
  /** Maximum total physical bytes for this load across host and accelerator. */
  readonly maxLoadBytes: number;
  readonly maxAcceleratorBytes: number;
  readonly deadlineMs: number;
  /** Maximum simultaneous sequences, each reserved at maxContextTokens. */
  readonly concurrency: number;
  readonly allowCpuOffload: boolean;
  /** This flag alone is not remote-provider authorization or user consent. */
  readonly allowRemote: boolean;
}

export interface InferenceRequest {
  readonly requestId: string;
  readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
  readonly budget: InferenceBudget;
  readonly responseFormat: "text" | "json" | "json-schema";
  readonly responseSchema?: Readonly<Record<string, unknown>>;
}

export interface InferenceResponse {
  readonly requestId: string;
  readonly modelId: string;
  readonly text: string;
  readonly finishReason: "stop" | "length" | "cancelled" | "error";
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface EngineHealth {
  readonly status: "ready" | "degraded" | "unavailable";
  readonly evidence: readonly BackendEvidence[];
}

export interface DiscoveredModel {
  readonly modelId: string;
  readonly revision?: string;
  readonly locality: "local" | "remote";
  readonly available: boolean;
  readonly manifest?: ModelManifest;
}

export interface LoadedModel {
  readonly modelId: string;
  readonly revision: string;
  readonly engineId: string;
  /** Opaque adapter-owned handle; it does not confer tool authority. */
  readonly handle: string;
}

export interface CancellationEvidence {
  readonly requestId: string;
  readonly status: "cancelled" | "already-finished" | "unconfirmed";
}

/** Fractions describe separate resident allocations, so duplicate copies count twice. */
export interface AllocationFractions {
  readonly host: number;
  readonly accelerator: number;
}

export interface MemoryPlacement {
  /** null for CPU-only; required when any accelerator allocation is requested. */
  readonly acceleratorId: string | null;
  readonly weights: AllocationFractions;
  readonly kvCache: AllocationFractions;
  /** Explicit engine-reported placement; must be allowed by the budget. */
  readonly usesCpuOffload: boolean;
  /**
   * Conservative engine/backend-specific upper bounds at the requested context.
   * Include graph/scratch/workspace, tokenizer, allocator fragmentation,
   * additional weight/KV replicas not represented by the placement fractions,
   * and other allocations. Per-sequence bytes scale with concurrency.
   * Values must be supplied even when known to be zero; unknown is not zero.
   */
  readonly runtime: {
    readonly hostFixedBytes: number;
    readonly hostPerSequenceBytes: number;
    readonly acceleratorFixedBytes: number;
    readonly acceleratorPerSequenceBytes: number;
  };
}

export interface ResourcePolicy {
  readonly hostReserveBytes: number;
  readonly acceleratorReserveBytes: number;
  /** Fractions of each available pool retained AFTER its reserve, at least 0.20. */
  readonly hostHeadroomFraction: number;
  readonly acceleratorHeadroomFraction: number;
}

export interface ResourceEstimateInput {
  readonly profile: HardwareProfile;
  readonly model: ModelManifest;
  readonly budget: InferenceBudget;
  readonly placement: MemoryPlacement;
  readonly policy?: ResourcePolicy;
}

export type ResourceRejectionCode =
  | "invalid-input" | "invalid-policy" | "invalid-budget" | "context-limit" | "remote-model" | "invalid-model"
  | "unknown-host-memory" | "minimum-host-memory" | "unknown-weights" | "invalid-weights"
  | "unknown-kv-cache" | "invalid-kv-cache" | "kv-context-limit" | "arithmetic-overflow"
  | "invalid-placement" | "unknown-runtime-overhead" | "accelerator-required" | "offload-not-declared"
  | "offload-disallowed" | "unknown-accelerator" | "unknown-accelerator-memory" | "minimum-accelerator-memory"
  | "unknown-memory-topology" | "host-headroom" | "accelerator-headroom" | "max-load-exceeded" | "max-accelerator-exceeded";

export interface ResourceRejection {
  readonly code: ResourceRejectionCode;
  readonly detail: string;
}

/**
 * Resource-only decision. "within-budget" is NOT permission to load: artifact
 * trust, backend/model compatibility, privacy, quality and current availability
 * still require separate checks. Values are upper bounds or null if unknown.
 */
export interface LoadEstimate {
  readonly decision: "within-budget" | "reject";
  readonly reasons: readonly ResourceRejection[];
  readonly weightsBytes: number | null;
  readonly kvCacheBytes: number | null;
  readonly hostBytes: number | null;
  readonly acceleratorBytes: number | null;
  readonly totalBytes: number | null;
  readonly hostLimitBytes: number | null;
  readonly acceleratorLimitBytes: number | null;
}

/** Adapter boundary only; no existing provider is wrapped by this slice. */
export interface EngineAdapter {
  readonly descriptor: EngineDescriptor;
  probe(): Promise<EngineHealth>;
  discoverModels(): Promise<readonly DiscoveredModel[]>;
  estimateLoad(model: ModelManifest, budget: InferenceBudget): Promise<LoadEstimate>;
  /** Future local adapters must enforce admission and other gates before loading. */
  load(model: ModelManifest, budget: InferenceBudget): Promise<LoadedModel>;
  generate(model: LoadedModel, request: InferenceRequest): Promise<InferenceResponse>;
  cancel(requestId: string): Promise<CancellationEvidence>;
  unload(model: LoadedModel): Promise<void>;
}
