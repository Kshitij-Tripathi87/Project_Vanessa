import { chromium, type Browser, type Page } from "playwright";
import * as os from "node:os";

export interface YouTubeSearchResult {
  title: string;
  url: string;
}

function normalizeHttpUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A non-empty URL is required.");
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new Error("Only HTTP and HTTPS URLs are permitted.");
  }
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Only valid HTTP and HTTPS URLs are permitted.");
  }
  return parsed.toString();
}

export class PlaywrightBrowserAgent {
  id = "browser-playwright";
  capabilities = ["browser_navigation", "web_search", "youtube_search", "youtube_playback", "page_inspection", "automation"];
  allowedTools = ["browser_navigate", "browser_screenshot", "browser_click", "browser_fill", "browser_extract"];
  private browser: Browser | null = null;
  private page: Page | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const headlessSetting = process.env.VANESSA_BROWSER_HEADLESS;
      // On the user's Windows PC, show the actual Edge window by default.
      // CI/Linux remains headless unless the operator explicitly changes this.
      const headless = headlessSetting === "1" || (headlessSetting !== "0" && process.platform !== "win32");
      const executablePath = process.env.VANESSA_EDGE_PATH ||
        (process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined);
      this.browser = await chromium.launch({
        headless,
        executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }
    return this.browser;
  }

