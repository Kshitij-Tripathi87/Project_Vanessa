const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildReadinessConfig } = require("./readiness-config.cjs");

const root = process.cwd();

test("readiness uses the same no-key local defaults as the launcher", () => {
  const config = buildReadinessConfig({}, root, () => false);
  assert.equal(config.asrProvider, "whisper");
  assert.equal(config.ttsProvider, "fish");
  assert.equal(config.plannerProvider, "ollama");
  assert.equal(config.conversationProvider, "ollama");
  assert.equal(config.usesLocalAsr, true);
  assert.equal(config.localAsrUrl, "ws://127.0.0.1:4505/");
  assert.equal(config.ttsFallback, true);
  assert.deepEqual(config.missing, []);
});

test("readiness follows explicitly selected hosted providers without inventing local ASR", () => {
  const env = {
    VOICE_ASR_PROVIDER: "sarvam",
    VOICE_TTS_PROVIDER: "sarvam",
    PLANNER_PROVIDER: "sarvam",
    CONVERSATION_PROVIDER: "sarvam",
    SARVAM_API_KEY: "test-only-key",
    SARVAM_CHAT_MODEL: "test-chat",
    SARVAM_ASR_MODEL: "saaras:v3-realtime",
    SARVAM_TTS_MODEL: "bulbul:v4-flash",
    SARVAM_TTS_SPEAKER: "test-speaker",
  };
  const config = buildReadinessConfig(env, root, () => false);
  assert.equal(config.asrProvider, "sarvam");
  assert.equal(config.ttsProvider, "sarvam");
  assert.equal(config.plannerProvider, "sarvam");
  assert.equal(config.conversationProvider, "sarvam");
  assert.equal(config.usesLocalAsr, false);
  assert.deepEqual(config.missing, []);
});

test("readiness keeps planner and conversation provider selection independent", () => {
  const env = {
    PLANNER_PROVIDER: "nvidia",
    CONVERSATION_PROVIDER: "ollama",
    NVIDIA_API_KEY: "test-nvidia-key",
    OLLAMA_MODEL: "qwen2.5:3b",
  };
  const config = buildReadinessConfig(env, root, () => false);
  assert.equal(config.plannerProvider, "nvidia");
  assert.equal(config.conversationProvider, "ollama");
  assert.equal(config.usesLocalAsr, true);
  assert.deepEqual(config.missing, []);
});

test("invalid provider selections fail configuration instead of being reported as healthy defaults", () => {
  assert.throws(() => buildReadinessConfig({ PLANNER_PROVIDER: "unknown-provider" }, root, () => false), /Unsupported planning provider/);
});

test("readiness respects a configured local ASR endpoint", () => {
  const env = { VOICE_URL: "ws://127.0.0.1:4601" };
  const config = buildReadinessConfig(env, root, () => false);
  assert.equal(config.usesLocalAsr, true);
  assert.equal(config.localAsrUrl, "ws://127.0.0.1:4601/");
});
