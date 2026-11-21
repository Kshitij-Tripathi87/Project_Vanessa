/** Intelligence contracts only: no tool execution, approval or policy authority. */
export type ComputeBackend = "cpu" | "cuda" | "rocm" | "vulkan" | "metal" |
  "directml" | "openvino" | "qnn" | "coreml" | "unknown";

export interface AcceleratorObservation {
  id: string;
  vendor: string;
  name: string;
  memoryKind: "dedicated" | "unified" | "shared" | "unknown";
  totalMemoryBytes?: number;
  availableMemoryBytes?: number;
  driverVersion?: string;
  computeCapability?: string;
}

export interface HardwareProfile {
  profileVersion: 1;
  os: string;
  architecture: string;
  cpu: { model?: string; logicalCores: number; instructionSets: string[] };
  memory: { totalBytes: number; availableBytes: number };
  accelerators: AcceleratorObservation[];
  /** Hardware visibility is NOT engine or model compatibility evidence. */
  detectedBackends: ComputeBackend[];
  capturedAt: string;
  confidence: "complete" | "partial";
  diagnostics: string[];
}

export interface ModelManifest {
  modelId: string;
  revision: string;
  artifactFormat: "gguf" | "safetensors" | "onnx" | "remote";
  artifactSha256?: string;
  tokenizerId: string;
  tokenizerRevision?: string;
  parameterCount?: number;
  activeParameterCount?: number;
  /** Resident weight footprint including scales and non-quantized tensors. */
  weightBytes?: number;
  effectiveBitsPerWeight?: number;
  quantizationOverheadFraction?: number;
  kvCache?: { kind: "transformer"; layerCount: number; kvHeadCount: number;
    headDimension: number; bytesPerElement: number } |
    { kind: "custom"; bytesPerTokenPerSequence: number };
  nativeContextTokens: number;
  supportedModalities: string[];
  quantization: string;
  supportedBackends: ComputeBackend[];
  capabilities: { jsonMode: boolean; jsonSchemaMode: boolean; toolPlanning: boolean;
    multilingual: string[]; streaming: boolean; cancellation: boolean };
  license: string;
  trustState: "verified" | "user-imported" | "unverified";
}

export interface InferenceBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxContextTokens: number;
  maxLoadBytes: number;
  maxAcceleratorBytes: number;
  deadlineMs: number;
  concurrency: number;
  allowCpuOffload: boolean;
  allowRemote: boolean;
}

export interface EngineDescriptor {
  engineId: string;
  version: string;
  locality: "local" | "remote";
  backends: ComputeBackend[];
  artifactFormats: ModelManifest["artifactFormat"][];
}
export interface EngineHealth {
  status: "ready" | "unavailable" | "unknown";
  descriptor: EngineDescriptor;
  checkedAt: string;
  diagnostics: string[];
}
export interface DiscoveredModel { modelId: string; revision?: string; manifest?: ModelManifest }
export interface LoadedModel { modelId: string; revision: string; engineId: string; handle: string }
export interface InferenceRequest {
  requestId: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  budget: InferenceBudget;
  output: { mode: "text" | "json" } | { mode: "json-schema"; schema: Record<string, unknown> };
  signal?: AbortSignal;
}
export interface InferenceResponse {
  requestId: string;
  modelId: string;
  revision: string;
  engineId: string;
  text: string;
  finishReason: "stop" | "length" | "cancelled";
  usage?: { inputTokens: number; outputTokens: number };
}
export interface CancellationEvidence {
  requestId: string;
  state: "confirmed" | "requested" | "unsupported" | "not-found";
}
export interface LoadEstimate {
  status: "fits" | "over-budget" | "unknown";
  /** Memory fit alone never qualifies an engine/model/backend tuple. */
  scope: "memory-only";
  weightsBytes?: number;
  kvCacheBytes?: number;
  runtimeBytes?: number;
  hostBytes?: number;
  acceleratorBytes?: number;
  reasons: string[];
}
export interface EngineAdapter {
  readonly engineId: string;
  probe(): Promise<EngineHealth>;
  discoverModels(): Promise<DiscoveredModel[]>;
  estimateLoad(model: ModelManifest, budget: InferenceBudget): Promise<LoadEstimate>;
  load(model: ModelManifest, budget: InferenceBudget): Promise<LoadedModel>;
  generate(model: LoadedModel, request: InferenceRequest): Promise<InferenceResponse>;
  cancel(requestId: string): Promise<CancellationEvidence>;
  unload(modelId: string): Promise<void>;
}
