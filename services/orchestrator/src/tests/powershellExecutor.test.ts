import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executePowerShellSteps, decodePowerShellJournal } from '../agents/powershell-executor.js';

test('validation rejects invalid requests before launch', async () => {
  for (const request of [
    { steps: [] }, { steps: [{ id: '', command: '1' }] },
    { steps: [{ id: 'a', command: ' ' }] },
    { steps: [{ id: 'a', command: '1' }, { id: 'a', command: '2' }] },
    { steps: [{ id: 'a', command: '1' }], timeoutMs: 0 },
    { steps: [{ id: 'a', command: '1' }], timeoutMs: 300001 },
    { steps: [{ id: 'a', command: '1' }], timeoutMs: 1.5 },
    { steps: [{ id: 'a', command: '1' }], workingDirectory: 'Z:\\vanessa-nonexistent-directory' },
  ]) await assert.rejects(executePowerShellSteps(request));
});

// Synthetic protocol fixtures: these tests do not launch or mock PowerShell.
const steps = [{ id: 'a', command: '1' }, { id: 'b', command: '2' }];
const journal = (...events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const completed = [
  { type: 'start', id: 'a', cwd: 'C:\\temp' },
  { type: 'output', id: 'a', stream: 'stdout', text: 'first\n' },
  { type: 'end', id: 'a', failed: false, exitCode: null, durationMs: 12 },
];
test('synthetic protocol: preserves completed steps and partial output on timeout', () => {
  const result = decodePowerShellJournal(steps, journal(...completed,
    { type: 'start', id: 'b' }, { type: 'output', id: 'b', stream: 'stdout', text: 'partial' }),
    { timedOut: true, shellCode: null, failure: 'timeout' });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.steps.map(s => s.status), ['completed', 'failed']);
  assert.equal(result.steps[0].stdout, 'first\n');
  assert.equal(result.steps[1].stdout, 'partial');
});
test('synthetic protocol: malformed, incomplete, reordered, and early-exit output cannot succeed', () => {
  for (const text of ['', '{', journal(...completed), journal({ type: 'done' }), journal({ type: 'start', id: 'b' })]) {
    assert.equal(decodePowerShellJournal(steps, text, { timedOut: false, shellCode: 0 }).success, false);
  }
  assert.equal(decodePowerShellJournal([steps[0]], journal(...completed, { type: 'done' }), { timedOut: false, shellCode: 1 }).success, false);
});
test('synthetic protocol: launch failure marks all steps skipped', () => {
  const result = decodePowerShellJournal(steps, '', { timedOut: false, shellCode: null, failure: 'PowerShell launch error: ENOENT' });
  assert.equal(result.success, false);
  assert.ok(result.steps.every(s => s.status === 'skipped'));
  assert.match(result.error!, /launch error/);
});

test('synthetic protocol: timeout and contradictory native status cannot report success', () => {
  assert.equal(decodePowerShellJournal([steps[0]], journal(...completed, { type: 'done' }),
    { timedOut: true, shellCode: 0 }).success, false);
  const contradictory = journal(completed[0],
    { type: 'end', id: 'a', failed: false, exitCode: 7, durationMs: 1 }, { type: 'done' });
  const result = decodePowerShellJournal([steps[0]], contradictory, { timedOut: false, shellCode: 0 });
  assert.equal(result.success, false);
  assert.match(result.error!, /Nonzero exit code/);
});
