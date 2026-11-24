import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLocalVoiceUrl, VoiceAdapter } from "../asr/voiceAdapter.js";
import { BrowserTtsAdapter } from "../tts/browserTts.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";
import { validateFishConfiguration } from "../server.js";

test("ambient local ASR rejects remote URLs, paths, credentials and redirects by configuration", () => {
  assert.equal(normalizeLocalVoiceUrl("ws://localhost:4505"), "ws://127.0.0.1:4505/");
  assert.equal(normalizeLocalVoiceUrl("ws://[::1]:4505"), "ws://[::1]:4505/");
  for (const value of ["wss://remote.example", "ws://remote.example:4505", "ws://192.168.1.8:4505", "ws://user:secret@127.0.0.1:4505", "ws://127.0.0.1:4505/path", "ws://127.0.0.1:4505/?token=x", "ws://127.0.0.1:4505/#fragment"]) {
    assert.throws(() => normalizeLocalVoiceUrl(value), /loopback/i, value);
    assert.throws(() => new VoiceAdapter(value), /loopback/i, value);
  }
});

test("local speech adapter emits text for the desktop and respects a pre-aborted call", async () => {
  const adapter = new BrowserTtsAdapter();
  const chunks: unknown[] = [];
  await adapter.streamSpeech("Hello locally.", (chunk) => chunks.push(chunk));
  assert.deepEqual(chunks, [{ chunkIndex: 0, text: "Hello locally.", isFinal: true, fallbackSpeech: true }]);
  await assert.rejects(adapter.streamSpeech("Do not emit", () => assert.fail("aborted"), AbortSignal.abort()));
});

test("default voice remains local even when unrelated hosted credentials are present", async () => {
  const keys = ["VOICE_ASR_PROVIDER", "VOICE_TTS_PROVIDER", "VOICE_PROVIDER", "VOICE_URL", "WHISPER_URL", "FISH_API_KEY", "FISH_TTS_VOICE_ID", "ELEVENLABS_API_KEY"];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  const fetchBefore = globalThis.fetch;
  let networkCalls = 0;
  try {
    for (const key of keys) delete process.env[key];
    process.env.FISH_API_KEY = "sk-fish-test-only";
    process.env.FISH_TTS_VOICE_ID = "test-only";
    process.env.ELEVENLABS_API_KEY = "sk_test_only";
    globalThis.fetch = (async () => { networkCalls++; throw new Error("Unexpected hosted call"); }) as typeof fetch;
    const chunks: unknown[] = [];
    const session = new VanessaVoiceSession({ handlers: { onAudioChunkOut: (chunk) => chunks.push(chunk) } });
    assert.equal(session.getProviderInfo().tts.requested, "On-device speech");
    assert.equal(session.getProviderInfo().asr.requested, "Local Whisper");
    assert.equal(validateFishConfiguration().valid, true);
    await session.speak("Private test text.");
    assert.deepEqual(chunks, [{ chunkIndex: 0, text: "Private test text.", isFinal: true, fallbackSpeech: true }]);
    assert.equal(networkCalls, 0);
    session.stop();
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("hosted voice selection and keys do not authorize audio or text egress", () => {
  const keys = ["VOICE_ASR_PROVIDER", "VOICE_TTS_PROVIDER", "VOICE_PROVIDER", "FISH_API_KEY", "FISH_TTS_VOICE_ID", "FISH_ASR_URL", "FISH_TTS_URL"];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      VOICE_ASR_PROVIDER: "fish", VOICE_TTS_PROVIDER: "fish", FISH_API_KEY: "sk-fish-test-only",
      FISH_TTS_VOICE_ID: "test-only", FISH_ASR_URL: "ws://127.0.0.1:12441/asr", FISH_TTS_URL: "ws://127.0.0.1:12442/tts",
    });
    delete process.env.VOICE_PROVIDER;
    assert.throws(() => new VanessaVoiceSession(), /separate scoped user permission/);
    const result = validateFishConfiguration();
    assert.equal(result.valid, false);
    assert(result.errors.some((error) => /speech_input.*scoped user permission/.test(error)));
    assert(result.errors.some((error) => /speech_output.*scoped user permission/.test(error)));
    assert.throws(() => new VanessaVoiceSession({ hostedEgressPolicy: {
      allows: ({ provider, purpose, origin }) => provider === "fish" && purpose === "speech_input" && origin === "ws://127.0.0.1:12441",
    } }), /speech_output.*scoped user permission/);
    const session = new VanessaVoiceSession({ hostedEgressPolicy: {
      allows: ({ provider, purpose, origin }) => provider === "fish" && (
        (purpose === "speech_input" && origin === "ws://127.0.0.1:12441") ||
        (purpose === "speech_output" && origin === "ws://127.0.0.1:12442")
      ),
    } });
    session.stop();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("non-loopback local ASR is reported unavailable before any listening session", () => {
  const beforeAsr = process.env.VOICE_ASR_PROVIDER;
  const beforeUrl = process.env.VOICE_URL;
  try {
    process.env.VOICE_ASR_PROVIDER = "whisper";
    process.env.VOICE_URL = "ws://remote.example:4505";
    const result = validateFishConfiguration();
    assert.equal(result.valid, false);
    assert(result.errors.some((error) => /loopback/i.test(error)));
    assert.throws(() => new VanessaVoiceSession(), /loopback/i);
  } finally {
    if (beforeAsr === undefined) delete process.env.VOICE_ASR_PROVIDER; else process.env.VOICE_ASR_PROVIDER = beforeAsr;
    if (beforeUrl === undefined) delete process.env.VOICE_URL; else process.env.VOICE_URL = beforeUrl;
  }
});
