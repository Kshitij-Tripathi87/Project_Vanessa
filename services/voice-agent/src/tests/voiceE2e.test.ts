import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import type { ExecuteCommandResult } from "@vanessa/shared";
import type { AsrAdapter } from "../asr/types.js";
import { OrchestratorClient } from "../orchestratorClient.js";
import { VanessaVoiceSession, type SessionState } from "../session/voiceSession.js";

interface TestServer {
  server: Server;
  baseUrl: string;
  requests: Array<{ body: any; method?: string; path?: string }>;
}

async function readRequestBody(request: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (body.length > 64 * 1024) throw new Error("test request body too large");
  }
  return JSON.parse(body || "{}");
}

async function startOrchestratorStub(
  result: ExecuteCommandResult,
  statusCode = 200,
): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const body = await readRequestBody(request);
      if (request.url === "/api/cancel/request") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "cancelled" }));
        return;
      }
      requests.push({ body, method: request.method, path: request.url });
      response.writeHead(statusCode, { "Content-Type": "application/json" });
      response.end(JSON.stringify(statusCode >= 200 && statusCode < 300
        ? { ...result, requestId: body.requestId }
        : { error: "orchestrator temporarily unavailable" }));
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid test request" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { server, baseUrl: "http://127.0.0.1:" + address.port, requests };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createSession(baseUrl: string, options: {
  failTts?: boolean;
} = {}) {
  let asrHandlers!: Parameters<AsrAdapter["connect"]>[0];
  const states: SessionState[] = [];
  const hud: Array<{ state: SessionState; transcript: string; plan?: any }> = [];
  const finalTranscripts: Array<{ text: string; requestId: string }> = [];
  const spoken: string[] = [];
  const audioChunks: any[] = [];
  const ttsUnavailable: string[] = [];
  let abortCalls = 0;

  const asr: AsrAdapter = {
    connect(handlers) { asrHandlers = handlers; },
    activateStream() {},
    sendAudioChunk() {},
    deactivateStream() {},
    close() {},
  };
  const session = new VanessaVoiceSession({
    asr,
    tts: {
      async streamSpeech(text, callback) {
        spoken.push(text);
        if (options.failTts) throw new Error("simulated TTS transport failure");
        callback({
          text,
          audioBase64: "AQID",
          format: "mp3",
          isFinal: true,
          chunkIndex: 0,
        });
      },
      abort() { abortCalls++; },
    },
    client: new OrchestratorClient(baseUrl),
    handlers: {
      onStateChange: (state) => states.push(state),
      onHudUpdate: (update) => hud.push(update),
      onFinalTranscript: (text, requestId) => finalTranscripts.push({ text, requestId }),
      onAudioChunkOut: (chunk) => audioChunks.push(chunk),
      onTtsUnavailable: (detail) => ttsUnavailable.push(detail),
    },
  });

  return {
    session,
    states,
    hud,
    finalTranscripts,
    spoken,
    audioChunks,
    ttsUnavailable,
    asrHandlers: () => asrHandlers,
    abortCalls: () => abortCalls,
  };
}

function successResult(command: string): ExecuteCommandResult {
  return {
    status: "success",
    spokenSummary: "Bluetooth is off and brightness is set to 70 percent.",
    planId: "plan-voice-e2e",
    plan: {
      id: "plan-voice-e2e",
      command,
      risk: "medium",
      tasks: [],
    },
    pendingTasks: [],
    sentiment: null,
    verification: {
      verified: true,
      postconditions: ["Bluetooth state was read back as off.", "Display brightness was read back as 70 percent."],
      outcome: "succeeded",
    },
  };
}

