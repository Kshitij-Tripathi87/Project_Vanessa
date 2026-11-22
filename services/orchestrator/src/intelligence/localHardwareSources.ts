import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { AcceleratorProfile, CpuProfile, MemoryProfile, ProbeStatus } from "./contracts.js";
import type { HardwareProbeProviders, ProbeResult } from "./hardwareProbe.js";

const execFileAsync = promisify(execFile);
const MiB = 1024 * 1024;
const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && !/^(?:\[?n\/?a\]?|\[?not supported\]?|unknown)$/i.test(trimmed) ? trimmed : null;
};
const natural = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = (value: unknown): number | null => {
  const n = natural(value);
  return n !== null && n > 0 ? n : null;
};

async function readText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

function absoluteWindowsPath(value: string | undefined, fallback: string): string {
  // Never execute from a UNC/device path supplied through the environment.
  return value && /^[a-z]:[\\/]/i.test(value) && path.win32.isAbsolute(value) ? value : fallback;
}

/** Probe subprocesses do not inherit provider credentials or arbitrary module paths. */
export function localProbeEnvironment(platform: NodeJS.Platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (platform !== "win32") return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  const root = absoluteWindowsPath(source.SystemRoot, "C:\\Windows");
  const system = path.win32.join(root, "System32");
  const powerShell = path.win32.join(system, "WindowsPowerShell", "v1.0");
  const temp = absoluteWindowsPath(source.TEMP, path.win32.join(root, "Temp"));
  return {
    SystemRoot: root,
    WINDIR: root,
    SystemDrive: root.slice(0, 2),
    PATH: [system, root, path.win32.join(system, "Wbem"), powerShell].join(";"),
    PSModulePath: path.win32.join(powerShell, "Modules"),
    TEMP: temp,
    TMP: absoluteWindowsPath(source.TMP, temp),
  };
}

/** Only fixed executable paths/arguments are used, with no shell or network. */
async function runFixed(files: readonly string[], args: readonly string[], timeout = 5_000): Promise<string | null> {
  for (const file of files) {
    try {
      const { stdout } = await execFileAsync(file, [...args], {
        timeout, maxBuffer: 2 * MiB, windowsHide: true, env: localProbeEnvironment(process.platform),
      });
      return stdout;
    } catch {
      // Missing utilities, unsupported drivers, timeouts and permissions are unknown.
    }
  }
  return null;
}

function common(values: readonly (string | null)[]): string | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  const distinct = new Set(values);
  return distinct.size === 1 ? values[0] : null;
}

/** Parse all reported logical CPUs; only ISA flags common to every CPU survive. */
export function parseLinuxCpuInfo(source: string): Pick<CpuProfile, "vendor" | "model" | "instructionSets"> {
  const sections = source.split(/\n\s*\n/).map((block) => {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const index = line.indexOf(":");
      if (index > 0) fields.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
    }
    return fields;
  }).filter((fields) => fields.has("processor"));
  if (sections.length === 0) return { vendor: null, model: null, instructionSets: null };
  const vendors = sections.map((section) => text(section.get("vendor_id") ?? section.get("cpu implementer")));
  const models = sections.map((section) => text(section.get("model name") ?? section.get("hardware")));
  const featureLists = sections.map((section) => {
    const raw = text(section.get("flags") ?? section.get("features"));
    return raw ? new Set(raw.toLowerCase().split(/\s+/).filter(Boolean)) : null;
  });
  let instructionSets: string[] | null = null;
  if (featureLists.every((features) => features !== null)) {
    instructionSets = [...featureLists[0]!].filter((feature) => featureLists.every((features) => features!.has(feature))).sort();
  }
  return { vendor: common(vendors), model: common(models), instructionSets };
}

