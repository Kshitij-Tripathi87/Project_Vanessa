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

## Conversation contract

`src/conversation.ts` is the independent conversation-v1 source of truth. The
build generates `schema/conversation-v1.schema.json` and Android
`core/protocol/.../conversation/ConversationModels.kt`; TypeScript and Kotlin
consume the same wire and reducer vectors in `fixtures/conversation-*`. Use the
strict `decodeConversation*` functions and Kotlin `ConversationCodec` at wire
boundaries; bare JSON parsing loses duplicate members and bare Kotlin decoding
does not enforce every schema constraint.

The contract's string limits count UTF-16 code units. JSON Schema's normal
`maxLength` counts code points, so the generated schema also supplies
`x-vanessa-minUtf16Length` and `x-vanessa-maxUtf16Length`. Generic schema
validators alone do not enforce those extensions. See
[`CONVERSATION_RUNTIME.md`](../../docs/engineering/CONVERSATION_RUNTIME.md) for
details and current integration status.

## Legacy v1 artifacts

`schema/protocol-v1.schema.json` and its generated Kotlin models remain for
legacy consumers. Their generators and fixtures are separate from the
conversation contract and the authenticated protocol-v2 fixtures.

## Contract-first rule

Change the protocol package before either client. For a v2 change, update the
schemas and tests, regenerate fixtures when their expected values change, then
verify the TypeScript implementation and cross-language vectors before enabling
network behavior.
