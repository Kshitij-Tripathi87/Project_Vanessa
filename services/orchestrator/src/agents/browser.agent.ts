import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import { playwrightBrowserAgent, type PlaywrightBrowserAgent } from "./browser-playwright.agent.js";

function safeHttpUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("A non-empty URL is required.");
  const trimmed = input.trim();
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") throw new Error("Only HTTP and HTTPS URLs are permitted.");
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("Only valid HTTP and HTTPS URLs are permitted.");
  return url.toString();
}

function evidence(description: string, data?: unknown): AgentEvidence {
  return {
    description,
    source: "Vanessa persistent Playwright Edge page",
    timestamp: new Date().toISOString(),
    confidence: 1,
    data,
  };
}

export class BrowserAgent implements SpecialistAgent {
  id = "browser";
  capabilities = [
    "browser_navigation",
    "web_search",
    "youtube_search",
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

  constructor(private readonly browser: PlaywrightBrowserAgent = playwrightBrowserAgent) {}

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const _runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);
    const startTime = new Date().toISOString();

    try {
      switch (action) {
        case "browser.open_url": {
          const requestedUrl = safeHttpUrl(params.url || "https://www.google.com/");
          const res = await this.browser.navigate(requestedUrl);
          if (!res.success) {
            return {
              agentId: this.id, status: "failed", success: false,
              summary: "Could not open " + requestedUrl + ": " + (res.error || "navigation failed"),
              spokenSummary: "I couldn't open that page.",
              evidence: [], artifacts: [],
              data: { requestedUrl, finalUrl: res.url, title: res.title, error: res.error },
              verification: { passed: false, details: res.error || "Browser navigation failed." },
            };
          }
          return {
            agentId: this.id, status: "completed", success: true,
            summary: "Opened " + res.url + " in the visible managed browser.",
            spokenSummary: "Opened " + res.url + ".",
            evidence: [evidence("Read the active browser tab URL and title after navigation.", { requestedUrl, finalUrl: res.url, title: res.title })],
            artifacts: [res.url],
            data: { requestedUrl, finalUrl: res.url, title: res.title, pageLoaded: true },
            verification: { passed: true, details: "The persistent browser tab navigated successfully and returned its actual URL/title." },
          };
        }

        case "browser.search": {
          const query = String(params.query || "").trim();
          if (!query) throw new Error("Search query is required.");
          const res = await this.browser.search(query);
          if (!res.success) {
            return {
              agentId: this.id, status: "failed", success: false,
              summary: "Search navigation failed for " + query + ".",
              spokenSummary: "I couldn't complete that web search.",
              evidence: [], artifacts: [res.url],
              data: { query, url: res.url, title: res.title, error: res.error },
              verification: { passed: false, details: res.error || "Search navigation failed." },
            };
          }
          const verified = res.snippets.length > 0;
          return {
            agentId: this.id, status: verified ? "completed" : "partial", success: verified,
            summary: verified
              ? "Opened web search results for " + query + " and extracted " + res.snippets.length + " result snippets."
              : "The search page opened, but its result snippets could not be verified.",
            spokenSummary: verified
              ? "I searched for " + query + " and found results."
              : "I opened the search page, but I couldn't verify the results.",
            evidence: [evidence("Observed the search page and its extracted text snippets.", { query, snippets: res.snippets, url: res.url, title: res.title })],
            artifacts: [res.url],
            data: { query, snippets: res.snippets, url: res.url, title: res.title, resultsVerified: verified },
            verification: { passed: verified, details: verified ? "At least one visible search-result snippet was extracted." : "No visible search-result snippets were extracted." },
          };
        }

        case "youtube.search": {
          const query = String(params.query || "").trim();
          if (!query) throw new Error("YouTube search query is required.");
          const res = await this.browser.searchYouTube(query);
          if (res.success && res.results.length > 0) {
            return {
              agentId: this.id, status: "completed", success: true,
              summary: "Verified " + res.results.length + " YouTube search result(s) for " + query + ".",
              spokenSummary: "I searched YouTube for " + query + " and found results.",
              evidence: [evidence("Read visible YouTube video titles and URLs from the active search page.", { query, results: res.results, url: res.url, title: res.title })],
              artifacts: [res.url],
              data: { query, results: res.results, url: res.url, title: res.title, resultsVerified: true, playbackAttempted: false },
              verification: { passed: true, details: "Visible video result titles and watch URLs were read from the YouTube page. No playback was requested." },
            };
          }
          const pageLoaded = res.url.includes("youtube.com/results");
          return {
            agentId: this.id, status: pageLoaded ? "partial" : "failed", success: false,
            summary: pageLoaded
              ? "YouTube opened, but visible search results could not be verified for " + query + "."
              : "Could not open YouTube search for " + query + ".",
            spokenSummary: pageLoaded
              ? "YouTube opened, but I couldn't verify any search results."
              : "I couldn't open YouTube search.",
            evidence: pageLoaded ? [evidence("YouTube search page opened but result verification failed.", { query, url: res.url, title: res.title, error: res.error })] : [],
            artifacts: res.url ? [res.url] : [],
            data: { query, results: res.results, url: res.url, title: res.title, resultsVerified: false, error: res.error },
            verification: { passed: false, details: res.error || "Visible YouTube results were not verified." },
          };
        }

        case "youtube.search_and_play": {
          const query = String(params.query || "").trim();
          if (!query) throw new Error("YouTube playback query is required.");
          const res = await this.browser.searchAndPlayYouTube(query);
          if (res.success && res.playbackVerified) {
            return {
              agentId: this.id, status: "completed", success: true,
              summary: "Verified playback for " + res.title + ".",
              spokenSummary: "I found " + res.title + " and verified that it is playing.",
              evidence: [evidence("Verified YouTube video currentTime advanced while the video was unpaused.", { query, url: res.url, title: res.title, playbackVerified: true, video: res.video })],
              artifacts: [res.url],
              data: { query, url: res.url, title: res.title, playbackVerified: true, video: res.video },
              verification: { passed: true, details: "Video was unpaused, ready to play, and playback time advanced." },
            };
          }
          const candidateOpened = res.url.includes("youtube.com/watch");
          return {
            agentId: this.id, status: candidateOpened ? "partial" : "failed", success: false,
            summary: candidateOpened
              ? "Opened a YouTube result, but playback could not be verified."
              : "Could not find a verifiable YouTube result for " + query + ".",
            spokenSummary: candidateOpened
              ? "I opened a result, but I couldn't verify that the video started playing."
              : "I couldn't find and verify a YouTube result for " + query + ".",
            evidence: [evidence("Playback is not claimed unless video state shows currentTime advancing.", { query, url: res.url, title: res.title, playbackVerified: false, video: res.video, error: res.error })],
            artifacts: res.url ? [res.url] : [],
            data: { query, url: res.url, title: res.title, playbackVerified: false, video: res.video, error: res.error },
            verification: { passed: false, details: res.error || "Video playback did not satisfy the observed playback postcondition." },
          };
        }

        case "browser.verify_page_state": {
          const url = typeof params.url === "string" ? params.url : "";
          const expectedText = String(params.expectedText || "").trim();
          if (!expectedText) throw new Error("Expected page text is required.");
          const res = await this.browser.verifyPageState(url, expectedText);
          const verified = res.success && res.found;
          return {
            agentId: this.id, status: verified ? "completed" : res.success ? "partial" : "failed", success: verified,
            summary: verified
              ? "Verified the expected page text."
              : res.success ? "The page loaded, but expected text was not found." : "Page verification failed.",
            spokenSummary: verified
              ? "I verified that the page contains the requested text."
              : "I couldn't verify the expected text on the page.",
            evidence: [evidence("Checked actual body text against the requested postcondition.", { url: res.url, title: res.title, expectedText, found: res.found })],
            artifacts: res.url ? [res.url] : [],
            data: { url: res.url, title: res.title, expectedText, found: res.found },
            verification: { passed: verified, details: res.error || (verified ? "Expected text was observed on the active page." : "Expected text was not observed on the page.") },
          };
        }

        case "browser.read_title": {
          const res = await this.browser.currentPageState();
          return {
            agentId: this.id, status: res.success ? "completed" : "failed", success: res.success,
            summary: res.success ? "Active browser page: " + res.title : "No active managed browser page is available.",
            spokenSummary: res.success ? "The active page is " + res.title + "." : "I don't have an active browser page to inspect yet.",
            evidence: res.success ? [evidence("Read title and URL from the existing browser tab.", { url: res.url, title: res.title })] : [],
            artifacts: res.url ? [res.url] : [],
            data: { url: res.url, title: res.title },
            verification: { passed: res.success, details: res.error || "Read active browser tab state." },
          };
        }

        case "browser.research":
        case "vanessa.run_goal": {
          const query = params.goal || params.query || params.prompt || "web research";
          const { vanessaAgent } = await import("./openjarvis.agent.js");
          const goalRes = await vanessaAgent.runGoal(query, ["web_search", "browser_navigate"]);
          const success = goalRes.success === true;
          return {
            agentId: this.id, status: success ? "completed" : "partial", success,
            summary: goalRes.final_answer || "Research outcome is incomplete.",
            spokenSummary: success ? "Finished research on " + query + "." : "I started research, but couldn't verify a complete result.",
            evidence: goalRes.steps ? goalRes.steps.map((step: any) => ({ description: step.thought + ": " + step.action })) : [],
            artifacts: [],
            data: goalRes,
            verification: { passed: success, details: success ? "Research agent returned success." : "Research agent did not confirm a complete result." },
          };
        }

        default:
          throw new Error("BrowserAgent: Unknown action '" + action + "'");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        agentId: this.id, status: "failed", success: false,
        summary: "Browser action failed: " + detail,
        spokenSummary: "I couldn't complete that browser action.",
        evidence: [], artifacts: [],
        data: { action, error: detail },
        verification: { passed: false, details: detail },
      };
    }
  }
}

export const browserAgent = new BrowserAgent();
