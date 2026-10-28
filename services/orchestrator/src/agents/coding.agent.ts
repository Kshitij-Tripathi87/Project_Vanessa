import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import { eventBus } from "../core/eventBus.js";
import { repairWorkspaceService, type RepairWorkspace, type RepairWorkspaceService } from "../core/repairWorkspace.js";

const execFileAsync = promisify(execFile);

function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) && fs.existsSync(path.join(current, "packages", "incident-lab", "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate monorepo root from ${start}.`);
}


function isCancellationRequested(task?: { status?: string; lifecycleState?: string }): boolean {
  const status = task?.status as string | undefined;
  const lifecycle = task?.lifecycleState as string | undefined;
  return status === "cancelled" ||
    status === "termination_unconfirmed" ||
    lifecycle === "cancel_requested" ||
    lifecycle === "cancelled" ||
    lifecycle === "termination_unconfirmed";
}

function interruptedPatchResult(
  taskId: string,
  workspace: RepairWorkspace | undefined,
  patchApplied: boolean,
): AgentResult {
  const detail = patchApplied
    ? "Cancellation was observed after the candidate patch was written. The isolated worktree is retained, but patch verification did not complete."
    : "Cancellation was observed before patch write. No repair was applied.";
  return {
    agentId: "coding",
    status: "partial",
    success: false,
    summary: detail,
    spokenSummary: patchApplied
      ? "I stopped after cancellation. A candidate patch remains isolated for review, but I have not verified it."
      : "I stopped before applying the repair because the task was cancelled.",
    error: detail,
    evidence: [{
      description: detail,
      source: "coding.cancellation",
      timestamp: new Date().toISOString(),
      confidence: 1,
      data: {
        taskId,
        cancellationRequested: true,
        patchApplied,
        workspaceId: workspace?.taskId,
        worktreePath: workspace?.worktreePath,
        branch: workspace?.branchName,
        baseCommit: workspace?.baseCommit,
      },
    }],
    artifacts: workspace ? [`worktree:${workspace.worktreePath}`, `branch:${workspace.branchName}`] : [],
    verification: { passed: false, details: detail },
    data: {
      outcome: "inconclusive",
      cancellationRequested: true,
      patchApplied,
      processStarted: false,
      workspaceId: workspace?.taskId,
      workspacePath: workspace?.worktreePath,
      branch: workspace?.branchName,
      baseCommit: workspace?.baseCommit,
    },
  };
}

export class CodingAgent implements SpecialistAgent {
  id = "coding";
  capabilities = [
    "git_inspection",
    "code_analysis",
    "patch_preparation",
    "developer_workspace",
    "diff_synthesis",
  ];
  allowedTools = [
    "git_status",
    "git_diff",
    "git_log",
    "git_checkout",
    "file_read",
    "file_write",
    "apply_patch",
  ];

  private workspaceRoot: string;
  private incidentLabDir: string;

  constructor(private readonly workspaceService: RepairWorkspaceService = repairWorkspaceService) {
    try { this.workspaceRoot = findRepositoryRoot(process.cwd()); }
    catch { this.workspaceRoot = process.cwd(); }
    this.incidentLabDir = path.resolve(this.workspaceRoot, "packages", "incident-lab");
  }

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    switch (action) {
      case "coding.inspect_changes":
      case "coding.analyze_repo":
      case "incident.analyze_repo":
        return this.inspectChanges(params, runCtx);

      case "coding.prepare_patch":
        return this.preparePatch(params, runCtx);

      case "coding.git_status":
        return this.gitStatus(runCtx);

      case "coding.git_diff":
        return this.gitDiff(params.target || "HEAD~1", runCtx);

      default: {
        const reason = `Unregistered coding action '${action}' is blocked.`;
        return {
          agentId: this.id,
          status: "blocked",
          success: false,
          summary: reason,
          spokenSummary: "I blocked an unregistered coding operation before it could inspect or modify files.",
          error: reason,
          evidence: [{
            description: reason,
            source: "coding-agent-dispatch",
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { outcome: "blocked", actionId: action, processStarted: false },
          }],
          artifacts: [],
          verification: { passed: false, details: reason },
          data: { outcome: "blocked", actionId: action, processStarted: false },
        };
      }
    }
  }

  async inspectChanges(params: Record<string, any>, _ctx?: AgentRunContext): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const requested = typeof params.target === "string" ? params.target.replace(/\\/g, "/") : "src/checkout.ts";
    if (!["src/checkout.ts", "packages/incident-lab/src/checkout.ts"].includes(requested)) {
      return { agentId: this.id, status: "blocked", success: false, summary: "Inspection target is not registered.",
        spokenSummary: "I blocked the inspection because its target is not on the allow-list.", error: "Only incident-lab checkout source is registered.",
        evidence: [], artifacts: [], verification: { passed: false, details: "Unregistered inspection target." }, data: { outcome: "blocked", target: requested } };
    }
    const relativeFile = "packages/incident-lab/src/checkout.ts";
    const filePath = path.resolve(this.workspaceRoot, relativeFile);
    if (!fs.existsSync(filePath)) {
      const reason = "The source file is missing; no culprit can be verified.";
      return { agentId: this.id, status: "partial", success: false, summary: reason, spokenSummary: reason,
        evidence: [{ description: reason, source: relativeFile, timestamp: startedAt, confidence: 0 }], artifacts: [],
        verification: { passed: false, details: reason }, data: { outcome: "inconclusive", file: relativeFile } };
    }
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const index = lines.findIndex((line) => !/^\s*\/\//.test(line) && /\bpromo\.discountRate\b/.test(line) && !/\bpromo\?\./.test(line));
    const culpritLine = index < 0 ? undefined : index + 1;
    const snippet = index < 0 ? undefined : lines[index].trim();
    let commitRef = "unavailable";
    try {
      const result = await execFileAsync("git", ["log", "-n", "1", "--pretty=format:%h %s (%an)"], {
        cwd: this.workspaceRoot, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" });
      if (result.stdout.trim()) commitRef = result.stdout.trim();
    } catch { /* metadata absence is not a source-level finding */ }
    const verified = Boolean(culpritLine && snippet);
    const detail = verified ? `Observed an unguarded promo.discountRate access at line ${culpritLine}.`
      : "The current source did not establish the suspected unguarded access.";
    const evidence: AgentEvidence[] = [{ description: detail, source: verified ? `${relativeFile}:L${culpritLine}` : relativeFile,
      timestamp: startedAt, confidence: verified ? 0.95 : 0, data: { file: relativeFile, culpritLine, codeSnippet: snippet, commitReference: commitRef } }];
    return { agentId: this.id, status: verified ? "completed" : "partial", success: verified, summary: detail,
      spokenSummary: verified ? `I found an unguarded optional property access on line ${culpritLine}.` : "I could not establish the suspected defect from the source content.",
      evidence, artifacts: [relativeFile], verification: { passed: verified, details: detail },
      data: { outcome: verified ? "finding_verified" : "inconclusive", file: relativeFile, culpritLine, codeSnippet: snippet, commitReference: commitRef } };
  }

  async preparePatch(params: Record<string, any>, ctx?: AgentRunContext): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const task = ctx?.task;
    const taskId = task?.id || `coding-${randomUUID()}`;
    const unexpectedParams = Object.keys(params || {}).filter((key) => key !== "taskId");
    if (unexpectedParams.length || (params.taskId !== undefined && params.taskId !== taskId)) {
      const reason = "Patch preparation accepts no user-selected target/path/task override.";
      return {
        agentId: this.id, status: "blocked", success: false, summary: reason, spokenSummary: reason,
        error: reason, evidence: [], artifacts: [], verification: { passed: false, details: reason },
        data: { outcome: "blocked", patchApplied: false, processStarted: false },
      };
    }

    // Direct agent invocation is not an authorization path. The one-use task
    // approval must already have been consumed by the orchestrator, with a
    // repository snapshot captured into the approval digest.
    const hasBoundApproval = Boolean(
      task?.action === "coding.prepare_patch" &&
      task.approvalDigest &&
      task.approvalConsumedAt !== undefined &&
      task.approvalPolicyVersion === "trustworthy-execution-v1" &&
      task.approvalExpiresAt !== undefined &&
      task.approvalExpiresAt > Date.now() &&
      task.approvalRepositoryRoot &&
      task.approvalBranch &&
      task.approvalBaseCommit &&
      task.approvalWorkingTreeDigest &&
      task.approvalTarget === "packages/incident-lab/src/checkout.ts" &&
      task.approvalPatchContract === "incident-lab.checkout-promo-null-guard.v1"
    );
    if (!hasBoundApproval) {
      const reason = "Patch preparation was blocked because no valid one-use approval is bound to the repository, base commit, target, and patch contract.";
      return {
        agentId: this.id, status: "blocked", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [{ description: reason, source: "coding.approval-gate", timestamp: startedAt, confidence: 1 }],
        artifacts: [], verification: { passed: false, details: reason }, data: { outcome: "blocked", patchApplied: false },
      };
    }
    const expected = {
      repositoryRoot: task!.approvalRepositoryRoot!,
      branch: task!.approvalBranch!,
      baseCommit: task!.approvalBaseCommit!,
      workingTreeDigest: task!.approvalWorkingTreeDigest!,
      targetRelativePath: task!.approvalTarget!,
      patchContract: task!.approvalPatchContract!,
    };
    let workspace;
    try { workspace = await this.workspaceService.create(taskId, expected); }
    catch (error: any) {
      const reason = typeof error?.message === "string" ? error.message : "Isolated repair workspace could not be created.";
      return { agentId: this.id, status: "blocked", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [{ description: reason, source: "repair-workspace", timestamp: startedAt, confidence: 1, data: { outcome: "blocked" } }],
        artifacts: [], verification: { passed: false, details: reason }, data: { outcome: "blocked", patchApplied: false } };
    }
    if (isCancellationRequested(task)) return interruptedPatchResult(taskId, workspace, false);

    const relativeTarget = "packages/incident-lab/src/checkout.ts";
    const checkoutFile = path.resolve(workspace.worktreePath, relativeTarget);
    if (!fs.existsSync(checkoutFile)) {
      const reason = `Target missing in isolated worktree: ${relativeTarget}`;
      return { agentId: this.id, status: "partial", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [], artifacts: [`worktree:${workspace.worktreePath}`], verification: { passed: false, details: reason },
        data: { outcome: "inconclusive", workspaceId: workspace.taskId, patchApplied: false } };
    }
    const original = fs.readFileSync(checkoutFile, "utf8");
    const targetLine = "const discount = (subtotal * promo.discountRate) / 100;";
    const occurrences = original.split(targetLine).length - 1;
    if (occurrences !== 1) {
      const reason = occurrences === 0 ? "Expected vulnerable source line was not present; no patch was applied." : "Expected source line is ambiguous; patch refused.";
      return { agentId: this.id, status: "partial", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [], artifacts: [`worktree:${workspace.worktreePath}`], verification: { passed: false, details: reason },
        data: { outcome: "inconclusive", workspaceId: workspace.taskId, patchApplied: false, baseCommit: workspace.baseCommit } };
    }
    const replacement = "const discountRate = promo?.discountRate ?? 0;\n  const discount = (subtotal * discountRate) / 100;";
    const patched = original.replace(targetLine, replacement);
    if (patched === original) {
      const reason = "Patch would be a no-op; no repair is reported.";
      return { agentId: this.id, status: "partial", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [], artifacts: [`worktree:${workspace.worktreePath}`], verification: { passed: false, details: reason },
        data: { outcome: "inconclusive", workspaceId: workspace.taskId, patchApplied: false } };
    }
    // Recheck immediately before the first write. No await is allowed between
    // this check and the patch write, so a concurrent cancel cannot slip into
    // this synchronous mutation boundary.
    if (isCancellationRequested(task)) return interruptedPatchResult(taskId, workspace, false);

    try {
      fs.writeFileSync(checkoutFile, patched, "utf8");
      if (fs.readFileSync(checkoutFile, "utf8") !== patched || !patched.includes(replacement)) throw new Error("On-disk readback mismatch.");
    } catch (error: any) {
      const reason = `Patch write/readback failed: ${error?.message || "unknown error"}`;
      return { agentId: this.id, status: "failed", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [], artifacts: [`worktree:${workspace.worktreePath}`], verification: { passed: false, details: reason },
        data: { outcome: "failed", workspaceId: workspace.taskId, patchApplied: false } };
    }
    let diff = "", changedFiles: string[] = [];
    try {
      const diffResult = await execFileAsync("git", ["diff", "--no-ext-diff", "--", relativeTarget], {
        cwd: workspace.worktreePath, timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8" });
      diff = diffResult.stdout;
      if (isCancellationRequested(task)) return interruptedPatchResult(taskId, workspace, true);

      const names = await execFileAsync("git", ["diff", "--name-only"], {
        cwd: workspace.worktreePath, timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" });
      changedFiles = names.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (isCancellationRequested(task)) return interruptedPatchResult(taskId, workspace, true);
    } catch (error: any) {
      const reason = `Patch diff inspection failed: ${error?.message || "unknown error"}`;
      return { agentId: this.id, status: "partial", success: false, summary: reason, spokenSummary: reason, error: reason,
        evidence: [], artifacts: [`worktree:${workspace.worktreePath}`], verification: { passed: false, details: reason },
        data: { outcome: "inconclusive", workspaceId: workspace.taskId, patchApplied: false } };
    }
    const diffHash = createHash("sha256").update(diff).digest("hex");
    const baseCheckoutUnchanged = await this.workspaceService.isBaseCheckoutUnchanged(workspace);
    if (isCancellationRequested(task)) return interruptedPatchResult(taskId, workspace, true);
    const verified = Boolean(diff.trim()) && changedFiles.length === 1 && changedFiles[0] === relativeTarget && baseCheckoutUnchanged;
    const details = verified ? "Patch was read back and independently observed in the isolated worktree diff. Regression tests have not run."
      : "Diff or base-checkout isolation verification failed.";
    const evidence: AgentEvidence[] = [{ description: details, source: `worktree:${workspace.worktreePath}`,
      timestamp: new Date().toISOString(), confidence: verified ? 1 : 0,
      data: { workspaceId: workspace.taskId, worktreePath: workspace.worktreePath, branch: workspace.branchName,
        baseCommit: workspace.baseCommit, targetFile: relativeTarget, diffHash, changedFiles, baseCheckoutUnchanged, diff } }];
    eventBus.emitEvent("audit:log", { id: `audit-${Date.now()}`, timestamp: Date.now(), source: "desktop_hud", agent: this.id,
      action: "coding.prepare_patch", resource: `worktree:${workspace.worktreePath}`, risk: "high", permission: "allowed",
      status: verified ? "success" : "warn",
      result: { workspaceId: workspace.taskId, branch: workspace.branchName, patchApplied: verified, diffHash, baseCheckoutUnchanged }, details });
    return { agentId: this.id, status: verified ? "completed" : "partial", success: verified,
      summary: verified ? `Prepared patch in isolated worktree ${workspace.branchName}; regression tests have not run.` : details,
      spokenSummary: verified ? "The patch is prepared and diff-verified in an isolated worktree. Tests have not yet run." : "The patch could not be independently verified.",
      evidence, artifacts: [`worktree:${workspace.worktreePath}`, `branch:${workspace.branchName}`, relativeTarget],
      verification: { passed: verified, details },
      data: { outcome: verified ? "patch_prepared" : "inconclusive", workspaceId: workspace.taskId, workspacePath: workspace.worktreePath,
        branch: workspace.branchName, baseCommit: workspace.baseCommit, targetFile: relativeTarget, patchApplied: verified,
        diffHash, changedFiles, baseCheckoutUnchanged } };
  }

  async gitStatus(_ctx?: AgentRunContext): Promise<AgentResult> {
    const result = await execFileAsync("git", ["status", "--short"], {
      cwd: this.workspaceRoot, timeout: 5000, windowsHide: true, encoding: "utf8" });
    const status = result.stdout.trim();
    const detail = "Git status was captured from the current repository; this is read-only evidence.";
    return {
      agentId: this.id, status: "completed", success: true, summary: detail, spokenSummary: detail,
      evidence: [{
        description: detail,
        source: "git status --short",
        timestamp: new Date().toISOString(),
        confidence: 1,
        data: { repositoryRoot: this.workspaceRoot, status },
      }],
      artifacts: [],
      verification: { passed: true, details: detail },
      data: { outcome: "status_observed", repositoryRoot: this.workspaceRoot, status },
    };
  }

  async gitDiff(target: string, _ctx?: AgentRunContext): Promise<AgentResult> {
    if (typeof target !== "string" || !target.trim() || target.startsWith("-")) {
      return { agentId: this.id, status: "blocked", success: false, summary: "Invalid diff target.",
        spokenSummary: "I blocked the diff request because its target was invalid.", evidence: [], artifacts: [],
        verification: { passed: false, details: "Invalid diff target." }, data: { outcome: "blocked" } };
    }
    const result = await execFileAsync("git", ["diff", "--no-ext-diff", "--", target], {
      cwd: this.workspaceRoot, timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8" });
    const detail = "A scoped Git diff was captured. A diff being present does not prove the change is correct.";
    return {
      agentId: this.id, status: "completed", success: true, summary: detail, spokenSummary: detail,
      evidence: [{
        description: detail,
        source: `git diff --no-ext-diff -- ${target}`,
        timestamp: new Date().toISOString(),
        confidence: 1,
        data: { repositoryRoot: this.workspaceRoot, target, diff: result.stdout },
      }],
      artifacts: [],
      verification: { passed: true, details: detail },
      data: { outcome: "diff_observed", repositoryRoot: this.workspaceRoot, target, diff: result.stdout },
    };
  }


}

export const codingAgent = new CodingAgent();
