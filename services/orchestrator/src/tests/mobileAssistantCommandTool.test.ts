import assert from "node:assert/strict";
import { test } from "node:test";
import { createMobileAssistantCommandTool } from "../core/mobileAssistantCommandTool.js";

test("remote assistant command is submitted to the central orchestrator with phone origin", async () => {
  let submitted: any;
  const updates: any[] = [];
  const tool = createMobileAssistantCommandTool(
    async (payload) => {
      submitted = payload;
      return {
        status: "success",
        spokenSummary: "Notepad was opened.",
        verification: { verified: true, postconditions: ["Process launch observed."], outcome: "succeeded" },
      };
    },
    async () => undefined,
    (event) => updates.push(event),
  );
  const result = await tool.handler(
    { command: "Open Notepad", language: "en-IN" },
    { signal: new AbortController().signal, taskId: "outer-task", deviceId: "paired-phone" },
  );
  assert.equal(submitted.command, "Open Notepad");
  assert.equal(submitted.language, "en-IN");
  assert.equal(submitted.source, "phone");
  assert.match(submitted.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal((result as any).spokenSummary, "Notepad was opened.");
  assert.deepEqual(updates.map((item) => item.state), ["planning", "verifying"]);
  assert.equal(updates[0].deviceId, "paired-phone");
  assert.equal(updates[0].taskId, "outer-task");
});

test("remote command verifier accepts typed failure without relabelling it as success", async () => {
  const tool = createMobileAssistantCommandTool(
    async () => ({ status: "failed", spokenSummary: "The requested action failed." }),
    async () => undefined,
  );
  assert.equal(await tool.verifier(
    { command: "try", language: "en" },
    { status: "failed", spokenSummary: "The requested action failed." },
  ), true);
  assert.equal(await tool.verifier({ command: "try" }, { status: "success" }), false);
  assert.equal(await tool.verifier({ command: "try" }, null), false);
});

test("remote command cancellation is correlated to its inner orchestrator request", async () => {
  let cancelRequestId = "";
  let rejectExecution: ((error: Error) => void) | undefined;
  const tool = createMobileAssistantCommandTool(
    () => new Promise((_resolve, reject) => { rejectExecution = reject; }),
    async (requestId) => { cancelRequestId = requestId; },
  );
  const controller = new AbortController();
  const running = tool.handler(
    { command: "Long operation" },
    { signal: controller.signal, taskId: "outer-task", deviceId: "paired-phone" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(cancelRequestId, /^[0-9a-f-]{36}$/i);
  rejectExecution?.(Object.assign(new Error("cancelled"), { code: "TASK_CANCELLED" }));
  await assert.rejects(running);
});
