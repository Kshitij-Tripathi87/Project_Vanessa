import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executePowerShellSteps } from '../agents/powershell-executor.js';

// REAL Windows integration. Only temporary directories and harmless commands.
const windows = { skip: process.platform !== 'win32' };
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'vanessa-executor-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('Windows: same-scope order, variables, location, quotes, spaces and multiline', windows, async () => fixture(async dir => {
  const sub = join(dir, "space and 'quote");
  await mkdir(sub);
  const result = await executePowerShellSteps({ workingDirectory: dir, steps: [
    { id: 'set', command: "$message = @'\nquoted \"value\" and 'single'\nsecond line\n'@\nSet-Location -LiteralPath \"space and 'quote\"\nWrite-Output 'first'" },
    { id: 'read', command: 'Write-Output $message\n(Get-Location).Path' },
  ] });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.steps[0].stdout.trim(), 'first');
  assert.match(result.steps[1].stdout, /quoted "value" and 'single'\r?\nsecond line/);
  assert.ok(result.steps[1].stdout.includes(sub));
  assert.equal(result.finalWorkingDirectory, sub);
}));
test('Windows: cmdlet errors and native failures stop and skip subsequent steps', windows, async () => fixture(async dir => {
  for (const command of ["Get-Item -LiteralPath './missing'", '& $env:ComSpec /d /c exit 7', '& $env:ComSpec /d /c exit 7; & $env:ComSpec /d /c exit 0']) {
    const result = await executePowerShellSteps({ workingDirectory: dir, steps: [
      { id: 'before', command: "'kept'" }, { id: 'bad', command }, { id: 'after', command: "'never'" },
    ] });
    assert.equal(result.success, false);
    assert.deepEqual(result.steps.map(s => s.status), ['completed', 'failed', 'skipped']);
    assert.equal(result.steps[0].stdout.trim(), 'kept');
    if (command.startsWith('&')) assert.equal(result.steps[1].exitCode, 7);
    else assert.match(result.steps[1].stderr, /missing/);
  }
}));
test('Windows: native exit code resets between steps', windows, async () => fixture(async dir => {
  const result = await executePowerShellSteps({ workingDirectory: dir, steps: [
    { id: 'native', command: '& $env:ComSpec /d /c exit 0' }, { id: 'ps', command: "'hello'" },
  ] });
  assert.equal(result.success, true);
  assert.equal(result.steps[0].exitCode, 0);
  assert.equal(result.steps[1].exitCode, undefined);
}));
test('Windows: whole-batch timeout retains completed results', windows, async () => fixture(async dir => {
  const result = await executePowerShellSteps({ workingDirectory: dir, timeoutMs: 15000, steps: [
    { id: 'before', command: "'kept'" }, { id: 'slow', command: 'Start-Sleep -Seconds 60' }, { id: 'after', command: '1' },
  ] });
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
  assert.deepEqual(result.steps.map(s => s.status), ['completed', 'failed', 'skipped']);
  assert.equal(result.steps[0].stdout.trim(), 'kept');
}));
test('Windows: early exit cannot succeed; output is bounded', windows, async () => fixture(async dir => {
  const early = await executePowerShellSteps({ workingDirectory: dir, steps: [{ id: 'exit', command: 'exit 0' }, { id: 'after', command: '1' }] });
  assert.equal(early.success, false);
  const large = await executePowerShellSteps({ workingDirectory: dir, steps: [{ id: 'large', command: "1..1000 | ForEach-Object { 'x' * 1000 }" }] });
  assert.equal(large.success, true, JSON.stringify(large));
  assert.equal(large.steps[0].outputTruncated, true);
  assert.ok(large.steps[0].stdout.length <= 65536);
}));

test('Windows: Unicode request data and variables share one process within a batch only', windows, async () => fixture(async dir => {
  const sub = join(dir, 'हैलो café');
  await mkdir(sub);
  const result = await executePowerShellSteps({ workingDirectory: sub, steps: [
    { id: 'first', command: "$batchValue = 'नमस्ते café'; $batchPid = $PID; Write-Output $PID" },
    { id: 'second', command: 'if ($PID -ne $batchPid) { throw "Process changed" }; Write-Output $PID; Write-Output $batchValue' },
  ] });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.steps[1].stdout.trim(), `${result.steps[0].stdout.trim()}\r\nनमस्ते café`);
  assert.equal(result.finalWorkingDirectory, sub);
  const fresh = await executePowerShellSteps({ workingDirectory: dir, steps: [
    { id: 'fresh', command: "if (Get-Variable -Name batchValue -ErrorAction SilentlyContinue) { throw 'State leaked' }; 'fresh'" },
  ] });
  assert.equal(fresh.success, true, JSON.stringify(fresh));
  assert.equal(fresh.steps[0].stdout.trim(), 'fresh');
}));

test('Windows: direct console output limit fails the batch', windows, async () => fixture(async dir => {
  const result = await executePowerShellSteps({ workingDirectory: dir, steps: [
    { id: 'console', command: "[Console]::Write('x' * 100000)" },
  ] });
  assert.equal(result.success, false);
  assert.match(result.error!, /diagnostic output exceeded/);
}));
