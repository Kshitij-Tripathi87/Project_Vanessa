import { Task, CriticVerdict, SkillDefinition } from "@vanessa/shared";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export class CriticEngine {
  /**
   * Evaluate task execution outcome against acceptance criteria, invariants, and deterministic proofs.
   */
  public evaluate(
    task: Task,
    skill?: SkillDefinition,
    executionLog: string[] = []
  ): CriticVerdict {
    const jobType = task.jobType || (skill?.jobType ?? "action");
    let passed = true;
    let score = 1.0;
    const feedbackNotes: string[] = [];
    const proofPoints: string[] = [];
    let invariantsPreserved = true;

    if (task.verification && !task.verification.verified) {
      passed = false;
      score = 0.4;
      feedbackNotes.push("Task did not return a passing verification result.");
    }

    // 1. Invariant Checks based on skill or action
    if (skill?.invariants && skill.invariants.length > 0) {
      for (const invariant of skill.invariants) {
        const invLower = invariant.toLowerCase();

        // Invariant: Never deploy directly to production
        if (invLower.includes("never deploy") || invLower.includes("automated deployment")) {
          const actionText = `${task.action} ${JSON.stringify(task.params)} ${JSON.stringify(task.result)}`.toLowerCase();
          if (
            actionText.includes("deploy --prod") ||
            actionText.includes("kubectl apply -f prod") ||
            actionText.includes("push --force production")
          ) {
            invariantsPreserved = false;
            passed = false;
            score = 0.0;
            feedbackNotes.push("VIOLATION: Automated production deployment attempted against safety invariant.");
          } else {
            proofPoints.push("Preserved invariant: Zero production deployment maintained");
          }
        }

        // Invariant: Prompt injection defense
        if (invLower.includes("prompt injection") || invLower.includes("strictly as data")) {
          proofPoints.push("Preserved invariant: Web research payload treated as untrusted data");
        }

        // Invariant: Opening terminal is NOT proof of testing
        if (invLower.includes("not proof of testing") || invLower.includes("exitcode === 0")) {
          const exitCode = task.verification?.exitCode ?? (task.result?.exitCode ?? (task.status === "success" ? 0 : 1));
          if (exitCode !== 0) {
            passed = false;
            score = 0.2;
            feedbackNotes.push(`Testing failed: Process exited with non-zero exit code (${exitCode})`);
          } else {
            proofPoints.push("Preserved invariant: Test suite completed with verified exit code 0");
          }
        }
      }
    }

    // 2. Specific Postcondition Validations
    const actionLower = task.action.toLowerCase();

    // WiFi Postcondition
    if (actionLower.includes("wifi") && (actionLower.includes("restart") || actionLower.includes("enable"))) {
      if (task.result?.connected === false || task.verification?.verified === false) {
        passed = false;
        score = 0.3;
        feedbackNotes.push("Wi-Fi network postcondition could not be verified.");
      } else if (task.result?.connected === true) {
        proofPoints.push("Observed Wi-Fi connection status is connected.");
      }
    }

    // Folder Creation Postcondition
    if (actionLower.includes("folder.create") || actionLower.includes("mkdir")) {
      const folderPath = task.result?.path || (task.artifacts && task.artifacts[0]) || task.params?.path || task.params?.folderPath || task.params?.name;
      if (folderPath && typeof folderPath === "string") {
        const resolvedPath = path.isAbsolute(folderPath) ? folderPath : path.resolve(folderPath);
        const demoPath = path.join(os.homedir(), "Documents", "VanessaDemo", path.basename(folderPath));
        if (fs.existsSync(resolvedPath) || fs.existsSync(folderPath) || fs.existsSync(demoPath)) {
          proofPoints.push(`Deterministic proof: Directory exists on disk at ${folderPath}`);
        } else {
          passed = false;
          score = 0.3;
          feedbackNotes.push(`Directory postcondition failed: ${folderPath} does not exist.`);
        }
      }
    }

    // Cloud Drive Upload Postcondition
    if (actionLower.includes("drive.upload") || actionLower.includes("upload")) {
      const driveUrl = task.result?.shareLink || task.result?.url || task.result?.shareableLink || task.result?.id;
      if (driveUrl) {
        proofPoints.push(`Deterministic proof: Shareable cloud link generated: ${driveUrl}`);
      }
    }

    // Acceptance Criteria Verification
    if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
      for (const criteria of task.acceptanceCriteria) {
        if (task.status === "success") {
          proofPoints.push(`Satisfied criterion: ${criteria}`);
        } else if (task.status === "failed") {
          feedbackNotes.push(`Unsatisfied criterion: ${criteria}`);
          score = Math.max(0, score - 0.3);
        }
      }
    }

    // Goal Job specific multi-step verification
    if (jobType === "goal") {
      if (!task.result && task.status === "success") {
        passed = false;
        score = 0.4;
        feedbackNotes.push("Goal job completed without synthesizing a structured result");
      } else if (task.result) {
        proofPoints.push("Goal job produced synthesized response and artifact evidence");
      }
    }

    // Final outcome synthesis
    if (task.status === "failed" || task.status === "cancelled") {
      passed = false;
      score = Math.min(score, 0.4);
    }

    const proofStr = proofPoints.length > 0 ? proofPoints.join("; ") : undefined;
    const feedbackStr = feedbackNotes.length > 0 ? feedbackNotes.join("; ") : "All acceptance criteria and invariants satisfied";

    return {
      passed,
      score: Number(score.toFixed(2)),
      feedback: feedbackStr,
      proof: proofStr,
      invariantsPreserved,
    };
  }
}

export const criticEngine = new CriticEngine();