  private async getPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      const browser = await this.getBrowser();
      this.page = await browser.newPage();
    }
    return this.page;
  }

  /** Navigate the persistent browser tab. On Windows, the default configuration is visible and user-facing. */
  async navigate(url: string): Promise<{ success: boolean; title: string; url: string; error?: string }> {
    let target: string;
    try {
      target = normalizeHttpUrl(url);
    } catch (error) {
      return { success: false, title: "", url, error: error instanceof Error ? error.message : String(error) };
    }

    try {
      const page = await this.getPage();
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
      const title = await page.title();
      if (response && response.status() >= 400) {
        return { success: false, title, url: page.url(), error: "Page returned HTTP " + response.status() };
      }
      return { success: true, title, url: page.url() };
    } catch (error) {
      return { success: false, title: "", url: target, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async search(query: string): Promise<{ success: boolean; snippets: string[]; url: string; title: string; error?: string }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return { success: false, snippets: [], url: "", title: "", error: "Search query is required." };
    const target = "https://www.google.com/search?q=" + encodeURIComponent(normalizedQuery);
    const navigation = await this.navigate(target);
    if (!navigation.success) return { success: false, snippets: [], url: navigation.url, title: navigation.title, error: navigation.error };

    try {
      const page = await this.getPage();
      await page.waitForTimeout(900);
      const snippets = await page.locator("h3, .VwiC3b, .IsZvec, .LC20lb").evaluateAll((elements) =>
        elements.map((element) => (element.textContent || "").trim())
          .filter((value) => value.length > 10)
          .filter((value, index, values) => values.indexOf(value) === index)
          .slice(0, 8)
      );
      return { success: true, snippets, url: page.url(), title: await page.title() };
    } catch (error) {
      return { success: true, snippets: [], url: navigation.url, title: navigation.title, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async searchYouTube(query: string): Promise<{
    success: boolean;
    query: string;
    results: YouTubeSearchResult[];
    url: string;
    title: string;
    error?: string;
  }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { success: false, query: normalizedQuery, results: [], url: "", title: "", error: "YouTube search query is required." };
    }

    const target = "https://www.youtube.com/results?search_query=" + encodeURIComponent(normalizedQuery);
    const navigation = await this.navigate(target);
    if (!navigation.success) {
      return { success: false, query: normalizedQuery, results: [], url: navigation.url, title: navigation.title, error: navigation.error };
    }

    try {
      const page = await this.getPage();
      await page.waitForSelector("ytd-video-renderer, ytd-rich-item-renderer", { timeout: 10000 });
      const rawResults = await page.locator("a#video-title").evaluateAll((anchors) =>
        anchors.map((anchor) => ({
          title: (anchor.getAttribute("title") || anchor.textContent || "").trim(),
          href: anchor.getAttribute("href") || "",
        })).filter((item) => item.title.length > 0 && item.href.startsWith("/watch"))
      );
      const results = rawResults.map((item) => ({
        title: item.title,
        url: new URL(item.href, "https://www.youtube.com").toString(),
      })).filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index).slice(0, 10);

      if (results.length === 0) {
        return { success: false, query: normalizedQuery, results, url: page.url(), title: await page.title(), error: "YouTube loaded, but no visible video results could be verified." };
      }
      return { success: true, query: normalizedQuery, results, url: page.url(), title: await page.title() };
    } catch (error) {
      const page = await this.getPage().catch(() => null);
      return {
        success: false,
        query: normalizedQuery,
        results: [],
        url: page?.url() || navigation.url,
        title: page ? await page.title().catch(() => "") : navigation.title,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async searchAndPlayYouTube(query: string): Promise<{
    success: boolean;
    query: string;
    url: string;
    title: string;
    playbackVerified: boolean;
    video?: { paused: boolean; currentTime: number; readyState: number };
    error?: string;
  }> {
    const search = await this.searchYouTube(query);
    const candidate = search.results[0];
    if (!search.success || !candidate) {
      return {
        success: false, query, url: search.url, title: search.title, playbackVerified: false,
        error: search.error || "No YouTube result could be verified.",
      };
    }

    try {
      const page = await this.getPage();
      await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector("video", { timeout: 10000 });
      let playbackAttempted = false;
      try {
        playbackAttempted = await page.locator("video").evaluate(async (element) => {
          const video = element as HTMLVideoElement;
          try { await video.play(); return true; } catch { return false; }
        });
      } catch { /* an observed failed attempt is not success */ }

      if (!playbackAttempted) {
        try {
          await page.locator(".ytp-large-play-button").click({ timeout: 1500 });
          playbackAttempted = true;
        } catch { /* no visible play button */ }
      }
      await page.waitForTimeout(1800);
      const video = await page.locator("video").evaluate((element) => {
        const media = element as HTMLVideoElement;
        return { paused: media.paused, currentTime: media.currentTime, readyState: media.readyState };
      });
      const playbackVerified = !video.paused && video.currentTime > 0.25 && video.readyState >= 2;
      return {
        success: playbackVerified,
        query,
        url: page.url(),
        title: await page.title(),
        playbackVerified,
        video,
        error: playbackVerified ? undefined : "The result opened, but video playback was not observed to advance.",
      };
    } catch (error) {
      const page = await this.getPage().catch(() => null);
      return {
        success: false,
        query,
        url: page?.url() || candidate.url,
        title: page ? await page.title().catch(() => "") : candidate.title,
        playbackVerified: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async verifyPageState(url: string, expectedText: string): Promise<{ success: boolean; found: boolean; url: string; title: string; error?: string }> {
    let page: Page;
    if (url.trim()) {
      const nav = await this.navigate(url);
      if (!nav.success) return { success: false, found: false, url: nav.url, title: nav.title, error: nav.error };
      page = await this.getPage();
    } else {
      try { page = await this.getPage(); }
      catch (error) { return { success: false, found: false, url: "", title: "", error: error instanceof Error ? error.message : String(error) }; }
    }

    try {
      const content = await page.locator("body").innerText({ timeout: 5000 });
      return { success: true, found: content.includes(expectedText), url: page.url(), title: await page.title() };
    } catch (error) {
      return { success: false, found: false, url: page.url(), title: await page.title().catch(() => ""), error: error instanceof Error ? error.message : String(error) };
    }
  }

  async currentPageState(): Promise<{ success: boolean; url: string; title: string; error?: string }> {
    if (!this.page || this.page.isClosed()) {
      return { success: false, url: "", title: "", error: "No managed browser page has been opened yet." };
    }
    try {
      return { success: true, url: this.page.url(), title: await this.page.title() };
    } catch (error) {
      return { success: false, url: this.page.url(), title: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}

export const playwrightBrowserAgent = new PlaywrightBrowserAgent();
