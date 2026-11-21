import assert from "node:assert/strict";
import { test } from "node:test";
import { probeHardware, parseNvidiaObservations, type HardwareProbeSources } from "../intelligence/hardwareProbe.js";
import { estimateResources, type ResourceEstimateOptions } from "../intelligence/resourceEstimator.js";
import type { HardwareProfile, InferenceBudget, ModelManifest } from "../intelligence/engineAdapter.js";

const GiB = 1024 ** 3;
function profile(available = 16 * GiB): HardwareProfile {
  return { profileVersion: 1, os: "linux", architecture: "x64", cpu: { logicalCores: 8, instructionSets: [] },
    memory: { totalBytes: available, availableBytes: available }, accelerators: [], detectedBackends: ["cpu"],
    capturedAt: "2026-11-21T00:00:00.000Z", confidence: "partial", diagnostics: [] };
}
function model(): ModelManifest {
  return { modelId: "fixture", revision: "1", artifactFormat: "gguf", tokenizerId: "fixture-tokenizer",
    parameterCount: 1_000_000_000, weightBytes: GiB, nativeContextTokens: 4096,
    kvCache: { kind: "transformer", layerCount: 16, kvHeadCount: 4, headDimension: 64, bytesPerElement: 2 },
    supportedModalities: ["text"], quantization: "fixture-q8", supportedBackends: ["cpu"],
    capabilities: { jsonMode: true, jsonSchemaMode: false, toolPlanning: true, multilingual: ["en"], streaming: false, cancellation: true },
    license: "fixture-only", trustState: "unverified" };
}
function budget(): InferenceBudget {
  return { maxInputTokens: 1536, maxOutputTokens: 512, maxContextTokens: 2048,
    maxLoadBytes: 16 * GiB, maxAcceleratorBytes: 16 * GiB, deadlineMs: 10000,
    concurrency: 1, allowCpuOffload: false, allowRemote: false };
}
const options: ResourceEstimateOptions = { placement: { kind: "cpu" }, runtimeOverheadBytes: GiB / 4 };
const estimate = (m = model(), b = budget(), h = profile(), o = options) => estimateResources(m, b, h, o);

for (const [cohort, ram, expected] of [
  ["E0", 2, "over-budget"], ["E1", 8, "fits"], ["E2", 16, "fits"],
  ["E3", 32, "fits"], ["E4", 64, "fits"],
] as const) test(`${cohort} synthetic memory cohort: ${expected} (not model quality qualification)`, () => {
  assert.equal(estimate(model(), budget(), profile(ram * GiB)).status, expected);
});

