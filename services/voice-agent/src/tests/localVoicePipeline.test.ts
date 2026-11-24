import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

/** The real voice server, local Whisper and orchestrator transports; no provider or microphone is used. */
test("local Whisper to orchestrator to on-device speech stays on loopback", { timeout: 10_000 }, async () => {
  const localAsr = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(localAsr, "listening");
  const asrAddress = localAsr.address();
  assert(asrAddress && typeof asrAddress !== "string");
  let audioFrames = 0;
  let finalizeCount = 0;
  localAsr.on("connection", (socket) => {
    socket.on("message", (data, binary) => {
      if (binary) audioFrames += 1;
      else if (JSON.parse(data.toString()).type === "finalize") {
        finalizeCount += 1;
        socket.send(JSON.stringify({ text: "Check local status", language: "en", is_final: true }));
      }
    });
  });

  const commands: Array<Record<string, any>> = [];
  let cancellations = 0;
  const orchestrator = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    if (request.url === "/api/cancel/request") {
      cancellations += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    commands.push(body);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      requestId: body.requestId,
      status: "success",
      spokenSummary: "Local status is ready.",
      verification: { verified: true, outcome: "succeeded", postconditions: ["Local status checked."] },
    }));
  });
  orchestrator.listen(0, "127.0.0.1");
  await once(orchestrator, "listening");
  const orchAddress = orchestrator.address();
  assert(orchAddress && typeof orchAddress !== "string");

  const values: Record<string, string> = {
    VANESSA_SKIP_DOTENV: "true", VOICE_STRICT_CONFIG: "true", VOICE_ASR_PROVIDER: "whisper",
    VOICE_TTS_PROVIDER: "browser", VOICE_WAKE_WORD_ENABLED: "false",
    VOICE_URL: `ws://127.0.0.1:${asrAddress.port}`, ORCHESTRATOR_URL: `http://127.0.0.1:${orchAddress.port}`,
    FISH_API_KEY: "sk-fish-local-fixture", FISH_TTS_VOICE_ID: "local-fixture",
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1") throw new Error("Unexpected non-loopback HTTP request in local voice test.");
    return originalFetch(input, init);
  }) as typeof fetch;

  let app: Awaited<ReturnType<typeof import("../server.js").createVoiceAgentServer>> | undefined;
  let client: WebSocket | undefined;
  const events: Array<Record<string, any>> = [];
  const waitFor = (predicate: (event: Record<string, any>) => boolean) => new Promise<Record<string, any>>((resolve, reject) => {
    const found = events.find(predicate);
    if (found) return resolve(found);
    const timeout = setTimeout(() => { client?.off("message", listener); reject(new Error("Timed out waiting for local voice event.")); }, 3000);
    const listener = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as Record<string, any>;
      if (!predicate(event)) return;
      clearTimeout(timeout);
      client?.off("message", listener);
      resolve(event);
    };
    client!.on("message", listener);
  });

  try {
    const { createVoiceAgentServer } = await import("../server.js");
    app = await createVoiceAgentServer();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: "vanessa://desktop" });
    client.on("message", (data) => events.push(JSON.parse(data.toString()) as Record<string, any>));
    const sessionReady = waitFor((event) => event.type === "session_ready");
    await once(client, "open");
    const ready = await sessionReady;
    assert.equal(ready.providers.tts.requested, "On-device speech");
    const asrConnected = once(localAsr, "connection");
    client.send(JSON.stringify({ type: "activate" }));
    await asrConnected;
    await waitFor((event) => event.type === "state_change" && event.state === "listening");
    client.send(Buffer.alloc(640), { binary: true });
    client.send(JSON.stringify({ type: "finalize" }));
    const spoken = await waitFor((event) => event.type === "tts_chunk" && event.isFinal === true);
    assert.equal(spoken.text, "Local status is ready.");
    assert.equal(spoken.fallbackSpeech, true);
    assert.equal(spoken.audioBase64, undefined);
    assert.equal(finalizeCount, 1);
    assert.equal(audioFrames, 1);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, "Check local status");
    assert.equal(commands[0].source, "voice");
    assert.equal(cancellations, 0);
    const closed = once(client, "close");
    client.close();
    await closed;
  } finally {
    if (client && client.readyState < WebSocket.CLOSING) client.terminate();
    if (app) await app.close();
    for (const socket of localAsr.clients) socket.terminate();
    await new Promise<void>((resolve) => localAsr.close(() => resolve()));
    orchestrator.closeAllConnections();
    await new Promise<void>((resolve) => (orchestrator as Server).close(() => resolve()));
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
