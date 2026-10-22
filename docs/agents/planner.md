# Planner Agent Contract

**ID:** planner. The planner exists; this defines the required behavior.

## Responsibility
Convert a contextualized request into the smallest dependency-aware task DAG using registered actions. Planning decides what work is needed, not how an OS side effect is performed.

## Inputs and output
Inputs: committed request, normalized context, target device, registered agent/action catalog and authorized relevant memory.
Output: plan ID, intent/risk, unique tasks, registered agent/action IDs, schema-valid parameters, dependencies, requested tools, acceptance criteria, timeout and idempotency.

## Rules
- Preserve exact URL; do not convert it into search.
- Distinguish browser.open_url, browser.search, youtube.search, youtube.open_video and youtube.search_and_play.
- Search is not playback; results page must not be reported as playing.
- Reject unknown agents/actions, invalid parameters, duplicate IDs, dangling dependencies and cycles.
- Policy derives permissions independently; the model cannot assign them.
- Do not replay past actions just because they appear in history.
- Clarify if ambiguity changes the outcome.

## Failure behavior
Use deterministic fallback only for supported patterns. Otherwise ask or report inability; never silently select a different action.

## Tests
Exact URL preservation, YouTube search/play distinction, invalid action, cycle, duplicate IDs, missing dependency, stale-history replay and ambiguity.