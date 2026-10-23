import type { Plan, Task } from "@vanessa/shared";
import * as fs from "node:fs";
import * as path from "node:path";

/** Resolve application workspace independently of pnpm's package working directory. */
export function resolvePlannerWorkspace(): string {
  let candidate = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) return fs.realpathSync(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) return process.cwd();
    candidate = parent;
  }
}

export type ContextInput = {
  command: string;
  source: "voice" | "desktop" | "phone";
  recentTasks: Task[];
  memories: string[];
  activePlan?: Plan;
};

const MAX_RECENT_TASKS = 3;
const MAX_MEMORIES = 5;
const MAX_MEMORY_CHARS = 120;

export function buildPlannerContext(input: ContextInput) {
  const recentTasks = (input.recentTasks || [])
    .slice(-MAX_RECENT_TASKS)
    .map((task) => ({
      id: task.id,
      agent: task.agent,
      action: task.action,
      status: task.status,
    }));

  const memories = (input.memories || [])
    .slice(0, MAX_MEMORIES)
    .map((memory) =>
      typeof memory === "string"
        ? memory.slice(0, MAX_MEMORY_CHARS)
        : JSON.stringify(memory).slice(0, MAX_MEMORY_CHARS)
    );

  return {
    command: input.command,
    source: input.source,
    recentTasks,
    memories,
    activePlanId: input.activePlan?.id ?? null,
    activeTasks:
      input.activePlan?.tasks
        .filter((task) => task.status === "running")
        .map((task) => task.id) ?? [],
  };
}
