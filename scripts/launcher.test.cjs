const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { launcherConfig } = require('./launcher-config.cjs');
const { ensureService } = require('./launch-vanessa.cjs');
const root = process.cwd();
const config = (env = {}, args = [], files = []) => launcherConfig(env, args, root, p => files.some(file => p === path.resolve(root, file)));

test('full Sarvam stack needs no Gemini or Fish credentials and rejects placeholders', () => {
  const env = { PLANNER_PROVIDER: 'sarvam', VOICE_ASR_PROVIDER: 'sarvam', VOICE_TTS_PROVIDER: 'sarvam', SARVAM_API_KEY: 'test-only-key', SARVAM_CHAT_MODEL: 'test-model', SARVAM_ASR_MODEL: 'saaras:v3-realtime', SARVAM_TTS_MODEL: 'bulbul:v4-flash', SARVAM_TTS_SPEAKER: 'test-speaker' };
  assert.deepEqual(config(env, ['--codex-test']).missing, []);
  assert(config({ ...env, SARVAM_TTS_MODEL: 'YOUR_SARVAM_TTS_MODEL' }).missing.some(item => item.includes('SARVAM_TTS_MODEL')));
  assert.throws(() => config({ ...env, SARVAM_API_KEY: 'YOUR_SARVAM_API_KEY' }, ['--codex-test']), /SARVAM_API_KEY/);
});

test('Sarvam is switchable and validates its key independently of Fish TTS', () => {
  const env = { NVIDIA_API_KEY: 'test', VOICE_ASR_PROVIDER: 'sarvam', SARVAM_API_KEY: 'test', SARVAM_ASR_MODEL: 'saaras:v3-realtime', VOICE_TTS_FALLBACK_PROVIDER: 'browser' };
  assert.deepEqual(config(env, ['--codex-test']).missing, []);
  assert.equal(config(env).localAsr, undefined);
  assert.throws(() => config({ ...env, SARVAM_API_KEY: '' }, ['--codex-test']), /SARVAM_API_KEY/);
  assert(config({ ...env, VOICE_TTS_FALLBACK_PROVIDER: 'none' }).missing.some(key => key.includes('FISH_API_KEY')));
  assert.equal(config({ ...env, VOICE_ASR_PROVIDER: 'fish', FISH_API_KEY: 'test' }).asr, 'fish');
});

test('ordinary launch and text-only do not require Fish or Codex-specific credentials', () => {
  assert(config().missing.length > 0);
  const text = config({ NVIDIA_API_KEY: 'test' }, ['--text-only', '--codex-test']);
  assert.equal(text.voice, false);
  assert.deepEqual(text.missing, []);
  assert.throws(() => config({}, ['--codex-test']), /configuration missing/);
});

test('planner and conversation providers are independent and require only their selected credentials', () => {
  const both = {
    PLANNER_PROVIDER: 'nvidia', SARVAM_CHAT_PROVIDER: 'sarvam',
    NVIDIA_API_KEY: 'test-nvidia-key', SARVAM_API_KEY: 'test-sarvam-key', SARVAM_CHAT_MODEL: 'test-model',
  };
  const mixed = config(both, ['--text-only', '--codex-test']);
  assert.equal(mixed.planner, 'nvidia');
  assert.equal(mixed.conversation, 'sarvam');
  assert.deepEqual(mixed.missing, []);
  assert.throws(() => config({ ...both, NVIDIA_API_KEY: '' }, ['--text-only', '--codex-test']), /NVIDIA_API_KEY/);
  assert.throws(() => config({ ...both, SARVAM_API_KEY: '' }, ['--text-only', '--codex-test']), /SARVAM_API_KEY/);
  const sarvamOnly = config({ SARVAM_CHAT_PROVIDER: 'sarvam', SARVAM_API_KEY: 'test', SARVAM_CHAT_MODEL: 'model' }, ['--text-only', '--codex-test']);
  assert.equal(sarvamOnly.planner, 'sarvam');
  assert.equal(sarvamOnly.conversation, 'sarvam');
  const nvidiaOnly = config({ PLANNER_PROVIDER: ' NVIDIA ', NVIDIA_API_KEY: 'test' }, ['--text-only', '--codex-test']);
  assert.equal(nvidiaOnly.planner, 'nvidia');
  assert.equal(nvidiaOnly.conversation, 'nvidia');
});

