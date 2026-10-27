import { runPowerShell } from "./powershell.js";
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
  ];
  allowedTools = [
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_fill",
    "browser_extract",
  ];

  private edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

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
        const url = typeof params.url === "string" && params.url.trim() ? params.url.trim() : "https://google.com";
        const res = await this.openUrl(url);
        const detail = res.simulated
          ? "Simulation only: browser navigation was not attempted or verified."
          : res.success
            ? "Windows accepted a browser launch request for " + url + "; the destination page load was not verified."
            : "Browser launch request failed for " + url + ".";
        return {
          agentId: this.id,
          status: res.simulated || res.success ? "partial" : "failed",
          success: false,
          summary: detail,
          spokenSummary: res.simulated
            ? "This was a simulation. No browser navigation occurred."
            : res.success
              ? "I requested that Windows open the destination. I could not verify that the page loaded."
              : "I could not launch the requested browser destination.",
          evidence: [{
            description: detail,
            source: "browser.launch-request",
            timestamp: startTime,
            confidence: res.simulated ? 1 : 0.6,
            data: { url, simulated: res.simulated === true, launchRequestAccepted: res.success && !res.simulated, pageLoadVerified: false },
          }],
          artifacts: [],
          verification: { passed: false, details: detail },
          data: {
            outcome: res.simulated ? "simulated" : res.success ? "inconclusive" : "failed",
            simulated: res.simulated === true,
            launchRequestAccepted: res.success && !res.simulated,
            pageLoadVerified: false,
            url: res.url,
          },
        };
      }

      case "browser.search": {
        const query = typeof params.query === "string" ? params.query : "";
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const res = await this.openUrl(url);
        const detail = res.simulated
          ? "Simulation only: web search was not attempted or verified."
          : res.success
            ? "Windows accepted a search-page launch request; search results were not inspected."
            : "Search-page launch failed.";
        return {
          agentId: this.id,
          status: res.simulated || res.success ? "partial" : "failed",
          success: false,
          summary: detail,
          spokenSummary: res.simulated
            ? "This was a simulation. No web search occurred."
            : res.success
              ? "I requested the search page, but I could not verify the results."
              : "I could not open the search page.",
          evidence: [{
            description: detail, source: "browser.search-launch", timestamp: startTime, confidence: res.simulated ? 1 : 0.6,
            data: { query, url, simulated: res.simulated === true, launchRequestAccepted: res.success && !res.simulated, resultsInspected: false },
          }],
          artifacts: [],
          verification: { passed: false, details: detail },
          data: { outcome: res.simulated ? "simulated" : res.success ? "inconclusive" : "failed", simulated: res.simulated === true, launchRequestAccepted: res.success && !res.simulated, resultsInspected: false, query, url },
        };
      }

      case "browser.research":
      case "vanessa.run_goal": {
        const query = params.goal || params.query || params.prompt || "web research";
        const { vanessaAgent } = await import("./openjarvis.agent.js");
        const goalRes = await vanessaAgent.runGoal(query, ["web_search", "browser_navigate"]);
        const succeeded = goalRes?.success === true && goalRes?.status !== "blocked" && goalRes?.status !== "failed";
        const detail = succeeded
          ? "Research returned a result, but source verification remains subject to the evidence attached to that result."
          : (typeof goalRes?.summary === "string" ? goalRes.summary : "The research executor is unavailable; no research result was verified.");
        const evidence = Array.isArray(goalRes?.steps)
          ? goalRes.steps.map((step: any) => ({ description: String(step?.thought || "Research step") + ": " + String(step?.action || "No action detail"), source: "research-executor", timestamp: startTime, confidence: 0.5 }))
          : [{ description: detail, source: "research-executor", timestamp: startTime, confidence: 1, data: { outcome: "inconclusive", processStarted: false } }];
        return {
          agentId: this.id,
          status: succeeded ? "completed" : goalRes?.status === "blocked" ? "blocked" : "partial",
          success: succeeded,
          summary: detail,
          spokenSummary: succeeded ? "Research returned a result; its sources need to be reviewed." : "I could not complete or verify the research request.",
          evidence,
          artifacts: [],
          verification: { passed: succeeded, details: detail },
          data: { outcome: succeeded ? "succeeded" : goalRes?.status === "blocked" ? "blocked" : "inconclusive", query, research: goalRes, processStarted: goalRes?.data?.processStarted ?? false },
        };
      }

      case "youtube.search_and_play": {
        const query = typeof params.query === "string" && params.query.trim() ? params.query.trim().slice(0, 1000) : "Bolna Buildathon";
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const res = await this.openUrl(url);
        const detail = res.simulated
          ? "Simulation only: YouTube navigation and playback were not attempted or verified."
          : res.success
            ? "Windows accepted a YouTube search-page launch request; video playback was not verified."
            : "The YouTube search-page launch request failed.";
        return {
          agentId: this.id,
          status: res.simulated || res.success ? "partial" : "failed",
          success: false,
          summary: detail,
          spokenSummary: res.simulated
            ? "This was a simulation. No YouTube navigation or playback occurred."
            : res.success
              ? "I requested the YouTube search page, but I could not verify that a video played."
              : "I could not launch the YouTube search page.",
          evidence: [{
            description: detail, source: "youtube.launch-request", timestamp: startTime, confidence: res.simulated ? 1 : 0.6,
            data: { query, url, simulated: res.simulated === true, launchRequestAccepted: res.success && !res.simulated, playbackVerified: false },
          }],
          artifacts: [],
          verification: { passed: false, details: detail },
          data: { outcome: res.simulated ? "simulated" : res.success ? "inconclusive" : "failed", simulated: res.simulated === true, launchRequestAccepted: res.success && !res.simulated, playbackVerified: false, query, url },
        };
      }

      case "browser.read_title": {
        const detail = "Active-tab title inspection is not connected to a real browser observation provider.";
        return {
          agentId: this.id,
          status: "partial",
          success: false,
          summary: detail,
          spokenSummary: "I cannot verify the active browser tab with the current integration.",
          evidence: [{ description: detail, source: "browser.read_title", timestamp: startTime, confidence: 1, data: { outcome: "inconclusive", processStarted: false } }],
          artifacts: [],
          verification: { passed: false, details: detail },
          data: { outcome: "inconclusive", pageLoadVerified: false, titleRead: false },
        };
      }

      default:
        throw new Error(`BrowserAgent: Unknown action '${action}'`);
    }
  }

  private async openUrl(url: string): Promise<{ success: boolean; url: string; simulated?: boolean }> {
    if (typeof url !== "string" || !url.trim() || url.length > 4096) {
      return { success: false, url: typeof url === "string" ? url.slice(0, 4096) : "" };
    }
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { success: false, url }; }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { success: false, url };
    }
    if (process.env.FAKE === "1") {
      return { success: false, url, simulated: true };
    }
    const psCommand = "$url = $env:VANESSA_URL; Start-Process -FilePath $env:VANESSA_BROWSER -ArgumentList $url";
    try {
      await runPowerShell(psCommand, { VANESSA_BROWSER: this.edgePath, VANESSA_URL: url }, 10000);
      return { success: true, url };
    } catch {
      await runPowerShell("Start-Process -FilePath $env:VANESSA_URL", { VANESSA_URL: url }, 10000);
      return { success: true, url };
    }
  }
}

export const browserAgent = new BrowserAgent();
