export type SideEffectClass = "read_only" | "isolated_write" | "machine_state" | "external_side_effect";

export interface ManagedActionPolicy {
  canonicalId: string;
  aliases: string[];
  approvalRequired: boolean;
  sideEffectClass: SideEffectClass;
  blocked?: boolean;
  validate: (params: Record<string, any>) => string | undefined;
}

export interface ManagedActionResolution {
  managed: boolean;
  canonicalId?: string;
  approvalRequired?: boolean;
  sideEffectClass?: SideEffectClass;
  blocked?: boolean;
  reason?: string;
}

function onlyKeys(params: Record<string, any>, allowed: string[]): string | undefined {
  const unknown = Object.keys(params || {}).filter((key) => !allowed.includes(key));
  return unknown.length ? `Unsupported parameter(s): ${unknown.join(", ")}.` : undefined;
}

const noParams = (params: Record<string, any>) => onlyKeys(params, []);
const taskIdOnly = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["taskId"]);
  if (unknown) return unknown;
  if (params.taskId !== undefined && (typeof params.taskId !== "string" || !params.taskId.trim())) return "taskId must be a non-empty string.";
  return undefined;
};
const validateTestRun = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["suiteId", "workspaceId", "expectedDiffHash"]);
  if (unknown) return unknown;
  if (params.suiteId !== "incident-lab.regression") return "suiteId must be the registered incident-lab.regression suite.";
  if (typeof params.workspaceId !== "string" || !params.workspaceId.trim() || /[\\/]/.test(params.workspaceId)) {
    return "workspaceId must identify a registered workspace; arbitrary paths are not accepted.";
  }
  if (typeof params.expectedDiffHash !== "string" || !/^[a-f0-9]{64}$/i.test(params.expectedDiffHash)) {
    return "expectedDiffHash must be a SHA-256 hex digest.";
  }
  return undefined;
};
const validateInspection = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["target", "taskId"]);
  if (unknown) return unknown;
  if (params.target !== undefined && !["src/checkout.ts", "packages/incident-lab/src/checkout.ts"].includes(String(params.target).replace(/\\/g, "/"))) {
    return "target is not in the diagnostic allow-list.";
  }
  return undefined;
};
const validateDiagnosis = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["repo", "logs", "memory"]);
  if (unknown) return unknown;
  for (const key of ["repo", "logs", "memory"]) {
    if (params[key] !== undefined && (params[key] === null || typeof params[key] !== "object")) {
      return `${key} must be an evidence object.`;
    }
  }
  return undefined;
};
const validateDiff = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["target"]);
  if (unknown) return unknown;
  if (!["packages/incident-lab/src/checkout.ts", "src/checkout.ts"].includes(String(params.target || ""))) {
    return "Diff target is not in the allow-list.";
  }
  return undefined;
};

const validateAsk = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["query", "prompt"]);
  if (unknown) return unknown;
  const query = params.query ?? params.prompt;
  if (typeof query !== "string" || !query.trim()) return "A non-empty query or prompt is required.";
  if (query.length > 4000) return "Query/prompt must be 4,000 characters or fewer.";
  return undefined;
};

const validateMemoryQuery = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["query", "keyword"]);
  if (unknown) return unknown;
  const query = params.query ?? params.keyword;
  if (typeof query !== "string" || !query.trim() || query.length > 1000) return "Memory query must be a non-empty string of 1,000 characters or fewer.";
  return undefined;
};
const validateMemoryStore = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["content", "text", "metadata"]);
  if (unknown) return unknown;
  const content = params.content ?? params.text;
  if (typeof content !== "string" || !content.trim()) return "Memory content must be a non-empty string.";
  if (content.length > 20000) return "Memory content must be 20,000 characters or fewer.";
  if (params.metadata !== undefined && (!params.metadata || typeof params.metadata !== "object" || Array.isArray(params.metadata))) {
    return "Memory metadata must be an object when supplied.";
  }
  return undefined;
};
const validateMemoryList = (params: Record<string, any>) => {
  const unknown = onlyKeys(params, ["limit"]);
  if (unknown) return unknown;
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50)) {
    return "Memory list limit must be an integer from 1 to 50.";
  }
  return undefined;
};

