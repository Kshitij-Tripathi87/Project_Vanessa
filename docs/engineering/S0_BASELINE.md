# Vanessa S0 baseline — partial

**Status:** Partial evidence, not an S0 exit or a release/security certification.<br>
**Tested branch and commit:** `arena/c1dd05d5-project-vanessa` at `1dd201b40e762a1a210a318791a0f08d69d51aab`.<br>
**Machine-readable summary:** [S0_BASELINE.json](S0_BASELINE.json).<br>
**Planning authority:** [Vanessa Integrated Production Plan](VANESSA_INTEGRATED_PRODUCTION_PLAN.md).

The owner approved adding the plan and this report, and wants the product built and tested before any deployment decision. No hosted gateway, domain or provider has been chosen. This report does not authorize application changes, account access, paid calls, provisioning, deployment, commits, pushes or PRs.

## Repository and PR snapshot

- The working tree was clean before the documentation changes. Tests below use clean archives of the **committed** `1dd201b` tree, not uncommitted documentation.
- At the latest read-only GitHub check, `main` was `d7da0dc9c021cac8a825b94ba2155aed25cab5aa`. The GitHub comparison showed it two commits ahead of this branch, changing only `docs/engineering/INTELLIGENCE_FIRST_MODEL_RUNTIME_PLAN.md`. A remote `develop` branch was not returned. Recheck both before future integration; this branch was not switched or rebased.
- [PR #91](https://github.com/Kshitij-Tripathi87/Project_Vanessa/pull/91) is merged at `1dd201b` and provides the standalone intelligence foundation. Its probe and estimator are **not** yet wired into the existing router or loader.
- [PR #89](https://github.com/Kshitij-Tripathi87/Project_Vanessa/pull/89) is merged into `main` at `d7da0dc`, after this branch's base; it adds an intelligence design document, not runtime behavior.
- [PR #90](https://github.com/Kshitij-Tripathi87/Project_Vanessa/pull/90) is merged at `7a2bb34` into `integration/intelligence-first-architecture`, **not into current `main`** at this check. That integration branch diverges from `main` and contains overlapping intelligence files; reconcile it rather than applying it blindly.
- [PR #88](https://github.com/Kshitij-Tripathi87/Project_Vanessa/pull/88) remains open and draft. Physical Windows acceptance is a later product/release gate, not a prerequisite for the earlier synthetic intelligence-foundation slice.
- Desktop conversation, desktop voice-bridge and Android controller/ASR/TTS wiring were merged through PRs #85, #86 and #87. Their presence does not establish durable conversation, a physical voice journey or real PC-to-phone task acceptance.

## Environment and build

The latest local run used a Linux x86-64 sandbox, Node `v22.22.3` and pnpm `11.24.0`. `corepack pnpm install --frozen-lockfile --ignore-scripts` and `corepack pnpm -r run build` passed in an isolated archive. Earlier repeat runs also passed.

Lifecycle scripts were disabled, so the build is not proof that Electron, native modules or a Windows installer run locally. No Android SDK, system JDK, `adb`, PowerShell, physical Windows machine or physical Android device was available. The root desktop conversation command initially could not find a `pnpm` executable; it passed after adding a **temporary Corepack shim inside the isolated archive**, without changing the repository.

Regenerating and comparing five tracked schema/Kotlin artifacts against `1dd201b` found no drift. The frozen lockfile passed installation; its SHA-256 is recorded in the JSON. This comparison does not cover every generated artifact.

## Selected tests

These are selected suites, not the entire test inventory. Test environments were sanitized; voice tests used `scripts/test-env.mjs`, fake credentials and loopback fixtures, with no paid provider calls.

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Canonical protocol | 187 | 0 | 0 |
| Shared protocol | 3 | 0 | 0 |
| In-process usage meter | 4 | 0 | 0 |
| Intelligence foundation | 27 | 0 | 0 |
| Voice, fake providers | 41 | 0 | 0 |
| Selected remote, filesystem and safety | 58 | 0 | 3 |
| Broader regression sample | 36 | 6 | 0 |
| Launcher and readiness | 23 | 0 | 0 |
| Desktop conversation, with temporary pnpm shim | 22 | 0 | 0 |
| **Total for these invocations** | **401** | **6** | **3** |

The skipped cases were a real Windows PowerShell archive, a Windows Recycle Bin deletion and a Windows volume readback. They are not passes. The Android UI source-contract check passed, but it is not a Gradle build or emulator test.

### Regression failures

The same six failure names and counts reproduced against a fresh `e3596802d52143b62b3433ba40501b440e61bcaa` source snapshot with an identical lockfile. This establishes that they predate the PR #91 branch baseline under these conditions; it does not establish their root causes or make them acceptable for release.

1. `modelPlan.test.ts`: selectable-agent count expects 10; the catalogue contains 12.
2. `modelPlan.test.ts`: a Codex boundary assertion reaches a different unavailable-action error.
3. `plannerPrompt.test.ts`: the minimal teaching example and selectable-agent expectations differ.
4. `router.test.ts`: an expectation for an NVIDIA default conflicts with the observed Ollama default.
5. `trustworthyExecution.test.ts`: the fake-mode fixture's `basePath` is outside approved filesystem roots.
6. `voicePlanning.test.ts`: an assertion about the rendered coding-agent prompt fails.

Triage these with their owners. Do not weaken path containment, planner validation or other security behavior simply to make the tests pass.

### Reproduction outline

Run in a disposable directory, not the working tree, and do not supply real provider credentials:

```sh
snapshot=$(mktemp -d)
git archive 1dd201b40e762a1a210a318791a0f08d69d51aab | tar -x -C "$snapshot"
cd "$snapshot"
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm -r run build
mkdir -p .tool-shims
corepack enable --install-directory "$PWD/.tool-shims" pnpm
export PATH="$PWD/.tool-shims:$PATH"
# Run each selected suite in a clean environment; do not forward provider keys.
safe_env() { env -i PATH="$PATH" HOME="$HOME" CI=1 VANESSA_SKIP_DOTENV=true VANESSA_MEMORY_DB=:memory: "$@"; }
safe_env corepack pnpm --filter @vanessa/orchestrator test:intelligence
# The other exact selected-suite commands and counts are in S0_BASELINE.json;
# invoke them through safe_env as well.
```

For the fake-provider voice suite, use the `scripts/test-env.mjs` preload shown in the JSON. The earlier comparison used a clean GitHub source archive at `e359680` and the same regression command and lockfile. Raw local logs were temporary and are not retained in this repository; regenerate and archive redacted logs for a durable S0 exit record.

## CI and security boundaries

- [Agent Workflow CI on `1dd201b`](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44985644034) passed; [CI on later `main` `d7da0dc`](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/45029420309) passed. Those green jobs do not include the six failing sampled suites above.
- The separate `.github/workflows/trustworthy-execution.yml` targets `Vanessa-Prototype-1-MAIN`, not ordinary pushes/PRs to current `main`; its coverage needs reconciliation before it can be treated as a main gate.
- The [Windows installer job on the PR #91 head](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44981782916) passed. Android [foundation](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44932543189) and [emulator QA](https://github.com/Kshitij-Tripathi87/Project_Vanessa/actions/runs/44932543198) passed at the earlier `e359680` commit. None proves physical-device acceptance.
- The older `docs/codebase-audit.md` is historical. Current legacy remote command and approval routes check paired-session tokens, and unsafe `claude_code.open`, `terminal.run_command` and generic `tests.run` paths are blocked. These observations do **not** establish that all remote authorization or process paths are secure.
- In the legacy approval route, the handler checks the paired token and passes a task ID to the orchestrator. The separate v2 path verifies an action-hash-bound proof. The legacy path needs security review before remote exposure; a token check alone is not evidence of the full digest-bound approval required by the plan.
- Dependabot alerts were disabled; code-scanning and secret-scanning APIs returned 403. GitHub returned zero open issues, but the unavailable alert inventory means this is **not** evidence of zero security findings.
- The existing usage budget is in-process. Durable cross-user/provider reservations, provider freshness and the proposed 20% state machine are not established by the passing meter tests.

## Outstanding decisions and evidence

- The owner confirmed **both Android and iPhone/iOS are in product scope**, with broad phone compatibility as the goal. Current Android `minSdk` is 26; when the optional llama.cpp native build is configured, its Gradle settings restrict it to `arm64-v8a` and specify Android API 28. Neither proves compatibility on any device. No iOS app was found under `apps/`; iOS implementation, tooling, supported versions and physical devices remain unverified. Publish and physically test an OS/ABI/hardware/feature matrix for both platforms. Unsupported devices must degrade honestly without silent cloud escalation; any narrower release requires explicit approval.
- The owner supplied non-secret starting credit amounts for Sarvam, Fish Audio and ElevenLabs in conversation. Account-specific balances are deliberately not reproduced in this public repository. API eligibility, exact credit units, account scope, reset/expiry, auto-top-up and the allocation authorized for Vanessa are unknown; available credit is **not** permission to spend. No account credentials are needed for the local build.
- Tester identities/counts, clean Windows machines, actual phones, privacy/identity recovery details and full security evidence remain unknown. They do not block local fake-provider development, but applicable physical, isolation and security gates remain mandatory before an advertised beta.
- The supplied source plan labels itself prepared on 22 November 2026; that date has not been independently verified. The source's 18 December beta schedule is unconfirmed and must not replace evidence-based go/no-go.
