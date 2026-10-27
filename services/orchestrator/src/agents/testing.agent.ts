import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import { eventBus } from "../core/eventBus.js";
import { processSupervisor, type ManagedProcessResult } from "../core/processSupervisor.js";
import { repairWorkspaceService, type RepairWorkspace } from "../core/repairWorkspace.js";

const execFileAsync = promisify(execFile);

const INCIDENT_LAB_SUITE_ID = "incident-lab.regression";

export interface RegressionSummary {
  passed: number;
  total: number;
}

export function parseRegressionSummary(output: string): RegressionSummary | null {
  const match = output.match(/ALL REGRESSION TESTS PASSED\s*\((\d+)\s*\/\s*(\d+)\)/);
  if (!match) return null;
  const passed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || total < 1 || passed !== total) return null;
  return { passed, total };
}

export function validateRegressionRequest(params: Record<string, any>):
  | { valid: true; suiteId: string; workspaceId: string; expectedDiffHash: string }
  | { valid: false; reason: string } {
  if (Object.prototype.hasOwnProperty.call(params, "command")) {
    return { valid: false, reason: "Free-form command execution is not accepted by the testing agent. Use a registered suiteId." };
  }
  const unknown = Object.keys(params).filter((key) => !["suiteId", "workspaceId", "expectedDiffHash"].includes(key));
  if (unknown.length) return { valid: false, reason: `Unsupported testing parameter(s): ${unknown.join(", ")}` };
  if (params.suiteId !== INCIDENT_LAB_SUITE_ID) {
    return { valid: false, reason: `Unknown or missing test suite. Registered suite: ${INCIDENT_LAB_SUITE_ID}.` };
  }
  if (typeof params.workspaceId !== "string" || !params.workspaceId.trim() || /[\\/]/.test(params.workspaceId)) {
    return { valid: false, reason: "A registered workspaceId is required; arbitrary workspace paths are not accepted." };
  }
  if (typeof params.expectedDiffHash !== "string" || !/^[a-f0-9]{64}$/i.test(params.expectedDiffHash)) {
    return { valid: false, reason: "The expected patch digest is missing or malformed." };
  }
  return { valid: true, suiteId: INCIDENT_LAB_SUITE_ID, workspaceId: params.workspaceId, expectedDiffHash: params.expectedDiffHash };
}

