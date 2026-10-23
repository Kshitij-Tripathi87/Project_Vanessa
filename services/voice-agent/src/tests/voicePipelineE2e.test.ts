import assert from "node:assert/strict";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import type { AsrAdapter, ProviderRuntimeStatus, TranscriptResult } from "../asr/types.js";
import type { VoiceTtsAdapter, TtsOutputChunk } from "../tts/types.js";
import type { OrchestratorClient, OrchestratorCommandResult } from "../orchestratorClient.js";

type AsrHandlers = Parameters<AsrAdapter["connect"]>[0];

class FakeAsr implements AsrAdapter {
  name = "Fake ASR";
  private handlers?: AsrHandlers;
  active = false;
  closed = false;
  chunks: Int16Array[] = [];
  connectCount = 0;
  activateCount = 0;
  deactivateCount = 0;

  connect(handlers: AsrHandlers): void { this.handlers = handlers; this.connectCount++; }
  sendAudioChunk(pcm: Int16Array): void { this.chunks.push(pcm); }
  activateStream(): void { this.active = true; this.activateCount++; }
  deactivateStream(): void { this.active = false; this.deactivateCount++; }
  finalizeTurn(): void {}
  setConversationContext(_turns: Array<{ role: "user" | "assistant"; content: string }>): void {}
  getProviderStatus(): ProviderRuntimeStatus { return { requested: this.name, active: this.name, state: "ready" }; }
  close(): void { this.closed = true; this.active = false; }

  emitPartial(text: string): void {
    this.handlers?.onPartial({ text, isFinal: false, language: "en", confidence: 0.91 });
  }
  emitFinal(text: string, turnId: string): void {
    this.handlers?.onFinal({ text, isFinal: true, language: "en", confidence: 0.99, turnId });
  }
}

class FakeTts implements VoiceTtsAdapter {
  texts: string[] = [];
  chunks: TtsOutputChunk[] = [];
  abortCount = 0;
  private waiters: Array<() => void> = [];
  async streamSpeech(text: string, onAudioChunk: (chunk: TtsOutputChunk) => void): Promise<void> {
    this.texts.push(text);
    const chunk: TtsOutputChunk = {
      chunkIndex: 0, text, audioBase64: Buffer.from("fake-audio").toString("base64"),
      format: "mp3", isFinal: true, fallbackSpeech: true,
    };
    this.chunks.push(chunk);
    onAudioChunk(chunk);
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  abort(): void { this.abortCount++; }
  waitForSpeechCount(expected: number): Promise<void> {
    if (this.texts.length >= expected) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function waitUntil(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error("Timed out waiting for voice pipeline postcondition"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function main() {
  const asr = new FakeAsr();
  const tts = new FakeTts();
  const requests: Array<Record<string, any>> = [];
  const spoken = "Bluetooth is off, brightness is 80%, and I found a playlist.";
  const result: OrchestratorCommandResult = {
    status: "success", spokenSummary: spoken, requestId: "voice-test-request",
    planId: "plan-test", plan: { tasks: [
      { id: "os-bluetooth", agent: "windows", action: "bluetooth.disable", status: "success" },
      { id: "os-brightness", agent: "windows", action: "brightness.set", status: "success" },
      { id: "browser-playlist", agent: "browser", action: "youtube.search", status: "success" },
    ] },
  };
  const orchestrator = {
    executeCommand: async (input: any) => { requests.push(input); return { ...result, requestId: input.requestId }; },
  } as unknown as Pick<OrchestratorClient, "executeCommand">;
  const partialTranscripts: string[] = [];
  const finalTranscripts: Array<{ text: string; requestId: string }> = [];
  const emittedAudio: TtsOutputChunk[] = [];
  const states: string[] = [];
  const session = new VanessaVoiceSession({
    asrAdapter: asr, ttsAdapter: tts, orchestrator, initializeWakeWord: false,
    handlers: {
      onPartialTranscript: (text) => partialTranscripts.push(text),
      onFinalTranscript: (text, requestId) => finalTranscripts.push({ text, requestId }),
      onAudioChunkOut: (chunk) => emittedAudio.push(chunk as TtsOutputChunk),
      onStateChange: (state) => states.push(state),
    },
  });

  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "partial ASR transcript updates the UI but does not dispatch a task",
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
      name: "committed wake-word request reaches orchestrator once and response is sent to TTS",
      run: async () => {
        const command = "Hey Vanessa, turn off Bluetooth, increase brightness to 80%, open YouTube.com, and search for a playlist";
        asr.emitFinal(command, "fish-turn-001");
        await tts.waitForSpeechCount(1);
        await waitUntil(() => session.getState() === "idle" && requests.length === 1);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].command, "turn off Bluetooth, increase brightness to 80%, open YouTube.com, and search for a playlist");
        assert.equal(requests[0].source, "voice");
        assert.equal(requests[0].language, "en");
        assert.equal(requests[0].idempotencyKey, `voice:${requests[0].requestId}`);
        assert.ok(requests[0].requestId.startsWith("voice-"));
        assert.equal(finalTranscripts.length, 1);
        assert.equal(finalTranscripts[0].text, requests[0].command);
        assert.equal(tts.texts[0], spoken);
        assert.equal(emittedAudio.length, 1);
        assert.equal(emittedAudio[0].text, spoken);
        assert.ok(states.includes("thinking"));
        assert.ok(states.includes("executing"));
        assert.ok(states.includes("responding"));
      },
    },
    {
      name: "repeated committed turn ID is not dispatched twice",
      run: async () => {
        asr.emitFinal("Hey Vanessa, turn off Bluetooth", "fish-turn-001");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(requests.length, 1);
        assert.equal(tts.texts.length, 1);
      },
    },
  ];

  let failed = 0;
  for (const test of cases) {
    try { await test.run(); console.log(`PASS ${test.name}`); }
    catch (error) { failed++; console.error(`FAIL ${test.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
  }
  session.stop();
  assert.equal(asr.closed, true);
  console.log(`Voice pipeline contract tests: ${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main().catch((error) => { console.error(error); process.exit(1); });