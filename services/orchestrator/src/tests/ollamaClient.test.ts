import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { OllamaClient } from "../core/ollamaClient.js";

async function withServer(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void, run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("Ollama sends keyless loopback chat requests and supports JSON planning mode", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/api/chat"); assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    let body = ""; request.on("data", chunk => { body += chunk.toString(); });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, "qwen2.5:3b"); assert.equal(parsed.stream, false); assert.equal(parsed.format, "json");
      assert.deepEqual(parsed.messages, [{ role: "system", content: "Return a plan." }, { role: "user", content: "Open Settings." }]);
      assert.equal(request.headers["x-request-id"], "test-request-1");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: { role: "assistant", content: '{"tasks":[]}' }, done: true, done_reason: "stop" }));
    });
  }, async url => {
    const client = new OllamaClient({ baseUrl: url });
    assert.equal(await client.generate("Open Settings.", "Return a plan.", true, "test-request-1"), '{"tasks":[]}');
  });
});

test("Ollama rejects non-loopback or non-origin URLs", () => {
  for (const baseUrl of ["https://example.com", "http://192.168.1.5:11434", "http://127.0.0.1:11434/api", "http://user:pass@127.0.0.1:11434"]) {
    assert.throws(() => new OllamaClient({ baseUrl }), /loopback origin/i);
  }
});

test("Ollama errors are bounded and provider response bodies are not echoed", async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"private server detail"}');
  }, async url => {
    await assert.rejects(new OllamaClient({ baseUrl: url }).generate("hello", "reply", false), /HTTP 503/);
    const malformed = new OllamaClient({ baseUrl: url, fetchImpl: async () => new Response("not-json", { status: 200 }) });
    await assert.rejects(malformed.generate("hello", "reply", false), /invalid JSON response/i);
  });
});

test("Ollama rejects incomplete and empty results", async () => {
  for (const payload of [{ message: { content: "partial" }, done: false }, { message: { content: "partial" }, done: true, done_reason: "length" }, { message: { content: "" }, done: true }]) {
    const client = new OllamaClient({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
    await assert.rejects(client.generate("hello", "reply", false), /incomplete response|no usable response/i);
  }
});
