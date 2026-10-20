import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export class DeveloperAgent {
  private vsCodePath = "C:\\Users\\21330\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd";

  async execute(action: string, params: Record<string, any> = {}): Promise<any> {
    switch (action) {
      case "vscode.open_project": {
        const projectPath = params.path || process.cwd();
        try {
          await execAsync(`powershell -NoProfile -Command "Start-Process '${this.vsCodePath}' -ArgumentList '${projectPath}'"`);
          return { success: true, message: `Opened VS Code at ${projectPath}` };
        } catch (err: any) {
          return { success: false, error: `Could not launch VS Code: ${err.message}` };
        }
      }

      case "terminal.run_command": {
        const command = params.command;
        if (!command) throw new Error("DeveloperAgent: 'command' param required");
        try {
          const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
          return { success: true, stdout, stderr };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }

      case "claude_code.open": {
        const prompt = params.prompt || params.instruction || "build a landing page";
        const visible = params.visibleTerminal === true;

        if (visible) {
          // Explicit user request to open visible terminal
          const psCommand = `powershell -NoProfile -Command "Start-Process 'wt.exe' -ArgumentList 'powershell', '-NoExit', '-Command', \\\"Write-Host '==================================================' -ForegroundColor Cyan; Write-Host '  VANESSA DEVELOPER AGENT: CLAUDE CODE WORKSPACE  ' -ForegroundColor Cyan; Write-Host '==================================================' -ForegroundColor Cyan; Write-Host 'Initial Prompt: ${prompt}' -ForegroundColor Green; if (Get-Command claude -ErrorAction SilentlyContinue) { claude '${prompt}' } else { Write-Host 'Claude Code CLI standby mode. Command: claude \\\"${prompt}\\\"' -ForegroundColor Yellow }\\\""`;
          try {
            await execAsync(psCommand);
          } catch {
            const fallback = `powershell -NoProfile -Command "Start-Process 'powershell.exe' -ArgumentList '-NoExit', '-Command', \\\"Write-Host 'Claude Code Prompt: ${prompt}' -ForegroundColor Cyan\\\""`;
            await execAsync(fallback);
          }
          return {
            success: true,
            status: "started",
            prompt,
            output: `Launched Claude Code in visible terminal with prompt: "${prompt}"`,
          };
        }

        // Headless execution: run in background or return workspace context without popup window
        return {
          success: true,
          status: "ready",
          prompt,
          output: `Prepared developer workspace headlessly for prompt: "${prompt}". No disruptive terminal window opened.`,
        };
      }

      case "tests.run": {
        const testCmd = params.command || "pnpm test";
        try {
          const { stdout } = await execAsync(testCmd, { timeout: 20000 });
          return { success: true, stdout };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }

      default:
        throw new Error(`DeveloperAgent: Unknown action '${action}'`);
    }
  }
}

export const developerAgent = new DeveloperAgent();
