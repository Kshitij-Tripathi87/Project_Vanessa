# Focused Windows MVP result

## Baseline and preservation

- Origin: https://github.com/Kshitij-Tripathi87/Project_Vanessa.git
- Fetched feature baseline: **04ad5ee572e136994709fae2b17ac01facd532f2**,
  `feat: add verified Windows Core Audio volume and mute control`.
- Remote feature branch did not advance beyond the requested baseline. Fetch also
  updated unrelated tracking refs, but none were merged into this work.
- Original checkout: `D:/projects/Project_Vanessa`, still on
  `feature/anshika-windows-agent`, with the broad local expansion and `.idea` intact.
- New attached worktree:
  `C:/Users/Lenovo/.codex/worktrees/windows-agent-mvp/Project_Vanessa`.
- New branch: **feature/anshika-windows-agent-mvp**, starting at the fetched feature
  baseline. Publication of the focused changes was subsequently authorized by the user.
- Original status and SHA-256 hashes of all **30** pre-existing modified/untracked
  files were captured before worktree creation and compared afterward: **unchanged**.
  See windows-mvp-preservation.json. No stash, reset, clean or file deletion was used.
- No force-push, main/prototype merge, destructive cleanup or history rewrite.
  Commit/push and a focused draft PR were subsequently requested by the user.

## Already working versus added

The baseline already had the generic sequential executor and verified multimedia
playback volume/mute helper, plus its manual capture/restore CLI and CoreAudio.cs
packaging. These files are byte-for-byte unchanged against the baseline, as are
the lockfile and audio asset copy script. Same-batch variables/location,
stop-on-failure, skipped steps, timeout, native failures and bounded output remain.

Added only built-in-display brightness and Bluetooth radio list/get/explicit set,
target selection, input validation, actual readback and honest errors. Brightness
reuses the investigated missing-CIM-return-value fix and NUL-cleaned friendly-name
fallback. Bluetooth uses documented WinRT Radio APIs with access checks and bounded
async/state waits. Baseline Bluetooth's simulated/synthetic-success implementation
was replaced. Audio, file/app, screenshot, Wi-Fi and planner/voice code paths remain
unchanged (including their pre-existing limitations).

New aliases integrate these controls into WindowsAgent with existing setter
approval checks. This is handler-level integration, not a completed voice/planner
feature. Normal setters persist; only the manual CLI's explicit --test mode restores.
No 122-recipe catalog, PowerShell module import, new service/LLM/protocol or new
runtime dependency was introduced.

## Commands actually run and results

From the new worktree:

```powershell
pnpm.cmd install --frozen-lockfile --ignore-scripts
pnpm.cmd --filter @vanessa/shared build
pnpm.cmd --filter @vanessa/orchestrator build
pnpm.cmd --filter @vanessa/orchestrator exec tsx --test src/tests/powershellExecutor.test.ts src/tests/powershellExecutor.windows.test.ts src/tests/windowsAudio.test.ts src/tests/windowsControls.test.ts
node.exe services/orchestrator/scripts/generate-windows-mvp-examples.mjs
git diff --check
```

- Dependency installation uses existing locked dependencies; no package or lockfile
  upgrades. The initial offline attempt lacked cached tarballs; online frozen
  installation completed. Lifecycle scripts were not run.
- Shared and orchestrator TypeScript builds: **passed**. Required definitions are
  embedded in built JS. Baseline CoreAudio.cs is copied by the existing build step.
- Combined tests: **25 passed, 0 failed, 0 skipped**, approximately 20.6 seconds.
- All **11** expanded JSON example commands separately parsed in real Windows
  PowerShell **5.1.26100.9711**. No example mutation was executed.
- Whitespace/diff check: passed (ordinary Git LF/CRLF notices only).

### Automated/mocked coverage

Baseline executor and audio regressions pass. Focused tests cover malformed input,
brightness ranges/levels, boolean/type validation, unknown fields, missing and
ambiguous hardware, stale IDs, denied permission, API/async failures, transient
disappearance, state mismatch/timeout, clean/missing/NUL-only display names with
preserved IDs, absent/null/zero/nonzero CIM returns, restoration after a partial
failure, no restoration after failed capture, normal setter persistence, per-task
approval, and invalid/truncated/interrupted JSON wrapper results.

