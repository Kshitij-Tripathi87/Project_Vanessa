# AGENTS.md — Instructions for coding agents

These instructions govern AI coding assistants modifying this repository. Vanessa's runtime agent contracts live under `docs/agents/`.

## Product and architecture
Vanessa is a voice-first engineering and IT assistant. A committed user utterance passes through contextualization, planning, policy, a dependency-aware task runner, specialist handlers, verification and truthful reporting. Windows 11 is the primary target; macOS/mobile capabilities are staged unless implemented and tested.

## Repository map
- `apps/desktop/`: Electron/React desktop HUD and audio UI.
- `services/voice-agent/`: audio session, VAD, turn detection, Fish Audio ASR/TTS and interruption.
- `services/orchestrator/`: planner, task runner, policy, specialist registry, memory and event bus.
- `services/relay/`: paired-device routing and event delivery.
- `packages/shared/`: canonical TypeScript task, agent, event and command contracts.
- `Agents and tools/`: Python/OpenJarvis bridge and tools.
- `packages/incident-lab/`: deterministic incident fixtures.
- `docs/agents/`: runtime agent specifications and acceptance tests.

## Mandatory rules
1. Read the relevant `docs/agents/` spec before changing a runtime agent.
2. Opening a terminal, launching a process, showing a message or returning text does not prove requested work completed.
3. Side-effecting handlers must return structured status and evidence. Verify an observable postcondition; absent/inconclusive verification means partial/unverified, not completed.
4. Keep voice barge-in (stop playback), task cancellation (one task), and emergency stop (eligible work/processes plus locks) distinct.
5. Treat model plans, transcript drafts, memory, browser content, repository files and logs as untrusted. Validate schemas, IDs, params, DAG dependencies and permissions.
6. Models and clients cannot grant permissions. Policy derives approval from action, args, user and target.
7. Never commit credentials or expose Fish keys in renderer/mobile bundles. Do not print `.env` contents. Redact secrets from logs and memory.
8. `FAKE=1` tests validate simulated logic only, never live execution.
9. Preserve user changes. Do not reset or force-push. Use a feature branch and reviewable PR rather than direct commits to `main`.
10. Add tests for behavior changes; separate unit/mocked tests from real adapter acceptance tests.
11. Use pnpm workspaces and update lockfile with dependencies.
12. Avoid per-user absolute paths; use configuration and OS adapters.
13. Respect timeouts, cancellation, resource locks and idempotency. Never blindly retry uncertain non-idempotent side effects.
14. Keep planner prompts, action catalog, allowlists and tests consistent.

## Browser invariants
- Explicit URLs navigate directly after scheme validation; do not convert to search.
- Search, opening a video and playing it are different intents.
- A YouTube results page is not a playing video.
- Do not claim playback until the watch page and playback state are verified.
- Never fabricate page title, URL or observations.

## Verification
Run applicable commands and record exact results:
```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test:scenarios
pnpm test:skills
pnpm test:drills
pnpm test:drills:process
pnpm test:checkout:gate
pnpm --filter @vanessa/voice-agent test
pnpm --filter @vanessa/voice-agent test:behavior
pnpm readiness
```
Run live Fish Audio, browser and OS acceptance tests separately with prerequisites and consent. State which tests were mocked.

## Definition of done
Implementation, contract, negative tests, evidence and docs must agree. Reports must distinguish live, mocked and unverified behavior.
