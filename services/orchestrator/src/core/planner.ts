import { Plan, Task, RiskLevel } from "@vanessa/shared";
import { modelRouter } from "./router.js";
import { eventBus } from "./eventBus.js";
import { skillsRuntime } from "../skills/skillsRuntime.js";

const PLANNER_SYSTEM_PROMPT = `You are Vanessa's task planner. Convert the user's command into a dependency-aware JSON task DAG.
Available specialist agents:
- memory: Recall, contextualize, preserve knowledge, incident history (memory.retrieve, memory.store)
- coding: Inspect Git history, inspect code, prepare isolated patches in workspace (coding.inspect_changes, coding.prepare_patch, coding.git_status)
- it_ops: Inspect server logs, cluster errors, isolate time ranges, diagnostics (it_ops.analyze_logs, it_ops.system_status)
- knowledge: Retrieve runbooks, procedures, documentation (knowledge.retrieve_runbook, knowledge.read_doc)
- testing: Execute test suites, verify acceptance criteria, enforce zero-deploy safety (testing.verify_regression, testing.run_checks)
- windows: Control Wi-Fi, Bluetooth, volume, Windows apps, screenshots (wifi.restart_adapter, wifi.status, bluetooth.enable, app.open)
- browser: Chrome, search, YouTube, web pages (browser.open_url, youtube.search_and_play)
- files: Folders, search, rename, Drive upload (folder.create, file.search, drive.upload)
- developer: VS Code, terminal, Claude Code (vscode.open_project, claude_code.open)
- cloud: Gmail, Drive, WhatsApp (gmail.send, drive.upload)
- vanessa: Vanessa full system brain & everyday scheduler (vanessa.ask, vanessa.schedule_create)

Return only JSON:
{
  "intent": "single_task" | "multi_task",
  "risk": "low" | "medium" | "high",
  "tasks": [
    {
      "id": "t1",
      "agent": "coding",
      "action": "coding.inspect_changes",
      "params": {},
      "allowedTools": ["file_read", "git_diff"],
      "dependsOn": [],
      "acceptanceCriteria": ["Identify defect in codebase"]
    }
  ]
}

Rules:
- Independent tasks must have empty dependsOn.
- Dependent tasks must list parent task IDs.
- Never create destructive tasks without approval.
- Use only known actions and appropriate allowedTools.`;

