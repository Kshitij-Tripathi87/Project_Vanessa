import { execFile, spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 as win32Path } from "node:path";
import { promisify } from "node:util";
import { codexDependencies, findCodexCli } from "./codex-launcher.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 8_000;

export interface CodexTaskParams {
  projectPath?: unknown;
  prompt?: unknown;
  expectedBranch?: unknown;
  acceptanceCriteria?: unknown;
  allowedPaths?: unknown;
  timeoutMs?: unknown;
}

export interface CodexProgressEvent {
  taskId: string;
  requestId?: string;
  stage: "preflight" | "started" | "progress" | "completed" | "failed" | "cancelled" | "timed_out";
  message: string;
  eventType?: string;
  timestamp: number;
}

interface CodexWorkspace {
  root: string;
  branch: string;
  dirty: boolean;
}

interface CodexWorkspaceChanges {
  files: string[];
  diffStat: string;
}

interface CodexCli {
  file: string;
  prefix: string[];
}

export interface CodexTaskRunnerDependencies {
  platform: () => string;
  isDirectory: (path: string) => Promise<boolean>;
  inspectWorkspace: (path: string) => Promise<CodexWorkspace>;
  collectWorkspaceChanges: (path: string) => Promise<CodexWorkspaceChanges>;
  resolveCli: () => Promise<CodexCli>;
  spawnProcess: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  terminateProcess: (child: ChildProcess) => void;
  now: () => number;
}

function redact(value: unknown, maxLength = MAX_SUMMARY_CHARS): string {
  return String(value ?? "")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .slice(0, maxLength);
}

function getEventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part: any) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("");
}

function progress(
  options: { taskId: string; requestId?: string; onProgress?: (event: CodexProgressEvent) => void },
  stage: CodexProgressEvent["stage"],
  message: string,
  eventType?: string,
  now = Date.now(),
): void {
  try {
    options.onProgress?.({
      taskId: options.taskId,
      requestId: options.requestId,
      stage,
      message: redact(message, 600),
      eventType,
      timestamp: now,
    });
  } catch {
    // Progress reporting must never take down an active coding task.
  }
}

async function inspectGitWorkspace(projectPath: string): Promise<CodexWorkspace> {
  const runGit = async (args: string[]) => {
    const result = await execFileAsync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout || "").trim();
  };
  const root = await runGit(["rev-parse", "--show-toplevel"]);
  const branch = await runGit(["branch", "--show-current"]);
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"]);
  return { root, branch, dirty: Boolean(status) };
}

async function collectGitWorkspaceChanges(projectPath: string): Promise<CodexWorkspaceChanges> {
  const runGit = async (args: string[]) => {
    const result = await execFileAsync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(result.stdout || "").trim();
  };
  const [tracked, untracked, diffStat] = await Promise.all([
    runGit(["diff", "--name-only", "HEAD"]),
    runGit(["ls-files", "--others", "--exclude-standard"]),
    runGit(["diff", "--stat", "HEAD"]),
  ]);
  const files = [...new Set([...tracked, ...untracked].flatMap((group) => group.split(/\r?\n/)).filter(Boolean))]
    .map((file) => file.replace(/\\/g, "/"))
    .sort((a, b) => a.localeCompare(b));
  return { files, diffStat: redact(diffStat, 8_000) };
}

function findScopeViolations(files: string[], allowedPaths: string[]): string[] {
  const roots = allowedPaths.map((item) => item.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase());
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return !roots.some((root) => normalized === root || normalized.startsWith(root + "/"));
  });
}

function safeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Codex uses its own user-profile authentication. Do not leak Vanessa provider keys,
  // developer .env values, CI tokens, or cloud credentials into the coding subprocess.
  const allowed = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "HOME", "CODEX_HOME", "TERM", "LANG", "LC_ALL",
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (process.platform === "win32" && pid && Number.isSafeInteger(pid)) {
    try {
      const killer = nodeSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => { try { child.kill(); } catch { /* already exited */ } });
      // Do not wait indefinitely for taskkill to return.
      const fallback = setTimeout(() => { try { child.kill(); } catch { /* already exited */ } }, 1_500);
      fallback.unref?.();
      return;
    } catch {
      // Fall through to the child's own termination primitive.
    }
  }
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
}

