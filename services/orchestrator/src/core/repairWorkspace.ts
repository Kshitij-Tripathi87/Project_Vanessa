import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepairWorkspace {
  taskId: string;
  repositoryRoot: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  baseBranch: string;
  baseStatus: string;
  createdAt: string;
}

export interface RepairWorkspaceExpectation {
  repositoryRoot: string;
  branch: string;
  baseCommit: string;
  workingTreeDigest: string;
  targetRelativePath: string;
  patchContract: string;
}

export class RepairWorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "REPOSITORY_NOT_FOUND"
      | "BASE_CHECKOUT_DIRTY"
      | "WORKTREE_COLLISION"
      | "WORKTREE_VALIDATION_FAILED"
      | "BASE_CHECKOUT_CHANGED"
      | "GIT_OPERATION_FAILED"
  ) {
    super(message);
    this.name = "RepairWorkspaceError";
  }
}

async function git(cwd: string, args: string[]) {
  try {
    return await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
  } catch (error: any) {
    const detail = typeof error?.stderr === "string" && error.stderr.trim()
      ? error.stderr.trim()
      : error?.message || "unknown git error";
    throw new RepairWorkspaceError(
      `git ${args[0] || "command"} failed: ${detail}`,
      "GIT_OPERATION_FAILED"
    );
  }
}

function safeToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "repair";
}

