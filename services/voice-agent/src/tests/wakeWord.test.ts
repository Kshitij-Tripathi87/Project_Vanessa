import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PcmSampleFrameAccumulator, getWakeWordReadiness } from "../session/porcupineWakeWord.js";
import { WakeWordDetector } from "../session/wakeWord.js";

test("recognizes Hey Vanessa, Hi Vanessa, and Hello Vanessa while preserving the command text", () => {
  const detector = new WakeWordDetector();
  assert.deepEqual(detector.processTranscript("Hey Vanessa, Open YouTube and search for jazz"), {
    detected: true, cleanedText: "Open YouTube and search for jazz",
  });
  detector.resetSession();
  assert.deepEqual(detector.processTranscript("Hi Vanessa! read my notes.md"), {
    detected: true, cleanedText: "read my notes.md",
  });
  detector.resetSession();
  assert.deepEqual(detector.processTranscript("Hello Vanessa, please help"), {
    detected: true, cleanedText: "please help",
  });
  detector.resetSession();
});

test("does not wake on a phrase in the middle of unrelated speech, but accepts follow-up speech after activation", () => {
  const detector = new WakeWordDetector();
  assert.deepEqual(detector.processTranscript("Yesterday I said Hey Vanessa to test it"), {
    detected: false, cleanedText: "Yesterday I said Hey Vanessa to test it",
  });
  detector.touchActiveSession(5_000);
  assert.deepEqual(detector.processTranscript("Open the browser"), {
    detected: true, cleanedText: "Open the browser",
  });
  detector.resetSession();
});

test("buffers arbitrary PCM chunks into the exact model frame size without dropping samples", () => {
  const accumulator = new PcmSampleFrameAccumulator(512);
  const frames: number[] = [];
  const process = (frame: Int16Array) => { frames.push(frame.length); return false; };
  assert.equal(accumulator.feed(new Int16Array(320), process), false);
  assert.equal(accumulator.pendingSamples, 320);
  assert.equal(accumulator.feed(new Int16Array(320), process), false);
  assert.deepEqual(frames, [512]);
  assert.equal(accumulator.pendingSamples, 128);
  accumulator.feed(new Int16Array(832), process);
  assert.deepEqual(frames, [512, 512]);
  assert.equal(accumulator.pendingSamples, 448);
});

test("reports why local wake detection is unavailable instead of claiming it is active", async () => {
  assert.equal(getWakeWordReadiness({ VOICE_WAKE_PROVIDER: "porcupine" }).available, false);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-wake-word-"));
  try {
    const model = path.join(temp, "hey-vanessa_windows.ppn");
    await fs.writeFile(model, "fixture-model");
    const readiness = getWakeWordReadiness({
      VOICE_WAKE_PROVIDER: "porcupine",
      PORCUPINE_ACCESS_KEY: "configured-test-key",
      PORCUPINE_KEYWORD_PATHS: model,
    });
    assert.equal(readiness.available, true);
    assert.equal(readiness.keyword, "Hey Vanessa");
    const missing = getWakeWordReadiness({
      VOICE_WAKE_PROVIDER: "porcupine",
      PORCUPINE_ACCESS_KEY: "configured-test-key",
      PORCUPINE_KEYWORD_PATHS: path.join(temp, "missing.ppn"),
    });
    assert.equal(missing.available, false);
    assert.match(missing.reason || "", /missing|not a \.ppn/i);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
