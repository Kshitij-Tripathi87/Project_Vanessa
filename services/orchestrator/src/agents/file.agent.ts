import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { runPowerShell } from "./powershell.js";
import { privacyGuard } from "../core/privacy.js";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";

function requiredPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(label + " must be a non-empty path string.");
  }
  return path.resolve(value);
}

async function resolveApprovedDirectory(value: unknown, label: string): Promise<string> {
  const requested = requiredPath(value, label);
  const canonical = await fs.realpath(requested);
  if (!privacyGuard.isPathAllowed(canonical)) {
    throw new Error(label + " is outside approved filesystem roots.");
  }
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error(label + " must identify an existing directory.");
  return canonical;
}

async function resolveApprovedNewPath(value: unknown, label: string): Promise<string> {
  const requested = requiredPath(value, label);
  const leaf = path.basename(requested);
  if (!leaf || leaf === "." || leaf === "..") throw new Error(label + " must include a valid final path component.");
  const parent = await fs.realpath(path.dirname(requested));
  if (!privacyGuard.isPathAllowed(parent)) {
    throw new Error(label + " parent is outside approved filesystem roots.");
  }
  const canonicalTarget = path.join(parent, leaf);
  if (!privacyGuard.isPathAllowed(canonicalTarget)) {
    throw new Error(label + " is outside approved filesystem roots.");
  }
  try {
    await fs.lstat(canonicalTarget);
    throw new Error(label + " already exists; overwrite is not permitted.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return canonicalTarget;
}

async function observedEntry(targetPath: string): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean }> {
  try {
    const stat = await fs.stat(targetPath);
    return { exists: true, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, isFile: false, isDirectory: false };
    }
    throw error;
  }
}

export class FileAgent implements SpecialistAgent {
  id = "files";
  capabilities = [
    "file_search",
    "file_inspection",
    "folder_creation",
    "file_manipulation",
    "archive_creation",
  ];
  allowedTools = [
    "folder_create",
    "file_search",
    "file_read",
    "file_write",
  ];

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    _context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const startTime = new Date().toISOString();

    switch (action) {
      case "folder.create": {
        const folderName = typeof params.name === "string" ? params.name : params.path;
        if (typeof folderName !== "string" || !folderName.trim()) {
          throw new Error("folder.create requires a non-empty folder name or path.");
        }
        const basePath = typeof params.basePath === "string" && params.basePath.trim()
          ? await resolveApprovedDirectory(params.basePath, "basePath")
          : await resolveApprovedDirectory(privacyGuard.getAllowedFolders()[0] || path.join(os.homedir(), "Documents", "VanessaDemo"), "default folder root");
        const targetPath = path.isAbsolute(folderName)
          ? path.resolve(folderName)
          : path.resolve(basePath, folderName);

        // Check the canonical/physical path before creating anything. The guard
        // resolves existing ancestors, so nonexistent child directories are still
        // checked against approved roots.
        if (!privacyGuard.isPathAllowed(targetPath)) {
          throw new Error("The requested folder is outside approved filesystem roots.");
        }

        if (process.env.FAKE === "1") {
          const detail = "Simulation only: folder creation at " + targetPath + " was not executed because FAKE=1.";
          return {
            agentId: this.id,
            status: "partial",
            success: false,
            summary: detail,
            spokenSummary: "This was a simulation. No folder was created.",
            evidence: [{
              description: detail,
              source: "file-agent.fake-mode",
              timestamp: startTime,
              confidence: 1,
              data: { outcome: "simulated", simulated: true, actualStateChanged: false, actualStateVerified: false },
            }],
            artifacts: [],
            verification: { passed: false, details: detail },
            data: { outcome: "simulated", simulated: true, actualStateChanged: false, actualStateVerified: false, proposedTarget: targetPath },
          };
        }

        await fs.mkdir(targetPath, { recursive: true });
        const canonicalTarget = await fs.realpath(targetPath);
        if (!privacyGuard.isPathAllowed(canonicalTarget)) {
          throw new Error("The created folder resolved outside approved filesystem roots; refusing to report success.");
        }
        const observed = await fs.stat(canonicalTarget);
        if (!observed.isDirectory()) throw new Error("The requested path exists but is not a directory.");

        const detail = "Created and verified directory at " + canonicalTarget + ".";
        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: detail,
          spokenSummary: "Created folder " + path.basename(canonicalTarget) + ".",
          evidence: [{
            description: detail,
            source: canonicalTarget,
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { exists: true, isDirectory: true },
          }],
          artifacts: [canonicalTarget],
          verification: { passed: true, details: "The canonical directory exists and remains inside an approved root." },
          data: {
            fileReferences: [canonicalTarget],
            proposedChanges: ["Created directory " + canonicalTarget],
            verifiedFilesystemResults: { path: canonicalTarget, exists: true, isDirectory: true },
            path: canonicalTarget,
          },
        };
      }

