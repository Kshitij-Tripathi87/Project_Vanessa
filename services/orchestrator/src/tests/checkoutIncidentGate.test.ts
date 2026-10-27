/**
 * Deterministic checkout-incident trust gate.
 *
 * This gate intentionally does not call the LLM/voice stack, enable global
 * autonomy, or run the obsolete combined repair flow. It verifies the current
 * staged contract: diagnosis is not repair, combined repair is blocked, and
 * arbitrary test commands cannot launch a process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { IncidentAgent } from "../agents/incident.agent.js";
import { TestingAgent } from "../agents/testing.agent.js";
import { resolveManagedAction } from "../core/actionRegistry.js";

test("incident investigation reports diagnosis separately from repair and testing", async () => {
  const result = await new IncidentAgent().runFullInvestigation({});
  const data = result.data as Record<string, any>;

  assert.ok(data && typeof data === "object", "investigation must return structured data");
  assert.ok(["diagnosed", "inconclusive"].includes(data.outcome), "diagnosis must be evidence-backed or inconclusive");
  assert.equal(data.patchApplied, false, "investigation must never imply a patch was applied");
  assert.equal(data.testsPassed, false, "investigation must never imply tests ran");
  assert.equal(data.processStarted, false, "diagnostic investigation must not start a repair/test process");
  assert.equal(data.deploymentStatus, "REFUSED_PER_POLICY", "deployment remains outside this workflow");
  assert.equal(result.success, data.outcome === "diagnosed", "success may describe diagnosis only, not repair success");

  if (data.outcome === "diagnosed") {
    assert.equal(result.diagnosis?.status, "diagnosed");
    assert.ok(Array.isArray(result.evidence) && result.evidence.length >= 3, "diagnosis must retain source evidence");
    assert.equal(result.verification?.passed, true);
  } else {
    assert.equal(result.verification?.passed, false);
  }
  assert.doesNotMatch(result.summary || "", /patch applied|all (?:regression )?tests passed|repair succeeded/i);
});

test("combined auto-repair and test path is blocked before execution", async () => {
  const result = await new IncidentAgent().prepareFixAndVerify({});
  const data = result.data as Record<string, any>;

  assert.equal(result.status, "blocked");
  assert.equal(result.success, false);
  assert.equal(data.outcome, "blocked");
  assert.equal(data.patchApplied, false);
  assert.equal(data.testsPassed, false);
  assert.equal(data.processStarted, false);
  assert.equal(result.deploymentStatus, "REFUSED_PER_POLICY");
});

test("arbitrary test commands and unknown managed actions are denied", async () => {
  const params = { command: "echo pass && whoami" };
  const resolution = resolveManagedAction("testing.run_checks", params);
  assert.equal(resolution.managed, true);
  assert.equal(resolution.blocked, true);

  const result = await new TestingAgent().execute("testing.run_checks", params);
  assert.equal(result.status, "blocked");
  assert.equal(result.success, false);
  assert.equal((result.data as Record<string, any>)?.processStarted, false);

  const unknown = resolveManagedAction("testing.run_unregistered_suite", {});
  assert.equal(unknown.managed, true);
  assert.equal(unknown.blocked, true);
});
