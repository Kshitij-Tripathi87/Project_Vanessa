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
  const session = new VanessaVoiceSession({ asrProvider: "sarvam", ttsProvider: "sarvam" });
  await assert.rejects(session.enableWakeWordMonitor(), /local Whisper speech runtime/);
  session.stop();
});
