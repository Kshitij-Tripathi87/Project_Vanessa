import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { GeminiClient } from "../core/geminiClient.js";

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new GeminiClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1beta/`,
    apiKey: () => "test-key",
    timeoutMs: 1000,
  });
  return {
    client,
    baseUrl: `http://127.0.0.1:${address.port}/v1beta/`,
    async close() {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("uses the requested model, JSON planning, minimal thinking, and a reused socket without mixing context", async () => {
  const requests: any[] = [];
  const sockets = new Set();
  const previousModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  const f = await fixture((req, res) => {
    sockets.add(req.socket);
    assert.equal(req.url, "/v1beta/models/gemini-3.1-flash-lite:generateContent");
    assert.equal(req.headers["x-goog-api-key"], "test-key");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [
        { thought: true, text: "internal" }, { text: "answer" },
      ] } }] }));
    });
  });
  try {
    assert.equal(await f.client.generate("first request", "planner instructions", true), "answer");
    assert.equal(await f.client.generate("second request", "reply instructions", false), "answer");
    assert.equal(sockets.size, 1, "Sequential calls should reuse the HTTP connection");
    assert.equal(requests[0].systemInstruction.parts[0].text, "planner instructions");
    assert.equal(requests[0].generationConfig.responseMimeType, "application/json");
    assert.equal(requests[0].generationConfig.thinkingConfig.thinkingLevel, "minimal");
    assert.equal(requests[1].generationConfig.responseMimeType, undefined);
    assert.deepEqual(requests[1].contents, [{ role: "user", parts: [{ text: "second request" }] }]);
  } finally {
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
    await f.close();
  }
});

test("surfaces HTTP failures without leaking the provider body or retrying", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => {
    calls++;
    res.statusCode = 429;
    res.end("private-provider-error");
  });
  try {
    await assert.rejects(f.client.generate("request", "system", true), (error: any) => {
      assert.match(error.message, /HTTP 429/);
      assert(!error.message.includes("private-provider-error"));
      return true;
    });
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("rejects truncated, blocked, empty, and malformed responses", async () => {
  const responses = [
    JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }] }),
    JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
    JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] }),
    "not-json",
  ];
  const f = await fixture((_req, res) => { res.end(responses.shift()); });
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(f.client.generate("request", "system", true));
  } finally { await f.close(); }
});

test("bounds a stalled response and rejects missing credentials before connecting", async () => {
  const f = await fixture(() => {});
  const short = new GeminiClient({ baseUrl: f.baseUrl, apiKey: () => "test-key", timeoutMs: 30 });
  const missing = new GeminiClient({ baseUrl: f.baseUrl, apiKey: () => "" });
  try {
    await assert.rejects(short.generate("request", "system", true), /timed out/);
    await assert.rejects(missing.generate("request", "system", true), /GEMINI_API_KEY/);
  } finally {
    short.close();
    missing.close();
    await f.close();
  }
});
