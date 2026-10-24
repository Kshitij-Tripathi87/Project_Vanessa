import { playwrightBrowserAgent } from "../agents/browser-playwright.agent.js";

async function testPlaywright() {
  console.log("=== PLAYWRIGHT BROWSER AGENT TESTS ===\n");

  // Test 1: Basic navigation
  console.log("🧪 Test 1: Navigate to google.com");
  const navResult = await playwrightBrowserAgent.navigate("https://www.google.com");
  console.log(`  Success: ${navResult.success}`);
  console.log(`  Title: "${navResult.title}"`);
  console.log(`  URL: ${navResult.url}`);
  if (!navResult.success) {
    console.error(`  Error: ${navResult.error}`);
    process.exit(1);
  }

  // Test 2: Search
  console.log("\n🧪 Test 2: Search for 'TypeScript tutorial'");
  const searchResult = await playwrightBrowserAgent.search("TypeScript tutorial");
  console.log(`  Success: ${searchResult.success}`);
  console.log(`  URL: ${searchResult.url}`);
  console.log(`  Snippets found: ${searchResult.snippets.length}`);
  if (searchResult.snippets.length > 0) {
    console.log(`  First snippet: "${searchResult.snippets[0].substring(0, 100)}..."`);
  }
  if (!searchResult.success) {
    console.error(`  Error: ${searchResult.error}`);
    process.exit(1);
  }

  // Test 3: YouTube navigation
  console.log("\n🧪 Test 3: Navigate to YouTube search");
  const ytResult = await playwrightBrowserAgent.navigate("https://www.youtube.com/results?search_query=TypeScript+tutorial");
  console.log(`  Success: ${ytResult.success}`);
  console.log(`  Title: "${ytResult.title}"`);
  console.log(`  URL: ${ytResult.url}`);
  if (!ytResult.success) {
    console.error(`  Error: ${ytResult.error}`);
    process.exit(1);
  }

  // Test 4: Page verification
  console.log("\n🧪 Test 4: Verify page state");
  const verifyResult = await playwrightBrowserAgent.verifyPageState(
    "https://www.google.com",
    "Google"
  );
  console.log(`  Success: ${verifyResult.success}`);
  console.log(`  Found: ${verifyResult.found}`);
  if (!verifyResult.success) {
    console.error(`  Error: ${verifyResult.found}`);
    process.exit(1);
  }

  // Close browser
  await playwrightBrowserAgent.close();
  console.log("\n🎉 ALL PLAYWRIGHT TESTS PASSED!");
}

testPlaywright().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});