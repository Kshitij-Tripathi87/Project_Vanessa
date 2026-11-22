import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackendEvidence } from "../intelligence/contracts.js";
import { probeHardware } from "../intelligence/hardwareProbe.js";
import { combineInventory, localProbeEnvironment, parseLinuxCpuInfo, parseNvidiaSmiOutput, parsePciDeviceNames, parseWindowsSnapshot, windowsAccelerators } from "../intelligence/localHardwareSources.js";
import { accelerator, cohorts, cpuEvidence, gpuEvidence, MiB, profile, providersFor } from "./fixtures/intelligenceFixtures.js";

test("injects E0–E4 observations without treating cohorts as model-size guarantees", async () => {
  for (const fixture of cohorts()) {
    const seenDevices: string[] = [];
    const providers = providersFor(fixture.profile);
    const actual = await probeHardware({
      ...providers,
      backends: (devices) => {
        seenDevices.push(...devices.map((device) => device.id));
        return providers.backends(devices);
      },
    });
    assert.equal(actual.profileVersion, 1, fixture.name);
    assert.equal(actual.confidence, "complete", fixture.name);
    assert.deepEqual(actual.memory, fixture.profile.memory, fixture.name);
    assert.deepEqual(actual.accelerators, fixture.profile.accelerators, fixture.name);
    assert.deepEqual(seenDevices, fixture.profile.accelerators.map((device) => device.id), fixture.name);
    assert.deepEqual(actual.detectedBackends, fixture.profile.detectedBackends, fixture.name);
    assert.equal(actual.capturedAt, "2026-01-01T00:00:00.000Z");
  }
});

test("GPU identity, VRAM and driver alone never establish engine/backend support", async () => {
  const gpu = accelerator();
  const providers = providersFor(profile({ accelerators: [gpu] }));
  const result = await probeHardware({
    ...providers,
    backends: () => ({ status: "unavailable", value: null }),
  });
  assert.deepEqual(result.accelerators, [gpu]);
  assert.deepEqual(result.detectedBackends, []);
  assert.equal(result.probes.backends, "unavailable");
  assert.equal(result.confidence, "partial");

  const invented: BackendEvidence = { ...gpuEvidence(gpu), evidence: null };
  const noEvidence = await probeHardware({ ...providers, backends: () => ({ status: "complete", value: [invented] }) });
  assert.equal(noEvidence.backendEvidence[0].status, "unknown");
  assert.deepEqual(noEvidence.detectedBackends, []);
  assert.equal(noEvidence.probes.backends, "partial");

  const cpuOnlyEvidence = await probeHardware({ ...providers, backends: () => ({ status: "complete", value: [cpuEvidence()] }) });
  assert.deepEqual(cpuOnlyEvidence.detectedBackends, ["cpu"]);
  assert.equal(cpuOnlyEvidence.probes.backends, "partial"); // The GPU was never tested.
  assert.equal(cpuOnlyEvidence.confidence, "partial");
  const inconsistent = await probeHardware({ ...providers, backends: () => ({ status: "complete", value: [cpuEvidence(), { ...gpuEvidence(gpu), scope: "engine" }] }) });
  assert.deepEqual(inconsistent.detectedBackends, ["cpu"]);
  assert.equal(inconsistent.probes.backends, "partial");
});

test("retains only explicit engine/device evidence and rejects evidence for an unobserved device", async () => {
  const gpu = accelerator();
  const other = accelerator({ id: "not-observed" });
  const result = await probeHardware({
    ...providersFor(profile({ accelerators: [gpu] })),
    backends: () => ({ status: "complete", value: [cpuEvidence(), gpuEvidence(gpu), gpuEvidence(other)] }),
  });
  assert.deepEqual(result.detectedBackends, ["cpu", "vulkan"]);
  assert.equal(result.backendEvidence.length, 2);
  assert.equal(result.backendEvidence[1].acceleratorId, gpu.id);
  assert.equal(result.probes.backends, "partial");
  assert.equal(result.confidence, "partial");

  const conflict = await probeHardware({
    ...providersFor(profile({ accelerators: [gpu] })),
    backends: () => ({ status: "complete", value: [cpuEvidence(), gpuEvidence(gpu), { ...gpuEvidence(gpu), status: "unsupported" }] }),
  });
  assert.deepEqual(conflict.detectedBackends, ["cpu"]);
  assert.equal(conflict.backendEvidence[1].status, "unknown");
  assert.equal(conflict.probes.backends, "partial");
});

