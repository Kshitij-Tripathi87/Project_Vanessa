import assert from "node:assert/strict";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import type { AsrAdapter, ProviderRuntimeStatus } from "../asr/types.js";
import type { VoiceTtsAdapter, TtsOutputChunk } from "../tts/types.js";
import type { OrchestratorClient, OrchestratorCommandResult } from "../orchestratorClient.js";

type AsrHandlers = Parameters<AsrAdapter["connect"]>[0];
class FakeAsr implements AsrAdapter {
  name = "Fake ASR";
  private handlers?: AsrHandlers;
  closed = false;
  connect(handlers: AsrHandlers): void { this.handlers = handlers; }
  sendAudioChunk(_pcm: Int16Array): void {}
  activateStream(): void {}
  deactivateStream(): void {}
  finalizeTurn(): void {}
  setConversationContext(_turns: Array<{ role: "user" | "assistant"; content: string }>): void {}
  getProviderStatus(): ProviderRuntimeStatus { return { requested: this.name, active: this.name, state: "ready" }; }
  close(): void { this.closed = true; }
  emitPartial(text: string): void { this.handlers?.onPartial({ text, isFinal: false, language: "en", confidence: 0.9 }); }
  emitFinal(text: string, turnId: string): void { this.handlers?.onFinal({ text, isFinal: true, language: "en", confidence: 0.99, turnId }); }
}
class FakeTts implements VoiceTtsAdapter {
  texts: string[] = [];
  chunks: TtsOutputChunk[] = [];
  private waiters: Array<() => void> = [];
  async streamSpeech(text: string, onAudioChunk: (chunk: TtsOutputChunk) => void): Promise<void> {
    this.texts.push(text);
    const chunk: TtsOutputChunk = { chunkIndex: 0, text, isFinal: true, audioBase64: Buffer.from("test-audio").toString("base64"), fallbackSpeech: true };
    this.chunks.push(chunk);
    onAudioChunk(chunk);
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  abort(): void {}
  waitForCount(count: number): Promise<void> {
    if (this.texts.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
function waitUntil(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for voice E2E postcondition"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function main() {
  const asr = new FakeAsr();
  const tts = new FakeTts();
  const requests: Array<Record<string, any>> = [];
  const spokenSummary = "Bluetooth is off, brightness is 80%, and I found YouTube search results.";
  const orchestratorResult: OrchestratorCommandResult = {
    status: "success", spokenSummary, requestId: "voice-e2e", planId: "plan-e2e",
    plan: { tasks: [
      { id: "bt", agent: "windows", action: "bluetooth.disable", status: "success" },
      { id: "brightness", agent: "windows", action: "brightness.set", status: "success" },
      { id: "youtube", agent: "browser", action: "youtube.search", status: "success" },
    ] } as any,
  };
  const orchestrator = {
    executeCommand: async (input: any) => { requests.push(input); return { ...orchestratorResult, requestId: input.requestId }; },
  } as unknown as Pick<OrchestratorClient, "executeCommand">;
  const partialTranscripts: string[] = [];
  const finalTranscripts: Array<{ text: string; requestId: string }> = [];
  const audioChunks: TtsOutputChunk[] = [];
  const session = new VanessaVoiceSession({
    asrAdapter: asr, ttsAdapter: tts, orchestrator, initializeWakeWord: false,
    handlers: {
      onPartialTranscript: (text) => partialTranscripts.push(text),
      onFinalTranscript: (text, requestId) => finalTranscripts.push({ text, requestId }),
      onAudioChunkOut: (chunk) => audioChunks.push(chunk as TtsOutputChunk),
    },
  });

  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "partial ASR transcript is surfaced but does not dispatch work",
      run: async () => {
        await session.start();
        await session.activateSession(5000);
        asr.emitPartial("turn off Bluetooth");
        assert.deepEqual(partialTranscripts, ["turn off Bluetooth"]);
        assert.equal(requests.length, 0);
        assert.equal(session.getState(), "listening");
      },
    },
    {
      name: "committed wake-word turn is dispatched once and orchestrator summary flows back to TTS",
      run: async () => {
        const command = "HEY VANESSA, Turn off Bluetooth, increase brightness to 80%, open YouTube.com, and search me a playlist";
        asr.emitFinal(command, "asr-turn-001");
        await tts.waitForCount(1);
        await waitUntil(() => requests.length === 1 && session.getState() === "idle");
        const expectedCommand = "Turn off Bluetooth, increase brightness to 80%, open YouTube.com, and search me a playlist";
        assert.equal(requests.length, 1);
        assert.equal(requests[0].command, expectedCommand);
        assert.equal(requests[0].source, "voice");
        assert.equal(requests[0].language, "en");
        assert.ok(requests[0].requestId.startsWith("voice-"));
        assert.equal(requests[0].idempotencyKey, "voice:" + requests[0].requestId);
        assert.deepEqual(finalTranscripts, [{ text: expectedCommand, requestId: requests[0].requestId }]);
        assert.deepEqual(tts.texts, [spokenSummary]);
        assert.equal(audioChunks.length, 1);
        assert.equal(audioChunks[0].text, spokenSummary);
      },
    },
    {
      name: "duplicate committed ASR turn ID is not dispatched or spoken twice",
      run: async () => {
        asr.emitFinal("Hey Vanessa, turn off Bluetooth", "asr-turn-001");
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(requests.length, 1);
        assert.equal(tts.texts.length, 1);
      },
    },
  ];

  let failures = 0;
  try {
    for (const test of cases) {
      try { await test.run(); console.log("PASS " + test.name); }
      catch (error) { failures++; console.error("FAIL " + test.name + ": " + (error instanceof Error ? error.stack || error.message : String(error))); }
    }
  } finally { session.stop(); }
  assert.equal(asr.closed, true);
  console.log("Voice E2E contract tests: " + (cases.length - failures) + "/" + cases.length + " passed");
  process.exit(failures ? 1 : 0);
}
void main().catch((error) => { console.error(error); process.exit(1); });