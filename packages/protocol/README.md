# Vanessa Protocol Package

Canonical wire contracts for Vanessa phone-to-PC communication. Protocol v2
is the authenticated remote contract; the v1 schemas remain temporarily
available for the desktop's legacy loopback gateway.

## Protocol v2

New remote code should use the v2 exports from `src/index.ts`:

- `canonicalize.ts` implements RFC 8785 JSON Canonicalization Scheme (JCS).
  Canonical UTF-8 bytes are the shared input to signatures and hashes.
- `envelope.ts` defines bounded, versioned envelopes and strict decoding.
- `messages.ts` defines the v2 message families and payload validation.
- `signatures.ts` provides P-256/ES256 signing, verification, and key IDs.

Do not extend protocol v1 or accept it on an authenticated remote listener.
The v1 exports remain available only to support the existing desktop gateway
while it migrates.

## Cross-language fixtures

Golden vectors are in `fixtures/`. They cover canonical bytes, signatures,
and valid/invalid v2 wire frames. The fixture signing key is intentionally
public and test-only; never use it in production.

```bash
npm run build
npm run fixtures
npm test
```

`npm run fixtures` reuses the fixture key and existing signatures so
regeneration is deterministic. The tests verify the generated vectors and
expected rejection cases.

## Legacy v1 artifacts

The current JSON Schema and Kotlin model generators still describe protocol v1:

- `schema/protocol-v1.schema.json`
- `apps/android/core/protocol/src/main/kotlin/` (generated locally)

They are retained for legacy consumers and are not the v2 cross-language
fixture contract. The v2 canonicalization and signature vectors are currently
the shared contract for TypeScript and Kotlin implementations.

## Contract-first rule

Change the protocol package before either client. For a v2 change, update the
schemas and tests, regenerate fixtures when their expected values change, then
verify the TypeScript implementation and cross-language vectors before enabling
network behavior.
