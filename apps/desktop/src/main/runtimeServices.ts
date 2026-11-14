import { app } from "electron";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { applyOrchestratorRuntimeUrls, resolveOrchestratorPort, resolveVoiceAgentPort } from "./runtimeConfig.js";
import { RemotePcIdentityStore, type RemotePcIdentity } from "./remotePcIdentityStore.js";
import { ElectronPcIdentityEncryption } from "./electronRemoteIdentityStore.js";

const managedChildren = new Map<string, ChildProcess>();
let shuttingDown = false;
let remoteAdminToken: string | undefined;

export function getRemoteAdminToken(): string | undefined {
  return remoteAdminToken;
}

export function parseEnvironmentFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.includes('"', 1)) || (value.startsWith("'") && value.includes("'", 1))) {
      const quote = value[0];
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

/** Load settings from the per-user file without overwriting inherited deployment variables. */
export function loadUserEnvironment(): string {
  const userDataPath = app.getPath("userData");
  const envPath = path.join(userDataPath, ".env");
  fs.mkdirSync(userDataPath, { recursive: true });

  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(process.resourcesPath, "vanessa.env.example");
    if (fs.existsSync(examplePath)) fs.copyFileSync(examplePath, envPath);
    else fs.writeFileSync(envPath, "# Vanessa user configuration\n# Add provider keys here, then restart the app.\n", "utf8");
  }

  if (fs.existsSync(envPath)) {
    const values = parseEnvironmentFile(fs.readFileSync(envPath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined || process.env[key]?.trim() === "") process.env[key] = value;
    }
  }

  // These services are intentionally bound to loopback in a desktop install.
  process.env.HOST = "127.0.0.1";
  if (!process.env.VOICE_AGENT_PORT?.trim()) process.env.VOICE_AGENT_PORT = "4500";
  if (!process.env.VANESSA_PORT?.trim()) process.env.VANESSA_PORT = "4319";
  return envPath;
}

function copyMissing(sourcePath: string, destinationPath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const name of fs.readdirSync(sourcePath)) {
      copyMissing(path.join(sourcePath, name), path.join(destinationPath, name));
    }
    return;
  }
  if (!fs.existsSync(destinationPath)) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function runExecutable(file: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || "Command failed").trim().slice(0, 500);
        reject(new Error(detail));
      } else {
        resolve(String(stdout || ""));
      }
    });
  });
}

/**
 * Configure the v2 WSS ingress only after the user explicitly enables remote
 * access. Tailscale Serve proxies to the localhost-only gateway; we never bind
 * the orchestrator to a network interface or start Funnel.
 */
async function configureTailscaleRemoteIngress(): Promise<string | undefined> {
  if (process.env.VANESSA_REMOTE_V2_ENABLED !== "true") return undefined;

  const candidates = [
    process.env.TAILSCALE_CLI_PATH,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
    "tailscale.exe",
    "tailscale",
  ].filter((value): value is string => Boolean(value?.trim()));

  let lastError: unknown;
  for (const executable of [...new Set(candidates)]) {
    try {
      const rawStatus = await runExecutable(executable, ["status", "--json"]);
      const status = JSON.parse(rawStatus) as {
        BackendState?: string;
        Self?: { DNSName?: string };
      };
      if (status.BackendState !== "Running") {
        throw new Error("Tailscale is not connected. Sign in to the same tailnet on both devices.");
      }
      const dnsName = status.Self?.DNSName?.replace(/\\.$/, "").trim();
      if (!dnsName || !/^[a-zA-Z0-9.-]+$/.test(dnsName)) {
        throw new Error("Tailscale did not report a valid MagicDNS name for this Windows PC.");
      }
      // Serve is private to this tailnet, provides TLS, and proxies WebSocket
      // upgrades to the loopback HTTP listener.
      await runExecutable(executable, [
        "serve", "--bg", "--set-path=/remote-v2", "http://127.0.0.1:4321",
      ]);
      const url = "wss://" + dnsName + "/remote-v2";
      process.env.VANESSA_REMOTE_V2_PUBLIC_URL = url;
      console.info("[Vanessa Remote v2] Tailscale Serve configured for " + url);
      return url;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(
    "[Vanessa Remote v2] Tailscale Serve could not be configured. The gateway remains loopback-only; " +
    (lastError instanceof Error ? lastError.message : "Install/sign in to Tailscale and retry."),
  );
  return undefined;
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function serviceHealthy(url: string, expectedService: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const body = await response.json() as { service?: string };
    return body.service === expectedService;
  } catch {
    return false;
  }
}

function appendServiceLogs(name: string, child: ChildProcess): void {
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, name + ".log");
    const output = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(output);
    child.stderr?.pipe(output);
    child.once("close", () => output.end());
  } catch {
    child.stdout?.resume();
    child.stderr?.resume();
  }
}

