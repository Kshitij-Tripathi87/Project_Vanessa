import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run a fixed PowerShell program while keeping request values out of its code. */
export function runPowerShell(
  script: string,
  values: Record<string, string> = {},
  timeout = 5000
) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(values)) {
    if (!/^VANESSA_[A-Z0-9_]+$/.test(key)) {
      throw new Error(`Invalid PowerShell environment key: ${key}`);
    }
    env[key] = value;
  }

  return execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env, timeout, windowsHide: true }
  );
}
