import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { NvidiaClient } from "../core/nvidiaClient.js";

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const client = new NvidiaClient({ baseUrl, apiKey: () => "test-key", timeoutMs: 1000 });
  return {
    client, baseUrl,
    async close() {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("uses NVIDIA chat completions for JSON plans and speech, reusing the connection without mixing context", async () => {
  const requests: any[] = [];
  const sockets = new Set();
  const previousModel = process.env.NVIDIA_MODEL;
  process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
  const f = await fixture((req, res) => {
    sockets.add(req.socket);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.headers["x-goog-api-key"], undefined);
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "answer", reasoning_content: "internal" } }] }));
    });
  });
  try {
    assert.equal(await f.client.generate("first request", "planner instructions", true), "answer");
    assert.equal(await f.client.generate("second request", "reply instructions", false), "answer");
    assert.equal(sockets.size, 1);
    assert.equal(requests[0].model, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: false });
    assert.equal(requests[0].reasoning_effort, undefined);
    assert.equal(requests[0].max_tokens, 4096);
    assert.equal(requests[1].max_tokens, 256);
    assert.equal(requests[1].response_format, undefined);
    assert.deepEqual(requests[1].messages, [
      { role: "system", content: "reply instructions" },
      { role: "user", content: "second request" },
    ]);
  } finally {
    if (previousModel === undefined) delete process.env.NVIDIA_MODEL;
    else process.env.NVIDIA_MODEL = previousModel;
    await f.close();
  }
});

test("logs the provider error and matching request ID while redacting credentials", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  let calls = 0;
  const f = await fixture((_req, res) => {
    calls++;
    res.statusCode = 429;
    res.setHeader("x-request-id", "provider-123");
    res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error", api_key: "test-key" } }));
  });
  try {
    await assert.rejects(f.client.generate("private request prompt", "private system prompt", true, "request-123"), (error: any) => {
      assert.match(error.message, /HTTP 429/);
      assert.match(error.message, /Rate limit exceeded/);
      assert(!error.message.includes("test-key"));
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /request=request-123/);
    assert.match(logs[0], /HTTP=429/);
    assert.match(logs[0], /providerRequestId="provider-123"/);
    assert.match(logs[0], /Rate limit exceeded/);
    assert.match(logs[0], /rate_limit_error/);
    assert.match(logs[0], /\[REDACTED\]/);
    assert(!logs[0].includes("test-key"));
    assert(!logs[0].includes("private request prompt"));
    assert(!logs[0].includes("private system prompt"));
  } finally { await f.close(); }
});

test("prints indented assistant JSON with parsed content, without truncation or exposed credentials", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args.join(" ")); });
  const plan = { intent: "single_task", tasks: [{ id: "t1", agent: "windows", action: "app.open", params: { name: "brave" } }], detail: "x".repeat(9000) + " END-OF-RESPONSE test-key" };
  const content = JSON.stringify(plan);
  const responseBody = " \n" + JSON.stringify({ id: "chatcmpl-test", choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { total_tokens: 100 } }) + "\n";
  const f = await fixture((_req, res) => { res.end(responseBody); });
  try {
    assert.equal(await f.client.generate("request", "system", true, "response-request"), content);
    const responseLog = logs.find((line) => line.startsWith("[NVIDIA] response "));
    assert(responseLog);
    assert.match(responseLog, /request=response-request/);
    assert.match(responseLog, /HTTP=200/);
    assert.equal(responseLog.slice(responseLog.indexOf("\n") + 1), JSON.stringify({ content: plan, role: "assistant" }, null, 2).replaceAll("test-key", "[REDACTED]"));
    assert(!responseLog.includes("chatcmpl-test"));
    assert(!responseLog.includes('"usage"'));
    assert(responseLog.includes("END-OF-RESPONSE"));
    assert(!responseLog.includes("test-key"));
  } finally { await f.close(); }
});

test("rejects truncated, refused, empty, and malformed responses", async () => {
  const responses = [
    JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    JSON.stringify({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }),
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: null, reasoning_content: "internal" } }] }),
    "not-json",
  ];
  const f = await fixture((_req, res) => { res.end(responses.shift()); });
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(f.client.generate("request", "system", true));
  } finally { await f.close(); }
});

test("logs an exact timeout with request ID, phase, and no HTTP response", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  const f = await fixture(() => {});
  const short = new NvidiaClient({ baseUrl: f.baseUrl, apiKey: () => "test-key", timeoutMs: 30 });
  const missing = new NvidiaClient({ baseUrl: f.baseUrl, apiKey: () => "" });
  try {
    await assert.rejects(short.generate("request", "system", true, "timeout-request"), /NVIDIA request timed out after 30 ms/);
    await assert.rejects(missing.generate("request", "system", true), /NVIDIA_API_KEY/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /request=timeout-request/);
    assert.match(logs[0], /phase=waiting_for_headers/);
    assert.match(logs[0], /HTTP=none/);
    assert.match(logs[0], /responseBytes=0/);
    assert.match(logs[0], /ETIMEDOUT/);
  } finally {
    short.close();
    missing.close();
    await f.close();
  }
});

test("preserves the underlying network error message and code", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  const f = await fixture((req) => { req.socket.destroy(); });
  try {
    await assert.rejects(f.client.generate("request", "system", true, "network-request"), (error: any) => {
      assert.equal(error.code, "ECONNRESET");
      assert.match(error.message, /socket hang up/);
      return true;
    });
    assert.match(logs[0], /request=network-request/);
    assert.match(logs[0], /ECONNRESET/);
    assert.match(logs[0], /socket hang up/);
  } finally { await f.close(); }
});
