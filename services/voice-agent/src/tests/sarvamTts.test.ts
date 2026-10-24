import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { SarvamTtsAdapter } from "../tts/sarvamTts.js";

test("Sarvam TTS streams audio chunks and preserves configured format", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const messages: any[] = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers["api-subscription-key"], "test-key");
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "flush") {
        socket.send(JSON.stringify({ type: "audio", data: { audio: Buffer.from("audio").toString("base64") } }));
        socket.send(JSON.stringify({ type: "event", data: { event_type: "flush_done" } }));
      }
    });
  });

  const adapter = new SarvamTtsAdapter({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${address.port}`,
    model: "bulbul:v4-flash",
    speaker: "test-speaker",
    language: "en-IN",
    codec: "wav",
    sampleRate: 24000,
    timeoutMs: 2000,
  });
  const chunks: any[] = [];
  try {
    await adapter.streamSpeech("Hello Vanessa", (chunk) => chunks.push(chunk));
    assert.equal(messages[0].type, "config");
    assert.equal(messages[0].data.speaker, "test-speaker");
    assert.equal(messages[1].type, "text");
    assert.equal(messages[2].type, "flush");
    assert.equal(chunks[0].audioBase64, Buffer.from("audio").toString("base64"));
    assert.equal(chunks[0].format, "wav");
    assert.equal(chunks[0].sampleRate, 24000);
    assert.equal(chunks.at(-1).isFinal, true);
    assert.equal(chunks.at(-1).format, "wav");
  } finally {
    adapter.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Sarvam TTS rejects placeholder credentials before opening a socket", async () => {
  const adapter = new SarvamTtsAdapter({ apiKey: "sarvam-placeholder-key" });
  await assert.rejects(adapter.streamSpeech("hello", () => {}), /SARVAM_API_KEY/);
  assert.equal(adapter.getProviderStatus().state, "error");
});
