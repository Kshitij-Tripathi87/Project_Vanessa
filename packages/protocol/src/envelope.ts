import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { canonicalize } from "./canonicalize.ts";
import {
  REMOTE_MESSAGE_TYPES,
  REMOTE_PROTOCOL_VERSION,
  UuidSchema,
  SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
  Base64UrlSchema,
  EpochMsSchema,
} from "./messages.ts";

/**
 * The v2 wire envelope.
 *
 * Shape (RFC 8785 order is irrelevant — canonicalization sorts keys):
 *
 *   {
 *     v, messageId, sessionId, type, sentAt, sequence, keyId,
 *     payload: { ...per-type fields... },
 *     auth: { algorithm: "ES256", signature: "<base64url DER>" }
 *   }
 *
 * The signature is computed over the canonicalized envelope with
 * `auth.signature` REMOVED but `auth.algorithm` and `keyId` kept, so the
 * algorithm and key id are authenticated and a downgrade is detectable. The
 * signature never covers itself.
 */

/** Wire size limit for one control message, including the envelope. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

/** Signature algorithm for protocol v2: ECDSA P-256 over SHA-256. */
export const SIGNATURE_ALGORITHM = "ES256" as const;

/** Highest accepted per-session sequence number (stays inside int53). */
export const MAX_SEQUENCE = 2 ** 31 - 1;

/** Session id used by handshake messages, before the PC has allocated one. */
export const PRE_SESSION_ID = "00000000-0000-0000-0000-000000000000";

/** Maximum members in a payload object before it is rejected as hostile. */
export const MAX_PAYLOAD_KEYS = 32;
export const MAX_PAYLOAD_KEY_LENGTH = 64;

export const KeyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const EnvelopeAuthSchema = z
  .object({
    algorithm: z.literal(SIGNATURE_ALGORITHM),
    signature: Base64UrlSchema.min(16).max(200),
  })
  .strict();

export const EnvelopeSchema = z
  .object({
    v: z.literal(REMOTE_PROTOCOL_VERSION),
    messageId: UuidSchema,
    sessionId: UuidSchema,
    type: z.enum(REMOTE_MESSAGE_TYPES),
    sentAt: EpochMsSchema,
    sequence: z.number().int().min(0).max(MAX_SEQUENCE),
    keyId: KeyIdSchema,
    payload: z
      .record(z.unknown())
      .refine(
        (payload) => {
          const keys = Object.keys(payload);
          return keys.length <= MAX_PAYLOAD_KEYS && keys.every((key) => key.length <= MAX_PAYLOAD_KEY_LENGTH);
        },
        { message: `payload exceeds ${MAX_PAYLOAD_KEYS} members or a ${MAX_PAYLOAD_KEY_LENGTH}-character key.` },
      ),
    auth: EnvelopeAuthSchema,
  })
  .strict();

/** An envelope as it arrives on the wire, with a signature to verify. */
export type RemoteEnvelope = z.infer<typeof EnvelopeSchema>;

/** The exact bytes that are signed: the envelope minus `auth.signature`. */
export type SignedRemoteEnvelope = Omit<RemoteEnvelope, "auth"> & { auth: { algorithm: "ES256" } };

/** Thrown when a frame exceeds `MAX_ENVELOPE_BYTES`. */
export class EnvelopeTooLargeError extends Error {
  // A plain field, not a constructor parameter property: the test suite loads
  // this module through Node's strip-only TypeScript support, which rejects
  // parameter properties (they are not erasable syntax).
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(`Envelope of ${byteLength} bytes exceeds the ${MAX_ENVELOPE_BYTES}-byte limit.`);
    this.name = "EnvelopeTooLargeError";
    this.byteLength = byteLength;
  }
}

/** Thrown when the wire bytes are not decodable JSON. */
export class MalformedEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEnvelopeError";
  }
}

/**
 * Reject JSON text containing duplicate member names.
 *
 * `JSON.parse` keeps the last occurrence, so `{"a":1,"a":2}` and `{"a":2}`
 * parse to the same object and are indistinguishable afterwards — but only one
 * of them is the byte sequence that was signed. A reviver cannot help: it runs
 * after the collapse. So the text is scanned structurally before parsing.
 *
 * The scanner accepts exactly what the JSON grammar accepts and throws only on
 * a duplicate member, a syntax error, or nesting past `MAX_DECODE_DEPTH` (which
 * the payload schemas reject anyway, and which keeps a 64 KiB frame of `[` from
 * driving recursion). Syntax correctness is re-checked by `JSON.parse`.
 */
