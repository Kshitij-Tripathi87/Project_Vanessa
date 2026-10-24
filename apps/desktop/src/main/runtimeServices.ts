import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const managedChildren = new Map<string, ChildProcess>();
let shuttingDown = false;

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
  process.env.VOICE_AGENT_PORT = "4500";
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
}): Promise<void> {
  if (await serviceHealthy(options.healthUrl, options.serviceIdentity)) {
    console.info("[Vanessa Runtime] Reusing healthy " + options.name + " service.");
    return;
  }

  if (!(await portAvailable(options.port))) {
    throw new Error(options.name + " port " + options.port + " is already in use by a process that did not identify itself as Vanessa.");
  }
  if (!fs.existsSync(options.entryPath)) throw new Error("The packaged " + options.name + " service is missing at " + options.entryPath);

  const childEnvironment = { ...process.env, HOST: "127.0.0.1" };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(process.resourcesPath, "runtime", "node.exe"), [options.entryPath], {
    cwd: options.workingDirectory,
    env: { ...childEnvironment, HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
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

  const orchestratorPort = Number(process.env.VANESSA_PORT || 4139);
  const orchestratorHome = path.join(installRoot, "orchestrator");
  const voiceHome = path.join(installRoot, "voice-agent");
  await startService({
    name: "orchestrator",
    entryPath: path.join(orchestratorHome, "dist", "server.js"),
    workingDirectory: orchestratorHome,
    port: orchestratorPort,
    healthUrl: "http://127.0.0.1:" + orchestratorPort + "/health",
    serviceIdentity: "vanessa-orchestrator",
  });
  await startService({
    name: "voice-agent",
    entryPath: path.join(voiceHome, "dist", "server.js"),
    workingDirectory: voiceHome,
    port: 4500,
    healthUrl: "http://127.0.0.1:4500/health",
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
