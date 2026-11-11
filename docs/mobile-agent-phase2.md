# Mobile agent PC core — Phase 2

This slice runs inside the existing orchestrator service. It does not create a second desktop app.

## Local development

The gateway is off by default. Start the orchestrator with `VANESSA_MOBILE_GATEWAY_ENABLED=true`; it binds to `127.0.0.1:4320` unless `VANESSA_MOBILE_GATEWAY_HOST` and `VANESSA_MOBILE_GATEWAY_PORT` are set. Wildcard addresses are rejected. Remote binding accepts only a Tailscale IPv4 address and additionally requires `VANESSA_MOBILE_GATEWAY_ALLOW_UNAUTHENTICATED_REMOTE=true`; keep remote binding disabled until Phase 3 pairing and message authentication are implemented.

The SQLite task and audit ledger uses `data/vanessa_mobile_agent.db` by default. Set `VANESSA_MOBILE_DB` to choose a different path. `GET /api/mobile/audit?limit=100` returns the newest redacted audit rows; the desktop audit panel hydrates from it at startup.

## Implemented

- WebSocket protocol validation, unsupported-version and unknown-type errors, 1 MiB incoming limit, per-connection-address rate limiting, and no compression.
- PC-owned tool tiers and a manifest generated from the handler registry. The phone cannot submit a tier.
- SQLite task transitions, restart recovery for interrupted work, per-client idempotency, serial UI work, parallel read-only work, abort signals, timeouts, and one retry for idempotent handlers.
- Action-hash-bound, expiring confirmation for Tier 2 work.
- Tools: `system_status` (measured CPU and memory, battery when Windows reports one), `find_file`, `open_app`, `open_url`, `open_file`, `set_volume`, `media_control`, `lock_pc`, and `delete_file` (Recycle Bin only).
- `take_screenshot` returns a scaled JPEG through the live task result; screenshot bytes are excluded from SQLite and audit storage.
- Append-only audit rows with recursively redacted arguments/results and no file contents or screenshots.

`media_control` verifies that Windows accepted the media-key injection; it cannot verify playback state. `lock_pc` verifies process launch, not the visible lock screen. Every handler reports its own verifier or a documented reason that independent readback is unavailable.

## Remaining before Phase 2 acceptance

- `take_screenshot` requires an interactive Windows desktop. The current execution environment has no valid screen handle, so its image-capture success path cannot be exercised here; the gateway test verifies it fails cleanly in this headless session, and a separate engine test verifies ephemeral results never reach disk.
- Media-key injection and session lock are implemented but not sent during validation because they would alter playback or lock the active desktop. Volume is checked by setting it back to its current observed level; Recycle Bin integration uses a disposable fixture.
- Pair and test with an Android device after Phase 3 adds device registration, message signatures, and replay protection. No physical phone is attached in this environment.

## Verification

From the repository root:

```powershell
pnpm --filter @vanessa/shared build
pnpm --filter @vanessa/orchestrator build
node --test services/orchestrator/dist/tests/mobileGateway.test.js services/orchestrator/dist/tests/mobileTaskEngine.test.js packages/shared/dist/protocol.test.js
```
