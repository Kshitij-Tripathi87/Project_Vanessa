const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const {
  buildReport,
  getEffectiveEnv,
  parseEnvFile,
  probeOllama,
  runCli,
} = require("./doctor.cjs");

const root = path.resolve(__dirname, "..");
const BASE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "Launch-Vanessa.bat",
  ".env.example",
  "scripts/setup_windows.ps1",
  "node_modules/dotenv/package.json",
  "apps/desktop/node_modules/electron/package.json",
  "services/orchestrator/node_modules/tsx/package.json",
  "services/voice-agent/voice_server.py",
  ".venv-voice/Scripts/python.exe",
];

function existsFor(files) {
  const resolved = new Set(files.map((file) => path.resolve(root, file).toLowerCase()));
  return (value) => resolved.has(path.resolve(value).toLowerCase());
}

function localEnv(overrides = {}) {
  return {
    VOICE_ASR_PROVIDER: "whisper",
    VOICE_TTS_PROVIDER: "fish",
    VOICE_ALLOW_FALLBACK: "true",
    VOICE_TTS_FALLBACK_PROVIDER: "browser",
    PLANNER_PROVIDER: "ollama",
    CONVERSATION_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "qwen2.5:3b",
    ...overrides,
  };
}

function dependencies(files = BASE_FILES, overrides = {}) {
  return {
    root,
    platform: "win32",
    nodeVersion: "26.1.0",
    env: localEnv(),
    exists: existsFor(files),
    pythonProbe: () => true,
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:11434/api/tags");
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen2.5:3b" }] }) };
    },
    ...overrides,
  };
}

function findCheck(report, id) {
  const check = report.checks.find((item) => item.id === id);
  assert(check, "Expected check " + id);
  return check;
}

test("first-run doctor passes the no-key local profile without claiming microphone verification", async () => {
  const report = await buildReport(dependencies());
  assert.equal(report.overall, "ready");
  assert.equal(report.summary.fail, 0);
  assert.equal(findCheck(report, "local-speech-runtime").status, "pass");
  assert.equal(findCheck(report, "local-llm-runtime").status, "pass");
  assert.equal(findCheck(report, "selected-provider-credentials").status, "pass");
  assert.equal(findCheck(report, "microphone").status, "info");
  assert.match(findCheck(report, "microphone").message, /only be confirmed from the running desktop app/i);
  assert.equal(findCheck(report, "configuration-file").status, "info", "missing .env is expected before first-run setup");
});

test("doctor reports missing workspace dependencies as actionable blockers", async () => {
  const files = BASE_FILES.filter((file) => file !== "services/orchestrator/node_modules/tsx/package.json");
  const report = await buildReport(dependencies(files));
  assert.equal(report.overall, "blocked");
  assert.equal(findCheck(report, "orchestrator-runtime").status, "fail");
  assert.match(findCheck(report, "orchestrator-runtime").remediation, /reinstall workspace dependencies/i);
});

test("doctor identifies missing local speech imports and server entry point", async () => {
  const files = BASE_FILES.filter((file) => file !== "services/voice-agent/voice_server.py");
  const report = await buildReport(dependencies(files, { pythonProbe: () => false }));
  assert.equal(findCheck(report, "local-speech-runtime").status, "fail");
  assert.equal(findCheck(report, "local-speech-server").status, "fail");
});

test("doctor never sends prompts to a configured remote Ollama endpoint", async () => {
  let calls = 0;
  const report = await buildReport(dependencies(BASE_FILES, {
    env: localEnv({ OLLAMA_BASE_URL: "https://example.com" }),
    fetchImpl: async () => { calls++; throw new Error("must not call remote"); },
  }));
  assert.equal(calls, 0);
  assert.equal(findCheck(report, "local-llm-runtime").status, "fail");
  assert.match(findCheck(report, "local-llm-runtime").message, /loopback HTTP origin/i);
});

