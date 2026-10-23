import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { modelRouter } from "../core/router.js";

const execAsync = promisify(exec);

export class VanessaAgent {
  private openJarvisDir: string;

  constructor() {
    const searchDirs = [
      path.resolve(process.cwd(), "agents and tools"),
      path.resolve(process.cwd(), "..", "..", "agents and tools"),
      "c:\\Users\\21330\\Documents\\Project_Vanessa\\agents and tools",
      path.resolve(process.cwd(), "agents_and_tools"),
      path.resolve(process.cwd(), "..", "..", "agents_and_tools"),
      "c:\\Users\\21330\\Documents\\Project_Vanessa\\agents_and_tools",
      path.resolve(process.cwd(), "tools"),
      path.resolve(process.cwd(), "..", "..", "tools"),
      "c:\\Users\\21330\\Documents\\Project_Vanessa\\tools",
      path.resolve(process.cwd(), "OpenJarvis"),
      path.resolve(process.cwd(), "..", "..", "OpenJarvis"),
      "c:\\Users\\21330\\Documents\\Project_Vanessa\\OpenJarvis",
    ];
    this.openJarvisDir = searchDirs.find((d) => fs.existsSync(d)) || searchDirs[0];
  }

  async execute(action: string, params: Record<string, any> = {}): Promise<any> {
    switch (action) {
      case "vanessa.ask":
      case "tools.ask":
      case "connector.ask":
      case "jarvis.ask":
      case "openjarvis.ask": {
        const query = params.query || params.prompt || params.command || "System status check";
        // Previous NVIDIA reply and Python-bridge fallback retained, disabled.
        // const intelligentReply = await modelRouter.callConversationalLLM(query);
        // if (intelligentReply) {
        //   return { success: true, content: intelligentReply, mode: "nvidia_nemotron_550b" };
        // }
        // return this.ask(query);
        return this.ask(query);
      }

      case "vanessa.run_tool":
      case "tools.run_tool":
      case "connector.run_tool":
      case "jarvis.run_tool":
      case "openjarvis.run_tool": {
        const tool = params.tool || params.name || "shell_exec";
        const toolParams = params.params || {};
        return this.runTool(tool, toolParams);
      }

      case "vanessa.shell":
      case "tools.shell":
      case "connector.shell":
      case "jarvis.shell":
      case "openjarvis.shell": {
        const command = params.command || params.cmd || "echo Vanessa System Online";
        return this.runTool("shell_exec", { command });
      }

      case "vanessa.git":
      case "tools.git":
      case "connector.git":
      case "jarvis.git":
      case "openjarvis.git": {
        const gitTool = params.tool || "git_status";
        return this.runTool(gitTool, params);
      }

      case "vanessa.browser":
      case "tools.browser":
      case "connector.browser":
      case "jarvis.browser":
      case "openjarvis.browser": {
        const url = params.url || "https://google.com";
        return this.runTool("browser_navigate", { url });
      }

      case "vanessa.schedule_create":
      case "tools.schedule_create":
      case "connector.schedule_create":
      case "jarvis.schedule_create":
      case "openjarvis.schedule_create": {
        const prompt = params.prompt || "Daily system diagnostics and backup";
        const type = params.type || "cron";
        const value = params.value || "0 9 * * *";
        const tools = params.tools || "shell_exec,file_read,file_write,git_status";
        return this.scheduleCreate(prompt, type, value, tools);
      }

      case "vanessa.schedule_list":
      case "jarvis.schedule_list":
      case "openjarvis.schedule_list": {
        return this.scheduleList();
      }

      case "vanessa.status":
      case "jarvis.status":
      case "openjarvis.status": {
        return this.getStatus();
      }

      case "vanessa.run_goal":
      case "tools.run_goal":
      case "connector.run_goal":
      case "jarvis.run_goal":
      case "openjarvis.run_goal": {
        const goal = params.goal || params.objective || params.query || "Perform system goal";
        const tools = params.tools;
        const maxSteps = params.maxSteps || params.max_steps || 5;
        return this.runGoal(goal, tools, maxSteps);
      }

      default:
        // Default to asking Vanessa or running tool
        if (action.startsWith("vanessa.tool.")) {
          const toolName = action.replace("vanessa.tool.", "");
          return this.runTool(toolName, params);
        }
        if (action.startsWith("jarvis.tool.")) {
          const toolName = action.replace("jarvis.tool.", "");
          return this.runTool(toolName, params);
        }
        return this.ask(params.query || action);
    }
  }

  async runBridge(action: string, payload?: Record<string, any>): Promise<any> {
    try {
      if (!process.env.NVIDIA_API_KEY) {
        process.env.NVIDIA_API_KEY = "nvapi-placeholder-key-replace-with-your-nvidia-key";
      }
      if (!process.env.NVIDIA_BASE_URL) {
        process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
      }
      if (!process.env.NVIDIA_MODEL) {
        process.env.NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
      }

      const venvPy = path.join(this.openJarvisDir, ".venv", "Scripts", "python.exe");
      const pythonExe = fs.existsSync(venvPy) ? `"${venvPy}"` : "uv run python";

      let cmd = `${pythonExe} vanessa_bridge.py ${action}`;
      if (payload) {
        const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
        cmd += ` --b64 ${b64}`;
      }

      const { stdout } = await execAsync(cmd, {
        cwd: this.openJarvisDir,
        timeout: 45000,
      });

      return JSON.parse(stdout.trim());
    } catch (err: any) {
      console.warn("[VanessaAgent] Bridge execution fallback:", err.message);
      return {
        success: false,
        error: err.message,
        fallback: true,
      };
    }
  }

  async getStatus(): Promise<any> {
    return this.runBridge("status");
  }

  async ask(query: string): Promise<any> {
    // Previous Python/NVIDIA conversational fallback retained, disabled.
    // return this.runBridge("ask", { query });
    const content = await modelRouter.callConversationalLLM(query);
    if (!content) throw new Error("Gemini returned no conversational reply.");
    return { success: true, content, mode: "gemini-3.5-flash-lite" };
  }

  async runTool(tool: string, params: Record<string, any> = {}): Promise<any> {
    return this.runBridge("run_tool", { tool, params });
  }

  async scheduleCreate(prompt: string, type: string, value: string, tools: string): Promise<any> {
    return this.runBridge("schedule_create", { prompt, type, value, tools });
  }

  async scheduleList(): Promise<any> {
    return this.runBridge("schedule_list");
  }

  async runGoal(goal: string, tools?: string[], maxSteps: number = 5): Promise<any> {
    return this.runBridge("run_goal", { goal, tools, max_steps: maxSteps });
  }
}

export const OpenJarvisAgent = VanessaAgent;
export const vanessaAgent = new VanessaAgent();
export const openJarvisAgent = vanessaAgent;
export const toolsAgent = vanessaAgent;
export const connectorAgent = vanessaAgent;
