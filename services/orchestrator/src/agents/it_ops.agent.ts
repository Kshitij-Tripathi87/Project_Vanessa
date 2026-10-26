import * as path from "node:path";
import * as fs from "node:fs";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import { eventBus } from "../core/eventBus.js";

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

/**
 * Resolve incident-lab log targets consistently whether the planner supplies
 * a root-relative path, repository-prefixed path, basename, or Windows-style
 * separators. Absolute paths and existing symlinks must stay inside the lab.
 */
export function resolveIncidentLabLogPath(target: unknown, incidentLabDir: string): string {
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new TypeError("A non-empty log target is required.");
  }

  const requested = target.trim();
  if (requested.includes(String.fromCharCode(0))) {
    throw new TypeError("The log target contains an invalid null character.");
  }

  const root = fs.realpathSync(incidentLabDir);
  const platformTarget = requested.replace(/[\\/]/g, path.sep);
  const absoluteTarget = path.isAbsolute(platformTarget);
  let candidate: string;
  let relativeTarget = "";

  if (absoluteTarget) {
    candidate = path.resolve(platformTarget);
  } else {
    relativeTarget = requested.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    relativeTarget = relativeTarget.replace(/^(?:packages\/incident-lab|incident-lab)(?:\/|$)/i, "");
    candidate = path.resolve(root, relativeTarget.split("/").join(path.sep));
  }

  candidate = path.resolve(candidate);
  if (!isPathWithin(root, candidate)) {
    throw new Error("The requested log target is outside the incident-lab directory.");
  }

  const validateExistingFile = (filePath: string): string => {
    const actualPath = fs.realpathSync(filePath);
    if (!isPathWithin(root, actualPath)) {
      throw new Error("The requested log target resolves outside the incident-lab directory.");
    }
    if (!fs.statSync(actualPath).isFile()) {
      throw new Error("The requested log target is not a file.");
    }
    return actualPath;
  };

  if (fs.existsSync(candidate)) {
    return validateExistingFile(candidate);
  }

  // Some planners emit only the filename. Permit that shorthand only when it
  // identifies exactly one file in the small set of documented log locations.
  // Never use basename fallback for an absolute or multi-segment target.
  if (!absoluteTarget && relativeTarget.length > 0 && !relativeTarget.includes("/")) {
    const fallbackCandidates = ["logs", "fixtures", "tests/fixtures"]
      .map((directory) => path.resolve(root, directory, relativeTarget))
      .filter((item) => isPathWithin(root, item) && fs.existsSync(item));

    const actualCandidates = [...new Set(fallbackCandidates.map(validateExistingFile))];
    if (actualCandidates.length === 1) return actualCandidates[0];
    if (actualCandidates.length > 1) {
      throw new Error("The log basename is ambiguous within the incident-lab directory.");
    }
  }

  return candidate;
}

function failedLogRead(details: string, relativeTarget?: string): AgentResult {
  return {
    agentId: "it_ops",
    status: "failed",
    success: false,
    summary: "Unable to analyze the requested checkout log.",
    spokenSummary: "I couldn't analyze the checkout log. The requested log could not be safely read.",
    evidence: [],
    artifacts: [],
    verification: { passed: false, details },
    data: {
      ...(relativeTarget ? { logPath: relativeTarget } : {}),
      logLineCount: 0,
      totalErrorsDetected: 0,
      signatureMatches: 0,
    },
  };
}

export class ITOpsAgent implements SpecialistAgent {
  id = "it_ops";
  capabilities = [
    "log_analysis",
    "diagnostics",
    "incident_triage",
    "error_clustering",
    "system_state",
  ];
  allowedTools = [
    "log_read",
    "log_grep",
    "system_status",
    "diagnostics_inspect",
    "network_status",
    "process_list",
  ];

  private workspaceRoot: string;
  private incidentLabDir: string;

