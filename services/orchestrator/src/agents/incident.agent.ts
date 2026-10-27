import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eventBus } from "../core/eventBus.js";
import type { AgentRunContext } from "@vanessa/shared";

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

  async execute(action: string, params: Record<string, any> = {}, context?: AgentRunContext): Promise<any> {
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
        return this.prepareFixAndVerify({ ...params, taskId: params.taskId || context?.task?.id });

      case "incident.investigate":
        return this.runFullInvestigation({ ...params, taskId: params.taskId || context?.task?.id });

      default: {
        const detail = `Unregistered incident action '${action}' is blocked; no investigation or process was started.`;
        eventBus.emitEvent("audit:log", {
          id: `incident-unknown-${randomUUID()}`,
          timestamp: Date.now(),
          source: "desktop_hud",
          agent: "incident",
          action,
          resource: "incident-agent-dispatch",
          risk: "high",
          permission: "blocked",
          status: "blocked",
          details: detail,
        });
        return {
          agentId: "incident",
          status: "blocked",
          success: false,
          summary: detail,
          spokenSummary: "I blocked an unregistered incident operation.",
          error: detail,
          evidence: [{
            description: detail,
            source: "incident-agent-dispatch",
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { outcome: "blocked", actionId: action, processStarted: false },
          }],
          artifacts: [],
          verification: { passed: false, details: detail },
          data: { outcome: "blocked", actionId: action, processStarted: false },
        };
      }
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
   * Combined patch-and-test execution remains blocked until every stage is individually approved.
   */
  async prepareFixAndVerify(_params: Record<string, any>): Promise<any> {
    const detail = "Combined repair-and-test execution is disabled. Use the staged coding.prepare_patch operation, approve its exact worktree/base-commit/patch contract, then separately approve testing.run_incident_lab for the resulting diff digest.";
    const result = {
      status: "blocked",
      success: false,
      patchApplied: false,
      testsPassed: false,
      error: detail,
      summary: detail,
      spokenSummary: detail,
      verification: { passed: false, details: detail },
      evidence: [{
        type: "policy",
        actionId: "incident.prepare_and_verify",
        processStarted: false,
        timestamp: new Date().toISOString(),
        detail,
      }],
      data: { outcome: "blocked", patchApplied: false, testsPassed: false, processStarted: false },
      deploymentStatus: "REFUSED_PER_POLICY",
      deploymentReason: "Deployment is outside this workflow and was not attempted.",
    };
    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "desktop_hud",
      agent: "incident",
      action: "incident.prepare_and_verify",
      resource: "incident-lab",
      risk: "high",
      permission: "blocked",
      status: "blocked",
      result,
      details: detail,
    });
    return result;
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
    const workers = [repoEvidence, logEvidence, memoryEvidence];
    const workerEvidence = workers.map((worker) => ({
      description: `${worker.worker}: ${String(worker.findings.analysis || worker.findings.runbookTitle || "Source inspected")}.`,
      source: worker.source,
      timestamp: worker.timestamp,
      confidence: worker.confidence,
      data: worker.findings,
    }));

    if (diagnosis.status !== "diagnosed" || !diagnosis.proposedFix) {
      const summary = "Investigation is inconclusive. Source and log evidence did not establish the targeted defect; no patch or test process was started.";
      return {
        status: "partial",
        success: false,
        investigationId,
        workers,
        diagnosis,
        summary,
        spokenSummary: summary,
        verification: { passed: false, details: summary },
        evidence: workerEvidence,
        artifacts: [],
        data: {
          outcome: "inconclusive",
          investigationId,
          workers,
          diagnosis,
          patchApplied: false,
          testsPassed: false,
          processStarted: false,
          deploymentStatus: "REFUSED_PER_POLICY",
        },
      };
    }

    const summary = "Diagnosis is supported by observed source and log evidence. No patch was applied and no tests were run. Continue through the separately approved coding.prepare_patch and testing.run_incident_lab stages.";
    return {
      status: "completed",
      success: true,
      investigationId,
      workers,
      diagnosis,
      summary,
      spokenSummary: summary,
      verification: { passed: true, details: "The diagnosis is supported by direct source evidence plus a matching observed log signature; no repair success is claimed." },
      evidence: workerEvidence,
      artifacts: [],
      data: {
        outcome: "diagnosed",
        investigationId,
        workers,
        diagnosis,
        patchApplied: false,
        testsPassed: false,
        processStarted: false,
        deploymentStatus: "REFUSED_PER_POLICY",
      },
    };
  }

}

export const incidentAgent = new IncidentAgent();
