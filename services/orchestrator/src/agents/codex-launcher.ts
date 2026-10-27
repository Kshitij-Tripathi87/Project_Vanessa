import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPowerShell } from "./powershell.js";

const execFileAsync = promisify(execFile);
const terminalProgram = `
$ErrorActionPreference = 'Stop'
$command = '& $env:VANESSA_NODE $env:VANESSA_HELPER'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $env:VANESSA_PROJECT -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', $encoded) -WindowStyle Normal -PassThru
Write-Output $p.Id
`;

export interface CodexDependencies {
  platform: () => string;
  stat: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  run: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  terminal: (script: string, values: Record<string, string>) => Promise<{ stdout: string; stderr: string }>;
}

export const codexDependencies: CodexDependencies = {
  platform: () => process.platform as string,
  stat,
  run: async (file: string, args: string[]) => execFileAsync(file, args, {
    timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024,
  }),
  terminal: runPowerShell,
};

async function isFile(path: string, deps: CodexDependencies) {
  try { return (await deps.stat(path)).isFile(); } catch { return false; }
}

// Prefer the npm .cmd installation, but never send prompt data through cmd.exe.
// Its adjacent JS entry point invokes the same installed Codex CLI with argv intact.
export async function findCodexCli(deps: CodexDependencies) {
  for (const entry of (process.env.PATH || "").split(delimiter)) {
    if (!entry) continue;
    const directory = entry.replace(/^"|"$/g, "");
    if (await isFile(join(directory, "codex.cmd"), deps)) {
      const cli = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (await isFile(cli, deps)) return { file: process.execPath, prefix: [cli] };
    }
    const native = join(directory, "codex.exe");
    if (await isFile(native, deps)) return { file: native, prefix: [] as string[] };
  }
  throw new Error("Codex CLI not found on PATH. Install Codex with its npm codex.cmd entry point or add codex.exe to PATH. Custom .cmd wrappers are not supported.");
}

export async function openCodex(params: Record<string, unknown>, deps = codexDependencies) {
  try {
    if (typeof params.prompt !== "string" || !params.prompt.trim()) {
      throw new Error("codex.open requires a non-empty prompt string.");
    }
    if (params.prompt.includes("\0")) throw new Error("Prompt cannot contain NUL characters.");
    if (typeof params.projectPath !== "string" || !params.projectPath.trim()) {
      throw new Error("codex.open requires projectPath to be an existing project directory.");
    }
    const projectPath = resolve(params.projectPath);
    try {
      if (!(await deps.stat(projectPath)).isDirectory()) throw new Error("Not a directory");
    } catch {
      throw new Error(`Invalid or inaccessible project directory: ${projectPath}`);
    }
    if (deps.platform() !== "win32") throw new Error("codex.open currently supports Windows only.");
    const cli = await findCodexCli(deps);
    let help: string;
    try {
      const result = await deps.run(cli.file, [...cli.prefix, "--help"]);
      help = result.stdout;
    } catch (error) {
      throw new Error(`Could not inspect Codex --help: ${(error as Error).message}`);
    }
    if (!/\[PROMPT\]/i.test(help)) {
      throw new Error("Installed Codex --help does not advertise a positional [PROMPT]; cannot safely launch this version.");
    }
    let helper = fileURLToPath(new URL("./codex-terminal.cjs", import.meta.url));
    if (!(await isFile(helper, deps))) {
      // tsc emits JS into dist; the unchanged helper remains in src.
      helper = resolve(dirname(helper), "../../src/agents/codex-terminal.cjs");
      if (!(await isFile(helper, deps))) throw new Error("Codex terminal helper is missing.");
    }
    // '--' ensures even a prompt starting with '-' stays positional.
    const payload = JSON.stringify({ file: cli.file, args: [...cli.prefix, "--", params.prompt], projectPath });
    const result = await deps.terminal(terminalProgram, {
      VANESSA_NODE: process.execPath,
      VANESSA_HELPER: helper,
      VANESSA_PROJECT: projectPath,
      VANESSA_CODEX_REQUEST: payload,
    });
    const terminalPid = Number(result.stdout.trim());
    if (!Number.isSafeInteger(terminalPid) || terminalPid <= 0) throw new Error("Terminal launch returned no process ID.");
    return {
      success: true,
      status: "started",
      terminalPid,
      projectPath,
      output: "Visible terminal process started. Codex startup, prompt acceptance, and task completion are not verified; check the terminal.",
    };
  } catch (error) {
    return { success: false, status: "failed", error: `Could not open Codex: ${(error as Error).message}` };
  }
}
