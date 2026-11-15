import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SEEDED_PASSWORD = 'demo-password-L1';

function npmInvocation(args) {
  if (process.platform !== 'win32') return { file: 'npm', args };
  if (process.env.npm_execpath) return { file: process.execPath, args: [process.env.npm_execpath, ...args] };
  // Only fixed, judge-authored npm arguments reach this static Windows command line.
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] };
}

function childProcess(file, args, { cwd, env, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* exited */ } }
      } else {
        try { child.kill(); } catch { /* exited */ }
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-40000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-40000); });
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, error: error?.message, timedOut, stdout, stderr });
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  if (process.platform === 'win32') {
    await childProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000,
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* exited */ } }
  }
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* exited */ }
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApp(workspaceDir, dbPath, timeoutMs = 15000) {
  const port = await reservePort();
  const npm = npmInvocation(['start']);
  const child = spawn(npm.file, npm.args, {
    cwd: workspaceDir,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
    shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-20000); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Application exited before health check (code ${child.exitCode}): ${stderr || stdout}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const payload = await response.json();
        if (payload.status === 'ok') return { child, baseUrl, stdout: () => stdout, stderr: () => stderr };
      }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await stopProcess(child);
  throw new Error(`Health check timed out after ${timeoutMs}ms. ${stderr || stdout}`);
}

async function request(baseUrl, pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  let payload;
  try { payload = await response.json(); }
  catch { payload = null; }
  return { status: response.status, payload };
}

async function npmCommand(args, cwd, timeoutMs = 60000) {
  const invocation = npmInvocation(args);
  return childProcess(invocation.file, invocation.args, { cwd, env: process.env, timeoutMs });
}

function check(id, name, passed, detail) {
  return { id, name, passed: Boolean(passed), detail: String(detail || (passed ? 'Passed.' : 'Failed.')) };
}

async function sha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

