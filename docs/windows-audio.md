# Windows playback volume and mute

This helper controls the current default **render / multimedia** endpoint using
Windows Core Audio. It reads volume and mute, sets an explicit percentage from
0 to 100, or sets an explicit boolean mute state. Setting volume does not unmute;
setting mute does not intentionally change volume. There is no toggle operation.

## Implementation and contract

- `src/agents/windows-audio/CoreAudio.cs`: .NET Framework COM interop, input
  validation, device identity checks, mutation and verified readback. HRESULTs
  are checked, Windows BOOL uses `UnmanagedType.Bool`, native float uses C#
  `float`, interface vtable order is preserved, and allocated device-ID strings
  and COM references are released. Device identity is the endpoint ID, not a
  friendly display name.
- `src/agents/windows-audio.ts`: `windowsAudioCommand(request)` supplies a command
  for an existing executor step. The command loads the C# asset with `Add-Type`,
  invokes the helper, prints structured JSON and throws on an unsuccessful
  result so the sequential executor marks the step failed and skips later steps.
  `executeWindowsAudio(request)` is the convenience wrapper around
  `executePowerShellSteps`. Helper paths are absolute, resolved relative to the
  module's `import.meta.url`, and safely quoted independently of working directory.
- `windows.agent.ts`: the existing volume-set handler now uses this wrapper and
  reports observed state or failure instead of simulated volume keys. It also
  accepts `volume.get` / `windows.volume_get` and `volume.mute` /
  `windows.volume_mute` directly. Set uses `params.level`; mute uses
  `params.muted` as an explicit boolean. No planner, voice or routing is changed.
- `scripts/copy-windows-audio.mjs`: the orchestrator build copies the C# helper
  into `dist/agents/windows-audio`, alongside the compiled TypeScript module.
- `src/scripts/windows-audio-smoke.ts`: optional manual CLI, always using the
  existing sequential executor. Saves a restore point without overwriting an
  existing file; later commands pin the expected device ID. Restore attempts
  volume and mute separately, even if volume restoration fails.

Requests:

```ts
type WindowsAudioRequest = (
  { operation: 'get' } |
  { operation: 'setVolume'; volumePercent: number } |
  { operation: 'setMute'; muted: boolean }
) & { expectedDeviceId?: string };
```

The helper returns the following JSON shape. Fields without an available value
are null. A failed setter may have changed the device, so failures attempt a
fresh observation instead of copying the requested state into the observation.

```json
{
  "success": true,
  "operation": "setVolume",
  "requested": { "volumePercent": 30 },
  "observed": { "volumePercent": 30.000001, "muted": false },
  "device": {
    "id": "<Windows endpoint ID>",
    "flow": "render",
    "role": "multimedia",
    "currentDefaultId": "<Windows endpoint ID>"
  },
  "error": null
}
```

Errors include `invalid_input`, `no_device`, `api_failure`, `device_changed`,
`readback_mismatch`, or `executor_failure`, with a message and an HRESULT when
available. On startup/compilation failure before the C# method runs, the executor
step contains the error; the TypeScript wrapper reports `executor_failure`.
Unknown request fields, numeric strings, implicit mute values, and out-of-range
percentages are rejected. Volume verification allows **0.5 percentage points**
of scalar/driver rounding. Mute must match exactly.

Device selection is checked before mutation and after readback; a changed
default or a mismatched optional `expectedDeviceId` is a failure. Observed state
belongs to `device.id`, even if it stopped being the default during the call.

## Calling from orchestration

Orchestration supplies commands, applies existing permissions/approvals first,
and interprets the execution results. The helper adds no endpoint, elevation,
policy exception or permission bypass. JSON transport is not a sandbox.

```ts
import { executePowerShellSteps } from '../agents/powershell-executor.js';
import { windowsAudioCommand } from '../agents/windows-audio.js';

// Only after the existing permission/approval flow authorizes these operations:
const batch = await executePowerShellSteps({
  steps: [
    { id: 'read-audio', command: windowsAudioCommand({ operation: 'get' }) },
    // Add a setVolume or setMute command only when authorized.
  ],
});
const audio = JSON.parse(batch.steps[0].stdout);
// Check batch.success AND audio.success; inspect observed/device/error.
```

State in PowerShell variables lasts only within one batch. Endpoint volume is
real Windows state and lasts beyond the process until changed again.

## Exact manual smoke commands (Windows PowerShell)

The commands below actually change audio when **you** run them. The automated
tests do not. Run the setup and read-only save first:

