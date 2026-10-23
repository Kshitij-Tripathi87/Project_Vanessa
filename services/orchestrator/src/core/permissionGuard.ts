import * as path from "node:path";
import { Task, PermissionStatus } from "@vanessa/shared";
import { eventBus } from "./eventBus.js";
import { privacyGuard } from "./privacy.js";

export class PermissionGuard {
  // High-risk actions require confirmation unless autonomy is explicitly enabled.
  public autonomousMode: boolean = process.env.AUTONOMOUS_MODE === "true";

  // Actions that require explicit user confirmation before executing
  private confirmActions = new Set<string>([
    "codex.open",
    "wifi.restart_adapter",
    "drive.upload",
    "gmail.send",
    "system.shutdown",
    "system.reboot",
    "file.delete",
    "developer.claude_code.open_autonomous",
    "terminal.run_command",
    "tests.run",
    "claude_code.open",
  ]);

  // Actions permanently blocked by policy (OWASP: Least privilege & high-risk prevention)
  private blockedPatterns: RegExp[] = [
    /format\s+[a-z]:/i,
    /del\s+\/f\s+\/s\s+\/q\s+c:\\/i,
    /rm\s+-rf\s+\//i,
    /reg\s+delete/i,
    /git\s+push\s+.*--force/i,
    /\b(extract_password|dump_credentials|get_password)\b/i,
    /\b(make_payment|send_payment|execute_payment|charge_card|transfer_money)\b/i,
    /\bcredit[_-]?card[_-]?number\b/i,
  ];

  check(task: Task, emitAudit = true): PermissionStatus {
    const actionKey = task.action;

    // Match dangerous command text in both the action and parameters.
    const paramStr = JSON.stringify(task.params || {});
    const inspectedText = `${actionKey} ${paramStr}`;
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(inspectedText)) {
        if (emitAudit) eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          resource: task.params?.path || task.params?.file || "system",
          risk: "blocked",
          permission: "blocked",
          status: "blocked",
          details: `Blocked by safety policy: matching rule ${pattern.source}`,
        });
        return "blocked";
      }
    }

    // Enforce the approved-folder policy on filesystem and cloud-file actions.
    const isFileAccess = task.agent === "files" || /^(file|folder|directory)\./i.test(actionKey) || actionKey === "drive.upload";
    if (isFileAccess) {
      const pathKeys = ["path", "targetPath", "filePath", "basePath", "sourceDir", "oldPath", "newPath", "file"];
      const filePaths = pathKeys
        .map((key) => task.params?.[key])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (actionKey === "folder.create") {
        const folderName = task.params?.name || task.params?.path;
        if (typeof folderName === "string" && folderName.trim()) {
          const basePath = typeof task.params?.basePath === "string"
            ? task.params.basePath
            : privacyGuard.getAllowedFolders()[0] || process.cwd();
          filePaths.push(path.isAbsolute(folderName) ? folderName : path.resolve(basePath, folderName));
        }
      }
      const protectedPath = filePaths.find((filePath) => /(?:^|[\\/])(?:windows[\\/](?:system32|syswow64)|program files(?: \(x86\))?)(?:[\\/]|$)/i.test(path.normalize(filePath)));
      if (protectedPath) {
        if (emitAudit) eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          resource: protectedPath,
          risk: "blocked",
          permission: "blocked",
          status: "blocked",
          details: "Blocked by protected system path policy.",
        });
        return "blocked";
      }
      const deniedPath = filePaths.find((filePath) => !privacyGuard.isPathAllowed(filePath));
      if (deniedPath) {
        if (emitAudit) eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          resource: deniedPath,
          risk: "destructive",
          permission: "blocked",
          status: "blocked",
          details: "Blocked by folder privacy policy: path is outside approved folders.",
        });
        return "blocked";
      }
    }

    // Explicitly sensitive actions and any high-risk task always require a
    // fresh, per-task human approval. Global autonomy never overrides this.
    if (this.confirmActions.has(actionKey) || task.risk === "high") {
      if (emitAudit) eventBus.emitEvent("audit:log", {
        id: `audit-${Date.now()}`,
        timestamp: Date.now(),
        taskId: task.id,
        agent: task.agent,
        action: task.action,
        resource: task.params?.path || task.params?.resource || task.action,
        risk: task.risk || "medium",
        permission: "requires_confirmation",
        status: "awaiting_approval",
        details: "Explicit user approval is required before this action can run.",
      });
      return "confirm";
    }

    return "allowed";
  }
}

export const permissionGuard = new PermissionGuard();
