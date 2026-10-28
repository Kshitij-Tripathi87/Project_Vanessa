import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentResult, AgentRunContext, AgentTask, SpecialistAgent } from "@vanessa/shared";
import { privacyGuard } from "../core/privacy.js";
import { resolvePlannerWorkspace } from "../core/contextBuilder.js";
import { buildPowerShellEnvironment } from "./powershell.js";

const execFileAsync = promisify(execFile);
type OpenMode = "explorer" | "default";

export interface FolderAgentOptions {
  platform?: NodeJS.Platform;
  openTarget?: (targetPath: string, mode: OpenMode, isDirectory: boolean) => Promise<void>;
}

export function classifyResourcePath(targetPath: string, isDirectory = false): "directory" | "code" | "web" | "text" | "data" | "document" | "image" | "unknown" {
  if (isDirectory) return "directory";
  const ext = path.extname(targetPath).toLowerCase();
  if (/\.(?:html?|xhtml)$/.test(ext)) return "web";
  if (/\.(?:py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|cs|cpp|c|h|hpp|php|rb|swift|kt|scala|sql|sh|ps1|bat|cmd|css|scss|vue|svelte)$/.test(ext)) return "code";
  if (/\.(?:json|csv|ya?ml|toml|xml)$/.test(ext)) return "data";
  if (/\.(?:txt|md|log|ini|cfg|env|rst)$/.test(ext)) return "text";
  if (/\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods)$/.test(ext)) return "document";
  if (/\.(?:png|jpe?g|webp|gif|bmp|svg|tif{1,2})$/.test(ext)) return "image";
  return "unknown";
}

export class FolderAgent implements SpecialistAgent {
  id = "folder";
  capabilities = ["path_resolution", "folder_navigation", "file_opening", "resource_classification", "project_root_detection"];
  allowedTools = ["folder_resolve", "folder_open"];

  private readonly platform: NodeJS.Platform;
  private readonly openTargetOverride?: FolderAgentOptions["openTarget"];

