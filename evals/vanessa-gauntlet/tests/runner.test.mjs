import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(ROOT, 'run.mjs');

async function createFixture(root, { answer, modifyProtected = false, omitTelemetry = false }) {
  const packRoot = path.join(root, 'pack');
  const template = path.join(packRoot, 'template');
  await mkdir(path.join(template, 'src'), { recursive: true });
  await mkdir(path.join(packRoot, 'tests'), { recursive: true });
  await writeFile(path.join(template, 'src', 'answer.txt'), 'todo\n');
  await writeFile(path.join(template, 'README.md'), 'immutable\n');
  await writeFile(path.join(packRoot, 'spec.md'), 'Create the correct answer.\n');
  await writeFile(path.join(packRoot, 'judge.mjs'), `import { readFile } from 'node:fs/promises';\nimport path from 'node:path';\nexport async function judge({workspaceDir}) {\n const value = await readFile(path.join(workspaceDir, 'src/answer.txt'), 'utf8');\n return { checks: [{ id: 'answer', name: 'Answer is correct', passed: value.trim() === '42', detail: value.trim() }] };\n}\n`);
  await writeFile(path.join(packRoot, 'pack.json'), JSON.stringify({
    schema: 'vanessa.gauntlet.pack.v1', id: 'test.runner', level: 'L1', spec: 'spec.md', template: 'template', judge: 'judge.mjs',
    requiredRuns: 1, expectedChecks: 1, maxHumanInterventions: 0, adapterTimeoutMs: 10000, judgeTimeoutMs: 10000,
    protectedFiles: ['README.md'], allowedPaths: ['src/answer.txt'],
  }, null, 2));
  const adapterFile = path.join(root, 'adapter.mjs');
  const telemetry = omitTelemetry ? '' : ',humanInterventions:0,scopeViolations:0';
  const adapterSource = `import { readFile, writeFile } from 'node:fs/promises';\nimport path from 'node:path';\nconst workspace = process.env.VANESSA_GAUNTLET_WORKSPACE;\nawait writeFile(path.join(workspace, 'src/answer.txt'), ${JSON.stringify(answer)} + '\\n');\n${modifyProtected ? "await writeFile(path.join(workspace, 'README.md'), 'tampered\\n');" : ''}\nawait writeFile(process.env.VANESSA_GAUNTLET_RESULT_FILE, JSON.stringify({claimedDone:true${telemetry},repairAttempts:1,summary:'fixture adapter finished'}));\n`;
  await writeFile(adapterFile, adapterSource);
  return { packFile: path.join(packRoot, 'pack.json'), adapterFile };
}

async function runFixture({ answer, modifyProtected = false, omitTelemetry = false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vanessa-gauntlet-runner-test-'));
  const { packFile, adapterFile } = await createFixture(root, { answer, modifyProtected, omitTelemetry });
  const resultRoot = path.join(root, 'results');
  const workspaceRoot = path.join(root, 'workspaces');
  const result = spawnSync(process.execPath, [RUNNER, '--pack', packFile, '--adapter', adapterFile, '--runs', '1', '--results-root', resultRoot, '--workspace-root', workspaceRoot], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const batchRoot = path.join(resultRoot, 'test.runner');
  const batchIds = await import('node:fs/promises').then((fs) => fs.readdir(batchRoot));
  const summaryPath = path.join(batchRoot, batchIds[0] ?? "", 'summary.json');
let summary;
try {
  summary = JSON.parse(await readFile(summaryPath, 'utf8'));
} catch (error) {
  const batchEntries = await import('node:fs/promises').then((fs) => fs.readdir(batchRoot, { withFileTypes: true }));
  throw new Error("Runner omitted summary.json. exit=" + result.status + "; signal=" + result.signal + "; error=" + result.error + "; stdout=" + result.stdout + "; stderr=" + result.stderr + "; entries=" + batchEntries.map((entry) => entry.name).join(", "), { cause: error });
}
  return { root, result, summary };
}

test('runner qualifies only when the independent judge passes and the adapter truthfully claims completion', async () => {
  const fixture = await runFixture({ answer: '42' });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(fixture.summary.qualification, 'PASS');
    assert.equal(fixture.summary.passedRuns, 1);
    assert.equal(fixture.summary.runs[0].checksPassed, 1);
    assert.equal(fixture.summary.runs[0].falseDoneClaims, 0);
    assert.equal(fixture.summary.scopeViolations, 0);
    assert.equal(fixture.summary.runs[0].repairAttempts, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a false completion claim fails the run even when the adapter exits zero', async () => {
  const fixture = await runFixture({ answer: 'not the answer' });
  try {
    assert.equal(fixture.result.status, 1);
    assert.equal(fixture.summary.qualification, 'NOT_QUALIFIED');
    assert.equal(fixture.summary.runs[0].falseDoneClaims, 1);
    assert.equal(fixture.summary.runs[0].status, 'failed');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('protected file changes count as scope violations and block qualification', async () => {
  const fixture = await runFixture({ answer: '42', modifyProtected: true });
  try {
    assert.equal(fixture.result.status, 1);
    assert.equal(fixture.summary.runs[0].checksPassed, 1);
    assert.equal(fixture.summary.runs[0].falseDoneClaims, 0);
    assert.ok(fixture.summary.scopeViolations > 0);
    assert.equal(fixture.summary.qualification, 'NOT_QUALIFIED');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test('missing intervention or scope telemetry stays unknown and cannot qualify', async () => {
  const fixture = await runFixture({ answer: '42', omitTelemetry: true });
  try {
    assert.equal(fixture.result.status, 1);
    assert.equal(fixture.summary.qualification, 'NOT_QUALIFIED');
    assert.equal(fixture.summary.runs[0].humanInterventions, null);
    assert.equal(fixture.summary.runs[0].scopeViolations, null);
    assert.equal(fixture.summary.scopeViolations, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
