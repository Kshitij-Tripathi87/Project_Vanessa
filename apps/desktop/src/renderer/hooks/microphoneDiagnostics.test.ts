import assert from "node:assert/strict";
import { test } from "node:test";
import { explainMicrophoneFailure, measureMicrophoneSignal, hasMicrophoneSignal } from "./microphoneDiagnostics.js";

test("permission denial includes Windows desktop microphone privacy steps", () => {
  const message = explainMicrophoneFailure({ name: "NotAllowedError" });
  assert.match(message, /Privacy & security → Microphone/);
  assert.match(message, /Let desktop apps access your microphone/);
});

test("missing and busy microphone errors have distinct remediation", () => {
  assert.match(explainMicrophoneFailure({ name: "NotFoundError" }), /No microphone was found/);
  assert.match(explainMicrophoneFailure({ name: "NotReadableError" }), /Close apps using it/);
});

test("audio engine, security, constraints and interruption are distinguished", () => {
  assert.match(explainMicrophoneFailure({ name: "AudioContextUnavailableError" }), /audio engine/);
  assert.match(explainMicrophoneFailure({ name: "SecurityError" }), /security context/);
  assert.match(explainMicrophoneFailure({ name: "OverconstrainedError" }), /audio format/);
  assert.match(explainMicrophoneFailure({ name: "AbortError" }), /interrupted/);
});

test("unknown and unstructured errors return safe guidance rather than raw exception text", () => {
  assert.match(explainMicrophoneFailure({ name: "MysteryError", message: "raw internal trace" }), /Typed commands remain available/);
  assert.doesNotMatch(explainMicrophoneFailure(new Error("private device data")), /private device data/);
});


test("microphone signal measurement treats centered samples as silence", () => {
  const silence = measureMicrophoneSignal(new Uint8Array(1024).fill(128));
  assert.equal(silence.rms, 0);
  assert.equal(silence.peak, 0);
  assert.equal(hasMicrophoneSignal(silence), false);
});

test("microphone signal measurement detects a captured waveform", () => {
  const samples = new Uint8Array(1024);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 105 : 151;
  const measurement = measureMicrophoneSignal(samples);
  assert(measurement.rms > 0);
  assert(measurement.peak > 0);
  assert.equal(hasMicrophoneSignal(measurement), true);
});

test("microphone signal measurement safely handles empty or malformed samples", () => {
  assert.deepEqual(measureMicrophoneSignal([]), { rms: 0, peak: 0 });
  assert.equal(hasMicrophoneSignal({ rms: Number.NaN, peak: 1 }), false);
});