function pciId(raw: string | null): string | null {
  if (!raw) return null;
  const match = /^([0-9a-f]+):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i.exec(raw.trim());
  if (!match) return null;
  const domain = match[1].replace(/^0+/, "") || "0";
  return `${domain.padStart(4, "0")}:${match[2]}:${match[3]}.${match[4]}`.toLowerCase();
}

function csvFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else field += ch;
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields;
}

function memoryMiB(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim()) * MiB;
  return natural(value);
}

/** nvidia-smi reports facts, not engine compatibility or memory topology. */
export function parseNvidiaSmiOutput(source: string): { devices: AcceleratorProfile[]; complete: boolean } {
  const devices: AcceleratorProfile[] = [];
  let complete = true;
  for (const line of source.split(/\r?\n/).filter((entry) => entry.trim())) {
    const fields = csvFields(line);
    if (!fields || fields.length !== 6) { complete = false; continue; }
    const [uuid, bus, name, totalRaw, freeRaw, driver] = fields;
    const normalizedPci = pciId(bus);
    const id = normalizedPci ? `pci:${normalizedPci}` : text(uuid) ? `nvidia:${uuid.trim()}` : null;
    if (!id) { complete = false; continue; }
    const totalMemoryBytes = positive(memoryMiB(totalRaw));
    let availableMemoryBytes = memoryMiB(freeRaw);
    if (totalMemoryBytes !== null && availableMemoryBytes !== null && availableMemoryBytes > totalMemoryBytes) availableMemoryBytes = null;
    devices.push({
      id,
      vendor: "NVIDIA",
      name: text(name),
      pciDeviceId: null,
      totalMemoryBytes,
      availableMemoryBytes,
      // nvidia-smi's framebuffer figures alone do not prove dedicated vs shared.
      memoryTopology: "unknown",
      driverVersion: text(driver),
      computeCapability: null,
    });
  }
  return { devices, complete };
}

async function nvidiaObservation(platform: NodeJS.Platform): Promise<ProbeResult<readonly AcceleratorProfile[]>> {
  const windowsRoot = absoluteWindowsPath(process.env.SystemRoot, "C:\\Windows");
  const programFiles = absoluteWindowsPath(process.env.ProgramW6432, "C:\\Program Files");
  const files = platform === "win32"
    ? [path.win32.join(windowsRoot, "System32", "nvidia-smi.exe"), path.win32.join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")]
    : ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"];
  const output = await runFixed(files, [
    "--query-gpu=uuid,pci.bus_id,name,memory.total,memory.free,driver_version",
    "--format=csv,noheader,nounits",
  ], 3_000);
  if (output === null) return { status: "unavailable", value: null };
  const parsed = parseNvidiaSmiOutput(output);
  return { status: parsed.complete ? "complete" : "partial", value: parsed.devices };
}

function hexDevice(raw: string | null): string | null {
  const cleaned = raw?.trim().toLowerCase();
  return cleaned && /^0x[0-9a-f]{4}$/.test(cleaned) ? cleaned : null;
}

const pciVendors: Readonly<Record<string, string>> = {
  "0x10de": "NVIDIA",
  "0x1002": "AMD",
  "0x1022": "AMD",
  "0x8086": "Intel",
  "0x106b": "Apple",
};

/** Parse the locally installed pci.ids database without downloading identities. */
export function parsePciDeviceNames(source: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  let vendor: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const vendorLine = /^([0-9a-f]{4})\s+(.+)$/i.exec(line);
    if (vendorLine) { vendor = vendorLine[1].toLowerCase(); continue; }
    if (/^\S/.test(line) && !line.startsWith("#")) vendor = null;
    const deviceLine = /^\t([0-9a-f]{4})\s+(.+)$/i.exec(line);
    if (vendor && deviceLine) names.set(`0x${vendor}:0x${deviceLine[1].toLowerCase()}`, deviceLine[2].trim());
  }
  return names;
}

