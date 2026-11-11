import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ProtocolMessageSchema, toJsonSchema } from "./protocol.js";

describe("versioned mobile/desktop protocol", () => {
  it("accepts a valid task submission and rejects unknown fields", () => {
    const base = { v: 1, id: "39ea70e2-5374-45c8-99fb-83fb0b972ac2", type: "task.submit", idempotencyKey: "phone:request-1", tool: "open_app", args: { app: "chrome" }, createdAt: Date.now() };
    assert.equal(ProtocolMessageSchema.safeParse(base).success, true);
    assert.equal(ProtocolMessageSchema.safeParse({ ...base, tier: 0 }).success, false);
  });

  it("emits a JSON Schema with all protocol message variants", () => {
    const schema = toJsonSchema();
    assert.equal(schema.title, "VanessaProtocolMessage");
    assert.ok(JSON.stringify(schema).includes("task.confirm_required"));
  });

  it("parses and serializes every shared wire fixture", async () => {
    const source = await readFile(new URL("../fixtures/protocol-v1.jsonl", import.meta.url), "utf8");
    const fixtures = source.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
    assert.equal(fixtures.length, 11);
    for (const fixture of fixtures) {
      const parsed = ProtocolMessageSchema.parse(fixture);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), fixture);
    }
  });
});
