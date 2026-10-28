import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveManagedAction } from "./actionRegistry.js";
import { repairWorkspaceService } from "./repairWorkspace.js";
import { WINDOWS_JOB_RUNNER_SCRIPT, buildWindowsJobRunnerEnvironment } from "./windowsJobRunner.js";

const execFileAsync = promisify(execFile);

export type ManagedProcessStatus =
  | "exited"
  | "not_started"
  | "spawn_failed"
  | "timed_out"
  | "cancelled"
  | "termination_unconfirmed"
  | "orphaned_processes";

export interface ManagedProcessRequest {
  taskId: string;
  actionId: string;
  executable: string;
  args: string[];
  /** Inputs used to validate the registered action and resolve its managed target. */
  actionParams: Record<string, any>;
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
  /** Actual OS launcher (PowerShell Job Object wrapper on Windows). */
  launcherExecutable?: string;
  launcherArgs?: string[];
  processStarted: boolean;
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

interface StartingReservation {
  taskId: string;
  actionId: string;
  cancelled: boolean;
  claimed: boolean;
  completion: Promise<ManagedProcessResult>;
  resolveCompletion: (result: ManagedProcessResult) => void;
  result?: ManagedProcessResult;
}

interface ManagedEntry {
  request: ManagedProcessRequest;
  child: ChildProcess;
  launcherExecutable: string;
  launcherArgs: string[];
  windowsJobWrapper: boolean;
  runnerStarted: boolean;
  runnerStartProbe: string;
  unverifiedMarkerProbe: string;
  verificationToken: string;
  unverifiedJobTermination: boolean;
  processClosed: boolean;
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

const requireFromOrchestrator = createRequire(import.meta.url);

/**
 * The registered incident-lab runner uses this application's known Node runtime
 * and installed TSX loader, while test source is resolved inside the task
 * worktree. This avoids shell/pnpm wrapper processes and avoids installation
 * scripts or network access in a repair workspace.
 */
export function getIncidentLabTestInvocation(worktreePath: string): { executable: string; args: string[] } {
  if (!path.isAbsolute(worktreePath)) throw new Error("Incident-lab test workspace must be an absolute path.");
  const loaderPath = requireFromOrchestrator.resolve("tsx");
  const testPath = path.resolve(worktreePath, "packages", "incident-lab", "tests", "checkout.test.ts");
  if (!path.isAbsolute(loaderPath) || !path.isAbsolute(testPath)) {
    throw new Error("The registered incident-lab runner paths could not be resolved safely.");
  }
  // ESM loader specifiers must be file URLs on Windows; a raw drive-letter
  // path is parsed as an unsupported URL scheme. file: URLs are also valid on POSIX.
  const loaderUrl = pathToFileURL(loaderPath).href;
  return { executable: process.execPath, args: [`--import=${loaderUrl}`, testPath] };
}

const ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "SYSTEMDRIVE", "ComSpec",
  "TEMP", "TMP", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PSMODULEPATH",
  "PNPM_HOME", "COREPACK_HOME", "CI", "NODE_ENV",
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

function redactOutput(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[REDACTED_SECRET]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*([^\s,;\"']+)/gi, "$1=[REDACTED]");
}


interface WindowsProcessSnapshotEntry {
  pid: number;
  parentPid: number;
}

async function getWindowsProcessSnapshot(): Promise<WindowsProcessSnapshotEntry[] | null> {
  // Query only PID/parent PID. The previous Toolhelp32 + Add-Type path
  // compiled a P/Invoke wrapper on every snapshot and timed out on CI, which
  // correctly forced every normal Windows run to termination_unconfirmed.
  // This fixed, data-only query is bounded; failure remains fail-closed.
  const script = `$ErrorActionPreference = "Stop"
$items = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId }
})
ConvertTo-Json -InputObject $items -Depth 3 -Compress`;
  try {
    const result = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: minimalEnvironment(),
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    const output = result.stdout.trim();
    if (!output) return null;
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const entries = rows.map((row: any) => ({ pid: Number(row?.pid), parentPid: Number(row?.parentPid) }));
    if (
      !entries.length ||
      !entries.every((row: WindowsProcessSnapshotEntry) =>
        Number.isSafeInteger(row.pid) && row.pid > 0 &&
        Number.isSafeInteger(row.parentPid) && row.parentPid >= 0
      )
    ) return null;
    return entries;
  } catch {
    return null;
  }
}

async function getWindowsProcessTree(rootPid: number): Promise<number[] | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  const processes = await getWindowsProcessSnapshot();
  if (!processes) return null;
  const processIds = new Set<number>([rootPid]);
  let previousSize = -1;
  while (previousSize !== processIds.size) {
    previousSize = processIds.size;
    for (const process of processes) {
      if (processIds.has(process.parentPid)) processIds.add(process.pid);
    }
  }
  return [...processIds];
}

async function areWindowsProcessesGone(processIds: number[]): Promise<boolean | null> {
  if (!processIds.length || processIds.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) return null;
  const processes = await getWindowsProcessSnapshot();
  if (!processes) return null;
  const alive = new Set(processes.map((process) => process.pid));
  return processIds.every((pid) => !alive.has(pid));
}

/**
 * Owns subprocess lifecycle for migrated execution paths. This service only
 * accepts executable + argv arrays, uses shell:false, limits inherited
 * environment and output, and keeps an active registry keyed by task ID.
 *
 * POSIX cancellation owns a detached process group and verifies group exit.
 * Windows snapshots descendant PIDs, invokes taskkill as the termination
 * mechanism, and independently verifies that all captured PIDs are absent.
 * If either query or postcondition check fails, termination remains unconfirmed.
 */
export class ProcessSupervisor {
  private readonly active = new Map<string, ManagedEntry>();
  private readonly starting = new Map<string, StartingReservation>();
  private readonly completed = new Map<string, ManagedProcessResult>();

  constructor(private readonly workspaceService = repairWorkspaceService) {}

  listActiveTaskIds(): string[] {
    return [...this.active.keys()];
  }

  listStartingTaskIds(): string[] {
    return [...this.starting.keys()];
  }

  getResult(taskId: string): ManagedProcessResult | undefined {
    return this.active.get(taskId)?.result || this.completed.get(taskId);
  }

  /**
   * Reserves a task ID before an agent enters asynchronous preflight. A cancel
   * received during that window is remembered and must be observed before spawn.
   */
  reserve(taskId: string, actionId: string): void {
    if (!taskId?.trim()) throw new Error("A taskId is required for managed execution.");
    if (actionId !== "testing.run_incident_lab") {
      throw new Error(`No startup reservation is registered for action '${actionId}'.`);
    }
    if (this.active.has(taskId)) throw new Error(`Task ${taskId} already owns a running process.`);
    if (this.completed.has(taskId)) throw new Error(`Task ${taskId} already has a terminal execution result.`);
    const existing = this.starting.get(taskId);
    if (existing) {
      if (existing.actionId !== actionId || existing.claimed) {
        throw new Error(`Task ${taskId} already owns a different or claimed startup reservation.`);
      }
      return;
    }
    let resolveCompletion!: (result: ManagedProcessResult) => void;
    const completion = new Promise<ManagedProcessResult>((resolve) => { resolveCompletion = resolve; });
    this.starting.set(taskId, {
      taskId, actionId, cancelled: false, claimed: false, completion, resolveCompletion,
    });
  }

  /**
   * Resolves a reservation when an agent exits preflight without reaching the
   * process supervisor. If cancellation is pending, this is the proof that no
   * managed process was started for that task.
   */
  releaseReservationIfUnused(taskId: string): void {
    const reservation = this.starting.get(taskId);
    if (!reservation || this.active.has(taskId)) return;
    this.finishBeforeStart(
      reservation,
      reservation.cancelled
        ? "Cancellation was confirmed before process launch; no managed process was started."
        : "The managed action returned before launching a process."
    );
  }

  private finishBeforeStart(reservation: StartingReservation, reason: string): ManagedProcessResult {
    if (reservation.result) return reservation.result;
    const now = new Date().toISOString();
    const cancelled = reservation.cancelled;
    const result: ManagedProcessResult = {
      runId: randomUUID(),
      taskId: reservation.taskId,
      actionId: reservation.actionId,
      status: cancelled ? "cancelled" : "not_started",
      executable: "",
      args: [],
      cwd: "",
      processStarted: false,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancellationRequested: cancelled,
      terminationVerified: true,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      outputDigest: createHash("sha256").update("").digest("hex"),
      error: reason,
    };
    reservation.result = result;
    this.starting.delete(reservation.taskId);
    this.completed.set(reservation.taskId, result);
    reservation.resolveCompletion(result);
    return result;
  }

  async run(request: ManagedProcessRequest): Promise<ManagedProcessResult> {
    if (!request.taskId?.trim()) throw new Error("A taskId is required for managed execution.");
    if (!request.actionId?.trim()) throw new Error("An actionId is required for managed execution.");
    const priorResult = this.completed.get(request.taskId);
    if (priorResult) return priorResult;

    let reservation = this.starting.get(request.taskId);
    if (!reservation) {
      this.reserve(request.taskId, request.actionId);
      reservation = this.starting.get(request.taskId)!;
      reservation.claimed = true;
    } else {
      if (reservation.actionId !== request.actionId) {
        throw new Error("Managed execution action does not match its startup reservation.");
      }
      if (reservation.claimed) {
        throw new Error(`Task ${request.taskId} already claimed its managed execution reservation.`);
      }
      reservation.claimed = true;
    }
    if (reservation.cancelled) {
      return this.finishBeforeStart(reservation, "Cancellation was confirmed before process launch; no managed process was started.");
    }

    try {
      if (!request.executable?.trim() || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")) {
        throw new Error("Managed execution requires an executable and a string argument array.");
      }
      const actionPolicy = resolveManagedAction(request.actionId, request.actionParams || {});
      if (!actionPolicy.managed || actionPolicy.blocked || actionPolicy.canonicalId !== request.actionId) {
        throw new Error(actionPolicy.reason || "The process supervisor only accepts canonical registered actions.");
      }
      if (request.actionId !== "testing.run_incident_lab") {
        throw new Error(`No process executor is registered for action '${request.actionId}'.`);
      }
      const workspaceId = request.actionParams?.workspaceId;
      const expectedDiffHash = request.actionParams?.expectedDiffHash;
      const workspace = typeof workspaceId === "string" ? this.workspaceService.getWorkspace(workspaceId) : undefined;
      if (!workspace || typeof expectedDiffHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedDiffHash)) {
        throw new Error("The registered test runner requires a known worktree and expected SHA-256 patch digest.");
      }
      if (!path.isAbsolute(request.cwd) || !fs.existsSync(request.cwd) || !fs.statSync(request.cwd).isDirectory()) {
        throw new Error("Managed execution cwd must be an existing absolute directory.");
      }
      const cwd = fs.realpathSync(path.resolve(request.cwd));
      if (!path.isAbsolute(cwd)) throw new Error("Invalid canonical working directory.");
      if (cwd !== path.resolve(workspace.worktreePath) || fs.realpathSync(workspace.worktreePath) !== cwd) {
        throw new Error("Process cwd does not match the registered repair worktree.");
      }
      // Promise.all rejects as soon as one command fails, while sibling Git
      // children can continue running. Wait for all bounded preflight children
      // before returning any cancellation/failure result.
      const checks = await Promise.allSettled([
        execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["branch", "--show-current"], { cwd, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["diff", "--no-ext-diff", "--", "packages/incident-lab/src/checkout.ts"], { cwd, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["diff", "--name-only"], { cwd, timeout: 5000, encoding: "utf8" }),
      ]);
      const failedCheck = checks.find((check) => check.status === "rejected");
      if (failedCheck?.status === "rejected") throw failedCheck.reason;
      const [rootResult, headResult, branchResult, diffResult, namesResult] = checks.map((check) => {
        if (check.status !== "fulfilled") throw new Error("A Git preflight command did not settle successfully.");
        return check.value;
      });
      const actualDiffHash = createHash("sha256").update(diffResult.stdout).digest("hex");
      const changedFiles = namesResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (
        path.resolve(rootResult.stdout.trim()) !== cwd ||
        headResult.stdout.trim() !== workspace.baseCommit ||
        branchResult.stdout.trim() !== workspace.branchName ||
        !diffResult.stdout.trim() ||
        changedFiles.length !== 1 ||
        changedFiles[0] !== "packages/incident-lab/src/checkout.ts" ||
        actualDiffHash !== expectedDiffHash ||
        !(await this.workspaceService.isBaseCheckoutUnchanged(workspace))
      ) {
        throw new Error("The target worktree, base commit, changed-file scope, patch digest, or base-checkout invariant failed revalidation.");
      }
      const expectedInvocation = getIncidentLabTestInvocation(workspace.worktreePath);
      if (request.executable !== expectedInvocation.executable || JSON.stringify(request.args) !== JSON.stringify(expectedInvocation.args)) {
        throw new Error("Executable and argv do not match the registered incident-lab test runner.");
      }
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 10 * 60 * 1000) {
        throw new Error("Managed execution timeout must be between 1 ms and 10 minutes.");
      }
      if (this.active.has(request.taskId)) throw new Error(`Task ${request.taskId} already owns a running process.`);
      // The checks above include asynchronous Git reads. Cancellation may have
      // arrived while they were in flight; never cross the spawn boundary then.
      if (reservation.cancelled || reservation.result) {
        return this.finishBeforeStart(reservation, "Cancellation was confirmed before process launch; no managed process was started.");
      }
  
      const normalizedRequest = {
        ...request,
        args: [...request.args],
        cwd,
        maxOutputBytes: Math.min(Math.max(1024, request.maxOutputBytes ?? 256 * 1024), 2 * 1024 * 1024),
      };
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      const runId = randomUUID();
      const verificationToken = randomUUID();
      const windowsJobWrapper = process.platform === "win32";
      const launcherExecutable = windowsJobWrapper ? "powershell.exe" : normalizedRequest.executable;
      const launcherArgs = windowsJobWrapper
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_JOB_RUNNER_SCRIPT]
        : [...normalizedRequest.args];

      let resolveCompletion!: (result: ManagedProcessResult) => void;
      const completion = new Promise<ManagedProcessResult>((resolve) => { resolveCompletion = resolve; });
      let child: ChildProcess;
      try {
        const launchEnv: NodeJS.ProcessEnv = {
          ...minimalEnvironment(),
          VANESSA_EXECUTION_RUN_ID: runId,
        };
        if (windowsJobWrapper) {
          Object.assign(launchEnv, buildWindowsJobRunnerEnvironment(
            normalizedRequest.executable,
            normalizedRequest.args,
            normalizedRequest.cwd,
            runId,
            verificationToken,
          ));
        }
        child = spawn(launcherExecutable, launcherArgs, {
          cwd: normalizedRequest.cwd,
          env: launchEnv,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error: any) {
        const now = Date.now();
        const result: ManagedProcessResult = {
          runId, taskId: normalizedRequest.taskId, actionId: normalizedRequest.actionId,
          status: "spawn_failed", executable: normalizedRequest.executable, args: normalizedRequest.args,
          cwd: normalizedRequest.cwd, launcherExecutable, launcherArgs,
          processStarted: false, startedAt, finishedAt: new Date(now).toISOString(),
          durationMs: now - startedMs, exitCode: null, signal: null, timedOut: false,
          cancellationRequested: false, terminationVerified: true, stdout: "", stderr: "",
          stdoutTruncated: false, stderrTruncated: false,
          outputDigest: createHash("sha256").update("").digest("hex"),
          error: error?.message || "Process spawn failed.",
        };
        reservation.result = result;
        this.starting.delete(normalizedRequest.taskId);
        this.completed.set(normalizedRequest.taskId, result);
        reservation.resolveCompletion(result);
        return result;
      }
  
      const entry: ManagedEntry = {
        request: normalizedRequest, child, launcherExecutable, launcherArgs, windowsJobWrapper,
        runnerStarted: !windowsJobWrapper, runnerStartProbe: "",
        unverifiedMarkerProbe: "", verificationToken, unverifiedJobTermination: false,
        processClosed: false,
        runId, startedMs, startedAt, stdout: [], stderr: [],
        stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
        timedOut: false, cancellationRequested: false, completion, resolveCompletion,
      };
      // Register immediately after spawn and before yielding to any async work.
      // No await occurs between the last cancellation check and this hand-off.
      this.active.set(normalizedRequest.taskId, entry);
      this.starting.delete(normalizedRequest.taskId);
  
      child.stdout?.on("data", (chunk: Buffer | string) => appendBounded(entry, "stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), normalizedRequest.maxOutputBytes!));
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        appendBounded(entry, "stderr", buffer, normalizedRequest.maxOutputBytes!);
        if (entry.windowsJobWrapper) {
          const text = buffer.toString("utf8");
          if (!entry.runnerStarted) {
            entry.runnerStartProbe = (entry.runnerStartProbe + text).slice(-4096);
            if (entry.runnerStartProbe.includes(`VANESSA_JOB_RUNNER_STARTED:${entry.verificationToken}`)) {
              entry.runnerStarted = true;
            }
          }
          entry.unverifiedMarkerProbe = (entry.unverifiedMarkerProbe + text).slice(-8192);
          if (entry.unverifiedMarkerProbe.includes(`VANESSA_JOB_RUNNER_UNVERIFIED:${entry.verificationToken}:`)) {
            entry.unverifiedJobTermination = true;
          }
        }
      });
      child.once("error", (error) => { entry.spawnError = error; });
      let timer: NodeJS.Timeout | undefined;
      child.once("close", (exitCode, signal) => {
        // Node emits all stdio data events before "close". This flag allows a
        // concurrent terminator to inspect wrapper evidence without waiting for
        // finish(), which itself may be awaiting the same termination promise.
        entry.processClosed = true;
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
    } catch (error: any) {
      if (this.starting.get(request.taskId) === reservation && !this.active.has(request.taskId)) {
        this.finishBeforeStart(
          reservation,
          reservation.cancelled
            ? "Cancellation was confirmed before process launch; no managed process was started."
            : error?.message || "Managed execution failed before process launch."
        );
      }
      throw error;
    }
  }

  async cancel(taskId: string, expectedActionId?: string): Promise<ManagedProcessResult | undefined> {
    const entry = this.active.get(taskId);
    if (!entry) {
      const reservation = this.starting.get(taskId);
      if (reservation) {
        if (expectedActionId && expectedActionId !== reservation.actionId) return undefined;
        reservation.cancelled = true;
        // The promise resolves only after run() reaches its pre-spawn check, or
        // the caller releases the reservation after a preflight early return.
        return reservation.completion;
      }
      const previous = this.completed.get(taskId);
      if (previous) return previous;
      if (expectedActionId === "testing.run_incident_lab") {
        this.reserve(taskId, expectedActionId);
        const beforeStart = this.starting.get(taskId)!;
        beforeStart.cancelled = true;
        return this.finishBeforeStart(beforeStart, "Cancellation was requested before process launch; no managed process was started.");
      }
      return undefined;
    }
    if (entry.result?.status === "termination_unconfirmed") {
      entry.result = undefined;
      this.completed.delete(taskId);
      entry.terminatePromise = undefined;
    }
    entry.cancellationRequested = true;
    await this.terminate(entry);
    if (!entry.result) await this.finish(entry, entry.child.exitCode ?? null, entry.child.signalCode ?? null);
    return entry.result || await entry.completion;
  }

  private async terminate(entry: ManagedEntry): Promise<boolean> {
    if (entry.terminatePromise) return entry.terminatePromise;
    entry.terminatePromise = (async () => {
      const pid = entry.child.pid;
      if (!pid) return true;

      if (process.platform === "win32" && entry.windowsJobWrapper) {
        if (entry.result?.terminationVerified === true) return true;
        if (entry.child.exitCode !== null) {
          // Do not await finish() here: finish() may already be awaiting this
          // termination promise. Wait for stdio close so all private wrapper
          // markers have been observed, then make the proof decision directly.
          const closeDeadline = Date.now() + 1500;
          while (Date.now() < closeDeadline && !entry.processClosed) await delay(20);
          if (!entry.processClosed) return false;
          return !entry.unverifiedJobTermination;
        }
        try {
          // The wrapper reads this control message on its own stdin. The
          // registered test process receives NUL as stdin and cannot consume it.
          entry.child.stdin?.write(`CANCEL:${entry.runId}\n`);
        } catch { /* The wrapper may already have exited. */ }

        const cooperativeDeadline = Date.now() + 4500;
        while (Date.now() < cooperativeDeadline && entry.child.exitCode === null) {
          await delay(25);
        }
        if (entry.child.exitCode !== null) {
          // Do not await finish() here: finish() may already be awaiting this
          // termination promise. Wait for stdio close so all private wrapper
          // markers have been observed, then make the proof decision directly.
          const closeDeadline = Date.now() + 1500;
          while (Date.now() < closeDeadline && !entry.processClosed) await delay(20);
          if (!entry.processClosed) return false;
          return !entry.unverifiedJobTermination;
        }

        // If the wrapper does not answer, terminate it. KILL_ON_JOB_CLOSE is
        // the OS backstop; without the cooperative empty-job acknowledgement
        // we still report termination_unconfirmed and retain resource locks.
        try { entry.child.kill(); } catch { /* Already exiting. */ }
        const forcedDeadline = Date.now() + 1000;
        while (Date.now() < forcedDeadline && entry.child.exitCode === null) await delay(25);
        return false;
      }

      if (process.platform === "win32") {
        // Legacy fallback should only be reached by a non-wrapper Windows entry.
        const processIds = await getWindowsProcessTree(pid);
        if (!processIds) return false;
        try {
          await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            env: minimalEnvironment(),
            timeout: 3000,
            maxBuffer: 16 * 1024,
            windowsHide: true,
            encoding: "utf8",
          });
        } catch {
          // A non-zero taskkill result can indicate an exit race; verify the
          // process IDs below instead of trusting taskkill's exit code.
        }
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const gone = await areWindowsProcessesGone(processIds);
          if (gone === true) return true;
          if (gone === null) return false;
          await delay(100);
        }
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
    } else if (entry.windowsJobWrapper) {
      if (entry.unverifiedJobTermination) {
        status = "termination_unconfirmed";
        terminationVerified = null;
        const diagnostic = redactOutput(Buffer.concat(entry.stderr).toString("utf8").trim()).slice(-1200);
        error = diagnostic || "The Windows Job Object wrapper could not verify that every assigned process had exited.";
      } else if (!entry.runnerStarted) {
        status = "spawn_failed";
        terminationVerified = true;
        const diagnostic = redactOutput(Buffer.concat(entry.stderr).toString("utf8").trim()).slice(-1200);
        error = diagnostic
          ? `The Windows Job Object wrapper exited before the registered test executable started. Launcher diagnostic: ${diagnostic}`
          : "The Windows Job Object wrapper exited before the registered test executable started; it did not emit a startup marker.";
      } else {
        // Exit codes other than the reserved 'unverified' code are returned
        // only after the wrapper has confirmed that its Job Object is empty.
        terminationVerified = true;
      }
    } else {
      // A zero exit code is not enough if descendants survived the launcher.
      // Verify the owned process group/tree on every normal exit.
      let hasRemaining: boolean | null;
      if (process.platform === "win32" && entry.child.pid) {
        const processIds = await getWindowsProcessTree(entry.child.pid);
        if (!processIds) {
          hasRemaining = null;
        } else {
          const gone = await areWindowsProcessesGone(processIds);
          hasRemaining = gone === null ? null : !gone;
        }
      } else if (entry.child.pid) {
        hasRemaining = processGroupAlive(entry.child.pid);
      } else {
        hasRemaining = null;
      }
      if (hasRemaining === false) {
        terminationVerified = true;
      } else if (hasRemaining === true) {
        terminationVerified = await this.terminate(entry);
        status = terminationVerified ? "orphaned_processes" : "termination_unconfirmed";
        error = terminationVerified
          ? "The launcher exited with descendant processes still present; the supervisor terminated them. The run is not eligible for success."
          : "The launcher exited with descendant processes still present, and the supervisor could not verify their termination.";
      } else {
        status = "termination_unconfirmed";
        error = "The launcher exited, but the supervisor could not verify that its process tree was gone.";
      }
    }

    // The close handler and timeout/cancel handler can overlap while awaiting
    // termination proof. The first finalizer wins.
    if (entry.result) return;
    const stdoutBuffer = Buffer.concat(entry.stdout);
    const stderrBuffer = Buffer.concat(entry.stderr);
    // Store and hash the same redacted output; never persist raw secrets.
    const stdout = redactOutput(stdoutBuffer.toString("utf8"));
    const rawStderr = stderrBuffer.toString("utf8");
    const stderr = redactOutput(entry.windowsJobWrapper
      ? rawStderr
          .replaceAll(`VANESSA_JOB_RUNNER_STARTED:${entry.verificationToken}`, "")
          .replaceAll(`VANESSA_JOB_RUNNER_UNVERIFIED:${entry.verificationToken}:`, "VANESSA_JOB_RUNNER_UNVERIFIED:")
      : rawStderr);
    const digest = createHash("sha256").update(stdout).update("\\0").update(stderr).digest("hex");
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
      launcherExecutable: entry.launcherExecutable,
      launcherArgs: [...entry.launcherArgs],
      processStarted: entry.windowsJobWrapper ? entry.runnerStarted : entry.child.pid !== undefined,
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
