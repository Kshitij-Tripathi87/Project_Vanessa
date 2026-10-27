import * as fs from "node:fs";
import * as path from "node:path";
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

export function validateRegressionRequest(params: Record<string, any>): { valid: true; suiteId: string } | { valid: false; reason: string } {
  if (Object.prototype.hasOwnProperty.call(params, "command")) {
    return { valid: false, reason: "Free-form command execution is not accepted by the testing agent. Use a registered suiteId." };
  }
  const unknown = Object.keys(params).filter((key) => key !== "suiteId");
  if (unknown.length) return { valid: false, reason: `Unsupported testing parameter(s): ${unknown.join(", ")}` };
  if (params.suiteId !== INCIDENT_LAB_SUITE_ID) {
    return { valid: false, reason: `Unknown or missing test suite. Registered suite: ${INCIDENT_LAB_SUITE_ID}.` };
  }
  return { valid: true, suiteId: INCIDENT_LAB_SUITE_ID };
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
    this.workspaceRoot = findRepositoryRoot(process.cwd());
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

    const taskId = ctx?.task?.id || `test-${randomUUID()}`;
    let processResult: ManagedProcessResult;
    try {
      processResult = await processSupervisor.run({
        taskId,
        actionId: "testing.run_incident_lab",
        executable: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        args: ["--filter", "@vanessa/incident-lab", "test"],
        cwd: this.workspaceRoot,
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
    const testSuccess = exitSucceeded && report !== null && !processResult.stdoutTruncated && !processResult.stderrTruncated;
    const processFailed = processResult.status === "exited" && processResult.exitCode !== 0;
    const outcome = testSuccess ? "succeeded" : processFailed ? "failed" : "inconclusive";
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
