import type { Task } from "@vanessa/shared";

/** Normalize a specialist result into the authoritative task result/verification contract. */
export function recordAgentResult(task: Task, result: any): "success" | "partial" | "failed" {
  const structured = result && typeof result === "object" ? result : undefined;
  task.result = structured?.data !== undefined ? structured.data : result;
  if (structured?.spokenSummary) task.spokenSummary = structured.spokenSummary;
  if (task.action === "codex.open" && structured?.success === true && structured?.status === "started") {
    task.spokenSummary = "I started a Codex terminal with your request. Coding completion is not yet reported to Vanessa.";
  }
  const evidence = Array.isArray(structured?.evidence) ? structured.evidence : [];
  task.evidence = evidence;
  task.artifacts = Array.isArray(structured?.artifacts) ? structured.artifacts : [];

  const verification = structured?.verification;
  const verificationDetails = typeof verification?.details === "string" ? verification.details.trim() : "";

  // Partial is an explicit task outcome, not success with an imperfect verification field.
  if (structured?.status === "partial") {
    const detail = verificationDetails || String(structured?.summary || structured?.spokenSummary || "Operation was only partially completed or could not be fully verified.");
    task.verification = {
      verified: false,
      postconditions: [detail],
      exitCode: 1,
      artifacts: task.artifacts,
      outcome: "partial",
      details: detail,
    };
    return "partial";
  }

  if (verification?.passed === true && verificationDetails) {
    const successReported = structured.success !== false;
    task.verification = {
      verified: successReported,
      postconditions: [verificationDetails],
      exitCode: successReported ? 0 : 1,
      artifacts: task.artifacts,
      outcome: successReported ? "succeeded" : "failed",
    };
    if (evidence.length === 0) {
      evidence.push({
        description: verificationDetails,
        source: "agent_verification",
        timestamp: new Date().toISOString(),
        confidence: 0.8,
      });
    }
    return successReported ? "success" : "failed";
  }

  if (structured?.success === false || structured?.status === "failed") {
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
    const detail = verificationDetails || (typeof structured?.output === "string" ? structured.output : (typeof structured?.spokenSummary === "string" ? structured.spokenSummary : "Operation completed successfully"));
    task.verification = {
      verified: true,
      postconditions: [detail],
      exitCode: 0,
      artifacts: task.artifacts,
      outcome: "succeeded",
      details: detail,
    };
    if (evidence.length === 0) {
      evidence.push({
        description: detail,
        source: "agent_execution",
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      });
    }
    return "success";
  }

  if (result !== undefined && result !== null && result !== false && structured?.success !== false && structured?.status !== "failed" && structured?.status !== "partial" && structured?.status !== "blocked") {
    task.verification = {
      verified: true,
      postconditions: [verificationDetails || "Task completed without error."],
      exitCode: 0,
      artifacts: task.artifacts,
      outcome: "succeeded",
    };
    return "success";
  }

  const reportedFailure = structured?.success === false || structured?.status === "failed" || structured?.status === "blocked";
  task.verification = {
    verified: false,
    postconditions: [reportedFailure ? "The agent reported that the requested action failed or was blocked." : "No explicit passing verification result was returned by the agent."],
    exitCode: 1,
    artifacts: task.artifacts,
    outcome: reportedFailure ? "failed" : "partial",
    details: verificationDetails || (typeof structured?.error === "string" ? structured.error : undefined),
  };
  return reportedFailure ? "failed" : "partial";
}