const MAX_DECODE_DEPTH = 64;
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

type ScanState = { text: string; index: number; depth: number };

function skipDecodeWhitespace(state: ScanState): void {
  while (state.index < state.text.length && JSON_WHITESPACE.has(state.text[state.index])) state.index += 1;
}

/** Decode a JSON string literal starting at the opening quote. */
function readJsonString(state: ScanState): string {
  if (state.text[state.index] !== '"') throw new MalformedEnvelopeError("Envelope is not valid JSON.");
  state.index += 1;
  let value = "";
  while (state.index < state.text.length) {
    const char = state.text[state.index];
    if (char === '"') {
      state.index += 1;
      return value;
    }
    if (char !== "\\") {
      value += char;
      state.index += 1;
      continue;
    }
    const escape = state.text[state.index + 1];
    if (escape === undefined) throw new MalformedEnvelopeError("Envelope is not valid JSON.");
    state.index += 2;
    switch (escape) {
      case '"':
        value += '"';
        break;
      case "\\":
        value += "\\";
        break;
      case "/":
        value += "/";
        break;
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "u": {
        const hex = state.text.slice(state.index, state.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new MalformedEnvelopeError("Envelope is not valid JSON.");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        state.index += 4;
        break;
      }
      default:
        throw new MalformedEnvelopeError("Envelope is not valid JSON.");
    }
  }
  throw new MalformedEnvelopeError("Envelope is not valid JSON.");
}

/** Advance past a number, `true`, `false` or `null` token. */
function skipJsonLiteral(state: ScanState): void {
  while (state.index < state.text.length) {
    const char = state.text[state.index];
    if (char === "," || char === "}" || char === "]" || JSON_WHITESPACE.has(char)) return;
    state.index += 1;
  }
}

function skipJsonValue(state: ScanState): void {
  skipDecodeWhitespace(state);
  const char = state.text[state.index];
  if (char === undefined) throw new MalformedEnvelopeError("Envelope is not valid JSON.");
  if (char === '"') {
    readJsonString(state);
    return;
  }
  if (char === "{" || char === "[") {
    if (state.depth >= MAX_DECODE_DEPTH) throw new MalformedEnvelopeError("Envelope is nested too deeply.");
    state.depth += 1;
    if (char === "{") scanJsonObject(state);
    else scanJsonArray(state);
    state.depth -= 1;
    return;
  }
  skipJsonLiteral(state);
}

function scanJsonArray(state: ScanState): void {
  state.index += 1; // "["
  skipDecodeWhitespace(state);
  if (state.text[state.index] === "]") {
    state.index += 1;
    return;
  }
  for (;;) {
    skipJsonValue(state);
    skipDecodeWhitespace(state);
    const char = state.text[state.index];
    if (char === ",") {
      state.index += 1;
      continue;
    }
    if (char === "]") {
      state.index += 1;
      return;
    }
    throw new MalformedEnvelopeError("Envelope is not valid JSON.");
  }
}

function scanJsonObject(state: ScanState): void {
  state.index += 1; // "{"
  const members = new Set<string>();
  skipDecodeWhitespace(state);
  if (state.text[state.index] === "}") {
    state.index += 1;
    return;
  }
  for (;;) {
    skipDecodeWhitespace(state);
    const name = readJsonString(state);
    if (members.has(name)) throw new MalformedEnvelopeError(`Duplicate JSON member: ${name}`);
    members.add(name);
    skipDecodeWhitespace(state);
    if (state.text[state.index] !== ":") throw new MalformedEnvelopeError("Envelope is not valid JSON.");
    state.index += 1;
    skipJsonValue(state);
    skipDecodeWhitespace(state);
    const char = state.text[state.index];
    if (char === ",") {
      state.index += 1;
      continue;
    }
    if (char === "}") {
      state.index += 1;
      return;
    }
    throw new MalformedEnvelopeError("Envelope is not valid JSON.");
  }
}

/** Throw if `text` is not one complete JSON document with unique member names. */
function assertJsonWithoutDuplicates(text: string): void {
  const state: ScanState = { text, index: 0, depth: 0 };
  skipJsonValue(state);
  skipDecodeWhitespace(state);
  if (state.index !== text.length) throw new MalformedEnvelopeError("Envelope is not valid JSON.");
}

/** Decode wire bytes into a parsed envelope. Throws on any invalid frame. */
export function decodeRemoteEnvelope(bytes: Uint8Array): RemoteEnvelope {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new EnvelopeTooLargeError(bytes.byteLength);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MalformedEnvelopeError("Envelope is not valid UTF-8.");
  }
  if (text.length > MAX_ENVELOPE_BYTES) throw new EnvelopeTooLargeError(text.length);
  assertJsonWithoutDuplicates(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedEnvelopeError("Envelope is not valid JSON.");
  }
  return parseRemoteEnvelope(parsed);
}

