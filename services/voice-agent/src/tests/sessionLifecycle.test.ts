import assert from "node:assert/strict";
import { test } from "node:test";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import { SpeechAudioGate } from "../audio/speechGate.js";
import type { AsrAdapter } from "../asr/types.js";
import type { ExecuteCommandResult } from "@vanessa/shared";

function fixture() {
  const cancelled: string[] = [];
  const spoken: string[] = [];
  const hud: string[] = [];
  const requests: Array<{ resolve: (result: ExecuteCommandResult) => void; signal?: AbortSignal }> = [];
  let activations = 0;
  const asr: AsrAdapter = {
    connect() {}, activateStream() { activations++; }, sendAudioChunk() {}, close() {}, deactivateStream() {},
  };
  const session = new VanessaVoiceSession({ asr, tts: {
    async streamSpeech(text, callback) { spoken.push(text); callback({ text, isFinal: true, chunkIndex: 0 }); }, abort() {},
  }, client: {
    executeCommand: (_input, signal) => new Promise(resolve => requests.push({ resolve, signal })),
    async cancelRequest(id) { cancelled.push(id); },
  }, handlers: { onHudUpdate: update => hud.push(update.transcript) } });
  return { session, cancelled, spoken, hud, requests, activations: () => activations };
}

test("barge-in ignores stale replies without cancelling the orchestrator task", async () => {
  const f = fixture();
  await f.session.activateSession();
  const old = f.session.handleFinalUtterance("old request", "en", "old");
  f.session.interrupt();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.requests[0].signal?.aborted, false);
  assert.equal(f.cancelled.length, 0);
  const current = f.session.handleFinalUtterance("new request", "en", "new");
  f.requests[0].resolve({ status: "success", spokenSummary: "STALE REPLY" });
  await old;
  assert.equal(f.session.getState(), "executing");
  f.requests[1].resolve({ status: "success", spokenSummary: "Current reply" });
  await current;
  assert.deepEqual(f.spoken, ["Current reply"]);
  assert(!f.hud.includes("STALE REPLY"));
  f.session.stop();
});

test("stop drops pending results, closes capture, and allows a clean restart", async () => {
  const f = fixture();
  await f.session.activateSession();
  const old = f.session.handleFinalUtterance("first", "en", "first");
  f.session.stop();
  assert.equal(f.requests[0].signal?.aborted, true);
  assert.equal(f.cancelled.length, 1);
  f.requests[0].resolve({ status: "success", spokenSummary: "must not speak" });
  await old;
  assert.deepEqual(f.spoken, []);
  await f.session.activateSession();
  assert.equal(f.activations(), 2);
  assert.equal(f.session.getState(), "listening");
  f.session.stop();
});

test("speech gate retains onset pre-roll and natural pauses, never idle room audio", () => {
  const gate = new SpeechAudioGate();
  for (let i = 0; i < 30; i++) assert.deepEqual(gate.push(new Int16Array(320).fill(i), false), []);
  const onset = gate.push(new Int16Array(320).fill(1000), true);
  assert.equal(onset.length, 10);
  assert.equal(onset[0][0], 21);
  assert.equal(onset.at(-1)![0], 1000);
  assert.equal(gate.push(new Int16Array(320), false).length, 1);
  gate.reset();
  assert.equal(gate.push(new Int16Array(320), false).length, 0);
});

test("failed activation returns to idle and a later PTT can reconnect", async () => {
  let attempts = 0;
  const session = new VanessaVoiceSession({ asr: {
    connect() {}, sendAudioChunk() {}, close() {},
    activateStream() { if (++attempts === 1) throw new Error("network unavailable"); },
  }, tts: { async streamSpeech() {}, abort() {} } });
  await assert.rejects(session.activateSession(), /network unavailable/);
  assert.equal(session.getState(), "idle");
  await session.activateSession();
  assert.equal(session.getState(), "listening");
  session.stop();
});

test("a final transcript arriving after the capture deadline is accepted only for its authorized turn", async () => {
  let handlers!: Parameters<AsrAdapter["connect"]>[0];
  let submissions = 0;
  const session = new VanessaVoiceSession({ asr: {
    connect(value) { handlers = value; }, sendAudioChunk() {}, close() {}, activateStream() {},
  }, tts: { async streamSpeech() {}, abort() {} }, client: {
    async executeCommand() { submissions++; return { status: "success", spokenSummary: "reply" }; }, async cancelRequest() {},
  } });
  await session.activateSession(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await handlers.onFinal({ text: "Check status", language: "en", isFinal: true, turnId: "late-final" });
  assert.equal(submissions, 1);
  session.stop();
  await handlers.onFinal({ text: "must not run", language: "en", isFinal: true, turnId: "stale-final" });
  assert.equal(submissions, 1);
});

test("stopping during TTS does not cancel a command that already returned", async () => {
  let releaseTts!: () => void;
  let announceTtsStarted!: () => void;
  let requestSignal: AbortSignal | undefined;
  const ttsStarted = new Promise<void>((resolve) => { announceTtsStarted = resolve; });
  const cancelled: string[] = [];
  const asr: AsrAdapter = {
    connect() {}, activateStream() {}, sendAudioChunk() {}, deactivateStream() {}, close() {},
  };
  const session = new VanessaVoiceSession({
    asr,
    tts: {
      async streamSpeech(text, callback) {
        callback({ text, isFinal: true, chunkIndex: 0 });
        announceTtsStarted();
        await new Promise<void>((resolve) => { releaseTts = resolve; });
      },
      abort() {},
    },
    client: {
      async executeCommand(_input, signal) {
        requestSignal = signal;
        return { status: "success", spokenSummary: "The task completed." };
      },
      async cancelRequest(requestId) { cancelled.push(requestId); },
    },
  });
  await session.activateSession();
  const response = session.handleFinalUtterance("run the task", "en", "completed-task");
  await ttsStarted;
  session.stop();
  assert.equal(requestSignal?.aborted, false);
  assert.deepEqual(cancelled, []);
  releaseTts();
  await response;
});

test("barge-in aborts TTS playback without cancelling the completed task", async () => {
  let releaseTts!: () => void;
  let announceTtsStarted!: () => void;
  let ttsAbortCalls = 0;
  let cancelCalls = 0;
  let audioChunks = 0;
  const ttsStarted = new Promise<void>((resolve) => { announceTtsStarted = resolve; });
  const asr: AsrAdapter = {
    connect() {}, activateStream() {}, sendAudioChunk() {}, deactivateStream() {}, close() {},
  };
  const session = new VanessaVoiceSession({
    asr,
    tts: {
      async streamSpeech(text, callback) {
        callback({ text, isFinal: false, chunkIndex: 0 });
        await new Promise<void>((resolve) => { releaseTts = resolve; });
      },
      abort() { ttsAbortCalls++; },
    },
    client: {
      async executeCommand() {
        return { status: "success", spokenSummary: "Task completed." };
      },
      async cancelRequest() { cancelCalls++; },
    },
    handlers: { onAudioChunkOut: () => { audioChunks++; } },
  });

  await session.activateSession();
  const response = session.handleFinalUtterance("check task status", "en", "barge-in-tts");
  await new Promise(resolve => setTimeout(resolve, 0));
  await ttsStarted;
  session.interrupt();

  assert.equal(ttsAbortCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(audioChunks, 1);
  releaseTts();
  await response;
  session.stop();
});
