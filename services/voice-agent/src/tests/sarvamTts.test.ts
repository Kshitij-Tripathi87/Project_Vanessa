import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { UsageBudget } from "@vanessa/shared";
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
        socket.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
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
    assert.equal(messages[0].data.speech_sample_rate, 24000);
    assert.equal(messages[0].data.min_buffer_size, 20);
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

test("Sarvam TTS rejects incomplete streams and never emits a final chunk", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "flush") {
        socket.send(JSON.stringify({ type: "audio", data: { audio: Buffer.from("audio").toString("base64") } }));
        socket.close(1000, "incomplete");
      }
    });
  });
  const adapter = new SarvamTtsAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}`, timeoutMs: 2000 });
  const chunks: any[] = [];
  try {
    await assert.rejects(adapter.streamSpeech("hello", (chunk) => chunks.push(chunk)), /closed before completion/);
    assert.equal(chunks.some((chunk) => chunk.isFinal), false);
  } finally {
    adapter.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Sarvam TTS rejects empty or malformed audio instead of accepting it", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "flush") {
        socket.send(JSON.stringify({ type: "audio", data: { audio: "not-base64" } }));
      }
    });
  });
  const adapter = new SarvamTtsAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}`, timeoutMs: 2000 });
  try {
    await assert.rejects(adapter.streamSpeech("hello", () => {}), /malformed or empty audio/);
  } finally {
    adapter.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Sarvam TTS settles estimated potentially billable usage when cancelled after text is sent", { timeout: 5000 }, async () => {
  const previousRate = process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS;
  process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS = "10";
  const budget = new UsageBudget();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  let textSent!: () => void;
  const textSentPromise = new Promise<void>((resolve) => { textSent = resolve; });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "text") textSent();
    });
  });
  const adapter = new SarvamTtsAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}`, timeoutMs: 2000, budget });
  try {
    const pending = adapter.streamSpeech("hello", () => {});
    await textSentPromise;
    adapter.abort();
    await pending;
    const event = budget.snapshot().events.at(-1)!;
    assert.equal(event.status, "settled");
    assert.equal(event.actualCostInr, 0.05);
    assert.equal(event.metadata?.costBasis, "estimate");
    assert.equal(event.metadata?.providerUsageReported, false);
    assert.equal(event.metadata?.outcome, "cancelled");
    assert.equal(budget.snapshot().reservedInr, 0);
  } finally {
    adapter.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousRate === undefined) delete process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS;
    else process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS = previousRate;
  }
});

test("Sarvam TTS times out, closes the socket, and settles post-send usage", { timeout: 5000 }, async () => {
  const previousRate = process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS;
  process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS = "10";
  const budget = new UsageBudget();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.on("message", () => undefined);
  });
  const adapter = new SarvamTtsAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}`, timeoutMs: 1000, budget });
  try {
    await assert.rejects(adapter.streamSpeech("hello", () => {}), /timed out/);
    assert.equal(adapter.getProviderStatus().state, "error");
    const event = budget.snapshot().events.at(-1)!;
    assert.equal(event.status, "settled");
    assert.equal(event.metadata?.outcome, "failed");
    assert.equal(event.metadata?.potentiallyBillable, true);
    assert.equal(budget.snapshot().reservedInr, 0);
  } finally {
    adapter.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousRate === undefined) delete process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS;
    else process.env.SARVAM_TTS_INR_PER_1K_CHARACTERS = previousRate;
  }
});

test("Sarvam TTS ignores stale callbacks from a cancelled stream", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  let connectionCount = 0;
  let firstFlush!: () => void;
  const firstFlushPromise = new Promise<void>((resolve) => { firstFlush = resolve; });
  server.on("connection", (socket) => {
    const connection = ++connectionCount;
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type !== "flush") return;
      if (connection === 1) {
        firstFlush();
        setTimeout(() => {
          socket.send(JSON.stringify({ type: "audio", data: { audio: Buffer.from("stale").toString("base64") } }));
          socket.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
        }, 25);
      } else {
        socket.send(JSON.stringify({ type: "audio", data: { audio: Buffer.from("current").toString("base64") } }));
        socket.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
      }
    });
  });
  const adapter = new SarvamTtsAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${address.port}`, timeoutMs: 2000 });
  const chunks: any[] = [];
  try {
    const first = adapter.streamSpeech("first", (chunk) => chunks.push(chunk));
    await firstFlushPromise;
    adapter.abort();
    const second = adapter.streamSpeech("second", (chunk) => chunks.push(chunk));
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connectionCount, 2);
    assert.deepEqual(chunks.filter((chunk) => chunk.audioBase64).map((chunk) => Buffer.from(chunk.audioBase64, "base64").toString()), ["current"]);
    assert.equal(chunks.filter((chunk) => chunk.isFinal).length, 1);
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
