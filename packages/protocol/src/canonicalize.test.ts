import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CanonicalizationError,
  MAX_CANONICAL_DEPTH,
  canonicalize,
  canonicalizeJsonText,
  canonicalizeToBytes,
  isCanonicalizable,
} from "./canonicalize.ts";

/**
 * The golden vectors are the contract: if TypeScript and Kotlin disagree about
 * one byte here, every signature and action hash in the system is wrong. The
 * expected strings are hand-written in the generator, so this test checks
 * `canonicalize` against an independent opinion rather than against itself.
 */
const golden = JSON.parse(readFileSync(new URL("../fixtures/canonical-vectors.json", import.meta.url), "utf8")) as {
  version: number;
  vectors: { name: string; description: string; input: unknown; expected: string; canonical: string; sha256: string }[];
};

test("canonical-vectors.json matches the implementation byte-for-byte", () => {
  assert.equal(golden.version, 2);
  assert.ok(golden.vectors.length >= 10, "the vector set should cover the known disagreement points");
  for (const vector of golden.vectors) {
    assert.equal(canonicalize(vector.input), vector.expected, `${vector.name}: unexpected canonical text`);
    assert.equal(canonicalize(vector.input), vector.canonical, `${vector.name}: stored canonical text drifted`);
    assert.equal(
      createHash("sha256").update(vector.canonical, "utf8").digest("hex"),
      vector.sha256,
      `${vector.name}: stored digest drifted`,
    );
  }
});

test("object members are sorted by UTF-16 code units, not by locale or insertion order", () => {
  assert.equal(canonicalize({ b: 1, a: 2, C: 3 }), '{"C":3,"a":2,"b":1}');
  // "z" (U+007A) sorts before "é" (U+00E9), which sorts before "😀" (lead U+D83D).
  assert.equal(canonicalize({ "😀": 1, z: 2, "é": 3 }), '{"z":2,"é":3,"😀":1}');
  // Code-unit comparison, not code-point order: the astral key opens with the
  // surrogate U+D83D, so it sorts BEFORE U+FFFD; by code point it would be last.
  assert.equal(canonicalize({ "\u{1F600}": 1, "�": 2 }), '{"😀":1,"�":2}');
});

test("numbers follow ECMAScript Number::toString, which is what JCS mandates", () => {
  assert.equal(canonicalize([1e21, 1e-7, 1e-6, -0, 1.0, 273.15, 100]), "[1e+21,1e-7,0.000001,0,1,273.15,100]");
  assert.equal(canonicalize(9.99e20), "999000000000000000000");
  assert.equal(canonicalize(2 ** 53), "9007199254740992");
});

test("strings use the minimal escape set", () => {
  assert.equal(canonicalize("a/b"), '"a/b"'); // `/` is not escaped
  assert.equal(canonicalize('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(canonicalize("\b\f\n\r\t"), '"\\b\\f\\n\\r\\t"');
  assert.equal(canonicalize("\u0000\u001f"), '"\\u0000\\u001f"');
  // A valid surrogate pair is emitted raw; a lone surrogate is escaped.
  assert.equal(canonicalize("😀"), '"😀"');
  assert.equal(canonicalize("\ud800"), '"\\ud800"');
  assert.equal(canonicalize("a\udfffb"), '"a\\udfffb"');
});

test("undefined members are dropped; null is kept", () => {
  assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalize([undefined]), "[null]");
  assert.equal(canonicalize({}), "{}");
  assert.equal(canonicalize([]), "[]");
});

test("canonicalization is a fixed point and is independent of key insertion order", () => {
  const left = { taskId: "t", capability: "c", args: { b: 1, a: 2 } };
  const right = { args: { a: 2, b: 1 }, capability: "c", taskId: "t" };
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(canonicalize(JSON.parse(canonicalize(left))), canonicalize(left));
});

test("canonicalizeToBytes yields the exact UTF-8 signature input", () => {
  const bytes = canonicalizeToBytes({ a: "é" });
  // JCS does not escape non-ASCII: `é` is the two UTF-8 bytes C3 A9. A peer
  // that wrote `\u00e9` instead would sign different bytes.
  assert.deepEqual(Buffer.from(bytes), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0xa9, 0x22, 0x7d]));
});

test("values JSON cannot represent are rejected instead of silently coerced", () => {
  assert.throws(() => canonicalize(Number.NaN), CanonicalizationError);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), CanonicalizationError);
  assert.throws(() => canonicalize({ a: 1n }), CanonicalizationError);
  assert.throws(() => canonicalize(new Date()), CanonicalizationError);
  assert.equal(isCanonicalizable({ a: 1 }), true);
  assert.equal(isCanonicalizable({ a: Number.NaN }), false);
});

test("nesting past the depth limit is rejected rather than truncated", () => {
  let deep: unknown = "leaf";
  for (let index = 0; index < MAX_CANONICAL_DEPTH; index += 1) deep = [deep];
  assert.doesNotThrow(() => canonicalize(deep));

  let tooDeep: unknown = "leaf";
  for (let index = 0; index < MAX_CANONICAL_DEPTH + 1; index += 1) tooDeep = [tooDeep];
  assert.throws(() => canonicalize(tooDeep), CanonicalizationError);
});

test("canonicalizeJsonText reports invalid JSON as a canonicalization failure", () => {
  assert.equal(canonicalizeJsonText('{ "b" : 1 , "a" : 2 }'), '{"a":2,"b":1}');
  assert.throws(() => canonicalizeJsonText("{not json"), CanonicalizationError);
  assert.throws(() => canonicalizeJsonText(""), CanonicalizationError);
});
