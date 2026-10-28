import { runPowerShell } from "./powershell.js";
import { openCodex } from "./codex-launcher.js";
import type { AgentRunContext } from "@vanessa/shared";

export class DeveloperAgent {
  private vsCodePath = "C:\\Users\\21330\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd";

  private blocked(action: string, reason: string): any {
    return {
      agentId: "developer",
      status: "blocked",
      success: false,
      summary: reason,
      spokenSummary: "I blocked this developer operation before launching a process.",
      error: reason,
      evidence: [{
        description: "No process was started; the operation was rejected before execution.",
        source: "developer-agent-containment",
        timestamp: new Date().toISOString(),
        confidence: 1,
        data: { outcome: "blocked", actionId: action, processStarted: false },
      }],
      artifacts: [],
      verification: { passed: false, details: reason },
      data: { outcome: "blocked", actionId: action, processStarted: false },
    };
  }

  async execute(action: string, params: Record<string, any> = {}, context?: AgentRunContext): Promise<any> {
    switch (action) {
      case "codex.open":
        if (
          !context?.task ||
          context.task.action !== "codex.open" ||
          !context.task.approvalDigest ||
          context.task.approvalConsumedAt === undefined ||
          context.task.approvalPolicyVersion !== "trustworthy-execution-v1" ||
          typeof context.task.approvalExpiresAt !== "number" ||
          context.task.approvalExpiresAt <= Date.now()
        ) {
          return this.blocked(
            action,
            "Interactive Codex launch requires a live, consumed, task-bound approval. Direct agent invocation is not an authorization path."
          );
        }
        console.log(`[Codex] handoff project=${params.projectPath} promptCharacters=${typeof params.prompt === "string" ? params.prompt.length : 0}`);
        {
          const result = await openCodex(params);
          console.log(`[Codex] returned success=${result.success} status=${result.status || "none"} terminalPid=${result.terminalPid || "none"}; coding completion is not verified`);
          if (!result.success) console.error(`[Codex] launch failed: ${result.error}`);
          return result;
        }

      case "codex.run_task":
        return this.blocked(
          action,
          "Autonomous Codex task execution is disabled by Trustworthy Execution v1 policy. Prepare repairs only through the approved isolated-worktree workflow."
        );

      case "vscode.open_project": {
        const projectPath = params.path || process.cwd();
        try {
          await runPowerShell(
            "Start-Process -FilePath $env:VANESSA_VSCODE -ArgumentList $env:VANESSA_PROJECT",
            { VANESSA_VSCODE: this.vsCodePath, VANESSA_PROJECT: projectPath }
          );
          return { success: true, message: `Opened VS Code at ${projectPath}` };
        } catch (err: any) {
          return { success: false, error: `Could not launch VS Code: ${err.message}` };
        }
      }

      case "terminal.run_command":
        return {
          agentId: "developer",
          status: "blocked",
          success: false,
          summary: "Agent-driven arbitrary terminal commands are temporarily disabled until they use the managed execution registry.",
          spokenSummary: "I blocked arbitrary terminal execution. Use a registered, verified operation instead.",
          error: "Unregistered arbitrary shell execution is disabled by Trustworthy Execution v1 containment.",
          evidence: [{
            description: "No process was started; request was rejected before execution.",
            source: "developer-agent.containment",
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { outcome: "blocked", processStarted: false }
          }],
          artifacts: [],
          verification: { passed: false, details: "No process was started." },
          data: { outcome: "blocked", processStarted: false }
        };

      case "claude_code.open": {
        return {
          agentId: "developer",
          status: "blocked",
          success: false,
          summary: "Claude Code prompt execution is disabled until prompts are passed as data to a fixed launcher instead of interpolated into PowerShell source.",
          spokenSummary: "I blocked this developer launch because its prompt cannot be passed through the current launcher safely.",
          error: "Unsafe dynamic PowerShell command construction has been removed from this path.",
          evidence: [{
            description: "No prompt-bearing process was launched.",
            source: "developer-agent.containment",
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { outcome: "blocked", processStarted: false }
          }],
          artifacts: [],
          verification: { passed: false, details: "No prompt-bearing process was launched." },
          data: { outcome: "blocked", processStarted: false }
        };
      }

      case "tests.run": {
        return {
          agentId: "developer",
          status: "blocked",
          success: false,
          summary: "Generic test commands are disabled. Tests must use the registered TestingAgent suite and a registered isolated workspace.",
          spokenSummary: "I blocked that test request because arbitrary test commands are not permitted.",
          error: "Use testing.run_incident_lab with a registered workspaceId and expected patch digest.",
          evidence: [{
            description: "No test process was started.",
            source: "developer-agent.containment",
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { outcome: "blocked", processStarted: false }
          }],
          artifacts: [],
          verification: { passed: false, details: "No test process was started." },
          data: { outcome: "blocked", processStarted: false }
        };
      }

      default:
        throw new Error(`DeveloperAgent: Unknown action '${action}'`);
    }
  }
}

export const developerAgent = new DeveloperAgent();
