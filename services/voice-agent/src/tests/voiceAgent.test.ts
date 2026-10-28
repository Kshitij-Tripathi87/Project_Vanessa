import assert from "node:assert";
import { once } from "node:events";
import { decode, encode } from "@msgpack/msgpack";
import { WebSocketServer } from "ws";
import { PcmFrameAccumulator } from "../audio/capture.js";
import { SileroVadDetector } from "../audio/vad.js";
import { TurnDetector } from "../audio/turnDetector.js";
import { BargeInDetector } from "../session/bargeIn.js";
import { WakeWordDetector } from "../session/wakeWord.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import { FishAsrAdapter } from "../asr/fishAdapter.js";
import { FishTtsAdapter } from "../tts/fishTts.js";
import { OrchestratorClient } from "../orchestratorClient.js";

async function runTests() {
  console.log("==================================================");
  console.log("   VANESSA VOICE AGENT - WHISPERFLOW PIPELINE     ");
  console.log("==================================================\n");

  // 1. Audio Framing test
  console.log("🧪 Test 1: 20ms PCM Audio Framing (320 samples @ 16kHz)...");
  // 640 bytes = 320 samples of 16-bit PCM
  const dummyBuffer = Buffer.alloc(1280); // 2 frames worth
  const frameAccumulator = new PcmFrameAccumulator();
  assert.strictEqual(frameAccumulator.feed(dummyBuffer.subarray(0, 400)).length, 0, "Partial WebSocket frames must be buffered");
  const chunks = frameAccumulator.feed(dummyBuffer.subarray(400));
  assert.strictEqual(chunks.length, 2, "Should assemble 1280 bytes into two 640-byte 20ms frames");
  assert.strictEqual(chunks[0].pcm.length, 320, "Each chunk must have 320 samples");
  assert.strictEqual(chunks[0].durationMs, 20, "Each chunk duration must be 20ms");
  console.log("✅ [PASS] 20ms PCM Audio Framing verified.\n");

  // Fish realtime ASR wire protocol and audio batching regression test.
  console.log("🧪 Test 1b: Fish realtime ASR MessagePack session and committed user turns...");
  const fishServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(fishServer, "listening");
  const fishAddress = fishServer.address();
  assert(typeof fishAddress !== "string" && fishAddress, "Fish test server should bind an ephemeral TCP port");
  const clientMessages: any[] = [];
  let resolveFishReady!: () => void;
  let resolveFishFinal!: (text: string) => void;
  const fishReady = new Promise<void>((resolve) => { resolveFishReady = resolve; });
  const fishFinal = new Promise<string>((resolve) => { resolveFishFinal = resolve; });
  fishServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = decode(data as Buffer) as any;
      clientMessages.push(message);
      if (message.type === "config") {
        assert.deepStrictEqual(message.audio, { format: "pcm_s16le", sample_rate: 16000, channels: 1 });
        assert.deepStrictEqual(message.turn_detection, { mode: "auto", eager: true });
        assert.deepStrictEqual(message.results, { drafts: true });
        assert.deepStrictEqual(message.context.history, [
          { role: "user", text: "Open my project" },
          { role: "assistant", text: "Opening it now." },
        ]);
        socket.send(encode({ type: "session_started", session_id: "test-session" }));
        resolveFishReady();
      } else if (message.type === "audio_done") {
        socket.send(encode({ type: "committed", text: "background audio", user_turn: false, language_code: "en" }));
        socket.send(encode({ type: "committed", text: "open the project", user_turn: true, language_code: "en" }));
        socket.send(encode({ type: "session_done", stats: { audio_ms: 100, turns: 2 } }));
        socket.close();
      }
    });
  });
  const fishAsr = new FishAsrAdapter({
    apiKey: "sk-fish-test-key",
    url: `ws://127.0.0.1:${fishAddress.port}`,
    allowFallback: false,
  });
  fishAsr.setConversationContext([
    { role: "user", content: "Open my project" },
    { role: "assistant", content: "Opening it now." },
  ]);
  fishAsr.connect({ onPartial: () => {}, onFinal: (result) => resolveFishFinal(result.text) });
  await fishAsr.activateStream(5000);
  await fishReady;
  const hundredMsPcm = new Int16Array(320);
  for (let frame = 0; frame < 5; frame++) fishAsr.sendAudioChunk(hundredMsPcm);
  fishAsr.finalizeTurn();
  assert.strictEqual(await fishFinal, "open the project", "Non-user committed turns must not be dispatched");
  const audioMessage = clientMessages.find((message) => message.type === "audio");
  assert.strictEqual(audioMessage.data.length, 3200, "Fish ASR audio messages must batch 100ms of 16kHz mono PCM");
  assert(clientMessages.some((message) => message.type === "audio_done"), "Fish ASR session must end with audio_done");
  fishAsr.close();
  await new Promise<void>((resolve) => fishServer.close(() => resolve()));
  console.log("✅ [PASS] Fish ASR MessagePack handshake, audio framing and turn filtering verified.\n");

  // A configured provider that rejects its session must fail visibly without implicit fallback.
  const failingFishServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(failingFishServer, "listening");
  const failingFishAddress = failingFishServer.address();
  assert(typeof failingFishAddress !== "string" && failingFishAddress);
  failingFishServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = decode(data as Buffer) as any;
      if (message.type === "config") socket.send(encode({ type: "error", message: "test provider rejection" }));
    });
  });
  const failingFishAsr = new FishAsrAdapter({
    apiKey: "sk-fish-test-key",
    url: `ws://127.0.0.1:${failingFishAddress.port}`,
    allowFallback: false,
  });
  await failingFishAsr.connect({ onPartial: () => {}, onFinal: () => {} });
  await assert.rejects(failingFishAsr.activateStream(5000), /test provider rejection/);
  assert.strictEqual(failingFishAsr.getProviderStatus().state, "error");
  failingFishAsr.close();
  await new Promise<void>((resolve) => failingFishServer.close(() => resolve()));

  // The voice boundary sends a stable, expiring idempotency envelope to the orchestrator.
  const originalFetch = globalThis.fetch;
  let submittedBody: any;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    submittedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: "accepted", spokenSummary: "Request accepted." }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new OrchestratorClient("http://orchestrator.test");
    const result = await client.executeCommand({
      command: "open the project",
      requestId: "voice-test-turn-42",
      idempotencyKey: "voice:voice-test-turn-42",
      conversationContext: [{ role: "user", content: "Open my project" }],
    });
    assert.strictEqual(result.requestId, "voice-test-turn-42");
    assert.strictEqual(submittedBody.envelope.requestId, "voice-test-turn-42");
    assert.strictEqual(submittedBody.envelope.idempotencyKey, "voice:voice-test-turn-42");
    assert.strictEqual(submittedBody.envelope.source, "voice");
    assert(submittedBody.envelope.expiresAt > submittedBody.envelope.createdAt);
    assert.deepStrictEqual(submittedBody.conversationContext, [{ role: "user", content: "Open my project" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Fish live TTS wire protocol, PCM chunk boundaries, voice selection and explicit fallback.
  console.log("Test 1c: Fish live TTS protocol and configured voice...");
  const ttsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(ttsServer, "listening");
  const ttsAddress = ttsServer.address();
  assert(typeof ttsAddress !== "string" && ttsAddress, "Fish TTS test server should bind an ephemeral TCP port");
  const ttsMessages: any[] = [];
  ttsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = decode(data as Buffer) as any;
      ttsMessages.push(message);
      if (message.event === "stop") {
        socket.send(encode({ event: "audio", audio: new Uint8Array([1, 2, 3, 4]) }));
        socket.send(encode({ event: "audio", audio: new Uint8Array([5, 6, 7, 8]) }));
        socket.send(encode({ event: "finish", reason: "stop" }));
      }
    });
  });
  const tts = new FishTtsAdapter({
    apiKey: "sk-fish-test-key",
    voiceId: "vanessa-test-voice",
    model: "s2.1-pro-free",
    url: `ws://127.0.0.1:${ttsAddress.port}`,
  });
  const spokenChunks: any[] = [];
  await tts.streamSpeech("Hello there. How are you?", (chunk) => spokenChunks.push(chunk));
  assert.deepStrictEqual(ttsMessages.map((message) => message.event), ["start", "text", "flush", "stop"]);
  assert.strictEqual(ttsMessages[0].request.reference_id, "vanessa-test-voice");
  assert.strictEqual(ttsMessages[0].request.format, "pcm");
  assert.strictEqual(ttsMessages[0].request.sample_rate, 24000);
  assert.strictEqual(ttsMessages[1].text, "Hello there. How are you?");
  assert.strictEqual(spokenChunks.length, 2, "PCM frames should stream separately");
  assert.strictEqual(spokenChunks[0].isFinal, false);
  assert.strictEqual(spokenChunks[1].isFinal, true);
  assert(spokenChunks.every((chunk) => chunk.audioBase64 && chunk.format === "pcm_s16le" && chunk.sampleRate === 24000));
  await new Promise<void>((resolve) => ttsServer.close(() => resolve()));

  const missingVoiceTts = new FishTtsAdapter({ apiKey: "sk-fish-test-key", voiceId: "", fallback: "none" });
  const fallbackChunks: any[] = [];
  await assert.rejects(missingVoiceTts.streamSpeech("Cannot speak silently.", (chunk) => fallbackChunks.push(chunk)), /voice ID/i);
  assert.strictEqual(missingVoiceTts.getProviderStatus()?.state, "error");
  assert.strictEqual(fallbackChunks.length, 0, "Unconfigured TTS must not silently use another voice");
  const explicitFallback = new FishTtsAdapter({ apiKey: "", voiceId: "", fallback: "browser" });
  const fallbackChunk: any[] = [];
  await explicitFallback.streamSpeech("Fallback is ready.", (chunk) => fallbackChunk.push(chunk));
  assert.strictEqual(explicitFallback.getProviderStatus()?.state, "fallback");
  assert.strictEqual(fallbackChunk[0].fallbackSpeech, true);
  console.log("[PASS] Fish live TTS PCM stream and explicit fallback verified.\n");

  // 2. VAD Detection test
  console.log("🧪 Test 2: VAD Speech & Energy Detection...");
  const vad = new SileroVadDetector({ energyThreshold: 500 });
  const silencePcm = new Int16Array(320); // all zeros
  const speechPcm = new Int16Array(320);
  for (let i = 0; i < 320; i++) {
    speechPcm[i] = Math.sin(i * 0.1) * 8000; // loud sine wave
  }

  const silenceRes = vad.processChunk(silencePcm);
  assert.strictEqual(silenceRes.isSpeech, false, "Zero buffer should be silence");

  const speechRes = vad.processChunk(speechPcm);
  assert.strictEqual(speechRes.isSpeech, true, "Sine wave buffer should be detected as speech");
  assert(speechRes.energy > 500, "Energy should exceed threshold");
  console.log("✅ [PASS] VAD Speech & Energy Detection verified.\n");

  // 3. Turn Detector test
  console.log("🧪 Test 3: Turn Detector (Speech -> Silence -> Complete)...");
  const turnDetector = new TurnDetector({ silenceThresholdMs: 100, minSpeechMs: 40 });

  // Feed 2 speech frames (40ms)
  turnDetector.process({ isSpeech: true, partialTranscript: "Restart my Wi-Fi" });
  turnDetector.process({ isSpeech: true, partialTranscript: "Restart my Wi-Fi" });
  assert.strictEqual(turnDetector.getState(), "listening", "State should be listening during speech");

  // Feed silence frames to cross silenceThresholdMs (100ms / 20ms = 5 frames)
  let finalState = "listening";
  for (let i = 0; i < 6; i++) {
    finalState = turnDetector.process({ isSpeech: false, partialTranscript: "Restart my Wi-Fi" });
  }
  assert.strictEqual(finalState, "complete", "Turn should be complete after silence threshold");
  console.log("✅ [PASS] Turn Detector verified.\n");

  // 4. Barge-In Interruption test
  console.log("🧪 Test 4: Barge-In Detector (240ms speech debounce window)...");
  const bargeIn = new BargeInDetector();

  // Agent not speaking -> should never interrupt
  assert.strictEqual(bargeIn.shouldInterrupt(true, false), false, "Should not interrupt if agent is silent");

  // Agent speaking, user speaks for 11 frames (220ms) -> not yet interrupted
  for (let i = 0; i < 11; i++) {
    const interrupt = bargeIn.shouldInterrupt(true, true);
    assert.strictEqual(interrupt, false, "Frame " + i + " should not trigger interrupt before 240ms");
  }

  // 12th frame (240ms threshold) -> interrupt triggers!
  const trigger = bargeIn.shouldInterrupt(true, true);
  assert.strictEqual(trigger, true, "12th consecutive frame (240ms) must trigger barge-in interrupt");
  console.log("✅ [PASS] Barge-In Detector verified.\n");

  // 5. Wake Word "Hey Vanessa" activation test
  console.log("🧪 Test 5: Wake Word 'Hey Vanessa' Detection & Prefix Stripping...");
  const wakeWord = new WakeWordDetector();

  const res1 = wakeWord.processTranscript("hey vanessa restart the wi-fi adapter");
  assert.strictEqual(res1.detected, true, "'hey vanessa' wake word should be detected");
  assert.strictEqual(res1.cleanedText, "restart the wi-fi adapter", "Wake word prefix must be stripped");

  const res2 = wakeWord.processTranscript("vanessa open chrome and play youtube");
  assert.strictEqual(res2.detected, true, "'vanessa' wake word should be detected");
  assert.strictEqual(res2.cleanedText, "open chrome and play youtube", "Wake word prefix must be stripped");

  const res3 = wakeWord.processTranscript("what is the weather today?");
  // Because active session is maintained after wake word, subsequent turn is active
  assert.strictEqual(res3.detected, true, "Active conversation session should continue without repeated wake word");
  console.log("✅ [PASS] Wake Word 'Hey Vanessa' activation verified.\n");

  // 6. Vanessa Voice Session Integration test
  console.log("🧪 Test 6: VanessaVoiceSession WhisperFlow Loop...");
  let stateTransitions: string[] = [];
  const session = new VanessaVoiceSession({
    handlers: {
      onStateChange: (state) => stateTransitions.push(state),
    },
  });

  await session.start();
  assert.strictEqual(session.getState(), "idle", "Session should initialize in idle state");

  // Trigger barge-in
  session.interrupt();
  assert.strictEqual(session.getState(), "interrupted", "Session should enter interrupted state");

  session.stop();
  assert.strictEqual(session.getState(), "idle", "Session should return to idle when stopped");
  console.log("✅ [PASS] VanessaVoiceSession WhisperFlow Loop verified.\n");

  console.log("==================================================");
  console.log("🎉 ALL 6 WHISPERFLOW PIPELINE TESTS PASSED!       ");
  console.log("==================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
