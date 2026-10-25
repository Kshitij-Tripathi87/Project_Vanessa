import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { VanessaVoiceSession } from "../services/voice-agent/src/session/voiceSession.js";
import { SarvamAsrAdapter } from "../services/voice-agent/src/asr/sarvamAdapter.js";
import { SarvamTtsAdapter } from "../services/voice-agent/src/tts/sarvamTts.js";
import { OrchestratorClient } from "../services/voice-agent/src/orchestratorClient.js";
import { SarvamChatClient } from "../services/orchestrator/src/core/sarvamChat.js";
import { modelRouter } from "../services/orchestrator/src/core/router.js";
import { orchestrator } from "../services/orchestrator/src/core/orchestrator.js";
import { agentRegistry } from "../services/orchestrator/src/agents/registry.js";
import { UsageBudget } from "../packages/shared/dist/usageMeter.js";

test("cancel before submit or during planning never dispatches a late plan", async () => {
  const original = modelRouter.callLLM;
  let resolve!: (text: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(yes => entered = yes);
  modelRouter.callLLM = async () => { entered(); return new Promise<string>(yes => resolve = yes); };
  try {
    const pending = orchestrator.executeCommand({ command: "Check system status", requestId: "cancel-during-planning" });
    await started;
    orchestrator.cancelRequest("cancel-during-planning");
    resolve(JSON.stringify({ tasks: [{ id: "t1", agent: "it_ops", action: "it_ops.system_status", params: {}, dependsOn: [] }] }));
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.spokenSummary, /cancelled before execution/);
    assert.equal(result.plan, undefined);
    orchestrator.cancelRequest("cancel-before-submit");
    const early = await orchestrator.executeCommand({ command: "Check system status", requestId: "cancel-before-submit" });
    assert.equal(early.plan, undefined);
    assert.match(early.spokenSummary, /cancelled before execution/);
  } finally { modelRouter.callLLM = original; }
});

test("cancelling an executing request blocks its dependent tasks", async () => {
  const originalLLM = modelRouter.callLLM;
  const originalExecute = agentRegistry.it_ops.execute;
  let finish!: (result: any) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => started = resolve);
  let calls = 0;
  modelRouter.callLLM = async () => JSON.stringify({ tasks: [
    { id: "a", agent: "it_ops", action: "it_ops.system_status", params: {}, dependsOn: [] },
    { id: "b", agent: "it_ops", action: "it_ops.system_status", params: {}, dependsOn: ["a"] },
  ] });
  agentRegistry.it_ops.execute = async () => { calls++; started(); return new Promise<any>(resolve => finish = resolve); };
  try {
    const result = orchestrator.executeCommand({ command: "Check status twice", requestId: "cancel-running-plan" });
    await entered;
    orchestrator.cancelRequest("cancel-running-plan");
    finish({ success: true, verification: { passed: true, details: "mock operation returned" } });
    const cancelled = await result;
    assert.equal(calls, 1);
    assert.equal(cancelled.status, "partial");
    assert(cancelled.plan?.tasks.every(task => task.status === "cancelled"));
  } finally { modelRouter.callLLM = originalLLM; agentRegistry.it_ops.execute = originalExecute; }
});