export const codexTaskRunnerDependencies: CodexTaskRunnerDependencies = {
  platform: () => process.platform,
  isDirectory: async (path) => {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
  },
  inspectWorkspace: inspectGitWorkspace,
  collectWorkspaceChanges: collectGitWorkspaceChanges,
  resolveCli: async () => {
    const cli = await findCodexCli(codexDependencies);
    const help = await codexDependencies.run(cli.file, [...cli.prefix, "exec", "--help"]);
    const helpText = String(help.stdout || "") + "\n" + String(help.stderr || "");
    if (!/--json\b/.test(helpText) || !/--sandbox\b/.test(helpText)) {
      throw new Error("Installed Codex CLI does not advertise both exec --json and --sandbox; update the CLI before using managed coding.");
    }
    return cli;
  },
  spawnProcess: (file, args, options) => nodeSpawn(file, args, options),
  terminateProcess: terminateProcessTree,
  now: () => Date.now(),
};

const activeRuns = new Map<string, AbortController>();

export function cancelCodexTask(taskId: string): boolean {
  const controller = activeRuns.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Runs Codex non-interactively with JSONL progress events. This deliberately
 * reports process completion separately from independent verification: taskRunner
 * will keep a clean exit as partial until tests/postconditions are verified.
 */
export async function runCodexTask(
  params: CodexTaskParams,
  options: {
    taskId?: string;
    requestId?: string;
    onProgress?: (event: CodexProgressEvent) => void;
  } = {},
  deps: CodexTaskRunnerDependencies = codexTaskRunnerDependencies,
): Promise<Record<string, any>> {
  const taskId = options.taskId || "codex-" + String(deps.now());
  const requestId = options.requestId;
  const emit = (stage: CodexProgressEvent["stage"], message: string, eventType?: string) =>
    progress({ taskId, requestId, onProgress: options.onProgress }, stage, message, eventType, deps.now());

  let projectPath = "";
  let activeBranch = "";
  let controller: AbortController | undefined;
  try {
    if (deps.platform() !== "win32") {
      throw new Error("Managed Codex execution currently supports Windows only.");
    }
    if (typeof params.projectPath !== "string" || !params.projectPath.trim() || params.projectPath.includes("\0")) {
      throw new Error("codex.run_task requires an absolute repository projectPath.");
    }
    if (!win32Path.isAbsolute(params.projectPath)) {
      throw new Error("projectPath must be absolute. Select the repository folder in Vanessa first.");
    }
    projectPath = win32Path.resolve(params.projectPath);
    if (typeof params.prompt !== "string" || !params.prompt.trim() || params.prompt.includes("\0")) {
      throw new Error("codex.run_task requires a non-empty prompt without NUL characters.");
    }
    if (params.prompt.length > 20_000) throw new Error("Coding prompt exceeds the 20,000-character limit.");

    const timeoutMs = params.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(params.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("timeoutMs must be an integer between 10000 and 900000.");
    }

    let expectedBranch: string | undefined;
    if (params.expectedBranch !== undefined) {
      if (typeof params.expectedBranch !== "string" || !params.expectedBranch.trim() || params.expectedBranch.length > 200 || /[\r\n\0]/.test(params.expectedBranch)) {
        throw new Error("expectedBranch must be a non-empty branch name of at most 200 characters.");
      }
      expectedBranch = params.expectedBranch.trim();
    }

    const acceptanceCriteria = params.acceptanceCriteria === undefined ? [] : params.acceptanceCriteria;
    if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length > 20 ||
      acceptanceCriteria.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000 || item.includes("\0"))) {
      throw new Error("acceptanceCriteria must be an array of at most 20 non-empty strings (maximum 1,000 characters each).");
    }
    const allowedPaths = params.allowedPaths === undefined ? [] : params.allowedPaths;
    if (!Array.isArray(allowedPaths) || allowedPaths.length > 50 ||
      allowedPaths.some((item) => typeof item !== "string" || !item.trim() || item.length > 260 ||
        win32Path.isAbsolute(item) || item.split(/[\\/]+/).some((part) => part === "..") || item.includes("\0"))) {
      throw new Error("allowedPaths must contain at most 50 repository-relative paths without parent-directory traversal.");
    }
    if (activeRuns.has(taskId)) throw new Error("A managed Codex run already exists for this task ID.");

    controller = new AbortController();
    activeRuns.set(taskId, controller);
    emit("preflight", "Checking repository state before starting Codex.");

    if (!(await deps.isDirectory(projectPath))) throw new Error("The selected project path is not an accessible directory.");
    const workspace = await deps.inspectWorkspace(projectPath);
    if (!workspace.root || win32Path.resolve(workspace.root).toLowerCase() !== projectPath.toLowerCase()) {
      throw new Error("Select the Git repository root, not a nested folder.");
    }
    if (!workspace.branch) throw new Error("The repository is in detached-HEAD state. Check out the intended feature branch first.");
    activeBranch = workspace.branch;
    if (expectedBranch && workspace.branch !== expectedBranch) {
      throw new Error("Expected branch " + expectedBranch + " but found " + workspace.branch + ". No files were changed.");
    }
    if (workspace.dirty) {
      throw new Error("The repository has staged, modified, or untracked files. Commit or stash them before managed coding so existing work is preserved.");
    }
    if (controller.signal.aborted) throw new Error("Managed Codex task was cancelled during preflight.");

    const cli = await deps.resolveCli();
    if (controller.signal.aborted) throw new Error("Managed Codex task was cancelled during preflight.");

    const taskPrompt = [
      "VANESSA MANAGED CODING TASK",
      "Repository root: " + workspace.root,
      "Current branch: " + workspace.branch,
      "User objective:",
      params.prompt,
      "Acceptance criteria:",
      acceptanceCriteria.length ? acceptanceCriteria.map((item: string, index: number) => (index + 1) + ". " + item).join("\n") : "(Use the user's stated completion criteria; do not invent requirements.)",
      "Requested path scope:",
      allowedPaths.length ? allowedPaths.map((item: string) => "- " + item).join("\n") : "(Use the smallest set of files required for the objective.)",
      "Execution rules:",
      "- Work only within the selected repository and current branch.",
      "- Do not commit, push, merge, publish a release, or deploy.",
      "- Do not read or print .env files, provider credentials, auth files, browser profiles, or unrelated personal data.",
      "- Do not expose secrets in output, logs, generated tests, or changed files.",
      "- Do not weaken safety checks or delete unrelated files to make a test pass.",
      "- Keep changes scoped, add regression tests, and report actual commands and exit codes.",
      "- A clean exit is not independent verification. Report tests or acceptance criteria that were not actually verified.",
    ].join("\n\n");

    const args = [
      ...cli.prefix,
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--cd",
      projectPath,
      taskPrompt,
    ];
    emit("started", "Starting Codex in non-interactive JSONL mode on branch " + workspace.branch + ".", "exec.started");

    const completion = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      cancelled: boolean;
      turnCompleted: boolean;
      turnFailed: boolean;
      finalMessage: string;
      errorMessage: string;
      stderr: string;
      spawnError?: string;
    }>((resolveCompletion) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let stdoutBytes = 0;
      let stdoutBuffer = "";
      let stderr = "";
      let timedOut = false;
      let turnCompleted = false;
      let turnFailed = false;
      let finalMessage = "";
      let errorMessage = "";
      let spawnError: string | undefined;
      let exitCode: number | null = null;
      let closeSignal: NodeJS.Signals | null = null;
      let stdoutOverflow = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        resolveCompletion({
          exitCode,
          signal: closeSignal,
          timedOut,
          cancelled: controller?.signal.aborted === true && !timedOut,
          turnCompleted,
          turnFailed,
          finalMessage,
          errorMessage,
          stderr: redact(stderr, MAX_STDERR_CHARS),
          spawnError,
        });
      };

      const onLine = (line: string) => {
        if (!line.trim()) return;
        if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
          stdoutOverflow = true;
          errorMessage = "Codex emitted an oversized JSON event.";
          try { deps.terminateProcess(child); } catch { /* ignore secondary cleanup errors */ }
          return;
        }
        let event: any;
        try { event = JSON.parse(line); } catch {
          // Non-JSON output is not completion evidence and is intentionally not returned.
          return;
        }
        const type = typeof event?.type === "string" ? event.type : "unknown";
        let message = "Codex event: " + type;
        const item = event?.item;
        if (type === "thread.started") message = "Codex thread started.";
        else if (type === "turn.started") message = "Codex is working.";
        else if (type === "item.started") message = "Codex started a " + String(item?.type || "work") + " item.";
        else if (type === "item.completed") {
          if (item?.type === "agent_message") {
            const text = getEventText(item.text ?? item.content ?? item.message);
            if (text.trim()) finalMessage = text.slice(-MAX_SUMMARY_CHARS);
            message = "Codex produced an assistant update.";
          } else if (item?.type === "command_execution") {
            message = "Codex completed a command execution step.";
          } else {
            message = "Codex completed a " + String(item?.type || "work") + " item.";
          }
        } else if (type === "turn.completed") {
          turnCompleted = true;
          if (event?.turn?.status && event.turn.status !== "completed") {
            turnFailed = true;
            errorMessage = "Codex turn ended with status " + String(event.turn.status) + ".";
          }
          message = "Codex turn completed; independent verification is still required.";
        } else if (type === "turn.failed" || type === "error") {
          turnFailed = true;
          errorMessage = getEventText(event?.error?.message ?? event?.message ?? event?.error) || "Codex reported a failed turn.";
          message = "Codex reported a failed turn.";
        }
        emit("progress", message, type);
      };

      const child = deps.spawnProcess(cli.file, args, {
        cwd: projectPath,
        env: safeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.stdout || !child.stderr) {
        errorMessage = "Codex process did not expose output streams.";
        try { deps.terminateProcess(child); } catch { /* ignore */ }
        finish();
        return;
      }

      timeout = setTimeout(() => {
        timedOut = true;
        errorMessage = "Codex exceeded its " + String(timeoutMs) + "ms task deadline.";
        try { deps.terminateProcess(child); } catch { /* ignore */ }
      }, timeoutMs);
      timeout.unref?.();

      controller?.signal.addEventListener("abort", () => {
        try { deps.terminateProcess(child); } catch { /* ignore */ }
      }, { once: true });

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        stdoutBytes += Buffer.byteLength(text, "utf8");
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stdoutOverflow = true;
          errorMessage = "Codex exceeded the 8 MiB JSONL output limit.";
          try { deps.terminateProcess(child); } catch { /* ignore */ }
          return;
        }
        stdoutBuffer += text;
        if (stdoutBuffer.length > MAX_EVENT_LINE_BYTES && !stdoutBuffer.includes("\n")) {
          stdoutOverflow = true;
          errorMessage = "Codex emitted an oversized JSON event.";
          try { deps.terminateProcess(child); } catch { /* ignore */ }
          return;
        }
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) onLine(line);
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + String(chunk)).slice(-MAX_STDERR_CHARS);
      });
      child.once("error", (error) => {
        spawnError = redact(error.message, 1_000);
      });
      child.once("close", (code, close) => {
        exitCode = code;
        closeSignal = close;
        if (stdoutBuffer.trim()) onLine(stdoutBuffer);
        if (stdoutOverflow && !errorMessage) errorMessage = "Codex output exceeded the configured safety limit.";
        finish();
      });
    });

    if (completion.cancelled) {
      emit("cancelled", "Codex was cancelled. Any already-written working-tree changes must be reviewed.");
      return {
        success: false,
        status: "cancelled",
        exitCode: completion.exitCode,
        projectPath,
        error: "Coding task cancelled.",
        spokenSummary: "I cancelled the Codex task. Any changes already made need review.",
      };
    }
    if (completion.timedOut) {
      emit("timed_out", "Codex timed out and the process tree was asked to stop.");
      return {
        success: false,
        status: "timed_out",
        exitCode: completion.exitCode,
        projectPath,
        error: completion.errorMessage || "Codex task timed out.",
        spokenSummary: "Codex timed out. I have not verified the working tree or task outcome.",
      };
    }

    const summary = redact(completion.finalMessage || "", MAX_SUMMARY_CHARS).trim();
    const stderrSummary = redact(completion.stderr, 2_000).trim();
    if (completion.spawnError || completion.turnFailed || completion.exitCode !== 0 || !completion.turnCompleted || !summary) {
      const detail = completion.errorMessage || completion.spawnError ||
        (completion.exitCode !== 0 ? "Codex exited with code " + String(completion.exitCode) + "." : "") ||
        (!completion.turnCompleted ? "Codex ended without a turn.completed event." : "Codex ended without a final assistant message.");
      emit("failed", "Managed Codex task failed: " + detail);
      return {
        success: false,
        status: "failed",
        exitCode: completion.exitCode,
        projectPath,
        error: redact(detail, 2_000),
        stderr: stderrSummary || undefined,
        spokenSummary: "The managed coding task did not complete successfully. I have not reported a fix.",
      };
    }

    let changes: CodexWorkspaceChanges;
    try {
      changes = await deps.collectWorkspaceChanges(projectPath);
    } catch (error) {
      const detail = redact((error as Error)?.message || "Could not inspect the resulting Git diff.", 1_500);
      emit("failed", "Codex ended, but independent working-tree inspection failed: " + detail);
      return {
        success: false,
        status: "failed",
        exitCode: completion.exitCode,
        projectPath,
        branch: activeBranch,
        error: "Codex ended but Vanessa could not inspect the resulting Git diff: " + detail,
        spokenSummary: "Codex stopped, but I could not inspect its changes. I have not reported the task as complete.",
      };
    }

    const scopeViolations = allowedPaths.length ? findScopeViolations(changes.files, allowedPaths as string[]) : [];
    if (scopeViolations.length) {
      const detail = "Changes detected outside the requested path scope: " + scopeViolations.slice(0, 20).join(", ");
      emit("failed", detail);
      return {
        success: false,
        status: "failed",
        exitCode: completion.exitCode,
        projectPath,
        branch: activeBranch,
        changedFiles: changes.files,
        diffSummary: changes.diffStat,
        scopeViolations,
        error: detail + ". Changes were preserved in the working tree; Vanessa did not automatically revert them.",
        spokenSummary: "Codex changed files outside the requested scope. I preserved the changes for review and did not report success.",
      };
    }

    emit("completed", "Codex turn completed with exit code 0. Independent tests and postconditions still need verification.");
    return {
      success: true,
      status: "completed",
      exitCode: completion.exitCode,
      projectPath,
      branch: activeBranch,
      changedFiles: changes.files,
      diffSummary: changes.diffStat,
      output: summary,
      evidence: [{
        description: "Codex emitted turn.completed, exited with code 0, and Vanessa collected the changed-file list. Tests and postconditions remain independently unverified.",
        source: "codex_cli_and_git_diff",
        timestamp: new Date(deps.now()).toISOString(),
        confidence: 0.7,
        data: { changedFiles: changes.files, diffSummary: changes.diffStat },
      }],
      spokenSummary: "Codex finished its turn and I inspected the changed-file list. Tests and task postconditions still need independent verification.",
    };
  } catch (error) {
    const detail = redact((error as Error)?.message || "Managed Codex task failed.", 2_000);
    const cancelled = controller?.signal.aborted === true;
    emit(cancelled ? "cancelled" : "failed", detail);
    return {
      success: false,
      status: cancelled ? "cancelled" : "failed",
      projectPath: projectPath || undefined,
      error: detail,
      spokenSummary: cancelled ? "The managed coding task was cancelled." : "I could not run the managed coding task. No successful result was reported.",
    };
  } finally {
    if (controller) activeRuns.delete(taskId);
  }
}
