import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryPlacement, ResourceEstimateInput } from "../intelligence/contracts.js";
import { DEFAULT_RESOURCE_POLICY, estimateResourceFit, loadAfterResourceCheck, ResourceBudgetError } from "../intelligence/resourceEstimator.js";
import { accelerator, budget, cohorts, cpuPlacement, estimateInput, exactPolicy, GiB, gpuPlacement, MiB, model, profile } from "./fixtures/intelligenceFixtures.js";

function expectRejected(input: ResourceEstimateInput, code: string): void {
  const result = estimateResourceFit(input);
  assert.equal(result.decision, "reject");
  assert(result.reasons.some((reason) => reason.code === code), `expected ${code}, got ${JSON.stringify(result.reasons)}`);
}

test("CPU-only estimates weights, full-context KV, concurrency and runtime at the headroom boundary", () => {
  const input = estimateInput({
    profile: profile({ memory: { totalBytes: 5_000, availableBytes: 2_805 } }),
    policy: { ...exactPolicy, hostReserveBytes: 100 },
  });
  const result = estimateResourceFit(input);
  assert.equal(result.weightsBytes, 1_000);
  assert.equal(result.kvCacheBytes, 2 * 2 * 1 * 4 * 2 * 16 * 2);
  assert.equal(result.hostBytes, 1_000 + 1_024 + 100 + 20 * 2);
  assert.equal(result.totalBytes, 2_164);
  assert.equal(result.acceleratorBytes, 0);
  assert.equal(result.hostLimitBytes, 2_164);
  assert.equal(result.decision, "within-budget");
  expectRejected({ ...input, profile: profile({ memory: { totalBytes: 5_000, availableBytes: 2_804 } }) }, "host-headroom");
});

test("partial offload checks host and dedicated accelerator pools separately, at exact boundaries", () => {
  const gpu = accelerator({ totalMemoryBytes: 5_000, availableMemoryBytes: 1_390 });
  const input = estimateInput({
    profile: profile({ memory: { totalBytes: 5_000, availableBytes: 1_440 }, accelerators: [gpu] }),
    placement: gpuPlacement(), budget: budget({ maxLoadBytes: 2_264, maxAcceleratorBytes: 1_112 }),
  });
  const result = estimateResourceFit(input);
  assert.equal(result.hostBytes, 1_152);
  assert.equal(result.acceleratorBytes, 1_112);
  assert.equal(result.totalBytes, 2_264);
  assert.equal(result.hostLimitBytes, 1_152);
  assert.equal(result.acceleratorLimitBytes, 1_112);
  assert.equal(result.decision, "within-budget");
  expectRejected({ ...input, profile: { ...input.profile, memory: { totalBytes: 5_000, availableBytes: 1_439 } } }, "host-headroom");
  expectRejected({ ...input, profile: { ...input.profile, accelerators: [{ ...gpu, availableMemoryBytes: 1_389 }] } }, "accelerator-headroom");
  expectRejected({ ...input, budget: budget({ maxLoadBytes: 2_263 }) }, "max-load-exceeded");
  expectRejected({ ...input, budget: budget({ maxAcceleratorBytes: 1_111 }) }, "max-accelerator-exceeded");
});

test("shared and unified accelerator allocations also consume host headroom without being counted twice in total", () => {
  for (const topology of ["shared", "unified"] as const) {
    const gpu = accelerator({ totalMemoryBytes: 5_000, availableMemoryBytes: 1_390, memoryTopology: topology });
    const input = estimateInput({ profile: profile({ memory: { totalBytes: 5_000, availableBytes: 1_440 }, accelerators: [gpu] }), placement: gpuPlacement() });
    const rejected = estimateResourceFit(input);
    assert.equal(rejected.acceleratorBytes, 1_112);
    assert.equal(rejected.hostBytes, 2_264);
    assert.equal(rejected.totalBytes, 2_264);
    assert(rejected.reasons.some((reason) => reason.code === "host-headroom"));
    const fits = estimateResourceFit({ ...input, profile: { ...input.profile, memory: { totalBytes: 5_000, availableBytes: 2_830 } } });
    assert.equal(fits.hostLimitBytes, 2_264);
    assert.equal(fits.decision, "within-budget");
  }
});