async function linuxPciObservation(): Promise<ProbeResult<readonly AcceleratorProfile[]>> {
  const root = "/sys/bus/pci/devices";
  let entries: string[];
  try { entries = await readdir(root); } catch { return { status: "unavailable", value: null }; }
  const bdfs = entries.filter((entry) => pciId(entry) !== null).sort();
  const database = await readText("/usr/share/hwdata/pci.ids") ?? await readText("/usr/share/misc/pci.ids");
  const deviceNames = database === null ? new Map<string, string>() : parsePciDeviceNames(database);
  // PCI is not an exhaustive inventory of SoC, virtual or other accelerators.
  // Bound work on large hosts and never claim a known-empty full inventory.
  let status: ProbeStatus = "partial";
  const observations = await Promise.all(bdfs.slice(0, 1_024).map(async (entry) => {
    const base = `${root}/${entry}`;
    const classText = await readText(`${base}/class`);
    if (!classText || !/^0x[0-9a-f]{6}\s*$/i.test(classText)) return { failed: true, device: null };
    const deviceClass = Number.parseInt(classText.trim(), 16) >> 16;
    if (deviceClass !== 0x03 && deviceClass !== 0x12) return { failed: false, device: null };
    const [vendorRaw, deviceRaw, totalRaw, usedRaw] = await Promise.all([
      readText(`${base}/vendor`), readText(`${base}/device`),
      readText(`${base}/mem_info_vram_total`), readText(`${base}/mem_info_vram_used`),
    ]);
    const vendorId = hexDevice(vendorRaw);
    const deviceId = hexDevice(deviceRaw);
    const parseSysfsBytes = (value: string | null): number | null => value && /^\d+\s*$/.test(value) ? natural(Number(value.trim())) : null;
    const totalMemoryBytes = positive(parseSysfsBytes(totalRaw));
    const used = parseSysfsBytes(usedRaw);
    const availableMemoryBytes = totalMemoryBytes !== null && used !== null && used <= totalMemoryBytes ? totalMemoryBytes - used : null;
    let driverVersion: string | null = null;
    try {
      const driver = path.posix.basename(await readlink(`${base}/driver`));
      if (/^[a-z0-9_-]+$/i.test(driver)) driverVersion = text(await readText(`/sys/module/${driver}/version`));
    } catch { /* No driver/version is a valid unknown. */ }
    const device: AcceleratorProfile = {
      id: `pci:${pciId(entry)!}`,
      vendor: vendorId ? pciVendors[vendorId] ?? vendorId : null,
      name: vendorId && deviceId ? deviceNames.get(`${vendorId}:${deviceId}`) ?? null : null,
      pciDeviceId: deviceId,
      totalMemoryBytes,
      availableMemoryBytes,
      memoryTopology: "unknown",
      driverVersion,
      computeCapability: null,
    };
    return { failed: !vendorId || !device.pciDeviceId, device };
  }));
  const devices: AcceleratorProfile[] = [];
  for (const observation of observations) {
    if (observation.failed) status = "partial";
    if (observation.device) devices.push(observation.device);
  }
  return { status, value: devices };
}

export interface WindowsSnapshot {
  cpu: Array<{ Name?: unknown; Manufacturer?: unknown }>;
  accelerators: Array<{ Name?: unknown; AdapterCompatibility?: unknown; DriverVersion?: unknown; PNPDeviceID?: unknown }>;
  instructionSets: readonly string[] | null;
}

