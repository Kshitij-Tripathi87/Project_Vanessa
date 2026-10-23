import { playwrightBrowserAgent } from "./browser-playwright.agent.js";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";

export class BrowserAgent implements SpecialistAgent {
  id = "browser";
  capabilities = [
    "browser_navigation",
    "web_search",
    "youtube_playback",
    "page_inspection",
    "playwright_automation",
  ];
  allowedTools = [
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_fill",
    "browser_extract",
    "browser_playwright_automation",
  ];

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const _runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    const startTime = new Date().toISOString();

    switch (action) {
      case "browser.open_url": {
        const url = params.url || "https://google.com";
        const res = await playwrightBrowserAgent.navigate(url);
        const evidence: AgentEvidence[] = [
          {
            description: `Navigated browser to ${url}`,
            source: "Playwright (Edge)",
            timestamp: startTime,
            confidence: 1.0,
            data: { url, title: res.title },
          },
        ];
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? `Opened ${url} in browser` : `Failed to open ${url}: ${res.error}`,
          spokenSummary: res.success ? `Opened ${url}.` : `Failed to open ${url}.`,
          evidence,
          artifacts: [url],
          data: {
            pageObservations: res.success ? `Navigated to ${url} (title: ${res.title})` : `Failed: ${res.error}`,
            navigationResults: { url, status: res.success ? "loaded" : "failed", title: res.title },
            completedActions: res.success ? [`Opened ${url}`] : [`Failed to open ${url}: ${res.error}`],
            url: res.url,
          },
        };
      }

      case "browser.search": {
        const query = params.query || "";
        const res = await playwrightBrowserAgent.search(query);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? `Searched web for "${query}"` : `Search failed for "${query}"`,
          spokenSummary: res.success ? `Searching for ${query}.` : `Search failed for ${query}.`,
          evidence: res.success ? [
            {
              description: `Search results for "${query}": ${res.snippets.join("; ")}`,
              source: "Google Search (Playwright)",
              timestamp: startTime,
              confidence: 0.9,
              data: { snippets: res.snippets },
            }
          ] : [],
          artifacts: [res.url],
          data: {
            pageObservations: res.success ? `Displaying search results for ${query}` : `Search failed: ${res.error}`,
            navigationResults: { query, url: res.url },
            completedActions: res.success ? [`Search: ${query}`] : [`Search failed: ${res.error}`],
          },
        };
      }

      case "browser.research":
      case "vanessa.run_goal": {
        const query = params.goal || params.query || params.prompt || "web research";
        const { vanessaAgent } = await import("./openjarvis.agent.js");
        const goalRes = await vanessaAgent.runGoal(query, ["web_search", "browser_navigate"]);
        return {
          agentId: this.id,
          status: "completed",
          success: goalRes.success ?? true,
          summary: goalRes.final_answer || `Research completed for ${query}`,
          spokenSummary: `Finished research on ${query}.`,
          evidence: goalRes.steps ? goalRes.steps.map((s: any) => ({ description: `${s.thought}: ${s.action}` })) : [],
          artifacts: [],
          data: goalRes,
        };
      }

      case "youtube.search_and_play": {
        const query = params.query || "Bolna Buildathon";
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const res = await playwrightBrowserAgent.navigate(url);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? `Playing "${query}" on YouTube` : `Failed to open YouTube for "${query}"`,
          spokenSummary: res.success ? `Playing ${query} on YouTube.` : `Failed to open YouTube for ${query}.`,
          evidence: res.success ? [
            {
              description: `YouTube query loaded: ${query}`,
              source: "YouTube (Playwright)",
              timestamp: startTime,
              confidence: 0.9,
            }
          ] : [],
          artifacts: [url],
          data: {
            pageObservations: res.success ? `YouTube query loaded: ${query}` : `Failed: ${res.error}`,
            navigationResults: { query, url: res.url },
            completedActions: res.success ? [`Launched YouTube search for ${query}`] : [`Failed to launch YouTube: ${res.error}`],
            query,
            url: res.url,
          },
        };
      }

      case "browser.verify_page_state": {
        const url = params.url || "";
        const expectedText = params.expectedText || "";
        const res = await playwrightBrowserAgent.verifyPageState(url, expectedText);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? `Page verified: ${expectedText} found` : `Page verification failed`,
          spokenSummary: res.success ? `Found "${expectedText}" on page.` : `Could not verify page.`,
          evidence: res.success ? [
            {
              description: `Page verification: "${expectedText}" ${res.found ? "found" : "not found"} on ${url}`,
              source: "Playwright Verification",
              timestamp: startTime,
              confidence: 0.9,
            }
          ] : [],
          artifacts: [url],
          data: {
            pageObservations: `Verification: ${res.found ? "PASSED" : "FAILED"}`,
            navigationResults: { url, expectedText, found: res.found },
            completedActions: [`Verified page for "${expectedText}"`],
          },
        };
      }

      case "browser.read_title": {
        // Use the current URL from context or default
        const url = params.url || "https://google.com";
        const res = await playwrightBrowserAgent.navigate(url);
        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: "Read browser tab",
          spokenSummary: `Browser tab active: ${res.title}.`,
          evidence: [],
          artifacts: [],
          data: {
            pageObservations: "Active tab inspection",
            navigationResults: { title: res.title, url: res.url },
            completedActions: ["Inspected tab title"],
          },
        };
      }

      default:
        throw new Error(`BrowserAgent: Unknown action '${action}'`);
    }
  }
}

export const browserAgent = new BrowserAgent();
