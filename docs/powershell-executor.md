# Sequential Windows PowerShell executor

`executePowerShellSteps` in `services/orchestrator/src/agents/powershell-executor.ts`
is an internal execution primitive. Orchestration must apply the existing
`permissionGuard` policy to the supplied commands and obtain required approvals
**before** calling it. It does not generate commands, route intent, expose an HTTP
endpoint, elevate privileges, or change execution policy. Existing Windows-agent
handlers and `runPowerShell` are unchanged.

Commands intentionally execute as PowerShell code. JSON transport is not a
sandbox. Only trusted, policy-approved commands belong here. Commands must not
modify executor internals (`vex*` variables, `Write-VexEvent`, environment paths,
debugger breakpoints), disable error handling, or forge the result journal.

## API and orchestration responsibility

The exported function is:

```ts
executePowerShellSteps(request: PowerShellRequest): Promise<PowerShellBatchResult>

interface PowerShellRequest {
  steps: Array<{ id: string; command: string }>;
  workingDirectory?: string;
  timeoutMs?: number;
}

interface PowerShellBatchResult {
  success: boolean;
  steps: Array<{
    id: string;
    status: 'completed' | 'failed' | 'skipped';
    stdout: string;
    stderr: string;
    exitCode?: number;
    durationMs: number;
    outputTruncated?: boolean;
  }>;
  finalWorkingDirectory?: string;
  timedOut: boolean;
  error?: string;
}
```

Orchestration supplies commands, applies existing permission checks, obtains any
required approvals, and interprets the results. The executor runs the supplied
commands and returns execution evidence. It does not decide the user's intent or
whether the whole user goal has been achieved. For example, successful
`Start-Process` means Windows accepted the launch request; orchestration still
needs separate evidence to verify that the desired document was displayed.

Example inside orchestration code (after the existing permission and approval
flow has authorized every supplied command and target directory):

```ts
import { executePowerShellSteps } from '../agents/powershell-executor.js';

const result = await executePowerShellSteps({
  workingDirectory: approvedWorkingDirectory,
  timeoutMs: 30000,
  steps: [
    { id: 'change-directory', command: "Set-Location -LiteralPath './child with spaces'" },
    { id: 'read-directory', command: '(Get-Location).Path' },
  ],
});

if (!result.success) {
  // Report the failed step, stderr, skipped steps, and/or result.error.
  // Inspect result.timedOut before deciding whether retrying is appropriate.
} else {
  const observedDirectory = result.steps[1].stdout.trim();
  // Compare this execution evidence with the intended outcome.
}
```

This example assumes the directory already exists. Invalid input rejects the
promise, so callers must also handle validation/setup exceptions. No public raw
command endpoint or orchestration integration is added by this change.

Variables and location persist between steps **within one batch**. Separate
calls start fresh PowerShell processes; state does not persist between batches.

## Contract

- Windows only; one `powershell.exe` process, no profile, noninteractive, hidden.
- 1–100 ordered steps, unique nonblank IDs, nonblank commands without NUL.
- Optional existing filesystem directory; relative paths resolve against Node's
  current directory. Timeout is an integer from 100–300000 ms, default 30000 ms.
- Invalid requests and unsupported platforms reject. Runtime failures resolve to
  a structured unsuccessful batch with an optional `error` explanation.
- The fixed runner is passed using `-EncodedCommand`; the request is a UTF-8 JSON
  file in a private temporary directory. No command text is interpolated into a
  shell launch string. Steps are dot-sourced sequentially in the same scope.
- `$ErrorActionPreference = 'Stop'` is restored before every step. Cmdlet errors
  terminate the step unless command code deliberately handles or overrides them.
- `$LASTEXITCODE` resets before every step. A variable-write breakpoint remembers
  the first nonzero native exit code, even if a later executable exits zero.
  The result reports that failure code, or the last native code (including zero),
  or omits `exitCode` when no native code is available.
- First failure stops the batch; later steps are `skipped`. A started step that
  exits early or is killed is `failed`. Completed results and captured output
  survive a later failure or timeout. Duration is milliseconds.
  Native nonzero codes are evaluated at the step boundary: later statements
  inside the same command string may still execute before the batch stops.
- PowerShell output streams are captured separately from the JSON-lines result
  journal. Error records go to `stderr`; other PowerShell streams go to `stdout`.
  Output is rendered text, not typed objects or byte-exact native terminal output.
  Retention is capped at 65536 characters combined per step plus up to 4096
  characters for a terminating error. `outputTruncated` indicates that limit.
  Direct console output bypassing PowerShell streams is drained separately and
  limited to 64 KiB per batch; exceeding it fails and terminates the shell.
- `finalWorkingDirectory` is the latest location recorded by the runner; if the
  shell terminates before another event it may be the last known location.

## Timeout and cancellation limits

The whole-batch timer includes shell startup and execution, starting at process
launch. At timeout Node terminates the PowerShell process. Completion and cleanup
may take slightly longer than the deadline. This cannot undo completed effects,
guarantee termination of independently launched descendants, cancel remote work,
or interrupt every OS operation instantly. No external cancellation API is
provided. Output caps bound retained text, not allocations made inside arbitrary
commands (for example, constructing one enormous object). Shell launch errors,
nonzero shell exits, malformed journals, and missing completion events never
produce success. Temporary request/result files are removed after shell closure.

PowerShell error records, including native stderr surfaced as error records by
Windows PowerShell 5.1, conservatively fail the step. Commands can explicitly
handle their own errors, change preferences, or return misleading evidence; this
is not a security boundary. Output going directly to the process console rather
than the PowerShell pipeline counts toward the diagnostic limit but is not
included in per-step stdout/stderr.

## User-performed manual validation

The following were performed and reported by the user. These are manual results,
not automated tests run by the implementation agent:

- Working-directory persistence, including a path with spaces.
- Desktop resolution and PDF launch; the user confirmed the PDF was visible.
- Missing-file failure with the following step skipped.
- Notepad text-file workflow.
- Calculator and Settings launch.
- Windows, disk, process, battery, and network information.
- File creation, copying, renaming, reading, and ZIP creation.

The implementation agent's automated checks use temporary directories and
harmless commands only; they do not reproduce the application-launch or system
information workflows above. Permission integration and user-goal verification
remain orchestration work. There are no known blocking correctness findings for
review of this internal primitive; the limitations above still apply.

## Harmless CLI smoke example (PowerShell)

Run from the repository root. This creates only a temporary folder and request
file and executes `Set-Location` followed by `Get-Location`:

```powershell
Set-Location -LiteralPath 'D:\projects\Project_Vanessa'
$batchDir = Join-Path ([System.IO.Path]::GetTempPath()) ('vanessa-smoke-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $batchDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $batchDir 'child with spaces') | Out-Null
$requestPath = Join-Path $batchDir 'request.json'
@{
    workingDirectory = $batchDir
    timeoutMs = 30000
    steps = @(
        @{ id = 'change-directory'; command = "Set-Location -LiteralPath './child with spaces'" }
        @{ id = 'read-directory'; command = '(Get-Location).Path' }
    )
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $requestPath -Encoding UTF8
pnpm --filter @vanessa/orchestrator smoke:powershell $requestPath
```

The CLI prints the structured result as JSON and exits 0 only for success.

```powershell
# Validation and synthetic protocol tests; no real shell calls or shell mocks.
pnpm --filter @vanessa/orchestrator test:powershell
# Real powershell.exe integration tests, skipped outside Windows.
# Temporary directories, output, cmd.exe exit codes, and sleep only.
pnpm --filter @vanessa/orchestrator test:powershell:windows
```
