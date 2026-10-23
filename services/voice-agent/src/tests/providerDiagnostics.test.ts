import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { FishAsrAdapter } from "../asr/fishAdapter.js";
import { safeProviderDetail, providerTransportError } from "../diagnostics/providerDiagnostics.js";
import { FishTtsAdapter } from "../tts/fishTts.js";

test("provider diagnostics redact credentials and control characters", () => {
  const key = "sk-fish-private-test";
  const detail = safeProviderDetail(`Denied ${key}\nBearer other-token`, [key]);
  assert(!detail.includes(key));
  assert(!detail.includes("other-token"));
  assert(!detail.includes("\n"));
  assert.equal(safeProviderDetail("x".repeat(5000)).length, 600);
  const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  assert.match(providerTransportError(new AggregateError([cause], "")), /ECONNREFUSED/);
});

test("TTS upgrade rejection preserves the provider reason instead of a generic HTTP error", async () => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    const body = JSON.stringify({ error: { message: "API account access denied" } });
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const adapter = new FishTtsAdapter({ apiKey: "sk-fish-test", voiceId: "test-voice", url: `ws://127.0.0.1:${address.port}`, fallback: "none" });
  try {
    await assert.rejects(adapter.streamSpeech("hello", () => {}), /HTTP 403: API account access denied/);
  } finally {
    adapter.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP upgrade rejection exposes billing reason promptly, redacts the key, and does not reconnect", async () => {
  const key = "sk-fish-test-diagnostics";
  let upgrades = 0;
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    upgrades++;
    const body = JSON.stringify({ message: `Insufficient API balance for ${key}` });
    socket.end(`HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const adapter = new FishAsrAdapter({ apiKey: key, url: `ws://127.0.0.1:${address.port}`, allowFallback: false });
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  try {
    await adapter.connect({ onPartial: () => {}, onFinal: () => {} });
    await assert.rejects(adapter.activateStream(5000), (error: Error) => {
      assert.match(error.message, /HTTP 402/);
      assert.match(error.message, /Insufficient API balance/);
      assert(!error.message.includes(key));
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(upgrades, 1);
    assert.match(lines.join("\n"), /status=402/);
    assert(!lines.join("\n").includes(key));
    assert.match(adapter.getProviderStatus().detail || "", /HTTP 402/);
  } finally {
    console.error = originalError;
    adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