async function startService(options: {
  name: string;
  entryPath: string;
  workingDirectory: string;
  port: number;
  healthUrl: string;
  serviceIdentity: string;
  startupTimeoutMs?: number;
  remoteIdentity?: RemotePcIdentity;
}): Promise<void> {
  if (await serviceHealthy(options.healthUrl, options.serviceIdentity)) {
    console.info("[Vanessa Runtime] Reusing healthy " + options.name + " service.");
    return;
  }

  if (!(await portAvailable(options.port))) {
    throw new Error(options.name + " port " + options.port + " is already in use by a process that did not identify itself as Vanessa.");
  }
  if (!fs.existsSync(options.entryPath)) throw new Error("The packaged " + options.name + " service is missing at " + options.entryPath);

  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, HOST: "127.0.0.1" };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(process.resourcesPath, "runtime", "node.exe"), [options.entryPath], {
    cwd: options.workingDirectory,
    env: {
      ...childEnvironment,
      HOST: "127.0.0.1",
      ...(options.remoteIdentity ? {
        VANESSA_REMOTE_V2_ENABLED: "true",
        VANESSA_REMOTE_PC_KEY_ID: options.remoteIdentity.keyId,
        VANESSA_REMOTE_PC_PUBLIC_KEY: options.remoteIdentity.publicKeySpki,
        VANESSA_REMOTE_LOCAL_ADMIN_TOKEN: remoteAdminToken,
        VANESSA_REMOTE_DEVICE_STORE: path.join(app.getPath("userData"), "remote-v2", "trusted-devices.json"),
      } : { VANESSA_REMOTE_V2_ENABLED: "false" }),
    },
    stdio: options.remoteIdentity ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  if (options.remoteIdentity) {
    const identity = options.remoteIdentity;
    child.on("message", (rawMessage: unknown) => {
      if (!rawMessage || typeof rawMessage !== "object") return;
      const request = rawMessage as { type?: string; requestId?: string; envelope?: unknown };
      if (request.type !== "vanessa.remote.sign" || typeof request.requestId !== "string" || !request.envelope) return;
      void (async () => {
        try {
          const protocol = await import("@vanessa/protocol");
          const candidate = request.envelope as Record<string, unknown>;
          const parsed = protocol.safeParseRemoteEnvelope({
            ...candidate,
            auth: { algorithm: "ES256", signature: "AAAAAAAAAAAAAAAA" },
          });
          if (!parsed.success || parsed.data.keyId !== identity.keyId) {
            throw new Error("PC signer rejected an invalid or foreign-key envelope.");
          }
          const direction = protocol.REMOTE_MESSAGE_DIRECTIONS[parsed.data.type];
          if (direction === "client_to_server") {
            throw new Error("PC signer cannot sign a client-to-server protocol message.");
          }
          const { auth: _unsignedAuth, ...unsigned } = parsed.data;
          const envelope = protocol.signRemoteEnvelope(identity.privateKey, unsigned);
          if (child.connected) child.send({ type: "vanessa.remote.sign.response", requestId: request.requestId, envelope });
        } catch (error) {
          if (child.connected) child.send({
            type: "vanessa.remote.sign.response",
            requestId: request.requestId,
            error: error instanceof Error ? error.message.slice(0, 200) : "PC signature failed.",
          });
        }
      })();
    });
  }
  managedChildren.set(options.name, child);
  appendServiceLogs(options.name, child);

  let exitedError: Error | null = null;
  child.once("error", (error) => { exitedError = error; });
  child.once("exit", (code, signal) => {
    managedChildren.delete(options.name);
    if (!shuttingDown) {
      console.error("[Vanessa Runtime] " + options.name + " exited unexpectedly (code=" + code + ", signal=" + signal + "). Restarting in 2 seconds.");
      setTimeout(() => {
        if (!shuttingDown) void startService(options).catch((error) => {
          console.error("[Vanessa Runtime] Could not restart " + options.name + ":", error instanceof Error ? error.message : String(error));
        });
      }, 2000);
    }
  });

  const deadline = Date.now() + (options.startupTimeoutMs || 30000);
  while (Date.now() < deadline && !shuttingDown) {
    if (exitedError) throw exitedError;
    if (child.exitCode !== null) {
      throw new Error(options.name + " stopped during startup (exit code " + child.exitCode + "). Check " + options.name + ".log.");
    }
    if (await serviceHealthy(options.healthUrl, options.serviceIdentity)) {
      console.info("[Vanessa Runtime] " + options.name + " is healthy.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!shuttingDown) throw new Error(options.name + " did not become healthy in time. Check " + path.join(app.getPath("userData"), "logs", options.name + ".log"));
}

/** Start packaged backend services from isolated, production-only pnpm deploys. */
export async function startPackagedServices(): Promise<void> {
  if (!app.isPackaged || process.platform !== "win32") return;

  const resourceRuntime = path.join(process.resourcesPath, "runtime");
  const metadataPath = path.join(resourceRuntime, "build-meta.json");
  if (!fs.existsSync(metadataPath)) throw new Error("Packaged backend metadata is missing. Rebuild Vanessa from a desktop-release workflow.");

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { buildId?: string };
  const buildId = String(metadata.buildId || app.getVersion()).replace(/[^A-Za-z0-9._-]/g, "_");
  const userRuntime = path.join(app.getPath("userData"), "runtime");
  const installRoot = path.join(userRuntime, app.getVersion() + "-" + buildId);
  fs.mkdirSync(installRoot, { recursive: true });

  for (const service of ["orchestrator", "voice-agent"]) {
    const packagedService = path.join(resourceRuntime, service);
    const installedService = path.join(installRoot, service);
    if (!fs.existsSync(packagedService)) throw new Error("Missing packaged runtime files for " + service + ".");
    if (!fs.existsSync(path.join(installedService, "dist", "server.js"))) {
      fs.rmSync(installedService, { recursive: true, force: true });
      fs.cpSync(packagedService, installedService, { recursive: true });
    }
  }

  // Copy bundled defaults only when absent so users can add personal skills
  // and config in their writable profile without the installed app overwriting it.
  copyMissing(path.join(resourceRuntime, "skills"), path.join(userRuntime, "skills"));
  copyMissing(path.join(resourceRuntime, "config"), path.join(installRoot, "orchestrator", "config"));

  const orchestratorPort = resolveOrchestratorPort(process.env);
  const voiceAgentPort = resolveVoiceAgentPort(process.env);
  let remoteIdentity: RemotePcIdentity | undefined;
  remoteAdminToken = undefined;
  if (process.env.VANESSA_REMOTE_V2_ENABLED === "true") {
    try {
      const identityStore = new RemotePcIdentityStore(
        path.join(app.getPath("userData"), "remote-v2", "pc-identity.json"),
        new ElectronPcIdentityEncryption(),
      );
      remoteIdentity = await identityStore.loadOrCreate();
      remoteAdminToken = randomBytes(32).toString("base64url");
      process.env.VANESSA_REMOTE_PC_KEY_ID = remoteIdentity.keyId;
      process.env.VANESSA_REMOTE_PC_PUBLIC_KEY = remoteIdentity.publicKeySpki;
      process.env.VANESSA_REMOTE_LOCAL_ADMIN_TOKEN = remoteAdminToken;
      process.env.VANESSA_REMOTE_DEVICE_STORE = path.join(app.getPath("userData"), "remote-v2", "trusted-devices.json");
      console.info("[Vanessa Remote v2] OS-protected PC identity ready.");
    } catch (error) {
      process.env.VANESSA_REMOTE_V2_ENABLED = "false";
      console.error("[Vanessa Remote v2] Identity unavailable; remote pairing remains disabled:", error);
    }
  }
  if (remoteIdentity) await configureTailscaleRemoteIngress();
  process.env.VANESSA_PORT = String(orchestratorPort);
  process.env.VOICE_AGENT_PORT = String(voiceAgentPort);
  // Keep both voice-agent call sites aligned with the packaged orchestrator
  // port. Without this, voice sessions silently fall back to 4319 when the
  // user has selected another valid VANESSA_PORT.
  applyOrchestratorRuntimeUrls(process.env);
  const orchestratorHome = path.join(installRoot, "orchestrator");
  const voiceHome = path.join(installRoot, "voice-agent");
  await startService({
    name: "orchestrator",
    entryPath: path.join(orchestratorHome, "dist", "server.js"),
    workingDirectory: orchestratorHome,
    port: orchestratorPort,
    healthUrl: "http://127.0.0.1:" + orchestratorPort + "/health",
    serviceIdentity: "vanessa-orchestrator",
    ...(remoteIdentity ? { remoteIdentity } : {}),
  });
  await startService({
    name: "voice-agent",
    entryPath: path.join(voiceHome, "dist", "server.js"),
    workingDirectory: voiceHome,
    port: voiceAgentPort,
    healthUrl: "http://127.0.0.1:" + voiceAgentPort + "/health",
    serviceIdentity: "vanessa-voice-agent",
  });
}

export function stopPackagedServices(): void {
  shuttingDown = true;
  for (const [name, child] of managedChildren) {
    try {
      if (child.exitCode === null && child.pid) child.kill("SIGTERM");
    } catch (error) {
      console.warn("[Vanessa Runtime] Could not stop " + name + ":", error);
    }
  }
  managedChildren.clear();
}
