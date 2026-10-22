# Cloud and Connector Agents

**IDs:** cloud and connector. Connect Gmail, Drive, messaging and future integrations through scoped adapters.

## Rules
- Use OAuth/secret storage; never expose tokens to prompts or logs.
- Distinguish draft from send, local archive from remote upload, and upload from link-sharing.
- Require approval for sending messages, external uploads/public sharing/deletion as policy requires.
- Validate recipient, folder, sharing scope and destination.
- Persist remote IDs/idempotency keys to prevent duplicates after timeout.
- Respect quotas and return provider error codes without secret payloads.

## Tests
Draft vs send, wrong recipient, expired approval, remote upload ID verification, duplicate delivery, expired token, rate limit, revocation and secret-safe logs.