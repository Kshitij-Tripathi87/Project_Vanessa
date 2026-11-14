import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { z } from "zod";
import { privacyGuard } from "./privacy.js";
import { executeWindowsAudio } from "../agents/windows-audio.js";
import { executePowerShellSteps } from "../agents/powershell-executor.js";

export type MobileToolContext = { signal: AbortSignal; taskId?: string; requestId?: string; deviceId?: string };
export type MobileTool<T = any> = {
  name: string;
  description: string;
  argsSchema: z.ZodType<T>;
  manifestSchema: Record<string, unknown>;
  tier: 0 | 1 | 2;
  timeoutMs: number;
  idempotent: boolean;
  queue: "read" | "ui";
  noVerifyReason?: string;
  confirmSummary?: (args: T) => string;
  persistResult?: boolean;
  handler: (args: T, context: MobileToolContext) => Promise<unknown>;
  verifier: (args: T, result: unknown) => Promise<boolean>;
};

const SystemArgs = z.object({}).strict();
const FindArgs = z.object({
  name: z.string().min(1).max(180),
  folder: z.string().min(1).max(240).optional(),
  extension: z.string().regex(/^\.[a-zA-Z0-9]{1,12}$/).optional(),
  modifiedAfter: z.number().int().nonnegative().optional(),
  modifiedBefore: z.number().int().nonnegative().optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
}).strict();
const OpenAppArgs = z.object({ app: z.enum(["chrome", "edge", "firefox", "notepad", "calculator", "explorer", "vscode"]) }).strict();
const OpenUrlArgs = z.object({ url: z.string().url().max(2048).refine((value) => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}, "Only credential-free HTTP or HTTPS URLs are allowed.") }).strict();
const VolumeArgs = z.object({ volumePercent: z.number().int().min(0).max(100) }).strict();
const OpenFileArgs = z.object({ path: z.string().min(1).max(1024) }).strict();
const DeleteFileArgs = z.object({ path: z.string().min(1).max(1024) }).strict();
const MediaArgs = z.object({ control: z.enum(["play_pause", "next", "previous", "stop"]) }).strict();
const LockArgs = z.object({}).strict();

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("Task was cancelled."), { code: "TASK_CANCELLED" });
}

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    for (const [name, value] of Object.entries(cpu.times)) sum[name as keyof typeof sum] += value;
    return sum;
  }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
}

async function sampleCpuUsage(signal: AbortSignal): Promise<number | null> {
  const before = cpuTimes();
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(Object.assign(new Error("Task was cancelled."), { code: "TASK_CANCELLED" })); };
    timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 120);
    signal.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
  assertNotAborted(signal);
  const after = cpuTimes();
  const total = Object.keys(after).reduce((sum, key) => sum + after[key as keyof typeof after] - before[key as keyof typeof before], 0);
  if (total <= 0) return null;
  return Math.round((1 - (after.idle - before.idle) / total) * 100);
}

function launch(executable: string, args: string[], signal: AbortSignal): Promise<{ launched: true; pid: number }> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
    const onAbort = () => { try { child.kill(); } catch { /* already exited */ } reject(Object.assign(new Error("Task was cancelled."), { code: "TASK_CANCELLED" })); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
    child.once("spawn", () => {
      signal.removeEventListener("abort", onAbort);
      child.unref();
      if (!child.pid) reject(new Error("Windows did not return a process id."));
      else resolve({ launched: true, pid: child.pid });
    });
  });
}

const APP_EXECUTABLES: Record<z.infer<typeof OpenAppArgs>["app"], string> = {
  chrome: "chrome.exe", edge: "msedge.exe", firefox: "firefox.exe",
  notepad: "notepad.exe", calculator: "calc.exe", explorer: "explorer.exe", vscode: "code.exe",
};

function safeRoots(): string[] {
  return privacyGuard.getAllowedFolders().map((root) => {
    try { return fs.realpathSync.native(root); } catch { return path.resolve(root); }
  });
}

