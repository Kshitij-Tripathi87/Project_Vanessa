#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { launcherConfig } = require("./launcher-config.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 2500;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseEnvFile(filePath) {
  const result = {};
  let source = "";
  try { source = fs.readFileSync(filePath, "utf8"); } catch { return result; }

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[match[1]] = value;
  }
  return result;
}

function getEffectiveEnv(root, inherited = process.env) {
  // The committed .env.example is never loaded as credentials. A developer's
  // root .env overrides inherited values, matching the canonical launcher.
  const configHome = inherited.VANESSA_CONFIG_HOME || root;
  return { ...inherited, ...parseEnvFile(path.join(configHome, ".env")) };
}

function safeMessage(value) {
  return String(value || "")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .slice(0, 800);
}

async function probeOllama(baseUrl, model, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let parsed;
  try { parsed = new URL(baseUrl); } catch {
    return { status: "fail", message: "OLLAMA_BASE_URL is invalid. Use http://127.0.0.1:11434." };
  }

  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return {
      status: "fail",
      message: "The local LLM endpoint must be a loopback HTTP origin. No request was sent to a remote endpoint.",
    };
  }

  let response;
  try {
    response = await fetchImpl(parsed.origin + "/api/tags", {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      status: "fail",
      message: "Local Ollama is not reachable. Start Ollama or rerun Launch-Vanessa.bat to repair the local runtime.",
    };
  }

  if (!response || !response.ok) {
    return {
      status: "fail",
      message: "Local Ollama returned HTTP " + String(response?.status || "unknown") + ". Restart Ollama and rerun diagnostics.",
    };
  }

  let body;
  try { body = await response.json(); } catch {
    return { status: "fail", message: "Local Ollama returned an invalid model list. Restart Ollama and rerun diagnostics." };
  }

  const installed = Array.isArray(body?.models) && body.models.some((item) =>
    item && (item.name === model || item.model === model),
  );
  if (!installed) {
    return {
      status: "fail",
      message: "Ollama is reachable, but the configured local language model is missing. Run Launch-Vanessa.bat to install or repair it.",
    };
  }
  return { status: "pass", message: "Local Ollama and the configured model are ready." };
}

async function probeHttpService(url, service, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS) });
    const body = await response.json();
    if (response.ok && body?.service === service) {
      if (service === "vanessa-voice-agent" && body?.readiness && body.readiness !== "ready") {
        return { status: "warn", message: "Voice service is running but provider readiness is " + String(body.readiness) + ". Inspect the in-app voice diagnostics." };
      }
      return { status: "pass", message: service === "vanessa-orchestrator" ? "Local orchestrator is reachable." : "Local voice service is reachable." };
    }
    if (response.status === 503 && service === "vanessa-voice-agent") {
      return { status: "warn", message: "Voice service is running but not ready. Inspect provider configuration and microphone diagnostics." };
    }
  } catch {
    // Before launch, services normally are not running; absence is informational.
  }
  return { status: "info", message: "Service is not running right now. This is normal before launch; start Vanessa to test the live service." };
}

function pushCheck(checks, id, status, message, remediation) {
  checks.push({ id, status, message: safeMessage(message), ...(remediation ? { remediation } : {}) });
}

