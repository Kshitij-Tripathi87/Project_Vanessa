import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import {
  EdgeCdpBrowserDriver,
  type BrowserDriver,
  type BrowserPageState,
  type YouTubeCandidate,
} from "./browserDriver.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeHttpUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("A non-empty URL is required.");
  }
  const trimmed = input.trim();
  // If the user explicitly supplied a URI scheme, do not reinterpret a dangerous
  // scheme such as javascript: as an HTTPS hostname by prefixing it.
  const explicitScheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== "http" && explicitScheme !== "https") {
    throw new Error("Only HTTP and HTTPS URLs are permitted.");
  }
  const withScheme = /^https?:\\/\\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are permitted.");
  }
  if (!parsed.hostname) throw new Error("URL must include a hostname.");
  return parsed.toString();
}

function isYouTubeVideoUrl(url: string): boolean {
  const parsed = new URL(url);
  return (
    (parsed.hostname === "youtube.com" || parsed.hostname === "www.youtube.com" || parsed.hostname === "m.youtube.com") &&
    parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"))
  ) || parsed.hostname === "youtu.be";
}

function normalizedWords(value: string): string[] {
  const stop = new Set(["the", "a", "an", "to", "on", "in", "of", "for", "and", "video", "youtube", "play", "watch", "find", "open", "please", "me", "about"]);
  return value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
    .filter((word) => word.length > 1 && !stop.has(word));
}

function rankCandidate(query: string, candidate: YouTubeCandidate): number {
  const queryWords = normalizedWords(query);
  if (!queryWords.length) return 0;
  const titleWords = new Set(normalizedWords(`${candidate.title} ${candidate.channel || ""}`));
  return queryWords.filter((word) => titleWords.has(word)).length / queryWords.length;
}

