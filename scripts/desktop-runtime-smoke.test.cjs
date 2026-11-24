const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { evaluateInRenderer, historyProbeExpression } = require('./desktop-runtime-smoke.cjs');
const { startFixtures, fixtureEnvironment, FIXTURE_MODEL } = require('./desktop-runtime-fixtures.cjs');

test('renderer smoke transport waits for the matching evaluation response', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      assert.equal(request.method, 'Runtime.evaluate');
      assert.equal(request.params.awaitPromise, true);
      socket.send(JSON.stringify({ id: 99, result: { result: { value: false } } }));
      socket.send(JSON.stringify({ id: 1, result: { result: { value: true } } }));
    });
  });
  try {
    assert.equal(await evaluateInRenderer(`ws://127.0.0.1:${server.address().port}` , 'true'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('renderer smoke probes are synthetic and reject unknown phases', () => {
  assert.throws(() => historyProbeExpression('bad', true, true), /Invalid runtime smoke phase/);
  const write = historyProbeExpression('write', true, true);
  const verify = historyProbeExpression('verify', true, true);
  assert.match(write, /Synthetic desktop persistence smoke test/);
  assert.match(verify, /clearConversationHistory/);
  assert.doesNotMatch(write, /executeCommand\(/);
});

test('runtime smoke uses only loopback fixtures and detects unexpected model tasks', async () => {
  const fixtures = await startFixtures();
  try {
    const env = fixtureEnvironment({ SARVAM_API_KEY: 'real-secret', VOICE_PROVIDER: 'fish', PLANNER_PROVIDER: 'nvidia' }, fixtures, '/isolated-profile');
    assert.equal(env.SARVAM_API_KEY, undefined);
    assert.equal(env.VOICE_PROVIDER, undefined);
    assert.equal(env.PLANNER_PROVIDER, 'ollama');
    assert.equal(env.VOICE_ASR_PROVIDER, 'whisper');
    assert.equal(env.VOICE_TTS_PROVIDER, 'browser');
    assert.equal(env.VANESSA_CONFIG_HOME, '/isolated-profile');
    const response = await fetch(fixtures.ollamaUrl + '/api/tags');
    assert.deepEqual(await response.json(), { models: [{ name: FIXTURE_MODEL }] });
    const socket = new WebSocket(fixtures.asrUrl);
    await once(socket, 'open');
    socket.close();
    await once(socket, 'close');
    fixtures.assertNoTasks();
    assert.equal((await fetch(fixtures.ollamaUrl + '/api/generate', { method: 'POST' })).status, 501);
    assert.throws(() => fixtures.assertNoTasks(), /unexpected task or audio/);
  } finally { await fixtures.close(); }
});
