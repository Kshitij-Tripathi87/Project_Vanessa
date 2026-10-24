import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SarvamAsrAdapter } from "../asr/sarvamAdapter.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";

test("Sarvam audio, partials and final transcript reach POST /api/execute once per activation", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const events: string[] = [];
  const pcm = new Int16Array([100, -100, 0, 42]);
  server.on("connection", (ws, req) => {
    assert.equal(req.headers["api-subscription-key"], "test-key");
    const url = new URL(req.url!, "http://localhost");
    assert.equal(url.searchParams.get("model"), "saaras:v3-realtime");
    assert.equal(url.searchParams.get("endpointing"), "manual");
    assert.equal(url.searchParams.get("sample_rate"), "16000");
    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString()); events.push(msg.event);
      if (msg.event === "audio_input") {
        assert.deepEqual(Buffer.from(msg.audio, "base64"), Buffer.from(pcm.buffer));
        ws.send(JSON.stringify({ event: "transcript.partial", text: "Open", language: "en-IN" }));
      }
      if (msg.event === "speech_end") {
        const final = JSON.stringify({ event: "transcript.final", text: "Open my Python project", language: "en-IN" });
        ws.send(final); ws.send(final);
      }
    });
    ws.send(JSON.stringify({ event: "session.begin", request_id: "test-session" }));
  });
  const adapter = new SarvamAsrAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}` });
  let partials = 0;
  const session = new VanessaVoiceSession({ asrProvider: "sarvam", handlers: { onPartialTranscript: () => partials++ } });
  (session as any).asr = adapter;
  (session as any).tts = { streamSpeech: async () => {}, abort: () => {} };
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    assert(new URL(url).pathname === "/api/execute");
    assert.equal(init.method, "POST");
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: "success", spokenSummary: "Done" }), { status: 200 });
  }) as typeof fetch;
  try {
    for (let i = 1; i <= 2; i++) {
      await session.activateSession();
      adapter.sendAudioChunk(pcm);
      session.finalizeTurn(); session.finalizeTurn();
      const deadline = Date.now() + 1000;
      while ((requests.length < i || session.getState() !== "idle") && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
      assert.equal(requests.length, i);
    }
    assert.equal(partials, 2);
    assert.equal(events.filter(event => event === "speech_end").length, 2);
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    for (const body of requests) {
      assert.equal(body.command, "Open my Python project");
      assert.equal(body.source, "voice");
      assert.equal(body.language, "en-IN");
      assert.equal(body.envelope.command, body.command);
      assert.equal(body.envelope.requestId, body.requestId);
      assert.equal(body.idempotencyKey, `voice:${body.requestId}`);
    }
  } finally {
    session.stop(); globalThis.fetch = originalFetch;
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Sarvam reports missing keys and HTTP rejection without exposing the key", { timeout: 5000 }, async () => {
  const handlers = { onPartial: () => {}, onFinal: () => assert.fail("No transcript on rejection") };
  const missing = new SarvamAsrAdapter({ apiKey: "" });
  assert.throws(() => missing.connect(handlers), /SARVAM_API_KEY/);
  const http = createServer();
  http.on("upgrade", (_req, socket) => {
    const body = JSON.stringify({ message: "Invalid test-secret-key" });
    socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert(address && typeof address !== "string");
  const adapter = new SarvamAsrAdapter({ apiKey: "test-secret-key", url: `ws://127.0.0.1:${address.port}` });
  try {
    adapter.connect(handlers);
    await assert.rejects(adapter.activateStream(), /Sarvam ASR HTTP 401/);
    assert.equal(adapter.getProviderStatus().state, "error");
    assert(!adapter.getProviderStatus().detail!.includes("test-secret-key"));
    assert(adapter.getProviderStatus().detail!.includes("SARVAM_API_KEY"));
  } finally { adapter.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

test("Sarvam activation can be cancelled while connecting", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const adapter = new SarvamAsrAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}` });
  adapter.connect({ onPartial: () => {}, onFinal: () => assert.fail() });
  const activation = adapter.activateStream();
  const rejected = assert.rejects(activation, /cancelled/);
  adapter.close();
  await rejected;
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(adapter.getProviderStatus().state, "idle");
});

test("Sarvam retries transient connection loss with bounded backoff", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    if (connections === 1) {
      socket.close();
      return;
    }
    socket.send(JSON.stringify({ event: "session.begin" }));
  });
  const adapter = new SarvamAsrAdapter({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${address.port}`,
    maxReconnectAttempts: 1,
    reconnectBaseDelayMs: 50,
  });
  adapter.connect({ onPartial: () => {}, onFinal: () => {} });
  try {
    await adapter.activateStream(1000);
    assert.equal(connections, 2);
  } finally {
    adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