test("explicit duplicated host/device copies are not mistaken for a single allocation", () => {
  const input = estimateInput({
    profile: profile({ accelerators: [accelerator()] }),
    placement: gpuPlacement({ weights: { host: 1, accelerator: 1 }, kvCache: { host: 1, accelerator: 1 }, usesCpuOffload: false }),
  });
  const result = estimateResourceFit(input);
  assert.equal(result.hostBytes, 2_164);
  assert.equal(result.acceleratorBytes, 2_124);
  assert.equal(result.totalBytes, 4_288);
  assert.equal(result.decision, "within-budget");
});

test("parameter-based weights include quantization metadata and all stored MoE parameters", () => {
  const candidate = model({
    parameterCount: 1_000, activeParameterCount: 1,
    memory: { weights: { kind: "parameter-estimate", effectiveBitsPerParameter: 4.5, extraBytes: 100 },
      kvCache: { kind: "conventional-transformer", bytesPerElement: 2 } },
  });
  assert.equal(estimateResourceFit(estimateInput({ model: candidate })).weightsBytes, 663);
  expectRejected(estimateInput({ model: { ...candidate, parameterCount: undefined } }), "invalid-weights");
  expectRejected(estimateInput({ model: { ...candidate, parameterCount: Number.MAX_SAFE_INTEGER, memory: {
    weights: { kind: "parameter-estimate", effectiveBitsPerParameter: 16, extraBytes: 100 }, kvCache: candidate.memory!.kvCache,
  } } }), "arithmetic-overflow");
  expectRejected(estimateInput({ model: { ...candidate, memory: { kvCache: candidate.memory!.kvCache } } }), "unknown-weights");
});

test("nonstandard and quantized KV layouts need an explicit bounded estimate, not the transformer formula", () => {
  const bounded = model({ memory: {
    weights: { kind: "resident-upper-bound", bytes: 1_000 },
    kvCache: { kind: "sequence-upper-bound", maxContextTokens: 16, bytesPerSequence: 512 },
  } });
  assert.equal(estimateResourceFit(estimateInput({ model: bounded })).kvCacheBytes, 1_024);
  expectRejected(estimateInput({ model: bounded, budget: budget({ maxInputTokens: 9, maxContextTokens: 17 }) }), "kv-context-limit");
  expectRejected(estimateInput({ model: { ...bounded, memory: { weights: bounded.memory!.weights } } }), "unknown-kv-cache");
  const invalidQuantized = { kind: "conventional-transformer", bytesPerElement: 1 } as unknown as NonNullable<NonNullable<typeof bounded.memory>["kvCache"]>;
  expectRejected(estimateInput({ model: { ...bounded, memory: { weights: bounded.memory!.weights, kvCache: invalidQuantized } } }), "invalid-kv-cache");
});

test("unknown or contradictory host and accelerator facts fail closed rather than becoming zero", () => {
  for (const memory of [
    { totalBytes: null, availableBytes: null },
    { totalBytes: 10_000, availableBytes: null },
    { totalBytes: 10_000, availableBytes: 10_001 },
    { totalBytes: NaN, availableBytes: 1_000 },
  ]) expectRejected(estimateInput({ profile: profile({ memory }) }), "unknown-host-memory");
  const incompleteMemory = profile();
  expectRejected(estimateInput({ profile: { ...incompleteMemory, probes: { ...incompleteMemory.probes, memory: "partial" } } }), "unknown-host-memory");

  const known = accelerator();
  for (const device of [
    { ...known, totalMemoryBytes: null },
    { ...known, availableMemoryBytes: null },
    { ...known, availableMemoryBytes: known.totalMemoryBytes! + 1 },
  ]) expectRejected(estimateInput({ profile: profile({ accelerators: [device] }), placement: gpuPlacement() }), "unknown-accelerator-memory");
  expectRejected(estimateInput({ profile: profile({ accelerators: [{ ...known, memoryTopology: "unknown" }] }), placement: gpuPlacement() }), "unknown-memory-topology");
  expectRejected(estimateInput({ profile: profile({ accelerators: [] }), placement: gpuPlacement() }), "unknown-accelerator");
  expectRejected(estimateInput({ profile: profile({ accelerators: [known, { ...known, availableMemoryBytes: 1 }] }), placement: gpuPlacement() }), "unknown-accelerator");
  expectRejected(estimateInput({ profile: profile({ accelerators: [known], acceleratorInventory: "unavailable" }), placement: gpuPlacement() }), "unknown-accelerator");
});

