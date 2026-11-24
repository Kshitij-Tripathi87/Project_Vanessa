import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHostedEgress, denyHostedEgress, type HostedEgressPolicy } from "./hostedEgress.js";

test("hosted egress is denied by default even with a configured endpoint", () => {
  assert.throws(() => assertHostedEgress(denyHostedEgress, "sarvam", "speech_input", "wss://api.sarvam.ai/asr"), /separate scoped user permission/);
});

test("a policy receives exact recipient, provider and data purpose; a different scope is denied", () => {
  const policy: HostedEgressPolicy = { allows: (request) => request.provider === "fish" && request.purpose === "speech_output" && request.origin === "wss://api.example.test:8443" };
  assert.doesNotThrow(() => assertHostedEgress(policy, "fish", "speech_output", "wss://api.example.test:8443/v1/tts?model=one"));
  for (const [provider, purpose, endpoint] of [
    ["fish", "speech_input", "wss://api.example.test:8443/asr"],
    ["sarvam", "speech_output", "wss://api.example.test:8443/tts"],
    ["fish", "speech_output", "wss://other.example.test:8443/tts"],
  ] as const) assert.throws(() => assertHostedEgress(policy, provider, purpose, endpoint), /blocked/);
  assert.throws(() => assertHostedEgress(policy, "fish", "speech_output", "wss://user:secret@api.example.test:8443"), /invalid/);
  assert.throws(() => assertHostedEgress({ allows: () => { throw new Error("error"); } }, "fish", "speech_output", "wss://api.example.test:8443"), /blocked/);
});

test("cleartext hosted transports are limited to literal loopback fixtures", () => {
  const allow: HostedEgressPolicy = { allows: () => true };
  for (const endpoint of ["http://api.example.test/v1", "ws://api.example.test/v1", "http://localhost:9999/v1"]) {
    assert.throws(() => assertHostedEgress(allow, "sarvam", "conversation", endpoint), /invalid/);
  }
  for (const endpoint of ["http://127.0.0.1:9999/v1", "ws://[::1]:9999/v1", "https://api.example.test/v1", "wss://api.example.test/v1"]) {
    assert.doesNotThrow(() => assertHostedEgress(allow, "sarvam", "conversation", endpoint));
  }
});
