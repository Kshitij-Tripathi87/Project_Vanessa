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

/** Reviewed against registered handlers and the Trustworthy Execution v1 policy.
 * Only operations with explicit schemas and a safe runtime path are selectable.
 * Legacy aliases remain accepted only at the policy boundary and never expose
 * arbitrary shell commands through the testing/repair workflow.
 */
export const AGENT_CATALOG: CatalogAgent[] = [
  {
    id: "developer",
    purpose: "Run bounded project coding tasks through a managed Codex subprocess, and retain an explicit interactive handoff when requested.",
    limitations: "codex.run_task requires Windows, an installed Codex CLI, a clean Git repository root, and a non-detached branch. It never commits or pushes. A completed CLI turn is execution evidence only; task success remains partial until independent tests/postconditions are verified. codex.open only opens an interactive terminal.",
    actions: [
      action("codex.run_task", "Temporarily unavailable: the current Codex runner is not bound to the Trustworthy Execution v1 repair-worktree and independent-verification contract.", {
        projectPath: p("string", "Not accepted by the current release policy.", true),
        prompt: p("string", "Not accepted by the current release policy.", true),
        expectedBranch: p("string", "Not accepted by the current release policy."),
        acceptanceCriteria: p("array", "Not accepted by the current release policy."),
        allowedPaths: p("array", "Not accepted by the current release policy."),
        timeoutMs: p("number", "Not accepted by the current release policy."),
      }, "Blocked before autonomous coding begins. Use the registered checkout repair flow or an explicitly interactive user handoff; neither implies verified success.", "high", false, ["coding_run"]),
      action("codex.open", "Use only when the user explicitly wants an interactive Codex terminal handoff; terminal launch does not mean the coding task was executed or verified.", {
        projectPath: p("string", "Absolute existing project directory; use the trusted current project in runtime context unless the user selected another project.", true),
        prompt: p("string", "Concrete coding instructions, including scope, relevant files if known, and the user's constraints. Do not fabricate repository findings.", true),
      }, "{success, status: started|failed, terminalPid?, projectPath?, output?, error?}. PID identifies the terminal. Started proves launch only.", "high"),
      action("vscode.open_project", "Open an existing project in VS Code; this does not perform coding work.", {
        path: p("string", "Existing project path.", true),
      }, "{success, message? or error?}; executable path is machine-dependent."),
      action("terminal.run_command", "Unavailable: arbitrary shell execution is disabled until routed through a registered supervisor operation.", {
        command: p("string", "Not accepted by the current execution policy.", true),
      }, "Blocked before process launch.", "high", false),
      action("tests.run", "Unavailable: free-form test commands are disabled. Use the canonical registered incident-lab test suite in an approved worktree.", {
        command: p("string", "Not accepted by the current execution policy.", true),
      }, "Blocked before process launch.", "high", false),
      action("claude_code.open", "Legacy Claude workspace action. Default only returns preparation text; explicit visibleTerminal attempts terminal launch.", {
        prompt: p("string", "Initial task.", true), visibleTerminal: p("boolean", "Whether to request the legacy visible terminal path."),
      }, "{success, status: ready|started, prompt, output, verification}; not coding completion. Not selectable while Codex is the supported coding route.", "high", false),
    ],
  },
  {
    id: "windows",
    purpose: "Perform bounded Windows settings, application, and screenshot actions through PowerShell.",
    limitations: "Windows only; radio actions may need hardware/admin rights. Wi-Fi, Bluetooth, volume, and close-app handlers have success-returning failure paths, so their success flags do not independently prove the requested state. No arbitrary desktop clicking.",
    actions: [
      action("wifi.restart_adapter", "Attempt Wi-Fi adapter restart; temporarily interrupts connectivity.", {}, "AgentResult with data.adapter and data.connected; reported connectivity can be optimistic.", "high", true, ["net_adapter_control"]),
      action("wifi.status", "Read the Wi-Fi adapter's observed status.", {}, "AgentResult with data.status or an unverified/unknown status.", "low", true, ["net_adapter_control"]),
      action("brightness.list", "List active displays that expose brightness control and their observed levels.", {}, "Verified discovery snapshot with display IDs, names and supported levels.", "low", true, ["windows_setting_toggle"]),
      action("brightness.get", "Read the observed brightness of one display, selected by ID or friendly name.", {
        targetId: p("string", "Previously discovered display ID."), targetName: p("string", "Unique friendly display name when no ID is available."),
      }, "Verified read-only display observation.", "low", true, ["windows_setting_toggle"]),
      action("brightness.set", "Set display brightness and verify the requested value by read-back.", {
        brightnessPercent: p("number", "Requested integer percentage from 0 to 100.", true),
        targetId: p("string", "Previously discovered display ID."), targetName: p("string", "Unique friendly display name when no ID is available."),
      }, "Verified display observation matching the requested brightness; may require approval.", "high", true, ["windows_setting_toggle"]),
      action("bluetooth.list", "List discovered Bluetooth radios and their observed states.", {}, "Verified discovery snapshot with radio IDs, names and states.", "low", true, ["windows_setting_toggle"]),
      action("bluetooth.status", "Read the observed Bluetooth radio state.", {
        targetId: p("string", "Previously discovered Bluetooth radio ID."), targetName: p("string", "Unique friendly radio name when no ID is available."),
      }, "Verified read-only Bluetooth observation.", "low", true, ["windows_setting_toggle"]),
      action("bluetooth.set", "Set an explicit Bluetooth radio state and verify it by read-back.", {
        state: p("string", "Explicit state: On or Off.", true), targetId: p("string", "Previously discovered Bluetooth radio ID."), targetName: p("string", "Unique friendly radio name when no ID is available."),
      }, "Verified Bluetooth observation matching the requested state; may require approval.", "high", true, ["windows_setting_toggle"]),
      action("bluetooth.enable", "Enable the Bluetooth radio and verify its observed state.", {}, "Verified Bluetooth observation showing On; may require approval.", "high", true, ["windows_setting_toggle"]),
      action("bluetooth.disable", "Disable the Bluetooth radio and verify its observed state.", {}, "Verified Bluetooth observation showing Off; may require approval.", "high", true, ["windows_setting_toggle"]),
      action("volume.get", "Read the actual default playback volume and mute state.", {}, "Verified Core Audio read-back with device identity, volume percentage and mute state.", "low", true, ["audio_volume_set"]),
      action("volume.set", "Set playback volume and verify the actual output level by Core Audio read-back.", { level: p("number", "Requested percentage from 0 to 100.", true) }, "Verified Core Audio read-back matching the requested level; may require approval.", "high", true, ["audio_volume_set"]),
      action("volume.mute", "Set playback mute explicitly and verify the actual mute state.", { muted: p("boolean", "Whether playback should be muted.", true) }, "Verified Core Audio read-back matching the requested mute state; may require approval.", "high", true, ["audio_volume_set"]),
      action("app.open", "Launch an application by executable name; use browser actions for URLs.", { name: p("string", "Executable or supported name such as notepad, calculator, edge, or terminal.", true) }, "AgentResult indicating whether Windows accepted the launch request.", "low", true, ["windows_app_launch"]),
      action("app.close", "Attempt to stop an application process.", { name: p("string", "Process name to close.", true) }, "AgentResult with process operation output; fallback can overstate success.", "high", true, ["process_control"]),
      action("screenshot.capture", "Capture the primary Windows screen to a temporary PNG.", {}, "AgentResult with data.path and artifact path, or failure."),
    ],
  },
  {
    id: "browser",
    purpose: "Open URLs or search results, including YouTube searches. Delegate limited web research to the Python bridge.",
    limitations: "Playwright uses a persistent page session. Remote navigation is HTTP(S)-only; local/private hosts are denied by default, local HTML must be approved, and consequential clicks require confirmation.",
    actions: [
      action("browser.open_url", "Open a URL in the browser.", { url: p("string", "Complete http(s) URL.", true) }, "AgentResult with data.url, artifacts, and navigation claims; page contents are not returned.", "low", true, ["browser_navigate"]),
      action("browser.search", "Open Google search results for a query.", { query: p("string", "Search terms.", true) }, "AgentResult with query/search URL; not extracted search facts.", "low", true, ["browser_navigate"]),
      action("youtube.search_and_play", "Open YouTube search results. Retained action name does not imply actual playback.", { query: p("string", "Video or music search terms.", true) }, "AgentResult with data.query and data.url; do not claim playback was verified.", "low", true, ["browser_navigate"]),
      action("browser.research", "Invoke a limited Python web-search goal branch.", { goal: p("string", "Research request.", true) }, "AgentResult wrapping bridge steps/final_answer; bridge synthesis and success reports are limited and require Python dependencies.", "medium"),
      action("browser.read_title", "Read the title from a requested URL or the active browser page.", { url: p("string", "Optional reference URL.") }, "AgentResult with observed rendered page title and URL.", "low", true, ["browser_navigate"]),
      action("browser.inspect_page", "Inspect rendered page text and up to 50 links at a URL or the active page.", { url: p("string", "Optional HTTP(S) URL; omit to inspect the current page.") }, "AgentResult with observed title, URL, rendered text and links.", "low", true, ["browser_extract"]),
      action("browser.extract", "Extract readable rendered text and links from a URL or active browser page.", { url: p("string", "Optional HTTP(S) URL; omit to inspect the current page.") }, "AgentResult with bounded page text and link metadata.", "low", true, ["browser_extract"]),
      action("browser.verify_page_state", "Verify expected text against rendered page text, not page source markup.", { url: p("string", "HTTP(S) URL to inspect.", true), expectedText: p("string", "Text that must be visible in the rendered page.", true) }, "AgentResult succeeds only when navigation succeeds and expected text is found.", "low", true, ["browser_extract"]),
      action("browser.open_file", "Open an approved local HTML/XHTML file in the Playwright browser session.", { path: p("string", "Path to an existing HTML file inside an approved folder.", true) }, "AgentResult with observed title and file URL; target must be inside an approved folder.", "medium", true, ["browser_open_file"]),
      action("browser.click", "Click a page locator, optionally navigating to a URL first. Requires explicit confirmation because clicks can submit or mutate data.", { selector: p("string", "CSS or Playwright locator selector.", true), url: p("string", "Optional HTTP(S) URL; omit to use the active page.") }, "AgentResult with resulting URL/title/text or an explicit error.", "high", true, ["browser_click"]),
    ],
  },
  {
    id: "folder",
    purpose: "Resolve a mentioned file, folder or project inside approved roots, classify it, discover its project root and optionally open it in the desktop.",
    limitations: "Only approved folders are searchable. Bare-name search is bounded by depth and entry count; multiple matches require a more specific path. An OS launch acknowledgement is not proof that a person viewed a resource.",
    actions: [
      action("folder.resolve", "Resolve a path or filename within approved folders and return its canonical path, resource type, and project root. Optionally show it in Explorer.", {
        target: p("string", "Path or unambiguous file/folder name from the current request.", true),
        basePath: p("string", "Optional approved directory."),
        openExplorer: p("boolean", "Whether to open Explorer and select the resolved resource."),
      }, "AgentResult with data.targetPath, projectRoot, kind, extension, fileName and verified path provenance.", "low", true, ["folder_resolve"]),
      action("folder.open", "Resolve and open a folder in Explorer or a file with its associated desktop application.", {
        target: p("string", "Path or unambiguous file/folder name from the current request.", true),
        basePath: p("string", "Optional approved directory."),
        mode: p("string", "explorer to show/select the target, or default to use its associated application."),
      }, "AgentResult records the OS launch result; simulated/failed desktop operations are not reported as opened.", "low", true, ["folder_open"]),
    ],
  },
  {
    id: "folder",
    purpose: "Resolve a mentioned file, folder or project inside approved roots, classify it, discover its project root and optionally open it in the desktop.",
    limitations: "Only approved folders are searchable. Bare-name search is bounded by depth and entry count; multiple matches require a more specific path. An OS launch acknowledgement is not proof that a person viewed a resource.",
    actions: [
      action("folder.resolve", "Resolve a path or filename within approved folders and return its canonical path, resource type, and project root. Optionally show it in Explorer.", {
        target: p("string", "Path or unambiguous file/folder name from the current request.", true),
        basePath: p("string", "Optional approved directory."),
        openExplorer: p("boolean", "Whether to open Explorer and select the resolved resource."),
      }, "AgentResult with data.targetPath, projectRoot, kind, extension, fileName and verified path provenance.", "low", true, ["folder_resolve"]),
      action("folder.open", "Resolve and open a folder in Explorer or a file with its associated desktop application.", {
        target: p("string", "Path or unambiguous file/folder name from the current request.", true),
        basePath: p("string", "Optional approved directory."),
        mode: p("string", "explorer to show/select the target, or default to use its associated application."),
      }, "AgentResult records the OS launch result; simulated/failed desktop operations are not reported as opened.", "low", true, ["folder_open"]),
    ],
  },
  {
    id: "files",
    purpose: "Create directories, search filenames, inspect supported text/source, JSON and CSV files, rename filesystem entries, and create zip archives.",
    limitations: "Use approved folders. Search is nonrecursive. File inspection is bounded to 256 KiB and supports text/source, JSON and CSV previews; binary and office formats require dedicated parsers. Drive upload/link actions remain placeholders and are not selectable.",
    actions: [
      action("folder.create", "Create a folder within an approved base directory.", {
        name: p("string", "Folder name or absolute folder path.", true), basePath: p("string", "Approved base directory; omitted means backend's default allowed folder."),
      }, "AgentResult with data.path, fileReferences, artifact paths, and filesystem verification.", "low", true, ["folder_create"]),
      action("file.search", "List one directory and filter entry names.", {
        query: p("string", "Filename substring.", true), path: p("string", "Directory to list; service cwd if omitted."),
      }, "AgentResult with data.matches, data.bestMatch, directory and fileReferences.", "low", true, ["file_search"]),
      action("file.inspect", "Read a bounded preview of a supported text/source, JSON, or CSV file inside approved folders.", { path: p("string", "Existing file path inside approved folders.", true), maxBytes: p("number", "Optional preview size, clamped to 1 KiB–256 KiB.") }, "AgentResult with data.content, truncation state, metadata, optional JSON/CSV structure, and evidence.", "low", true, ["file_read"]),
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
    id: "coding",
    purpose: "Inspect the fixed incident-lab checkout target and prepare a narrowly scoped repair in a dedicated Git worktree.",
    limitations: "The repair target and patch contract are fixed to packages/incident-lab/src/checkout.ts. A patch is only prepared after exact preimage checks, on-disk readback, diff inspection, and base-checkout preservation checks. It does not run tests or claim the repair is complete. Dirty base checkouts are blocked; no commit, push, merge, or deployment is performed.",
    actions: [
      action("coding.inspect_changes", "Inspect source evidence for the known checkout defect without modifying files.", {
        target: p("string", "Optional allow-listed target; use packages/incident-lab/src/checkout.ts."),
      }, "AgentResult with source line/snippet evidence when present; missing or fixed source returns inconclusive.", "low", true, ["file_read"]),
      action("coding.prepare_patch", "Prepare the registered checkout null-guard patch in an isolated task worktree. Requires approval and returns workspaceId plus diffHash only when the actual patch and isolation checks pass.", {}, "AgentResult with workspaceId, worktreePath, baseCommit, diffHash and changedFiles. Regression tests have not run yet.", "high", true, ["file_read", "file_write", "apply_patch"]),
    ],
  },
  {
    id: "testing",
    purpose: "Run one registered regression suite in an approved repair worktree and return structured process/test evidence.",
    limitations: "No arbitrary command, cwd, executable, or environment input is accepted. Only incident-lab.regression is registered. The operation requires workspaceId and expectedDiffHash from a successful coding.prepare_patch result and separate approval. A non-zero exit, missing/invalid summary, zero tests, timeout, truncated output, leftover descendants, or failed base-worktree check can never produce success.",
    actions: [
      action("testing.run_incident_lab", "Run the registered incident-lab regression suite against the exact worktree and diff digest returned by coding.prepare_patch.", {
        suiteId: p("string", "Must be incident-lab.regression.", true),
        workspaceId: p("string", "Whole-string reference to the successful coding.prepare_patch workspaceId, e.g. $t2.result.workspaceId.", true),
        expectedDiffHash: p("string", "Whole-string reference to the successful coding.prepare_patch SHA-256 diffHash, e.g. $t2.result.diffHash.", true),
      }, "AgentResult with process status, exit code, structured test counts, diff digest and output digest, truncation metadata, termination proof and base-checkout preservation. Success requires exit 0 and all tests passed.", "high", true, ["test_run", "regression_check"]),
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
    purpose: "General conversational answers through the configured LLM and limited Python-bridge status/scheduling operations.",
    limitations: "An answer does not execute tools. Bridge actions need Python/OpenJarvis installed. Schedule creation stores a record but Vanessa startup does not start the scheduler loop. The goal bridge is keyword branching, not general iterative reasoning.",
    actions: [
      action("vanessa.ask", "Answer a general question or explain unavailable capabilities; never use it to pretend to execute a coding or OS action.", { query: p("string", "Question to answer.", true) }, "{success, content, mode}; a concise conversational reply from the configured LLM."),
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
  if (name === "brightness.set" && typeof params.brightnessPercent === "number" && (params.brightnessPercent < 0 || params.brightnessPercent > 100 || !Number.isInteger(params.brightnessPercent))) return false;
  if (name === "bluetooth.set" && params.state !== "On" && params.state !== "Off") return false;
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
