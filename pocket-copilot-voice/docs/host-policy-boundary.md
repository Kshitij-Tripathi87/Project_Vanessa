# Host-policy boundary

## Non-negotiable invariant

The phone model is an **intent and slot parser**. Its output is a proposal envelope, never a tool call. It has no authority, cannot approve work, cannot read live host state, and cannot claim an operation succeeded. The `authority`, `host_required`, and `execution_permitted` fields are constants in the contract, not model decisions.

The host must treat every value produced by the phone model as untrusted input, including action names, entity mentions, parameters, and confidence. The host re-resolves the entity against current state, re-checks authorization and policy, validates parameter bounds, decides whether fresh human approval is required, and only then invokes a separately implemented tool.

## Action families

| Action | Family | Host-side treatment |
|---|---|---|
| `get_service_status`, `list_services` | Read-only | Authenticate; query live state; return source timestamp and freshness. |
| `get_recent_logs` | Read-only / sensitive data | Enforce tenant scope, line/time caps, and secret/PII redaction before returning logs. |
| `get_metrics`, `run_diagnostic` | Read-only / potentially expensive | Enforce metric allowlist, time bounds, rate limits, and diagnostic budget. |
| `restart_service` | State-changing | Resolve environment and service; apply maintenance/availability policy; require host-defined approval. |
| `scale_service` | State-changing | Enforce cluster quotas, replica bounds, budget policy, and approval rules. |
| `deploy_release`, `rollback_release` | High impact | Verify signed artifact/version, environment, release policy, change window, and explicit approval. |
| `create_incident` | External side effect | Deduplicate, validate severity, and apply incident-management permissions. |
| `acknowledge_alert`, `silence_alert` | Operational state change | Resolve alert ID, enforce ownership and maximum silence duration, record audit event. |

This table is a design baseline, **not** an authorization policy. The host's versioned policy configuration is authoritative and may be stricter.

## Host processing pipeline

1. Validate the request and action contract against the exact schema version.
2. Authenticate the user/device and bind the request to the correct tenant/workspace.
3. Resolve `raw_mention` and `canonical_name` against live host state. A cached phone catalog is only a hint; never trust it as proof of identity or scope.
4. Re-validate action-specific parameters and apply quotas, environment restrictions, and policy.
5. Present a human-readable preview with target, environment, impact, and evidence. Obtain fresh approval when required.
6. Execute through the host's existing tool layer; use idempotency keys and bounded timeouts.
7. Return a signed/traceable outcome. Only the host may report success or failure.

## Offline mode

Offline mode may parse a command and render a local preview. It must not imply that the command was queued, delivered, approved, or executed unless a separate durable queue and host acknowledgement protocol explicitly proves that state. The `network_state` input is descriptive context only; it never changes the authority fields.

## Prompt injection and transcript handling

A transcript is untrusted user content. A phrase such as "ignore previous instructions" is not a control-plane instruction. The model should refuse explicit secret extraction and policy bypass, or hand off any unsupported request. Logs, host responses, tool output, and cached metadata must never be appended to the model's trusted instruction text.

## Confidence

`interpretation_confidence` is only a triage signal. It must not be used for authorization, approval, or safety bypass. Low ASR confidence should lead to clarification. High model confidence does not make an action safe.