function resolveAllowedRoot(folder?: string): string[] {
  const roots = safeRoots();
  if (!folder) return roots;
  const candidate = path.resolve(folder);
  let real: string;
  try { real = fs.realpathSync.native(candidate); }
  catch { throw Object.assign(new Error("Folder does not exist."), { code: "INVALID_ARGUMENTS" }); }
  if (!roots.some((root) => {
    const relative = path.relative(root, real);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  })) throw Object.assign(new Error("Folder is outside the approved folders."), { code: "PERMISSION_DENIED" });
  return [real];
}

async function findFiles(args: z.infer<typeof FindArgs>, signal: AbortSignal) {
  const roots = resolveAllowedRoot(args.folder);
  const found: Array<{ path: string; name: string; modifiedAt: number; size: number }> = [];
  const needle = args.name.toLocaleLowerCase();
  const pending = [...roots];
  let visited = 0;
  while (pending.length && found.length < args.maxResults && visited < 25_000) {
    assertNotAborted(signal);
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited % 128 === 0) assertNotAborted(signal);
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !["node_modules", ".git", "AppData"].includes(entry.name)) pending.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().includes(needle)) continue;
      if (args.extension && path.extname(entry.name).toLocaleLowerCase() !== args.extension.toLocaleLowerCase()) continue;
      try {
        const real = await fs.promises.realpath(full);
        if (!privacyGuard.isPathAllowed(real)) continue;
        const stat = await fs.promises.stat(real);
        if (args.modifiedAfter !== undefined && stat.mtimeMs < args.modifiedAfter) continue;
        if (args.modifiedBefore !== undefined && stat.mtimeMs > args.modifiedBefore) continue;
        found.push({ path: real, name: entry.name, modifiedAt: stat.mtimeMs, size: stat.size });
        if (found.length >= args.maxResults) break;
      } catch { /* a concurrently removed file is skipped */ }
    }
  }
  return { files: found, truncated: pending.length > 0 || visited >= 25_000 };
}

