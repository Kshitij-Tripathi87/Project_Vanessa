import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";

export type ManagedProcessStatus =
  | "exited"
  | "spawn_failed"
  | "timed_out"
  | "cancelled"
  | "termination_unconfirmed";

export interface ManagedProcessRequest {
  taskId: string;
  actionId: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface ManagedProcessResult {
  runId: string;
  taskId: string;
  actionId: string;
  status: ManagedProcessStatus;
  executable: string;
  args: string[];
  cwd: string;
  pid?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancellationRequested: boolean;
  terminationVerified: boolean | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputDigest: string;
  error?: string;
}

interface ManagedEntry {
  request: ManagedProcessRequest;
  child: ChildProcess;
  runId: string;
  startedMs: number;
  startedAt: string;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancellationRequested: boolean;
  spawnError?: Error;
  completion: Promise<ManagedProcessResult>;
  resolveCompletion: (result: ManagedProcessResult) => void;
  terminatePromise?: Promise<boolean>;
  result?: ManagedProcessResult;
}

const ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP",
  "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "PNPM_HOME",
  "COREPACK_HOME", "CI", "NODE_ENV",
] as const;

function minimalEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function appendBounded(entry: ManagedEntry, stream: "stdout" | "stderr", chunk: Buffer, limit: number) {
  const isStdout = stream === "stdout";
  const currentBytes = isStdout ? entry.stdoutBytes : entry.stderrBytes;
  const remaining = Math.max(0, limit - currentBytes);
  const accepted = chunk.subarray(0, remaining);
  if (accepted.length) {
    (isStdout ? entry.stdout : entry.stderr).push(accepted);
  }
  if (isStdout) {
    entry.stdoutBytes += accepted.length;
    if (accepted.length < chunk.length) entry.stdoutTruncated = true;
  } else {
    entry.stderrBytes += accepted.length;
    if (accepted.length < chunk.length) entry.stderrTruncated = true;
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns subprocess lifecycle for migrated execution paths. This service only
 * accepts executable + argv arrays, uses shell:false, limits inherited
 * environment and output, and keeps an active registry keyed by task ID.
 *
 * POSIX cancellation owns a detached process group and verifies group exit.
 * Windows currently uses taskkill as a best-effort containment step but
 * deliberately reports termination_unconfirmed until a Job Object-backed
 * implementation can prove descendant termination.
 */
export class ProcessSupervisor {
  private readonly active = new Map<string, ManagedEntry>();
  private readonly completed = new Map<string, ManagedProcessResult>();

  listActiveTaskIds(): string[] {
    return [...this.active.keys()];
  }

  getResult(taskId: string): ManagedProcessResult | undefined {
    return this.active.get(taskId)?.result || this.completed.get(taskId);
  }

  async run(request: ManagedProcessRequest): Promise<ManagedProcessResult> {
    if (!request.taskId?.trim()) throw new Error("A taskId is required for managed execution.");
    if (!request.actionId?.trim()) throw new Error("An actionId is required for managed execution.");
    if (!request.executable?.trim() || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")) {
      throw new Error("Managed execution requires an executable and a string argument array.");
    }
    if (!path.isAbsolute(request.cwd) || !fs.existsSync(request.cwd) || !fs.statSync(request.cwd).isDirectory()) {
      throw new Error("Managed execution cwd must be an existing absolute directory.");
    }
    const cwd = fs.realpathSync(path.resolve(request.cwd));
    if (!path.isAbsolute(cwd)) throw new Error("Invalid canonical working directory.");
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 10 * 60 * 1000) {
      throw new Error("Managed execution timeout must be between 1 ms and 10 minutes.");
    }
    if (this.active.has(request.taskId)) throw new Error(`Task ${request.taskId} already owns a running process.`);

    const normalizedRequest = {
      ...request,
      args: [...request.args],
      cwd,
      maxOutputBytes: Math.min(Math.max(1024, request.maxOutputBytes ?? 256 * 1024), 2 * 1024 * 1024),
    };
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const runId = randomUUID();

    let resolveCompletion!: (result: ManagedProcessResult) => void;
    const completion = new Promise<ManagedProcessResult>((resolve) => { resolveCompletion = resolve; });
    let child: ChildProcess;
    try {
      child = spawn(normalizedRequest.executable, normalizedRequest.args, {
        cwd: normalizedRequest.cwd,
        env: minimalEnvironment(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      const now = Date.now();
      return {
        runId, taskId: normalizedRequest.taskId, actionId: normalizedRequest.actionId,
        status: "spawn_failed", executable: normalizedRequest.executable, args: normalizedRequest.args,
        cwd: normalizedRequest.cwd, startedAt, finishedAt: new Date(now).toISOString(),
        durationMs: now - startedMs, exitCode: null, signal: null, timedOut: false,
        cancellationRequested: false, terminationVerified: null, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false,
        outputDigest: createHash("sha256").update("").digest("hex"),
        error: error?.message || "Process spawn failed.",
      };
    }

    const entry: ManagedEntry = {
      request: normalizedRequest, child, runId, startedMs, startedAt, stdout: [], stderr: [],
      stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, cancellationRequested: false, completion, resolveCompletion,
    };
    // Register immediately after spawn and before yielding to any async work.
    this.active.set(normalizedRequest.taskId, entry);

    child.stdout?.on("data", (chunk: Buffer | string) => appendBounded(entry, "stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), normalizedRequest.maxOutputBytes!));
    child.stderr?.on("data", (chunk: Buffer | string) => appendBounded(entry, "stderr", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), normalizedRequest.maxOutputBytes!));
    child.once("error", (error) => { entry.spawnError = error; });
    let timer: NodeJS.Timeout | undefined;
    child.once("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      void this.finish(entry, exitCode, signal);
    });

    timer = setTimeout(() => {
      if (!entry.result) {
        entry.timedOut = true;
        void this.terminate(entry).then(async () => {
          // Return a bounded, explicit result even if the OS never emits close.
          // The entry remains registered when the OS cannot prove termination.
          if (!entry.result) await this.finish(entry, entry.child.exitCode ?? null, entry.child.signalCode ?? null);
        }).catch(async () => {
          if (!entry.result) await this.finish(entry, entry.child.exitCode ?? null, entry.child.signalCode ?? null);
        });
      }
    }, normalizedRequest.timeoutMs);
    void completion.finally(() => { if (timer) clearTimeout(timer); });
    return completion;
  }

  async cancel(taskId: string): Promise<ManagedProcessResult | undefined> {
    const entry = this.active.get(taskId);
    if (!entry) return this.completed.get(taskId);
    entry.cancellationRequested = true;
    await this.terminate(entry);
    if (!entry.result) await this.finish(entry, entry.child.exitCode ?? null, entry.child.signalCode ?? null);
    return entry.completion;
  }

  private async terminate(entry: ManagedEntry): Promise<boolean> {
    if (entry.terminatePromise) return entry.terminatePromise;
    entry.terminatePromise = (async () => {
      const pid = entry.child.pid;
      if (!pid) return true;

      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            shell: false, windowsHide: true, stdio: "ignore",
          });
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        });
        // taskkill is an attempt, not proof that every descendant exited.
        return false;
      }

      try { process.kill(-pid, "SIGTERM"); } catch (error: any) {
        if (error?.code === "ESRCH") return true;
      }
      const gracefulDeadline = Date.now() + 600;
      while (Date.now() < gracefulDeadline && processGroupAlive(pid)) await delay(25);
      if (processGroupAlive(pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch (error: any) {
          if (error?.code === "ESRCH") return true;
        }
      }
      const forceDeadline = Date.now() + 1500;
      while (Date.now() < forceDeadline && processGroupAlive(pid)) await delay(25);
      return !processGroupAlive(pid);
    })();
    return entry.terminatePromise;
  }

  private async finish(entry: ManagedEntry, exitCode: number | null, signal: NodeJS.Signals | null) {
    if (entry.result) return;
    let terminationVerified: boolean | null = null;
    let status: ManagedProcessStatus = "exited";
    let error: string | undefined = entry.spawnError?.message;

    // A timeout/cancel handler and the child's close event can race while
    // termination is being verified. The first completed result wins.
    if (entry.result) return;
    if (entry.spawnError) {
      status = "spawn_failed";
    } else if (entry.timedOut || entry.cancellationRequested) {
      terminationVerified = await this.terminate(entry);
      if (!terminationVerified) {
        status = "termination_unconfirmed";
        error = process.platform === "win32"
          ? "Termination was requested, but Windows process-tree termination cannot be verified without Job Object ownership."
          : "The process group still appears to be present after termination escalation.";
      } else {
        status = entry.timedOut ? "timed_out" : "cancelled";
      }
    } else if (exitCode === null) {
      status = "spawn_failed";
      error = error || "The process closed without an exit code.";
    }

    const stdoutBuffer = Buffer.concat(entry.stdout);
    const stderrBuffer = Buffer.concat(entry.stderr);
    const stdout = stdoutBuffer.toString("utf8");
    const stderr = stderrBuffer.toString("utf8");
    const digest = createHash("sha256").update(stdoutBuffer).update("\0").update(stderrBuffer).digest("hex");
    const finishedMs = Date.now();
    const result: ManagedProcessResult = {
      runId: entry.runId,
      taskId: entry.request.taskId,
      actionId: entry.request.actionId,
      status,
      executable: entry.request.executable,
      args: [...entry.request.args],
      cwd: entry.request.cwd,
      pid: entry.child.pid,
      startedAt: entry.startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - entry.startedMs,
      exitCode,
      signal,
      timedOut: entry.timedOut,
      cancellationRequested: entry.cancellationRequested,
      terminationVerified,
      stdout,
      stderr,
      stdoutTruncated: entry.stdoutTruncated,
      stderrTruncated: entry.stderrTruncated,
      outputDigest: digest,
      error,
    };
    entry.result = result;
    this.completed.set(entry.request.taskId, result);
    // An unresolved process remains registered so callers can retry termination
    // and must retain any resource lock associated with that task.
    if (status !== "termination_unconfirmed") this.active.delete(entry.request.taskId);
    entry.resolveCompletion(result);
  }
}

export const processSupervisor = new ProcessSupervisor();
