import assert from "node:assert/strict";
import { planner } from "../core/planner.js";
import { modelRouter } from "../core/router.js";

async function main() {
  const originalCall = modelRouter.callLLM.bind(modelRouter);
  modelRouter.callLLM = async () => null;
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "compound voice request creates OS tasks and search-only Browser task",
      run: async () => {
        const command = "Hey Vanessa, turn off Bluetooth, increase brightness to 80%, open YouTube.com, and search me a playlist";
        const plan = await planner.createPlan(command);
        const bt = plan.tasks.find((task) => task.action === "bluetooth.disable");
        const brightness = plan.tasks.find((task) => task.action === "brightness.set");
        const search = plan.tasks.find((task) => task.action === "youtube.search");
        assert.ok(bt, "Bluetooth-off action should be preserved");
        assert.equal(bt.agent, "windows");
        assert.ok(brightness, "brightness action should be preserved");
        assert.equal(brightness.agent, "windows");
        assert.equal(brightness.params.level, 80);
        assert.ok(search, "YouTube search-only action should be selected");
        assert.equal(search.agent, "browser");
        assert.equal(search.params.query, "playlist");
        assert.notEqual(search.action, "youtube.search_and_play");
        assert.deepEqual(bt.dependsOn, []);
        assert.deepEqual(brightness.dependsOn, []);
        assert.deepEqual(search.dependsOn, []);
        assert.equal(plan.intent, "multi_task");
      },
    },
    {
      name: "invalid brightness target is rejected before planner dispatch",
      run: async () => {
        await assert.rejects(
          planner.createPlan("Hey Vanessa, turn off Bluetooth, increase brightness to 1000%, and search YouTube for jazz"),
          /Brightness target must be an integer from 0 to 100/,
        );
      },
    },
    {
      name: "explicit video playback intent uses a separate verified playback action",
      run: async () => {
        const plan = await planner.createPlan("Hey Vanessa, find and play a video about Python async on YouTube");
        const play = plan.tasks.find((task) => task.action === "youtube.search_and_play");
        assert.ok(play);
        assert.equal(play.agent, "browser");
        assert.match(String(play.params.query), /Python async/i);
      },
    },
  ];
  let failures = 0;
  try {
    for (const test of cases) {
      try { await test.run(); console.log("PASS " + test.name); }
      catch (error) { failures++; console.error("FAIL " + test.name + ": " + (error instanceof Error ? error.stack || error.message : String(error))); }
    }
  } finally { modelRouter.callLLM = originalCall; }
  console.log("Compound voice plan tests: " + (cases.length - failures) + "/" + cases.length + " passed");
  process.exit(failures ? 1 : 0);
}
void main().catch((error) => { console.error(error); process.exit(1); });