test("distinguishes absent devices from unavailable discovery and preserves unknown VRAM", async () => {
  const base = providersFor(profile());
  const none = await probeHardware(base);
  assert.deepEqual(none.accelerators, []);
  assert.equal(none.acceleratorInventory, "complete");
  const unavailable = await probeHardware({ ...base, accelerators: () => { throw new Error("sensitive local path"); } });
  assert.deepEqual(unavailable.accelerators, []);
  assert.equal(unavailable.acceleratorInventory, "unavailable");
  assert.equal(unavailable.confidence, "partial");
  assert.doesNotMatch(JSON.stringify(unavailable), /sensitive local path/);
  const gpu = accelerator({ totalMemoryBytes: null, availableMemoryBytes: null, memoryTopology: "unknown" });
  const unknown = await probeHardware({ ...base, accelerators: () => ({ status: "partial", value: [gpu] }) });
  assert.equal(unknown.accelerators[0].totalMemoryBytes, null);
  assert.equal(unknown.accelerators[0].availableMemoryBytes, null);
  assert.equal(unknown.accelerators[0].memoryTopology, "unknown");
  assert.equal(unknown.confidence, "partial");
  const partiallyObserved = await probeHardware({
    ...base,
    memory: () => ({ status: "partial", value: { totalBytes: null, availableBytes: 123 } }),
    accelerators: () => ({ status: "partial", value: [{ ...gpu, availableMemoryBytes: 456 }] }),
  });
  assert.deepEqual(partiallyObserved.memory, { totalBytes: null, availableBytes: 123 });
  assert.equal(partiallyObserved.accelerators[0].totalMemoryBytes, null);
  assert.equal(partiallyObserved.accelerators[0].availableMemoryBytes, 456);
  assert.equal(partiallyObserved.probes.memory, "partial");
});

test("invalid, contradictory or duplicate observations never become usable memory facts", async () => {
  const base = providersFor(profile());
  const duplicate = accelerator();
  const conflict = await probeHardware({
    ...base,
    memory: () => ({ status: "complete", value: { totalBytes: 100, availableBytes: 101 } }),
    accelerators: () => ({ status: "complete", value: [duplicate, { ...duplicate, availableMemoryBytes: 1 }] }),
    backends: () => ({ status: "complete", value: [gpuEvidence(duplicate)] }),
  });
  assert.deepEqual(conflict.memory, { totalBytes: 100, availableBytes: null });
  assert.deepEqual(conflict.accelerators, []);
  assert.deepEqual(conflict.detectedBackends, []);
  assert.equal(conflict.probes.memory, "partial");
  assert.equal(conflict.acceleratorInventory, "partial");
  assert.equal(conflict.probes.backends, "partial");
});

test("partial CPU facts and provider failures remain partial without leaking exception text", async () => {
  const base = providersFor(profile());
  const result = await probeHardware({
    ...base,
    cpu: () => ({ status: "complete", value: { vendor: null, model: "Observed CPU", logicalCores: 2, instructionSets: null } }),
    memory: () => { throw new Error("private detail"); },
    now: () => new Date("invalid"),
  });
  assert.equal(result.cpu.instructionSets, null);
  assert.equal(result.cpu.vendor, null);
  assert.equal(result.probes.cpu, "partial");
  assert.deepEqual(result.memory, { totalBytes: null, availableBytes: null });
  assert.equal(result.probes.memory, "unavailable");
  assert.equal(result.confidence, "partial");
  assert(!Number.isNaN(Date.parse(result.capturedAt)));
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
});