test("mock Sarvam STT -> real planner/policy/runner -> Sarvam TTS, including pending approval cancellation", { timeout: 15000 }, async () => {
  const budget = new UsageBudget();
  let sensitive = false;
  let executions = 0;
  const plans: any[] = [];
  const prompts: string[] = [];
  const syntheses: string[] = [];
  const chat = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const data = JSON.parse(body);
      prompts.push(data.messages[1].content);
      const plan = { tasks: [{ id: "t1", agent: sensitive ? "windows" : "it_ops", action: sensitive ? "wifi.restart_adapter" : "it_ops.system_status", params: {}, dependsOn: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  chat.listen(0, "127.0.0.1"); await once(chat, "listening");
  const chatAddress = chat.address(); assert(chatAddress && typeof chatAddress !== "string");
  const client = new SarvamChatClient({ apiKey: "test-key", url: `http://127.0.0.1:${chatAddress.port}`, model: "test", budget });
  const originalLLM = modelRouter.callLLM;
  // callLLM signature: (prompt, systemPrompt, requestIdOrSignal?, signal?) - pass signal through correctly
  modelRouter.callLLM = async (prompt, system, requestIdOrSignal, signal) => (await client.complete({
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    signal: signal ?? (requestIdOrSignal instanceof AbortSignal ? requestIdOrSignal : undefined)
  })).text;
  const originalExecute = agentRegistry.windows.execute;
  agentRegistry.windows.execute = async () => { executions++; throw new Error("Approval boundary bypassed"); };

  const http = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (req.url === "/api/cancel/request") {
          orchestrator.cancelRequest(data.requestId);
          res.end(JSON.stringify({ success: true }));
        } else {
          const result = await orchestrator.executeCommand(data);
          plans.push(result);
          res.end(JSON.stringify(result));
        }
      } catch { res.writeHead(500); res.end("{}"); }
    });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert(address && typeof address !== "string");
  const asrServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const ttsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await Promise.all([once(asrServer, "listening"), once(ttsServer, "listening")]);
  const asrAddress = asrServer.address();
  const ttsAddress = ttsServer.address();
  if (!asrAddress || typeof asrAddress === "string" || !ttsAddress || typeof ttsAddress === "string") {
    throw new Error("Mock Sarvam WebSocket servers did not expose listening addresses.");
  }
  const asrPort = asrAddress.port;
  const ttsPort = ttsAddress.port;
  asrServer.on("connection", ws => {
    ws.send(JSON.stringify({ event: "session.begin" }));
    ws.on("message", raw => {
      const event = JSON.parse(raw.toString()).event;
      if (event === "speech_end") ws.send(JSON.stringify({ event: "transcript.final", text: sensitive ? "Restart Wi-Fi" : "Check system status", language: "en-IN" }));
      if (event === "end") ws.send(JSON.stringify({ event: "session.end", audio_duration_s: 0.02 }));
    });
  });
  // Complete WAV fixture; not a claim of real speech or audible acceptance.
  const wav = Buffer.alloc(684);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(640, 40);
  ttsServer.on("connection", ws => ws.on("message", raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "text") syntheses.push(msg.data.text);
    if (msg.type === "flush") {
      for (const chunk of [wav.subarray(0, 100), wav.subarray(100)]) ws.send(JSON.stringify({ type: "audio", data: { audio: chunk.toString("base64") } }));
      ws.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
    }
  }));
  const audio: Buffer[] = [];
  const session = new VanessaVoiceSession({
    asr: new SarvamAsrAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${asrPort}`, budget }),
    tts: new SarvamTtsAdapter({ apiKey: "test-key", url: `ws://127.0.0.1:${ttsPort}`, codec: "wav", budget }),
    client: new OrchestratorClient(`http://127.0.0.1:${address.port}`),
    handlers: { onAudioChunkOut: chunk => { if (chunk.audioBase64) audio.push(Buffer.from(chunk.audioBase64, "base64")); } },
  });
  try {
    for (let turn = 0; turn < 2; turn++) {
      sensitive = turn === 1;
      await session.activateSession();
      await session.processAudioChunk({ pcm: new Int16Array(320).fill(1000), sampleRate: 16000, durationMs: 20 });
      session.finalizeTurn();
      const deadline = Date.now() + 5000;
      while (audio.length < turn + 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.equal(audio.length, turn + 1);
      assert.deepEqual(audio[turn], wav);
    }
    assert.equal(plans[0].status, "success");
    assert.equal(plans[1].status, "awaiting_approval");
    assert.equal(executions, 0);
    assert.match(prompts[0], /Check system status/);
    assert.match(prompts[1], /Recent conversation/);
    assert(syntheses.every(text => text.length > 0));
    session.stop();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(plans[1].plan.tasks[0].status, "cancelled");
    assert.equal(await orchestrator.approve(plans[1].plan.tasks[0].id), null);
    const events = budget.snapshot().events;
    assert(events.some(event => event.kind === "stt_audio_seconds" && event.metadata?.providerUsageReported === true));
    for (const kind of ["stt_audio_seconds", "tts_characters", "llm_input_tokens", "llm_output_tokens"]) assert(events.some(event => event.kind === kind));
    assert.equal(budget.snapshot().reservedInr, 0);
  } finally {
    session.stop();
    modelRouter.callLLM = originalLLM;
    agentRegistry.windows.execute = originalExecute;
    for (const server of [asrServer, ttsServer]) { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await Promise.all([new Promise<void>(resolve => http.close(() => resolve())), new Promise<void>(resolve => chat.close(() => resolve()))]);
  }
});