Actual brightness backend and controller are exercised with all CIM functions
mocked. Actual radio setter logic is exercised with access/radio/set wrappers
mocked. No simulated device result is presented as a live hardware mutation test.

### Actual read-only executor and packaging checks

A temporary isolated installation contains only copied dist helpers/runner and
CoreAudio.cs (no src, node_modules or profile). A fresh Node child removes the
interactive shell's PSExecutionPolicyPreference and PSModulePath environment
variables before invoking the **unchanged actual executor**. Native Windows
PowerShell default paths/policy apply. No policy value is set, no Bypass flag is
added, and machine/user policy remains effective.

Two fresh batches, each from another working directory, successfully ran:
environment readback, brightness discovery, Bluetooth discovery, repeated brightness
discovery, baseline audio read, and repeated audio read/type reuse.

- Effective execution policy: **Restricted**.
- Supported brightness displays: **1**; friendly fallback is readable, state read 90%.
- Bluetooth radios: **1**, observed On.
- Default multimedia playback endpoint: successfully read in both batches.

An initial diagnostic test inherited a PowerShell 7 module search path, causing
Windows PowerShell's Get-ExecutionPolicy module autoload to fail. The fresh-process
fixture removes that terminal-specific environment rather than changing production
executor behavior or policy. Direct new CLI read-only discovery also succeeded
from this development environment. Production launchers should avoid injecting an
incompatible module path; this task deliberately preserves the baseline executor.

## User-supplied manual verification after implementation

The user ran the built MVP CLI through the actual executor and supplied its output:

- Brightness discovery found the supported display at 90%; a normal set to 40%
  returned verified readback, and a separate get still returned 40%.
- Bluetooth discovery returned On; explicit set On succeeded and a separate get
  confirmed On. This verifies an already-On request, not an Off-to-On transition.
- Baseline audio read/capture returned approximately 40%, unmuted. The user's
  local audio-initial-mvp.json snapshot is not a source artifact and is not committed.
- No permission errors appeared in these supplied manual results. They are user-run
  evidence, separate from automated tests. Full orchestration integration remains pending.

## Not tested / deployment limits

- No live volume/mute, brightness or radio changes were executed by the automated
  implementation/test run. The user later verified MVP brightness and an already-On
  radio request as described above. Audio mutations and radio Off/On transitions
  remain unverified in the MVP. Earlier expansion tests are not counted as MVP evidence.
- Bluetooth first-use consent/capability restrictions and real state changes remain
  manual. Hidden/noninteractive execution may not be able to show required consent;
  return access_denied rather than inventing success or disabling a device/service.
- Restricted-policy inline execution passed on this host. Organization controls,
  constrained language, blocked Add-Type/WinRT or missing drivers can still prevent
  it; no enterprise deployment guarantee or policy bypass is claimed.
- Full voice -> planner -> approval UI -> executor integration was **not tested**.
  Planner/voice routing remains unchanged. Raw commands are trusted approved code,
  not a sandbox; internal helpers do not replace the existing permission guard.

## Files changed

Modified: services/orchestrator/package.json (two focused scripts),
src/agents/windows.agent.ts (focused handler aliases and removal of old Bluetooth
fallback), src/core/permissionGuard.ts (focused setter approvals).

Added under services/orchestrator: src/agents/windows-controls.ts,
windows-controls-backend.ts, windows-controls-controller.ts;
src/scripts/windows-controls-smoke.ts; src/tests/windowsControls.test.ts;
scripts/generate-windows-mvp-examples.mjs.

Added docs: windows-mvp-handoff.md, windows-mvp-examples.json,
windows-mvp-checklist.md, windows-mvp-results.md, windows-mvp-preservation.json.

See **windows-mvp-handoff.md** for exact next read-only, persistent-change and
optional capture/restore manual commands through the real executor.
