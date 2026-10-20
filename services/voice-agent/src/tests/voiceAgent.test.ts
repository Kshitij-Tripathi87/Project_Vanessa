import assert from "node:assert";
import { AudioCapture, AudioChunk } from "../audio/capture.js";
import { SileroVadDetector } from "../audio/vad.js";
import { TurnDetector } from "../audio/turnDetector.js";
import { BargeInDetector } from "../session/bargeIn.js";
import { WakeWordDetector } from "../session/wakeWord.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";

async function runTests() {
  console.log("==================================================");
  console.log("   VANESSA VOICE AGENT - WHISPERFLOW PIPELINE     ");
  console.log("==================================================\n");

  // 1. Audio Framing test
  console.log("🧪 Test 1: 20ms PCM Audio Framing (320 samples @ 16kHz)...");
  // 640 bytes = 320 samples of 16-bit PCM
  const dummyBuffer = Buffer.alloc(1280); // 2 frames worth
  const chunks = AudioCapture.framePcmBuffer(dummyBuffer);
  assert.strictEqual(chunks.length, 2, "Should slice 1280 bytes into two 640-byte 20ms frames");
  assert.strictEqual(chunks[0].pcm.length, 320, "Each chunk must have 320 samples");
  assert.strictEqual(chunks[0].durationMs, 20, "Each chunk duration must be 20ms");
  console.log("✅ [PASS] 20ms PCM Audio Framing verified.\n");

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