  constructor(options: FolderAgentOptions = {}) {
    this.platform = options.platform || process.platform;
    this.openTargetOverride = options.openTarget;
  }

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    _context?: AgentRunContext,
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};

    try {
      switch (action) {
      case "folder.resolve": {
        const resource = await this.resolveTarget(String(params.target || params.path || ""), params.basePath);
        let openedExplorer = false;
        const openExplorerRequested = params.openExplorer === true;
        const openExplorerSimulated = openExplorerRequested && process.env.FAKE === "1" && !this.openTargetOverride;
        if (openExplorerRequested && !openExplorerSimulated) {
          await this.openTarget(resource.targetPath, "explorer", resource.kind === "directory");
          openedExplorer = true;
        }
        const resolvedDetail = "Resolved " + resource.kind + " at " + resource.targetPath;
        const detail = openExplorerSimulated
          ? resolvedDetail + " Filesystem resolution succeeded, but opening Explorer was simulated and not performed."
          : resolvedDetail;
        return {
          agentId: this.id,
          status: openExplorerSimulated ? "partial" : "completed",
          success: !openExplorerSimulated,
          summary: detail,
          spokenSummary: openExplorerSimulated
            ? "I resolved the resource path, but this simulated run did not open File Explorer."
            : openedExplorer ? "Located the resource and opened it in File Explorer." : "Located the requested resource.",
          evidence: [{
            description: detail, source: resource.targetPath, timestamp: new Date().toISOString(), confidence: 1,
            data: { outcome: openExplorerSimulated ? "simulated" : "succeeded", pathResolved: true, openExplorerRequested, openedExplorer, simulated: openExplorerSimulated },
          }],
          artifacts: [resource.targetPath],
          verification: { passed: !openExplorerSimulated, details: detail },
          data: {
            outcome: openExplorerSimulated ? "simulated" : "succeeded",
            simulated: openExplorerSimulated,
            ...resource, path: resource.targetPath, fileReferences: [resource.targetPath], openedExplorer,
            verifiedFilesystemResults: { path: resource.targetPath, exists: true },
          },
        };
      }
      case "folder.open": {
        const resource = await this.resolveTarget(String(params.target || params.path || ""), params.basePath);
        const mode: OpenMode = params.mode === "explorer" ? "explorer" : "default";
        if (process.env.FAKE === "1" && !this.openTargetOverride) {
          const detail = "Simulation only: the resource was resolved, but the desktop open request was not performed.";
          return {
            agentId: this.id, status: "partial", success: false, summary: detail,
            spokenSummary: "This was a simulation. The file or folder was not opened.",
            evidence: [{ description: detail, source: resource.targetPath, timestamp: new Date().toISOString(), confidence: 1,
              data: { outcome: "simulated", simulated: true, processStarted: false, pathResolved: true, opened: false } }],
            artifacts: [],
            verification: { passed: false, details: detail },
            data: { outcome: "simulated", simulated: true, processStarted: false, path: resource.targetPath, opened: false },
          };
        }
        await this.openTarget(resource.targetPath, mode, resource.kind === "directory");
        const detail = "Operating system accepted the open request for " + resource.targetPath;
        return {
          agentId: this.id, status: "completed", success: true, summary: detail,
          spokenSummary: resource.kind === "directory" ? "Opened the folder in File Explorer." : "Opened the file with its desktop handler.",
          evidence: [{ description: detail, source: resource.targetPath, timestamp: new Date().toISOString(), confidence: 0.95 }],
          artifacts: [resource.targetPath],
          verification: { passed: true, details: "The operating system accepted the open request." },
          data: { ...resource, path: resource.targetPath, fileReferences: [resource.targetPath], opened: true },
        };
      }
      default:
        throw new Error("FolderAgent: Unknown action '" + action + "'");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        agentId: this.id, status: "failed", success: false,
        summary: "Could not resolve or open the requested resource.",
        spokenSummary: "I could not open that file or folder.",
        error: message, evidence: [], artifacts: [],
        verification: { passed: false, details: message },
        data: { requestedTarget: params.target || params.path || null },
      };
    }
  }

  private async resolveTarget(rawTarget: string, basePath?: unknown): Promise<{
    targetPath: string; projectRoot: string; kind: ReturnType<typeof classifyResourcePath>; extension: string; fileName: string;
  }> {
    const target = rawTarget.trim();
    if (!target) throw new Error("A file, folder, or project path is required.");
    const expandedTarget = target === "~" ? os.homedir() : target.startsWith("~/") || target.startsWith("~\\")
      ? path.join(os.homedir(), target.slice(2)) : target;

    if (basePath !== undefined && (typeof basePath !== "string" || !privacyGuard.isPathAllowed(basePath))) {
      throw new Error("The requested base path is outside approved folders.");
    }
    const roots = [...new Set([
      ...(typeof basePath === "string" ? [path.resolve(basePath)] : []),
      ...privacyGuard.getAllowedFolders(),
      resolvePlannerWorkspace(),
    ])].filter((root) => privacyGuard.isPathAllowed(root));

    let candidate: string | undefined;
    if (path.isAbsolute(expandedTarget)) {
      candidate = expandedTarget;
    } else {
      for (const root of roots) {
        const possible = path.resolve(root, expandedTarget);
        try { await fs.access(possible); candidate = possible; break; } catch { /* try the next approved root */ }
      }
    }

    if (!candidate && !path.isAbsolute(expandedTarget) && !/[\\/]/.test(expandedTarget)) {
      const found = await this.findByBasename(expandedTarget, roots);
      if (found.length > 1) {
        throw new Error("More than one approved resource matches '" + expandedTarget + "': " + found.slice(0, 3).join(", ") + ". Specify a full path.");
      }
      if (found.length === 1) candidate = found[0];
    }
    if (!candidate) throw new Error("Could not find '" + expandedTarget + "' in approved folders.");
    if (!privacyGuard.isPathAllowed(candidate)) throw new Error("The requested resource is outside approved folders.");

    const canonical = await fs.realpath(candidate);
    if (!privacyGuard.isPathAllowed(canonical)) throw new Error("The resolved resource escapes approved folders through a link.");
    const stat = await fs.stat(canonical);
    const kind = classifyResourcePath(canonical, stat.isDirectory());
    const projectRoot = this.findProjectRoot(canonical, stat.isDirectory(), roots);
    return { targetPath: canonical, projectRoot, kind, extension: path.extname(canonical).toLowerCase(), fileName: path.basename(canonical) };
  }

  private async findByBasename(name: string, roots: string[]): Promise<string[]> {
    const matches = new Set<string>();
    const skipped = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "AppData", "Windows"]);
    let visited = 0;
    const maxVisited = 8000;
    const maxDepth = 5;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxDepth || visited >= maxVisited || matches.size > 1) return;
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > maxVisited) return;
        const fullPath = path.join(directory, entry.name);
        if (entry.name.toLowerCase() === name.toLowerCase() && privacyGuard.isPathAllowed(fullPath)) matches.add(fullPath);
        if (matches.size > 1) return;
        if (entry.isDirectory() && !entry.isSymbolicLink() && !skipped.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(fullPath, depth + 1);
          if (matches.size > 1 || visited >= maxVisited) return;
        }
      }
    };
    for (const root of roots) {
      await walk(root, 0);
      if (matches.size > 1 || visited >= maxVisited) break;
    }
    return [...matches];
  }

  private findProjectRoot(targetPath: string, isDirectory: boolean, roots: string[]): string {
    let current = isDirectory ? targetPath : path.dirname(targetPath);
    const allowedRoots = roots.map((root) => path.resolve(root));
    while (true) {
      const markers = ["package.json", "pnpm-workspace.yaml", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"];
      if (markers.some((marker) => fsSync.existsSync(path.join(current, marker)))) return current;
      if (allowedRoots.includes(current)) return current;
      const parent = path.dirname(current);
      if (parent === current || !allowedRoots.some((root) => current === root || current.startsWith(root + path.sep))) {
        return isDirectory ? targetPath : path.dirname(targetPath);
      }
      current = parent;
    }
  }

  private async openTarget(targetPath: string, mode: OpenMode, isDirectory: boolean): Promise<void> {
    if (this.openTargetOverride) {
      await this.openTargetOverride(targetPath, mode, isDirectory);
      return;
    }
    if (this.platform === "win32") {
      if (mode === "explorer" || isDirectory) {
        const args = !isDirectory ? ["/select," + targetPath] : [targetPath];
        await execFileAsync("explorer.exe", args, { windowsHide: true, timeout: 5000 });
      } else {
        await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:VANESSA_OPEN_TARGET"], {
          windowsHide: true, timeout: 5000, env: buildPowerShellEnvironment({ VANESSA_OPEN_TARGET: targetPath }),
        });
      }
      return;
    }
    if (this.platform === "darwin") {
      await execFileAsync("open", [targetPath], { timeout: 5000 });
      return;
    }
    if (this.platform === "linux") {
      await execFileAsync("xdg-open", [targetPath], { timeout: 5000 });
      return;
    }
    throw new Error("Desktop opening is not supported on platform " + this.platform + ".");
  }
}

export const folderAgent = new FolderAgent();
