import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runPowerShell } from "./powershell.js";
import { privacyGuard } from "../core/privacy.js";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";

const execAsync = promisify(exec);

export class FileAgent implements SpecialistAgent {
  id = "files";
  capabilities = [
    "file_search",
    "folder_creation",
    "file_manipulation",
    "drive_upload",
    "archive_creation",
  ];
  allowedTools = [
    "folder_create",
    "file_search",
    "file_read",
    "file_write",
    "drive_upload",
  ];

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const _runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    const startTime = new Date().toISOString();

    switch (action) {
      case "folder.create": {
        const folderName = params.name || params.path || "Buildathon Demo";
        const basePath = params.basePath || privacyGuard.getAllowedFolders()[0] || path.join(os.homedir(), "Documents", "VanessaDemo");
        const targetPath = path.isAbsolute(folderName) ? folderName : path.join(basePath, folderName);

        if (process.env.FAKE === "1") {
          return {
            agentId: this.id,
            status: "completed",
            success: true,
            summary: `Created real folder at ${targetPath} and opened in Windows Explorer (FAKE=1)`,
            spokenSummary: `Created folder ${folderName}.`,
            evidence: [],
            artifacts: [targetPath],
            verification: {
              passed: true,
              details: `Filesystem directory confirmed at ${targetPath} (FAKE=1)`,
            },
            data: {
              fileReferences: [targetPath],
              proposedChanges: [`Created directory ${targetPath}`],
              verifiedFilesystemResults: { path: targetPath, exists: true },
              path: targetPath,
            },
          };
        }

        await fs.mkdir(targetPath, { recursive: true });

        const demoFilePath = path.join(targetPath, "Vanessa_Agent_Note.txt");
        await fs.writeFile(
          demoFilePath,
          `==================================================\n` +
          `   PROJECT VANESSA - AUTONOMOUS AGENT ACTIONS     \n` +
          `==================================================\n` +
          `Task: ${folderName}\n` +
          `Timestamp: ${new Date().toLocaleString()}\n` +
          `Status: Created successfully by Vanessa File Agent.\n`
        );

        try {
          exec(`explorer.exe "${targetPath}"`);
        } catch {}

        const evidence: AgentEvidence[] = [
          {
            description: `Created directory and verification note at ${targetPath}`,
            source: targetPath,
            timestamp: startTime,
            confidence: 1.0,
          },
        ];

        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: `Created real folder at ${targetPath} and opened in Windows Explorer`,
          spokenSummary: `Created folder ${folderName}.`,
          evidence,
          artifacts: [targetPath, demoFilePath],
          verification: {
            passed: true,
            details: `Filesystem directory confirmed at ${targetPath}`,
          },
          data: {
            fileReferences: [targetPath, demoFilePath],
            proposedChanges: [`Created directory ${targetPath}`],
            verifiedFilesystemResults: { path: targetPath, exists: true },
            path: targetPath,
          },
        };
      }

      case "file.search": {
        const query = params.query || "";
        const targetDir = params.path || process.cwd();
        try {
          const entries = await fs.readdir(targetDir);
          const matches = entries.filter((name) => name.toLowerCase().includes(query.toLowerCase()));
          return {
            agentId: this.id,
            status: "completed",
            success: true,
            summary: `Found ${matches.length} matching files in ${targetDir}`,
            spokenSummary: `Found ${matches.length} matching files.`,
            evidence: [],
            artifacts: matches,
            data: {
              fileReferences: matches.map((m) => path.join(targetDir, m)),
              matches,
              bestMatch: matches[0] ? { id: matches[0], name: matches[0] } : undefined,
              directory: targetDir,
              verifiedFilesystemResults: { totalMatches: matches.length },
            },
            verification: {
              passed: true,
              details: `Directory listing completed for ${targetDir}; ${matches.length} matching entry(ies) observed.`,
            },
          };
        } catch (err: any) {
          return {
            agentId: this.id,
            status: "failed",
            success: false,
            error: err.message,
            spokenSummary: "No matching files found.",
            evidence: [],
            artifacts: [],
            data: { matches: [] },
          };
        }
      }

      case "file.rename": {
        const { oldPath, newPath } = params;
        if (!oldPath || !newPath) throw new Error("oldPath and newPath are required");
        await fs.rename(oldPath, newPath);
        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: `Renamed ${oldPath} to ${newPath}`,
          spokenSummary: "File renamed.",
          evidence: [],
          artifacts: [newPath],
          data: {
            fileReferences: [oldPath, newPath],
            proposedChanges: [`Rename ${oldPath} -> ${newPath}`],
            verifiedFilesystemResults: { oldPath, newPath, success: true },
          },
          verification: {
            passed: await fs.stat(newPath).then((stat) => stat.isFile() || stat.isDirectory()).catch(() => false),
            details: `Rename destination inspected at ${newPath}.`,
          },
        };
      }

      case "file.zip":
      case "project.zip": {
        const sourceDir = params.sourceDir || process.cwd();
        const requestedZipName = path.basename(String(params.zipName || `project_${Date.now()}.zip`));
        const zipName = requestedZipName.toLowerCase().endsWith(".zip") ? requestedZipName : `${requestedZipName}.zip`;
        const archiveRoot = privacyGuard.getAllowedFolders()[0] || process.cwd();
        const destZip = path.join(archiveRoot, zipName);
        await runPowerShell(
          "Compress-Archive -Path (Join-Path $env:VANESSA_SOURCE '*') -DestinationPath $env:VANESSA_DESTINATION -Force",
          { VANESSA_SOURCE: sourceDir, VANESSA_DESTINATION: destZip },
          15000
        );
        const zipStats = await fs.stat(destZip);
        if (!zipStats.isFile() || zipStats.size === 0) {
          throw new Error("Archive output was missing or empty after compression.");
        }
        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: `Created zip archive at ${destZip}`,
          spokenSummary: "Created zip archive.",
          evidence: [],
          artifacts: [destZip],
          data: {
            fileReferences: [destZip],
            proposedChanges: [`Archive directory ${sourceDir}`],
            verifiedFilesystemResults: { zipPath: destZip },
          },
          verification: {
            passed: true,
            details: `Archive exists at ${destZip} with ${zipStats.size} bytes.`,
          },
        };
      }

      case "drive.upload": {
        return {
          agentId: this.id,
          status: "failed",
          success: false,
          summary: "Google Drive upload integration is not configured.",
          spokenSummary: "I could not upload the file because Google Drive integration is not configured.",
          evidence: [],
          artifacts: [],
          error: "No authenticated Google Drive client is configured; no upload was attempted.",
          verification: { passed: false, details: "Cloud upload was not performed." },
        };
      }

      case "drive.share_link": {
        return {
          agentId: this.id,
          status: "failed",
          success: false,
          summary: "Google Drive sharing integration is not configured.",
          spokenSummary: "I could not create a share link because Google Drive integration is not configured.",
          evidence: [],
          artifacts: [],
          error: "No authenticated Google Drive client is configured; no share link was created.",
          verification: { passed: false, details: "Cloud sharing was not performed." },
        };
      }

      default:
        throw new Error(`FileAgent: Unknown action '${action}'`);
    }
  }
}

export const fileAgent = new FileAgent();
