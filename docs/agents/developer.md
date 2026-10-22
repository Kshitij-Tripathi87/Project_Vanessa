# Developer Environment Agent

**ID:** developer. Owns IDE and coding CLI launch/session lifecycle; distinct from Coding agent.

## Responsibilities
Open VS Code/project, start Claude Code or another supported CLI, pass prompt safely, collect process/session status and logs.

## Rules
- “Opened IDE” is not “built an app”.
- “Started coding CLI” is accepted/running, not completed.
- Never interpolate user prompt into shell syntax; use safe argument APIs.
- Validate explicit project root.
- Avoid admin rights and unnecessary inherited secrets.
- Headless path must execute real supported work; a “workspace prepared” string is not code generation.
- Long-running work needs progress/result handles and cancellation.

## Tests
Missing CLI, quotes/metacharacters, path validation, visible vs headless, timeout, output capture, cancellation and launch-only not completion.