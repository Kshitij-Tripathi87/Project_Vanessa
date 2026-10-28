import type { RiskLevel, Task } from "@vanessa/shared";
import { catalogAccepts, getCatalogAction } from "../agents/agentCatalog.js";

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];

function invalidPlan(reason: string): never {
  throw new Error(`The LLM did not return a valid task plan: ${reason}; no tasks were started.`);
}

function resultReferences(value: unknown, taskLabel: string): string[] {
  if (typeof value === "string") {
    if (!/^\$[a-zA-Z0-9_]+\.result(?:[.\[]|$)/.test(value)) return [];
    const reference = value.match(/^\$([a-zA-Z0-9_]+)\.result\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/);
    if (!reference) invalidPlan(`${taskLabel} has an unsupported result reference; use a whole-string $t1.result.field reference`);
    return [reference[1]];
  }
  if (Array.isArray(value)) return value.flatMap((item) => resultReferences(item, taskLabel));
  if (value && typeof value === "object") return Object.values(value).flatMap((item) => resultReferences(item, taskLabel));
  return [];
}

/** Expand the small LLM contract into the complete task shape used by the runner. */
export function normalizeModelTasks(value: unknown): Task[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    invalidPlan("tasks must contain 1 to 12 task objects");
  }
  const ids = new Set<string>();
  const tasks: Task[] = value.map((raw, index) => {
    const label = `task ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidPlan(`${label} must be an object`);
    const id = raw.id === undefined ? `t${index + 1}` : raw.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_]+$/.test(id) || ids.has(id)) {
      invalidPlan(`${label} has an invalid or duplicate id`);
    }
    ids.add(id);
    if (typeof raw.agent !== "string" || typeof raw.action !== "string") invalidPlan(`${label} requires agent and action strings`);
    const spec = getCatalogAction(raw.agent, raw.action);
    if (!spec?.selectable) invalidPlan(`${label} selects an unavailable agent/action pair (${raw.agent}/${raw.action})`);
    const params = raw.params === undefined ? {} : raw.params;
    if (!params || typeof params !== "object" || Array.isArray(params) || !catalogAccepts(raw.agent, raw.action, params)) {
      const required = Object.entries(spec.parameters).filter(([, field]) => field.required).map(([name, field]) => `${name}:${field.type}`).join(", ") || "none";
      invalidPlan(`${label} (${raw.agent}/${raw.action}) has invalid params; required parameters: ${required}; use only the catalog's parameter names and types`);
    }
    if (raw.dependsOn !== undefined && (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((id: unknown) => typeof id !== "string"))) {
      invalidPlan(`${label}.dependsOn must be an array of task ID strings when supplied`);
    }
    // Preserve compatibility with older responses without granting model-chosen tools.
    if (raw.allowedTools !== undefined && (!Array.isArray(raw.allowedTools) || raw.allowedTools.some((tool: unknown) => typeof tool !== "string" || !spec.tools.includes(tool)))) {
      invalidPlan(`${label} requested tools outside the action's catalog permissions`);
    }
    const legacyRisk = RISK_LEVELS.includes(raw.risk) ? raw.risk : "low";
    return {
      id,
      agent: raw.agent,
      action: raw.action,
      params: { ...params },
      dependsOn: [...(raw.dependsOn || [])],
      status: "pending",
      risk: RISK_LEVELS[Math.max(RISK_LEVELS.indexOf(spec.risk), RISK_LEVELS.indexOf(legacyRisk))],
      allowedTools: [...spec.tools],
      acceptanceCriteria: raw.action === "codex.open"
        ? ["The requested prompt reaches Codex in the selected project; coding completion remains unverified"]
        : [`Report the observed result of ${raw.agent}/${raw.action} using the handler's verification and documented return fields.`],
    };
  });

  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    // A result reference already expresses a dependency; do not ask the LLM to repeat it.
    task.dependsOn = [...new Set([...task.dependsOn, ...resultReferences(task.params, task.id)])];
    for (const parentId of task.dependsOn) {
      if (parentId === task.id || !byId.has(parentId)) invalidPlan(`${task.id} has a self-dependency or unknown prerequisite (${parentId})`);
      if (byId.get(parentId)!.action === "codex.open") invalidPlan(`${task.id} depends on Codex completion, but codex.open only acknowledges a terminal launch`);
    }
  }
  if (tasks.filter((task) => task.action === "codex.open").length > 1) invalidPlan("use one Codex handoff for a cohesive coding request");

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalidPlan("task dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id)!.dependsOn) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}
