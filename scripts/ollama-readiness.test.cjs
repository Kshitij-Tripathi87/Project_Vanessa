const { test } = require("node:test");
const assert = require("node:assert/strict");
const { probeOllama } = require("./ollama-readiness.cjs");

test("Ollama probe checks the selected local model", async () => {
  let requestedUrl = "";
  const result = await probeOllama("http://127.0.0.1:11434", "qwen2.5:3b", {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen2.5:3b" }] }) };
    },
    now: () => 10,
  });
  assert.equal(requestedUrl, "http://127.0.0.1:11434/api/tags");
  assert.equal(result.status, "ONLINE");
  assert.equal(result.ok, true);
  assert.match(result.message, /qwen2\.5:3b.*ready/i);
});

test("Ollama probe reports a missing model as degraded rather than service-offline", async () => {
  const result = await probeOllama("http://localhost:11434/", "qwen2.5:3b", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: "llama3.2:1b" }] }) }),
  });
  assert.equal(result.status, "DEGRADED");
  assert.equal(result.ok, false);
  assert.match(result.message, /not installed/i);
  assert.match(result.message, /setup\/repair/);
});

test("Ollama probe refuses non-loopback endpoints without making a request", async () => {
  let called = false;
  const result = await probeOllama("https://example.com", "qwen2.5:3b", {
    fetchImpl: async () => { called = true; throw new Error("must not call"); },
  });
  assert.equal(called, false);
  assert.equal(result.status, "OFFLINE");
  assert.match(result.message, /remote endpoints are refused/i);
});

test("Ollama probe returns an actionable offline diagnosis without echoing internals", async () => {
  const result = await probeOllama("http://127.0.0.1:11434", "qwen2.5:3b", {
    fetchImpl: async () => { throw new Error("private network detail"); },
  });
  assert.equal(result.status, "OFFLINE");
  assert.match(result.message, /Start Ollama/);
  assert.doesNotMatch(result.message, /private network detail/);
});

test("Ollama probe rejects URL paths and credentials", async () => {
  let called = false;
  for (const url of ["http://127.0.0.1:11434/api/tags", "http://user:pass@localhost:11434"]) {
    const result = await probeOllama(url, "qwen2.5:3b", {
      fetchImpl: async () => { called = true; throw new Error("must not call"); },
    });
    assert.equal(result.status, "OFFLINE");
  }
  assert.equal(called, false);
});