function evidence(description: string, data?: unknown): AgentEvidence {
  return {
    description,
    source: "Vanessa managed Edge browser",
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
  ];
  allowedTools = [
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_fill",
    "browser_extract",
  ];

  constructor(private readonly driver: BrowserDriver = new EdgeCdpBrowserDriver()) {}

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string"
      ? actionOrTask
      : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string"
      ? (paramsOrContext as Record<string, any>) || {}
      : actionOrTask.params || {};
    const _runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    if (process.env.FAKE === "1") return this.simulated(action, params);

    try {
      switch (action) {
        case "browser.open_url": {
          const requestedUrl = normalizeHttpUrl(params.url);
          const page = await this.driver.navigate(requestedUrl);
          if (page.httpStatus !== undefined && page.httpStatus >= 400) {
            return this.failed(
              `The browser reached an HTTP ${page.httpStatus} response.`,
              `Navigation to ${requestedUrl} returned HTTP ${page.httpStatus}.`,
              { requestedUrl, page }
            );
          }
          const passed = page.readyState === "complete" && Boolean(page.url);
          return this.completed(
            `Opened ${page.url}`,
            `Opened ${page.url}.`,
            [evidence("Observed actual browser URL and document title after navigation.", { requestedUrl, ...page })],
            [page.url],
            { requestedUrl, finalUrl: page.url, title: page.title, pageState: page },
            passed,
            passed ? `Browser reported readyState=${page.readyState}; final URL and title were read from the active page.` : "Browser navigation was issued but a complete page state could not be verified."
          );
        }

        case "browser.search": {
          const query = String(params.query || "").trim();
          if (!query) throw new Error("Search query is required.");
          const engine = String(params.engine || "google").toLowerCase();
          const url = engine === "bing"
            ? `https://www.bing.com/search?q=${encodeURIComponent(query)}`
            : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          const page = await this.driver.navigate(url);
          const passed = page.readyState === "complete" && page.url.includes(new URL(url).hostname);
          return this.completed(
            `Opened web search results for "${query}"`,
            `Opened search results for ${query}.`,
            [evidence("Observed search results page after navigation.", page)],
            [page.url],
            { query, requestedUrl: url, finalUrl: page.url, title: page.title, pageState: page },
            passed,
            passed ? "Search results page loaded and its URL/title were observed." : "Search navigation was attempted but results page state was not verified."
          );
        }

        case "youtube.search": {
          const query = String(params.query || "").trim();
          if (!query) throw new Error("YouTube search query is required.");
          const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          const page = await this.driver.navigate(url);
          const results = await this.driver.getYouTubeResults();
          if (!results.length) {
            return this.partial(
              `Opened YouTube results for "${query}", but no video results could be verified.`,
              "I opened YouTube search, but I couldn't verify any results.",
              [evidence("YouTube result selector returned no video candidates.", { page })],
              [page.url],
              { query, page, results: [], simulated: false },
              "Search page loaded, but video result list was not observed."
            );
          }
          return this.completed(
            `Opened YouTube results for "${query}"`,
            `Opened YouTube search results for ${query}.`,
            [evidence(`Observed ${results.length} YouTube video result(s).`, { page, results: results.slice(0, 5) })],
            [page.url],
            { query, page, resultCount: results.length, results: results.slice(0, 5), playback: "not_requested" },
            true,
            `Observed ${results.length} results; playback was not requested.`
          );
        }

        case "youtube.open_video": {
          const url = normalizeHttpUrl(params.url);
          if (!isYouTubeVideoUrl(url)) throw new Error("youtube.open_video requires a YouTube watch URL or youtu.be video URL.");
          const page = await this.driver.navigate(url);
          if (page.httpStatus !== undefined && page.httpStatus >= 400) {
            return this.failed(`The video page returned HTTP ${page.httpStatus}.`, `Video navigation returned HTTP ${page.httpStatus}.`, { url, page });
          }
          const isWatchPage = isYouTubeVideoUrl(page.url);
          if (params.play === true && isWatchPage) {
            await pause(2200);
            const video = await this.driver.getVideoState();
            const playing = !video.paused && video.currentTime > 0.25 && video.readyState >= 2;
            if (playing) {
              return this.completed(
                `Playing ${video.title || "the requested YouTube video"}`,
                `Playing ${video.title || "the requested video"}.`,
                [evidence("Observed video player advancing on the requested watch page.", { page, video })],
                [page.url],
                { requestedUrl: url, page, video, playbackVerified: true },
                true,
                "The video element was unpaused and its playback time advanced."
              );
            }
            return this.partial(
              `Opened ${page.url}, but playback did not start automatically.`,
              "I opened the video, but playback didn't start. Please press play.",
              [evidence("Watch page was opened, but playback was not observed.", { page, video })],
              [page.url],
              { requestedUrl: url, page, video, playbackVerified: false },
              "Watch page opened; video playback was not verified."
            );
          }
          return this.completed(
            `Opened video page ${page.url}`,
            "Opened the video page.",
            [evidence("Observed requested YouTube watch page.", page)],
            [page.url],
            { requestedUrl: url, finalUrl: page.url, title: page.title, pageState: page, playback: "not_requested" },
            isWatchPage,
            isWatchPage ? "The active page is a YouTube watch page." : "Browser redirected away from the requested YouTube watch page."
          );
        }

        case "youtube.search_and_play": {
          const query = String(params.query || "").trim();
          if (!query) throw new Error("YouTube video query is required.");
          const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          const searchPage = await this.driver.navigate(searchUrl);
          const candidates = await this.driver.getYouTubeResults();
          if (!candidates.length) {
            return this.partial(
              `Opened YouTube results for "${query}", but I couldn't identify a video to play.`,
              `I opened YouTube results for ${query}, but couldn't identify a video to play.`,
              [evidence("No accessible YouTube result anchors were observed.", searchPage)],
              [searchPage.url],
              { query, searchPage, candidates: [], playbackVerified: false },
              "Search results page was opened, but no candidate video was verified."
            );
          }
          const preferredTitle = String(params.preferredTitle || "");
          const ranked = candidates.map((candidate) => ({
            candidate,
            score: Math.max(rankCandidate(query, candidate), preferredTitle ? rankCandidate(preferredTitle, candidate) : 0),
          })).sort((a, b) => b.score - a.score);
          const best = ranked[0];
          const next = ranked[1];
          if (!best || best.score <= 0) {
            return this.partial(
              `Found YouTube results for "${query}", but no clear match was identified.`,
              `I found results, but couldn't confidently choose the right video.`,
              [evidence("Candidate titles did not sufficiently match the requested terms.", { candidates: candidates.slice(0, 5) })],
              [searchPage.url],
              { query, searchPage, candidates: candidates.slice(0, 5), playbackVerified: false },
              "No candidate had sufficient title/channel token overlap."
            );
          }
          if (next && next.score === best.score && best.score < 1) {
            return this.partial(
              `Several videos matched "${query}" equally well.`,
              "I found a few equally relevant videos. Please specify the title or channel.",
              [evidence("Ambiguous top-ranked video candidates.", { candidates: ranked.slice(0, 5) })],
              [searchPage.url],
              { query, searchPage, candidates: ranked.slice(0, 5), playbackVerified: false },
              "More than one candidate had the same relevance score; no video was chosen."
            );
          }
          const watchUrl = normalizeHttpUrl(best.candidate.url);
          const page = await this.driver.navigate(watchUrl);
          if (!isYouTubeVideoUrl(page.url)) {
            return this.partial(
              `Opened a candidate result, but YouTube did not remain on a watch page.`,
              "I opened a result, but couldn't verify that YouTube reached its video page.",
              [evidence("Candidate navigation did not end at a YouTube watch URL.", { candidate: best.candidate, page })],
              [page.url],
              { query, candidate: best.candidate, page, playbackVerified: false },
              "Final URL is not a verified YouTube watch URL."
            );
          }
          await pause(2500);
          const video = await this.driver.getVideoState();
          const playing = !video.paused && video.currentTime > 0.25 && video.readyState >= 2;
          if (!playing) {
            return this.partial(
              `Opened "${video.title || best.candidate.title}", but playback did not start automatically.`,
              `I opened ${video.title || best.candidate.title}, but playback didn't start. Please press play.`,
              [evidence("Correct watch page was opened, but video playback was not observed.", { candidate: best.candidate, page, video })],
              [page.url],
              { query, candidate: best.candidate, page, video, playbackVerified: false },
              "Video page is open, but the video element did not demonstrate playback progress."
            );
          }
          return this.completed(
            `Playing "${video.title || best.candidate.title}"`,
            `Playing ${video.title || best.candidate.title}.`,
            [evidence("Selected video and verified playback progress.", { candidate: best.candidate, page, video })],
            [page.url],
            { query, candidate: best.candidate, page, video, playbackVerified: true },
            true,
            "Watch page is active and video playback time advanced."
          );
        }

        case "browser.read_title": {
          const page = await this.driver.getPageState();
          return this.completed(
            page.title ? `Current page: ${page.title}` : `Current page: ${page.url}`,
            page.title ? `The current page is ${page.title}.` : "I checked the active browser page.",
            [evidence("Read actual URL/title from the active controlled browser page.", page)],
            [page.url],
            { url: page.url, title: page.title, pageState: page },
            Boolean(page.url && page.readyState),
            "Current page metadata was read from the browser."
          );
        }

        case "browser.research":
        case "vanessa.run_goal": {
          const query = params.goal || params.query || params.prompt || "web research";
          const { vanessaAgent } = await import("./openjarvis.agent.js");
          const goalRes = await vanessaAgent.runGoal(query, ["web_search", "browser_navigate"]);
          const success = goalRes.success === true;
          return {
            agentId: this.id,
            status: success ? "completed" : "failed",
            success,
            summary: goalRes.final_answer || (success ? `Research completed for ${query}` : `Research failed for ${query}`),
            spokenSummary: success ? `Finished research on ${query}.` : `I couldn't complete the research on ${query}.`,
            evidence: Array.isArray(goalRes.steps) ? goalRes.steps.map((step: any) => ({ description: `${step.thought}: ${step.action}` })) : [],
            artifacts: [],
            verification: { passed: success, details: success ? "Research adapter reported success." : "Research adapter did not report success." },
            data: goalRes,
          };
        }

        default:
          throw new Error(`BrowserAgent: Unknown action '${action}'`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.failed(message, `Browser action ${action} failed: ${message}`, { action, params });
    }
  }

  private completed(
    summary: string,
    spokenSummary: string,
    evidenceItems: AgentEvidence[],
    artifacts: string[],
    data: Record<string, unknown>,
    passed: boolean,
    details: string
  ): AgentResult {
    return {
      agentId: this.id,
      status: passed ? "completed" : "partial",
      success: passed,
      summary,
      spokenSummary,
      evidence: evidenceItems,
      artifacts,
      verification: { passed, details },
      data,
    };
  }

  private partial(
    summary: string,
    spokenSummary: string,
    evidenceItems: AgentEvidence[],
    artifacts: string[],
    data: Record<string, unknown>,
    details: string
  ): AgentResult {
    return {
      agentId: this.id,
      status: "partial",
      success: false,
      summary,
      spokenSummary,
      evidence: evidenceItems,
      artifacts,
      verification: { passed: false, details },
      data,
    };
  }

  private failed(summary: string, details: string, data?: Record<string, unknown>): AgentResult {
    return {
      agentId: this.id,
      status: "failed",
      success: false,
      summary,
      spokenSummary: summary,
      evidence: [],
      artifacts: [],
      verification: { passed: false, details },
      data,
      error: details,
    };
  }

  private simulated(action: string, params: Record<string, any>): AgentResult {
    const url = String(params.url || params.query || "about:blank");
    return {
      agentId: this.id,
      status: "completed",
      success: true,
      summary: `SIMULATED: ${action} would operate on ${url}`,
      spokenSummary: "Browser action simulated; no real browser side effect was performed.",
      evidence: [evidence("FAKE=1 simulated browser result; not live execution evidence.", { simulated: true, action, params })],
      artifacts: [],
      verification: { passed: true, details: "SIMULATED ONLY: FAKE=1 prevents real browser execution." },
      data: { simulated: true, action, params },
    };
  }
}

export const browserAgent = new BrowserAgent();
