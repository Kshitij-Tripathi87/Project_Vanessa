import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { decode, encode } from "@msgpack/msgpack";

// This test starts the actual Fastify voice-agent service, but all provider
// transports and the orchestrator are loopback fixtures. It uses no API keys,
// microphone, internet provider, or user data.
process.env.VANESSA_SKIP_DOTENV = "true";
process.env.VOICE_STRICT_CONFIG = "true";
process.env.VOICE_ASR_PROVIDER = "fish";
process.env.VOICE_TTS_PROVIDER = "fish";
process.env.FISH_API_KEY = "sk-fish-sandbox-only";
process.env.FISH_TTS_VOICE_ID = "vanessa-sandbox-voice";
process.env.FISH_ASR_MODEL = "transcribe-stream-1";
process.env.FISH_TTS_MODEL = "s2.1-pro-free";
process.env.VOICE_ALLOW_FALLBACK = "false";
process.env.VOICE_TTS_FALLBACK_PROVIDER = "none";
process.env.VOICE_WAKE_WORD_ENABLED = "false";
process.env.VOICE_BUDGET_CAP_INR = "0";
process.env.VOICE_BUDGET_PER_USER_CAP_INR = "0";
process.env.VOICE_AGENT_PORT = "0";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + label);
    await delay(10);
  }
}

function listen(server: Server): Promise<AddressInfo> {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address() as AddressInfo);
}

