#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACK = path.join(ROOT, 'packs/build/l1-expense-app/pack.json');
const MAX_OUTPUT_BYTES = 128 * 1024;

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    i += 1;
  }
  return values;
}

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolvePackPath(packRoot, value, label) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`Pack ${label} must be a non-empty relative path.`);
  }
  const target = path.resolve(packRoot, value);
  if (!inside(packRoot, target)) throw new Error(`Pack ${label} escapes the pack directory.`);
  return target;
}

async function listFiles(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Template contains a symbolic link: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) await listFiles(root, absolute, output);
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Template contains an unsupported filesystem entry: ${path.relative(root, absolute)}`);
  }
  return output;
}

async function digestFiles(root, files) {
  const result = {};
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute)) throw new Error(`Protected path escapes workspace: ${relative}`);
    const content = await readFile(absolute);
    result[relative] = createHash('sha256').update(content).digest('hex');
  }
  return result;
}

function runChild(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const append = (target, chunk) => {
      const next = target + chunk.toString('utf8');
      return Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES
        ? Buffer.from(next, 'utf8').subarray(-MAX_OUTPUT_BYTES).toString('utf8')
        : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
    }, options.timeoutMs);
    timer.unref?.();
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, error: error ? String(error.message || error) : undefined, timedOut, stdout, stderr });
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.unref?.();
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* exited */ } }
}

function redactOutput(value) {
  return String(value || '')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(-MAX_OUTPUT_BYTES);
}

function normalizeAdapterResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Adapter result must be a JSON object.');
  const measuredInteger = (key) => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
  return {
    claimedDone: value.claimedDone === true,
    humanInterventions: measuredInteger('humanInterventions'),
    repairAttempts: Number.isSafeInteger(value.repairAttempts) && value.repairAttempts >= 0 ? value.repairAttempts : null,
    creditsSpent: Number.isFinite(value.creditsSpent) && value.creditsSpent >= 0 ? value.creditsSpent : null,
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 4000) : '',
    scopeViolations: measuredInteger('scopeViolations'),
    metadata: value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {},
  };
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) throw new Error('Judge must return a checks array.');
  return checks.map((check, index) => ({
    id: typeof check?.id === 'string' ? check.id : `check-${index + 1}`,
    name: typeof check?.name === 'string' ? check.name : `Check ${index + 1}`,
    passed: check?.passed === true,
    detail: typeof check?.detail === 'string' ? check.detail.slice(0, 4000) : '',
  }));
}

async function runOne({ pack, packRoot, specText, judge, adapterPath, workspaceRoot, runMetaDir, iteration }) {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const workspaceDir = path.join(workspaceRoot, `${pack.id.replace(/[^a-zA-Z0-9._-]/g, '-')}-${iteration}-${runId.slice(-8)}`);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let adapterExitCode = null;
  let adapterTimedOut = false;
  let adapterError;
  let adapterOutput = { stdout: '', stderr: '' };
  let adapterResult = {
    claimedDone: false, humanInterventions: null, repairAttempts: null,
    creditsSpent: null, summary: '', scopeViolations: null, metadata: {},
  };
  let checks = [];
  let judgeError;
  let judgedScopeViolations = 0;

  await cp(pack.templatePath, workspaceDir, { recursive: true, errorOnExist: true, force: false });
  const initialFiles = await listFiles(workspaceDir);
  const initialDigests = await digestFiles(workspaceDir, initialFiles);
  const protectedBaseline = await digestFiles(workspaceDir, pack.protectedFiles);
  const taskFile = path.join(workspaceDir, '.vanessa-gauntlet-task.md');
  await writeFile(taskFile, specText, 'utf8');
  const resultPath = path.join(runMetaDir, `adapter-result-${iteration}.json`);
  const taskDigest = createHash('sha256').update(specText).digest('hex');

  const adapterRun = await runChild(process.execPath, [adapterPath], {
    cwd: workspaceDir,
    timeoutMs: pack.adapterTimeoutMs,
    env: {
      ...process.env,
      VANESSA_GAUNTLET_RUN_ID: runId,
      VANESSA_GAUNTLET_ITERATION: String(iteration),
      VANESSA_GAUNTLET_PACK_ID: pack.id,
      VANESSA_GAUNTLET_LEVEL: pack.level,
      VANESSA_GAUNTLET_WORKSPACE: workspaceDir,
      VANESSA_GAUNTLET_TASK_FILE: taskFile,
      VANESSA_GAUNTLET_SPEC_FILE: taskFile,
      VANESSA_GAUNTLET_RESULT_FILE: resultPath,
      VANESSA_GAUNTLET_TIMEOUT_MS: String(pack.adapterTimeoutMs),
    },
  });
  adapterExitCode = adapterRun.code;
  adapterTimedOut = adapterRun.timedOut;
  adapterError = adapterRun.error;
  adapterOutput = { stdout: redactOutput(adapterRun.stdout), stderr: redactOutput(adapterRun.stderr) };
  try {
    const resultText = await readFile(resultPath, 'utf8');
    adapterResult = normalizeAdapterResult(JSON.parse(resultText));
  } catch (error) {
    adapterError ||= `Adapter did not produce a valid result file: ${error.message}`;
  }

  let sourceScopeViolations = 0;
  try {
    const afterFiles = (await listFiles(workspaceDir)).filter((relative) =>
      !relative.startsWith('.vanessa-gauntlet-') && !/(^|\/)(node_modules|\.gauntlet|\.git)(\/|$)/.test(relative) && relative !== 'data/expenses.sqlite');
    const afterDigests = await digestFiles(workspaceDir, afterFiles);
    const observedTaskDigest = createHash('sha256').update(await readFile(taskFile)).digest('hex');
    if (observedTaskDigest !== taskDigest) {
      sourceScopeViolations += 1;
      adapterError ||= 'The immutable task specification was modified.';
    }
    const beforeFiles = initialFiles.filter((relative) => !/(^|\/)(node_modules|\.gauntlet|\.git)(\/|$)/.test(relative) && relative !== 'data/expenses.sqlite');
    const allPaths = new Set([...beforeFiles, ...afterFiles]);
    const allowed = new Set(pack.allowedPaths || []);
    for (const relative of allPaths) {
      if (initialDigests[relative] !== afterDigests[relative] && !allowed.has(relative)) sourceScopeViolations += 1;
    }
  } catch (error) {
    sourceScopeViolations += 1;
    adapterError ||= `Workspace scope inspection failed: ${error.message}`;
  }

  try {
    const judged = await judge({
      packId: pack.id,
      level: pack.level,
      iteration,
      runId,
      packRoot,
      workspaceDir,
      specPath: taskFile,
      timeoutMs: pack.judgeTimeoutMs,
      adapterResult,
      protectedBaseline,
    });
    checks = normalizeChecks(judged.checks);
    judgedScopeViolations = Number.isSafeInteger(judged.scopeViolations) && judged.scopeViolations > 0 ? judged.scopeViolations : 0;
  } catch (error) {
    judgeError = String(error?.stack || error?.message || error);
  }

  const checksPassed = checks.filter((item) => item.passed).length;
  const checksTotal = pack.expectedChecks;
  const judgePassed = !judgeError && checks.length === checksTotal && checksPassed === checksTotal;
  const falseDoneClaims = adapterResult.claimedDone && !judgePassed ? 1 : 0;
  const scopeViolations = adapterResult.scopeViolations === null
    ? null
    : adapterResult.scopeViolations + sourceScopeViolations + Number(judgedScopeViolations || 0);
  const elapsedMs = Math.round(performance.now() - started);
  const status = adapterExitCode === 0 && !adapterTimedOut && !adapterError && judgePassed && adapterResult.claimedDone &&
    falseDoneClaims === 0 && scopeViolations === 0 && adapterResult.humanInterventions !== null &&
    adapterResult.humanInterventions <= pack.maxHumanInterventions
    ? 'passed' : 'failed';

  const record = {
    schema: 'vanessa.gauntlet.run.v1',
    packId: pack.id,
    level: pack.level,
    iteration,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs,
    status,
    adapter: path.basename(adapterPath),
    adapterExitCode,
    adapterTimedOut,
    adapterError,
    adapterSummary: adapterResult.summary,
    adapterClaimedDone: adapterResult.claimedDone,
    humanInterventions: adapterResult.humanInterventions,
    repairAttempts: adapterResult.repairAttempts,
    creditsSpent: adapterResult.creditsSpent,
    scopeViolations,
    falseDoneClaims,
    checksPassed,
    checksTotal,
    checks,
    judgeError,
    workspaceDir,
    adapterOutput,
  };
  return record;
}

function markdownReport(summary) {
  const rows = summary.runs.map((run) => `| ${run.iteration} | ${run.status} | ${run.checksPassed}/${run.checksTotal} | ${run.elapsedMs} | ${run.creditsSpent ?? 'n/a'} | ${run.humanInterventions} | ${run.repairAttempts ?? 'n/a'} | ${run.falseDoneClaims} | ${run.scopeViolations} |`).join('\n');
  return `# Vanessa Gauntlet — ${summary.packId}\n\n` +
    `- Level: ${summary.level}\n- Adapter: \`${summary.adapter}\`\n- Runs: ${summary.runs.length}\n` +
    `- Qualification: **${summary.qualification}**\n- Pass rate: ${summary.passRate}\n\n` +
    `| Run | Status | Checks | Time (ms) | Credits | Interventions | Repairs | False done | Scope violations |\n` +
    `|---:|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `## Hard invariants\n\n- False done claims: **${summary.falseDoneClaims}** (must be 0)\n` +
    `- Scope violations: **${summary.scopeViolations}** (must be 0)\n` +
    `- All runs must pass; a best-run score is not used.\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node evals/vanessa-gauntlet/run.mjs --adapter <trusted-adapter.mjs> [--pack <pack.json>] [--runs <count>] [--workspace-root <path>] [--results-root <path>]');
    return;
  }
  if (!args.adapter) throw new Error('--adapter is required. Adapters are explicit and are never inferred.');
  const packPath = path.resolve(args.pack || DEFAULT_PACK);
  const packRoot = path.dirname(packPath);
  const pack = JSON.parse(await readFile(packPath, 'utf8'));
  if (pack.schema !== 'vanessa.gauntlet.pack.v1' || typeof pack.id !== 'string' || typeof pack.level !== 'string') {
    throw new Error('Invalid task-pack manifest.');
  }
  pack.templatePath = resolvePackPath(packRoot, pack.template, 'template');
  const specPath = resolvePackPath(packRoot, pack.spec, 'spec');
  const judgePath = resolvePackPath(packRoot, pack.judge, 'judge');
  const specText = await readFile(specPath, 'utf8');
  const templateFiles = await listFiles(pack.templatePath);
  if (!Array.isArray(pack.protectedFiles) || pack.protectedFiles.some((value) => !templateFiles.includes(value))) {
    throw new Error('Every protectedFiles entry must exist inside the template.');
  }
  if (!Number.isInteger(pack.expectedChecks) || pack.expectedChecks < 1) throw new Error('expectedChecks must be a positive integer.');
  if (!Array.isArray(pack.allowedPaths) || pack.allowedPaths.some((value) => typeof value !== 'string' || !templateFiles.includes(value) || value.split(/[\\/]+/).some((part) => part === '..'))) {
    throw new Error('Every allowedPaths entry must be an existing file inside the template.');
  }
  pack.adapterTimeoutMs = Number(pack.adapterTimeoutMs || 60 * 60 * 1000);
  pack.judgeTimeoutMs = Number(pack.judgeTimeoutMs || 5 * 60 * 1000);
  pack.maxHumanInterventions = Number.isInteger(pack.maxHumanInterventions) ? pack.maxHumanInterventions : 0;
  if (!Number.isInteger(pack.requiredRuns) || pack.requiredRuns < 1) throw new Error('requiredRuns must be a positive integer.');
  const runs = Number(args.runs || pack.requiredRuns || 5);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from 1 to 20.');
  if (args.adapter && !args.adapter.endsWith('.mjs')) throw new Error('--adapter must reference a trusted .mjs adapter.');
  const adapterPath = path.resolve(args.adapter);
  const adapterStats = await import('node:fs/promises').then((fs) => fs.stat(adapterPath));
  if (!adapterStats.isFile()) throw new Error('Adapter path is not a file.');
  // Import the judge once; its implementation lives outside every task workspace.
  const judgeModule = await import(pathToFileURL(judgePath).href);
  if (typeof judgeModule.judge !== 'function') throw new Error('Judge module must export judge(context).');
  const workspaceRoot = path.resolve(args['workspace-root'] || path.join(os.tmpdir(), 'vanessa-gauntlet-runs'));
  await mkdir(workspaceRoot, { recursive: true });
  const resultsRoot = path.resolve(args['results-root'] || path.join(ROOT, 'results'));
  const batchId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const batchDir = path.join(resultsRoot, pack.id.replace(/[^a-zA-Z0-9._-]/g, '-'), batchId);
  await mkdir(batchDir, { recursive: true });
  const records = [];
  for (let iteration = 1; iteration <= runs; iteration += 1) {
    console.log(`[${iteration}/${runs}] ${pack.id} — creating isolated workspace`);
    const runMetaDir = path.join(batchDir, `run-${iteration}`);
    await mkdir(runMetaDir, { recursive: true });
    const record = await runOne({ pack, packRoot, specText, judge: judgeModule.judge, adapterPath, workspaceRoot, runMetaDir, iteration });
    records.push(record);
    await writeFile(path.join(batchDir, `run-${iteration}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.log(`[${iteration}/${runs}] ${record.status.toUpperCase()} ${record.checksPassed}/${record.checksTotal} checks in ${record.elapsedMs}ms`);
  }
  const passedRuns = records.filter((run) => run.status === 'passed').length;
  const summary = {
    schema: 'vanessa.gauntlet.batch.v1',
    batchId,
    packId: pack.id,
    level: pack.level,
    adapter: path.basename(adapterPath),
    requestedRuns: runs,
    requiredRuns: pack.requiredRuns || 5,
    passedRuns,
    passRate: `${passedRuns}/${records.length}`,
    falseDoneClaims: records.reduce((sum, run) => sum + run.falseDoneClaims, 0),
    scopeViolations: records.some((run) => run.scopeViolations === null)
      ? null : records.reduce((sum, run) => sum + run.scopeViolations, 0),
    qualification: runs >= (pack.requiredRuns || 5) && passedRuns === records.length &&
      records.length >= (pack.requiredRuns || 5) && records.every((run) => run.humanInterventions !== null && run.scopeViolations === 0)
      ? 'PASS' : 'NOT_QUALIFIED',
    generatedAt: new Date().toISOString(),
    runs: records,
  };
  await writeFile(path.join(batchDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(batchDir, 'summary.md'), markdownReport(summary), 'utf8');
  console.log(`\nBatch: ${batchDir}`);
  console.log(`Qualification: ${summary.qualification}; pass rate ${summary.passRate}; false-done ${summary.falseDoneClaims}; scope violations ${summary.scopeViolations}`);
  if (summary.qualification !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[gauntlet] ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