export function createMobileToolRegistry(): MobileTool<any>[] {
  return [
    {
      name: "system_status",
      description: "Get PC CPU and memory usage. Example: system_status({}).",
      argsSchema: SystemArgs,
      manifestSchema: { type: "object", properties: {}, additionalProperties: false },
      tier: 0, timeoutMs: 8_000, idempotent: true, queue: "read",
      handler: async (_args, { signal }) => {
        assertNotAborted(signal);
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const usagePercent = await sampleCpuUsage(signal);
        let battery: { chargePercent: number; estimatedRunTimeMinutes: number | null } | null = null;
        if (process.platform === "win32") {
          const command = "$battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if ($battery) { [ordered]@{ chargePercent = [int]$battery.EstimatedChargeRemaining; estimatedRunTimeMinutes = if ($battery.EstimatedRunTime -lt 71582788) { [int]$battery.EstimatedRunTime } else { $null } } | ConvertTo-Json -Compress } else { [ordered]@{ chargePercent = $null; estimatedRunTimeMinutes = $null } | ConvertTo-Json -Compress }";
          const batch = await executePowerShellSteps({ steps: [{ id: "mobile-battery-status", command }], timeoutMs: 5_000 });
          if (batch.success && batch.steps[0]?.status === "completed") {
            try {
              const parsed = JSON.parse(batch.steps[0].stdout.trim());
              if (Number.isInteger(parsed.chargePercent) && parsed.chargePercent >= 0 && parsed.chargePercent <= 100) battery = { chargePercent: parsed.chargePercent, estimatedRunTimeMinutes: Number.isInteger(parsed.estimatedRunTimeMinutes) ? parsed.estimatedRunTimeMinutes : null };
            } catch { /* report unavailable battery as null */ }
          }
        }
        return {
          hostname: os.hostname(), platform: os.platform(),
          cpu: { model: cpus[0]?.model ?? "unknown", logicalCores: cpus.length, usagePercent },
          memory: { totalBytes: totalMem, freeBytes: os.freemem(), usedPercent: Math.round((1 - os.freemem() / totalMem) * 100) },
          battery, capturedAt: Date.now(),
        };
      },
      verifier: async (_args, result) => !!result && typeof result === "object" && Number.isFinite((result as any).memory?.usedPercent) && ((result as any).cpu?.usagePercent === null || (Number.isFinite((result as any).cpu?.usagePercent) && (result as any).cpu.usagePercent >= 0 && (result as any).cpu.usagePercent <= 100)),
    },
    {
      name: "find_file",
      description: "Find a file by name under approved PC folders. Example: find_file({name:'report',extension:'.pdf'}).",
      argsSchema: FindArgs,
      manifestSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 180 }, folder: { type: "string", maxLength: 240 }, extension: { type: "string", pattern: "^\\.[a-zA-Z0-9]{1,12}$" }, modifiedAfter: { type: "integer", minimum: 0 }, modifiedBefore: { type: "integer", minimum: 0 }, maxResults: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, required: ["name"], additionalProperties: false },
      tier: 0, timeoutMs: 15_000, idempotent: true, queue: "read",
      handler: async (args, { signal }) => findFiles(args as z.infer<typeof FindArgs>, signal),
      verifier: async (_args, result) => !!result && Array.isArray((result as any).files),
    },
    {
      name: "open_app", description: "Open an app from the fixed PC allowlist. Example: open_app({app:'chrome'}).",
      argsSchema: OpenAppArgs, manifestSchema: { type: "object", properties: { app: { type: "string", enum: Object.keys(APP_EXECUTABLES) } }, required: ["app"], additionalProperties: false },
      tier: 1, timeoutMs: 5_000, idempotent: false, queue: "ui",
      handler: async (args, { signal }) => launch(APP_EXECUTABLES[args.app as keyof typeof APP_EXECUTABLES], [], signal),
      verifier: async (_args, result) => (result as any)?.launched === true && Number.isInteger((result as any)?.pid),
    },
    {
      name: "open_url", description: "Open an HTTP or HTTPS URL in the default PC browser. Example: open_url({url:'https://example.com'}).",
      argsSchema: OpenUrlArgs, manifestSchema: { type: "object", properties: { url: { type: "string", format: "uri", maxLength: 2048 } }, required: ["url"], additionalProperties: false },
      tier: 1, timeoutMs: 5_000, idempotent: false, queue: "ui",
      handler: async (args, { signal }) => launch("rundll32.exe", ["url.dll,FileProtocolHandler", args.url], signal),
      verifier: async (_args, result) => (result as any)?.launched === true && Number.isInteger((result as any)?.pid),
    },
    {
      name: "open_file", description: "Open a file that is inside an approved PC folder. Example: open_file({path:'C:/approved/report.pdf'}).",
      argsSchema: OpenFileArgs, manifestSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"], additionalProperties: false },
      tier: 1, timeoutMs: 5_000, idempotent: false, queue: "ui",
      handler: async (args, { signal }) => {
        let real: string;
        try { real = await fs.promises.realpath(args.path); } catch { throw Object.assign(new Error("File does not exist."), { code: "INVALID_ARGUMENTS" }); }
        if (!privacyGuard.isPathAllowed(real) || !(await fs.promises.stat(real)).isFile()) throw Object.assign(new Error("File is outside approved folders or is not a file."), { code: "PERMISSION_DENIED" });
        return launch("rundll32.exe", ["url.dll,FileProtocolHandler", real], signal);
      },
      verifier: async (_args, result) => (result as any)?.launched === true && Number.isInteger((result as any)?.pid),
    },
    {
      name: "set_volume", description: "Set the Windows default output volume from 0 to 100. Example: set_volume({volumePercent:35}).",
      argsSchema: VolumeArgs, manifestSchema: { type: "object", properties: { volumePercent: { type: "integer", minimum: 0, maximum: 100 } }, required: ["volumePercent"], additionalProperties: false },
      tier: 1, timeoutMs: 35_000, idempotent: true, queue: "ui",
      handler: async (args, { signal }) => {
        assertNotAborted(signal);
        const result = await executeWindowsAudio({ operation: "setVolume", volumePercent: args.volumePercent });
        if (!result.success || !result.observed) throw Object.assign(new Error(result.error?.message || "Windows audio control failed."), { code: "TASK_FAILED" });
        return { requestedVolume: args.volumePercent, observedVolume: result.observed.volumePercent, device: result.device?.id };
      },
      verifier: async (args, result) => Math.abs((result as any)?.observedVolume - args.volumePercent) <= 1,
    },
    {
      name: "delete_file", description: "Move one approved file to the Windows Recycle Bin after confirmation. Example: delete_file({path:'C:/approved/report.pdf'}).",
      argsSchema: DeleteFileArgs, manifestSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"], additionalProperties: false },
      tier: 2, timeoutMs: 20_000, idempotent: false, queue: "ui",
      confirmSummary: (args) => `Move ${path.basename(args.path)} to the Recycle Bin (${args.path})`,
      handler: async (args, { signal }) => {
        assertNotAborted(signal);
        let real: string;
        try { real = await fs.promises.realpath(args.path); } catch { throw Object.assign(new Error("File does not exist."), { code: "INVALID_ARGUMENTS" }); }
        const stat = await fs.promises.stat(real);
        if (!privacyGuard.isPathAllowed(real) || !stat.isFile()) throw Object.assign(new Error("Only one file inside an approved folder can be deleted."), { code: "PERMISSION_DENIED" });
        const literalPath = `'${real.replace(/'/g, "''")}'`;
        const command = `$source = @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class VanessaRecycleBin {\n  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]\n  private struct SHFILEOPSTRUCT {\n    public IntPtr hwnd; public uint wFunc;\n    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;\n    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;\n    public ushort fFlags;\n    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;\n    public IntPtr hNameMappings;\n    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;\n  }\n  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]\n  private static extern int SHFileOperation(ref SHFILEOPSTRUCT operation);\n  public static bool MoveToRecycleBin(string path) {\n    var operation = new SHFILEOPSTRUCT { wFunc = 3, pFrom = path + "\\0\\0", fFlags = 0x454 };\n    return SHFileOperation(ref operation) == 0 && !operation.fAnyOperationsAborted;\n  }\n}\n'@\nAdd-Type -TypeDefinition $source\n$target = ${literalPath}\nif (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Target file disappeared before recycle.' }\n$moved = [VanessaRecycleBin]::MoveToRecycleBin($target)\n[ordered]@{ movedToRecycleBin = $moved -and -not (Test-Path -LiteralPath $target); fileName = [IO.Path]::GetFileName($target) } | ConvertTo-Json -Compress`;
        const batch = await executePowerShellSteps({ steps: [{ id: "mobile-delete-file", command }], timeoutMs: 15_000 });
        if (!batch.success || batch.steps[0]?.status !== "completed") throw Object.assign(new Error(batch.error || batch.steps[0]?.stderr || "Could not move file to Recycle Bin."), { code: "TASK_FAILED" });
        const result = JSON.parse(batch.steps[0].stdout.trim()) as { movedToRecycleBin?: boolean; fileName?: string };
        return { ...result, originalPath: real };
      },
      verifier: async (_args, result) => (result as any)?.movedToRecycleBin === true && typeof (result as any)?.fileName === "string",
    },
    {
      name: "media_control", description: "Send a Windows media key for playback. Example: media_control({control:'play_pause'}).",
      argsSchema: MediaArgs, manifestSchema: { type: "object", properties: { control: { type: "string", enum: ["play_pause", "next", "previous", "stop"] } }, required: ["control"], additionalProperties: false },
      tier: 1, timeoutMs: 12_000, idempotent: false, queue: "ui", noVerifyReason: "Windows reports that a media key was sent but does not expose a reliable active-player state readback.",
      handler: async (args, { signal }) => {
        assertNotAborted(signal);
        const keys = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 } as const;
        const vk = keys[args.control as keyof typeof keys];
        const command = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class VanessaMediaKey { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'\n[VanessaMediaKey]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)\n[VanessaMediaKey]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)\n[ordered]@{ sent = $true; control = '${args.control}' } | ConvertTo-Json -Compress`;
        const batch = await executePowerShellSteps({ steps: [{ id: "mobile-media-key", command }], timeoutMs: 10_000 });
        if (!batch.success || batch.steps[0]?.status !== "completed") throw Object.assign(new Error(batch.error || batch.steps[0]?.stderr || "Media control failed."), { code: "TASK_FAILED" });
        return JSON.parse(batch.steps[0].stdout.trim());
      },
      verifier: async (args, result) => (result as any)?.sent === true && (result as any)?.control === args.control,
    },
    {
      name: "lock_pc", description: "Lock the Windows session. Example: lock_pc({}).",
      argsSchema: LockArgs, manifestSchema: { type: "object", properties: {}, additionalProperties: false },
      tier: 1, timeoutMs: 5_000, idempotent: false, queue: "ui", noVerifyReason: "The lock request process is verified as started; Windows does not provide an accessible confirmation from this process that the session is visibly locked.",
      handler: async (_args, { signal }) => launch("rundll32.exe", ["user32.dll,LockWorkStation"], signal),
      verifier: async (_args, result) => (result as any)?.launched === true && Number.isInteger((result as any)?.pid),
    },
    {
      name: "take_screenshot", description: "Capture and return a scaled JPEG of the current PC desktop. Example: take_screenshot({}).",
      argsSchema: LockArgs, manifestSchema: { type: "object", properties: {}, additionalProperties: false },
      tier: 1, timeoutMs: 15_000, idempotent: false, queue: "ui", persistResult: false,
      handler: async (_args, { signal }) => {
        assertNotAborted(signal);
        if (process.platform !== "win32") throw Object.assign(new Error("Desktop capture is available only on Windows."), { code: "TASK_FAILED" });
        const command = `Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen\nif ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { throw 'No active desktop bounds.' }\n$source = New-Object System.Drawing.Bitmap -ArgumentList $bounds.Width,$bounds.Height\n$graphics = [System.Drawing.Graphics]::FromImage($source)\n$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)\n$scale = [Math]::Min(1.0, [Math]::Min(640.0 / $bounds.Width, 480.0 / $bounds.Height))\n$width = [Math]::Max(1, [int]($bounds.Width * $scale))\n$height = [Math]::Max(1, [int]($bounds.Height * $scale))\n$scaled = New-Object System.Drawing.Bitmap -ArgumentList $width,$height\n$scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)\n$scaledGraphics.DrawImage($source, 0, 0, $width, $height)\n$stream = New-Object System.IO.MemoryStream\n$scaled.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)\n$data = [Convert]::ToBase64String($stream.ToArray())\nif ($data.Length -gt 700000) { throw 'Scaled screenshot exceeds the mobile response size limit.' }\n[ordered]@{ mimeType = 'image/jpeg'; data = $data; width = $width; height = $height; capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\n$stream.Dispose(); $scaledGraphics.Dispose(); $scaled.Dispose(); $graphics.Dispose(); $source.Dispose()`;
        // A scaled JPEG needs more than the executor's 64 KiB default output cap.
        const batch = await executePowerShellSteps({ steps: [{ id: "mobile-screenshot", command }], timeoutMs: 12_000, maxOutputBytes: 800_000 });
        if (!batch.success || batch.steps[0]?.status !== "completed") {
          const detail = batch.error || batch.steps[0]?.stderr || "";
          if (/CopyFromScreen|handle is invalid/i.test(detail)) throw Object.assign(new Error("No interactive desktop capture is available to the orchestrator."), { code: "TASK_FAILED" });
          throw Object.assign(new Error(detail || "Could not capture the desktop."), { code: "TASK_FAILED" });
        }
        return JSON.parse(batch.steps[0].stdout.trim());
      },
      verifier: async (_args, result) => (result as any)?.mimeType === "image/jpeg" && typeof (result as any)?.data === "string" && (result as any).data.startsWith("/9j/") && (result as any).data.length <= 700_000 && Number.isInteger((result as any)?.width) && Number.isInteger((result as any)?.height),
    },
  ];
}

export const mobileToolRegistry: MobileTool<any>[] = createMobileToolRegistry();
export function getMobileToolManifest() {
  return { version: "1.0.0", tools: mobileToolRegistry.map(({ name, description, manifestSchema, tier }) => ({ name, description, argsSchema: manifestSchema, tier })) };
}
