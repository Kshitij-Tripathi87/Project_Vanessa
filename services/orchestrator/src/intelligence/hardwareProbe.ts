import type {
  AcceleratorProfile,
  BackendEvidence,
  CpuProfile,
  HardwareProfile,
  MemoryProfile,
  ProbeStatus,
} from "./contracts.js";
import { createLocalHardwareProviders } from "./localHardwareSources.js";

export interface ProbeResult<T> {
  readonly status: ProbeStatus;
  readonly value: T | null;
}

type MaybePromise<T> = T | Promise<T>;

/** Providers are local-only. Injected engine probes must not upload the profile. */
export interface HardwareProbeProviders {
  readonly system: () => MaybePromise<ProbeResult<{ readonly os: string | null; readonly architecture: string | null }>>;
  readonly cpu: () => MaybePromise<ProbeResult<CpuProfile>>;
  readonly memory: () => MaybePromise<ProbeResult<MemoryProfile>>;
  readonly accelerators: () => MaybePromise<ProbeResult<readonly AcceleratorProfile[]>>;
  readonly backends: (accelerators: readonly AcceleratorProfile[]) => MaybePromise<ProbeResult<readonly BackendEvidence[]>>;
  readonly now: () => Date;
}

const isStatus = (status: unknown): status is ProbeStatus =>
  status === "complete" || status === "partial" || status === "unavailable";
const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const bytesOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const positiveOrNull = (value: unknown): number | null => {
  const n = bytesOrNull(value);
  return n !== null && n > 0 ? n : null;
};

async function safelyProbe<T>(probe: () => MaybePromise<ProbeResult<T>>): Promise<ProbeResult<T>> {
  try {
    const result = await probe();
    if (!result || !isStatus(result.status) || result.status === "unavailable") return { status: "unavailable", value: null };
    return { status: result.status, value: result.value ?? null };
  } catch {
    // Do not include raw errors: they may contain local paths or command output.
    return { status: "unavailable", value: null };
  }
}

function fieldStatus(reported: ProbeStatus, present: boolean, complete: boolean): ProbeStatus {
  if (reported === "unavailable" || !present) return "unavailable";
  return reported === "complete" && complete ? "complete" : "partial";
}

function normalizeAccelerator(raw: AcceleratorProfile): AcceleratorProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const id = stringOrNull(raw.id);
  if (!id) return null;
  const total = positiveOrNull(raw.totalMemoryBytes);
  let available = bytesOrNull(raw.availableMemoryBytes);
  if (total !== null && available !== null && available > total) available = null;
  const topology = ["dedicated", "shared", "unified"].includes(raw.memoryTopology)
    ? raw.memoryTopology : "unknown";
  return {
    id,
    vendor: stringOrNull(raw.vendor),
    name: stringOrNull(raw.name),
    pciDeviceId: stringOrNull(raw.pciDeviceId),
    totalMemoryBytes: total,
    availableMemoryBytes: available,
    memoryTopology: topology,
    driverVersion: stringOrNull(raw.driverVersion),
    computeCapability: stringOrNull(raw.computeCapability),
  };
}

const knownBackends = new Set(["cpu", "cuda", "rocm", "vulkan", "metal", "directml", "openvino", "qnn", "coreml"]);

function normalizeBackend(raw: BackendEvidence, deviceIds: ReadonlySet<string>): BackendEvidence | null {
  if (!raw || typeof raw !== "object" || !knownBackends.has(raw.backend)) return null;
  const engineId = stringOrNull(raw.engineId);
  if (!engineId || (raw.scope !== "engine" && raw.scope !== "device")) return null;
  const acceleratorId = stringOrNull(raw.acceleratorId);
  if (raw.scope === "engine" && acceleratorId !== null) return null;
  if (raw.backend === "cpu" && acceleratorId !== null) return null;
  if (raw.scope === "device" && raw.backend !== "cpu" && (!acceleratorId || !deviceIds.has(acceleratorId))) return null;
  if (acceleratorId && !deviceIds.has(acceleratorId)) return null;
  const validEvidence = raw.evidence && (raw.evidence.kind === "engine-probe" || raw.evidence.kind === "backend-test")
    && stringOrNull(raw.evidence.detail);
  const evidence = validEvidence && raw.evidence
    ? { kind: raw.evidence.kind, detail: stringOrNull(raw.evidence.detail)! } : null;
  const status = raw.status === "supported" || raw.status === "unsupported" || raw.status === "unknown"
    ? raw.status : "unknown";
  // An assertion without an actual probe is unknown, never positive evidence.
  return { backend: raw.backend, engineId, scope: raw.scope, acceleratorId, status: evidence ? status : "unknown", evidence };
}

/**
 * Collect a local snapshot. Missing facts stay null, errors become unavailable,
 * and GPU discovery does not imply that any inference backend works. No profile
 * is logged, persisted, or transmitted by this module.
 */
