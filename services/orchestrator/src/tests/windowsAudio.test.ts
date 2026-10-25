import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePowerShellSteps } from '../agents/powershell-executor.js';
import { executeWindowsAudio, windowsAudioCommand, windowsAudioHelperPath } from '../agents/windows-audio.js';
import { WindowsAgent } from '../agents/windows.agent.js';
import { runWindowsAudioSmoke } from '../scripts/windows-audio-smoke.js';
import type { WindowsAudioRequest, WindowsAudioResult } from '../agents/windows-audio.js';

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
test('helper command uses module-relative absolute asset path and JSON request data', () => {
  const command = windowsAudioCommand({ operation: 'setMute', muted: false, expectedDeviceId: "device ' quote" });
  assert.ok(command.includes(quote(windowsAudioHelperPath)));
  assert.ok(command.includes('"muted":false'));
  assert.ok(command.includes("device '' quote"));
});

test('Windows handler reports mocked readback and API failures honestly', async () => {
  const calls: unknown[] = [];
  const agent = new WindowsAgent(async request => {
    calls.push(request);
    return { success: false, requested: { volumePercent: 30 }, observed: { volumePercent: 55, muted: false },
      device: { id: 'fake', flow: 'render', role: 'multimedia', currentDefaultId: 'fake' },
      error: { code: 'readback_mismatch', message: 'Mock readback mismatch' } };
  });
  const result = await agent.execute('volume.set', { level: 30 });
  assert.equal(result.success, false);
  assert.equal(result.verification?.passed, false);
  assert.match(result.summary ?? '', /failed.*Mock readback mismatch/);
  assert.deepEqual(calls, [{ operation: 'setVolume', volumePercent: 30 }]);
  await agent.execute('volume.mute', { muted: false });
  await agent.execute('volume.get', {});
  assert.deepEqual(calls.slice(1), [{ operation: 'setMute', muted: false }, { operation: 'get' }]);
});

test('audio wrapper preserves API errors and rejects launch errors, malformed and interrupted success', async () => {
  const failure = { success: false, requested: { muted: true }, observed: null, device: null,
    error: { code: 'api_failure', message: 'Mock setter failed', hresult: '0x80004005' } };
  const batch = (stdout: string, success = false) => ({ success, timedOut: false,
    steps: [{ id: 'windows-audio', status: 'failed' as const, stdout, stderr: 'mock error', durationMs: 1 }] });
  const result = await executeWindowsAudio({ operation: 'setMute', muted: true }, async () => batch(JSON.stringify(failure)));
  assert.deepEqual(result, failure);
  const launch = await executeWindowsAudio({ operation: 'get' }, async () => { throw new Error('Mock process launch failed'); });
  assert.equal(launch.success, false);
  assert.match(launch.error!.message, /launch failed/);
  for (const stdout of ['not JSON', '{}', '{"success":true}', '{"success":true,"observed":{"volumePercent":30,"muted":false},"device":{"id":"fake"}}']) {
    assert.equal((await executeWindowsAudio({ operation: 'get' }, async () => batch(stdout))).success, false);
  }
});

test('smoke CLI mocks save/restore, explicit mute, original device, and validation without real mutations', async () => {
  const initial: WindowsAudioResult = { success: true, requested: null, observed: { volumePercent: 42.25, muted: true },
    device: { id: 'original-device', currentDefaultId: 'original-device', flow: 'render', role: 'multimedia' }, error: null };
  const calls: WindowsAudioRequest[] = [];
  let saved = '';
  const dependencies = {
    execute: async (request: WindowsAudioRequest) => { calls.push(request); return initial; },
    read: async () => saved,
    save: async (_path: string, contents: string) => { saved = contents; },
  };
  await runWindowsAudioSmoke(['get', 'initial.json'], dependencies);
  assert.deepEqual(JSON.parse(saved), initial);
  await runWindowsAudioSmoke(['set-volume', '30', 'initial.json'], dependencies);
  await runWindowsAudioSmoke(['set-mute', 'true', 'initial.json'], dependencies);
  await runWindowsAudioSmoke(['set-mute', 'false', 'initial.json'], dependencies);
  const restored = await runWindowsAudioSmoke(['restore', 'initial.json'], dependencies);
  assert.equal(restored.success, true);
  assert.deepEqual(calls, [
    { operation: 'get' },
    { operation: 'setVolume', volumePercent: 30, expectedDeviceId: 'original-device' },
    { operation: 'setMute', muted: true, expectedDeviceId: 'original-device' },
    { operation: 'setMute', muted: false, expectedDeviceId: 'original-device' },
    { operation: 'setVolume', volumePercent: 42.25, expectedDeviceId: 'original-device' },
    { operation: 'setMute', muted: true, expectedDeviceId: 'original-device' },
  ]);
  for (const args of [['set-mute', '0', 'initial.json'], ['set-volume', '101', 'initial.json'], ['set-volume', '', 'initial.json'], ['bad']]) {
    await assert.rejects(runWindowsAudioSmoke(args, dependencies));
  }
  assert.equal(calls.length, 6);
  const failure = { ...initial, success: false, error: { code: 'api_failure', message: 'mock' } };
  const attempts: WindowsAudioRequest[] = [];
  const failedRestore = await runWindowsAudioSmoke(['restore', 'initial.json'], {
    ...dependencies, execute: async request => { attempts.push(request); return failure; },
  });
  assert.equal(failedRestore.success, false);
  assert.equal(attempts.length, 2);
});

test('Windows: actual PowerShell helper policy with mocked audio device; no real mutations', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vanessa-audio-test-'));
  try {
    const helpers = join(dir, "helper assets with spaces and 'quote");
    const cwd = join(dir, 'different working directory');
    await mkdir(cwd);
    await cp(fileURLToPath(new URL('../agents/windows-audio/', import.meta.url)), helpers, { recursive: true });
    const fixture = fileURLToPath(new URL('./fixtures/WindowsAudioMock.cs', import.meta.url));
    const batch = await executePowerShellSteps({ workingDirectory: cwd, steps: [
      { id: 'mocked-audio', command: `$audioSource = [IO.File]::ReadAllText(${quote(join(helpers, 'CoreAudio.cs'))}) + [IO.File]::ReadAllText(${quote(fixture)})
Add-Type -TypeDefinition $audioSource -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll' -ErrorAction Stop
[Vanessa.WindowsAudio.MockTests]::Run() | ConvertTo-Json -Compress` },
    ] });
    assert.equal(batch.success, true, JSON.stringify(batch));
    const report = JSON.parse(batch.steps[0].stdout.trim());
    assert.ok(report.mockedChecks >= 25);
    assert.equal(report.realMutations, 0);
    // Invalid requests terminate the step before constructing a real Core Audio device.
    const invalid = await executePowerShellSteps({ workingDirectory: cwd, steps: [
      { id: 'invalid', command: windowsAudioCommand({ operation: 'setVolume', volumePercent: 101 }).replace(quote(windowsAudioHelperPath), quote(join(helpers, 'CoreAudio.cs'))) },
      { id: 'skipped', command: "'must not run'" },
    ] });
    assert.equal(invalid.success, false);
    assert.deepEqual(invalid.steps.map(s => s.status), ['failed', 'skipped']);
    const result = JSON.parse(invalid.steps[0].stdout.trim());
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_input');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