      case "file.search": {
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (typeof params.query !== "string") throw new Error("file.search requires a string query.");
        const requestedDirectory = typeof params.path === "string" && params.path.trim()
          ? params.path
          : privacyGuard.getAllowedFolders()[0];
        const targetDir = await resolveApprovedDirectory(requestedDirectory, "search directory");
        try {
          const entries = await fs.readdir(targetDir, { withFileTypes: true });
          const matchingEntries = entries.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()));
          const matches = matchingEntries.map((entry) => entry.name);
          const matchPaths = matchingEntries.map((entry) => path.join(targetDir, entry.name));
          const detail = "Listed " + entries.length + " entr(y/ies) in approved directory " + targetDir +
            "; " + matches.length + " matched the requested name filter.";
          return {
            agentId: this.id,
            status: "completed",
            success: true,
            summary: detail,
            spokenSummary: "Found " + matches.length + " matching entries.",
            evidence: [{
              description: detail,
              source: targetDir,
              timestamp: new Date().toISOString(),
              confidence: 1,
              data: { entryCount: entries.length, matchCount: matches.length },
            }],
            artifacts: matchPaths,
            data: {
              fileReferences: matchPaths,
              matches,
              bestMatch: matches[0] ? { id: matchPaths[0], name: matches[0] } : undefined,
              directory: targetDir,
              verifiedFilesystemResults: { totalEntries: entries.length, totalMatches: matches.length },
            },
            verification: {
              passed: true,
              details: detail,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            agentId: this.id,
            status: "failed",
            success: false,
            error: message,
            summary: "The approved directory could not be searched.",
            spokenSummary: "I could not search that folder.",
            evidence: [],
            artifacts: [],
            data: { query, directory: targetDir, matches: [] },
            verification: { passed: false, details: message },
          };
        }
      }

      case "file.inspect": {
        const requestedPath = params.path;
        if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("file.inspect requires a path.");
        const canonicalPath = await fs.realpath(path.resolve(requestedPath));
        if (!privacyGuard.isPathAllowed(canonicalPath)) throw new Error("The requested file is outside approved folders.");
        const stat = await fs.stat(canonicalPath);
        if (!stat.isFile()) throw new Error("file.inspect accepts a file, not a directory.");
        const extension = path.extname(canonicalPath).toLowerCase();
        const readable = new Set([".txt", ".md", ".rst", ".log", ".json", ".csv", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg", ".env", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".swift", ".kt", ".scala", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".html", ".htm", ".xhtml", ".css", ".scss", ".vue", ".svelte"]);
        if (!readable.has(extension)) {
          return {
            agentId: this.id, status: "failed", success: false,
            summary: "The file was found, but its content format is not supported by the text inspector.",
            spokenSummary: "I found the file, but I cannot analyze this file format yet.",
            error: "Unsupported content format: " + (extension || "(no extension)") + ". A format-specific parser is not configured.",
            evidence: [{ description: "File metadata inspected without reading content", source: canonicalPath, timestamp: startTime, confidence: 1 }],
            artifacts: [canonicalPath],
            data: { path: canonicalPath, fileName: path.basename(canonicalPath), extension, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), contentRead: false },
            verification: { passed: false, details: "Content was not read because no safe parser is configured for this format." },
          };
        }

        const requestedLimit = Number(params.maxBytes);
        const maxBytes = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(262144, Math.max(1024, Math.floor(requestedLimit))) : 65536;
        const handle = await fs.open(canonicalPath, "r");
        let rawContent: Buffer;
        let bytesRead = 0;
        try {
          const buffer = Buffer.alloc(maxBytes + 1);
          const readResult = await handle.read(buffer, 0, maxBytes + 1, 0);
          bytesRead = readResult.bytesRead;
          rawContent = buffer.subarray(0, Math.min(bytesRead, maxBytes));
        } finally {
          await handle.close();
        }
        if (rawContent.includes(0)) throw new Error("The target appears to be a binary file and cannot be safely decoded as text.");

        const content = rawContent.toString("utf8");
        const truncated = stat.size > maxBytes || bytesRead > maxBytes;
        let structure: Record<string, unknown> = {};
        if (extension === ".json") {
          try {
            const parsed = JSON.parse(content);
            structure = Array.isArray(parsed)
              ? { jsonType: "array", itemCount: parsed.length }
              : parsed && typeof parsed === "object"
                ? { jsonType: "object", topLevelKeys: Object.keys(parsed as Record<string, unknown>).slice(0, 100) }
                : { jsonType: typeof parsed };
          } catch {
            structure = { jsonParseable: false, note: "Preview may be truncated or invalid JSON." };
          }
        } else if (extension === ".csv") {
          const rows = content.split(/\r?\n/).filter((line) => line.length > 0);
          structure = { columnCount: rows[0] ? rows[0].split(",").length : 0, header: rows[0] ? rows[0].split(",").slice(0, 100) : [], dataRowsInPreview: Math.max(0, rows.length - 1), previewRows: rows.slice(0, 21) };
        }

        const detail = "Read " + Math.min(stat.size, maxBytes) + " byte(s) from " + canonicalPath + (truncated ? " (preview truncated)." : ".");
        return {
          agentId: this.id, status: "completed", success: true, summary: detail,
          spokenSummary: "I inspected the file and prepared a bounded content preview.",
          evidence: [{ description: detail, source: canonicalPath, timestamp: startTime, confidence: 1, data: { bytes: stat.size, truncated } }],
          artifacts: [canonicalPath],
          verification: { passed: true, details: "The file exists, is approved, and its content preview was read within the configured size limit." },
          data: { path: canonicalPath, fileName: path.basename(canonicalPath), extension, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), content, truncated, maxBytes, structure, contentRead: true },
        };
      }

      case "file.rename": {
        const oldPath = requiredPath(params.oldPath, "oldPath");
        const requestedNewPath = requiredPath(params.newPath, "newPath");
        const sourceLstat = await fs.lstat(oldPath);
        if (sourceLstat.isSymbolicLink()) {
          throw new Error("file.rename does not operate on symbolic links or reparse-point entries.");
        }
        if (!sourceLstat.isFile()) {
          throw new Error("file.rename currently supports regular files only; directory moves are disabled.");
        }
        const canonicalSource = await fs.realpath(oldPath);
        if (!privacyGuard.isPathAllowed(canonicalSource)) {
          throw new Error("The rename source is outside approved filesystem roots.");
        }

        const destinationParent = await fs.realpath(path.dirname(requestedNewPath));
        if (!privacyGuard.isPathAllowed(destinationParent)) {
          throw new Error("The rename destination parent is outside approved filesystem roots.");
        }
        const destinationPath = path.join(destinationParent, path.basename(requestedNewPath));
        if (!privacyGuard.isPathAllowed(destinationPath)) {
          throw new Error("The rename destination is outside approved filesystem roots.");
        }
        if (path.resolve(canonicalSource) === path.resolve(destinationPath)) {
          throw new Error("The rename source and destination are identical.");
        }
        const destinationState = await observedEntry(destinationPath);
        if (destinationState.exists) {
          throw new Error("The rename destination already exists; overwriting is not permitted.");
        }

        const sourceStat = await fs.stat(canonicalSource);
        const parentStat = await fs.stat(destinationParent);
        if (sourceStat.dev !== parentStat.dev) {
          throw new Error("Cross-volume rename is not supported; the source was left unchanged.");
        }

        // A hard link provides exclusive destination creation (EEXIST on a
        // collision) without replacing an existing destination on POSIX. Remove
        // the source only after the destination is confirmed to reference the
        // same file content and still lies inside the approved root.
        await fs.link(canonicalSource, destinationPath);
        try {
          const destinationStat = await fs.stat(destinationPath);
          if (!destinationStat.isFile() || destinationStat.size !== sourceStat.size) {
            throw new Error("The destination failed post-link verification; the original source was retained.");
          }
          const destinationCanonical = await fs.realpath(destinationPath);
          if (!privacyGuard.isPathAllowed(destinationCanonical)) {
            throw new Error("The destination resolved outside approved filesystem roots; the original source was retained.");
          }
          const currentSourceStat = await fs.stat(canonicalSource);
          if (currentSourceStat.dev !== sourceStat.dev || currentSourceStat.ino !== sourceStat.ino ||
              currentSourceStat.size !== sourceStat.size || currentSourceStat.mtimeMs !== sourceStat.mtimeMs) {
            throw new Error("The source changed during rename; both paths were retained for manual reconciliation.");
          }
          await fs.unlink(canonicalSource);
          const sourceAfter = await observedEntry(canonicalSource);
          const destinationAfter = await observedEntry(destinationCanonical);
          if (sourceAfter.exists || !destinationAfter.isFile) {
            throw new Error("Rename completion could not be verified; inspect both paths before retrying.");
          }
        } catch (error) {
          // Do not silently remove the linked destination on failure. Both paths
          // are retained if source reconciliation was not proven.
          throw error;
        }

        const detail = "Renamed approved file to " + destinationPath + ".";
        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: detail,
          spokenSummary: "File renamed and verified.",
          evidence: [{
            description: detail,
            source: destinationPath,
            timestamp: new Date().toISOString(),
            confidence: 1,
            data: { source: canonicalSource, destination: destinationPath, sourceRemoved: true },
          }],
          artifacts: [destinationPath],
          data: {
            fileReferences: [canonicalSource, destinationPath],
            proposedChanges: ["Rename " + canonicalSource + " to " + destinationPath],
            verifiedFilesystemResults: { oldPath: canonicalSource, newPath: destinationPath, success: true, sourceRemoved: true },
          },
          verification: {
            passed: true,
            details: "Destination exists as a regular file and the original source path is absent.",
          },
        };
      }

      case "file.zip":
      case "project.zip": {
        const sourceDir = await resolveApprovedDirectory(params.sourceDir, "archive source directory");
        const destinationDir = await resolveApprovedDirectory(
          typeof params.destinationDir === "string" && params.destinationDir.trim()
            ? params.destinationDir
            : privacyGuard.getAllowedFolders()[0],
          "archive destination directory",
        );
        const requestedZipName = typeof params.zipName === "string" && params.zipName.trim()
          ? params.zipName.trim()
          : "project_" + randomUUID() + ".zip";
        if (path.basename(requestedZipName) !== requestedZipName || /[<>:"/\\|?*\u0000-\u001f]/.test(requestedZipName)) {
          throw new Error("zipName must be a filename, not a path, and may not contain reserved characters.");
        }
        const zipName = requestedZipName.toLowerCase().endsWith(".zip") ? requestedZipName : requestedZipName + ".zip";
        const destZip = await resolveApprovedNewPath(path.join(destinationDir, zipName), "archive destination");
        const tempZip = path.join(destinationDir, "." + randomUUID() + ".vanessa-tmp.zip");
        try {
          await runPowerShell(
            "$sourceItems = Get-ChildItem -LiteralPath $env:VANESSA_SOURCE -Force | Select-Object -ExpandProperty FullName; " +
              "if (-not $sourceItems) { throw 'The source directory is empty.' }; " +
              "Compress-Archive -Path $sourceItems -DestinationPath $env:VANESSA_DESTINATION",
            { VANESSA_SOURCE: sourceDir, VANESSA_DESTINATION: tempZip },
            30000,
          );
          const tempStats = await fs.stat(tempZip);
          if (!tempStats.isFile() || tempStats.size === 0) {
            throw new Error("Archive output was missing or empty after compression.");
          }
          // Hard-link publication is exclusive: it fails if another process
          // creates the final archive after the initial authorization check.
          await fs.link(tempZip, destZip);
          await fs.unlink(tempZip);
          const finalPath = await fs.realpath(destZip);
          if (!privacyGuard.isPathAllowed(finalPath)) {
            throw new Error("The final archive resolved outside approved filesystem roots.");
          }
          const finalStats = await fs.stat(finalPath);
          if (!finalStats.isFile() || finalStats.size === 0) {
            throw new Error("The published archive failed post-write verification.");
          }
          const detail = "Created archive at " + finalPath + " (" + finalStats.size + " bytes).";
          return {
            agentId: this.id,
            status: "completed",
            success: true,
            summary: detail,
            spokenSummary: "Created and verified the archive.",
            evidence: [{
              description: detail,
              source: finalPath,
              timestamp: new Date().toISOString(),
              confidence: 1,
              data: { sourceDir, bytes: finalStats.size },
            }],
            artifacts: [finalPath],
            data: {
              fileReferences: [finalPath],
              proposedChanges: ["Archive approved directory " + sourceDir],
              verifiedFilesystemResults: { zipPath: finalPath, bytes: finalStats.size },
            },
            verification: {
              passed: true,
              details: "The non-empty archive exists at its canonical destination inside an approved root.",
            },
          };
        } finally {
          await fs.rm(tempZip, { force: true }).catch(() => undefined);
        }
      }

      case "drive.upload":
      case "drive.share_link": {
        const message = "No Google Drive connector is configured. No file was uploaded and no share link was created.";
        return {
          agentId: this.id,
          status: "failed",
          success: false,
          summary: message,
          spokenSummary: "Google Drive is not connected, so I did not upload or share anything.",
          error: message,
          evidence: [],
          artifacts: [],
          data: {
            outcome: "unavailable",
            provider: "google-drive",
            uploadPerformed: false,
            sharePermissionChanged: false,
          },
          verification: { passed: false, details: message },
        };
      }

      default:
        throw new Error(`FileAgent: Unknown action '${action}'`);
    }
  }
}

export const fileAgent = new FileAgent();