test("placement must account for all allocations and declare/allow CPU offload", () => {
  const input = estimateInput({ profile: profile({ accelerators: [accelerator()] }), placement: gpuPlacement() });
  expectRejected({ ...input, placement: gpuPlacement({ weights: { host: 0.3, accelerator: 0.5 } }) }, "invalid-placement");
  expectRejected({ ...input, placement: gpuPlacement({ kvCache: { host: 0, accelerator: 1 }, usesCpuOffload: false }) }, "offload-not-declared");
  expectRejected({ ...input, budget: budget({ allowCpuOffload: false }) }, "offload-disallowed");
  expectRejected({ ...input, placement: gpuPlacement({ acceleratorId: null }) }, "invalid-placement");
  expectRejected({ ...input, placement: gpuPlacement({ runtime: undefined } as unknown as Partial<MemoryPlacement>) }, "unknown-runtime-overhead");
  expectRejected({ ...input, placement: gpuPlacement({ runtime: { hostFixedBytes: 0, hostPerSequenceBytes: 0, acceleratorFixedBytes: 80, acceleratorPerSequenceBytes: 10 } }) }, "unknown-runtime-overhead");
  expectRejected({ ...input, placement: gpuPlacement({ runtime: { hostFixedBytes: 100, hostPerSequenceBytes: 20, acceleratorFixedBytes: 0, acceleratorPerSequenceBytes: 0 } }) }, "unknown-runtime-overhead");
});

test("rejects inadequate/invalid headroom, impossible contexts, minimums and remote artifacts", () => {
  const input = estimateInput();
  expectRejected({ ...input, policy: { ...exactPolicy, hostHeadroomFraction: 0.199 } }, "invalid-policy");
  expectRejected({ ...input, policy: { ...exactPolicy, acceleratorHeadroomFraction: 1 } }, "invalid-policy");
  expectRejected({ ...input, budget: budget({ maxInputTokens: 9 }) }, "context-limit");
  expectRejected({ ...input, budget: budget({ maxContextTokens: 512 }) }, "context-limit");
  expectRejected({ ...input, budget: budget({ concurrency: 0 }) }, "invalid-budget");
  expectRejected({ ...input, budget: budget({ maxLoadBytes: Infinity }) }, "invalid-budget");
  expectRejected({ ...input, model: model({ minimumRamBytes: 9 * GiB }) }, "minimum-host-memory");
  expectRejected({ ...input, model: model({ minimumVramBytes: 1 }) }, "accelerator-required");
  expectRejected({ ...input, model: model({ artifactFormat: "remote" }), budget: budget({ allowRemote: true }) }, "remote-model");
});

test("overflow in cache and per-sequence runtime calculations is rejected", () => {
  expectRejected(estimateInput({ model: model({ layerCount: Number.MAX_SAFE_INTEGER }) }), "arithmetic-overflow");
  expectRejected(estimateInput({ placement: cpuPlacement({ runtime: {
    hostFixedBytes: 100, hostPerSequenceBytes: Number.MAX_SAFE_INTEGER, acceleratorFixedBytes: 0, acceleratorPerSequenceBytes: 0,
  } }) }), "arithmetic-overflow");
});

test("large byte counts retain conservative rounding for decimal weights, placements and headroom", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const largeHost = profile({ memory: { totalBytes: max, availableBytes: max } });
  const input = estimateInput({ profile: largeHost, budget: budget({ maxLoadBytes: max }) });
  const hostLimit = Number(BigInt(max) * 4n / 5n);
  assert.equal(estimateResourceFit(input).hostLimitBytes, hostLimit);

  const counted = model({ parameterCount: max, memory: {
    weights: { kind: "parameter-estimate", effectiveBitsPerParameter: 0.1, extraBytes: 0 },
    kvCache: { kind: "conventional-transformer", bytesPerElement: 2 },
  } });
  const expectedWeights = Number((BigInt(max) + 79n) / 80n);
  assert.equal(estimateResourceFit({ ...input, model: counted }).weightsBytes, expectedWeights);

  const largeWeights = max - 10_000;
  const gpu = accelerator({ totalMemoryBytes: max, availableMemoryBytes: max });
  const split = estimateResourceFit({ ...input, profile: { ...largeHost, accelerators: [gpu] },
    budget: budget({ maxLoadBytes: max, maxAcceleratorBytes: max }),
    model: model({ memory: { weights: { kind: "resident-upper-bound", bytes: largeWeights },
      kvCache: { kind: "conventional-transformer", bytesPerElement: 2 } } }),
    placement: gpuPlacement({ weights: { host: 0.3, accelerator: 0.7 } }),
  });
  const hostWeights = Number((BigInt(largeWeights) * 3n + 9n) / 10n);
  const gpuWeights = Number((BigInt(largeWeights) * 7n + 9n) / 10n);
  assert.equal(split.hostBytes, hostWeights + 512 + 140);
  assert.equal(split.acceleratorBytes, gpuWeights + 512 + 100);
  assert.equal(split.decision, "within-budget");
});

