# Agent Implementation Order and Release Gates

## P0 — Browser semantics and verification
1. Separate exact URL, web search, YouTube search, direct video open and search-and-play.
2. Add real browser state observation using Playwright or a supported CDP attachment.
3. Replace browser.read_title placeholders with observed URL/title.
4. Return partial if playback is blocked.
5. Pass browser-acceptance.md on real Windows.

Exit gate: URLs navigate directly; search is not playback; every success has page evidence.

## P0 — Contextualizer and action catalog
1. Normalize intent before planning.
2. Maintain one catalog of registered actions, param schemas, agent capabilities and allowlists.
3. Align planner prompt, registry and contracts.
4. Validate DAG, params and URL rules after model output.
5. Add voice-command routing regression tests.

Exit gate: each test utterance produces the intended registered action and target.

## P0 — Verification integrity
1. Require action-specific postconditions for side effects.
2. Missing required verifier means partial/unverified.
3. Label fake results as simulated.
4. Testing agent executes real commands and captures exit codes.
5. Terminal launch never counts as successful testing.

## P1 — Voice and lifecycle
Only committed Fish ASR turns dispatch; correlate voice/request/plan/task/TTS; separate barge-in/cancel/emergency; live Fish test separate from mocks; reconnect and duplicate-delivery tests.

## P1 — Multi-device and cross-platform
Relay auth/replay/revocation; phone-to-PC verified task; phone-local task without PC; macOS capability matrix; signed desktop build.

## Release rule
Do not add more agent count until the existing specialists satisfy their contracts. Every milestone records exact test evidence and remaining limitations.
