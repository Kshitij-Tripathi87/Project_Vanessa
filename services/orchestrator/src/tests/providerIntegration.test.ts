import assert from "node:assert/strict";
import { test } from "node:test";

// These integration checks substitute provider calls and never use local keys,
// persistent memory, application launches, or real file operations.
process.env.VANESSA_SKIP_DOTENV = "true";
process.env.VANESSA_MEMORY_DB = ":memory:";

const [{ modelRouter }, { VanessaOrchestrator }, { vanessaAgent }, { planner }, { fileAgent }, { eventBus }] = await Promise.all([
  import("../core/router.js"),
  import("../core/orchestrator.js"),
  import("../agents/openjarvis.agent.js"),
  import("../core/planner.js"),
  import("../agents/file.agent.js"),
  import("../core/eventBus.js"),
]);

function preserveProviders(): () => void {
  const names = ["PLANNER_PROVIDER", "SARVAM_CHAT_PROVIDER"] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("conversational agent reports the selected Sarvam or NVIDIA model and provider", async () => {
  const restoreProviders = preserveProviders();
  const original = modelRouter.callConversationalLLM;
  try {
    process.env.PLANNER_PROVIDER = "nvidia";
    for (const provider of ["sarvam", "nvidia"]) {
      process.env.SARVAM_CHAT_PROVIDER = provider;
      modelRouter.callConversationalLLM = async () => "A substituted conversational answer.";
      const result = await vanessaAgent.execute("vanessa.ask", { query: "What can you do?" });
      assert.equal(result.success, true);
      assert.equal(result.content, "A substituted conversational answer.");
      assert.equal(result.mode, modelRouter.conversationalModel);
      assert.equal(typeof result.mode, "string");
      assert(result.mode.length > 0);

      modelRouter.callConversationalLLM = async () => null;
      await assert.rejects(vanessaAgent.ask("Question"), new RegExp(`${provider} returned no conversational reply`));
    }
  } finally {
    modelRouter.callConversationalLLM = original;
    restoreProviders();
  }
});

test("planning failures retain diagnostics and name the selected provider", async () => {
  const restoreProviders = preserveProviders();
  const original = planner.createPlan;
  try {
    planner.createPlan = async () => { throw new Error("Substituted provider failure"); };
    const orchestrator = new VanessaOrchestrator();
    for (const provider of ["sarvam", "nvidia"]) {
      process.env.PLANNER_PROVIDER = provider;
      // The conversation setting must not override the planning error label.
      process.env.SARVAM_CHAT_PROVIDER = provider === "sarvam" ? "nvidia" : "sarvam";
      const requestId = `provider-failure-${provider}`;
      const result = await orchestrator.executeCommand({ command: "Find a report", source: "desktop", requestId });
      assert.equal(result.status, "failed");
      assert.equal(result.plan, undefined);
      assert.match(result.spokenSummary, new RegExp(`with ${provider}`));
      const audit = eventBus.getRecentEvents(500).find((event) =>
        event.type === "audit:log" && event.payload?.action === "planning.failed" && event.payload?.details?.includes(requestId));
      assert(audit);
      assert.match(audit.payload.details, new RegExp(`${provider} planning failed`));
      assert.match(audit.payload.details, /Substituted provider failure/);
    }
  } finally {
    planner.createPlan = original;
    restoreProviders();
  }
});

test("cancellation before delivery prevents provider calls and task dispatch", async () => {
  const originalCall = modelRouter.callLLM;
  const originalExecute = fileAgent.execute;
  let providerCalls = 0;
  let dispatches = 0;
  try {
    modelRouter.callLLM = async () => {
      providerCalls++;
      return JSON.stringify({ tasks: [{ agent: "files", action: "file.search", params: { query: "report" } }] });
    };
    fileAgent.execute = async () => { dispatches++; return { success: true, spokenSummary: "Substituted file handler." }; };
    const orchestrator = new VanessaOrchestrator();
    const requestId = "cancelled-before-delivery";
    orchestrator.cancelRequest(requestId);
    const result = await orchestrator.executeCommand({ command: "Find a report", source: "desktop", requestId });
    assert.equal(result.status, "failed");
    assert.equal(result.plan, undefined);
    assert.match(result.spokenSummary, /Request cancelled before execution/);
    assert.equal(providerCalls, 0);
    assert.equal(dispatches, 0);
  } finally {
    modelRouter.callLLM = originalCall;
    fileAgent.execute = originalExecute;
  }
});
