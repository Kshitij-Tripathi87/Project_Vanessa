#!/usr/bin/env tsx
/**
 * YouTube Search Flow Test
 * Tests: Open Edge → Navigate to YouTube → Search for a video
 * Verifies the browser agent can actually perform real navigation
 */

import { browserAgent } from "../services/orchestrator/src/agents/browser.agent.js";
import { orchestrator } from "../services/orchestrator/src/core/orchestrator.js";
import { planner } from "../services/orchestrator/src/core/planner.js";

async function testYouTubeFlow() {
  console.log("==================================================");
  console.log("   YOUTUBE SEARCH FLOW TEST                         ");
  console.log("==================================================\n");

  // Test 1: Direct browser agent - YouTube search
  console.log("🧪 Test 1: browserAgent.youtube.search_and_play...");
  const ytRes = await browserAgent.execute("youtube.search_and_play", {
    query: "TypeScript tutorial",
  });
  console.log(`  Status: ${ytRes.status}, Success: ${ytRes.success}`);
  console.log(`  URL: ${ytRes.data?.url || ytRes.artifacts?.[0]}`);
  console.log(`  Summary: ${ytRes.summary}\n`);

  // Test 2: Direct browser agent - open_url
  console.log("🧪 Test 2: browserAgent.browser.open_url...");
  const navRes = await browserAgent.execute("browser.open_url", {
    url: "https://www.youtube.com",
  });
  console.log(`  Status: ${navRes.status}, Success: ${navRes.success}`);
  console.log(`  URL: ${navRes.data?.url || navRes.artifacts?.[0]}`);
  console.log(`  Summary: ${navRes.summary}\n`);

  // Test 3: Full orchestrator flow with YouTube
  console.log("🧪 Test 3: Orchestrator - 'open YouTube and search for a video'...");
  const res = await orchestrator.executeCommand({
    command: "open YouTube and search for a video",
    source: "desktop",
  });
  console.log(`  Status: ${res.status}`);
  console.log(`  Plan tasks: ${res.plan?.tasks?.length || 0}`);
  const ytTask = res.plan?.tasks?.find((t: any) => t.action?.includes("youtube"));
  console.log(`  YouTube task: ${ytTask?.action || "NOT FOUND"}`);
  console.log(`  Spoken: ${res.spokenSummary}\n`);

  // Test 4: Planner routes YouTube correctly
  console.log("🧪 Test 4: Planner - 'search YouTube for cats'...");
  const plan = await planner.createPlan("search YouTube for cats");
  const ytPlanTask = plan.tasks.find((t: any) => t.action?.includes("youtube"));
  console.log(`  Plan intent: ${plan.intent}`);
  console.log(`  Tasks: ${plan.tasks.length}`);
  console.log(`  YouTube task: ${ytPlanTask?.action || "NOT FOUND"}`);
  console.log(`  YouTube params: ${JSON.stringify(ytPlanTask?.params)}`);

  console.log("\n==================================================");
  console.log("   YOUTUBE FLOW TEST COMPLETE                       ");
  console.log("==================================================");
}

testYouTubeFlow().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});