test("more concurrent sequences never reduce KV or turn a no-fit into a fit", () => {
  let priorKv = 0;
  let seenRejection = false;
  for (let concurrency = 1; concurrency <= 8; concurrency++) {
    const result = estimateResourceFit(estimateInput({
      profile: profile({ memory: { totalBytes: 5_000, availableBytes: 3_000 } }),
      budget: budget({ concurrency }),
    }));
    assert(result.kvCacheBytes! > priorKv);
    priorKv = result.kvCacheBytes!;
    if (result.decision === "reject") seenRejection = true;
    if (seenRejection) assert.equal(result.decision, "reject");
  }
  assert(seenRejection);
});

test("synthetic E0–E4 cases use measured pools, reserves and a model estimate rather than tier assumptions", () => {
  assert.equal(DEFAULT_RESOURCE_POLICY.hostHeadroomFraction, 0.25);
  assert.equal(DEFAULT_RESOURCE_POLICY.acceleratorHeadroomFraction, 0.25);
  const candidate = model({
    parameterCount: 2_000_000_000, layerCount: 24, kvHeadCount: 8, headDimension: 64, nativeContextTokens: 4_096,
    memory: { weights: { kind: "parameter-estimate", effectiveBitsPerParameter: 4.5, extraBytes: 64 * MiB },
      kvCache: { kind: "conventional-transformer", bytesPerElement: 2 } },
  });
  const limits = budget({ maxInputTokens: 1_536, maxOutputTokens: 512, maxContextTokens: 2_048,
    maxLoadBytes: 8 * GiB, maxAcceleratorBytes: 4 * GiB, concurrency: 1 });
  for (const fixture of cohorts()) {
    const placement = fixture.placement.acceleratorId ? gpuPlacement({
      runtime: { hostFixedBytes: 192 * MiB, hostPerSequenceBytes: 32 * MiB, acceleratorFixedBytes: 128 * MiB, acceleratorPerSequenceBytes: 32 * MiB },
    }) : cpuPlacement({ runtime: { hostFixedBytes: 192 * MiB, hostPerSequenceBytes: 32 * MiB, acceleratorFixedBytes: 0, acceleratorPerSequenceBytes: 0 } });
    const result = estimateResourceFit(estimateInput({ profile: fixture.profile, model: candidate, budget: limits, placement, policy: undefined }));
    assert.equal(result.decision, "within-budget", `${fixture.name}: ${JSON.stringify(result.reasons)}`);
    assert(result.hostBytes! <= result.hostLimitBytes!);
    assert(result.acceleratorBytes! <= result.acceleratorLimitBytes!);
  }
  const constrained = estimateResourceFit(estimateInput({ profile: profile({ memory: { totalBytes: 2 * GiB, availableBytes: 512 * MiB } }),
    model: candidate, budget: limits, policy: undefined }));
  assert.equal(constrained.decision, "reject");
  assert(constrained.reasons.some((reason) => reason.code === "host-headroom"));
});

test("the optional admission helper never invokes a loader for unknown or over-budget candidates", async () => {
  let called = 0;
  const load = async () => { called++; return "loaded"; };
  await assert.rejects(loadAfterResourceCheck(estimateInput({ model: model({ memory: undefined }) }), load), (error) => {
    assert(error instanceof ResourceBudgetError);
    assert.equal(error.estimate.decision, "reject");
    return true;
  });
  await assert.rejects(loadAfterResourceCheck(estimateInput({ budget: budget({ maxLoadBytes: 1 }) }), load), ResourceBudgetError);
  assert.equal(called, 0);
  assert.equal(await loadAfterResourceCheck(estimateInput(), load), "loaded");
  assert.equal(called, 1);
});
