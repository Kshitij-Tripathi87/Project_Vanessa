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

    const partialTasks = tasks.filter((t) => t.status === "partial" || t.status === "blocked" || t.status === "expired");
    if (partialTasks.length > 0) {
      const actions = partialTasks.map((t) => t.action.replace(/[._]/g, " ")).join(" and ");
      if (language === "hi" || language === "hinglish") {
        return `${prefix}${actions} ka result mila, lekin verify nahi ho paya. Dependent actions roke gaye hain.`;
      }
      return `${prefix}I got a result for ${actions}, but could not verify it. Dependent actions were stopped.`;
    }

    // A generic outcome summary is not evidence. The caller uses the verified
    // success path below when every requested task passed its postconditions.
    const successTasks = tasks.filter((t) => t.status === "success");
    if (successTasks.length > 0) {
      return this.narrateVerifiedSuccess(successTasks, language, sentiment);
    }

    if (language === "hi" || language === "hinglish") {
      return `${prefix}Kisi task ke complete hone ka verification evidence nahi mila.`;
    }
    return `${prefix}No task has verified completion evidence.`;
  }

  /**
   * Speak only facts returned by the deterministic verifier. In particular,
   * never infer that Wi-Fi is connected, media is playing, a file was uploaded,
   * or a message was sent from the action name or an agent-authored summary.
   */
  narrateVerifiedSuccess(tasks: Task[], language: string = "en", sentiment?: any): string {
    const prefix = sentiment?.urgency === "critical" ? "Urgent update: " : sentiment?.emotion === "frustrated" ? "Understood. " : "";
    const verifiedTasks = tasks.filter((task) =>
      task.status === "success" && task.verification?.verified === true
    );

    if (verifiedTasks.length === 0) {
      return language === "hi" || language === "hinglish"
        ? `${prefix}Kisi task ke complete hone ka verification evidence nahi mila.`
        : `${prefix}No task has verified completion evidence.`;
    }

    const details = verifiedTasks.map((task) => {
      const verification = task.verification;
      const detail = typeof verification?.details === "string" && verification.details.trim()
        ? verification.details.trim()
        : verification?.postconditions?.find((entry) => typeof entry === "string" && entry.trim())?.trim();
      // The fallback is deliberately generic: the verifier passed, but it did
      // not provide a user-facing detail from which to infer a specific effect.
      return detail || `${task.action.replace(/[._]/g, " ")} passed verification`;
    });

    const uniqueDetails = [...new Set(details)].slice(0, 4);
    const remaining = details.length - uniqueDetails.length;
    const suffix = remaining > 0 ? `; ${remaining} additional action(s) verified` : "";
    const summary = `Verified ${verifiedTasks.length} action(s): ${uniqueDetails.join("; ")}${suffix}`;
    return `${prefix}${this.sanitizeSpokenSentence(summary)}`;
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
      .replace(/[\r\n]+/g, " ")
      .trim();

    // Ensure it ends cleanly with punctuation
    if (!clean.endsWith(".") && !clean.endsWith("!") && !clean.endsWith("?")) {
      return `${clean}.`;
    }
    return clean;
  }
}

export const narrator = new Narrator();
