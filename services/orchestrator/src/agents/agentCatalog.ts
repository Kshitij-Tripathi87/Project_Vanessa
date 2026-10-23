import type { AgentName, RiskLevel } from "@vanessa/shared";

type ParameterType = "string" | "number" | "boolean" | "object" | "array";
export interface ActionParameter {
  type: ParameterType;
  description: string;
  required: boolean;
}
export interface CatalogAction {
  name: string;
  description: string;
  parameters: Record<string, ActionParameter>;
  returns: string;
  risk: RiskLevel;
  selectable: boolean;
  tools: string[];
}
export interface CatalogAgent {
  id: AgentName;
  purpose: string;
  limitations: string;
  actions: CatalogAction[];
}

const p = (type: ParameterType, description: string, required = false): ActionParameter => ({ type, description, required });
const action = (
  name: string, description: string, parameters: CatalogAction["parameters"], returns: string,
  risk: RiskLevel = "low", selectable = true, tools: string[] = [],
): CatalogAction => ({ name, description, parameters, returns, risk, selectable, tools });

/** Reviewed against the registered handlers, not the older YAML agent cards.
 * This describes existing behavior; it does not implement or repair an agent.
 * Canonical names only. Legacy aliases and the checkout coding/incident agents
 * remain in the registry for compatibility but are not planner capabilities.
 */
