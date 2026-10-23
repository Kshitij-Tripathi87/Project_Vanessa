import assert from "node:assert/strict";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import type { AsrAdapter, ProviderRuntimeStatus } from "../asr/types.js";
import type { VoiceTtsAdapter, TtsOutputChunk } from "../tts/types.js";

type AsrHandlers = Parameters<AsrAdapter["connect"]>[0];
class FakeAsr implements AsrAdapter {
  name = "Fake ASR";
  private handlers?: AsrHandlers;
  failConnect = false;
  closed = false;
  connect(handlers: AsrHandlers): void {
    if (this.failConnect) throw new Error("test ASR handshake rejection");
    this.handlers = handlers;
  }
  sendAudioChunk(_pcm: Int16Array): void {}
  activateStream(): void {}
  deactivateStream(): void {}
  getProviderStatus(): ProviderRuntimeStatus { return { requested: this.name, active: this.name, state: this.failConnect ? "error" : "ready" }; }
  close(): void { this.closed = true; }
}
class FakeTts implements VoiceTtsAdapter {
  texts: string[] = [];
  abortCount = 0;
  fail = false;
  private waiters: Array<() => void> = [];
  async streamSpeech(text: string, onAudioChunk: (chunk: TtsOutputChunk) => void): Promise<void> {
    if (this.fail) throw new Error("test TTS provider failure");
    this.texts.push(text);
    onAudioChunk({ chunkIndex: 0, text, isFinal: true, fallbackSpeech: true });
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  abort(): void { this.abortCount++; }
  waitForCount(count: number): Promise<void> {
    if (this.texts.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
function waitUntil(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error("Timed out waiting for voice recovery postcondition"));
      setTimeout(poll, 10);
    };
    poll();
  });
}
async function main() {
  const originalFetch = globalThis.fetch;
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "ASR handshake failure returns session to idle and surfaces failure to caller",
      run: async () => {
        const asr = new FakeAsr(); asr.failConnect = true;
        const tts = new FakeTts();
        const session = new VanessaVoiceSession({ asrAdapter: asr, ttsAdapter: tts, initializeWakeWord: false });
        await assert.rejects(session.activateSession(1000), /test ASR handshake rejection/);
        assert.equal(session.getState(), "idle");
        assert.equal(tts.texts.length, 0);
        session.stop();
      },
    },
    {
      name: "orchestrator HTTP failure is spoken as a failure rather than success",
      run: async () => {
        const asr = new FakeAsr(); const tts = new FakeTts();
        const session = new VanessaVoiceSession({ asrAdapter: asr, ttsAdapter: tts, initializeWakeWord: false });
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })) as typeof fetch;
        await session.handleFinalUtterance("Hey Vanessa, open YouTube", "en", "turn-failure-1");
        assert.equal(tts.texts.length, 1);
        assert.match(tts.texts[0], /couldn.t reach the task coordinator/i);
        assert.equal(session.getState(), "idle");
        session.stop();
      },
    },
    {
      name: "TTS failure keeps the text result available and notifies the UI",
      run: async () => {
        const asr = new FakeAsr(); const tts = new FakeTts(); tts.fail = true;
        const hud: Array<{ state: string; transcript: string }> = [];
        const unavailable: string[] = [];
        const session = new VanessaVoiceSession({
          asrAdapter: asr, ttsAdapter: tts, initializeWakeWord: false,
          handlers: { onHudUpdate: (item) => hud.push(item), onTtsUnavailable: (detail) => unavailable.push(detail) },
        });
        globalThis.fetch = (async () => new Response(JSON.stringify({ status: "success", spokenSummary: "Bluetooth is off.", requestId: "tts-fail" }), { status: 200 })) as typeof fetch;
        await session.handleFinalUtterance("Hey Vanessa, turn off Bluetooth", "en", "turn-tts-fail");
        assert.ok(hud.some((item) => item.state === "responding" && item.transcript === "Bluetooth is off."));
        assert.deepEqual(unavailable, ["test TTS provider failure"]);
        assert.equal(session.getState(), "idle");
        session.stop();
      },
    },
    {
      name: "a follow-up wake-word turn is queued and processed after the active task completes",
      run: async () => {
        const asr = new FakeAsr(); const tts = new FakeTts();
        const received: string[] = [];
        let releaseFirst!: () => void;
        const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let fetchCount = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body || "{}"));
          received.push(body.envelope?.command || body.command);
          fetchCount++;
          if (fetchCount === 1) await firstResponse;
          return new Response(JSON.stringify({ status: "success", spokenSummary: fetchCount === 1 ? "Bluetooth is off." : "YouTube is open.", requestId: body.requestId }), { status: 200 });
        }) as typeof fetch;
        const session = new VanessaVoiceSession({ asrAdapter: asr, ttsAdapter: tts, initializeWakeWord: false });
        const first = session.handleFinalUtterance("Hey Vanessa, turn off Bluetooth", "en", "turn-queue-1");
        await waitUntil(() => fetchCount === 1);
        await session.handleFinalUtterance("Hey Vanessa, open YouTube", "en", "turn-queue-2");
        assert.equal(fetchCount, 1, "follow-up should wait until the active task is done");
        releaseFirst();
        await first;
        await tts.waitForCount(2);
        await waitUntil(() => fetchCount === 2 && session.getState() === "idle");
        assert.deepEqual(received, ["turn off Bluetooth", "open YouTube"]);
        assert.deepEqual(tts.texts, ["Bluetooth is off.", "YouTube is open."]);
        session.stop();
      },
    },
  ];

  let failed = 0;
  try {
    for (const test of cases) {
      try { await test.run(); console.log(`PASS ${test.name}`); }
      catch (error) { failed++; console.error(`FAIL ${test.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
    }
  } finally { globalThis.fetch = originalFetch; }
  console.log(`Voice turn recovery tests: ${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}
void main().catch((error) => { console.error(error); process.exit(1); });