const policyList: ManagedActionPolicy[] = [
  {
    canonicalId: "openjarvis.ask",
    aliases: ["vanessa.ask", "tools.ask", "connector.ask", "jarvis.ask"],
    approvalRequired: false,
    sideEffectClass: "read_only",
    validate: validateAsk,
  },
  { canonicalId: "memory.retrieve", aliases: ["memory.search"], approvalRequired: false, sideEffectClass: "read_only", validate: validateMemoryQuery },
  { canonicalId: "memory.store", aliases: ["memory.save"], approvalRequired: false, sideEffectClass: "isolated_write", validate: validateMemoryStore },
  { canonicalId: "memory.list", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: validateMemoryList },
  { canonicalId: "memory.delete", aliases: [], approvalRequired: true, sideEffectClass: "isolated_write", blocked: true, validate: noParams },
  { canonicalId: "testing.run_incident_lab", aliases: ["testing.run_checks", "testing.verify_regression"], approvalRequired: true, sideEffectClass: "read_only", validate: validateTestRun },
  { canonicalId: "coding.inspect_changes", aliases: ["coding.analyze_repo"], approvalRequired: false, sideEffectClass: "read_only", validate: validateInspection },
  { canonicalId: "coding.prepare_patch", aliases: [], approvalRequired: true, sideEffectClass: "isolated_write", validate: taskIdOnly },
  { canonicalId: "coding.git_status", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: noParams },
  { canonicalId: "coding.git_diff", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: validateDiff },
  { canonicalId: "incident.analyze_repo", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: noParams },
  { canonicalId: "incident.analyze_logs", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: noParams },
  { canonicalId: "incident.retrieve_memory", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: noParams },
  { canonicalId: "incident.diagnose", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: validateDiagnosis },
  { canonicalId: "incident.investigate", aliases: [], approvalRequired: false, sideEffectClass: "read_only", validate: taskIdOnly },
  { canonicalId: "incident.prepare_and_verify", aliases: [], approvalRequired: true, sideEffectClass: "isolated_write", blocked: true, validate: taskIdOnly },
  { canonicalId: "terminal.run_command", aliases: [], approvalRequired: true, sideEffectClass: "machine_state", blocked: true, validate: () => "Arbitrary shell execution is disabled until routed through a registered executor." },
  { canonicalId: "tests.run", aliases: [], approvalRequired: true, sideEffectClass: "machine_state", blocked: true, validate: () => "Generic test commands are disabled; use a registered test suite in an isolated workspace." },
  { canonicalId: "claude_code.open", aliases: [], approvalRequired: true, sideEffectClass: "machine_state", blocked: true, validate: () => "Prompt-bearing dynamic PowerShell launch is disabled until a fixed, data-only launcher is implemented." },
];

const byId = new Map<string, ManagedActionPolicy>();
for (const policy of policyList) {
  byId.set(policy.canonicalId, policy);
  for (const alias of policy.aliases) byId.set(alias, policy);
}

// Unmigrated agent namespaces fail closed. Only actions explicitly registered above
// are callable; legacy tool/shell/scheduling routes remain unavailable until they
// are moved behind the same policy and managed execution contracts.
const failClosedPrefixes = [
  "testing.",
  "incident.",
  "coding.",
  "memory.",
  "openjarvis.",
  "vanessa.",
  "tools.",
  "connector.",
  "jarvis.",
];
const explicitlyBlockedActions = new Set(["terminal.run_command", "tests.run", "claude_code.open", "developer.claude_code.open_autonomous", "incident.prepare_and_verify", "codex.run_task"]);

/**
 * Canonical policy registry for the incident/repair/testing execution surface.
 * Other Vanessa capabilities retain their existing policy path while their
 * executable inventory is migrated; unknown IDs in these namespaces are denied.
 */
export function resolveManagedAction(actionId: string, params: Record<string, any> = {}): ManagedActionResolution {
  if (explicitlyBlockedActions.has(actionId)) {
    return { managed: true, canonicalId: actionId, approvalRequired: true, sideEffectClass: "machine_state", blocked: true,
      reason: "This execution route is temporarily disabled by Trustworthy Execution v1 containment." };
  }
  const policy = byId.get(actionId);
  if (!policy) {
    if (failClosedPrefixes.some((prefix) => actionId.startsWith(prefix))) {
      return { managed: true, blocked: true, reason: `Unregistered managed action '${actionId}' is blocked.` };
    }
    return { managed: false };
  }
  const validationError = policy.validate(params || {});
  if (validationError) {
    return { managed: true, canonicalId: policy.canonicalId, approvalRequired: policy.approvalRequired,
      sideEffectClass: policy.sideEffectClass, blocked: true, reason: validationError };
  }
  if (policy.blocked) {
    return { managed: true, canonicalId: policy.canonicalId, approvalRequired: policy.approvalRequired,
      sideEffectClass: policy.sideEffectClass, blocked: true, reason: "This action is disabled by execution policy." };
  }
  return { managed: true, canonicalId: policy.canonicalId, approvalRequired: policy.approvalRequired,
    sideEffectClass: policy.sideEffectClass };
}

export function listManagedActionIds(): string[] {
  return policyList.map((policy) => policy.canonicalId);
}