test("Linux ISA collection intersects every processor instead of guessing the first CPU", () => {
  const sample = [
    "processor : 0\nvendor_id : GenuineIntel\nmodel name : Test CPU\nflags : sse2 avx avx2",
    "processor : 1\nvendor_id : GenuineIntel\nmodel name : Test CPU\nflags : sse2 avx",
  ].join("\n\n");
  assert.deepEqual(parseLinuxCpuInfo(sample), { vendor: "GenuineIntel", model: "Test CPU", instructionSets: ["avx", "sse2"] });
  assert.equal(parseLinuxCpuInfo(sample.replace("flags : sse2 avx\n", "").replace(/flags : sse2 avx$/, "")).instructionSets, null);
  assert.deepEqual(parseLinuxCpuInfo("not cpu info"), { vendor: null, model: null, instructionSets: null });
});

test("Linux PCI model names come only from matching local vendor/device IDs", () => {
  const database = [
    "# Local database fixture",
    "1002  AMD",
    "\t73bf  Fixture Radeon",
    "\t\t1234 5678  Subsystem, not a device",
    "8086  Intel",
    "\t1234  Fixture Intel GPU",
    "C 03  Display controller class, not a vendor",
    "\t0001  Not a device",
  ].join("\n");
  const names = parsePciDeviceNames(database);
  assert.equal(names.get("0x1002:0x73bf"), "Fixture Radeon");
  assert.equal(names.get("0x8086:0x1234"), "Fixture Intel GPU");
  assert.equal(names.get("0x8086:0x0001"), undefined);
  assert.equal(names.get("0x1002:0x1234"), undefined);
});

test("NVIDIA parser preserves real free memory and refuses to infer shared/dedicated topology", () => {
  const output = [
    'GPU-abc, 00000000:01:00.0, "GPU, Fixture", 8192, 4096, 550.54',
    "GPU-def, 00000000:02:00.0, Other GPU, 16384, [N/A], [N/A]",
    "GPU-ghi, 00000000:03:00.0, Broken GPU, 100, 101, 550.54",
    "GPU-jkl, 00000000:04:00.0, Partial GPU, [N/A], 512, 550.54",
  ].join("\n");
  const result = parseNvidiaSmiOutput(output);
  assert.equal(result.complete, true);
  assert.equal(result.devices[0].id, "pci:0000:01:00.0");
  assert.equal(result.devices[0].name, "GPU, Fixture");
  assert.equal(result.devices[0].totalMemoryBytes, 8192 * MiB);
  assert.equal(result.devices[0].availableMemoryBytes, 4096 * MiB);
  assert.equal(result.devices[0].driverVersion, "550.54");
  assert.equal(result.devices[0].memoryTopology, "unknown");
  assert.equal(result.devices[1].availableMemoryBytes, null);
  assert.equal(result.devices[1].driverVersion, null);
  assert.equal(result.devices[2].availableMemoryBytes, null);
  assert.equal(result.devices[3].totalMemoryBytes, null);
  assert.equal(result.devices[3].availableMemoryBytes, 512 * MiB);
  assert.equal(parseNvidiaSmiOutput('GPU-1, "broken').complete, false);
});

