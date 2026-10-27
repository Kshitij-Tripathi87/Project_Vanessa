import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eventBus } from "../core/eventBus.js";
import { repairWorkspaceService, RepairWorkspaceError } from "../core/repairWorkspace.js";

const execFileAsync = promisify(execFile);

export interface InvestigationEvidence {
  worker: string;
  source: string;
  timestamp: string;
  findings: Record<string, any>;
  confidence: number;
  verificationStatus: "verified" | "inconclusive" | "unverified";
}

export class IncidentAgent {
  private workspaceRoot: string;
  private incidentLabDir: string;

  constructor() {
    this.workspaceRoot = path.resolve(process.cwd());
    // Accommodate running from root or services/orchestrator
    if (fs.existsSync(path.resolve(this.workspaceRoot, "packages", "incident-lab"))) {
      this.incidentLabDir = path.resolve(this.workspaceRoot, "packages", "incident-lab");
    } else {
      this.incidentLabDir = path.resolve(this.workspaceRoot, "..", "..", "packages", "incident-lab");
    }
  }

  async execute(action: string, params: Record<string, any> = {}): Promise<any> {
    switch (action) {
      case "incident.analyze_repo":
        return this.analyzeRepository(params);

      case "incident.analyze_logs":
        return this.analyzeLogs(params);

      case "incident.retrieve_memory":
        return this.retrieveMemoryAndRunbook(params);

      case "incident.diagnose":
        return this.correlateEvidence(params);

      case "incident.prepare_and_verify":
        return this.prepareFixAndVerify(params);

      case "incident.investigate":
      default:
        return this.runFullInvestigation(params);
    }
  }

