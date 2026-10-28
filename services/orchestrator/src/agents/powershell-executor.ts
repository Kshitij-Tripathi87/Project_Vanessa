import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { powerShellRunner } from './powershell-runner.js';
import { buildPowerShellEnvironment } from './powershell.js';

export interface PowerShellRequest {
  steps: Array<{ id: string; command: string }>;
  workingDirectory?: string;
  timeoutMs?: number;
}
export interface PowerShellStepResult {
  id: string;
  status: 'completed' | 'failed' | 'skipped';
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  outputTruncated?: boolean;
}
export interface PowerShellBatchResult {
  success: boolean;
  steps: PowerShellStepResult[];
  finalWorkingDirectory?: string;
  timedOut: boolean;
  error?: string;
}

/** Internal only: orchestration MUST apply permissionGuard and obtain approvals first. */
export async function executePowerShellSteps(request: PowerShellRequest): Promise<PowerShellBatchResult> {
  if (!request || !Array.isArray(request.steps) || !request.steps.length || request.steps.length > 100) {
    throw new Error('steps must contain 1–100 steps');
  }
  const ids = new Set<string>();
  for (const step of request.steps) {
    if (!step || typeof step.id !== 'string' || !step.id.trim() || ids.has(step.id)) throw new Error('Step IDs must be unique non-empty strings');
    ids.add(step.id);
    if (typeof step.command !== 'string' || !step.command.trim() || step.command.includes('\0')) throw new Error('Commands must be non-empty strings without NUL');
  }
  const timeoutMs = request.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('timeoutMs must be an integer between 100 and 300000');
  let cwd: string | undefined;
  if (request.workingDirectory !== undefined) {
    if (typeof request.workingDirectory !== 'string' || !request.workingDirectory.trim()) throw new Error('workingDirectory must be an existing directory');
    cwd = resolve(request.workingDirectory);
    if (!(await stat(cwd)).isDirectory()) throw new Error('workingDirectory must be an existing directory');
  }
  if (process.platform !== 'win32') throw new Error('PowerShell batch execution is supported only on Windows');
  const dir = await mkdtemp(join(tmpdir(), 'vanessa-executor-'));
  const events = join(dir, 'events.jsonl');
  const input = join(dir, 'request.json');
  let timedOut = false;
  let failure: string | undefined;
  let shellCode: number | null = null;
  try {
    await writeFile(input, JSON.stringify({ steps: request.steps, workingDirectory: cwd }), 'utf8');
    // EncodedCommand contains only the fixed runner, never request commands.
    await new Promise<void>((finish) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powerShellRunner, 'utf16le').toString('base64')], {
        shell: false, windowsHide: true, cwd,
        env: buildPowerShellEnvironment({
          VANESSA_EXEC_REQUEST: input,
          VANESSA_EXEC_EVENTS: events,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const terminate = () => {
        child.kill();
        // Descendants may inherit pipe handles; do not wait for those handles.
        child.stdout.destroy();
        child.stderr.destroy();
      };
      let diagnosticBytes = 0;
      const capture = (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > 65536) { failure = 'Shell diagnostic output exceeded 64 KiB'; terminate(); }
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const timer = setTimeout(() => { timedOut = true; failure = 'Whole-batch timeout exceeded'; terminate(); }, timeoutMs);
      child.on('error', (error) => { failure = `PowerShell launch error: ${error.message}`; });
      child.on('close', (code) => { clearTimeout(timer); shellCode = code; finish(); });
    });
    let journal = '';
    try { journal = await readFile(events, 'utf8'); } catch { failure ??= 'Missing runner result journal'; }
    return decodePowerShellJournal(request.steps, journal, { timedOut, failure, shellCode });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Protocol decoder exported for platform-independent, synthetic protocol tests. */
export function decodePowerShellJournal(
  steps: PowerShellRequest['steps'], journal: string,
  outcome: { timedOut: boolean; failure?: string; shellCode: number | null },
): PowerShellBatchResult {
  const results: PowerShellStepResult[] = steps.map(({ id }) => ({ id, status: 'skipped', stdout: '', stderr: '', durationMs: 0 }));
  let index = 0;
  let active = false;
  let done = false;
  let startedAt: number | undefined;
  let failed = false;
  let finalWorkingDirectory: string | undefined;
  let error = outcome.failure;
  try {
    for (const line of journal.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (done) throw new Error('Data after runner completion');
      const result = results[index];
      if (event.type === 'done') {
        if (active || (!failed && index !== results.length)) throw new Error('Premature completion');
        done = true;
      } else {
        if (!result || event.id !== result.id || failed) throw new Error('Unexpected step event');
        if (event.type === 'start' && !active) {
          active = true; result.status = 'failed';
          startedAt = typeof event.startedAt === 'number' ? event.startedAt : undefined;
        }
        else if (event.type === 'output' && active && ['stdout', 'stderr'].includes(event.stream) && typeof event.text === 'string') {
          const stream = event.stream as 'stdout' | 'stderr';
          result[stream] = (result[stream] + event.text).slice(0, 70000);
        } else if (event.type === 'end' && active && typeof event.failed === 'boolean' && Number.isFinite(event.durationMs) && event.durationMs >= 0 && (event.exitCode === null || Number.isInteger(event.exitCode))) {
          if (!event.failed && event.exitCode !== null && event.exitCode !== 0) throw new Error('Nonzero exit code reported as success');
          result.status = event.failed ? 'failed' : 'completed';
          result.durationMs = event.durationMs;
          if (event.exitCode !== null) result.exitCode = event.exitCode;
          result.outputTruncated = event.outputTruncated === true;
          failed = event.failed;
          active = false;
          index++;
        } else throw new Error('Malformed runner event');
      }
      if (typeof event.cwd === 'string') finalWorkingDirectory = event.cwd;
    }
  } catch (err) { error ??= `Invalid runner protocol: ${(err as Error).message}`; }
  if (active && startedAt !== undefined) results[index].durationMs = Math.max(0, Date.now() - startedAt);
  if (!done) error ??= 'Incomplete runner output (PowerShell may have exited early)';
  if (outcome.shellCode !== 0) error ??= `PowerShell exited with code ${outcome.shellCode}`;
  return { success: !outcome.timedOut && !error && done && !failed && results.every(s => s.status === 'completed'), steps: results, finalWorkingDirectory, timedOut: outcome.timedOut, error };
}
