import assert from "node:assert/strict";
import { VanessaPlanner } from "../core/planner.js";
import { modelRouter } from "../core/router.js";

async function main() {
  const originalCallLLM = modelRouter.callLLM.bind(modelRouter);
  modelRouter.callLLM = async () => null;
  const planner = new VanessaPlanner();
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "an explicit URL is routed to direct navigation",
      run: async () => {
        const target = "https://example.com/path?q=1";
        const plan = await planner.createPlan(`Please open this link: ${target}`);
        assert.equal(plan.tasks.length, 1);
        assert.equal(plan.tasks[0].agent, "browser");
        assert.equal(plan.tasks[0].action, "browser.open_url");
        assert.equal(plan.tasks[0].params.url, target);
      },
    },
    {
      name: "open YouTube means homepage, not trending search results",
      run: async () => {
        const plan = await planner.createPlan("Hey Vanessa, open YouTube");
        assert.equal(plan.tasks[0].action, "browser.open_url");
        assert.equal(plan.tasks[0].params.url, "https://www.youtube.com/");
      },
    },
    {
      name: "search YouTube means results only",
      run: async () => {
        const plan = await planner.createPlan("Open YouTube and search for lo-fi music");
        assert.equal(plan.tasks[0].action, "youtube.search");
        assert.equal(plan.tasks[0].params.query, "lo-fi music");
      },
    },
    {
      name: "finding and playing a video chooses the search-and-play action",
      run: async () => {
        const plan = await planner.createPlan("Find and play a video about Python async on YouTube");
        assert.equal(plan.tasks[0].action, "youtube.search_and_play");
        assert.match(String(plan.tasks[0].params.query), /Python async/i);
      },
    },
    {
      name: "a supplied YouTube watch link with play intent is opened directly",
      run: async () => {
        const target = "https://www.youtube.com/watch?v=abc123";
        const plan = await planner.createPlan(`Play this video: ${target}`);
        assert.equal(plan.tasks[0].action, "youtube.open_video");
        assert.equal(plan.tasks[0].params.url, target);
        assert.equal(plan.tasks[0].params.play, true);
      },
    },
  ];

  let failed = 0;
  try {
    for (const test of cases) {
      try {
        await test.run();
        console.log(`PASS ${test.name}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${test.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
    }
  } finally {
    modelRouter.callLLM = originalCallLLM;
  }
  console.log(`Browser planner routing tests: ${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
