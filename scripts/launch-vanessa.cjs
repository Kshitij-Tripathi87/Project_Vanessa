/* Shared Windows launcher. No shell interpolation and no credentials in argv. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');
const { launcherConfig } = require('./launcher-config.cjs');

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

function startService(stage, entry, args = [], executable = process.execPath) {
  log(stage, 'Starting managed process');
  const child = spawn(executable, [entry, ...args], { cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (!ready && body.readiness && body.readiness !== 'ready') log(stage, `Voice readiness=${body.readiness}; text commands remain available. See configuration diagnostics above.`);
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

async function ensureService(stage, url, identity, port, reuse, start, strict = false) {
  if (reuse) {
    let health;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) health = await response.json();
    } catch {}
    if (health?.service === identity) {
      if (strict && health.readiness && health.readiness !== 'ready') throw new Error(`${stage}: existing service is not ready.`);
      log(stage, `Reusing healthy ${identity}; its environment/code are unchanged and its logs stay in its original terminal.`);
      return;
    }
  }
  await assertPortFree(port);
  start();
  await waitForHealth(stage, url, identity, strict);
}

function asrReachable(url) {
  return new Promise((resolve) => {
    const WebSocket = require('ws');
    const socket = new WebSocket(url, { handshakeTimeout: 1000 });
    socket.once('open', () => { socket.close(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function ensureLocalAsr(asr, reuse, reservedPorts) {
  if (!asr.local) {
    log('LOCAL ASR', 'External ASR endpoint configured; its process is managed separately. Connection is checked on microphone activation.');
    return;
  }
  if (reservedPorts.includes(asr.port)) throw new Error('Local ASR port conflicts with orchestrator, voice, or desktop UI.');
  if (reuse && await asrReachable(asr.url)) {
    log('LOCAL ASR', 'Reusing reachable WebSocket endpoint; server identity/model cannot be verified by the legacy protocol. This launcher will not stop it.');
    return;
  }
  await assertPortFree(asr.port);
  if (!asr.python || !asr.script) throw new Error('Local ASR is not running and its Python environment/server is missing. Set VOICE_PYTHON or install .venv-voice.');
  // Keep legacy and consolidated Python servers aligned with the client's URL.
  Object.assign(process.env, { VOICE_HOST: '127.0.0.1', WHISPER_HOST: '127.0.0.1', VOICE_PORT: String(asr.port), WHISPER_PORT: String(asr.port), PYTHONUNBUFFERED: '1' });
  log('LOCAL ASR', `Starting ${path.basename(asr.script)} on port ${asr.port}; first model load/download may take time.`);
  startService('LOCAL ASR', asr.script, [], asr.python);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !stopping) {
    if (await asrReachable(asr.url)) { log('LOCAL ASR', 'WebSocket ready.'); return; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping) throw new Error('Local ASR did not start within 120 seconds. Check Python dependencies/model download logs.');
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Vanessa Windows launcher
Usage: Launch-Vanessa.bat [options]
  (default)         Build latest code; start orchestrator, configured voice services, and desktop.
  --text-only       Start desktop and orchestrator without voice or Python requirements.
  --dev             Watch orchestrator/voice TypeScript and serve Vite with hot reload.
  --reuse-existing  Reuse healthy orchestrator/voice services; leave them running on exit.
                    Their environment/code may differ. Restart them to pick up changes.
  --codex-test      Require selected LLM/voice credentials and Codex CLI; reject FAKE=1.
  --check           Check configuration/dependencies without building or starting services.
  --build-only      Build without starting services or requiring unused ports.
  --help            Show this help.

Root .env is loaded for all managed processes. Existing .env files are never rewritten.
Sarvam, Fish, ElevenLabs, and local voice/whisper providers follow VOICE_ASR_PROVIDER / VOICE_TTS_PROVIDER.
Planning uses PLANNER_PROVIDER; conversational replies use SARVAM_CHAT_PROVIDER (sarvam or nvidia).
Local Whisper uses VOICE_URL (or WHISPER_URL), voice_server.py (legacy whisper_server.py fallback),
and VOICE_PYTHON or .venv-voice / .venv-whisper. Install its Python dependencies beforehand.
Missing cloud keys warn during ordinary startup; unavailable providers cannot serve requests.
Codex is optional unless --codex-test is selected. Logs are saved in logs/launcher/.
Close the desktop or press Ctrl+C to stop only processes owned by this launcher.
`);
    return;
  }
  if (process.platform !== 'win32') throw new Error('Use this launcher on Windows.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  process.chdir(root);
  const envPath = path.join(root, '.env');
  const dotenv = require('dotenv');
  const hasEnv = fs.existsSync(envPath);
  const parsed = hasEnv ? dotenv.parse(fs.readFileSync(envPath)) : {};
  // Root .env is authoritative for this launch, including all child processes.
  Object.assign(process.env, parsed);
  secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 6).map(([, value]) => value);
  const logDir = path.join(root, 'logs', 'launcher');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, `vanessa-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  log('1/5 ENV', hasEnv ? 'Loaded root .env; credentials are not printed.' : 'No root .env; using inherited environment. See .env.example for configuration.');
  if (hasEnv) log('1/5 ENV', `File last changed=${fs.statSync(envPath).mtime.toISOString()}; restart required after .env edits.`);
  if (process.env.FISH_API_KEY) log('1/5 ENV', `Fish key fingerprint=${createHash('sha256').update(process.env.FISH_API_KEY).digest('hex').slice(0, 12)} (hash only).`);
  log('Launcher', `Log file: ${logFile}`);
  const config = launcherConfig(process.env, process.argv.slice(2), root, fs.existsSync);
  const { asr, tts } = config;
  for (const warning of config.missing) log('CONFIG WARNING', warning);
  if (process.env.FAKE === '1') log('CONFIG WARNING', 'FAKE=1: simulated actions are enabled.');
  // Current renderer fixes the voice socket to 4500. Fail clearly rather than
  // launch an unreachable voice service when a different port is configured.
  if (config.voice && Number(process.env.VOICE_AGENT_PORT || 4500) !== 4500) throw new Error('Current desktop voice client requires VOICE_AGENT_PORT=4500.');
  const port = Number(process.env.VANESSA_PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [4500, 5173].includes(port)) throw new Error('Invalid VANESSA_PORT (must differ from voice/UI ports 4500/5173).');
  const orchestratorUrl = `http://127.0.0.1:${port}`;
  process.env.ORCHESTRATOR_URL = orchestratorUrl;
  process.env.ORCHESTRATOR_WS = `ws://127.0.0.1:${port}/events`;
  process.env.HOST = '127.0.0.1';
  if (config.strict) process.env.VOICE_STRICT_CONFIG = 'true';
  // Serve the built UI from the local origin already allowed by voice sockets
  // and microphone permissions. file:// pages have an opaque/null WS origin.
  process.env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173';
  process.env.VANESSA_DEV_MODE = config.dev ? '1' : '0';
  process.env.VITE_VANESSA_VOICE_ENABLED = config.voice ? 'true' : 'false';
  delete process.env.ELECTRON_RUN_AS_NODE;
  log('1/5 ENV', `Mode=${config.dev ? 'development/watch' : 'built'}; voice=${config.voice}; ASR=${asr}; TTS=${tts}; planner=${config.planner}; conversation=${config.conversation}`);
  log('1/5 ENV', `Orchestrator=${orchestratorUrl}; local Whisper=${config.localAsr ? 'configured' : 'not needed'}.`);
  const codex = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
  if (codex.status !== 0 && config.strict) throw new Error('Codex CLI not found on PATH. Add the installed Codex CLI directory to PATH and reopen the terminal.');
  log('1/5 ENV', codex.status === 0 ? 'Codex CLI found; authentication is checked on handoff.' : 'Codex CLI not found; other agents can still run. Coding handoffs require Codex on PATH.');
  const tsc = require.resolve('typescript/bin/tsc');
  const vite = path.join(path.dirname(require.resolve('vite/package.json', { paths: [path.join(root, 'apps/desktop')] })), 'bin', 'vite.js');
  const electron = require(require.resolve('electron', { paths: [path.join(root, 'apps/desktop')] }));
  if (!fs.existsSync(electron)) throw new Error('Electron executable is missing. Restore workspace dependencies.');
  const tsx = config.dev ? require.resolve('tsx/cli', { paths: [path.join(root, 'services/orchestrator')] }) : undefined;
  if (!process.argv.includes('--build-only') && config.localAsr?.local && (!config.localAsr.python || !config.localAsr.script) && !config.reuse) throw new Error('Local Whisper selected but its Python environment/server is missing. Set VOICE_PYTHON or install .venv-voice; use --reuse-existing for an already running server, or --text-only for text work.');
  if (process.argv.includes('--check')) {
    log('Launcher', 'Preflight passed. No services started; credentials have not been sent to providers.');
    return;
  }
  if (!process.argv.includes('--build-only')) {
    if (!config.reuse) {
      await assertPortFree(port);
      if (config.voice) await assertPortFree(4500);
    }
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
  if (config.localAsr) await ensureLocalAsr(config.localAsr, config.reuse, [port, 4500, 5173]);
  await ensureService('3/5 ORCHESTRATOR', `${orchestratorUrl}/health`, 'vanessa-orchestrator', port, config.reuse, () => {
    startService('3/5 ORCHESTRATOR', tsx || 'services/orchestrator/dist/server.js', config.dev ? ['watch', 'services/orchestrator/src/server.ts'] : []);
  });
  if (stopping) return;
  if (config.voice) await ensureService('4/5 VOICE', 'http://127.0.0.1:4500/health', 'vanessa-voice-agent', 4500, config.reuse, () => {
    startService('4/5 VOICE', tsx || 'services/voice-agent/dist/server.js', config.dev ? ['watch', 'services/voice-agent/src/server.ts'] : []);
  }, config.strict);
  else log('4/5 VOICE', 'Skipped (--text-only). Microphone is unavailable in this mode.');
  if (stopping) return;
  startService('DESKTOP UI', vite, [...(config.dev ? [] : ['preview']), '--config', 'apps/desktop/vite.config.ts', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
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
  log('5/5 DESKTOP', 'Launching desktop. Enter a command and approve tasks when requested.');
  if (config.strict) log('Codex Test', `Expected: input -> ${config.planner} -> Planner -> awaiting_approval -> approval -> Codex handoff. Terminal launch does not verify coding completion.`);
  log('Launcher', 'Close the desktop or press Ctrl+C to stop owned services. Reused services remain running.');
  await run('DESKTOP', electron, ['.'], path.join(root, 'apps/desktop'));
  shutdown(0, 'Desktop closed. Stopping services started by this launcher.');
}

module.exports = { ensureService };
if (require.main === module) {
  process.on('SIGINT', () => shutdown(0, 'Ctrl+C received. Stopping owned processes.'));
  process.on('SIGTERM', () => shutdown(0, 'Stop requested.'));
  main().catch((error) => shutdown(1, error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ? 'A workspace dependency is missing. Restore dependencies with pnpm install, then relaunch.'
    : error.message));
}