// Fixed local query. IsProcessorFeaturePresent reports OS-exposed flags; this
// finite list is deliberately not described as an exhaustive ISA inventory.
const WINDOWS_CIM_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$isa = $null
try {
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class VanessaCpuProbe { [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsProcessorFeaturePresent(uint feature); }'
  $features = @{ sse = 6; sse2 = 10; sse3 = 13; sse4_1 = 37; sse4_2 = 38; avx = 39; avx2 = 40; avx512f = 41; armv8 = 29; armv8_crypto = 30; armv8_crc32 = 31; armv8_1_atomics = 34 }
  $isa = @(foreach ($entry in $features.GetEnumerator()) {
    if ([VanessaCpuProbe]::IsProcessorFeaturePresent([uint32]$entry.Value)) { [string]$entry.Key }
  })
} catch { $isa = $null }
$info = @{
  cpu = @(Get-CimInstance -ClassName Win32_Processor | Select-Object Name, Manufacturer)
  accelerators = @(Get-CimInstance -ClassName Win32_VideoController | Select-Object Name, AdapterCompatibility, DriverVersion, PNPDeviceID)
  instructionSets = $isa
}
ConvertTo-Json -InputObject $info -Depth 4 -Compress
`;

export function parseWindowsSnapshot(output: string): WindowsSnapshot | null {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object") return null;
    const snapshot = value as Partial<WindowsSnapshot>;
    if (!Array.isArray(snapshot.cpu) || !Array.isArray(snapshot.accelerators)) return null;
    const instructionSets = Array.isArray(snapshot.instructionSets)
      && snapshot.instructionSets.every((item) => typeof item === "string" && item.trim().length > 0)
      ? [...snapshot.instructionSets] : null;
    return { cpu: snapshot.cpu, accelerators: snapshot.accelerators, instructionSets };
  } catch { return null; }
}

async function windowsSnapshot(): Promise<WindowsSnapshot | null> {
  const root = absoluteWindowsPath(process.env.SystemRoot, "C:\\Windows");
  const output = await runFixed([path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CIM_QUERY]);
  return output === null ? null : parseWindowsSnapshot(output);
}

export function windowsAccelerators(snapshot: WindowsSnapshot | null): ProbeResult<readonly AcceleratorProfile[]> {
  if (!snapshot) return { status: "unavailable", value: null };
  // Video controllers do not enumerate every possible compute accelerator.
  let status: ProbeStatus = "partial";
  const devices: AcceleratorProfile[] = [];
  for (const [index, raw] of snapshot.accelerators.entries()) {
    const name = text(raw?.Name);
    const vendor = text(raw?.AdapterCompatibility);
    const pnpId = text(raw?.PNPDeviceID);
    if (!name && !vendor && !pnpId) { status = "partial"; continue; }
    devices.push({
      id: pnpId ? `windows:${pnpId}` : `windows:display:${index}`,
      vendor,
      name,
      pciDeviceId: null,
      // Win32_VideoController.AdapterRAM is frequently 32-bit/truncated and
      // has no free-memory measurement. Do not turn it into an upper bound.
      totalMemoryBytes: null,
      availableMemoryBytes: null,
      memoryTopology: "unknown",
      driverVersion: text(raw?.DriverVersion),
      computeCapability: null,
    });
  }
  return { status, value: devices };
}

function profilerBytes(raw: unknown): number | null {
  const value = text(raw);
  const match = value && /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i.exec(value);
  if (!match) return null;
  // Labels such as "GB" may be rounded/decimal; decimal units are the
  // conservative interpretation. Free memory remains unknown regardless.
  const multiplier: Readonly<Record<string, number>> = { B: 1, KB: 1_000, MB: 1_000_000, GB: 1_000_000_000, TB: 1_000_000_000_000 };
  const digits = match[1].split(".")[1]?.length ?? 0;
  const lowerBound = Math.max(0, Number(match[1]) - 10 ** -digits);
  return positive(Math.floor(lowerBound * multiplier[match[2].toUpperCase()]));
}

async function macAccelerators(): Promise<ProbeResult<readonly AcceleratorProfile[]>> {
  const output = await runFixed(["/usr/sbin/system_profiler"], ["SPDisplaysDataType", "-json"], 5_000);
  if (output === null) return { status: "unavailable", value: null };
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object") return { status: "unavailable", value: null };
    const items = (parsed as Record<string, unknown>).SPDisplaysDataType;
    if (!Array.isArray(items)) return { status: "unavailable", value: null };
    // Display inventory does not enumerate all compute/Neural Engine devices.
    let status: ProbeStatus = "partial";
    const devices: AcceleratorProfile[] = [];
    for (const [index, value] of items.entries()) {
      if (!value || typeof value !== "object") { status = "partial"; continue; }
      const raw = value as Record<string, unknown>;
      const name = text(raw.sppci_model) ?? text(raw._name);
      const vendor = text(raw.spdisplays_vendor) ?? text(raw.sppci_vendor);
      if (!name && !vendor) { status = "partial"; continue; }
      const shared = text(raw.spdisplays_vram_shared);
      devices.push({
        id: `mac:display:${index}`,
        vendor,
        name,
        pciDeviceId: text(raw.spdisplays_device_id),
        totalMemoryBytes: profilerBytes(shared ?? raw.spdisplays_vram),
        availableMemoryBytes: null,
        memoryTopology: shared ? "shared" : "unknown",
        driverVersion: null,
        computeCapability: null,
      });
    }
    return { status, value: devices };
  } catch { return { status: "unavailable", value: null }; }
}

function mergeDevices(primary: readonly AcceleratorProfile[], nvidia: readonly AcceleratorProfile[]): { devices: AcceleratorProfile[]; ambiguous: boolean } {
  const result = [...primary];
  let ambiguous = false;
  for (const device of nvidia) {
    const index = result.findIndex((item) => item.id === device.id);
    if (index < 0) {
      // A matching product name is not a device identity: two identical GPUs
      // may be visible to different APIs. Keep unmatched observations separate.
      if (primary.some((item) => /nvidia/i.test(`${item.vendor ?? ""} ${item.name ?? ""}`))) ambiguous = true;
      result.push(device);
      continue;
    }
    const previous = result[index];
    const lowerKnown = (a: number | null, b: number | null): number | null =>
      a === null ? b : b === null ? a : Math.min(a, b);
    const topologyConflict = previous.memoryTopology !== "unknown" && device.memoryTopology !== "unknown"
      && previous.memoryTopology !== device.memoryTopology;
    if (topologyConflict) ambiguous = true;
    result[index] = {
      ...previous,
      id: device.id,
      vendor: device.vendor ?? previous.vendor,
      name: device.name ?? previous.name,
      // Independent measurements may differ or be sampled at different times.
      totalMemoryBytes: lowerKnown(previous.totalMemoryBytes, device.totalMemoryBytes),
      availableMemoryBytes: lowerKnown(previous.availableMemoryBytes, device.availableMemoryBytes),
      memoryTopology: topologyConflict ? "unknown" : device.memoryTopology !== "unknown" ? device.memoryTopology : previous.memoryTopology,
      driverVersion: device.driverVersion ?? previous.driverVersion,
      computeCapability: device.computeCapability ?? previous.computeCapability,
    };
  }
  return { devices: result, ambiguous };
}

export function combineInventory(primary: ProbeResult<readonly AcceleratorProfile[]>, nvidia: ProbeResult<readonly AcceleratorProfile[]>): ProbeResult<readonly AcceleratorProfile[]> {
  if (primary.status === "unavailable" && nvidia.status === "unavailable") return { status: "unavailable", value: null };
  const merged = mergeDevices(primary.value ?? [], nvidia.value ?? []);
  const status: ProbeStatus = primary.status === "complete" && nvidia.status !== "partial" && !merged.ambiguous ? "complete" : "partial";
  return { status, value: merged.devices };
}

function localMemory(): ProbeResult<MemoryProfile> {
  try {
    let total = positive(os.totalmem());
    const osFree = natural(os.freemem());
    let constrained: number | null = null;
    let processFree: number | null = null;
    try { constrained = positive(process.constrainedMemory?.()); } catch { /* unknown */ }
    try { processFree = natural(process.availableMemory?.()); } catch { /* unknown */ }
    if (total !== null && constrained !== null) total = Math.min(total, constrained);
    // If a process-level availability reading is absent, a container/job limit
    // could make host free memory unsafe to use. Leave availability unknown.
    const available = total !== null && osFree !== null && processFree !== null
      ? Math.min(total, osFree, processFree) : null;
    return { status: total !== null && available !== null ? "complete" : "partial", value: { totalBytes: total, availableBytes: available } };
  } catch { return { status: "unavailable", value: null }; }
}

/** Default providers collect only local facts; no engine support is assumed. */
export function createLocalHardwareProviders(): HardwareProbeProviders {
  const platform = process.platform;
  let windowsPromise: Promise<WindowsSnapshot | null> | undefined;
  const windows = (): Promise<WindowsSnapshot | null> => windowsPromise ??= windowsSnapshot();

  return {
    system: () => ({ status: "complete", value: { os: platform, architecture: process.arch } }),
    cpu: async () => {
      try {
        const cpus = os.cpus();
        const nodeModels = cpus.map((cpu) => text(cpu.model));
        let model = common(nodeModels);
        let vendor: string | null = null;
        let instructionSets: readonly string[] | null = null;
        if (platform === "linux") {
          const source = await readText("/proc/cpuinfo");
          if (source !== null) {
            const parsed = parseLinuxCpuInfo(source);
            vendor = parsed.vendor;
            // A mixed set of os.cpus models must not become a single invented model.
            if (model === null && nodeModels.length === 0) model = parsed.model;
            instructionSets = parsed.instructionSets;
          }
        } else if (platform === "win32") {
          const snapshot = await windows();
          if (snapshot) {
            vendor = common(snapshot.cpu.map((cpu) => text(cpu?.Manufacturer)));
            if (model === null && nodeModels.length === 0) model = common(snapshot.cpu.map((cpu) => text(cpu?.Name)));
            instructionSets = snapshot.instructionSets;
          }
        } else if (platform === "darwin") {
          const [vendorResult, flags, leaf7] = await Promise.all([
            runFixed(["/usr/sbin/sysctl"], ["-n", "machdep.cpu.vendor"], 2_000),
            runFixed(["/usr/sbin/sysctl"], ["-n", "machdep.cpu.features"], 2_000),
            runFixed(["/usr/sbin/sysctl"], ["-n", "machdep.cpu.leaf7_features"], 2_000),
          ]);
          vendor = text(vendorResult);
          // Both lists are needed before claiming the complete set of observed flags.
          if (flags !== null && leaf7 !== null) instructionSets = [...new Set(`${flags} ${leaf7}`.toLowerCase().trim().split(/\s+/).filter(Boolean))].sort();
        }
        let logicalCores: number | null = null;
        try { logicalCores = positive(os.availableParallelism()); } catch { logicalCores = positive(cpus.length); }
        const value: CpuProfile = { vendor, model, logicalCores, instructionSets };
        // Windows probes a finite feature subset; it is useful evidence but not
        // a complete ISA list. ARM/macOS may also lack the Intel sysctls.
        return { status: platform !== "win32" && vendor && model && logicalCores && instructionSets !== null ? "complete" : "partial", value };
      } catch { return { status: "unavailable", value: null }; }
    },
    memory: localMemory,
    accelerators: async () => {
      if (platform === "linux") {
        const [pci, nvidia] = await Promise.all([linuxPciObservation(), nvidiaObservation(platform)]);
        return combineInventory(pci, nvidia);
      }
      if (platform === "win32") {
        const [snapshot, nvidia] = await Promise.all([windows(), nvidiaObservation(platform)]);
        return combineInventory(windowsAccelerators(snapshot), nvidia);
      }
      if (platform === "darwin") return macAccelerators();
      return { status: "unavailable", value: null };
    },
    backends: () => ({ status: "unavailable", value: null }),
    now: () => new Date(),
  };
}
