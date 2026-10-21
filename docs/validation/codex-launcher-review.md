# Codex launcher — team review handoff

Prepared 2026-10-21 from the working tree on `feature/anshika-codingAgent`, based on `9f92f1e`.

## Readiness

Ready for code review; not ready to merge until the confirmation-policy gap below is resolved. PR base: `main`. The relevant implementation and this handoff are included in the review commit; no push or PR has been created.

## Draft PR

**Title:** Add a Windows Codex CLI launcher to the developer agent

The developer agent now accepts `codex.open` with an existing `projectPath` and a non-empty `prompt`. It locates an npm-installed or native Codex CLI on PATH, checks that CLI help advertises a positional prompt, and opens a visible PowerShell terminal in the project directory.

Request values travel through environment JSON to a fixed CommonJS helper, which invokes the CLI with `shell: false`. A `--` separator keeps prompts beginning with a dash positional. The result reports only that a terminal process started; it does not verify Codex startup, prompt acceptance, or completion.

The change includes a focused test command and a manual smoke-test command. Unit tests (3/3), orchestrator TypeScript checking, and tracked diff whitespace checks pass. Live Windows terminal behavior remains unverified in this review pass.

## Proposed review scope

- `services/orchestrator/package.json`: `test:codex` and `smoke:codex` commands.
- `services/orchestrator/src/agents/developer.agent.ts`: action dispatch.
- `services/orchestrator/src/agents/codex-launcher.ts`: validation, CLI discovery, help check, terminal launch.
- `services/orchestrator/src/agents/codex-terminal.cjs`: shell-free invocation with inherited terminal I/O.
- `services/orchestrator/src/scripts/codex-smoke.ts`: manual launcher entry point.
- `services/orchestrator/src/tests/codexLauncher.test.ts`: invalid input, failures, and argument preservation.
- This handoff document.

Several implementation files are currently untracked: include them explicitly when preparing a commit. Keep the unrelated untracked `.idea/` editor files out of the review.

## Findings and decisions

1. **P1 — Codex launch bypasses the existing explicit confirmation policy.** `services/orchestrator/src/core/permissionGuard.ts` lists `claude_code.open` and `terminal.run_command` as confirmation-required actions, but omits `codex.open`. A low- or medium-risk task using the new action therefore falls through to `allowed`, although its prompt can ask the external agent to change files or run commands. Add `codex.open` to that policy and verify that low/medium-risk launches require confirmation, including with global autonomy enabled. The launcher correctly avoids shell interpolation; that does not replace approval of the requested coding task.

2. **Planner integration is incomplete.** `services/orchestrator/src/core/planner.ts` advertises Claude Code but not `codex.open`; its heuristic branch also only handles Claude requests. `services/orchestrator/src/schemas/task.schema.ts` has no Codex entry. Decide whether this PR intentionally exposes only a direct developer-agent API. If voice/planner routing is intended, add action documentation, required parameters, routing, and a planning regression check. The schema table currently has no consumers in `src`, so its omission alone is not evidence that execution is blocked.

3. **Built output depends on the source tree.** TypeScript compilation does not copy `codex-terminal.cjs` into `dist`. The launcher falls back to `src/agents/codex-terminal.cjs`, which works only when that source file ships alongside the build. A dist-only distribution will fail with “Codex terminal helper is missing.” Confirm the deployment layout or copy the helper as part of the build before supporting dist-only deployment.

## Validation evidence

From the repository root:

```powershell
& 'C:\Program Files\nodejs\node.exe' node_modules/typescript/bin/tsc --noEmit -p services/orchestrator/tsconfig.json
git diff --check
```

Both exited 0. The whitespace check covered the tracked diff, not the untracked implementation files.

From `services/orchestrator`:

```powershell
& 'C:\Program Files\nodejs\node.exe' node_modules/tsx/dist/cli.mjs --test src/tests/codexLauncher.test.ts
```

Passed 3 tests, 0 failed. Tests stub filesystem/CLI/terminal dependencies and exercise the helper in a VM; they do not launch a real CLI or terminal. Initial `.cmd` invocations failed because Node was absent from this shell's PATH; the installed executable above completed the checks successfully.

## Remaining acceptance checks

- Resolve the confirmation-policy finding and run a regression check against `PermissionGuard.check`.
- On Windows with Node, pnpm, and a supported Codex installation on PATH, run `pnpm --filter @vanessa/orchestrator smoke:codex "D:\path\to\test-project"`. This opens a visible terminal and submits the default read-only prompt; any CLI authentication or approval prompts still need handling there.
- Inspect the terminal to confirm the requested directory and prompt reached Codex. A successful JSON result alone is insufficient evidence.
- Repeat with a project path containing spaces and a prompt containing quotes/newlines; verify those values remain literal.
- Validate the intended built/deployed layout, including helper availability.

## Reverting

Remove the `codex.open` dispatch/import, the two package scripts, and the four new implementation/test files to remove this feature. The implementation adds no dependencies or database migrations. An already opened terminal must be closed separately.
