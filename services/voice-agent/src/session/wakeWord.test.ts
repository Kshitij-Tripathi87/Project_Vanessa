import assert from "node:assert/strict";
import { test } from "node:test";
import { WakeWordDetector } from "./wakeWord.js";

test("wake phrase must lead the utterance and have a token boundary", () => {
  const detector = new WakeWordDetector();
  assert.deepEqual(detector.processTranscript("Hey Vanessa, open Notepad"), {
    detected: true,
    cleanedText: "open notepad",
  });
  detector.resetSession();

  assert.equal(detector.processTranscript("I saw Vanessa yesterday").detected, false);
  assert.equal(detector.processTranscript("Vanessability is not a wake phrase").detected, false);
  assert.equal(detector.processTranscript("Okay Vanessa").detected, true);
  detector.resetSession();
});
import { VanessaVoiceSession } from "./voiceSession.js";

test("hosted ASR cannot enable always-on ambient wake-word monitoring", async () => {
  const asrOrigin = new URL(process.env.SARVAM_ASR_URL || "wss://api.sarvam.ai/speech-to-text-realtime/ws").origin;
  const session = new VanessaVoiceSession({
    asrProvider: "sarvam", ttsProvider: "browser",
    // Even an explicitly admitted hosted provider cannot receive ambient audio.
    hostedEgressPolicy: { allows: (request) => request.provider === "sarvam" && request.purpose === "speech_input" && request.origin === asrOrigin },
  });
  await assert.rejects(session.enableWakeWordMonitor(), /local Whisper speech runtime/);
  session.stop();
});