```powershell
Set-Location -LiteralPath 'D:\projects\Project_Vanessa'
$initialAudioFile = Join-Path $env:TEMP ('vanessa-initial-audio-' + [guid]::NewGuid() + '.json')
pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio get "$initialAudioFile"
if ($LASTEXITCODE -ne 0) { throw 'Could not save initial audio state; stop here.' }
Write-Host "Initial audio state saved at: $initialAudioFile"
```

Then set volume, mute, unmute, and restore. Each operation reads back and verifies
the resulting state. The `finally` block attempts restoration even if a manual
test fails:

```powershell
try {
    pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio set-volume 30 "$initialAudioFile"
    if ($LASTEXITCODE -ne 0) { throw 'Volume verification failed.' }

    pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio set-mute true "$initialAudioFile"
    if ($LASTEXITCODE -ne 0) { throw 'Mute verification failed.' }

    pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio set-mute false "$initialAudioFile"
    if ($LASTEXITCODE -ne 0) { throw 'Unmute verification failed.' }
} finally {
    pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio restore "$initialAudioFile"
    if ($LASTEXITCODE -ne 0) { Write-Warning "Restoration failed; inspect $initialAudioFile and the reported error." }
}
```

To retry restoration in a new terminal, set `$initialAudioFile` to the saved
file's full path and run the restore command again. If the default device
changed, restoration refuses to modify the replacement device. Select the
original device through Windows first, then retry. Do not overwrite the backup.

Supported CLI operations are `get <initial.json>`, `set-volume <0..100>
<initial.json>`, `set-mute <true|false> <initial.json>`, and `restore
<initial.json>`. There is no relative increase/decrease operation: choose an
explicit target percentage. For example, after saving the initial state, these
commands increase the target to 100% and then decrease it to 30%:

```powershell
pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio set-volume 100 "$initialAudioFile"
pnpm.cmd --filter @vanessa/orchestrator smoke:windows-audio set-volume 30 "$initialAudioFile"
```

## User-performed manual validation

The user reports successful mute, unmute, volume increase, and volume decrease
on their laptop. These are user-performed real-device tests, not automated
mutation tests run by the implementation agent. The supplied terminal output
also verifies initial-state saving, 30% readback, mute/unmute readback, and
restoration to the original volume and mute state on the same endpoint.

## Validation and limits

```powershell
pnpm.cmd --filter @vanessa/orchestrator test:windows-audio
pnpm.cmd --filter @vanessa/orchestrator test:powershell
pnpm.cmd --filter @vanessa/orchestrator test:powershell:windows
pnpm.cmd --filter @vanessa/orchestrator build
```

Audio mutation tests use in-memory fake devices and mocked executor calls only.
The real PowerShell test compiles the COM declarations and tests policy/readback
logic against an injected fake; it never constructs a real audio endpoint.
It also checks asset paths containing spaces/apostrophes and helper failure
propagation. A separate actual-device check was read-only. Real setter behavior
was manually validated by the user as described above; it has not been claimed
as automated testing.

This targets Windows PowerShell 5.1 and its built-in .NET Framework, including
`System.Web.Extensions` for JSON parsing. It does not load on-disk `.ps1` helper
scripts or change execution policy; it uses the executor's normal inline
commands and `Add-Type` for the C# source. If policy, constrained language,
application control, or the compiler blocks `Add-Type`/COM, it reports failure;
there is no alternate bypass or key-press fallback. No third-party executable
or new package dependency is required.

Reads are snapshots, not an atomic lock against user changes or hotplug. A
default-device switch away and back between checks can go undetected. Quantized
hardware readback outside the tolerance is an honest verification failure.
Timeout does not undo a completed audio change; explicit restoration is required.
Missing devices, inactive audio sessions/services, disconnects and permission
failures return errors. Endpoint volume reflects the Windows control, not proof
of audible playback; software-only endpoint controls may not affect exclusive
mode applications. This does not change per-app/session or capture volume.

## Microsoft references consulted

- [Default endpoint selection](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-getdefaultaudioendpoint)
- [Endpoint activation](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdevice-activate)
- [Endpoint identity and memory ownership](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdevice-getid)
- [Scalar volume signature and range](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nf-endpointvolume-iaudioendpointvolume-setmastervolumelevelscalar)
- [SetMute](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nf-endpointvolume-iaudioendpointvolume-setmute) and [GetMute](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nf-endpointvolume-iaudioendpointvolume-getmute)
- [Microsoft SDK interface/vtable declarations](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/endpointvolume.h)
- [Windows PowerShell Add-Type](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-5.1)
- [Endpoint volume and exclusive-mode limitations](https://learn.microsoft.com/en-us/windows/win32/coreaudio/endpoint-volume-controls)
