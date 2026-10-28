/* Shared Windows launcher. No shell interpolation and no credentials in argv. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
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

function startService(stage, entry, args = [], executable = process.execPath, options = {}) {
  const fatalOnExit = options.fatalOnExit !== false;
  log(stage, 'Starting managed process');
  const child = spawn(executable, [entry, ...args], { cwd: options.cwd || root, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  attachOutput(child, stage);
  child.once('error', (error) => {
    if (fatalOnExit) shutdown(1, `${stage} failed to start.`);
    else log(`${stage} DEGRADED`, `Optional service failed to start (${error.code || "process error"}); desktop and typed commands remain available.`);
  });
  child.once('close', (code) => {
    children.delete(child);
    if (stopping) return;
    if (fatalOnExit) shutdown(1, `${stage} stopped unexpectedly (exit ${code}).`);
    else log(`${stage} DEGRADED`, `Optional service stopped (exit ${code}); desktop and typed commands remain available. Voice can be repaired by restarting Vanessa.`);
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

async function assertOllamaReady(config) {
  if (![config.planner, config.conversation].includes('ollama')) return;
  let parsed;
  try { parsed = new URL(process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl); }
  catch { throw new Error('OLLAMA_BASE_URL is invalid. Use http://127.0.0.1:11434 for local Ollama.'); }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (parsed.protocol !== 'http:' || !localHosts.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('OLLAMA_BASE_URL must be a local loopback HTTP origin, for example http://127.0.0.1:11434. Vanessa will not send local prompts to remote hosts.');
  }
  const model = (process.env.OLLAMA_MODEL || config.ollamaModel || 'qwen2.5:3b').trim();
  let response;
  try { response = await fetch(parsed.origin + '/api/tags', { signal: AbortSignal.timeout(2500) }); }
  catch { throw new Error('Local Ollama is not reachable at ' + parsed.origin + '. Run .\\\\scripts\\\\setup_windows.ps1 or start Ollama, then retry.'); }
  if (!response.ok) throw new Error('Local Ollama returned HTTP ' + response.status + '. Restart Ollama and retry.');
  let body;
  try { body = await response.json(); } catch { throw new Error('Local Ollama returned an invalid model list. Restart Ollama and retry.'); }
  const installed = Array.isArray(body.models) && body.models.some(item => item && item.name === model);
  if (!installed) throw new Error('Local model "' + model + '" is not installed. Run .\\\\scripts\\\\setup_windows.ps1 or execute ollama pull ' + model + '.');
  log('OLLAMA', 'Local model ready: ' + model + '; no provider key required.');
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
  const child = startService('LOCAL ASR', asr.script, [], asr.python, { fatalOnExit: false });
  let processStartError = null;
  child.once('error', (error) => { processStartError = error; });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !stopping) {
    if (processStartError) throw new Error(`Local ASR process could not start: ${processStartError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Local ASR process exited before readiness (exit ${child.exitCode ?? 'signal ' + child.signalCode}).`);
    }
    if (await asrReachable(asr.url)) { log('LOCAL ASR', 'WebSocket ready.'); return; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping) throw new Error('Local ASR did not start within 120 seconds. Check Python dependencies/model download logs.');
}

async function main() {
  if (process.argv.includes('--doctor')) {
    const { runCli } = require(path.join(root, 'scripts', 'doctor.cjs'));
    const args = process.argv.slice(2).filter((arg) => arg !== '--doctor');
    process.exitCode = await runCli(args);
    return;
  }
  if (process.argv.includes('--help')) {
    console.log(`Vanessa Windows launcher
Usage: Launch-Vanessa.bat [options]
  (default)         Build latest code; start orchestrator, configured voice services, and desktop.
  --text-only       Start desktop and orchestrator without voice or Python requirements.
  --dev             Watch orchestrator/voice TypeScript and serve Vite with hot reload.
  --reuse-existing  Reuse healthy orchestrator/voice services; leave them running on exit.
                    Their environment/code may differ. Restart them to pick up changes.
  --codex-test      Require selected LLM/voice credentials and Codex CLI; reject FAKE=1.
  --doctor          Run read-only setup diagnostics; add --live while Vanessa is running.
  --check           Check configuration/dependencies without building or starting services.
  --build-only      Build without starting services or requiring unused ports.
  --help            Show this help.

Root .env is loaded for all managed processes. Existing .env files are never rewritten.
Sarvam, Fish, ElevenLabs, and local voice/whisper providers follow VOICE_ASR_PROVIDER / VOICE_TTS_PROVIDER.
Planning uses PLANNER_PROVIDER; replies use CONVERSATION_PROVIDER (ollama, sarvam, or nvidia). Local Ollama is the default and needs no API key.
Local Whisper uses VOICE_URL and .venv-voice. Run scripts\\setup_windows.ps1 once to provision local models and dependencies. Browser speech synthesis is the no-key TTS fallback.
Cloud providers are optional; configure their keys only when explicitly selecting those providers.
Codex is optional unless --codex-test is selected. Logs are saved in logs/launcher/.
Close the desktop or press Ctrl+C to stop only processes owned by this launcher.
`);
    return;
  }
  if (process.platform !== 'win32') throw new Error('Use this launcher on Windows.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  process.chdir(root);
  const configHome = path.resolve(process.env.VANESSA_CONFIG_HOME || root);
  fs.mkdirSync(configHome, { recursive: true });
  const envPath = path.join(configHome, '.env');
  const dotenv = require('dotenv');
  const hasEnv = fs.existsSync(envPath);
  const parsed = hasEnv ? dotenv.parse(fs.readFileSync(envPath)) : {};
  Object.assign(process.env, parsed);
  secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 6).map(([, value]) => value);
  const logDir = path.join(configHome, 'logs', 'launcher');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, `vanessa-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  log('1/5 ENV', hasEnv ? 'Loaded per-user .env; credentials are not printed.' : 'No per-user .env; first-run setup creates a local profile.');
  if (hasEnv) log('1/5 ENV', `Configuration last changed=${fs.statSync(envPath).mtime.toISOString()}; restart required after edits.`);
  log('Launcher', `Log file: ${logFile}`);
  const config = launcherConfig(process.env, process.argv.slice(2), root, fs.existsSync);
  const workspaceRoot = path.resolve(process.env.VANESSA_WORKSPACE_ROOT || root);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  process.chdir(workspaceRoot);
  // Apply no-key defaults to every managed child process. Explicit settings in
  // the user's .env remain authoritative.
  process.env.VOICE_ASR_PROVIDER ||= config.asr;
  process.env.VOICE_TTS_PROVIDER ||= config.tts;
  process.env.VOICE_TTS_FALLBACK_PROVIDER ||= config.ttsFallback ? 'browser' : 'none';
  process.env.PLANNER_PROVIDER ||= config.planner;
  process.env.CONVERSATION_PROVIDER ||= config.conversation;
  process.env.OLLAMA_BASE_URL ||= config.ollamaBaseUrl;
  process.env.OLLAMA_MODEL ||= config.ollamaModel;
  process.env.VOICE_URL ||= config.localAsr?.url || process.env.WHISPER_URL || 'ws://127.0.0.1:4505';
  process.env.VOICE_MODEL ||= process.env.WHISPER_MODEL || 'base';
  process.env.VOICE_LANGUAGE ||= 'auto';
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
  const installedMode = process.env.VANESSA_INSTALLED_MODE === '1';
  const tsc = installedMode ? undefined : require.resolve('typescript/bin/tsc');
  const vite = path.join(path.dirname(require.resolve('vite/package.json', { paths: [path.join(root, 'apps/desktop')] })), 'bin', 'vite.js');
  const electron = require(require.resolve('electron', { paths: [path.join(root, 'apps/desktop')] }));
  if (!fs.existsSync(electron)) throw new Error('Electron executable is missing. Restore workspace dependencies.');
  const tsx = config.dev ? require.resolve('tsx/cli', { paths: [path.join(root, 'services/orchestrator')] }) : undefined;
  if (!process.argv.includes('--build-only') && config.localAsr?.local && (!config.localAsr.python || !config.localAsr.script) && !config.reuse) throw new Error('Local Whisper selected but its Python environment/server is missing. Set VOICE_PYTHON or install .venv-voice; use --reuse-existing for an already running server, or --text-only for text work.');
  if (!process.argv.includes('--build-only')) await assertOllamaReady(config);
  if (process.argv.includes('--check')) {
    log('Launcher', 'Preflight passed. No services started; no provider credentials are needed for the local default profile.');
    return;
  }
  if (!process.argv.includes('--build-only')) {
    if (!config.reuse) {
      await assertPortFree(port);
      if (config.voice) await assertPortFree(4500);
    }
    await assertPortFree(5173);
  }
  if (installedMode) {
    const requiredOutputs = ['packages/shared/dist/index.js','services/orchestrator/dist/server.js','services/voice-agent/dist/server.js','apps/desktop/dist/main/index.js','apps/desktop/dist/renderer/index.html'];
    const missingOutputs = requiredOutputs.filter((file) => !fs.existsSync(path.join(root, file)));
    if (missingOutputs.length) throw new Error(`Installed build output is missing (${missingOutputs.join(', ')}). Run Vanessa Setup/Repair from the install directory.`);
    log('2/5 BUILD', 'Installed application build is ready; using prebuilt assets.');
  } else {
    log('2/5 BUILD', 'Building shared contracts, orchestrator, voice service, and desktop.');
    for (const project of ['packages/shared', 'services/orchestrator', 'services/voice-agent']) {
      await run(`Build ${project}`, process.execPath, [tsc, '-p', path.join(project, 'tsconfig.json')]);
    }
    fs.copyFileSync(path.join(root, 'services/orchestrator/src/agents/codex-terminal.cjs'), path.join(root, 'services/orchestrator/dist/agents/codex-terminal.cjs'));
    log('2/5 BUILD', 'Codex terminal helper copied to build output.');
    await run('Build desktop types', process.execPath, [tsc, '-p', 'apps/desktop/tsconfig.json']);
    await run('Build desktop main', process.execPath, [tsc, '-p', 'apps/desktop/tsconfig.node.json']);
    await run('Build renderer', process.execPath, [vite, 'build', '--config', 'apps/desktop/vite.config.ts']);
  }
  if (process.argv.includes('--build-only')) {
    log('Launcher', 'Build validation passed. No services started.');
    return;
  }
  if (config.localAsr) {
    try {
      await ensureLocalAsr(config.localAsr, config.reuse, [port, 4500, 5173]);
    } catch (error) {
      if (config.strict) throw error;
      const detail = error instanceof Error ? error.message : 'unknown startup error';
      log('LOCAL ASR DEGRADED', `${detail} Speech input may be unavailable; the desktop and typed commands will continue. Run scripts\\setup_windows.ps1 to repair local speech.`);
    }
  }
  const orchestratorEntry = config.dev ? tsx : path.join(root, 'services/orchestrator/dist/server.js');
  const orchestratorArgs = config.dev ? ['watch', path.join(root, 'services/orchestrator/src/server.ts')] : [];
  await ensureService('3/5 ORCHESTRATOR', `${orchestratorUrl}/health`, 'vanessa-orchestrator', port, config.reuse, () => {
    startService('3/5 ORCHESTRATOR', orchestratorEntry, orchestratorArgs, process.execPath, { cwd: workspaceRoot });
  });
  if (stopping) return;
  if (config.voice) {
    try {
      const voiceEntry = config.dev ? tsx : path.join(root, 'services/voice-agent/dist/server.js');
      const voiceArgs = config.dev ? ['watch', path.join(root, 'services/voice-agent/src/server.ts')] : [];
      await ensureService('4/5 VOICE', 'http://127.0.0.1:4500/health', 'vanessa-voice-agent', 4500, config.reuse, () => {
        startService('4/5 VOICE', voiceEntry, voiceArgs, process.execPath, { fatalOnExit: false, cwd: workspaceRoot });
      }, config.strict);
    } catch (error) {
      if (config.strict) throw error;
      const detail = error instanceof Error ? error.message : 'unknown startup error';
      log('4/5 VOICE DEGRADED', `${detail} The desktop will still launch; typed commands will go directly to the local orchestrator until voice is repaired.`);
    }
  } else log('4/5 VOICE', 'Skipped (--text-only). Microphone is unavailable in this mode.');
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

module.exports = { ensureService, startService };
if (require.main === module) {
  process.on('SIGINT', () => shutdown(0, 'Ctrl+C received. Stopping owned processes.'));
  process.on('SIGTERM', () => shutdown(0, 'Stop requested.'));
  main().catch((error) => shutdown(1, error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ? 'A workspace dependency is missing. Restore dependencies with pnpm install, then relaunch.'
    : error.message));
}