test("local subprocesses do not inherit provider secrets, arbitrary search paths or UNC system roots", () => {
  const source = { SystemRoot: "\\\\remote\\share", TEMP: "C:\\Temp", OPENAI_API_KEY: "secret", NVIDIA_API_KEY: "secret", PATH: "untrusted", PSModulePath: "untrusted" };
  const windows = localProbeEnvironment("win32", source);
  assert.equal(windows.SystemRoot, "C:\\Windows");
  assert.equal(windows.TEMP, "C:\\Temp");
  assert(!JSON.stringify(windows).includes("secret"));
  assert(!JSON.stringify(windows).includes("untrusted"));
  assert(!windows.PSModulePath!.includes("remote"));
  const linux = localProbeEnvironment("linux", source);
  assert.equal(linux.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(linux.OPENAI_API_KEY, undefined);
  assert.equal(linux.NVIDIA_API_KEY, undefined);
});

test("Windows CIM fixtures preserve unknown VRAM and never merge NVIDIA devices on product name alone", () => {
  const output = JSON.stringify({
    cpu: [{ Name: "Fixture CPU", Manufacturer: "Fixture Vendor" }],
    accelerators: [{ Name: "Fixture GPU", AdapterCompatibility: "NVIDIA", DriverVersion: "1.2", PNPDeviceID: "PCI\\\\VEN_10DE", AdapterRAM: 4_294_967_295 }],
    instructionSets: ["sse2", "avx2"],
  });
  const snapshot = parseWindowsSnapshot(output);
  assert(snapshot);
  assert.deepEqual(snapshot.instructionSets, ["sse2", "avx2"]);
  const wmi = windowsAccelerators(snapshot);
  assert.equal(wmi.value![0].totalMemoryBytes, null); // AdapterRAM can be truncated.
  assert.equal(wmi.value![0].availableMemoryBytes, null);
  const nvidia = parseNvidiaSmiOutput("GPU-abc, 00000000:01:00.0, Fixture GPU, 8192, 4096, 550.54");
  const unmatched = combineInventory(wmi, { status: "complete", value: nvidia.devices });
  assert.equal(unmatched.status, "partial"); // WMI and PCI IDs cannot be correlated by name.
  assert.equal(unmatched.value!.length, 2);
  assert.equal(unmatched.value![1].id, "pci:0000:01:00.0");
  assert.equal(unmatched.value![1].availableMemoryBytes, 4096 * MiB);
  assert.equal(unmatched.value![1].memoryTopology, "unknown");

  const samePci = combineInventory({ status: "complete", value: [{ ...wmi.value![0], id: "pci:0000:01:00.0",
    totalMemoryBytes: 6_144 * MiB, availableMemoryBytes: 5_120 * MiB }] }, { status: "complete", value: nvidia.devices });
  assert.equal(samePci.status, "complete");
  assert.equal(samePci.value!.length, 1); // Exact device IDs may be correlated.
  assert.equal(samePci.value![0].totalMemoryBytes, 6_144 * MiB);
  assert.equal(samePci.value![0].availableMemoryBytes, 4_096 * MiB);

  const ambiguous = combineInventory({ status: "complete", value: [wmi.value![0], { ...wmi.value![0], id: "other-wmi" }] },
    { status: "complete", value: [nvidia.devices[0], { ...nvidia.devices[0], id: "other-pci" }] });
  assert.equal(ambiguous.status, "partial");
  assert.equal(parseWindowsSnapshot("not JSON"), null);
  assert.equal(parseWindowsSnapshot(JSON.stringify({ cpu: [], accelerators: [], instructionSets: "not a list" }))!.instructionSets, null);
});

test("the built-in local probe is safe on the current host and does not manufacture backend support", { timeout: 20_000 }, async () => {
  const result = await probeHardware();
  assert.equal(result.os, process.platform);
  assert.equal(result.architecture, process.arch);
  assert.equal(result.profileVersion, 1);
  assert.deepEqual(result.detectedBackends, []);
  assert.equal(result.probes.backends, "unavailable");
  assert.equal(result.confidence, "partial");
  assert(result.cpu.logicalCores === null || result.cpu.logicalCores > 0);
  assert(result.memory.totalBytes === null || result.memory.totalBytes > 0);
  if (result.memory.availableBytes !== null) assert(result.memory.availableBytes <= result.memory.totalBytes!);
  assert.doesNotThrow(() => JSON.stringify(result));
});
