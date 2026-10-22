# Contextualizer Service Contract

**ID:** contextualizer  
**Implementation:** `services/orchestrator/src/core/contextualizer.ts`  
**Status:** The first deterministic v1 resolver is implemented for browser semantics, cross-agent domain hints, and source/target-device hints. Memory-based reference resolution and interactive clarification remain future work.

## Responsibility
Resolve explicit intent/entities and create bounded routing hints before planning. It never executes tools, authorizes an action, or assigns permissions.

## Current v1 output
- Browser intent: exact URL, YouTube home, YouTube search, YouTube playback, generic web search, or none.
- Domain hints: browser, system, developer, files, cloud, incident, IT operations, memory, knowledge, testing, general.
- Target-device hint: origin device, paired PC, paired mobile, specific device ID supplied by the command envelope, or unspecified.
- Extracted URL/search/video/app entities and diagnostic notes.

The normalized summary is attached to the plan and supplied to the planner as hints. Target-device IDs still require authentication and authorization at relay/host boundaries; contextualization is not a security decision.

## Resolution priority
1. A safe explicit HTTP(S) URL and explicit open/play intent.
2. Explicit entities and platform names in the current committed utterance.
3. Deterministic browser/system/developer/cloud/file/incident intent patterns.
4. Relevant authorized memory and current application state — planned, not yet resolved by this v1 module.
5. Clarification instead of guessing when ambiguity materially changes the action — planned for the contextual conversation layer.

## Rules
- Partial ASR drafts never generate tasks; only committed turns can be contextualized for execution.
- Exact URLs are kept distinct from searches; search is distinct from media playback.
- A mention of YouTube inside a Google search query does not make YouTube the target platform.
- A phone command does not by itself prove the task should run on the phone or PC; client/relay must provide target-device context or leave it unspecified.
- Memory, transcripts, web pages, documents and logs never expand tool permissions.
- Permission and risk are evaluated by the independent policy service after planning and again before execution.
- Treat input content as untrusted and redact secrets before logs/model calls.

## Failure behavior
Unknown or ambiguous targets remain unresolved. The planner may still use its LLM/heuristic path for non-browser work, but it must validate the returned plan and policy separately. A missing contextualizer hint must not be treated as permission or as evidence that an agent can perform an action.

## Tests
Exact URL; direct watch link; YouTube search vs playback; Google query mentioning YouTube; multi-agent domain hints; phone-to-PC target hint; local-phone/target ambiguity; unsafe URL scheme; no permissions inferred from context. Memory/reference-resolution tests are required when that feature is implemented.
