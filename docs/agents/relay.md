# Relay Service Contract

**ID:** relay. Routes commands/events; it is not a planner or PC executor.

## Command envelope
Include schema version, request/task IDs, origin/target device IDs, created/expiry, idempotency key, committed command and authentication context. Server validates envelope; desktop independently checks policy before side effects.

## Reliability
Persist accepted command and sequence-numbered event metadata; support cursors/replay, heartbeat, reconnect backoff, expiry/dead-letter state and revocation. On lost acknowledgement, query task status before resubmission. Duplicate delivery cannot duplicate non-idempotent work.

## Security
TLS/WSS, short-lived scoped credentials, one-time pairing challenge, rate limits, origin validation, per-message authorization, payload limits and secret-safe logs. No generic remote shell.

## Tests
Pair/approve/revoke, invalid/expired code, wrong target, relay restart, desktop disconnect, duplicate request, cursor replay, token expiry and unauthorized command.