test("doctor uses selected hosted providers without probing Ollama or exposing provider keys", async () => {
  const secret = "sk-fish-this-is-a-test-only-key";
  let calls = 0;
  const env = {
    VOICE_ASR_PROVIDER: "sarvam",
    VOICE_TTS_PROVIDER: "sarvam",
    PLANNER_PROVIDER: "sarvam",
    CONVERSATION_PROVIDER: "sarvam",
    SARVAM_API_KEY: secret,
    SARVAM_CHAT_MODEL: "test-chat",
    SARVAM_ASR_MODEL: "saaras:v3-realtime",
    SARVAM_TTS_MODEL: "bulbul:v4-flash",
    SARVAM_TTS_SPEAKER: "test-speaker",
  };
  const report = await buildReport(dependencies(BASE_FILES, {
    env,
    fetchImpl: async () => { calls++; throw new Error("should not call Ollama"); },
  }));
  assert.equal(calls, 0);
  assert.equal(findCheck(report, "local-llm-runtime").status, "info");
  assert.equal(findCheck(report, "selected-provider-credentials").status, "pass");
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("live checks distinguish a stopped stack from a broken prerequisite", async () => {
  const report = await buildReport(dependencies(BASE_FILES, {
    live: true,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen2.5:3b" }] }) };
      throw new Error("service not listening");
    },
  }));
  assert.equal(report.overall, "ready");
  assert.equal(findCheck(report, "orchestrator-live").status, "info");
  assert.equal(findCheck(report, "voice-live").status, "info");
});

test("environment parsing supports normal assignments and keeps credential values out of reports", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-doctor-"));
  try {
    const envPath = path.join(temporary, ".env");
    const secret = "sk-fish-test-secret-value";
    fs.writeFileSync(envPath, [
      "# Comment line",
      "VOICE_ASR_PROVIDER=whisper",
      "OLLAMA_BASE_URL=http://127.0.0.1:11434 # local-only",
      "SARVAM_API_KEY=\"" + secret + "\"",
      "export OLLAMA_MODEL='qwen2.5:3b'",
      "",
    ].join("\n"), "utf8");

    const parsed = parseEnvFile(envPath);
    assert.equal(parsed.VOICE_ASR_PROVIDER, "whisper");
    assert.equal(parsed.OLLAMA_BASE_URL, "http://127.0.0.1:11434");
    assert.equal(parsed.SARVAM_API_KEY, secret);
    assert.equal(parsed.OLLAMA_MODEL, "qwen2.5:3b");

    const effective = getEffectiveEnv(temporary, { TEST_FROM_PROCESS: "one", VOICE_ASR_PROVIDER: "fish" });
    assert.equal(effective.TEST_FROM_PROCESS, "one");
    assert.equal(effective.VOICE_ASR_PROVIDER, "whisper", ".env must override inherited values");
    assert.equal(JSON.stringify({ checks: [{ message: "Provider selected." }] }).includes(secret), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("doctor JSON output has a stable schema and strict mode catches warnings", async () => {
  const output = [];
  const error = [];
  const code = await runCli(["--doctor", "--json", "--strict"], {
    stdout: (value) => output.push(value),
    stderr: (value) => error.push(value),
    options: dependencies(BASE_FILES, {
      env: localEnv({
        VOICE_ASR_PROVIDER: "sarvam",
        SARVAM_API_KEY: "",
        SARVAM_ASR_MODEL: "saaras:v3-realtime",
      }),
    }),
  });
  assert.equal(code, 1);
  assert.equal(error.length, 0);
  const parsed = JSON.parse(output[0]);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(typeof parsed.summary.fail, "number");
  assert(Array.isArray(parsed.checks));
});

test("unknown doctor flags return a usage error instead of being ignored", async () => {
  const errors = [];
  const code = await runCli(["--mystery"], { stderr: (value) => errors.push(value), stdout: () => {} });
  assert.equal(code, 2);
  assert.match(errors[0], /Unknown doctor option/);
});

test("Ollama probe handles model missing and provider failure without leaking errors", async () => {
  const missing = await probeOllama("http://127.0.0.1:11434", "qwen2.5:3b", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) }),
  });
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /language model is missing/i);

  const failed = await probeOllama("http://127.0.0.1:11434", "qwen2.5:3b", {
    fetchImpl: async () => { throw new Error("private endpoint details"); },
  });
  assert.equal(failed.status, "fail");
  assert.doesNotMatch(failed.message, /private endpoint details/);
});
