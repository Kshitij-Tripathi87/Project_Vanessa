import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SarvamAsrAdapter } from "../asr/sarvamAdapter.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import { SpeechAudioGate } from "../audio/speechGate.js";

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

test("Sarvam ignores malformed audio/events and duplicate finals after deactivation", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  let partials = 0;
  let finals = 0;
  server.on("connection", (ws) => {
    ws.send(JSON.stringify({ event: "session.begin" }));
    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "audio_input") {
        ws.send("not-json");
        ws.send(JSON.stringify(null));
        ws.send(JSON.stringify({ event: "transcript.partial", text: 42 }));
        ws.send(JSON.stringify({ event: "transcript.partial", text: "He", language: { value: "en-IN" } }));
        ws.send(JSON.stringify({ event: "transcript.partial", text: "Hello", language: "en-IN" }));
      }
      if (msg.event === "speech_end") {
        const final = JSON.stringify({ event: "transcript.final", text: "Hello", language: "en-IN" });
        ws.send(final);
        setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(final); }, 10);
      }
    });
  });
  const adapter = new SarvamAsrAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}` });
  adapter.connect({
    onPartial: result => { partials++; assert.equal(result.language, "en-IN"); },
    onFinal: result => { finals++; assert.equal(result.text, "Hello"); },
  });
  try {
    await adapter.activateStream(1000);
    assert.doesNotThrow(() => {
      adapter.sendAudioChunk(null as unknown as Int16Array);
      adapter.sendAudioChunk(new Int8Array([1, 2]) as unknown as Int16Array);
      adapter.sendAudioChunk(new Int16Array());
    });
    adapter.sendAudioChunk(new Int16Array([1, -1]));
    adapter.finalizeTurn();
    const deadline = Date.now() + 1000;
    while (finals < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(partials, 1);
    assert.equal(finals, 1);
    assert.equal(adapter.getProviderStatus().state, "idle");
  } finally {
    adapter.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Sarvam readiness and finalization timeouts are bounded and cancellable", { timeout: 5000 }, async () => {
  const readinessServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(readinessServer, "listening");
  const readinessAddress = readinessServer.address(); assert(readinessAddress && typeof readinessAddress !== "string");
  const readinessAdapter = new SarvamAsrAdapter({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${readinessAddress.port}`,
    maxReconnectAttempts: 0,
    connectionTimeoutMs: 25,
  });
  readinessAdapter.connect({ onPartial: () => {}, onFinal: () => assert.fail("No transcript on timeout") });
  try {
    await assert.rejects(readinessAdapter.activateStream(), /session readiness timed out/);
    assert.equal(readinessAdapter.getProviderStatus().state, "error");
  } finally {
    readinessAdapter.close();
    for (const ws of readinessServer.clients) ws.terminate();
    await new Promise<void>(resolve => readinessServer.close(() => resolve()));
  }

  const finalizationServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(finalizationServer, "listening");
  const finalizationAddress = finalizationServer.address(); assert(finalizationAddress && typeof finalizationAddress !== "string");
  finalizationServer.on("connection", ws => ws.send(JSON.stringify({ event: "session.begin" })));
  const finalizationAdapter = new SarvamAsrAdapter({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${finalizationAddress.port}`,
    finalizationTimeoutMs: 25,
  });
  finalizationAdapter.connect({ onPartial: () => {}, onFinal: () => assert.fail("No transcript on timeout") });
  try {
    await finalizationAdapter.activateStream(1000);
    finalizationAdapter.finalizeTurn();
    const deadline = Date.now() + 1000;
    while (finalizationAdapter.getProviderStatus().state !== "error" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(finalizationAdapter.getProviderStatus().state, "error");
    assert.match(finalizationAdapter.getProviderStatus().detail ?? "", /within 1 seconds/);
  } finally {
    finalizationAdapter.close();
    for (const ws of finalizationServer.clients) ws.terminate();
    await new Promise<void>(resolve => finalizationServer.close(() => resolve()));
  }
});

test("Sarvam cancellation prevents a queued reconnect from reopening the session", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  let connections = 0;
  server.on("connection", ws => {
    connections++;
    ws.close();
  });
  const adapter = new SarvamAsrAdapter({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${address.port}`,
    maxReconnectAttempts: 1,
    reconnectBaseDelayMs: 50,
  });
  adapter.connect({ onPartial: () => {}, onFinal: () => {} });
  const activation = adapter.activateStream();
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    adapter.close();
    await assert.rejects(activation, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(connections, 1);
    assert.equal(adapter.getProviderStatus().state, "idle");
  } finally {
    adapter.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Sarvam speech gate forwards pre-roll and speech, not idle silence", () => {
  const gate = new SpeechAudioGate({ preRollFrames: 2, trailingSilenceFrames: 2 });
  const quiet = (v: number) => new Int16Array([v, v]);
  const speech = (v: number) => new Int16Array([v + 1000, v + 1000]);

  assert.deepEqual(gate.push(quiet(1), false), []);
  assert.deepEqual(gate.push(quiet(2), false), []);
  const onset = gate.push(speech(3), true);
  assert.deepEqual(onset.map(frame => frame[0]), [2, 1003]);

  assert.deepEqual(gate.push(speech(4), true).map(frame => frame[0]), [1004]);
  assert.deepEqual(gate.push(quiet(5), false).map(frame => frame[0]), [5]);
  assert.deepEqual(gate.push(quiet(6), false).map(frame => frame[0]), [6]);
  assert.deepEqual(gate.push(quiet(7), false), []);

  // After a long pause, only the latest pre-roll and new speech are forwarded.
  assert.deepEqual(gate.push(quiet(8), false), []);
  const nextOnset = gate.push(speech(9), true);
  assert.deepEqual(nextOnset.map(frame => frame[0]), [8, 1009]);
});

test("Sarvam speech gate reset prevents audio leaking across turns", () => {
  const gate = new SpeechAudioGate({ preRollFrames: 3, trailingSilenceFrames: 1 });
  gate.push(new Int16Array([11]), false);
  gate.reset();
  const output = gate.push(new Int16Array([22]), true);
  assert.deepEqual(output.map(frame => frame[0]), [22]);
});
