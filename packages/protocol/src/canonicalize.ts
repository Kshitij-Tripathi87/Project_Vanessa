/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * This is the byte-format used for every signed object in the protocol:
 * envelope signing material, the pairing challenge bytes and `actionHash`.
 * Any two implementations that produce the same JCS bytes produce the same
 * signature/hash, so the Kotlin client and the TypeScript PC must agree exactly.
 *
 * Rules implemented (RFC 8785 §3):
 * - object member names are sorted by UTF-16 code units, ascending;
 * - array order is preserved;
 * - strings are serialized with the minimal set of escapes (lone surrogates are
 *   escaped as `\uXXXX` because they cannot be encoded as UTF-8);
 * - numbers are serialized exactly as ECMAScript `Number::toString` does;
 * - whitespace is insignificant and is never emitted.
 */

/** Recursion limit. Deeper values are rejected rather than silently truncated. */
export const MAX_CANONICAL_DEPTH = 64;

/** Thrown when a value cannot be canonicalized (non-serializable type, NaN, too deep). */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

type Context = { readonly depth: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Only plain objects are JSON records. A Date, Map, typed array or class
  // instance has different (or no) serialization in a peer language, so it is
  // rejected rather than silently rendered as `{}` or an index map.
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Serialize a number using the ECMAScript `Number::toString` algorithm, which is
 * exactly what JCS mandates. `String()` on a JS number already implements it
 * (shortest round-tripping decimal, exponent form for |n| >= 1e21 or < 1e-6).
 * NaN/Infinity have no JSON representation and are rejected.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`Cannot canonicalize non-finite number: ${String(value)}`);
  }
  // Note: JCS serializes -0 as "0" (the ABNF forbids a leading minus sign
  // without a digit). String(-0) === "0", so no special case is needed.
  return String(value);
}

/** JCS string escaping. Mirrors `JSON.stringify` minus the optional escapes. */
function serializeString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    switch (codeUnit) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0c:
        out += "\\f";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      default:
        break;
    }
    if (codeUnit >= 0x20 && (codeUnit < 0xd800 || codeUnit > 0xdfff)) {
      // Printable BMP character (including the pass-through surrogate halves
      // handled below for valid pairs).
      out += value[index];
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Well-formed pair: emit the two code units as-is; UTF-8 encoding
        // turns them into the single astral code point.
        out += value[index] + value[index + 1];
        index += 1;
        continue;
      }
    }
    // Control character, or an unpaired surrogate. JCS requires `\uXXXX` with
    // lowercase hex digits.
    out += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

function write(value: unknown, context: Context, out: string): string {
  if (context.depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizationError(`Value is nested deeper than ${MAX_CANONICAL_DEPTH} levels.`);
  }
  if (value === null) return `${out}null`;

  switch (typeof value) {
    case "boolean":
      return `${out}${value ? "true" : "false"}`;
    case "number":
      return `${out}${serializeNumber(value)}`;
    case "string":
      return `${out}${serializeString(value)}`;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new CanonicalizationError(
        `Cannot canonicalize a value of type "${typeof value}"; JSON has no representation for it.`,
      );
    case "object":
      break;
    default:
      throw new CanonicalizationError(`Cannot canonicalize a value of type "${typeof value}".`);
  }

  if (Array.isArray(value)) {
    let text = `${out}[`;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) text += ",";
      // Mirror `JSON.stringify`: an `undefined` array entry serializes as
      // `null`, so an array that survives a parse/serialize round trip keeps
      // identical canonical bytes. (`undefined` object members are dropped
      // instead, which `JSON.stringify` also does.)
      const item = value[index];
      text = write(item === undefined ? null : item, { depth: context.depth + 1 }, text);
    }
    return `${text}]`;
  }

  if (!isRecord(value)) {
    throw new CanonicalizationError("Cannot canonicalize a non-plain object.");
  }

  // Default Array#sort compares UTF-16 code units, which is what JCS requires.
  const keys = Object.keys(value).sort();
  let text = `${out}{`;
  let emitted = 0;
  for (const key of keys) {
    const member = value[key];
    // `undefined` members are dropped, matching JSON.stringify; explicit `null`
    // values are kept because they are real JSON values.
    if (member === undefined) continue;
    if (emitted > 0) text += ",";
    // The member name is part of the canonical bytes: it is sorted, escaped and
    // quoted exactly like a string value.
    text += `${serializeString(key)}:`;
    text = write(member, { depth: context.depth + 1 }, text);
    emitted += 1;
  }
  return `${text}}`;
}

/**
 * Canonicalize a JSON value to its deterministic JCS text.
 *
 * Use this before hashing or signing. Do not use `JSON.stringify` for that
 * purpose: key order and number formatting would then depend on insertion
 * order and on the emitter, which breaks cross-language signatures.
 */
export function canonicalize(value: unknown): string {
  return write(value, { depth: 0 }, "");
}

/** JCS text encoded as UTF-8 bytes. This is the exact input to a signature. */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * Canonicalize text that is already JSON (a parsed object, a stored document).
 * Equivalent to `canonicalize(JSON.parse(text))` but rejects invalid JSON with
 * a CanonicalizationError instead of a SyntaxError.
 */
export function canonicalizeJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CanonicalizationError(
      `Cannot canonicalize text that is not valid JSON: ${(error as Error).message}`,
    );
  }
  return canonicalize(parsed);
}

/** True when the value can be canonicalized without throwing. */
export function isCanonicalizable(value: unknown): boolean {
  try {
    canonicalize(value);
    return true;
  } catch {
    return false;
  }
}
