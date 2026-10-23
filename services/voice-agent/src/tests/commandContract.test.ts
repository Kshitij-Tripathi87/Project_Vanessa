import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandRequest, submitCommandRequest, type ExecuteCommandResult } from "@vanessa/shared";
import { OrchestratorClient } from "../orchestratorClient.js";

test("voice and desktop text use the same envelope keys, expiry, defaults, and full response", async () => {
  const fetchBefore = globalThis.fetch;
  const requests: any[] = [];
  const response: ExecuteCommandResult = {
    status: "awaiting_approval", spokenSummary: "Approval required.", planId: "plan1",
    plan: { id: "plan1", command: "Inspect code", risk: "high", tasks: [] },
    pendingTasks: [], sentiment: null,
    verification: { verified: false, postconditions: [], outcome: "partial" },
  };
  globalThis.fetch = (async (url: any, options: any) => {
    assert.equal(url, "http://orchestrator.test/api/execute");
    assert.equal(options.method, "POST");
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  try {
    const voice = await new OrchestratorClient("http://orchestrator.test").executeCommand({
      command: "Inspect code", requestId: "voice-turn", conversationContext: [{ role: "user", content: "Current project is Vanessa" }],
    });
    // This is the shared function used by both desktop IPC and browser preview.
    const text = await submitCommandRequest("http://orchestrator.test", {
      command: "Inspect code", source: "desktop", requestId: "text-turn",
    });
    assert.deepEqual(Object.keys(requests[0]).sort(), Object.keys(requests[1]).sort());
    assert.deepEqual(Object.keys(requests[0].envelope).sort(), Object.keys(requests[1].envelope).sort());
    assert.equal(requests[0].source, "voice");
    assert.equal(requests[1].source, "desktop");
    assert.deepEqual(requests[1].conversationContext, []);
    assert.equal(requests[1].sentiment, null);
    assert.equal(requests[0].idempotencyKey, "voice:voice-turn");
    assert.equal(requests[1].idempotencyKey, "desktop:text-turn");
    for (const body of requests) {
      assert.equal(body.language, "en");
      assert.equal(body.envelope.schemaVersion, "1.0");
      assert.equal(body.envelope.expiresAt - body.envelope.createdAt, 300000);
      assert.equal(body.envelope.requestId, body.requestId);
      assert.equal(body.envelope.idempotencyKey, body.idempotencyKey);
      assert.equal(body.envelope.source, body.source);
    }
    assert.deepEqual(voice, { ...response, requestId: "voice-turn" });
    assert.deepEqual(text, { ...response, requestId: "text-turn" });
  } finally { globalThis.fetch = fetchBefore; }
});

test("retries preserve supplied identities and envelope expiry; independent text submissions get new IDs", () => {
  const first = createCommandRequest({ command: "Inspect", source: "desktop" }, 1000);
  const retry = createCommandRequest(first, 2000);
  assert.deepEqual(retry, first);
  assert.notEqual(createCommandRequest({ command: "Inspect", source: "desktop" }).requestId, first.requestId);
  assert.equal(first.sentiment, null);
});

test("voice and text surface HTTP failures through the same client contract", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(new OrchestratorClient("http://orchestrator.test").executeCommand({ command: "Inspect" }), /HTTP 503/);
    await assert.rejects(submitCommandRequest("http://orchestrator.test", { command: "Inspect", source: "desktop" }), /HTTP 503/);
  } finally { globalThis.fetch = fetchBefore; }
});
