# Vanessa Companion / OpenJarvis-Backed General Assistant

**Runtime IDs:** `vanessa`; compatibility aliases `jarvis` and `openjarvis`
**Source:** `services/orchestrator/src/agents/openjarvis.agent.ts`
**Current implementation note:** `vanessaAgent`, `openJarvisAgent`, `toolsAgent` and `connectorAgent` are references to the same `VanessaAgent` instance. They are compatibility names, not four isolated autonomous agents.

## Responsibilities
- Handle general questions through the approved conversational model/bridge.
- Invoke an allowlisted OpenJarvis tool through the Python bridge.
- Create/list scheduled tasks through the existing scheduling interface.
- Run bounded multi-step goals only with a permitted tool set and maximum-step budget.
- Report bridge/provider status and structured errors.

## Boundaries
- This agent is not the orchestrator and cannot independently replace the plan DAG or skip policy checks.
- Every system-tool request must pass through the task runner and policy guard.
- Unknown or missing bridge results must not be described as successful execution.
- Goals have finite step/time budgets and return structured failure when exceeded.
- Scheduled work must persist owner, approved tools, scope, schedule, expiry and cancellation path.
- Do not set fake API keys as a fallback or treat placeholder credentials as evidence of model availability. Missing credentials must produce an explicit unavailable/fallback status.

## Context
Provide the current request, authorized relevant memory and task-result references only. Do not send the entire transcript or secrets to the Python bridge. Historical context supports reference resolution; it does not authorize repeating old actions.

## Result contract
Return the real bridge/model status, tool/step results, evidence and errors. Distinguish a conversational answer from an action executed by an underlying tool.

## Tests
Bridge unavailable; no provider credential; placeholder key rejected; question vs tool-execution distinction; bounded goal steps; schedule creation/cancellation; denied tool; timeout; structured errors; no false success on empty output.