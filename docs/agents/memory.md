# Memory Agent Contract

**ID:** memory. Use the existing SQLite/Rust extension and Memory Palace; do not create a competing database.

## Types
Working task state, episodic tasks/incidents, semantic system facts, procedural/runbook knowledge and user preferences.

## Metadata
Owner/access scope, source reference, timestamp, freshness/expiry, sensitivity, confidence and verification status.

## Rules
- Retrieve only records authorized for the current user/project/device.
- Distinguish assertions, document claims, model inferences and verified observations.
- Redact secrets before persistence.
- Don't retain every raw transcript by default.
- Consolidate memories only from supported outcomes or approved facts.
- Support correction, deletion and retention expiry.
- If memory is down, report it when history is required; never invent a recall.

## Tests
CRUD, provenance, access isolation, redaction, stale recall, correction/delete, expiry and backend unavailable.