async function buildReport(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const platform = options.platform || process.platform;
  const nodeVersion = options.nodeVersion || process.versions.node;
  const exists = options.exists || fs.existsSync;
  const env = options.env || getEffectiveEnv(root);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const pythonProbe = options.pythonProbe || ((pythonPath) => {
    const result = spawnSync(pythonPath, ["-c", "import faster_whisper, numpy, websockets"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  });
  const checks = [];

  pushCheck(
    checks, "platform",
    platform === "win32" ? "pass" : "fail",
    platform === "win32" ? "Windows host detected." : "Vanessa's current desktop launcher supports Windows only.",
    platform === "win32" ? undefined : "Run the Windows setup on a Windows 11 device.",
  );

  const major = Number(String(nodeVersion).split(".")[0]);
  pushCheck(
    checks, "node",
    Number.isInteger(major) && major >= 22 ? "pass" : "fail",
    Number.isInteger(major) && major >= 22 ? "Node.js runtime meets the minimum version." : "Node.js 22 or newer is required.",
    Number.isInteger(major) && major >= 22 ? undefined : "Run Launch-Vanessa.bat to start setup, or install Node.js 22+ and reopen the terminal.",
  );

  const requiredFiles = [
    ["repository", "package.json"],
    ["lockfile", "pnpm-lock.yaml"],
    ["launcher", "Launch-Vanessa.bat"],
    ["setup-script", "scripts/setup_windows.ps1"],
    ["env-template", ".env.example"],
  ];
  for (const [id, relative] of requiredFiles) {
    const found = exists(path.join(root, relative));
    pushCheck(
      checks, id, found ? "pass" : "fail",
      found ? "Required project file is present: " + relative : "Required project file is missing: " + relative,
      found ? undefined : "Restore the complete Vanessa checkout before launching.",
    );
  }

  const configHome = process.env.VANESSA_CONFIG_HOME || root;
  const envFilePresent = exists(path.join(configHome, ".env"));
  pushCheck(
    checks, "configuration-file", envFilePresent ? "pass" : "info",
    envFilePresent ? "Local .env file exists; its values are not displayed by diagnostics." : "Local .env file has not been created yet; first-run setup will create it from .env.example.",
    envFilePresent ? undefined : "Run Launch-Vanessa.bat to initialize the local configuration.",
  );

  let config;
  try {
    config = launcherConfig(env, [], root, exists);
    pushCheck(checks, "provider-selection", "pass", "Selected provider names and required configuration fields are valid.");
  } catch (error) {
    pushCheck(checks, "provider-selection", "fail", safeMessage(error.message), "Correct the provider settings in .env, then run diagnostics again.");
    config = null;
  }

  const requiredPackages = [
    ["workspace-dependencies", "node_modules/dotenv/package.json", "Workspace dependencies are installed."],
    ["electron-runtime", "apps/desktop/node_modules/electron/package.json", "Electron runtime package is installed."],
    ["orchestrator-runtime", "services/orchestrator/node_modules/tsx/package.json", "Orchestrator runtime package is installed."],
  ];
  for (const [id, relative, successMessage] of requiredPackages) {
    const found = exists(path.join(root, relative));
    pushCheck(
      checks, id, found ? "pass" : "fail",
      found ? successMessage : "Required runtime package is missing: " + relative,
      found ? undefined : "Run Launch-Vanessa.bat to reinstall workspace dependencies.",
    );
  }

  if (config) {
    const missing = Array.isArray(config.missing) ? config.missing : [];
    if (missing.length) {
      pushCheck(
        checks, "selected-provider-credentials", "warn",
        "The selected optional provider configuration is incomplete (" + missing.join(", ") + "). Local/text features may still work.",
        "Set only the credentials required by the provider you selected, or choose the default local provider profile. Diagnostic output never includes credential values.",
      );
    } else {
      pushCheck(checks, "selected-provider-credentials", "pass", "The selected providers' required configuration fields are present.");
    }

    if (config.localAsr?.local) {
      const pythonPath = config.localAsr.python || path.join(root, ".venv-voice", "Scripts", "python.exe");
      const pythonExists = exists(pythonPath);
      if (!pythonExists) {
        pushCheck(checks, "local-speech-runtime", "fail", "The local speech Python environment is missing.", "Run Launch-Vanessa.bat to install Python speech dependencies and warm the configured model.");
      } else {
        const importsReady = Boolean(pythonProbe(pythonPath));
        pushCheck(
          checks, "local-speech-runtime", importsReady ? "pass" : "fail",
          importsReady ? "Local Faster-Whisper dependencies can be imported." : "Local speech dependencies are incomplete or the Python runtime failed to start.",
          importsReady ? undefined : "Run Launch-Vanessa.bat to reinstall the local speech dependencies.",
        );
      }
      const serverExists = Boolean(config.localAsr.script && exists(config.localAsr.script));
      pushCheck(
        checks, "local-speech-server", serverExists ? "pass" : "fail",
        serverExists ? "Local ASR server entry point is present." : "Local ASR server entry point is missing.",
        serverExists ? undefined : "Restore services/voice-agent/voice_server.py, then rerun setup.",
      );
    } else {
      pushCheck(checks, "local-speech-runtime", "info", "Local Whisper is not selected for the active ASR provider.");
    }

    if ([config.planner, config.conversation].includes("ollama")) {
      const ollama = await probeOllama(env.OLLAMA_BASE_URL || config.ollamaBaseUrl, env.OLLAMA_MODEL || config.ollamaModel, { fetchImpl });
      pushCheck(checks, "local-llm-runtime", ollama.status, ollama.message, ollama.status === "pass" ? undefined : "Start Ollama, install the configured model, or select a different provider explicitly.");
    } else {
      pushCheck(checks, "local-llm-runtime", "info", "A hosted provider is selected for planning/conversation; no local Ollama probe was made.");
    }
  }

  if (options.live) {
    const port = Number(env.VANESSA_PORT || 4319);
    const voicePort = Number(env.VOICE_AGENT_PORT || 4500);
    const orchestrator = await probeHttpService("http://127.0.0.1:" + port + "/health", "vanessa-orchestrator", { fetchImpl });
    const voice = await probeHttpService("http://127.0.0.1:" + voicePort + "/health", "vanessa-voice-agent", { fetchImpl });
    pushCheck(checks, "orchestrator-live", orchestrator.status, orchestrator.message);
    pushCheck(checks, "voice-live", voice.status, voice.message);
  } else {
    pushCheck(checks, "live-services", "info", "Live service checks were not requested. Add --live while Vanessa is running to check the orchestrator and voice gateway.");
  }

  pushCheck(
    checks, "microphone",
    "info",
    "Microphone permission and actual audio capture can only be confirmed from the running desktop app; this diagnostic does not request microphone access.",
    "Open Vanessa, start voice, speak a short phrase, and confirm a transcript appears. If capture fails, check Windows Settings > Privacy & security > Microphone and the selected input device.",
  );

  const failures = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warn").length;
  const overall = failures ? "blocked" : warnings ? "attention" : "ready";
  return {
    schemaVersion: 1,
    generatedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
    overall,
    summary: {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: warnings,
      fail: failures,
      info: checks.filter((item) => item.status === "info").length,
    },
    checks,
    nextStep: failures
      ? "Run Launch-Vanessa.bat to repair missing local prerequisites, then rerun --doctor."
      : warnings
        ? "Review the warnings. Use --live while Vanessa is running for service checks."
        : "Prerequisites look ready. Launch Vanessa and verify microphone capture from the HUD.",
  };
}

function formatText(report) {
  const symbols = { pass: "[PASS]", warn: "[WARN]", fail: "[FAIL]", info: "[INFO]" };
  const lines = [
    "VANESSA WINDOWS DOCTOR",
    "Overall: " + report.overall.toUpperCase(),
    "",
  ];
  for (const check of report.checks) {
    lines.push((symbols[check.status] || "[INFO]") + " " + check.message);
    if (check.remediation) lines.push("       Next: " + check.remediation);
  }
  lines.push("", report.nextStep);
  lines.push("Privacy: .env values, API keys, transcripts, and audio are not included in this report.");
  return lines.join("\n");
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || console.log;
  const stderr = io.stderr || console.error;
  const has = (arg) => argv.includes(arg);
  const known = new Set(["--doctor", "--json", "--live", "--strict", "--help"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length) {
    stderr("Unknown doctor option(s): " + unknown.join(", ") + ". Supported: --doctor, --json, --live, --strict, --help.");
    return 2;
  }
  if (has("--help")) {
    stdout("Vanessa doctor\nUsage: node scripts/doctor.cjs [--json] [--live] [--strict]\n  --json    Emit machine-readable diagnostics.\n  --live    Check the orchestrator and voice gateway; Vanessa should already be running.\n  --strict  Return non-zero for warnings as well as failures.\n");
    return 0;
  }
  const report = await buildReport({ ...(io.options || {}), live: has("--live") });
  stdout(has("--json") ? JSON.stringify(report, null, 2) : formatText(report));
  return report.summary.fail > 0 || (has("--strict") && report.summary.warn > 0) ? 1 : 0;
}

if (require.main === module) {
  runCli().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Doctor could not complete. Check Node.js, local project files, and try again.");
    process.exitCode = 2;
  });
}

module.exports = { buildReport, formatText, getEffectiveEnv, parseEnvFile, probeHttpService, probeOllama, runCli };