test("voice final transcript reaches the orchestrator HTTP contract and returns spoken verified output", async () => {
  const command = "Turn off Bluetooth and set brightness to 70 percent.";
  const turnId = "voice-e2e-turn-42";
  const server = await startOrchestratorStub(successResult(command));
  const fixture = createSession(server.baseUrl);

  try {
    await fixture.session.activateSession(5000);
    await fixture.asrHandlers().onFinal({
      text: command,
      language: "en",
      isFinal: true,
      turnId,
    });

    // A duplicated final message for the same provider turn must not dispatch again.
    await fixture.session.handleFinalUtterance(command, "en", turnId, true);

    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/execute");
    assert.equal(request.body.source, "voice");
    assert.equal(request.body.command, command);
    assert.equal(request.body.language, "en");
    assert.equal(request.body.envelope.originDeviceId, "desktop-local");
    assert.equal(request.body.requestId, "voice-" + createHash("sha256").update(turnId).digest("hex").slice(0, 32));
    assert.equal(request.body.idempotencyKey, "voice:" + request.body.requestId);
    assert.equal(request.body.envelope.requestId, request.body.requestId);
    assert.equal(request.body.envelope.idempotencyKey, request.body.idempotencyKey);
    assert.equal(request.body.envelope.source, "voice");
    assert.equal(request.body.envelope.schemaVersion, "1.0");
    assert(request.body.envelope.expiresAt > request.body.envelope.createdAt);

    assert.deepEqual(fixture.finalTranscripts, [{ text: command, requestId: request.body.requestId }]);
    assert.equal(fixture.session.getState(), "idle");
    assert(fixture.states.includes("thinking"));
    assert(fixture.states.includes("executing"));
    assert(fixture.states.includes("responding"));
    assert(fixture.hud.some((update) => update.transcript === command));
    assert(fixture.hud.some((update) => update.transcript === "Bluetooth is off and brightness is set to 70 percent."));
    assert.deepEqual(fixture.spoken, ["Bluetooth is off and brightness is set to 70 percent."]);
    assert.equal(fixture.audioChunks.length, 1);
    assert.equal(fixture.audioChunks[0].audioBase64, "AQID");
    assert.equal(fixture.audioChunks[0].isFinal, true);
    assert.equal(fixture.ttsUnavailable.length, 0);
  } finally {
    fixture.session.stop();
    await closeServer(server.server);
  }
});

test("orchestrator HTTP failure is reported as unconfirmed instead of speaking a false success", async () => {
  const command = "Open YouTube and search for a coding playlist.";
  const server = await startOrchestratorStub(successResult(command), 503);
  const fixture = createSession(server.baseUrl);

  try {
    await fixture.session.activateSession(5000);
    await fixture.asrHandlers().onFinal({
      text: command,
      language: "en",
      isFinal: true,
      turnId: "voice-e2e-failure",
    });

    assert.equal(server.requests.length, 1);
    assert.equal(fixture.session.getState(), "idle");
    assert(fixture.hud.some((update) => /couldn't confirm the task result/i.test(update.transcript)));
    assert.deepEqual(fixture.spoken, [
      "I couldn't confirm the task result. Check the task timeline before retrying; the request may already be running.",
    ]);
    assert.equal(fixture.audioChunks.length, 1);
  } finally {
    fixture.session.stop();
    await closeServer(server.server);
  }
});

test("TTS transport failure preserves the text result and reports unavailable speech", async () => {
  const command = "Check the current task status.";
  const server = await startOrchestratorStub(successResult(command));
  const fixture = createSession(server.baseUrl, { failTts: true });

  try {
    await fixture.session.activateSession(5000);
    await fixture.asrHandlers().onFinal({
      text: command,
      language: "en",
      isFinal: true,
      turnId: "voice-e2e-tts-failure",
    });

    assert.equal(server.requests.length, 1);
    assert.equal(fixture.session.getState(), "idle");
    assert(fixture.hud.some((update) => update.transcript === "Bluetooth is off and brightness is set to 70 percent."));
    assert.equal(fixture.spoken.length, 1);
    assert.match(fixture.ttsUnavailable[0] || "", /simulated TTS transport failure/);
    assert.equal(fixture.audioChunks.length, 0);
  } finally {
    fixture.session.stop();
    await closeServer(server.server);
  }
});
