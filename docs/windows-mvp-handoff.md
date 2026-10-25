# Windows MVP: audio, brightness and Bluetooth

Baseline: `origin/feature/anshika-windows-agent` at
`04ad5ee572e136994709fae2b17ac01facd532f2` (verified after fetch).
Worktree branch: `feature/anshika-windows-agent-mvp`.
The original checkout and its broad local expansion remain untouched.

## Command batches and packaging

Keep the existing generic executor contract:

```json
{"workingDirectory":"optional existing directory","timeoutMs":30000,"steps":[{"id":"unique-step-id","command":"ordinary PowerShell code"}]}
```

`executePowerShellSteps` is internal: orchestration must apply the existing
permission guard, command/path checks and required approvals before calling it.
It runs sequential steps in one Windows PowerShell 5.1 process, preserving variables
and location within that batch; the next batch is a fresh process. Native failure,
bounded output, timeout, stop-on-failure and skipped-step reporting are unchanged.

The fixed brightness/Bluetooth PowerShell definitions live in compiled `.js` files;
the builder includes those definitions in ordinary approved command text. It does
not import `.psm1`/`.ps1` files, change execution policy, use Bypass flags, create a
service or expose an action-only API. The audio helper still uses the unchanged
baseline `Add-Type -Path` CoreAudio.cs asset and checks its cached type before load.
Build output contains all dependencies; no interactive profile or source file is
needed at runtime. The builder is callable from a different working directory.

```powershell
# From the NEW worktree root, not D:/projects/Project_Vanessa:
pnpm.cmd --filter @vanessa/shared build
pnpm.cmd --filter @vanessa/orchestrator build
node.exe services/orchestrator/scripts/generate-windows-mvp-examples.mjs
```

## Exact command construction

In the installed orchestrator, import builders relative to your installed code:

```javascript
import { executePowerShellSteps } from './agents/powershell-executor.js';
import { windowsAudioCommand } from './agents/windows-audio.js';
import { windowsControlCommand } from './agents/windows-controls.js';

// Apply existing permission/approval checks before executing any generated batch.
const request = {
  timeoutMs: 30000,
  steps: [{
    id: 'brightness-discovery',
    command: windowsControlCommand({control:'brightness', operation:'list'})
  }]
};
// const result = await executePowerShellSteps(request);
```

The **command templates** are:

| Operation | Builder inputs |
|---|---|
| Audio read | `windowsAudioCommand({operation:'get'})` |
| Output volume | `windowsAudioCommand({operation:'setVolume', volumePercent:30})` |
| Explicit mute/unmute | `windowsAudioCommand({operation:'setMute', muted:true})` / `muted:false` |
| Brightness discover | `windowsControlCommand({control:'brightness', operation:'list'})` |
| Brightness read | `windowsControlCommand({control:'brightness', operation:'get', targetId:selectedId})` |
| Brightness set | `windowsControlCommand({control:'brightness', operation:'set', targetId:selectedId, brightnessPercent:40})` |
| Bluetooth discover | `windowsControlCommand({control:'bluetooth', operation:'list'})` |
| Bluetooth read | `windowsControlCommand({control:'bluetooth', operation:'get', targetId:selectedId})` |
| Bluetooth On/Off | `windowsControlCommand({control:'bluetooth', operation:'set', targetId:selectedId, state:'On'})` / `state:'Off'` |

Audio uses the documented default multimedia playback endpoint; optionally include
`expectedDeviceId` from a previous read to reject a default-device change.
Brightness is an integer 0..100, also checked against exposed supported levels.
Bluetooth accepts only exact On/Off, never a blind toggle. Brightness/Bluetooth
may use `targetName` instead of `targetId`, but never both. If selection is omitted,
only one unambiguous suitable target is auto-selected. Duplicate friendly names
remain ambiguous. `list` has no selection. `waitMs` optionally bounds state polling
to 100..10000 ms (default 5000); separate WinRT async calls also have 5-second bounds.

[windows-mvp-examples.json](windows-mvp-examples.json) contains **11 complete valid
executor JSON examples with expanded command strings**, not pseudocode or a new
protocol. Selected-ID placeholders are illustrative; replace them with discovered
IDs. JSON examples use repository-relative `workingDirectory: services/orchestrator/dist`
and resolve the audio asset from that directory. For a production installation,
resolve the actual installed dist path in trusted host code, or use the runtime
command builder's import.meta-relative path. No developer-specific asset path is
embedded in the portable examples.

For PowerShell-side verification/capture within the same batch, reuse the fixed
definitions already present in a generated control step, then call:

```powershell
# These function calls require the generated fixed definitions earlier in the batch.
$before = Invoke-WindowsControl ([pscustomobject]@{
    control='brightness'; operation='get'; targetId=$selectedId
})
if (-not $before.success) { throw $before.error.message }
$changed = Invoke-WindowsControl ([pscustomobject]@{
    control='brightness'; operation='set'; targetId=$before.target.id; brightnessPercent=40
})
$changed | ConvertTo-Json -Depth 12 -Compress
if (-not $changed.success) { throw $changed.error.message }
```

Normal set commands **leave the requested setting in place**. There is no implicit
restore in the backend, wrapper, agent or generated command. Restore only for an
explicit undo or the manual CLI's opt-in `--test` mode.

## Results, errors and permission limits

