import fs from "node:fs";
import path from "node:path";
import { SkillDefinition, AgentName } from "@vanessa/shared";

export class SkillsRuntime {
  private skills: Map<string, SkillDefinition> = new Map();
  private initialized = false;
  private skillsDir: string;

  constructor() {
    const candidates = [
      path.resolve(process.cwd(), "skills"),
      path.resolve(process.cwd(), "..", "..", "skills"),
      "c:\\Users\\21330\\Documents\\Project_Vanessa\\skills",
    ];
    this.skillsDir = candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!fs.existsSync(this.skillsDir)) {
      console.warn(`[SkillsRuntime] Skills directory not found at ${this.skillsDir}`);
      this.initialized = true;
      return;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillPath)) {
          try {
            const content = fs.readFileSync(skillPath, "utf-8");
            const skill = this.parseSkillFile(entry.name, skillPath, content);
            this.skills.set(skill.name, skill);
          } catch (err) {
            console.error(`[SkillsRuntime] Failed to load skill ${entry.name}:`, err);
          }
        }
      }
    }

    this.initialized = true;
    console.log(`[SkillsRuntime] Loaded ${this.skills.size} skills from ${this.skillsDir}`);
  }

  public parseSkillFile(folderName: string, filePath: string, content: string): SkillDefinition {
    let name = folderName;
    let description = "";
    let agent: AgentName | string = "vanessa";
    let locks: string[] = [];
    let allowedTools: string[] = [];
    let jobType: "action" | "goal" = "action";
    const invariants: string[] = [];

    // Parse YAML frontmatter between --- markers
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let body = content;

    if (frontmatterMatch) {
      body = content.substring(frontmatterMatch[0].length).trim();
      const yamlLines = frontmatterMatch[1].split(/\r?\n/);
      let currentKey = "";

      for (const line of yamlLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        if (trimmed.startsWith("- ") && currentKey) {
          const item = trimmed.substring(2).trim();
          if (currentKey === "locks") locks.push(item);
          else if (currentKey === "allowedtools") allowedTools.push(item);
          else if (currentKey === "invariants") invariants.push(item);
          continue;
        }

        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          const key = trimmed.substring(0, colonIdx).trim().toLowerCase();
          const val = trimmed.substring(colonIdx + 1).trim();
          currentKey = key;

          if (key === "name" && val) name = val;
          else if (key === "description" && val) description = val;
          else if (key === "agent" && val) agent = val as AgentName;
          else if (key === "type" && val) jobType = val.toLowerCase().includes("goal") ? "goal" : "action";
          else if (key === "jobtype" && val) jobType = val.toLowerCase().includes("goal") ? "goal" : "action";
        }
      }
    }

    // Infer goal vs action if not specified
    if (
      name.includes("research") ||
      name.includes("triage") ||
      name.includes("brief") ||
      name.includes("incident") ||
      name.includes("explain")
    ) {
      jobType = "goal";
    }

    // Extract Objective
    const objMatch = body.match(/##\s*Objective\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    const objective = objMatch ? objMatch[1].trim() : "";

    // Extract Steps
    const stepsMatch = body.match(/##\s*Steps\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    const steps: string[] = [];
    if (stepsMatch) {
      const stepLines = stepsMatch[1].split(/\r?\n/);
      for (const s of stepLines) {
        const trimmed = s.trim();
        if (/^\d+\.|\*/.test(trimmed)) {
          steps.push(trimmed);
        }
      }
    }

    // Extract Invariants
    const invMatch = body.match(/##\s*Invariants?\r?\n([\s\S]*?)(?=\r?\n##|$)/i);
    if (invMatch) {
      const invLines = invMatch[1].split(/\r?\n/);
      for (const inv of invLines) {
        const trimmed = inv.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          invariants.push(trimmed.replace(/^[-*]\s*/, ""));
        }
      }
    }

    return {
      name,
      description,
      agent,
      locks,
      allowedTools,
      jobType,
      invariants,
      instructions: body,
      objective,
      steps,
      filePath,
    };
  }

  public listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  public getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  public matchSkill(query: string): SkillDefinition | undefined {
    const lower = query.toLowerCase();

    // 1. Exact or name containment
    for (const [name, skill] of this.skills.entries()) {
      if (lower.includes(name.toLowerCase())) {
        return skill;
      }
    }

    // 2. Semantic keywords mapping
    if (lower.includes("wifi") || lower.includes("wi-fi") || lower.includes("network") || lower.includes("adapter")) {
      return this.skills.get("network-troubleshoot");
    }
    if (lower.includes("research") || lower.includes("search online") || lower.includes("find info")) {
      return this.skills.get("web-research");
    }
    if (lower.includes("youtube") || lower.includes("play music") || lower.includes("play video")) {
      return this.skills.get("youtube-playback");
    }
    if (lower.includes("drive") || lower.includes("upload") || lower.includes("cloud storage")) {
      return this.skills.get("drive-upload");
    }
    if (lower.includes("incident") || lower.includes("checkout") || lower.includes("500 error") || lower.includes("triage")) {
      return this.skills.get("incident-triage");
    }
    if (lower.includes("landing page") || lower.includes("brief") || lower.includes("website spec")) {
      return this.skills.get("landing-page-brief");
    }
    if (lower.includes("test") || lower.includes("run checks") || lower.includes("regression")) {
      return this.skills.get("run-tests-and-explain");
    }
    if (lower.includes("remember") || lower.includes("preference") || lower.includes("favorite")) {
      return this.skills.get("remember-preferences");
    }
    if (lower.includes("folder") || lower.includes("directory") || lower.includes("setup project")) {
      return this.skills.get("folder-setup");
    }
    if (lower.includes("email") || lower.includes("forward")) {
      return this.skills.get("email-forward");
    }
    if (lower.includes("open app") || lower.includes("launch") || lower.includes("start program")) {
      return this.skills.get("app-launcher");
    }

    return undefined;
  }

  public getSkillPromptAugmentation(skill: SkillDefinition): string {
    return `[Skill Playbook: ${skill.name}]
Objective: ${skill.objective || skill.description}
${skill.steps && skill.steps.length > 0 ? `Procedural Steps:\n${skill.steps.join("\n")}` : ""}
${skill.invariants && skill.invariants.length > 0 ? `Critical Invariants:\n- ${skill.invariants.join("\n- ")}` : ""}
Full Instructions:
${skill.instructions}`;
  }
}

export const skillsRuntime = new SkillsRuntime();