function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(current, "pnpm-workspace.yaml")) &&
      fs.existsSync(path.join(current, "packages", "incident-lab", "package.json"))
    ) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate monorepo root from ${start}; testing was not started.`);
}

function diagnosticOutput(result: ManagedProcessResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-20000);
}

export class TestingAgent implements SpecialistAgent {
  id = "testing";
  capabilities = [
    "test_execution",
    "acceptance_verification",
    "regression_testing",
    "safety_policy_enforcement",
  ];
  allowedTools = ["test_run", "test_report", "assertion_verify", "regression_check"];

  private workspaceRoot: string;

  constructor() {
    try {
      this.workspaceRoot = findRepositoryRoot(process.cwd());
    } catch {
      // Keep the service bootable; test execution will be blocked if the repo
      // cannot be resolved, rather than throwing during module initialization.
      this.workspaceRoot = "";
    }
  }

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string"
      ? actionOrTask
      : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string"
      ? (paramsOrContext as Record<string, any>) || {}
      : actionOrTask.params || {};
    const runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    switch (action) {
      case "testing.run_incident_lab":
      // Legacy action names are normalized here only. Evidence always records the canonical ID.
      case "testing.verify_regression":
      case "testing.run_checks":
        return this.verifyRegression(params, runCtx);
      default:
        return this.blocked(`Unregistered testing action '${action}'.`, action);
    }
  }

  private blocked(reason: string, action = "testing.run_incident_lab"): AgentResult {
    const evidence: AgentEvidence[] = [{
      description: reason,
      source: "testing.request-validation",
      timestamp: new Date().toISOString(),
      confidence: 1,
      data: { outcome: "blocked", actionId: action, processStarted: false },
    }];
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "desktop_hud",
      agent: this.id,
      action,
      resource: "testing-runner",
      risk: "high",
      permission: "blocked",
      status: "blocked",
      result: { reason, processStarted: false },
      details: "Testing request was rejected before process creation.",
    });
    return {
      agentId: this.id,
      status: "blocked",
      success: false,
      summary: reason,
      spokenSummary: "I blocked that test request because it did not match the registered safe testing contract.",
      error: reason,
      evidence,
      artifacts: [],
      verification: { passed: false, details: reason },
      data: { outcome: "blocked", processStarted: false },
    };
  }

  async verifyRegression(params: Record<string, any>, ctx?: AgentRunContext): Promise<AgentResult> {
    const request = validateRegressionRequest(params);
    if (!request.valid) return this.blocked(request.reason);

    const workspace: RepairWorkspace | undefined = repairWorkspaceService.getWorkspace(request.workspaceId);
    if (!workspace) {
      return this.blocked("The requested workspace is not registered in this orchestrator session.", "testing.run_incident_lab");
    }
    if (!this.workspaceRoot) {
      return this.blocked("The monorepo root is unavailable; safe test execution is disabled.", "testing.run_incident_lab");
    }

    let actualRoot = "", actualHead = "", actualBranch = "", actualDiff = "";
    let changedFiles: string[] = [];
    try {
      const [root, head, branch, diff, names] = await Promise.all([
        execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace.worktreePath, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.worktreePath, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["branch", "--show-current"], { cwd: workspace.worktreePath, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["diff", "--no-ext-diff", "--", "packages/incident-lab/src/checkout.ts"], { cwd: workspace.worktreePath, timeout: 5000, encoding: "utf8" }),
        execFileAsync("git", ["diff", "--name-only"], { cwd: workspace.worktreePath, timeout: 5000, encoding: "utf8" }),
      ]);
      actualRoot = path.resolve(root.stdout.trim());
      actualHead = head.stdout.trim();
      actualBranch = branch.stdout.trim();
      actualDiff = diff.stdout;
      changedFiles = names.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    } catch (error: any) {
      return this.blocked(`Could not validate the registered repair workspace: ${error?.message || "git inspection failed"}`, "testing.run_incident_lab");
    }
    const actualDiffHash = createHash("sha256").update(actualDiff).digest("hex");
    if (
      actualRoot !== path.resolve(workspace.worktreePath) ||
      actualHead !== workspace.baseCommit ||
      actualBranch !== workspace.branchName ||
      !actualDiff.trim() ||
      changedFiles.length !== 1 ||
      changedFiles[0] !== "packages/incident-lab/src/checkout.ts" ||
      actualDiffHash !== request.expectedDiffHash
    ) {
      return this.blocked("The registered worktree, base commit, changed-file scope, or patch digest did not match the approved test target.", "testing.run_incident_lab");
    }

    const taskId = ctx?.task?.id || `test-${randomUUID()}`;
    let processResult: ManagedProcessResult;
    try {
      const executable = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "pnpm";
      const args = process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm --filter @vanessa/incident-lab test"]
        : ["--filter", "@vanessa/incident-lab", "test"];
      processResult = await processSupervisor.run({
        taskId,
        actionId: "testing.run_incident_lab",
        executable,
        args,
        cwd: workspace.worktreePath,
        timeoutMs: 25000,
        maxOutputBytes: 256 * 1024,
      });
    } catch (error: any) {
      const reason = error?.message || "Registered test runner could not be started.";
      return {
        agentId: this.id,
        status: "partial",
        success: false,
        summary: "Test execution is inconclusive because no valid process result was produced.",
        spokenSummary: "I could not verify the regression result because the test runner did not produce a complete execution record.",
        error: reason,
        evidence: [{ description: reason, source: "process-supervisor", timestamp: new Date().toISOString(), confidence: 1 }],
        artifacts: [],
        verification: { passed: false, details: reason },
        data: { outcome: "inconclusive", actionId: "testing.run_incident_lab", suiteId: request.suiteId, processStarted: false },
      };
    }

    const output = diagnosticOutput(processResult);
    const report = parseRegressionSummary(output);
    const exitSucceeded = processResult.status === "exited" && processResult.exitCode === 0;
    let baseCheckoutUnchanged = await repairWorkspaceService.isBaseCheckoutUnchanged(workspace);
    const testSuccess = exitSucceeded && report !== null && !processResult.stdoutTruncated && !processResult.stderrTruncated && baseCheckoutUnchanged;
    const processFailed = processResult.status === "exited" && processResult.exitCode !== 0;
    const outcome = testSuccess ? "succeeded" : processFailed || !baseCheckoutUnchanged ? "failed" : "inconclusive";
    const details = testSuccess
      ? `Registered incident-lab suite passed ${report!.passed}/${report!.total} tests with exit code 0.`
      : processFailed
        ? `Registered incident-lab suite exited with code ${processResult.exitCode}.`
        : processResult.status === "timed_out"
          ? "The registered test process timed out; passing results were not established."
          : processResult.status === "termination_unconfirmed"
            ? "Termination could not be verified; the task must not be treated as safely cancelled."
            : "A valid structured test summary was not established for this process run.";

    const evidence: AgentEvidence[] = [{
      description: details,
      source: "process-supervisor",
      timestamp: processResult.finishedAt,
      confidence: testSuccess ? 1 : 0,
      data: {
        runId: processResult.runId,
        taskId: processResult.taskId,
        actionId: processResult.actionId,
        suiteId: request.suiteId,
        workspaceId: request.workspaceId,
        expectedDiffHash: request.expectedDiffHash,
        actualDiffHash,
        changedFiles,
        workspacePath: workspace.worktreePath,
        baseCommit: workspace.baseCommit,
        baseCheckoutUnchanged,
        executable: processResult.executable,
        args: processResult.args,
        cwd: processResult.cwd,
        pid: processResult.pid,
        startedAt: processResult.startedAt,
        finishedAt: processResult.finishedAt,
        durationMs: processResult.durationMs,
        processStatus: processResult.status,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        cancellationRequested: processResult.cancellationRequested,
        terminationVerified: processResult.terminationVerified,
        report,
        stdoutTruncated: processResult.stdoutTruncated,
        stderrTruncated: processResult.stderrTruncated,
        outputDigest: processResult.outputDigest,
        diagnosticOutput: output,
      },
    }];

    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "desktop_hud",
      agent: this.id,
      action: "testing.run_incident_lab",
      resource: request.suiteId,
      risk: "high",
      permission: "allowed",
      status: testSuccess ? "success" : processFailed ? "error" : "warn",
      result: { outcome, processStatus: processResult.status, exitCode: processResult.exitCode, report, outputDigest: processResult.outputDigest },
      details,
    });

    return {
      agentId: this.id,
      status: testSuccess ? "completed" : processFailed ? "failed" : "partial",
      success: testSuccess,
      summary: details,
      spokenSummary: testSuccess
        ? `The registered regression suite passed all ${report!.total} tests.`
        : processFailed
          ? "The regression suite failed. I will not report the repair as successful."
          : "The regression result is inconclusive. I cannot claim the tests passed.",
      evidence,
      artifacts: [`suite:${request.suiteId}`],
      verification: { passed: testSuccess, details },
      data: {
        outcome,
        actionId: "testing.run_incident_lab",
        suiteId: request.suiteId,
        workspaceId: request.workspaceId,
        expectedDiffHash: request.expectedDiffHash,
        actualDiffHash,
        baseCheckoutUnchanged,
        processStatus: processResult.status,
        exitStatus: processResult.exitCode,
        report,
        testsPassed: testSuccess,
        outputDigest: processResult.outputDigest,
        deploymentStatus: "REFUSED_PER_POLICY",
        deploymentReason: "Deployment is outside the registered testing workflow and was not attempted.",
      },
    };
  }
}

export const testingAgent = new TestingAgent();