function isContained(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Creates a task-scoped git worktree without changing the user's checked-out
 * branch, index, tracked files, or untracked files. Dirty base checkouts are
 * rejected rather than silently incorporating user work into a repair.
 *
 * Worktrees live in a dedicated sibling directory outside the base checkout.
 * This avoids polluting the project tree and keeps worktree files out of user
 * source paths. The base checkout must be clean before a repair is created.
 */
export class RepairWorkspaceService {
  private readonly workspaces = new Map<string, RepairWorkspace>();

  constructor(private readonly startDirectory: string = process.cwd()) {}

  getWorkspace(workspaceId: string): RepairWorkspace | undefined {
    if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.includes("/") || workspaceId.includes("\\")) {
      return undefined;
    }
    return this.workspaces.get(workspaceId);
  }

  async create(taskId: string, expected?: RepairWorkspaceExpectation): Promise<RepairWorkspace> {
    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new RepairWorkspaceError("A non-empty task ID is required.", "WORKTREE_VALIDATION_FAILED");
    }
    if (this.workspaces.has(taskId)) {
      throw new RepairWorkspaceError("This task already owns a repair workspace; a new task ID is required.", "WORKTREE_COLLISION");
    }

    let repositoryRoot: string;
    try {
      const rootResult = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.startDirectory,
        windowsHide: true,
        timeout: 5000,
        encoding: "utf8",
      });
      repositoryRoot = path.resolve(rootResult.stdout.trim());
    } catch {
      throw new RepairWorkspaceError(
        `Could not resolve a Git repository from ${this.startDirectory}.`,
        "REPOSITORY_NOT_FOUND"
      );
    }

    const [headResult, branchResult, statusResult, commonDirResult] = await Promise.all([
      git(repositoryRoot, ["rev-parse", "HEAD"]),
      git(repositoryRoot, ["branch", "--show-current"]),
      git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(repositoryRoot, ["rev-parse", "--git-common-dir"]),
    ]);

    const baseCommit = headResult.stdout.trim();
    const baseBranch = branchResult.stdout.trim();
    const baseStatus = statusResult.stdout;
    if (!baseCommit || !baseBranch) {
      throw new RepairWorkspaceError("Base HEAD or branch could not be established.", "WORKTREE_VALIDATION_FAILED");
    }
    if (expected) {
      const actualDigest = createHash("sha256").update(baseStatus).digest("hex");
      if (
        path.resolve(expected.repositoryRoot) !== repositoryRoot ||
        expected.branch !== baseBranch ||
        expected.baseCommit !== baseCommit ||
        expected.workingTreeDigest !== actualDigest ||
        expected.targetRelativePath !== "packages/incident-lab/src/checkout.ts" ||
        expected.patchContract !== "incident-lab.checkout-promo-null-guard.v1"
      ) {
        throw new RepairWorkspaceError(
          "The repository snapshot no longer matches the exact approved repair target and base commit.",
          "WORKTREE_VALIDATION_FAILED"
        );
      }
    }
    if (baseStatus.trim()) {
      throw new RepairWorkspaceError(
        "The base checkout is dirty. Repair was not started; commit or stash user changes, or explicitly choose a clean base.",
        "BASE_CHECKOUT_DIRTY"
      );
    }

    // Git rejects a worktree path nested inside the repository's .git
    // directory. Use a dedicated sibling directory so the base checkout stays
    // clean and worktree metadata/files remain outside user project files.
    const commonDirText = commonDirResult.stdout.trim();
    const commonDir = path.resolve(repositoryRoot, commonDirText);
    const parentDirectory = path.dirname(repositoryRoot);
    const repositoryName = safeToken(path.basename(repositoryRoot));
    const worktreesRoot = path.resolve(parentDirectory, `.vanessa-${repositoryName}-repair-worktrees`);
    await fs.mkdir(worktreesRoot, { recursive: true });
    const realWorktreesRoot = await fs.realpath(worktreesRoot);
    if (
      !isContained(parentDirectory, realWorktreesRoot) ||
      isContained(repositoryRoot, realWorktreesRoot) ||
      path.resolve(realWorktreesRoot) !== realWorktreesRoot
    ) {
      throw new RepairWorkspaceError("Managed worktree root escaped the approved sibling directory.", "WORKTREE_VALIDATION_FAILED");
    }

    const taskToken = safeToken(taskId);
    const nonce = randomUUID().slice(0, 12);
    const branchName = `vanessa/repair/${taskToken}-${nonce}`;
    const worktreePath = path.resolve(realWorktreesRoot, `task-${taskToken}-${nonce}`);
    if (!isContained(realWorktreesRoot, worktreePath)) {
      throw new RepairWorkspaceError("Resolved worktree path escapes the managed root.", "WORKTREE_VALIDATION_FAILED");
    }
    try {
      await fs.lstat(worktreePath);
      throw new RepairWorkspaceError("Task worktree path already exists; refusing to reuse it.", "WORKTREE_COLLISION");
    } catch (error: any) {
      if (error instanceof RepairWorkspaceError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }

    await git(repositoryRoot, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);

    const [worktreeRootResult, worktreeHeadResult, worktreeBranchResult, worktreeStatusResult] = await Promise.all([
      git(worktreePath, ["rev-parse", "--show-toplevel"]),
      git(worktreePath, ["rev-parse", "HEAD"]),
      git(worktreePath, ["branch", "--show-current"]),
      git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);

    const actualWorktreeRoot = path.resolve(worktreeRootResult.stdout.trim());
    const actualHead = worktreeHeadResult.stdout.trim();
    const actualBranch = worktreeBranchResult.stdout.trim();
    if (
      actualWorktreeRoot !== worktreePath ||
      actualHead !== baseCommit ||
      actualBranch !== branchName ||
      worktreeStatusResult.stdout.trim()
    ) {
      throw new RepairWorkspaceError(
        "Git worktree did not match the expected root, branch, base commit, and clean status.",
        "WORKTREE_VALIDATION_FAILED"
      );
    }

    const unchanged = await this.isBaseCheckoutUnchanged({
      taskId,
      repositoryRoot,
      worktreePath,
      branchName,
      baseCommit,
      baseBranch,
      baseStatus,
      createdAt: new Date().toISOString(),
    });
    if (!unchanged) {
      throw new RepairWorkspaceError(
        "The base checkout changed while the repair workspace was being created.",
        "BASE_CHECKOUT_CHANGED"
      );
    }

    const workspace: RepairWorkspace = {
      taskId,
      repositoryRoot,
      worktreePath,
      branchName,
      baseCommit,
      baseBranch,
      baseStatus,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(taskId, workspace);
    return workspace;
  }

  async isBaseCheckoutUnchanged(workspace: RepairWorkspace): Promise<boolean> {
    try {
      const [headResult, branchResult, statusResult, rootResult] = await Promise.all([
        git(workspace.repositoryRoot, ["rev-parse", "HEAD"]),
        git(workspace.repositoryRoot, ["branch", "--show-current"]),
        git(workspace.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
        git(workspace.repositoryRoot, ["rev-parse", "--show-toplevel"]),
      ]);
      return (
        path.resolve(rootResult.stdout.trim()) === workspace.repositoryRoot &&
        headResult.stdout.trim() === workspace.baseCommit &&
        branchResult.stdout.trim() === workspace.baseBranch &&
        statusResult.stdout === workspace.baseStatus
      );
    } catch {
      return false;
    }
  }
}

export const repairWorkspaceService = new RepairWorkspaceService();