export const AGENT_CATALOG: CatalogAgent[] = [
  {
    id: "developer",
    purpose: "Send project coding, debugging, refactoring, implementation, and code-review requests to the existing Codex launcher. Also open an IDE or run an explicitly requested command.",
    limitations: "Codex accepts only projectPath and prompt. It launches an interactive Windows terminal; no coding completion, diff, test evidence, or agent response is returned. Its runner context argument is ignored, so selected context must be included in prompt. Never promise the code is fixed merely because a terminal opened.",
    actions: [
      action("codex.open", "Preferred action for ALL project coding work, even when the user does not say Codex. Preserve the user's task, constraints, relevant history, and completion criteria in prompt.", {
        projectPath: p("string", "Absolute existing project directory; use the trusted current project in runtime context unless the user selected another project.", true),
        prompt: p("string", "Concrete coding instructions, including scope, relevant files if known, and the user's constraints. Do not fabricate repository findings.", true),
      }, "{success, status: started|failed, terminalPid?, projectPath?, output?, error?}. PID identifies the terminal. Started proves launch only.", "high"),
      action("vscode.open_project", "Open an existing project in VS Code; this does not perform coding work.", {
        path: p("string", "Existing project path.", true),
      }, "{success, message? or error?}; executable path is machine-dependent."),
      action("terminal.run_command", "Run a concrete command explicitly requested by the user. Do not substitute this for Codex coding work or invent shell scripts.", {
        command: p("string", "Literal requested shell command; runs with the service working directory, not an arbitrary project cwd.", true),
      }, "{success, exitCode, stdout?, stderr?, error?, verification}; 30-second subprocess timeout.", "high"),
      action("tests.run", "Run an explicitly supplied test command in the service working directory, independently of any uncompleted Codex session.", {
        command: p("string", "Known test command supplied by the user or trusted project context.", true),
      }, "{success, exitCode, stdout? or error?, verification}; 20-second subprocess timeout.", "high"),
      action("claude_code.open", "Legacy Claude workspace action. Default only returns preparation text; explicit visibleTerminal attempts terminal launch.", {
        prompt: p("string", "Initial task.", true), visibleTerminal: p("boolean", "Whether to request the legacy visible terminal path."),
      }, "{success, status: ready|started, prompt, output, verification}; not coding completion. Not selectable while Codex is the supported coding route.", "high", false),
    ],
  },
  {
    id: "windows",
    purpose: "Perform bounded Windows settings, application, and screenshot actions through PowerShell.",
    limitations: "Windows only; radio actions may need hardware/admin rights. Brightness is supported only when Windows exposes WMI brightness control; simulated results must not count as verified live hardware changes. No arbitrary desktop clicking.",
    actions: [
      action("wifi.restart_adapter", "Attempt Wi-Fi adapter restart; temporarily interrupts connectivity.", {}, "AgentResult with data.adapter and data.connected; reported connectivity can be optimistic.", "high", true, ["net_adapter_control"]),
      action("wifi.status", "Read the Wi-Fi adapter's observed status.", {}, "AgentResult with data.status or an unverified/unknown status.", "low", true, ["net_adapter_control"]),
      action("bluetooth.enable", "Attempt to enable the Bluetooth radio.", {}, "AgentResult with data.state; may report requested state after failure.", "low", true, ["windows_setting_toggle"]),
      action("bluetooth.disable", "Attempt to disable the Bluetooth radio.", {}, "AgentResult with data.state; may report requested state after failure.", "low", true, ["windows_setting_toggle"]),
      action("brightness.set", "Set internal display brightness to a percentage and verify the monitor value by reading it back.", { level: p("number", "Integer percentage from 0 to 100.", true) }, "AgentResult with currentBrightness, requestedBrightness, observedBrightness and verification; unsupported displays fail explicitly.", "low", true, ["windows_setting_toggle"]),
      action("brightness.adjust", "Adjust display brightness by percentage points. When the user only says increase brightness, use +10.", { delta: p("number", "Integer adjustment from -100 to 100; use +10 for an unspecified increase.", true) }, "AgentResult with currentBrightness, requestedBrightness, observedBrightness and read-back verification.", "low", true, ["windows_setting_toggle"]),
      action("volume.set", "Attempt volume adjustment through media-key events.", { level: p("number", "Requested percentage from 0 to 100.", true) }, "AgentResult; actual output volume is not read back.", "low", true, ["audio_volume_set"]),
      action("app.open", "Launch an application by executable name; use browser actions for URLs.", { name: p("string", "Executable or supported name such as notepad, calculator, edge, or terminal.", true) }, "AgentResult indicating whether Windows accepted the launch request.", "low", true, ["windows_app_launch"]),
      action("app.close", "Attempt to stop an application process.", { name: p("string", "Process name to close.", true) }, "AgentResult with process operation output; fallback can overstate success.", "high", true, ["process_control"]),
      action("screenshot.capture", "Capture the primary Windows screen to a temporary PNG.", {}, "AgentResult with data.path and artifact path, or failure."),
    ],
  },
  {
    id: "browser",
    purpose: "Request URL navigation and search pages. The current handler can launch the browser but does not observe the active page.",
    limitations: "Navigation prefers Edge then the default URL handler; it does not verify page loading. YouTube search returns partial until the active page and results are actually observed. The legacy youtube.search_and_play action still only opens search results and must not be reported as playback. General click/fill/extract automation is not implemented despite declared tool names.",
    actions: [
      action("browser.open_url", "Open a URL in the browser.", { url: p("string", "Complete http(s) URL.", true) }, "AgentResult with data.url, artifacts, and navigation claims; page contents are not returned.", "low", true, ["browser_navigate"]),
      action("browser.search", "Open Google search results for a query.", { query: p("string", "Search terms.", true) }, "AgentResult with query/search URL; not extracted search facts.", "low", true, ["browser_navigate"]),
      action("youtube.search", "Open YouTube search results for the requested terms without implying playback.", { query: p("string", "YouTube search terms.", true) }, "Returns the requested search URL and a partial result until active page/results are actually verified.", "low", true, ["browser_navigate"]),
      action("youtube.search_and_play", "Open YouTube search results. Retained action name does not imply actual playback.", { query: p("string", "Video or music search terms.", true) }, "AgentResult with data.query and data.url; do not claim playback was verified.", "low", true, ["browser_navigate"]),
      action("browser.research", "Invoke a limited Python web-search goal branch.", { goal: p("string", "Research request.", true) }, "AgentResult wrapping bridge steps/final_answer; bridge synthesis and success reports are limited and require Python dependencies.", "medium"),
      action("browser.read_title", "Placeholder tab-title inspection.", { url: p("string", "Optional reference URL.") }, "Fixed title Browser Active Tab; no actual tab inspection.", "low", false),
    ],
  },
  {
    id: "files",
    purpose: "Create directories, search one directory, rename filesystem entries, and create zip archives.",
    limitations: "Use allowed folders. Search is a nonrecursive filename substring match. Folder creation also writes a demo note and opens Explorer. Drive upload/link actions generate synthetic IDs and do not contact Google Drive.",
    actions: [
      action("folder.create", "Create a folder within an approved base directory.", {
        name: p("string", "Folder name or absolute folder path.", true), basePath: p("string", "Approved base directory; omitted means backend's default allowed folder."),
      }, "AgentResult with data.path, fileReferences, artifact paths, and filesystem verification.", "low", true, ["folder_create"]),
      action("file.search", "List one directory and filter entry names.", {
        query: p("string", "Filename substring.", true), path: p("string", "Directory to list; service cwd if omitted."),
      }, "AgentResult with data.matches, data.bestMatch, directory and fileReferences.", "low", true, ["file_search"]),
      action("file.rename", "Rename an existing file or directory.", {
        oldPath: p("string", "Existing source path.", true), newPath: p("string", "Destination path within allowed folders.", true),
      }, "AgentResult with destination artifact and observed rename verification.", "medium", true, ["file_write"]),
      action("file.zip", "Compress directory contents into a zip in an allowed archive directory.", {
        sourceDir: p("string", "Directory to archive.", true), zipName: p("string", "Archive basename ending in .zip; backend can generate one."),
      }, "AgentResult with data.verifiedFilesystemResults.zipPath and a checked nonempty archive.", "medium"),
      action("drive.upload", "Placeholder upload; no OAuth or network upload occurs.", { file: p("string", "Filename.", true) }, "Invented data.fileId/shareLink/url; not evidence of an uploaded file.", "high", false),
      action("drive.share_link", "Placeholder Drive URL generation.", { fileId: p("string", "Drive file ID.", true) }, "Constructed URL only; no sharing permission is changed or verified.", "low", false),
    ],
  },
  {
    id: "memory",
    purpose: "Store local knowledge or preferences and retrieve limited previous incident/context records.",
    limitations: "Store writes SQLite with default 30-day retention and attempts Python storage. Retrieval may fall back to seeded INC-842 regardless of the query. Listing is a fixed demo record. Never treat seeded fallback as proven user history; no manual deletion.",
    actions: [
      action("memory.store", "Persist user-provided facts or preferences; do not store secrets.", {
        content: p("string", "Fact or preference to remember.", true), metadata: p("object", "Optional metadata such as title."),
      }, "AgentResult with data.stored/content/redactedCount; local record persisted.", "low", true, ["memory_store"]),
      action("memory.retrieve", "Attempt explicit keyword recall; inspect provenance and relevance.", { query: p("string", "Specific recall query.", true) }, "AgentResult with data.memoryRecord/historicalIncident; fallback may be unrelated sample data.", "low", true, ["memory_retrieve"]),
      action("memory.list", "Placeholder recent-memory listing.", { limit: p("number", "Requested count.") }, "Fixed INC-842 record, not actual recent records; real memory UI uses /api/memory.", "low", false),
      action("memory.delete", "Handler refuses manual deletion.", { id: p("string", "Record identifier.") }, "Failure explaining retention policy.", "low", false),
    ],
  },
  {
    id: "it_ops",
    purpose: "Inspect local checkout-style logs and obtain basic diagnostics for the orchestrator process.",
    limitations: "Log analysis is tailored to discountRate/checkout errors and includes fixed causes, severity, and duration wording. It is not general production monitoring or cluster analysis.",
    actions: [
      action("it_ops.analyze_logs", "Read a local log and count ERROR/discountRate signatures.", { target: p("string", "Log path; relative paths resolve under packages/incident-lab.", true) }, "AgentResult with observations, timeRanges, probableCauses, signatureMatches and evidence; some interpretation is fixed.", "low", true, ["log_read", "log_grep"]),
      action("it_ops.system_status", "Read Node process memory use, uptime, and platform.", {}, "AgentResult with memoryUsage, uptime and platform; not whole-machine health.", "low", true, ["system_status"]),
    ],
  },
  {
    id: "knowledge",
    purpose: "Read local documentation or retrieve the existing checkout runbook example.",
    limitations: "Runbook retrieval always targets checkout-payment-failure.md and returns hardcoded passages. There is no general document search/index or independent runbook reasoning.",
    actions: [
      action("knowledge.read_doc", "Read a known local documentation file.", { path: p("string", "Known documentation path; relative to service cwd.", true) }, "AgentResult with data.content; missing file can return an empty string.", "low", true, ["runbook_read"]),
      action("knowledge.retrieve_runbook", "Retrieve the checkout-payment-failure runbook example only.", { runbook: p("string", "Use checkout-payment-failure, not an invented runbook.", true) }, "AgentResult with runbookTitle/relevantPassages/applicableProcedures; passages and diagnosis are fixed.", "low", true, ["runbook_read"]),
    ],
  },
  {
    id: "testing",
    purpose: "Execute a known regression command and return captured test output independently of coding-agent completion.",
    limitations: "Runs in service cwd with a 25-second timeout. Success also depends on pass wording in stdout. A branch field is metadata; it does not switch branches. Do not schedule this after codex.open as if coding work had finished.",
    actions: [
      action("testing.verify_regression", "Execute a known test command and report captured outcome.", {
        command: p("string", "Test command supplied by the user or trusted context.", true),
        branch: p("string", "Optional reporting label; no branch checkout occurs."),
        autoDeploy: p("boolean", "Must be false; this action does not deploy."),
      }, "AgentResult with data.exitStatus/testsPassed/testOutput/deploymentStatus plus verification and evidence.", "high", true, ["test_run", "regression_check"]),
      action("testing.run_checks", "Alias operation for the same regression subprocess.", { command: p("string", "Known check command.", true), autoDeploy: p("boolean", "Must be false.") }, "Same test result contract as testing.verify_regression.", "high", true, ["test_run"]),
    ],
  },
  {
    id: "cloud",
    purpose: "Open prefilled Gmail draft and WhatsApp share pages. Actual sending and Drive upload are unfinished.",
    limitations: "Opening a compose/share page does not send. Some browser-launch errors are swallowed. Never claim a message was transmitted.",
    actions: [
      action("gmail.draft", "Open a Gmail compose URL with supplied fields.", {
        to: p("string", "User-specified recipient.", true), subject: p("string", "Email subject.", true), body: p("string", "Draft body.", true),
      }, "{success, action: drafted, recipient, subject, composeUrl, status}; page-launch result only.", "medium"),
      action("whatsapp.send_link", "Open a prefilled WhatsApp sharing URL, leaving sending to the user.", {
        text: p("string", "Text/link to share.", true), phone: p("string", "Optional user-provided recipient number."),
      }, "{success, url, status}; sharing prompt only.", "medium"),
      action("gmail.send", "Placeholder send that performs no mail API call.", { to: p("string", "Recipient.", true), subject: p("string", "Subject.", true) }, "Synthetic success response; no email sent.", "high", false),
      action("drive.upload", "Delegates to the file agent's placeholder upload.", { file: p("string", "Filename.", true) }, "Synthetic Drive link only.", "high", false),
    ],
  },
  {
    id: "vanessa",
    purpose: "General conversational answers through Gemini and limited Python-bridge status/scheduling operations.",
    limitations: "An answer does not execute tools. Bridge actions need Python/OpenJarvis installed. Schedule creation stores a record but Vanessa startup does not start the scheduler loop. The goal bridge is keyword branching, not general iterative reasoning.",
    actions: [
      action("vanessa.ask", "Answer a general question or explain unavailable capabilities; never use it to pretend to execute a coding or OS action.", { query: p("string", "Question to answer.", true) }, "{success, content, mode}; a concise conversational reply from Gemini."),
      action("vanessa.status", "Query Python bridge tool/scheduler metadata.", {}, "Bridge {success, brain, tools, scheduler} or failure; metadata does not prove every integration works."),
      action("vanessa.schedule_create", "Register an explicitly specified schedule; do not promise execution without a running scheduler.", {
        prompt: p("string", "Task to register.", true), type: p("string", "Scheduler type supported by the bridge, such as cron.", true),
        value: p("string", "Explicit schedule expression; do not invent a time or timezone.", true), tools: p("string", "Comma-separated tool names if provided by trusted configuration."),
      }, "Bridge {success, task_id, prompt, schedule, next_run, tools} or error; schedule registration only.", "high"),
      action("vanessa.schedule_list", "List registered schedules through the Python bridge.", {}, "Bridge {success, count, tasks} or error."),
      action("vanessa.run_tool", "Generic Python tool dispatch; arbitrary tool names are not audited in this catalog.", { tool: p("string", "Tool name.", true), params: p("object", "Tool arguments.") }, "Bridge tool output; excluded from automatic selection until tools have explicit contracts.", "high", false),
      action("vanessa.shell", "Generic shell bridge.", { command: p("string", "Shell command.", true) }, "Bridge output; use explicit developer command contract instead.", "high", false),
      action("vanessa.git", "Generic Python git-tool bridge.", { tool: p("string", "Git tool name.", true) }, "Bridge output; project coding/version-control work belongs in codex.open.", "medium", false),
      action("vanessa.browser", "Generic Python browser bridge.", { url: p("string", "URL.", true) }, "Bridge output; use explicit browser action instead.", "low", false),
      action("vanessa.run_goal", "Limited keyword-based Python goal branch.", { goal: p("string", "Goal.", true), tools: p("array", "Tool list."), maxSteps: p("number", "Accepted but not used as an actual reasoning loop.") }, "Generic final_answer/steps, often success regardless of inner tool failures; not selectable.", "high", false),
    ],
  },
];