  /**
   * Worker 1: Repository Analysis (Concurrent)
   */
  async analyzeRepository(_params: Record<string, any>): Promise<InvestigationEvidence> {
    const relativeFile = "packages/incident-lab/src/checkout.ts";
    const filePath = path.resolve(this.incidentLabDir, "src", "checkout.ts");
    const exists = fs.existsSync(filePath);
    const content = exists ? fs.readFileSync(filePath, "utf-8") : "";
    const lines = content.split(/\r?\n/);
    const culpritIndex = lines.findIndex((line) =>
      !/^\s*\/\//.test(line) &&
      /\bpromo\.discountRate\b/.test(line) &&
      !/\bpromo\?\./.test(line)
    );
    const culpritLine = culpritIndex >= 0 ? culpritIndex + 1 : -1;
    const snippet = culpritIndex >= 0 ? lines[culpritIndex].trim() : "";
    const signature = lines.find((line) => /function\s+calculateTotal\s*\(/.test(line))?.trim() || "";
    const finding: InvestigationEvidence = {
      worker: "Worker 1: Repository Analysis",
      source: relativeFile,
      timestamp: new Date().toISOString(),
      findings: {
        file: relativeFile,
        fileExists: exists,
        culpritLine,
        codeSnippet: snippet || undefined,
        functionSignature: signature || undefined,
        analysis: !exists
          ? "The target source file does not exist; no source-level conclusion can be verified."
          : culpritIndex >= 0
            ? "Observed a direct promo.discountRate access in executable source without optional chaining."
            : "The inspected source does not contain the targeted unguarded promo.discountRate access.",
      },
      confidence: !exists ? 0 : culpritIndex >= 0 ? 0.95 : 0.7,
      verificationStatus: exists && culpritIndex >= 0 ? "verified" : "inconclusive",
    };
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`, timestamp: Date.now(), source: "desktop_hud", agent: "incident",
      action: "incident.analyze_repo", resource: relativeFile, risk: "low", permission: "allowed",
      status: finding.verificationStatus === "verified" ? "success" : "warn",
      result: finding.findings,
      details: finding.verificationStatus === "verified"
        ? "Repository evidence identified an unguarded optional property access."
        : "Repository analysis did not establish the targeted defect from source evidence.",
    });
    return finding;
  }

  /**
   * Worker 2: Log Analysis (Concurrent)
   */
  async analyzeLogs(_params: Record<string, any>): Promise<InvestigationEvidence> {
    const relativeLog = "packages/incident-lab/logs/checkout-service.log";
    const logPath = path.resolve(this.incidentLabDir, "logs", "checkout-service.log");
    const exists = fs.existsSync(logPath);
    const logContent = exists ? fs.readFileSync(logPath, "utf-8") : "";
    const lines = logContent.split(/\r?\n/);
    const errorLines = lines.filter((line) => /\[ERROR\]/i.test(line));
    const typeErrors = lines.filter((line) =>
      /Cannot read properties of (?:undefined|null).*discountRate/i.test(line) ||
      (/promo\.discountRate/i.test(line) && /TypeError/i.test(line))
    );
    const finding: InvestigationEvidence = {
      worker: "Worker 2: Log Analysis", source: relativeLog, timestamp: new Date().toISOString(),
      findings: {
        fileExists: exists, totalLines: exists ? lines.length : 0, totalErrorsDetected: errorLines.length,
        signatureMatches: typeErrors.length, observedErrorLines: errorLines.slice(0, 20),
        matchingErrorLines: typeErrors.slice(0, 20),
        analysis: !exists
          ? "The log file is unavailable; no log-based conclusion can be verified."
          : typeErrors.length > 0
            ? "The log contains observed errors consistent with promo.discountRate access."
            : "The log was read, but the targeted TypeError signature was not observed.",
      },
      confidence: !exists ? 0 : typeErrors.length > 0 ? 0.95 : 0.6,
      verificationStatus: exists ? "verified" : "inconclusive",
    };
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`, timestamp: Date.now(), source: "desktop_hud", agent: "incident",
      action: "incident.analyze_logs", resource: relativeLog, risk: "low", permission: "allowed",
      status: exists ? "success" : "warn", result: finding.findings,
      details: exists ? "Log source was read; findings reflect only observed log records."
        : "Log source was unavailable; log analysis remains inconclusive.",
    });
    return finding;
  }

  /**
   * Worker 3: Memory & Runbook Retrieval (Concurrent)
   */
  async retrieveMemoryAndRunbook(_params: Record<string, any>): Promise<InvestigationEvidence> {
    const runbookRelative = "packages/incident-lab/runbooks/checkout-payment-failure.md";
    const runbookPath = path.resolve(this.incidentLabDir, "runbooks", "checkout-payment-failure.md");
    const runbookExists = fs.existsSync(runbookPath);
    const runbookContent = runbookExists ? fs.readFileSync(runbookPath, "utf-8") : "";
    const runbookTitle = runbookContent.split(/\r?\n/).find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "") || "";
    let memoryResult = "";
    let memorySource = "";
    let memoryError = "";
    const candidates = [
      path.resolve(this.workspaceRoot, "Agents and tools"),
      path.resolve(this.workspaceRoot, "agents and tools"),
      path.resolve(this.workspaceRoot, "agents_and_tools"),
      path.resolve(this.workspaceRoot, "tools"),
      path.resolve(this.workspaceRoot, "OpenJarvis"),
    ];
    const openJarvisDir = candidates.find((directory) => fs.existsSync(directory));
    if (openJarvisDir) {
      try {
        const script = "from openjarvis.tools.storage_tools import MemoryRetrieveTool; tool = MemoryRetrieveTool(); res = tool.execute(query='checkout'); print(res.content if hasattr(res, 'content') else res)";
        const result = await execFileAsync("uv", ["run", "python", "-c", script], {
          cwd: openJarvisDir, timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8",
        });
        if (result.stdout.trim()) {
          memoryResult = result.stdout.trim().slice(0, 12000);
          memorySource = openJarvisDir;
        }
      } catch (error: any) {
        memoryError = typeof error?.message === "string" ? error.message : "Memory retrieval failed.";
      }
    } else {
      memoryError = "No supported local memory-tool directory was found.";
    }
    const sourceAvailable = Boolean(memoryResult || runbookContent);
    const finding: InvestigationEvidence = {
      worker: "Worker 3: Memory & Runbook Retrieval",
      source: memoryResult ? memorySource : runbookRelative, timestamp: new Date().toISOString(),
      findings: {
        memoryRetrieved: Boolean(memoryResult), memoryRecord: memoryResult || undefined,
        memoryRetrievalError: memoryError || undefined, runbookExists, runbookTitle: runbookTitle || undefined,
        runbookExcerpt: runbookContent ? runbookContent.slice(0, 6000) : undefined,
        sourcesUsed: [...(memoryResult ? ["local-memory"] : []), ...(runbookContent ? ["runbook"] : [])],
      },
      confidence: sourceAvailable ? 0.8 : 0,
      verificationStatus: sourceAvailable ? "verified" : "inconclusive",
    };
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`, timestamp: Date.now(), source: "desktop_hud", agent: "incident",
      action: "incident.retrieve_memory", resource: memoryResult ? memorySource : runbookRelative,
      risk: "low", permission: "allowed", status: sourceAvailable ? "success" : "warn",
      result: finding.findings,
      details: sourceAvailable ? "Memory/runbook result includes only content retrieved from available sources."
        : "No historical memory or runbook evidence was available.",
    });
    return finding;
  }

  /**
   * Evidence Correlation & Diagnosis
   */
  async correlateEvidence(evidence: {
    repo?: InvestigationEvidence;
    logs?: InvestigationEvidence;
    memory?: InvestigationEvidence;
  }): Promise<any> {
    const repoFindings = evidence.repo?.findings || {};
    const logFindings = evidence.logs?.findings || {};
    const repoVerified = evidence.repo?.verificationStatus === "verified" &&
      Number.isInteger(repoFindings.culpritLine) && repoFindings.culpritLine > 0 &&
      typeof repoFindings.codeSnippet === "string" && repoFindings.codeSnippet.length > 0;
    const logMatches = Number(logFindings.signatureMatches || 0);
    const memoryAvailable = evidence.memory?.verificationStatus === "verified";
    const corroboratingEvidence = [
      ...(repoVerified ? [{ source: "Repository", detail: `${evidence.repo?.source}:L${repoFindings.culpritLine} — ${repoFindings.codeSnippet}` }] : []),
      ...(logMatches > 0 ? [{ source: "Logs", detail: `${logMatches} matching error record(s) observed in ${evidence.logs?.source}.` }] : []),
      ...(memoryAvailable ? [{ source: "Memory / Runbook", detail: "Retrieved historical context is available; it is context, not proof of the current defect." }] : []),
    ];
    const diagnosed = repoVerified && logMatches > 0;
    const original = repoVerified ? String(repoFindings.codeSnippet) : "";
    const proposedFix = diagnosed && /promo\.discountRate/.test(original)
      ? {
          file: evidence.repo?.source,
          targetLine: repoFindings.culpritLine,
          original,
          replacement: "const discountRate = promo?.discountRate ?? 0;\n  const discount = (subtotal * discountRate) / 100;",
        }
      : undefined;
    return {
      incidentId: `INC-${randomUUID()}`,
      status: diagnosed && proposedFix ? "diagnosed" : "inconclusive",
      rootCause: diagnosed
        ? `Observed unguarded promo.discountRate access at ${evidence.repo?.source}:L${repoFindings.culpritLine}, corroborated by matching log records.`
        : "The available evidence does not establish a source-level defect corroborated by matching logs.",
      corroboratingEvidence, proposedFix,
      confidenceScore: diagnosed && proposedFix ? 0.9 : 0,
      evidenceAvailability: {
        repository: evidence.repo?.verificationStatus || "unverified",
        logs: evidence.logs?.verificationStatus || "unverified",
        memory: evidence.memory?.verificationStatus || "unverified",
      },
    };
  }

  /**
   * Step 4: Safe Execution & Local Test Verification
   */
  async prepareFixAndVerify(params: Record<string, any>): Promise<any> {
    const taskId = typeof params.taskId === "string" && params.taskId.trim() ? params.taskId : `incident-${randomUUID()}`;
    const deploymentStatus = "REFUSED_PER_POLICY";
    let workspace;
    try {
      workspace = await repairWorkspaceService.create(taskId);
    } catch (error: any) {
      const code = error instanceof RepairWorkspaceError ? error.code : "WORKSPACE_CREATION_FAILED";
      const result = {
        status: code === "BASE_CHECKOUT_DIRTY" ? "blocked" : "inconclusive", taskId,
        patchApplied: false, testsPassed: false, testExitCode: null, evidence: [],
        errorCode: code, error: typeof error?.message === "string" ? error.message : "Repair workspace could not be created.",
        deploymentStatus, deploymentReason: "Deployment is outside this workflow and was not attempted.",
      };
      eventBus.emitEvent("audit:log", {
        id: `audit-${Date.now()}`, timestamp: Date.now(), source: "desktop_hud", agent: "incident",
        action: "incident.prepare_and_verify", resource: taskId, risk: "high", permission: "blocked",
        status: "warn", result, details: "Repair was not started because the isolated workspace precondition failed.",
      });
      return result;
    }

    const relativeTarget = "packages/incident-lab/src/checkout.ts";
    const checkoutFile = path.resolve(workspace.worktreePath, relativeTarget);
    const evidence: Record<string, any>[] = [];
    let patchApplied = false, testsPassed = false;
    let testExitCode: number | null = null;
    let testOutput = "", diff = "", diffHash = "";
    let testReport: { passed: number; total: number } | undefined;
    let changedFiles: string[] = [];
    let outcome: "success" | "failed" | "inconclusive" = "inconclusive";
    let failureReason = "";

    if (!fs.existsSync(checkoutFile)) {
      failureReason = `Required patch target does not exist in isolated worktree: ${relativeTarget}`;
    } else {
      const originalContent = fs.readFileSync(checkoutFile, "utf8");
      const targetLine = "const discount = (subtotal * promo.discountRate) / 100;";
      const matches = originalContent.split(targetLine).length - 1;
      if (matches !== 1) {
        failureReason = matches === 0
          ? "Expected vulnerable source line was not present; no patch was applied."
          : "Expected source line is ambiguous; refusing to patch multiple locations.";
      } else {
        const replacement = "const discountRate = promo?.discountRate ?? 0;\n  const discount = (subtotal * discountRate) / 100;";
        const patchedContent = originalContent.replace(targetLine, replacement);
        if (patchedContent === originalContent) {
          failureReason = "Patch would be a no-op; no successful repair can be claimed.";
        } else {
          try {
            fs.writeFileSync(checkoutFile, patchedContent, "utf8");
            const actualContent = fs.readFileSync(checkoutFile, "utf8");
            if (actualContent !== patchedContent || !actualContent.includes(replacement)) {
              failureReason = "On-disk source did not match the intended patch after write.";
            } else patchApplied = true;
          } catch (error: any) {
            failureReason = `Patch write/readback failed: ${error?.message || "unknown error"}`;
          }
        }
      }
    }

    if (patchApplied) {
      try {
        const diffResult = await execFileAsync("git", ["diff", "--no-ext-diff", "--", relativeTarget], {
          cwd: workspace.worktreePath, timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8",
        });
        diff = diffResult.stdout;
        diffHash = createHash("sha256").update(diff).digest("hex");
        const names = await execFileAsync("git", ["diff", "--name-only"], {
          cwd: workspace.worktreePath, timeout: 10000, windowsHide: true, encoding: "utf8",
        });
        changedFiles = names.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
        if (!diff.trim() || changedFiles.length !== 1 || changedFiles[0] !== relativeTarget) {
          patchApplied = false;
          failureReason = "Observed diff is empty or includes unexpected changed files.";
        } else {
          evidence.push({ type: "patch", target: relativeTarget, diffHash, changedFiles, baseCommit: workspace.baseCommit, worktreePath: workspace.worktreePath });
        }
      } catch (error: any) {
        patchApplied = false;
        failureReason = `Patch diff inspection failed: ${error?.message || "unknown error"}`;
      }
    }

    if (patchApplied) {
      try {
        const result = await execFileAsync("pnpm", ["--filter", "@vanessa/incident-lab", "test"], {
          cwd: workspace.worktreePath, timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8",
        });
        testOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-20000);
        testExitCode = 0;
        const match = testOutput.match(/ALL REGRESSION TESTS PASSED\s*\((\d+)\s*\/\s*(\d+)\)/);
        if (match) testReport = { passed: Number(match[1]), total: Number(match[2]) };
        testsPassed = Boolean(testReport && testReport.total > 0 && testReport.passed === testReport.total);
        outcome = testsPassed ? "success" : "inconclusive";
        if (!testsPassed) failureReason = "Runner exited 0 but did not produce a valid non-zero-count regression summary.";
      } catch (error: any) {
        const stdout = typeof error?.stdout === "string" ? error.stdout : "";
        const stderr = typeof error?.stderr === "string" ? error.stderr : "";
        testOutput = [stdout, stderr, error?.message].filter(Boolean).join("\n").slice(-20000);
        testExitCode = typeof error?.code === "number" ? error.code : null;
        testsPassed = false;
        outcome = testExitCode !== null && testExitCode !== 0 ? "failed" : "inconclusive";
        failureReason = testExitCode !== null
          ? `Regression suite exited with code ${testExitCode}.`
          : "Regression runner failed to start or timed out; test completion is not verified.";
      }
      evidence.push({
        type: "test-run", suiteId: "incident-lab.regression",
        command: "pnpm --filter @vanessa/incident-lab test", exitCode: testExitCode, report: testReport,
        outputDigest: createHash("sha256").update(testOutput).digest("hex"),
      });
    }

    const baseCheckoutUnchanged = await repairWorkspaceService.isBaseCheckoutUnchanged(workspace);
    evidence.push({
      type: "workspace", repositoryRoot: workspace.repositoryRoot, worktreePath: workspace.worktreePath,
      branch: workspace.branchName, baseCommit: workspace.baseCommit, baseCheckoutUnchanged,
    });
    if (!baseCheckoutUnchanged) {
      outcome = "failed";
      failureReason = "Base checkout changed during repair; isolation invariant failed.";
    }
    if (!patchApplied && outcome === "success") outcome = "inconclusive";
    if (!patchApplied && !failureReason) failureReason = "No verifiable patch was applied.";
    if (outcome !== "success") testsPassed = false;

    const verificationResult = {
      status: outcome, taskId, branch: workspace.branchName, worktreePath: workspace.worktreePath,
      baseCommit: workspace.baseCommit, patchApplied, diffHash: diffHash || undefined, changedFiles,
      testsPassed, testSuiteRun: patchApplied ? "incident-lab.regression" : undefined, testExitCode,
      testReport, testOutput, baseCheckoutUnchanged, evidence,
      error: outcome === "success" ? undefined : failureReason || "Required verification evidence was not established.",
      deploymentStatus, deploymentReason: "Deployment is outside this workflow and was not attempted.",
    };
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`, timestamp: Date.now(), source: "desktop_hud", agent: "incident",
      action: "incident.prepare_and_verify", resource: `worktree:${workspace.worktreePath}`,
      risk: "high", permission: "allowed",
      status: outcome === "success" ? "success" : outcome === "failed" ? "error" : "warn",
      result: verificationResult,
      details: outcome === "success"
        ? "Patch diff, structured regression report, and base-checkout preservation were verified."
        : `Repair did not pass all evidence gates: ${verificationResult.error}`,
    });
    return verificationResult;
  }

  /**
   * Full Workflow: Orchestrates 3 concurrent workers, diagnoses, prepares fix, and tests
   */
  async runFullInvestigation(params: Record<string, any>): Promise<any> {
    const investigationId = `inv_${randomUUID()}`;
    const [repoEvidence, logEvidence, memoryEvidence] = await Promise.all([
      this.analyzeRepository(params), this.analyzeLogs(params), this.retrieveMemoryAndRunbook(params),
    ]);
    const diagnosis = await this.correlateEvidence({ repo: repoEvidence, logs: logEvidence, memory: memoryEvidence });
    if (diagnosis.status !== "diagnosed" || !diagnosis.proposedFix) {
      return {
        status: "inconclusive", investigationId, workers: [repoEvidence, logEvidence, memoryEvidence], diagnosis,
        verification: {
          status: "inconclusive", patchApplied: false, testsPassed: false,
          error: "Repair was not attempted because current source evidence did not establish the targeted defect.",
          deploymentStatus: "REFUSED_PER_POLICY",
        },
        summary: "Investigation is inconclusive. The available evidence did not establish the targeted defect; no patch or deployment was attempted.",
      };
    }
    const verification = await this.prepareFixAndVerify({ ...params, taskId: params.taskId || investigationId });
    const status = verification.status === "success" ? "success"
      : verification.status === "failed" ? "failed"
      : verification.status === "blocked" ? "blocked" : "inconclusive";
    const summary = status === "success"
      ? `Investigation verified a patch in worktree ${verification.worktreePath}; ${verification.testReport.passed}/${verification.testReport.total} regression tests passed. Base checkout unchanged. Deployment was not attempted.`
      : status === "failed"
        ? `Investigation failed a required verification gate: ${verification.error || "see evidence"}.`
        : status === "blocked"
          ? `Investigation was blocked before repair: ${verification.error || "a required precondition was not met"}.`
          : `Investigation is inconclusive: ${verification.error || "required verification evidence is missing"}.`;
    return { status, investigationId, workers: [repoEvidence, logEvidence, memoryEvidence], diagnosis, verification, summary };
  }

}

export const incidentAgent = new IncidentAgent();
