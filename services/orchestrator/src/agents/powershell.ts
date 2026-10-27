import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Keep only Windows process/runtime variables needed by fixed system scripts.
// Provider keys, session tokens and the rest of the orchestrator environment do
// not cross this process boundary unless a caller explicitly passes a VANESSA_*
// value as structured data.
const WINDOWS_RUNTIME_ENV = new Set([
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATH", "PATHEXT", "COMSPEC",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "PSMODULEPATH",
]);

export function buildPowerShellEnvironment(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (WINDOWS_RUNTIME_ENV.has(key.toUpperCase()) && typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!/^VANESSA_[A-Z0-9_]+$/.test(key)) {
      throw new Error(`Invalid PowerShell environment key: ${key}`);
    }
    if (typeof value !== "string" || value.includes("\0") || value.length > 32768) {
      throw new Error(`Invalid value for PowerShell environment key: ${key}`);
    }
    env[key] = value;
  }
  return env;
}

/** Run a fixed PowerShell program with request values passed out-of-band. */
export function runPowerShell(
  script: string,
  values: Record<string, string> = {},
  timeout = 5000
) {
  if (typeof script !== "string" || !script.trim() || script.includes("\0")) {
    throw new Error("PowerShell script must be a non-empty fixed program without NUL.");
  }
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300000) {
    throw new Error("PowerShell timeout must be an integer from 100 to 300000 milliseconds.");
  }
  const env = buildPowerShellEnvironment(values);
  return execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 }
  );
}
