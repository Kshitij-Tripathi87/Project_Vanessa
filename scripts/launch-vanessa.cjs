/* Windows test launcher. No shell interpolation and no credentials in argv. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const children = new Set();
let stopping = false;
let logFile;
let secrets = [];
function log(stage, message) {
  let line = `${new Date().toISOString()} [${stage}] ${message}`;
  for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, line + '\n');
}

function attachOutput(child, stage) {
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    stream.on('data', (chunk) => {
      pending += decoder.write(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line) log(stage, line);
    });
    stream.on('end', () => {
      pending += decoder.end();
      if (pending) log(stage, pending);
    });
  }
}

function run(stage, executable, args, cwd = root) {
  log(stage, 'Starting');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    attachOutput(child, stage);
    child.once('error', reject);
    child.once('close', (code) => {
      children.delete(child);
      log(stage, `Exited with code ${code}`);
      code === 0 ? resolve() : reject(new Error(`${stage} exited with code ${code}; see the preceding log lines.`));
    });
  });
}

function startService(stage, entry, args = []) {
  log(stage, 'Starting freshly built service');
  const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  attachOutput(child, stage);
  child.once('error', () => shutdown(1, `${stage} failed to start.`));
  child.once('close', (code) => {
    children.delete(child);
    if (!stopping) shutdown(1, `${stage} stopped unexpectedly (exit ${code}).`);
  });
  return child;
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => reject(new Error(`Port ${port} is unavailable (${error.code}). Close the previous Vanessa service/session before restarting; existing processes will not be reused or killed.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

async function waitForHealth(stage, url, service, ready = false) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      if (response.ok && body.service === service) {
        if (ready && body.readiness !== 'ready') throw new Error(`Provider readiness=${body.readiness}; inspect voice configuration errors above.`);
        log(stage, `Health OK${ready ? '; providers configured (external API access is checked on first use)' : ''}`);
        return;
      }
    } catch (error) {
      if (error.message.startsWith('Provider readiness=')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!stopping) throw new Error(`${stage} did not become healthy within 30 seconds.`);
}

function shutdown(code, reason) {
  if (stopping) return;
  stopping = true;
  log('Launcher', reason);
  for (const child of children) {
    if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  process.exit(code);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Use this launcher on Windows.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  process.chdir(root);
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) throw new Error('Root .env is missing.');
  const dotenv = require('dotenv');
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  // Root .env is authoritative for this launch, including all child processes.
  Object.assign(process.env, parsed);
  secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 6).map(([, value]) => value);
  const logDir = path.join(root, 'logs', 'launcher');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, `vanessa-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  log('1/5 ENV', 'Loaded root .env; credentials are not printed.');
  log('1/5 ENV', `File last changed=${fs.statSync(envPath).mtime.toISOString()}; Fish key fingerprint=${createHash('sha256').update(process.env.FISH_API_KEY || '').digest('hex').slice(0, 12)} (hash only; compare after changing the key). Restart required after .env edits.`);
  log('Launcher', `Log file: ${logFile}`);
  const asr = process.env.VOICE_ASR_PROVIDER || 'fish';
  const tts = process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || 'fish';
  if (asr !== 'fish' || tts !== 'fish') throw new Error('This voice-to-Codex test launcher expects Fish ASR and Fish TTS. Select fish in VOICE_ASR_PROVIDER and VOICE_TTS_PROVIDER.');
  for (const key of ['GEMINI_API_KEY', 'FISH_API_KEY']) {
    if (!process.env[key]?.trim()) throw new Error(`Missing ${key} in root .env.`);
    log('1/5 ENV', `${key}=configured`);
  }
  if (!(process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID)?.trim()) throw new Error('Missing FISH_TTS_VOICE_ID in root .env.');
  if (process.env.FAKE === '1') throw new Error('FAKE=1 is enabled. Disable it for a real Codex test.');
  // Current renderer fixes the voice socket to 4500. Fail clearly rather than
  // launch an unreachable voice service when a different port is configured.
  if (Number(process.env.VOICE_AGENT_PORT || 4500) !== 4500) throw new Error('Current desktop voice client requires VOICE_AGENT_PORT=4500.');
  const port = Number(process.env.VANESSA_PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 4500) throw new Error('Invalid VANESSA_PORT (must differ from voice port 4500).');
  const orchestratorUrl = `http://127.0.0.1:${port}`;
  process.env.ORCHESTRATOR_URL = orchestratorUrl;
  process.env.ORCHESTRATOR_WS = `ws://127.0.0.1:${port}/events`;
  process.env.HOST = '127.0.0.1';
  process.env.VOICE_STRICT_CONFIG = 'true';
  // Serve the built UI from the local origin already allowed by voice sockets
  // and microphone permissions. file:// pages have an opaque/null WS origin.
  process.env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173';
  delete process.env.ELECTRON_RUN_AS_NODE;
  log('1/5 ENV', `ASR=${asr}; TTS=${tts}; voice ID configured; Gemini=${process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'}`);
  log('1/5 ENV', `Orchestrator=${orchestratorUrl}; Voice=ws://127.0.0.1:4500/ws; local Whisper startup skipped.`);
  const codex = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
  if (codex.status !== 0) throw new Error('Codex CLI not found on PATH. Add the installed Codex CLI directory to PATH and reopen the terminal.');
  log('1/5 ENV', 'Codex CLI found; authentication will be checked by Codex when launched.');
  const tsc = require.resolve('typescript/bin/tsc');
  const vite = path.join(path.dirname(require.resolve('vite/package.json', { paths: [path.join(root, 'apps/desktop')] })), 'bin', 'vite.js');
  const electron = require(require.resolve('electron', { paths: [path.join(root, 'apps/desktop')] }));
  if (!fs.existsSync(electron)) throw new Error('Electron executable is missing. Restore workspace dependencies.');
  if (process.argv.includes('--check')) {
    log('Launcher', 'Preflight passed. No services started; credentials have not been sent to providers.');
    return;
  }
  if (!process.argv.includes('--build-only')) {
    await assertPortFree(port);
    await assertPortFree(4500);
    await assertPortFree(5173);
  }
  log('2/5 BUILD', 'Building shared contracts, orchestrator, voice service, and desktop. pnpm is not needed at launch when dependencies are installed.');
  for (const project of ['packages/shared', 'services/orchestrator', 'services/voice-agent']) {
    await run(`Build ${project}`, process.execPath, [tsc, '-p', path.join(project, 'tsconfig.json')]);
  }
  // TypeScript does not copy the fixed native-terminal helper into dist.
  fs.copyFileSync(path.join(root, 'services/orchestrator/src/agents/codex-terminal.cjs'), path.join(root, 'services/orchestrator/dist/agents/codex-terminal.cjs'));
  log('2/5 BUILD', 'Codex terminal helper copied to build output.');
  await run('Build desktop types', process.execPath, [tsc, '-p', 'apps/desktop/tsconfig.json']);
  await run('Build desktop main', process.execPath, [tsc, '-p', 'apps/desktop/tsconfig.node.json']);
  await run('Build renderer', process.execPath, [vite, 'build', '--config', 'apps/desktop/vite.config.ts']);
  if (process.argv.includes('--build-only')) {
    log('Launcher', 'Build validation passed. No services started.');
    return;
  }
  startService('3/5 ORCHESTRATOR', 'services/orchestrator/dist/server.js');
  await waitForHealth('3/5 ORCHESTRATOR', `${orchestratorUrl}/health`, 'vanessa-orchestrator');
  if (stopping) return;
  startService('4/5 VOICE', 'services/voice-agent/dist/server.js');
  await waitForHealth('4/5 VOICE', 'http://127.0.0.1:4500/health', 'vanessa-voice-agent', true);
  if (stopping) return;
  startService('DESKTOP UI', vite, ['preview', '--config', 'apps/desktop/vite.config.ts', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
  let uiReady = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try {
      const response = await fetch(process.env.VITE_DEV_SERVER_URL, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { uiReady = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (stopping) return;
  if (!uiReady) throw new Error('Built desktop UI did not become available on port 5173.');
  log('DESKTOP UI', 'Built renderer ready on trusted local origin http://127.0.0.1:5173');
  log('5/5 DESKTOP', 'Launching desktop. Activate the microphone, speak a coding request, then approve the developer/codex.open task in Vanessa.');
  log('Test', 'Expected: Voice control -> transcript -> Orchestrator -> Gemini -> Planner -> awaiting_approval -> approval -> Codex handoff.');
  log('Test', 'A started Codex terminal is a handoff only; it does not verify coding completion. Close the desktop or press Ctrl+C to stop this launcher and its services.');
  await run('DESKTOP', electron, ['.'], path.join(root, 'apps/desktop'));
  shutdown(0, 'Desktop closed. Stopping services started by this launcher.');
}

process.on('SIGINT', () => shutdown(0, 'Ctrl+C received. Stopping owned processes.'));
process.on('SIGTERM', () => shutdown(0, 'Stop requested.'));
main().catch((error) => shutdown(1, error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  ? 'A workspace dependency is missing. Restore dependencies with pnpm install, then relaunch.'
  : error.message));
