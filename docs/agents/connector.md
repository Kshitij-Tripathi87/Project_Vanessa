# Connector Agent Contract

**Runtime ID:** `connector` (currently an alias to the shared OpenJarvis-backed VanessaAgent instance)
**Related specification:** `cloud-integrations.md`

## Responsibility
Provide a stable interface to external systems such as Google Drive, Gmail, messaging services, source control, ticketing, documentation and monitoring. Connector actions should be explicit, provider-scoped and typed.

## Current state
The registry maps `connectorAgent` to the same `vanessaAgent` object. Treat Connector as a compatibility routing alias, not an independently isolated agent. Real external integrations need their own adapter implementation and auth configuration before being advertised as available.

## Required adapter contract
Each connector declares:
- Provider and capability IDs.
- Authentication mechanism and scopes.
- Typed input/output schemas.
- Read vs write/external-side-effect classification.
- Rate limits and retry strategy.
- Idempotency and deduplication strategy.
- Verification method and remote artifact ID.
- Credential storage, redaction and revocation behavior.

## Safety
- Drafting an email differs from sending it; local file creation differs from Drive upload; upload differs from link-sharing/public exposure.
- Require policy approval where defined for sending, external uploads, public sharing, deletion and sensitive data transfer.
- Never store tokens in prompts, renderer/mobile bundles or logs.
- Validate recipient, destination, sharing scope and external resource IDs.
- If a provider times out after a possible side effect, reconcile status before retrying to prevent duplicates.

## Tests
Missing/expired token; revoked scope; wrong recipient/destination; approval required; rate limit; timeout after provider accepted request; deduplication; remote resource ID/link verification; secret-safe logs; unsupported connector explicitly unavailable.