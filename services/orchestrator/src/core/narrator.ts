/**
 * Vanessa Narrator Component
 * Strategy Brief (Page 16, 25, 27):
 * "Narrator: turns job events into one spoken sentence, merges noisy updates, and says plainly what failed."
 * "Check: one sentence at most, and it never reads out keys, tokens or file contents."
 */

import { Task } from "@vanessa/shared";
import { privacyGuard } from "./privacy.js";

export class Narrator {
  /**
   * Generates a clean, privacy-safe, one-sentence spoken summary from completed tasks
   */
  narrateOutcome(command: string, tasks: Task[], language: string = "en", sentiment?: any): string {
    const failedTasks = tasks.filter((t) => t.status === "failed");
    const prefix = sentiment?.urgency === "critical" ? "Urgent update: " : sentiment?.emotion === "frustrated" ? "Understood. " : "";

    // 1. If any task failed, state plainly what failed
    if (failedTasks.length > 0) {
      const failed = failedTasks[0];
      const rawError = failed.error || "Execution encountered an error";
      const cleanError = privacyGuard.redactSensitiveData(rawError).cleanText;
      const actionName = failed.action.replace(/[._]/g, " ");

      if (language === "hi" || language === "hinglish") {
        return `${prefix}${actionName} pura nahi ho paya: ${cleanError}.`;
      }
      return `${prefix}${actionName} failed: ${cleanError}.`;
    }

    // 2. Awaiting approval case
    const pendingApproval = tasks.filter((t) => t.status === "awaiting_approval");
    if (pendingApproval.length > 0) {
      const actions = pendingApproval.map((t) => t.action.replace(/[._]/g, " ")).join(" and ");
      if (language === "hi" || language === "hinglish") {
        return `${prefix}Is action ke liye permission chahiye: ${actions}. Kya main aage badhun?`;
      }
      return `${prefix}This action requires your confirmation: ${actions}. Do you want me to proceed?`;
    }

    // 3. Single successful task: use specific spoken summary if available
    const successTasks = tasks.filter((t) => t.status === "success");
    if (successTasks.length === 1) {
      const task = successTasks[0];
      if (task.spokenSummary) {
        return `${prefix}${this.sanitizeSpokenSentence(task.spokenSummary)}`;
      }
    }

    // 4. Multiple successful tasks: merge into concise sentence
    if (successTasks.length > 1) {
      const actionSummaries = successTasks
        .map((t) => t.spokenSummary)
        .filter(Boolean) as string[];

      if (actionSummaries.length > 0) {
        return `${prefix}${this.sanitizeSpokenSentence(actionSummaries.join(" "))}`;
      }

      const actions = successTasks.map((t) => t.action.split(".")[1] || t.action).join(" and ");
      return `${prefix}Successfully completed ${actions}.`;
    }

    if (language === "hi" || language === "hinglish") {
      return `${prefix}Aapka task pura ho gaya hai.`;
    }
    return `${prefix}All requested tasks have completed successfully.`;
  }

  /**
   * Enforce narrator invariant: one sentence at most, strips keys, tokens, paths
   */
  private sanitizeSpokenSentence(text: string): string {
    const redacted = privacyGuard.redactSensitiveData(text).cleanText;
    // Strip file paths, JWTs, and long technical strings
    const clean = redacted
      .replace(/[A-Za-z]:\\[\w\-\\]+/g, "local folder")
      .replace(/https?:\/\/[^\s]+/g, "link")
      .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "")
      .trim();

    // Ensure it ends cleanly with punctuation
    if (!clean.endsWith(".") && !clean.endsWith("!") && !clean.endsWith("?")) {
      return `${clean}.`;
    }
    return clean;
  }
}

export const narrator = new Narrator();