export async function judge(context) {
  const checks = [];
  const workspaceDir = context.workspaceDir;
  const dbPath = path.join(workspaceDir, '.gauntlet', 'acceptance.sqlite');
  let app;
  try {
    app = await startApp(workspaceDir, dbPath, 15000);
    const health = await request(app.baseUrl, '/health');
    checks.push(check('health', 'Application starts and responds on /health', health.status === 200 && health.payload?.status === 'ok', `HTTP ${health.status}; payload=${JSON.stringify(health.payload)}`));
  } catch (error) {
    checks.push(check('health', 'Application starts and responds on /health', false, error.message));
  }

  let demoToken;
  let otherToken;
  if (app) {
    const login = await request(app.baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'demo@vanessa.test', password: SEEDED_PASSWORD } });
    const loginOk = login.status === 200 && typeof login.payload?.token === 'string' && login.payload.token.length >= 32 && login.payload?.user?.id === 'seed-user-a';
    demoToken = login.payload?.token;
    const registerEmail = `l1-${randomUUID()}@example.test`;
    const registration = await request(app.baseUrl, '/api/auth/register', { method: 'POST', body: { email: registerEmail, password: 'Gauntlet-Password-2026!' } });
    const registerOk = registration.status === 201 && registration.payload?.user?.email === registerEmail && typeof registration.payload?.token === 'string';
    const sessionCheck = registration.payload?.token
      ? await request(app.baseUrl, '/api/expenses', { token: registration.payload.token })
      : { status: 0, payload: null };
    checks.push(check('auth', 'User can register, log in, and receive a valid bearer session', loginOk && registerOk && sessionCheck.status === 200, `seed-login=${login.status}; register=${registration.status}; authenticated-read=${sessionCheck.status}`));

    const testEmail = `crud-${randomUUID()}@example.test`;
    const createdUser = await request(app.baseUrl, '/api/auth/register', { method: 'POST', body: { email: testEmail, password: 'CRUD-Password-2026!' } });
    const crudToken = createdUser.payload?.token;
    let crudOk = createdUser.status === 201 && typeof crudToken === 'string';
    let createdExpenseId;
    if (crudOk) {
      const created = await request(app.baseUrl, '/api/expenses', { method: 'POST', token: crudToken, body: { description: 'Benchmark expense', amountMinor: 12345, currency: 'INR' } });
      createdExpenseId = created.payload?.expense?.id;
      const read = createdExpenseId ? await request(app.baseUrl, `/api/expenses/${createdExpenseId}`, { token: crudToken }) : { status: 0 };
      const updated = createdExpenseId ? await request(app.baseUrl, `/api/expenses/${createdExpenseId}`, { method: 'PATCH', token: crudToken, body: { amountMinor: 23456, description: 'Updated benchmark expense' } }) : { status: 0 };
      const deleted = createdExpenseId ? await request(app.baseUrl, `/api/expenses/${createdExpenseId}`, { method: 'DELETE', token: crudToken }) : { status: 0 };
      const absent = createdExpenseId ? await request(app.baseUrl, `/api/expenses/${createdExpenseId}`, { token: crudToken }) : { status: 0 };
      crudOk = created.status === 201 && read.status === 200 && read.payload?.expense?.amountMinor === 12345 &&
        updated.status === 200 && updated.payload?.expense?.amountMinor === 23456 &&
        deleted.status === 200 && absent.status === 404;
    }
    checks.push(check('crud', 'Authenticated user can create, read, update and delete an expense', crudOk, `created=${createdUser.status === 201 ? 'user' : createdUser.status}; expense lifecycle=${crudOk ? 'passed' : 'failed'}`));

    const otherLogin = await request(app.baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'other@vanessa.test', password: SEEDED_PASSWORD } });
    otherToken = otherLogin.payload?.token;
    const mine = demoToken ? await request(app.baseUrl, '/api/expenses', { token: demoToken }) : { status: 0, payload: null };
    const theirs = otherToken ? await request(app.baseUrl, '/api/expenses', { token: otherToken }) : { status: 0, payload: null };
    const otherIds = new Set((theirs.payload?.expenses || []).map((item) => item.id));
    const leakAttempt = otherIds.size && demoToken
      ? await request(app.baseUrl, `/api/expenses/${[...otherIds][0]}`, { token: demoToken })
      : { status: 0 };
    const isolated = otherLogin.status === 200 && mine.status === 200 && theirs.status === 200 &&
      (mine.payload?.expenses || []).every((item) => !otherIds.has(item.id)) &&
      (theirs.payload?.expenses || []).length > 0 && leakAttempt.status === 404;
    checks.push(check('isolation', 'User A cannot read User B expenses', isolated, `A=${mine.status}; B=${theirs.status}; cross-user-read=${leakAttempt.status}; IDs-disjoint=${isolated}`));

    const dashboardA = demoToken ? await request(app.baseUrl, '/api/dashboard', { token: demoToken }) : { status: 0, payload: null };
    const dashboardB = otherToken ? await request(app.baseUrl, '/api/dashboard', { token: otherToken }) : { status: 0, payload: null };
    const dashboardOk = dashboardA.status === 200 && dashboardA.payload?.count === 3 && dashboardA.payload?.totalMinor === 46500 &&
      Array.isArray(dashboardA.payload?.totals) && dashboardA.payload.totals.length === 1 &&
      dashboardA.payload.totals[0]?.currency === 'INR' && dashboardA.payload.totals[0]?.count === 3 &&
      dashboardB.status === 200 && dashboardB.payload?.count === 1 && dashboardB.payload?.totalMinor === 99900;
    checks.push(check('dashboard', 'Dashboard totals match the seeded data for each user', dashboardOk, `A=${JSON.stringify(dashboardA.payload)}; B=${JSON.stringify(dashboardB.payload)}`));
  } else {
    checks.push(check('auth', 'User can register, log in, and receive a valid bearer session', false, 'Skipped because the application did not start.'));
    checks.push(check('crud', 'Authenticated user can create, read, update and delete an expense', false, 'Skipped because the application did not start.'));
    checks.push(check('isolation', 'User A cannot read User B expenses', false, 'Skipped because the application did not start.'));
    checks.push(check('dashboard', 'Dashboard totals match the seeded data for each user', false, 'Skipped because the application did not start.'));
  }
  if (app) await stopProcess(app.child);

  const projectTests = await npmCommand(['test'], workspaceDir, context.timeoutMs || 60000);
  let protectedUnchanged = true;
  const protectedDetails = [];
  for (const [relative, expected] of Object.entries(context.protectedBaseline || {})) {
    try {
      const actual = await sha256(path.join(workspaceDir, relative));
      if (actual !== expected) {
        protectedUnchanged = false;
        protectedDetails.push(`${relative} changed`);
      }
    } catch {
      protectedUnchanged = false;
      protectedDetails.push(`${relative} missing`);
    }
  }
  checks.push(check('project-tests', 'Project test suite passes and protected tests/scripts remain unchanged', projectTests.code === 0 && !projectTests.timedOut && protectedUnchanged,
    `npm test exit=${projectTests.code}; timedOut=${projectTests.timedOut}; protected=${protectedUnchanged ? 'unchanged' : protectedDetails.join(', ')}; ${projectTests.stderr.slice(-1200)}`));

  let freshCloneOk = false;
  let freshDetail = '';
  const freshRoot = await mkdtemp(path.join(os.tmpdir(), 'vanessa-gauntlet-fresh-'));
  const freshDir = path.join(freshRoot, 'project');
  try {
    await cp(workspaceDir, freshDir, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(workspaceDir, source).split(path.sep).join('/');
        return !/(^|\/)(node_modules|\.git|\.gauntlet|data)(\/|$)/.test(relative) && !relative.startsWith('.vanessa-gauntlet-');
      },
    });
    const readme = await readFile(path.join(freshDir, 'README.md'), 'utf8');
    const npmInstall = await npmCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], freshDir, 60000);
    let freshApp;
    try {
      if (npmInstall.code !== 0 || npmInstall.timedOut) throw new Error(`npm install failed: ${npmInstall.stderr || npmInstall.stdout}`);
      if (!readme.includes('npm install') || !readme.includes('npm start')) throw new Error('README must document npm install and npm start.');
      freshApp = await startApp(freshDir, path.join(freshDir, '.gauntlet', 'fresh.sqlite'), 15000);
      const freshHealth = await request(freshApp.baseUrl, '/health');
      freshCloneOk = freshHealth.status === 200 && freshHealth.payload?.status === 'ok';
      freshDetail = `clean-copy install exit=${npmInstall.code}; README commands present; health=${freshHealth.status}`;
    } finally {
      if (freshApp) await stopProcess(freshApp.child);
    }
  } catch (error) {
    freshDetail = error.message;
  } finally {
    await rm(freshRoot, { recursive: true, force: true });
  }
  checks.push(check('fresh-clone', 'Clean copy installs and starts using the README commands', freshCloneOk, freshDetail));

  // Workspace-wide path and protected-file violations are counted by the outer runner.
  return { checks, scopeViolations: 0 };
}