Outer executor result: `success`, `steps` with completed/failed/skipped status,
stdout/stderr, duration/native exit and truncation evidence, `timedOut`, optional
`error`, and final working directory. Do not treat JSON stdout as success if the
outer batch/step failed, timed out or was truncated.

Control stdout includes `success`, `control`, `operation`, `requested`, `target`,
`observed`, `verification:{passed,kind,waitedMs}`, and `error`. Discovery returns
`observed.devices` with actual IDs and friendly names. Audio keeps its existing
`device`, `observed.volumePercent`, `observed.muted` and error format.

The brightness helper removes NUL characters and surrounding whitespace from WMI
names and falls back to `Brightness-capable display`, preserving exact IDs. It
rejects explicit nonzero WmiSetBrightness return codes. Some CIM providers omit
ReturnValue; absence alone is neither success nor failure: actual bounded readback
must match. Radio access and SetStateAsync must both return Allowed, followed by
actual state verification. Pairing, unpairing, headset connection, device/service
disabling and external-monitor DDC/CI are outside this focused implementation.

| Error | Orchestrator response |
|---|---|
| `invalid_input`, `unsupported_value` | Fix the value/schema; do not retry the same mutation. |
| `unsupported`, `no_device` | Explain missing hardware/interface; no synthetic success. |
| `ambiguous_target` | Present friendly candidates and retain selected ID internally. |
| `target_missing` | Rediscover; do not redirect the mutation to another device. |
| `access_denied` | Explain consent/system policy denial; do not bypass it. |
| `async_timeout`, `readback_mismatch` | Outcome unverified; inspect actual state before any retry/undo. |
| `api_failure`, `executor_failure` | Inspect evidence; failed API may have partially changed state. |

Ordinary brightness and radio operations are not globally elevated. Radio mutation
may require first-use consent, app capability/interactive context or policy support.
The noninteractive hidden executor may be unable to present consent; this is a
remaining deployment/manual validation requirement, not permission to bypass it.
Restricted execution policy permits this tested inline command path on this host;
organization controls, AppLocker/WDAC/Constrained Language or blocked Add-Type/API
access can still deny it. No universal enterprise deployment claim is made.

Existing agent aliases are wired for brightness list/get/set and Bluetooth
list/get/status/set/enable/disable. `windows.bluetooth_toggle` now requires an
explicit boolean `enabled`; it does not infer a toggle. Setter aliases require
per-task confirmation under existing permission handling, even in autonomy mode.
Planner/voice routing is unchanged; understanding and routing spoken brightness
requests is **not end-to-end tested or added by this task**.

## Manual commands: actual executor

Set location to this focused worktree, then run each command individually. These
Node CLIs use the existing executor; no module import or policy change is needed.

```powershell
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js brightness list
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js bluetooth list
```

Read selected targets using the friendly names discovered above:

```powershell
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js brightness get --name 'Brightness-capable display'
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js bluetooth get --name 'Bluetooth'
```

Individual **persistent** setting changes and readback (not run during automation):

```powershell
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js brightness set 40 --name 'Brightness-capable display'
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js brightness get --name 'Brightness-capable display'

# Bluetooth Off can disconnect Bluetooth keyboards, mice or headsets.
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js bluetooth set On --name 'Bluetooth'
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js bluetooth get --name 'Bluetooth'
```

Optional **temporary tests**: capture current value, pin exact ID, change, read back
and restore. Failed capture prevents both mutation and restoration; a partially
failed mutation still attempts restoration. Restore errors remain failures. There
is no run-all mutation command.

```powershell
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js brightness set 40 --name 'Brightness-capable display' --test
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js bluetooth set Off --name 'Bluetooth' --test
```

Print, without executing, the complete existing-format request for orchestration:

```powershell
node.exe services/orchestrator/dist/scripts/windows-controls-smoke.js brightness set 40 --name 'Brightness-capable display' --request
```

Existing audio manual commands capture an exclusive new snapshot file and reject
an existing snapshot path. Use a new filename if already present:

```powershell
node.exe services/orchestrator/dist/scripts/windows-audio-smoke.js get audio-initial-mvp.json

# Optional: changes persist until restore is explicitly run.
node.exe services/orchestrator/dist/scripts/windows-audio-smoke.js set-volume 30 audio-initial-mvp.json
node.exe services/orchestrator/dist/scripts/windows-audio-smoke.js set-mute true audio-initial-mvp.json
node.exe services/orchestrator/dist/scripts/windows-audio-smoke.js set-mute false audio-initial-mvp.json
node.exe services/orchestrator/dist/scripts/windows-audio-smoke.js restore audio-initial-mvp.json
```

Full voice -> planner -> approval UI -> execution integration remains a separate
manual test. See windows-mvp-results.md for actual automated/read-only evidence.

## Microsoft interfaces

- [WmiSetBrightness](https://learn.microsoft.com/en-us/windows/win32/wmicoreprov/wmisetbrightness-method-in-class-wmimonitorbrightnessmethods)
- [Radio access](https://learn.microsoft.com/en-us/uwp/api/windows.devices.radios.radio.requestaccessasync)
- [Radio set/state verification](https://learn.microsoft.com/en-us/uwp/api/windows.devices.radios.radio.setstateasync)
- Existing [Core Audio guide](windows-audio.md) and [executor contract](powershell-executor.md).
