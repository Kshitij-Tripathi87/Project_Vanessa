import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOrchestratorRuntimeUrls,
  resolveOrchestratorHttpUrl,
  resolveOrchestratorPort,
  resolveOrchestratorWebSocketUrl,
  resolveVoiceAgentPort,
} from "./runtimeConfig.js";

test("packaged runtime defaults match the orchestrator and voice-agent servers", () => {
  assert.equal(resolveOrchestratorPort({}), 4319);
  assert.equal(resolveVoiceAgentPort({}), 4500);
  assert.equal(resolveOrchestratorHttpUrl({}), "http://127.0.0.1:4319");
  assert.equal(resolveOrchestratorWebSocketUrl({}), "ws://127.0.0.1:4319/events");
});

test("orchestrator port honors explicit valid per-user settings", () => {
  assert.equal(resolveOrchestratorPort({ VANESSA_PORT: "4421" }), 4421);
});

test("voice port rejects unsupported overrides that the renderer cannot reach", () => {
  assert.equal(resolveVoiceAgentPort({}), 4500);
  assert.throws(
    () => resolveVoiceAgentPort({ VOICE_AGENT_PORT: "4521" }),
    /VOICE_AGENT_PORT must be 4500/,
  );
});

test("invalid runtime ports fail before spawning child processes", () => {
  for (const value of ["abc", "0", "65536", "4319.5"]) {
    assert.throws(() => resolveOrchestratorPort({ VANESSA_PORT: value }), /VANESSA_PORT/);
  }
});

test("HTTP and WebSocket overrides are validated and resolved independently", () => {
  assert.equal(
    resolveOrchestratorHttpUrl({ ORCHESTRATOR_URL: "http://127.0.0.1:5123/path/ignored" }),
    "http://127.0.0.1:5123",
  );
  assert.equal(
    resolveOrchestratorWebSocketUrl({ ORCHESTRATOR_URL: "https://vanessa.local:5123" }),
    "wss://vanessa.local:5123/events",
  );
  assert.equal(
    resolveOrchestratorWebSocketUrl({ ORCHESTRATOR_WS: "ws://127.0.0.1:6123/events" }),
    "ws://127.0.0.1:6123/events",
  );
  assert.throws(() => resolveOrchestratorHttpUrl({ ORCHESTRATOR_URL: "file:///tmp/api" }), /http or https/);
  assert.throws(() => resolveOrchestratorWebSocketUrl({ ORCHESTRATOR_WS: "http://127.0.0.1:4319" }), /ws or wss/);
});


test("voice-agent orchestrator clients receive the same resolved endpoint", () => {
  const env = { VANESSA_PORT: "4421" };
  const resolved = applyOrchestratorRuntimeUrls(env);
  assert.equal(resolved, "http://127.0.0.1:4421");
  assert.equal(env.ORCHESTRATOR_URL, resolved);
  assert.equal(env.VANESSA_ORCHESTRATOR_URL, resolved);
});

test("explicit orchestrator URL is propagated to both voice-agent clients", () => {
  const env = { ORCHESTRATOR_URL: "http://127.0.0.1:5123" };
  const resolved = applyOrchestratorRuntimeUrls(env);
  assert.equal(resolved, "http://127.0.0.1:5123");
  assert.equal(env.ORCHESTRATOR_URL, resolved);
  assert.equal(env.VANESSA_ORCHESTRATOR_URL, resolved);
});
