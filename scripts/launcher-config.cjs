const path = require('node:path');

function launcherConfig(env, args, root, exists) {
  const supported = new Set(['--help', '--check', '--build-only', '--text-only', '--dev', '--reuse-existing', '--codex-test']);
  for (const arg of args) if (!supported.has(arg)) throw new Error(`Unknown launcher option: ${arg}. Use --help.`);
  const voice = !args.includes('--text-only');
  const strict = args.includes('--codex-test');
  const asr = (env.VOICE_ASR_PROVIDER || 'fish').trim().toLowerCase();
  const tts = (env.VOICE_TTS_PROVIDER || env.VOICE_PROVIDER || 'fish').trim().toLowerCase();
  const planner = (env.SARVAM_CHAT_PROVIDER || env.PLANNER_PROVIDER || 'gemini').trim().toLowerCase();
  if (voice && !['fish', 'voice', 'whisper', 'elevenlabs', 'sarvam'].includes(asr)) throw new Error(`Unsupported VOICE_ASR_PROVIDER: ${asr}`);
  if (voice && !['fish', 'elevenlabs', 'sarvam'].includes(tts)) throw new Error(`Unsupported VOICE_TTS_PROVIDER: ${tts}`);
  const missing = [];
  const addMissing = (item) => { if (!missing.includes(item)) addMissing(item); };
  const configured = (value) => Boolean(value?.trim()) && !/placeholder|replace[-_ ]with|your[_-]/i.test(value);
  if (planner !== 'sarvam' && !env.GEMINI_API_KEY?.trim()) addMissing('GEMINI_API_KEY (planning unavailable)');
  if (planner === 'sarvam') {
    if (!configured(env.SARVAM_API_KEY)) addMissing('SARVAM_API_KEY (Sarvam planning unavailable)');
    if (!configured(env.SARVAM_CHAT_MODEL)) addMissing('SARVAM_CHAT_MODEL (Sarvam planning unavailable)');
  }
  if (voice) {
    if (asr === 'sarvam' && !configured(env.SARVAM_API_KEY)) addMissing('SARVAM_API_KEY (recognition unavailable)');
    if (asr === 'sarvam' && !configured(env.SARVAM_ASR_MODEL)) addMissing('SARVAM_ASR_MODEL (recognition unavailable)');
    if (asr === 'fish' && !env.FISH_API_KEY?.trim() && env.VOICE_ALLOW_FALLBACK !== 'true') addMissing('FISH_API_KEY (recognition unavailable)');
    if (asr === 'elevenlabs' && !env.ELEVENLABS_API_KEY?.trim()) addMissing('ELEVENLABS_API_KEY (recognition unavailable)');
    if (tts === 'fish' && env.VOICE_TTS_FALLBACK_PROVIDER !== 'browser') {
      if (!env.FISH_API_KEY?.trim()) addMissing('FISH_API_KEY (speech output unavailable)');
      if (!(env.FISH_TTS_VOICE_ID || env.FISH_VANESSA_VOICE_ID)?.trim()) addMissing('FISH_TTS_VOICE_ID (speech output unavailable)');
    }
    if (tts === 'elevenlabs') {
      if (!env.ELEVENLABS_API_KEY?.trim()) addMissing('ELEVENLABS_API_KEY (speech output unavailable)');
      if (!env.ELEVENLABS_VOICE_ID?.trim()) addMissing('ELEVENLABS_VOICE_ID (speech output unavailable)');
    }
    if (tts === 'sarvam') {
      if (!configured(env.SARVAM_API_KEY)) addMissing('SARVAM_API_KEY (speech output unavailable)');
      if (!configured(env.SARVAM_TTS_MODEL)) addMissing('SARVAM_TTS_MODEL (speech output unavailable)');
      if (!configured(env.SARVAM_TTS_SPEAKER)) addMissing('SARVAM_TTS_SPEAKER (speech output unavailable)');
    }
  }
  if (strict && missing.length) throw new Error(`Codex test configuration missing: ${missing.join(', ')}`);
  if (strict && env.FAKE === '1') throw new Error('Disable FAKE=1 for a real Codex test.');
  let localAsr;
  if (voice && (['voice', 'whisper'].includes(asr) || (asr === 'fish' && env.VOICE_ALLOW_FALLBACK === 'true'))) {
    const url = new URL(env.VOICE_URL || env.WHISPER_URL || 'ws://127.0.0.1:4505');
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('VOICE_URL/WHISPER_URL must use ws:// or wss://.');
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
    localAsr = { url: url.href, local, port: Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) };
    if (local) {
      if (url.protocol !== 'ws:' || url.pathname !== '/' || url.search || url.username || url.password) throw new Error('Managed local Whisper requires ws://localhost:PORT or ws://127.0.0.1:PORT without a path or credentials.');
      const choose = (candidates) => candidates.map((item) => path.resolve(root, item)).find(exists);
      localAsr.python = choose([env.VOICE_PYTHON, '.venv-voice/Scripts/python.exe', '.venv-whisper/Scripts/python.exe'].filter(Boolean));
      localAsr.script = choose(['services/voice-agent/voice_server.py', 'services/voice-agent/whisper_server.py']);
    }
  }
  return { voice, strict, asr, tts, missing, localAsr, dev: args.includes('--dev'), reuse: args.includes('--reuse-existing') };
}

module.exports = { launcherConfig };
