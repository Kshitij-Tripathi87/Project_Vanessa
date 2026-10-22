# OpenJarvis and Python Bridge Adapter

**IDs:** openjarvis, Python bridge and compatible Vanessa tool adapters.

## Responsibility
Expose approved Python/OpenJarvis tools and Rust/SQLite memory capabilities to the TypeScript orchestrator through a versioned boundary.

## Rules
- Validate request/response schemas in both processes.
- Return structured status, output, errors, artifacts and verification; never flatten exceptions into success.
- Enforce policy before tool invocation.
- Use timeouts and terminate child work when cancellation is supported.
- Route memory through one documented service; avoid competing stores.
- If daemon is offline, return failed/blocked with health detail.
- Redact sensitive content crossing process boundaries.

## Tests
Bridge offline, schema mismatch, tool denial, Python exception, timeout, memory roundtrip, native backend unavailable and no success from stub output.