# Tool Registry and Tool Execution Adapter

**Runtime ID:** `tools` (currently an alias to the shared OpenJarvis-backed VanessaAgent instance)
**Purpose:** define the boundary between specialist reasoning and typed executable tools.

## Responsibilities
- Expose registered tools with stable IDs, schemas, platform support, permissions, timeout and verification contract.
- Validate tool name and parameter schema before invoking the Python/OpenJarvis bridge or native adapter.
- Return structured execution results, including status, outputs, exit codes, artifacts, evidence and verification.
- Provide a discoverable catalog to the planner/contextualizer without granting tool access merely because a tool is visible.

## Core invariant
A tool is the smallest permissioned side-effect boundary. The model can request a tool but cannot grant itself that tool, expand parameters beyond schema, or bypass the policy layer.

## Requirements
- Maintain one source of truth for action IDs, parameter schemas and capabilities; generate prompt/catalog entries from it where practical.
- Effective allowedTools is the intersection of the registered tool, agent allowlist, task scope and policy decision.
- Never execute arbitrary shell text merely because it arrived as a tool parameter.
- Tool execution needs timeout, cancellation, idempotency classification and operation-specific verification.
- FAKE=1 responses are explicitly simulation-only and must never satisfy a live execution gate.
- Log IDs and safe summaries, not secrets, full private page contents, access tokens or raw audio.
- Unknown tools return blocked/failed; they never fall back to a broader shell capability.

## Tests
Unknown tool; schema mismatch; disallowed tool; malicious parameter; timeout; cancellation; duplicate non-idempotent call; missing verification; fake response cannot pass a live gate; bridge unavailable; cross-platform unsupported tool.