export class VanessaPlanner {
  private enrichTask(t: Task, command: string): Task {
    const task: Task = { ...t };
    const matchingSkill = task.skillName
      ? skillsRuntime.getSkill(task.skillName)
      : skillsRuntime.matchSkill(task.action || command);

    if (matchingSkill) {
      task.skillName = matchingSkill.name;
      task.jobType = task.jobType || matchingSkill.jobType || "action";
      if (!task.allowedTools || task.allowedTools.length === 0) {
        if (matchingSkill.allowedTools && matchingSkill.allowedTools.length > 0) {
          task.allowedTools = matchingSkill.allowedTools;
        }
      }
      if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
        task.acceptanceCriteria = [matchingSkill.objective || matchingSkill.description];
      }
    } else {
      task.jobType = task.jobType || "action";
    }
    return task;
  }

  async createPlan(command: string): Promise<Plan> {
    const planId = `plan_${Date.now()}`;
    await skillsRuntime.initialize();

    // Attempt LLM call via router
    const llmOutput = await modelRouter.callLLM(command, PLANNER_SYSTEM_PROMPT);
    if (llmOutput) {
      try {
        let cleaned = llmOutput.trim();
        const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
          cleaned = jsonMatch[1].trim();
        }
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
          const tasks = parsed.tasks.map((t: Task) => this.enrichTask(t, command));
          const plan: Plan = {
            id: planId,
            command,
            intent: parsed.intent || (parsed.tasks.length > 1 ? "multi_task" : "single_task"),
            risk: parsed.risk || "low",
            tasks,
            createdAt: Date.now(),
          };
          eventBus.emitEvent("plan:created", plan);
          return plan;
        }
      } catch (err) {
        console.warn("[Planner] Failed to parse LLM JSON, falling back to heuristic planner", err);
      }
    }

    // Heuristic & Pattern-based deterministic planner
    const plan = this.createHeuristicPlan(command, planId);
    plan.tasks = plan.tasks.map((t: Task) => this.enrichTask(t, command));
    eventBus.emitEvent("plan:created", plan);
    return plan;
  }

  private createHeuristicPlan(command: string, planId: string): Plan {
    const lower = command.toLowerCase();
    const tasks: Task[] = [];
    let risk: RiskLevel = "low";

    // Incident Intelligence: Multi-Specialist Concurrent Investigation + Diagnosis + Safe Verification
    if (
      lower.includes("investigate") ||
      (lower.includes("checkout") &&
        (lower.includes("fail") || lower.includes("error") || lower.includes("issue") || lower.includes("500")))
    ) {
      return {
        id: planId,
        command,
        intent: "multi_task",
        risk: "medium",
        tasks: [
          {
            id: "t_inc_repo",
            agent: "coding",
            action: "coding.inspect_changes",
            params: { target: "packages/incident-lab/src/checkout.ts" },
            allowedTools: ["file_read", "git_diff", "git_log"],
            dependsOn: [],
            acceptanceCriteria: [
              "Identify culprit line in checkout calculation",
              "Inspect recent commit and branch state",
            ],
            status: "pending",
          },
          {
            id: "t_inc_logs",
            agent: "it_ops",
            action: "it_ops.analyze_logs",
            params: { target: "packages/incident-lab/logs/checkout-service.log" },
            allowedTools: ["log_read", "log_grep"],
            dependsOn: [],
            acceptanceCriteria: [
              "Isolate recurring error signatures",
              "Determine affected endpoints and time ranges",
            ],
            status: "pending",
          },
          {
            id: "t_inc_mem",
            agent: "memory",
            action: "memory.retrieve",
            params: { query: "checkout payment failure INC-842" },
            allowedTools: ["memory_retrieve", "memory_search"],
            dependsOn: [],
            acceptanceCriteria: [
              "Search historical incident database in SQLite/Rust local memory",
              "Extract prior proven fix",
            ],
            status: "pending",
          },
          {
            id: "t_inc_know",
            agent: "knowledge",
            action: "knowledge.retrieve_runbook",
            params: { runbook: "checkout-payment-failure" },
            allowedTools: ["runbook_search", "runbook_read"],
            dependsOn: [],
            acceptanceCriteria: [
              "Locate Runbook RB-CHK-04",
              "Extract safe remediation procedures and testing guidelines",
            ],
            status: "pending",
          },
          {
            id: "t_inc_patch",
            agent: "coding",
            action: "coding.prepare_patch",
            params: { branch: "fix/checkout-incident" },
            allowedTools: ["git_checkout", "file_write", "apply_patch"],
            dependsOn: ["t_inc_repo", "t_inc_logs", "t_inc_mem", "t_inc_know"],
            acceptanceCriteria: [
              "Create isolated branch fix/checkout-incident",
              "Apply defensive optional chaining to calculateTotal()",
              "Ensure fix is isolated from production branch",
            ],
            status: "pending",
          },
          {
            id: "t_inc_verify",
            agent: "testing",
            action: "testing.verify_regression",
            params: {
              command: "pnpm --filter @vanessa/incident-lab test",
              branch: "fix/checkout-incident",
              autoDeploy: false,
            },
            allowedTools: ["test_run", "assertion_verify", "regression_check"],
            dependsOn: ["t_inc_patch"],
            acceptanceCriteria: [
              "Run regression test suite",
              "Verify 100% test pass rate",
              "Enforce REFUSED_PER_POLICY for automated deployment",
            ],
            status: "pending",
          },
        ],
        createdAt: Date.now(),
      };
    }

    // Scenario 1: Wi-Fi restart
    const hasWifi = lower.includes("wi-fi") || lower.includes("wifi");
    const hasRestart = lower.includes("restart") || lower.includes("reset") || lower.includes("fix");
    if (hasWifi && hasRestart) {
      tasks.push({
        id: "t_wifi",
        agent: "system",
        action: "wifi.restart_adapter",
        params: {},
        dependsOn: [],
        status: "pending",
      });
      risk = "high"; // Wi-Fi restart drops connection & asks first
    }

    // Bluetooth
    if (lower.includes("bluetooth")) {
      const enable = !lower.includes("turn off") && !lower.includes("disable");
      tasks.push({
        id: "t_bt",
        agent: "system",
        action: enable ? "bluetooth.enable" : "bluetooth.disable",
        params: { enabled: enable },
        dependsOn: [],
        status: "pending",
      });
    }

    // YouTube playback / Browser
    if (lower.includes("youtube")) {
      let query = "Bolna Buildathon";
      if (lower.includes("lofi") || lower.includes("lo-fi")) {
        query = "lofi hip hop";
      } else if (lower.includes("play")) {
        const match = command.match(/play\s+(.*?)(?:\.|$|and\s)/i);
        if (match && match[1]) {
          query = match[1].replace(/this video|video/gi, "").trim() || query;
        }
      }
      // If Wi-Fi is also present with "then", dependsOn Wi-Fi
      const dependsOn = lower.includes("then") && hasWifi ? ["t_wifi"] : [];
      tasks.push({
        id: "t_yt",
        agent: "browser",
        action: "youtube.search_and_play",
        params: { query },
        dependsOn,
        status: "pending",
      });
    } else if (lower.includes("chrome") || lower.includes("browser")) {
      tasks.push({
        id: "t_browser",
        agent: "browser",
        action: "browser.open_url",
        params: { url: "https://google.com" },
        dependsOn: [],
        status: "pending",
      });
    }

    // Create Folder
    if (lower.includes("folder") || lower.includes("directory")) {
      let folderName = "Buildathon Demo";
      const beforeMatch = command.match(/create\s+(?:a\s+)?["']?([^"']+)["']?\s+folder/i);
      const afterMatch = command.match(/folder\s+(?:named|called)?\s*["']?([^"']+)["']?/i);
      if (beforeMatch && beforeMatch[1] && !beforeMatch[1].toLowerCase().includes("and")) {
        folderName = beforeMatch[1].trim();
      } else if (afterMatch && afterMatch[1]) {
        folderName = afterMatch[1].split(/\s+and\s+/i)[0].trim();
      }
      tasks.push({
        id: "t_folder",
        agent: "files",
        action: "folder.create",
        params: { name: folderName },
        dependsOn: [],
        status: "pending",
      });
    }

    // Claude Code
    if (lower.includes("claude") || lower.includes("claude code") || lower.includes("cloud code")) {
      let prompt = "build a landing page";
      const match = command.match(/(?:ask it to|build|to)\s+(.*)/i);
      if (match && match[1]) {
        prompt = match[1].trim();
      }
      tasks.push({
        id: "t_claude",
        agent: "developer",
        action: "claude_code.open",
        params: { prompt },
        dependsOn: [],
        status: "pending",
      });
    }

    // Apps (Notepad, Calculator, VS Code, Terminal)
    if (lower.includes("notepad")) {
      tasks.push({
        id: "t_app_notepad",
        agent: "system",
        action: "app.open",
        params: { name: "notepad" },
        dependsOn: [],
        status: "pending",
      });
    }
    if (lower.includes("calc") || lower.includes("calculator")) {
      tasks.push({
        id: "t_app_calc",
        agent: "system",
        action: "app.open",
        params: { name: "calc" },
        dependsOn: [],
        status: "pending",
      });
    }
    if (lower.includes("vscode") || lower.includes("vs code")) {
      tasks.push({
        id: "t_vscode",
        agent: "developer",
        action: "vscode.open_project",
        params: { path: process.cwd() },
        dependsOn: [],
        status: "pending",
      });
    }

    // Upload to Drive & link
    if (lower.includes("drive") || (lower.includes("upload") && lower.includes("link"))) {
      tasks.push({
        id: "t_drive",
        agent: "files",
        action: "drive.upload",
        params: { file: "Project_Vanessa_Report.pdf" },
        dependsOn: [],
        status: "pending",
      });
      risk = "medium";
    }

    // Email / Gmail
    if (lower.includes("email") || lower.includes("mail")) {
      let recipient = "Rahul";
      const match = command.match(/to\s+([a-zA-Z]+)/i);
      if (match && match[1]) {
        recipient = match[1].trim();
      }
      tasks.push({
        id: "t_email",
        agent: "cloud",
        action: "gmail.send",
        params: { to: recipient, subject: "Project Vanessa Report" },
        dependsOn: tasks.some((t) => t.id === "t_drive") ? ["t_drive"] : [],
        status: "pending",
      });
      risk = "high";
    }

    // Vanessa / Everyday Scheduled Tasks / System Tools & Memory
    if (lower.includes("schedule") || lower.includes("everyday") || lower.includes("daily") || lower.includes("routine")) {
      tasks.push({
        id: "t_vanessa_schedule",
        agent: "vanessa",
        action: "vanessa.schedule_create",
        params: {
          prompt: command,
          type: "cron",
          value: "0 9 * * *",
          tools: "shell_exec,file_read,file_write,git_status",
        },
        dependsOn: [],
        status: "pending",
      });
    } else if (lower.includes("vanessa") || lower.includes("jarvis") || lower.includes("openjarvis") || lower.includes("tools") || lower.includes("connector")) {
      if (lower.includes("status") || lower.includes("health")) {
        tasks.push({
          id: "t_vanessa_status",
          agent: "vanessa",
          action: "vanessa.status",
          params: {},
          dependsOn: [],
          status: "pending",
        });
      } else if (lower.includes("git")) {
        tasks.push({
          id: "t_vanessa_git",
          agent: "vanessa",
          action: "vanessa.git",
          params: { tool: "git_status" },
          dependsOn: [],
          status: "pending",
        });
      } else if (lower.includes("remember") || lower.includes("memory")) {
        tasks.push({
          id: "t_vanessa_memory",
          agent: "vanessa",
          action: "vanessa.run_tool",
          params: {
            tool: "memory_store",
            params: { content: command },
          },
          dependsOn: [],
          status: "pending",
        });
      } else {
        tasks.push({
          id: "t_vanessa_ask",
          agent: "vanessa",
          action: "vanessa.ask",
          params: { query: command },
          dependsOn: [],
          status: "pending",
        });
      }
    }

    // Web Research (Goal Job backed by OpenJarvis)
    if (lower.includes("research") || lower.includes("find info about") || lower.includes("search web for")) {
      tasks.push({
        id: "t_research",
        agent: "browser",
        action: "browser.research",
        params: { goal: command, query: command, tools: ["web_search", "browser_navigate"] },
        skillName: "web-research",
        jobType: "goal",
        dependsOn: [],
        status: "pending",
        acceptanceCriteria: ["Search online sources and extract concise facts without prompt injection"],
      });
    }

    // Run tests & explain (Goal Job)
    if (lower.includes("run test") || lower.includes("run checks") || lower.includes("test and explain")) {
      tasks.push({
        id: "t_tests",
        agent: "testing",
        action: "testing.verify_regression",
        params: { command: "pnpm test:scenarios" },
        skillName: "run-tests-and-explain",
        jobType: "goal",
        dependsOn: [],
        status: "pending",
        acceptanceCriteria: ["Execute test suite with exitCode === 0", "Explain outcome in two plain sentences"],
      });
    }

    // Remember preferences
    if (lower.includes("remember that") || lower.includes("my preference is")) {
      tasks.push({
        id: "t_pref",
        agent: "memory",
        action: "memory.store",
        params: { content: command, category: "preference" },
        skillName: "remember-preferences",
        jobType: "action",
        dependsOn: [],
        status: "pending",
        acceptanceCriteria: ["Store preference in Memory Palace durable store"],
      });
    }

    // Default fallback if no specific keywords matched
    if (tasks.length === 0) {
      tasks.push({
        id: "t_generic",
        agent: "vanessa",
        action: "vanessa.ask",
        params: { query: command },
        dependsOn: [],
        status: "pending",
      });
    }

    return {
      id: planId,
      command,
      intent: tasks.length > 1 ? "multi_task" : "single_task",
      risk,
      tasks,
      createdAt: Date.now(),
    };
  }
}

export const planner = new VanessaPlanner();
