/* Test-only loopback fixtures for the Windows Electron runtime smoke.
 * No real provider, model download, microphone or PC task is used. */
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const FIXTURE_MODEL = 'vanessa-smoke-fixture';
const root = path.resolve(__dirname, '..');

async function startFixtures() {
  const unexpected = [];
  const ollama = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: FIXTURE_MODEL }] }));
    } else {
      unexpected.push('unexpected model request');
      res.writeHead(501); res.end();
    }
  });
  const asr = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  try {
    await once(asr, 'listening');
    ollama.listen(0, '127.0.0.1');
    await once(ollama, 'listening');
  } catch (error) {
    asr.close(); ollama.close();
    throw error;
  }
  asr.on('connection', (socket) => {
    socket.on('message', () => { unexpected.push('unexpected audio or ASR control'); });
  });
  const result = {
    ollamaUrl: `http://127.0.0.1:${ollama.address().port}`,
    asrUrl: `ws://127.0.0.1:${asr.address().port}`,
    assertNoTasks() {
      if (unexpected.length) throw new Error('The runtime smoke attempted an unexpected task or audio request.');
    },
    async close() {
      for (const socket of asr.clients) socket.terminate();
      ollama.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => asr.close(resolve)),
        new Promise((resolve) => ollama.close(resolve)),
      ]);
    },
  };
  return result;
}

function fixtureEnvironment(original, fixtures, configHome) {
  const env = { ...original };
  // Never inherit live provider credentials or a user's existing profile.
  for (const key of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
  }
  for (const key of ['VOICE_PROVIDER', 'SARVAM_CHAT_PROVIDER', 'VITE_DEV_SERVER_URL', 'VANESSA_INSTALLED_MODE']) delete env[key];
  return Object.assign(env, {
    VANESSA_CONFIG_HOME: configHome,
    VANESSA_WORKSPACE_ROOT: root,
    VANESSA_SKIP_DOTENV: 'true',
    VANESSA_PORT: '4319', VOICE_AGENT_PORT: '4500',
    VANESSA_RUNTIME_SMOKE_DEBUG_PORT: '9222',
    PLANNER_PROVIDER: 'ollama', CONVERSATION_PROVIDER: 'ollama',
    OLLAMA_BASE_URL: fixtures.ollamaUrl, OLLAMA_MODEL: FIXTURE_MODEL,
    VOICE_ASR_PROVIDER: 'whisper', VOICE_TTS_PROVIDER: 'browser',
    VOICE_URL: fixtures.asrUrl, VOICE_WAKE_WORD_ENABLED: 'false',
    VOICE_STRICT_CONFIG: 'true', FAKE: '1',
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The Electron runtime smoke runs on Windows.');
  const configHome = mkdtempSync(path.join(tmpdir(), 'vanessa-runtime-smoke-'));
  let fixtures;
  try {
    fixtures = await startFixtures();
    const child = spawn(process.execPath, [path.join(root, 'scripts/launch-vanessa.cjs'), '--runtime-smoke'], {
      cwd: root, env: fixtureEnvironment(process.env, fixtures, configHome), stdio: 'inherit', windowsHide: true,
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });
    fixtures.assertNoTasks();
    if (code !== 0) throw new Error(`Desktop runtime smoke failed (exit ${code ?? 'signal'}).`);
  } finally {
    if (fixtures) await fixtures.close();
    rmSync(configHome, { recursive: true, force: true });
  }
}

module.exports = { startFixtures, fixtureEnvironment, FIXTURE_MODEL };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