test("KV estimate uses KV heads, full context and concurrent sequences", () => {
  const one = estimate();
  const two = estimate(model(), { ...budget(), concurrency: 2 });
  assert.equal(one.kvCacheBytes, 2 * 16 * 4 * 64 * 2 * 2048);
  assert.equal(two.kvCacheBytes, one.kvCacheBytes! * 2);
  assert.equal(two.weightsBytes, one.weightsBytes);
  assert.equal(two.scope, "memory-only");
});
test("known resident weights take precedence over parameter count", () => {
  assert.equal(estimate({ ...model(), parameterCount: 999_000_000_000 }).weightsBytes, GiB);
});
test("weight calculation uses total MoE parameters and explicit metadata", () => {
  const result = estimate({ ...model(), weightBytes: undefined, activeParameterCount: 1,
    effectiveBitsPerWeight: 4, quantizationOverheadFraction: 0.1 });
  assert.equal(result.weightsBytes, 550_000_000);
  assert.equal(estimate({ ...model(), weightBytes: undefined }).status, "unknown");
});
test("unknown cache layout cannot be treated as zero", () => {
  assert.equal(estimate({ ...model(), kvCache: undefined }).status, "unknown");
});
test("custom cache layout is explicit rather than using transformer assumptions", () => {
  assert.equal(estimate({ ...model(), kvCache: { kind: "custom", bytesPerTokenPerSequence: 300 } }).kvCacheBytes, 300 * 2048);
});
test("headroom boundary permits exact fit and rejects one byte less budget", () => {
  const first = estimate();
  const b = { ...budget(), maxLoadBytes: first.hostBytes! };
  assert.equal(estimate(model(), b).status, "fits");
  assert.equal(estimate(model(), { ...b, maxLoadBytes: b.maxLoadBytes - 1 }).status, "over-budget");
  // 25% of available memory after zero reserve is retained.
  const h = profile(Math.ceil(first.hostBytes! * 4 / 3));
  assert.equal(estimate(model(), b, h, { ...options, hostReserveBytes: 0 }).status, "fits");
  h.memory.availableBytes -= 1;
  assert.equal(estimate(model(), b, h, { ...options, hostReserveBytes: 0 }).status, "over-budget");
});
test("OS reserve, current available RAM and nonzero headroom are enforced", () => {
  const h = profile();
  h.memory.availableBytes = GiB;
  assert.equal(estimate(model(), budget(), h).status, "over-budget");
  assert.equal(estimate(model(), budget(), profile(), { ...options, headroomFraction: 0 }).status, "unknown");
  assert.equal(estimate(model(), budget(), profile(), { ...options, runtimeOverheadBytes: 0 }).status, "unknown");
});
for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid concurrency ${value} fails closed`, () => {
    assert.equal(estimate(model(), { ...budget(), concurrency: value }).status, "unknown");
  });
}
test("context limits, overflow, invalid cache and remote models fail closed", () => {
  assert.equal(estimate(model(), { ...budget(), maxInputTokens: 4096 }).status, "unknown");
  assert.equal(estimate(model(), { ...budget(), maxContextTokens: 8192 }).status, "unknown");
  assert.equal(estimate({ ...model(), weightBytes: Number.MAX_SAFE_INTEGER }).status, "unknown");
  assert.equal(estimate({ ...model(), kvCache: { kind: "custom", bytesPerTokenPerSequence: -1 } }).status, "unknown");
  assert.equal(estimate({ ...model(), artifactFormat: "remote" }).status, "unknown");
});
function gpuProfile(kind: "dedicated" | "shared" | "unified" | "unknown" = "dedicated") {
  const h = profile();
  h.accelerators = [{ id: "gpu:0", vendor: "fixture", name: "fixture", memoryKind: kind,
    totalMemoryBytes: 8 * GiB, availableMemoryBytes: 4 * GiB }];
  return h;
}
const offload: ResourceEstimateOptions = { ...options, placement: { kind: "dedicated", acceleratorId: "gpu:0", weightFraction: 0.5 } };
test("partial offload requires opt-in and conservatively retains host staging", () => {
  assert.equal(estimate(model(), budget(), gpuProfile(), offload).status, "unknown");
  const result = estimate(model(), { ...budget(), allowCpuOffload: true }, gpuProfile(), offload);
  assert.equal(result.status, "fits");
  assert.equal(result.hostBytes, estimate().hostBytes);
  assert.equal(result.acceleratorBytes, GiB / 2 + result.kvCacheBytes! + options.runtimeOverheadBytes);
});
test("GPU total memory cannot substitute for unknown or insufficient free memory", () => {
  const h = gpuProfile();
  const b = { ...budget(), allowCpuOffload: true };
  delete h.accelerators[0].availableMemoryBytes;
  assert.equal(estimate(model(), b, h, offload).status, "unknown");
  h.accelerators[0].availableMemoryBytes = 0;
  assert.equal(estimate(model(), b, h, offload).status, "over-budget");
  assert.equal(estimate(model(), { ...b, maxAcceleratorBytes: 1 }, gpuProfile(), offload).status, "over-budget");
});
test("unknown, shared and absent accelerator topology fail closed", () => {
  for (const h of [profile(), gpuProfile("shared"), gpuProfile("unknown")]) {
    assert.equal(estimate(model(), { ...budget(), allowCpuOffload: true }, h, offload).status, "unknown");
  }
});
test("unified memory uses one physical pool without adding GPU capacity", () => {
  const h = gpuProfile("unified");
  const o: ResourceEstimateOptions = { ...options, placement: { kind: "unified", acceleratorId: "gpu:0" } };
  const result = estimate(model(), budget(), h, o);
  assert.equal(result.status, "fits");
  assert.equal(result.hostBytes, result.acceleratorBytes);
  h.memory.availableBytes = GiB;
  assert.equal(estimate(model(), budget(), h, o).status, "over-budget");
});

const sources: HardwareProbeSources = {
  platform: () => "linux", architecture: () => "x64", cpus: () => [{ model: "fixture" }, { model: "fixture" }],
  totalMemory: () => 16 * GiB, freeMemory: () => 8 * GiB,
  cpuInfo: async () => "flags : sse2 avx avx2\nflags : sse2 avx\n",
  nvidiaInfo: async () => "0, Fixture GPU, 8192, 4096, 1.0\n",
  now: () => new Date("2026-11-21T00:00:00.000Z"),
};
test("local probe records observations without claiming GPU usability", async () => {
  const h = await probeHardware(sources);
  assert.equal(h.cpu.logicalCores, 2);
  assert.deepEqual(h.cpu.instructionSets, ["avx", "sse2"]);
  assert.equal(h.accelerators[0].availableMemoryBytes, 4 * GiB);
  assert.equal(h.accelerators[0].memoryKind, "unknown");
  assert.deepEqual(h.detectedBackends, ["cpu"]);
  assert.equal(h.confidence, "partial");
  assert.equal(h.capturedAt, "2026-11-21T00:00:00.000Z");
});
test("missing probes preserve partial/unknown state and do not echo private errors", async () => {
  const fail = async (): Promise<string> => { throw new Error("private-path-or-key"); };
  const h = await probeHardware({ ...sources, cpuInfo: fail, nvidiaInfo: fail });
  assert.deepEqual(h.cpu.instructionSets, []);
  assert.deepEqual(h.accelerators, []);
  assert.equal(h.confidence, "partial");
  assert.ok(!JSON.stringify(h).includes("private-path-or-key"));
});
test("unsupported platform never launches Linux/NVIDIA probes", async () => {
  const forbidden = async (): Promise<string> => { assert.fail("probe must not run"); };
  const h = await probeHardware({ ...sources, platform: () => "darwin", cpuInfo: forbidden, nvidiaInfo: forbidden });
  assert.equal(h.os, "darwin");
  assert.deepEqual(h.accelerators, []);
});
test("unavailable VRAM remains undefined, never zero", () => {
  const [gpu] = parseNvidiaObservations("0, Fixture GPU, [N/A], [Not Supported], 1.0");
  assert.equal(gpu.totalMemoryBytes, undefined);
  assert.equal(gpu.availableMemoryBytes, undefined);
});
test("malformed, duplicate, inconsistent and oversized GPU reports are rejected", () => {
  for (const text of ["bad", "0, GPU, 1, 2, 1", "0, GPU, 1, 1, 1\n0, GPU, 1, 1, 1", "x".repeat(65537)]) {
    assert.throws(() => parseNvidiaObservations(text));
  }
});
test("invalid host memory cannot yield a usable profile", async () => {
  await assert.rejects(probeHardware({ ...sources, freeMemory: () => 32 * GiB }));
});