export async function probeHardware(overrides: Partial<HardwareProbeProviders> = {}): Promise<HardwareProfile> {
  const providers: HardwareProbeProviders = { ...createLocalHardwareProviders(), ...overrides };
  const [systemResult, cpuResult, memoryResult, acceleratorResult] = await Promise.all([
    safelyProbe(providers.system),
    safelyProbe(providers.cpu),
    safelyProbe(providers.memory),
    safelyProbe(providers.accelerators),
  ]);

  const os = stringOrNull(systemResult.value?.os);
  const architecture = stringOrNull(systemResult.value?.architecture);
  const systemStatus = fieldStatus(systemResult.status, !!os || !!architecture, !!os && !!architecture);

  const rawCpu = cpuResult.value;
  const rawInstructionSets = rawCpu?.instructionSets;
  const instructionSets = Array.isArray(rawInstructionSets)
    && rawInstructionSets.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    ? [...new Set(rawInstructionSets.map((entry) => entry.trim().toLowerCase()))].sort() : null;
  const cpu: CpuProfile = {
    vendor: stringOrNull(rawCpu?.vendor),
    model: stringOrNull(rawCpu?.model),
    logicalCores: positiveOrNull(rawCpu?.logicalCores),
    instructionSets,
  };
  const cpuPresent = cpu.vendor !== null || cpu.model !== null || cpu.logicalCores !== null || instructionSets !== null;
  const cpuComplete = cpu.vendor !== null && cpu.model !== null && cpu.logicalCores !== null && instructionSets !== null;
  const cpuStatus = fieldStatus(cpuResult.status, cpuPresent, cpuComplete);

  const totalBytes = positiveOrNull(memoryResult.value?.totalBytes);
  let availableBytes = bytesOrNull(memoryResult.value?.availableBytes);
  if (totalBytes !== null && availableBytes !== null && availableBytes > totalBytes) availableBytes = null;
  const memory: MemoryProfile = { totalBytes, availableBytes };
  const memoryStatus = fieldStatus(memoryResult.status, totalBytes !== null || availableBytes !== null,
    totalBytes !== null && availableBytes !== null);

  let acceleratorStatus = acceleratorResult.status;
  const accelerators: AcceleratorProfile[] = [];
  const ids = new Set<string>();
  const ambiguousIds = new Set<string>();
  if (acceleratorResult.value !== null && !Array.isArray(acceleratorResult.value)) {
    acceleratorStatus = acceleratorStatus === "unavailable" ? "unavailable" : "partial";
  } else {
    for (const raw of acceleratorResult.value ?? []) {
      const item = normalizeAccelerator(raw);
      if (!item || ids.has(item.id) || ambiguousIds.has(item.id)) {
        if (acceleratorStatus === "complete") acceleratorStatus = "partial";
        if (item && ids.has(item.id)) {
          // Conflicting observations for one ID cannot safely supply free VRAM.
          ambiguousIds.add(item.id);
          ids.delete(item.id);
          accelerators.splice(accelerators.findIndex((device) => device.id === item.id), 1);
        }
        continue;
      }
      ids.add(item.id);
      accelerators.push(item);
    }
    if (acceleratorResult.value === null && acceleratorStatus === "complete") acceleratorStatus = "partial";
  }

  const backendResult = await safelyProbe(() => providers.backends(accelerators));
  let backendStatus = backendResult.status;
  const backendEvidence: BackendEvidence[] = [];
  const backendKeys = new Map<string, number>();
  if (backendResult.value !== null && !Array.isArray(backendResult.value)) {
    backendStatus = backendStatus === "unavailable" ? "unavailable" : "partial";
  } else {
    for (const raw of backendResult.value ?? []) {
      const item = normalizeBackend(raw, ids);
      if (!item || item.status === "unknown") {
        if (backendStatus === "complete") backendStatus = "partial";
      }
      if (!item) continue;
      const key = JSON.stringify([item.engineId, item.backend, item.scope, item.acceleratorId]);
      const existing = backendKeys.get(key);
      if (existing === undefined) {
        backendKeys.set(key, backendEvidence.length);
        backendEvidence.push(item);
      } else if (backendEvidence[existing].status !== item.status) {
        // Conflicting reports for the same tuple are not positive evidence.
        backendEvidence[existing] = { ...item, status: "unknown", evidence: null };
        if (backendStatus === "complete") backendStatus = "partial";
      }
    }
    if (backendResult.value === null && backendStatus === "complete") backendStatus = "partial";
  }
  // A completed probe of one engine does not cover untested devices. Retain its
  // positive facts, but do not label the whole backend observation complete.
  const cpuCovered = backendEvidence.some((item) => item.backend === "cpu" && item.status !== "unknown");
  const devicesCovered = accelerators.every((device) => backendEvidence.some((item) =>
    item.scope === "device" && item.acceleratorId === device.id && item.status !== "unknown"));
  if (backendStatus === "complete" && (!cpuCovered || !devicesCovered)) backendStatus = "partial";
  const detectedBackends = [...new Set(backendEvidence.filter((item) => item.status === "supported").map((item) => item.backend))];

  let capturedAt: string;
  let validClock = true;
  try {
    capturedAt = providers.now().toISOString();
  } catch {
    capturedAt = new Date().toISOString();
    validClock = false;
  }
  const completeAcceleratorDetails = accelerators.every((device) => device.vendor !== null && device.name !== null
    && device.totalMemoryBytes !== null && device.availableMemoryBytes !== null
    && device.memoryTopology !== "unknown" && device.driverVersion !== null);
  const confidence = validClock && systemStatus === "complete" && cpuStatus === "complete"
    && memoryStatus === "complete" && acceleratorStatus === "complete" && completeAcceleratorDetails
    && backendStatus === "complete" ? "complete" : "partial";

  return {
    profileVersion: 1,
    os,
    architecture,
    cpu,
    memory,
    accelerators,
    acceleratorInventory: acceleratorStatus,
    backendEvidence,
    detectedBackends,
    probes: { system: systemStatus, cpu: cpuStatus, memory: memoryStatus, accelerators: acceleratorStatus, backends: backendStatus },
    capturedAt,
    confidence,
  };
}
