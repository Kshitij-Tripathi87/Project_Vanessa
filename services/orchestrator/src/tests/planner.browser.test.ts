import assert from "node:assert/strict";
import { test } from "node:test";
import { planner } from "../core/planner.js";

test("a concrete destination is planned as browser navigation, not search", async () => {
  const plan = await planner.createPlan("Hey Vanessa, open https://example.com/docs?q=browser");
  assert.equal(plan.intent, "single_task");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].agent, "browser");
  assert.equal(plan.tasks[0].action, "browser.open_url");
  assert.equal(plan.tasks[0].params.url, "https://example.com/docs?q=browser");
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.ok(plan.tasks[0].acceptanceCriteria?.some((criterion) => /page-load verification/i.test(criterion)));
});

test("explicit Google search gets a deterministic browser.search plan", async () => {
  const plan = await planner.createPlan("Search Google for lo-fi & jazz + focus");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].agent, "browser");
  assert.equal(plan.tasks[0].action, "browser.search");
  assert.equal(plan.tasks[0].params.query, "lo-fi & jazz + focus");
});

test("YouTube search still takes the specialized direct-navigation path", async () => {
  const plan = await planner.createPlan("Hey Vanessa, open YouTube and search for rainforest sounds");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].agent, "browser");
  assert.equal(plan.tasks[0].action, "youtube.search_and_play");
  assert.equal(plan.tasks[0].params.query, "rainforest sounds");
});

test("common Windows controls bypass model guessing and use reviewed actions", async () => {
  const openExplorer = await planner.createPlan("Open File Explorer");
  assert.equal(openExplorer.tasks[0].agent, "windows");
  assert.equal(openExplorer.tasks[0].action, "app.open");
  assert.equal(openExplorer.tasks[0].params.name, "explorer");

  const bluetooth = await planner.createPlan("Turn off Bluetooth");
  assert.equal(bluetooth.tasks[0].agent, "windows");
  assert.equal(bluetooth.tasks[0].action, "bluetooth.disable");

  const brightness = await planner.createPlan("Set brightness to 60 percent");
  assert.equal(brightness.tasks[0].agent, "windows");
  assert.equal(brightness.tasks[0].action, "brightness.set");
  assert.equal(brightness.tasks[0].params.level, 60);

  const adjust = await planner.createPlan("Increase brightness");
  assert.equal(adjust.tasks[0].agent, "windows");
  assert.equal(adjust.tasks[0].action, "brightness.adjust");
  assert.equal(adjust.tasks[0].params.delta, 10);
});