/** Parse a value into an envelope. Throws a ZodError when it does not match. */
export function parseRemoteEnvelope(value: unknown): RemoteEnvelope {
  return EnvelopeSchema.parse(value);
}

/** Non-throwing envelope parse. */
export function safeParseRemoteEnvelope(
  value: unknown,
): { success: true; data: RemoteEnvelope } | { success: false; error: z.ZodError } {
  return EnvelopeSchema.safeParse(value) as { success: true; data: RemoteEnvelope } | { success: false; error: z.ZodError };
}

/** Assert the frame size before doing any work on it. */
export function assertEnvelopeSize(byteLength: number): void {
  if (byteLength > MAX_ENVELOPE_BYTES) throw new EnvelopeTooLargeError(byteLength);
}

/**
 * The object that is signed: the envelope with the signature removed but the
 * algorithm and key id retained. Returns a new object; the input is untouched.
 */
export function toSignedRemoteEnvelope(envelope: RemoteEnvelope): SignedRemoteEnvelope {
  const { signature, ...auth } = envelope.auth;
  void signature;
  return { ...envelope, auth };
}

/** Canonical bytes that `auth.signature` must be computed over. */
export function canonicalSignedRemoteEnvelope(envelope: RemoteEnvelope): string {
  return canonicalize(toSignedRemoteEnvelope(envelope));
}

export type RemoteEnvelopeSeed = {
  type: RemoteEnvelope["type"];
  payload: Record<string, unknown>;
  keyId: string;
  sessionId?: string;
  messageId?: string;
  sentAt?: number;
  sequence?: number;
};

/** Build an unsigned envelope with fresh identifiers (tests, fixtures, PC→phone). */
export function createRemoteEnvelope(seed: RemoteEnvelopeSeed): Omit<RemoteEnvelope, "auth"> {
  return {
    v: REMOTE_PROTOCOL_VERSION,
    messageId: seed.messageId ?? crypto.randomUUID(),
    sessionId: seed.sessionId ?? PRE_SESSION_ID,
    type: seed.type,
    sentAt: seed.sentAt ?? Date.now(),
    sequence: seed.sequence ?? 0,
    keyId: seed.keyId,
    payload: seed.payload,
  };
}

/** True when the version is one this package implements. */
export function isSupportedRemoteProtocolVersion(version: unknown): version is (typeof SUPPORTED_REMOTE_PROTOCOL_VERSIONS)[number] {
  return typeof version === "number" && (SUPPORTED_REMOTE_PROTOCOL_VERSIONS as readonly number[]).includes(version);
}

/** JSON Schema description of the envelope, for cross-language codegen. */
export function toEnvelopeJsonSchema(): Record<string, unknown> {
  // zod-to-json-schema cannot type-check the bounded-JSON payload union
  // (TS2589 deep instantiation), so the schema goes through `any`. Runtime
  // output is correct and is validated by the fixture round-trip tests.
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "RemoteEnvelope",
    version: REMOTE_PROTOCOL_VERSION,
    ...(zodToJsonSchema(EnvelopeSchema as unknown as Parameters<typeof zodToJsonSchema>[0], "RemoteEnvelope") as Record<
      string,
      unknown
    >),
  };
}