test('provider selection rejects unsupported values and placeholders before startup', () => {
  for (const provider of ['typo', 'gemini']) {
    assert.throws(() => config({ PLANNER_PROVIDER: provider }, ['--text-only']), /Unsupported planning provider/);
    assert.throws(() => config({ PLANNER_PROVIDER: 'nvidia', SARVAM_CHAT_PROVIDER: provider }, ['--text-only']), /Unsupported conversation provider/);
  }
  assert.throws(() => config({ NVIDIA_API_KEY: 'nvapi-placeholder-key' }, ['--text-only', '--codex-test']), /NVIDIA_API_KEY/);
});
test('selects existing providers without Fish requirements for ElevenLabs', () => {
  const result = config({ NVIDIA_API_KEY: 'test', VOICE_ASR_PROVIDER: 'elevenlabs', VOICE_TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'test', ELEVENLABS_VOICE_ID: 'voice' });
  assert.deepEqual(result.missing, []);
  assert.equal(result.localAsr, undefined);
  assert.throws(() => config({ VOICE_ASR_PROVIDER: 'typo' }), /Unsupported/);
});
test('restores local server selection with current and legacy environment paths', () => {
  const env = { VOICE_ASR_PROVIDER: 'whisper', WHISPER_URL: 'ws://127.0.0.1:4510' };
  const current = config(env, [], ['.venv-voice/Scripts/python.exe', 'services/voice-agent/voice_server.py']);
  assert.equal(current.localAsr.port, 4510);
  assert(current.localAsr.python.endsWith(path.normalize('.venv-voice/Scripts/python.exe')));
  const legacy = config(env, [], ['.venv-whisper/Scripts/python.exe', 'services/voice-agent/whisper_server.py']);
  assert(legacy.localAsr.script.endsWith('whisper_server.py'));
  assert(config({ VOICE_ALLOW_FALLBACK: 'true' }).localAsr);
  assert.equal(config({ VOICE_ASR_PROVIDER: 'voice', VOICE_URL: 'ws://other-host:4505' }).localAsr.local, false);
  assert.equal(config(env, ['--text-only']).localAsr, undefined);
});
test('options are explicit and real Codex tests reject simulation', () => {
  assert.throws(() => config({}, ['--typo']), /Unknown/);
  assert.throws(() => config({ NVIDIA_API_KEY: 'test', FAKE: '1' }, ['--text-only', '--codex-test']), /FAKE/);
  assert(config({}, ['--dev', '--reuse-existing']).dev);
  assert(config({}, ['--dev', '--reuse-existing']).reuse);
});
test('reuse verifies service identity; an unrelated listener is never accepted', async () => {
  let identity = 'vanessa-orchestrator';
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: identity })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  let starts = 0;
  try {
    await ensureService('Test', `http://127.0.0.1:${port}/health`, 'vanessa-orchestrator', port, true, () => starts++);
    assert.equal(starts, 0);
    identity = 'unrelated';
    await assert.rejects(ensureService('Test', `http://127.0.0.1:${port}/health`, 'vanessa-orchestrator', port, true, () => starts++), /Port .* unavailable/);
    assert.equal(starts, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Sarvam STT, TTS and chat can run without Gemini or Fish credentials', () => {
  const env = {
    VOICE_ASR_PROVIDER: 'sarvam',
    VOICE_TTS_PROVIDER: 'sarvam',
    SARVAM_API_KEY: 'test-sarvam-key',
    SARVAM_ASR_MODEL: 'saaras:v3-realtime',
    SARVAM_TTS_MODEL: 'bulbul:v4-flash',
    SARVAM_TTS_SPEAKER: 'shubh_enhi_ads',
    SARVAM_CHAT_PROVIDER: 'sarvam',
    PLANNER_PROVIDER: 'sarvam',
    SARVAM_CHAT_MODEL: 'sarvam-105b-conversations',
  };
  const result = config(env, ['--codex-test']);
  assert.deepEqual(result.missing, []);
  assert.equal(result.asr, 'sarvam');
  assert.equal(result.tts, 'sarvam');
});

test('Sarvam launcher rejects missing TTS persona/model instead of starting a silent voice path', () => {
  const base = {
    VOICE_ASR_PROVIDER: 'sarvam',
    VOICE_TTS_PROVIDER: 'sarvam',
    SARVAM_API_KEY: 'test-sarvam-key',
    SARVAM_ASR_MODEL: 'saaras:v3-realtime',
    SARVAM_CHAT_PROVIDER: 'sarvam',
    PLANNER_PROVIDER: 'sarvam',
    SARVAM_CHAT_MODEL: 'sarvam-105b-conversations',
  };
  assert(config(base).missing.some(key => key.includes('SARVAM_TTS_MODEL')));
  assert(config(base).missing.some(key => key.includes('SARVAM_TTS_SPEAKER')));
});