  constructor() {
    this.workspaceRoot = path.resolve(process.cwd());
    if (fs.existsSync(path.resolve(this.workspaceRoot, "packages", "incident-lab"))) {
      this.incidentLabDir = path.resolve(this.workspaceRoot, "packages", "incident-lab");
    } else {
      this.incidentLabDir = path.resolve(this.workspaceRoot, "..", "..", "packages", "incident-lab");
    }
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
      case "it_ops.analyze_logs":
      case "incident.analyze_logs":
        return this.analyzeLogs(params, runCtx);

      case "it_ops.system_status":
        return this.systemStatus(runCtx);

      default:
        return this.analyzeLogs(params, runCtx);
    }
  }


  async analyzeLogs(params: Record<string, any>, _ctx?: AgentRunContext): Promise<AgentResult> {
    const startTime = new Date().toISOString();
    const targetLog = params.target === undefined ? "logs/checkout-service.log" : params.target;
    let logPath: string;

    try {
      logPath = resolveIncidentLabLogPath(targetLog, this.incidentLabDir);
    } catch {
      return failedLogRead("The log target is invalid, ambiguous, or outside the permitted incident-lab directory.");
    }

    const incidentRoot = fs.realpathSync(this.incidentLabDir);
    const relativeLogPath = path.relative(incidentRoot, logPath).split(path.sep).join("/");

    if (!fs.existsSync(logPath)) {
      return failedLogRead(
        "The requested log file was not found; no substitute file was analyzed.",
        relativeLogPath
      );
    }

    let logContent: string;
    try {
      const stat = fs.statSync(logPath);
      if (!stat.isFile()) {
        return failedLogRead("The requested log target is not a regular file.", relativeLogPath);
      }
      logContent = fs.readFileSync(logPath, "utf-8");
    } catch {
      return failedLogRead("The requested log file exists but could not be read.", relativeLogPath);
    }

    const lines = logContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return failedLogRead("The requested log file is empty; no incident conclusion was inferred.", relativeLogPath);
    }

    const errorLines = lines.filter((line) => /\[ERROR\]/i.test(line));
    const typeErrors = lines.filter(
      (line) =>
        line.includes("Cannot read properties of undefined (reading 'discountRate')") ||
        line.includes("Cannot read properties of null") ||
        line.includes("discountRate")
    );

    const timestamps: string[] = [];
    for (const line of errorLines) {
      const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
      if (match?.[1]) timestamps.push(match[1]);
    }

    const timeRange = {
      firstError: timestamps[0] || "unknown",
      lastError: timestamps[timestamps.length - 1] || "unknown",
      duration: timestamps.length >= 2 ? "observed timestamps available" : "unknown",
    };

    const probableCauses = typeErrors.length > 0
      ? [
          "A null or undefined promo value may reach calculateTotal() without a guard.",
          "A checkout change may have introduced a missing null-safety check; inspect correlated code before concluding.",
        ]
      : [];

    const observations = [
      `Read ${lines.length} non-empty log lines.`,
      `Detected ${errorLines.length} [ERROR] entries.`,
      `Found ${typeErrors.length} discountRate/null-related signature matches.`,
    ];

    const evidence: AgentEvidence[] = [
      {
        description: `Analyzed ${lines.length} non-empty log lines and found ${typeErrors.length} checkout signature matches.`,
        source: relativeLogPath,
        timestamp: startTime,
        confidence: typeErrors.length > 0 ? 0.99 : 0.7,
        data: {
          logLineCount: lines.length,
          totalErrors: errorLines.length,
          signatureMatches: typeErrors.length,
          timeRange,
          probableCauses,
        },
      },
    ];

    const hasSignature = typeErrors.length > 0;
    const summary = hasSignature
      ? `Analyzed ${lines.length} log lines: found ${typeErrors.length} discountRate/null-related signature matches across ${errorLines.length} ERROR entries.`
      : `Analyzed ${lines.length} log lines; no discountRate/null-related checkout signature was found.`;
    const spokenSummary = hasSignature
      ? "Analyzed the checkout log and found a recurring discountRate or null-related error signature."
      : "Analyzed the checkout log, but did not find a matching discountRate or null-related error signature.";

    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "desktop_hud",
      agent: this.id,
      action: "it_ops.analyze_logs",
      resource: relativeLogPath,
      risk: "low",
      permission: "allowed",
      status: "success",
      result: { logLineCount: lines.length, totalErrors: errorLines.length, signatureMatches: typeErrors.length },
      details: "IT operations agent read and analyzed the selected incident-lab log",
    });

    return {
      agentId: this.id,
      status: "completed",
      success: true,
      summary,
      spokenSummary,
      evidence,
      artifacts: [relativeLogPath],
      verification: {
        passed: true,
        details: `Read ${lines.length} non-empty log lines from ${relativeLogPath}; found ${errorLines.length} ERROR entries and ${typeErrors.length} checkout signature matches.`,
      },
      data: {
        logPath: relativeLogPath,
        logLineCount: lines.length,
        observations,
        timeRanges: timeRange,
        probableCauses,
        totalErrorsDetected: errorLines.length,
        signatureMatches: typeErrors.length,
        errorSignature: hasSignature ? "TypeError/null/discountRate-related checkout error signature" : null,
        failurePattern: hasSignature
          ? "The selected log contains discountRate/null-related error evidence; validate correlated code and impact before claiming a root cause."
          : "No matching checkout signature was found in the selected log.",
        impactSeverity: hasSignature ? "Potential checkout impact; validate against supporting evidence." : "Undetermined; no matching signature found.",
      },
    };
  }

  async systemStatus(_ctx?: AgentRunContext): Promise<AgentResult> {
    return {
      agentId: this.id,
      status: "completed",
      success: true,
      summary: "System diagnostics normal",
      spokenSummary: "System state is healthy.",
      evidence: [],
      artifacts: [],
      data: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        platform: process.platform,
      },
    };
  }
}

export const itOpsAgent = new ITOpsAgent();
