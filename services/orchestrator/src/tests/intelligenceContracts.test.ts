import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineAdapter, EngineDescriptor, InferenceRequest, LoadedModel } from "../intelligence/contracts.js";
import { estimateResourceFit } from "../intelligence/resourceEstimator.js";
import { budget, estimateInput, model } from "./fixtures/intelligenceFixtures.js";

test("a synthetic engine can implement the provider-neutral lifecycle without planner or tool authority", async () => {
  const descriptor: EngineDescriptor = {
    engineId: "synthetic", version: "1", locality: "local", artifactFormats: ["gguf"], backends: ["cpu"],
    operatingSystems: ["linux"], architectures: ["x64"],
    capabilities: { streaming: false, cancellation: true, jsonMode: true, jsonSchemaMode: false },
  };
  const calls: string[] = [];
  const loaded: LoadedModel = { modelId: "synthetic-model", revision: "1", engineId: "synthetic", handle: "opaque" };
  const adapter: EngineAdapter = {
    descriptor,
    async probe() { calls.push("probe"); return { status: "ready", evidence: [] }; },
    async discoverModels() { calls.push("discover"); return [{ modelId: loaded.modelId, locality: "local", available: true, manifest: model() }]; },
    async estimateLoad() { calls.push("estimate"); return estimateResourceFit(estimateInput()); },
    async load() { calls.push("load"); return loaded; },
    async generate(_model, request) { calls.push("generate"); return { requestId: request.requestId, modelId: loaded.modelId, text: "{}", finishReason: "stop" }; },
    async cancel(requestId) { calls.push("cancel"); return { requestId, status: "cancelled" }; },
    async unload() { calls.push("unload"); },
  };
  const request: InferenceRequest = { requestId: "request-1", messages: [{ role: "user", content: "hello" }], budget: budget(), responseFormat: "json" };
  assert.equal((await adapter.probe()).status, "ready");
  assert.equal((await adapter.discoverModels())[0].modelId, loaded.modelId);
  assert.equal((await adapter.estimateLoad(model(), budget())).decision, "within-budget");
  const handle = await adapter.load(model(), budget());
  assert.equal((await adapter.generate(handle, request)).requestId, request.requestId);
  assert.equal((await adapter.cancel(request.requestId)).status, "cancelled");
  await adapter.unload(handle);
  assert.deepEqual(calls, ["probe", "discover", "estimate", "load", "generate", "cancel", "unload"]);
});
