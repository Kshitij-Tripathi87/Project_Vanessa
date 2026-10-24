import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { SarvamChatClient } from "../core/sarvamChat.js";

test("Sarvam chat client collects streaming SSE content and sends provider configuration", { timeout: 5000 }, async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers["api-subscription-key"], "test-key");
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, "sarvam-test-model");
      assert.equal(parsed.stream, true);
      assert.equal(parsed.reasoning_effort, null);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "from Sarvam." } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new SarvamChatClient({
    apiKey: "test-key",
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    model: "sarvam-test-model",
  });
  try {
    const result = await client.complete({
      requestId: "test-request",
      messages: [{ role: "user", content: "Say hello." }],
    });
    assert.equal(result.text, "Hello from Sarvam.");
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Sarvam chat client does not accept placeholder credentials", async () => {
  const client = new SarvamChatClient({ apiKey: "replace-with-your-sarvam-key" });
  await assert.rejects(client.complete({ messages: [{ role: "user", content: "hello" }] }), /SARVAM_API_KEY/);
});