export function getCatalogAction(agent: string, name: string): CatalogAction | undefined {
  return AGENT_CATALOG.find((entry) => entry.id === agent)?.actions.find((entry) => entry.name === name);
}

export function catalogAccepts(agent: string, name: string, params: Record<string, unknown>): boolean {
  const spec = getCatalogAction(agent, name);
  if (!spec?.selectable) return false;
  if (Object.keys(params).some((key) => !Object.hasOwn(spec.parameters, key))) return false;
  for (const [key, field] of Object.entries(spec.parameters)) {
    const value = params[key];
    if (value === undefined) { if (field.required) return false; else continue; }
    // Runner-supported dependency references are resolved after parent success.
    if (typeof value === "string" && /^\$[a-zA-Z0-9_]+\.result\.[a-zA-Z0-9_.]+$/.test(value)) continue;
    if (field.type === "array" ? !Array.isArray(value)
      : field.type === "object" ? !value || typeof value !== "object" || Array.isArray(value)
      : typeof value !== field.type) return false;
    if (field.type === "string" && field.required && !(value as string).trim()) return false;
    if (field.type === "number" && !Number.isFinite(value)) return false;
  }
  if (name === "volume.set" && typeof params.level === "number" && (params.level < 0 || params.level > 100)) return false;
  if (params.autoDeploy === true) return false;
  if (name === "codex.open" && String(params.prompt).includes("\0")) return false;
  return true;
}

export function renderAgentCatalog(): string {
  return AGENT_CATALOG.map((agent) => [
    `AGENT ${agent.id}: ${agent.purpose}`,
    `Limits: ${agent.limitations}`,
    ...agent.actions.map((a) => [
      `Action ${a.name} [${a.selectable ? "selectable" : "UNAVAILABLE - do not plan"}; minimum risk ${a.risk}]: ${a.description}`,
      `Parameters: ${Object.entries(a.parameters).map(([name, p]) => `${name} (${p.type}, ${p.required ? "required" : "optional"}): ${p.description}`).join("; ") || "none; use {}"}`,
      `Returns: ${a.returns}`,
    ].join("\n")),
  ].join("\n")).join("\n\n");
}
