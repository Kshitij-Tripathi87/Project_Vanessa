import { Task, PermissionStatus } from "@vanessa/shared";
import { eventBus } from "./eventBus.js";
import { privacyGuard } from "./privacy.js";

export class PermissionGuard {
  public autonomousMode: boolean = process.env.AUTONOMOUS_MODE !== "false";

  // Actions that require explicit user confirmation before executing
  private confirmActions = new Set<string>([
    "wifi.restart_adapter",
    "drive.upload",
    "gmail.send",
    "system.shutdown",
    "system.reboot",
    "file.delete",
    "developer.claude_code.open_autonomous",
  ]);

  // Session-level granted permissions
  private sessionGranted = new Set<string>();

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

  alwaysAllowForSession(actionKey: string) {
    this.sessionGranted.add(actionKey);
  }

  check(task: Task): PermissionStatus {
    const actionKey = task.action;

    // Check for blocked malicious patterns in params
    const paramStr = JSON.stringify(task.params || {});
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(paramStr)) {
        eventBus.emitEvent("audit:log", {
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

    // Check Folder Allowlist for file operations
    const filePath = task.params?.path || task.params?.targetPath || task.params?.filePath || task.params?.basePath;
    if (filePath && typeof filePath === "string") {
      // If path points to system folders like Windows/System32, block
      const lower = filePath.toLowerCase();
      if (lower.includes("windows\\system32") || lower.includes("program files") || lower.includes("windows\\syswow64")) {
        eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          resource: filePath,
          risk: "destructive",
          permission: "blocked",
          status: "blocked",
          details: `Blocked by folder privacy policy: access to protected Windows directory denied`,
        });
        return "blocked";
      }
    }

    if (this.sessionGranted.has(actionKey)) {
      return "allowed";
    }

    if (this.confirmActions.has(actionKey)) {
      if (this.autonomousMode) {
        eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          resource: task.params?.path || task.params?.resource || task.action,
          risk: task.risk || "medium",
          permission: "autonomous_approved",
          status: "autonomous_approved",
          details: `Autonomous Execution: Executed ${task.action} without interruption`,
        });
        return "allowed";
      }
      return "confirm";
    }

    return "allowed";
  }
}

export const permissionGuard = new PermissionGuard();
