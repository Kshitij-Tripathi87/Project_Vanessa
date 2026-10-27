import type { Task } from "@vanessa/shared";
import { resolveManagedAction } from "./actionRegistry.js";

export function recordAgentResult(task: Task, result: any): "success" | "partial" | "failed" | "blocked" {
  const structured = result && typeof result === "object" ? result : undefined;
  task.result = structured?.data !== undefined ? structured.data : result;
  if (structured?.spokenSummary) task.spokenSummary = structured.spokenSummary;
  const evidence = Array.isArray(structured?.evidence) ? structured.evidence : [];
  task.evidence = evidence;
  task.artifacts = Array.isArray(structured?.artifacts) ? structured.artifacts : [];

  const verification = structured?.verification;
  const verificationDetails = typeof verification?.details === "string" ? verification.details.trim() : "";
  const resultData = structured?.data && typeof structured.data === "object" ? structured.data as Record<string, any> : {};
  const managedAction = resolveManagedAction(task.action, task.params || {});

  // Explicit non-success states are handled before the generic success:false
  // branch so "blocked" and "inconclusive" are not collapsed into a test failure.
  if (structured?.status === "blocked" || resultData.outcome === "blocked") {
    const detail = verificationDetails || structured?.error || structured?.summary || "Execution was blocked by policy.";
    task.verification = {
      verified: false,
      postconditions: [detail],
      exitCode: 1,
      artifacts: task.artifacts,
      outcome: "blocked",
      details: detail,
    };
    task.error = typeof structured?.error === "string" ? structured.error : detail;
    return "blocked";
  }

  if (resultData.outcome === "inconclusive" || resultData.outcome === "simulated") {
    const detail = verificationDetails || structured?.error || structured?.summary ||
      (resultData.outcome === "simulated" ? "Simulated output is not evidence of a real execution." : "Required verification evidence was not established.");
    task.verification = {
      verified: false,
      postconditions: [detail],
      exitCode: undefined,
      artifacts: task.artifacts,
      outcome: resultData.outcome === "simulated" ? "simulated" : "inconclusive",
      details: detail,
    };
    return "partial";
  }

  // Opening an interactive coding terminal is a handoff, not proof that code was
  // written or tested. Keep that distinction even if the launcher itself worked.
  if ((task.action === "codex.open" || task.action === "claude_code.open") && structured?.success === true && structured?.status === "started") {
    const detail = "Interactive coding session started; patch creation and test completion have not been reported.";
    task.spokenSummary = "I opened the coding session. I have not yet verified a code change or test result.";
    task.verification = {
      verified: false,
      postconditions: [detail],
      exitCode: 0,
      artifacts: task.artifacts,
      outcome: "partial",
      details: detail,
    };
    return "partial";
  }
  if (verification?.passed === true && verificationDetails && !["failed", "blocked", "partial", "awaiting_approval"].includes(structured?.status)) {
    const successReported = structured.success !== false;
    if (successReported && managedAction.managed && evidence.length === 0) {
      const detail = "Managed execution returned a positive flag without source-linked execution evidence.";
      task.verification = {
        verified: false,
        postconditions: [detail],
        exitCode: undefined,
        artifacts: task.artifacts,
        outcome: "inconclusive",
        details: detail,
      };
      return "partial";
    }
    task.verification = {
      verified: successReported,
      postconditions: [verificationDetails],
      exitCode: successReported ? 0 : 1,
      artifacts: task.artifacts,
      outcome: successReported ? "succeeded" : "failed",
    };
    if (evidence.length === 0 && !managedAction.managed) {
      evidence.push({
        description: verificationDetails,
        source: "agent_verification",
        timestamp: new Date().toISOString(),
        confidence: 0.8,
      });
    }
    return successReported ? "success" : "failed";
  }

  if (structured?.success === false || ["failed", "blocked"].includes(structured?.status)) {
    task.verification = {
      verified: false,
      postconditions: [verificationDetails || "Agent reported execution failure."],
      exitCode: 1,
      artifacts: task.artifacts,
      outcome: "failed",
    };
    return "failed";
  }

  if (verification?.passed === false) {
    task.verification = {
      verified: false,
      postconditions: [verificationDetails || "Agent verification failed."],
      exitCode: 1,
      artifacts: task.artifacts,
      outcome: "failed",
    };
    return "failed";
  }

  if (structured?.success === true || verification?.passed === true) {
    const detail = verificationDetails || (typeof structured?.output === "string" ? structured.output : (typeof structured?.spokenSummary === "string" ? structured.spokenSummary : ""));
    task.verification = {
      verified: false,
      postconditions: [detail
        ? `Agent reported success, but did not provide a passing verification result: ${detail}`
        : "Agent reported success, but did not provide a passing verification result."],
      exitCode: 0,
      artifacts: task.artifacts,
      outcome: "partial",
      details: detail || undefined,
    };
    return "partial";
  }

  task.verification = {
    verified: false,
    postconditions: ["No explicit passing verification result was returned by the agent."],
    exitCode: 1,
    artifacts: task.artifacts,
    outcome: "partial",
    details: verificationDetails || undefined,
  };
  return "partial";
}
