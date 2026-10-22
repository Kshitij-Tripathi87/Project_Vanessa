# Incident Intelligence Workflow

**ID:** incident. Composite workflow; the orchestrator remains the only durable DAG owner.

## Intended DAG
Run independent read-only repository inspection, log analysis, authorized memory retrieval and runbook retrieval concurrently. Diagnosis waits for findings. Patch preparation waits for diagnosis and applicable approvals. Regression tests wait for the patch. Deployment is excluded by default and blocked for the safe incident workflow.

## Rules
- Do not build a second scheduler inside the incident agent.
- Every worker returns actual evidence/source, not canned expected output.
- Empty memory/logs cannot inherit hardcoded findings.
- Keep patch in an isolated worktree and provide diff.
- Overall success requires real tests passing and a verified patch artifact.
- Missing key evidence means partial; never auto-deploy.

## Tests
Worker parallelism, dependency ordering, missing logs, stale memory, patch diff, intentionally failing test, no deployment and truthful partial result.