async function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function closeWs(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    if (client.readyState < WebSocket.CLOSING) client.close();
  }
  if (!server.address()) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("sandbox starts the real voice-agent server and completes ASR -> orchestrator -> TTS", async () => {
  const asrServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(asrServer, "listening");
  const asrAddress = asrServer.address();
  assert(asrAddress && typeof asrAddress !== "string");

  const ttsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(ttsServer, "listening");
  const ttsAddress = ttsServer.address();
  assert(ttsAddress && typeof ttsAddress !== "string");

  const asrMessages: Array<Record<string, any>> = [];
  const ttsMessages: Array<Record<string, any>> = [];
  let orchestratorBody: Record<string, any> | undefined;

  asrServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = decode(Buffer.from(raw as Buffer)) as Record<string, any>;
      asrMessages.push(message);
      if (message.type === "config") {
        socket.send(encode({ type: "session_started", session_id: "sandbox-asr-session" }));
      } else if (message.type === "audio_done") {
        socket.send(encode({
          type: "committed",
          text: "report the sandbox voice service status",
          user_turn: true,
          language_code: "en",
          turn_index: 1,
        }));
      }
    });
  });

  ttsServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = decode(Buffer.from(raw as Buffer)) as Record<string, any>;
      ttsMessages.push(message);
      if (message.event === "stop") {
        socket.send(Buffer.from(encode({ event: "audio", audio: new Uint8Array([1, 2, 3, 4]) })));
        socket.send(Buffer.from(encode({ event: "audio", audio: new Uint8Array([5, 6, 7, 8]) })));
        socket.send(Buffer.from(encode({ event: "finish", reason: "stop" })));
      }
    });
  });

  const orchestrator = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    orchestratorBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "success",
      spokenSummary: "The sandbox voice service completed its test command.",
      planId: "sandbox-voice-plan",
      plan: { id: "sandbox-voice-plan", command: orchestratorBody.command, risk: "low", tasks: [] },
      pendingTasks: [],
      sentiment: null,
      verification: {
        verified: true,
        postconditions: ["The sandbox orchestrator returned a verified result."],
        outcome: "succeeded",
      },
    }));
  });
  const orchestratorAddress = await listen(orchestrator);

  process.env.FISH_ASR_URL = "ws://127.0.0.1:" + asrAddress.port;
  process.env.FISH_TTS_URL = "ws://127.0.0.1:" + ttsAddress.port;
  process.env.ORCHESTRATOR_URL = "http://127.0.0.1:" + orchestratorAddress.port;

  let app: any;
  let client: WebSocket | undefined;
  try {
    // Import after test-only environment is installed: the service constructs
    // its orchestrator client and provider adapters from these values.
    const { createVoiceAgentServer } = await import("../server.js");
    app = await createVoiceAgentServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appAddress = app.server.address() as AddressInfo;
    const baseUrl = "http://127.0.0.1:" + appAddress.port;

    const healthResponse = await fetch(baseUrl + "/health");
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as Record<string, any>;
    assert.equal(health.status, "online");
    assert.equal(health.service, "vanessa-voice-agent");
    assert.equal(health.readiness, "ready");
    assert.equal(health.providers.asr.configured, true);
    assert.equal(health.providers.tts.configured, true);

    const readyResponse = await fetch(baseUrl + "/ready");
    assert.equal(readyResponse.status, 200);
    assert.equal((await readyResponse.json() as Record<string, any>).status, "ready");

    const events: Array<Record<string, any>> = [];
    client = new WebSocket(baseUrl.replace("http", "ws") + "/ws", {
      origin: "http://127.0.0.1:5173",
    });
    client.on("message", (raw) => {
      try { events.push(JSON.parse(raw.toString()) as Record<string, any>); }
      catch { /* malformed service output is caught by the assertions below */ }
    });
    await once(client, "open");
    await waitUntil(() => events.some((event) => event.type === "session_ready"), "WebSocket session_ready");

    const ready = events.find((event) => event.type === "session_ready")!;
    assert.equal(ready.sampleRate, 16000);
    assert.equal(ready.chunkDurationMs, 20);
    assert.equal(ready.chunkBytes, 640);
    assert.equal(ready.activationMode, "push_to_talk");

    client.send(JSON.stringify({ type: "activate" }));
    await waitUntil(
      () => events.some((event) => event.type === "state_change" && event.state === "listening"),
      "ASR activation",
    );
    await waitUntil(() => asrMessages.some((message) => message.type === "config"), "Fish ASR config handshake");

    // Ten 20ms mono PCM frames exercise the real PCM accumulator and provider adapter.
    for (let frame = 0; frame < 10; frame++) {
      client.send(Buffer.alloc(640, frame), { binary: true });
    }
    await waitUntil(() => asrMessages.some((message) => message.type === "audio"), "ASR audio frame");
    client.send(JSON.stringify({ type: "finalize" }));

    await waitUntil(() => Boolean(orchestratorBody), "orchestrator task submission");
    await waitUntil(() => ttsMessages.some((message) => message.event === "stop"), "TTS completion");
    await waitUntil(
      () => events.filter((event) => event.type === "tts_chunk").length >= 2,
      "TTS audio chunks",
    );

    assert.equal(orchestratorBody?.source, "voice");
    assert.equal(orchestratorBody?.command, "report the sandbox voice service status");
    assert.match(String(orchestratorBody?.requestId), /^voice-[a-f0-9]{32}$/);
    assert.equal(orchestratorBody?.idempotencyKey, "voice:" + orchestratorBody?.requestId);
    assert.deepEqual(
      ttsMessages.map((message) => message.event),
      ["start", "text", "flush", "stop"],
    );
    assert.equal(ttsMessages[0].request.reference_id, "vanessa-sandbox-voice");
    assert.equal(
      ttsMessages.find((message) => message.event === "text")?.text,
      "The sandbox voice service completed its test command.",
    );

    const audioEvents = events.filter((event) => event.type === "tts_chunk");
    assert.equal(audioEvents[0].audioBase64, Buffer.from([1, 2, 3, 4]).toString("base64"));
    assert.equal(audioEvents[0].format, "pcm_s16le");
    assert.equal(audioEvents[0].sampleRate, 24000);
    assert.equal(audioEvents[0].isFinal, false);
    assert.equal(audioEvents[1].audioBase64, Buffer.from([5, 6, 7, 8]).toString("base64"));
    assert.equal(audioEvents[1].isFinal, true);
    assert.ok(events.some((event) =>
      event.type === "hud_update" &&
      event.transcript === "The sandbox voice service completed its test command."
    ));
  } finally {
    client?.close();
    await app?.close();
    await closeHttp(orchestrator);
    await closeWs(asrServer);
    await closeWs(ttsServer);
  }
});
