import assert from "node:assert/strict";
import { test } from "node:test";
import { VanessaPlanner } from "../core/planner.js";
import { modelRouter } from "../core/router.js";

function makePlan(tasks: unknown[]) {
  return JSON.stringify({ intent: "multi_task", risk: "low", tasks });
}
const okTasks = [
  { id: "bt_off", agent: "windows", action: "bluetooth.disable", params: {}, dependsOn: [], acceptanceCriteria: ["Read back Bluetooth as Off"] },
  { id: "brightness_80", agent: "windows", action: "brightness.set", params: { level: 80 }, dependsOn: [], acceptanceCriteria: ["Read back brightness at 80%"] },
  { id: "youtube_home", agent: "browser", action: "browser.open_url", params: { url: "https://www.youtube.com/" }, dependsOn: [], acceptanceCriteria: ["Request YouTube home page navigation"] },
  { id: "playlist_search", agent: "browser", action: "youtube.search", params: { query: "playlist" }, dependsOn: ["youtube_home"], acceptanceCriteria: ["Open YouTube search results; do not claim playback"] },
];

test("plans a compound voice request across OS and Browser agents with correct dependencies", async () => {
  const originalCallLLM = modelRouter.callLLM.bind(modelRouter);
  modelRouter.callLLM = async () => makePlan(okTasks);
  try {
    const planner = new VanessaPlanner();
    const command = "Hey Vanessa, turn off Bluetooth, increase brightness to 80%, open YouTube.com, and search for a playlist.";
    const plan = await planner.createPlan(command, [], { source: "voice", language: "en", requestId: "voice-compound-test" } as any);
    assert.equal(plan.command, command);
    assert.equal(plan.intent, "multi_task");
    assert.equal(plan.tasks.length, 4);

    const byAction = new Map(plan.tasks.map((task) => [task.action, task]));
    const bluetooth = byAction.get("bluetooth.disable");
    const brightness = byAction.get("brightness.set");
    const home = byAction.get("browser.open_url");
    const search = byAction.get("youtube.search");

    assert.ok(bluetooth && brightness && home && search);
    assert.equal(bluetooth.agent, "windows");
    assert.equal(brightness.agent, "windows");
    assert.equal(brightness.params.level, 80);
    assert.equal(home.agent, "browser");
    assert.equal(home.params.url, "https://www.youtube.com/");
    assert.equal(search.agent, "browser");
    assert.equal(search.params.query, "playlist");
    assert.deepEqual(bluetooth.dependsOn, []);
    assert.deepEqual(brightness.dependsOn, []);
    assert.deepEqual(home.dependsOn, []);
    assert.deepEqual(search.dependsOn, [home.id]);
    assert.notEqual(search.action, "youtube.search_and_play", "searching a playlist must not be represented as media playback");
    assert.ok(plan.tasks.every((task) => task.status === "pending"));
    assert.ok(plan.tasks.every((task) => task.allowedTools && task.allowedTools.length > 0), "backend catalog should supply effective tool allowlists");
  } finally {
    modelRouter.callLLM = originalCallLLM;
  }
});

test("rejects an invalid brightness target before any task runs", async () => {
  const originalCallLLM = modelRouter.callLLM.bind(modelRouter);
  modelRouter.callLLM = async () => makePlan([{
    id: "brightness_bad", agent: "windows", action: "brightness.set", params: { level: 1000 },
    dependsOn: [], acceptanceCriteria: ["Set brightness"],
  }]);
  try {
    const planner = new VanessaPlanner();
    await assert.rejects(
      planner.createPlan("Increase brightness to 1000%", [], { source: "voice" } as any),
      /valid task plan|invalid plan/i,
    );
  } finally {
    modelRouter.callLLM = originalCallLLM;
  }
});