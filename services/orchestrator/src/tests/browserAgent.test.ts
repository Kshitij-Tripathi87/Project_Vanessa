import assert from "node:assert/strict";
import type { BrowserDriver, BrowserPageState, YouTubeCandidate, VideoState } from "../agents/browserDriver.js";
import { BrowserAgent } from "../agents/browser.agent.js";

class FakeBrowserDriver implements BrowserDriver {
  calls: string[] = [];
  page: BrowserPageState = {
    url: "about:blank",
    title: "",
    readyState: "complete",
    httpStatus: 200,
  };
  candidates: YouTubeCandidate[] = [
    { title: "Python Async Tutorial for Beginners", url: "https://www.youtube.com/watch?v=abc123", channel: "Example Academy" },
  ];
  video: VideoState = {
    url: "https://www.youtube.com/watch?v=abc123",
    title: "Python Async Tutorial for Beginners",
    paused: true,
    currentTime: 0,
    readyState: 4,
  };
  playbackWillStart = false;

  async navigate(url: string): Promise<BrowserPageState> {
    this.calls.push(url);
    const isResults = url.includes("/results?search_query=");
    this.page = {
      url,
      title: isResults ? "YouTube Search" : url.includes("/watch") ? this.video.title : "Example page",
      readyState: "complete",
      httpStatus: 200,
    };
    return this.page;
  }

  async getPageState(): Promise<BrowserPageState> { return this.page; }
  async getYouTubeResults(): Promise<YouTubeCandidate[]> { return this.candidates; }
  async getVideoState(): Promise<VideoState> { return { ...this.video, url: this.page.url, title: this.page.title }; }
  async startVideoPlayback(): Promise<{ attempted: boolean; details: string }> {
    if (this.playbackWillStart) {
      this.video.paused = false;
      this.video.currentTime = 1.1;
      return { attempted: true, details: "Fake driver simulated a browser play click." };
    }
    return { attempted: true, details: "Fake driver simulated an autoplay block." };
  }
}

async function main() {
  const oldFake = process.env.FAKE;
  delete process.env.FAKE;
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "opens exact URL without converting to search",
      run: async () => {
        const driver = new FakeBrowserDriver();
        const agent = new BrowserAgent(driver);
        const result = await agent.execute("browser.open_url", { url: "https://example.com/path?q=1" });
        assert.equal(driver.calls.length, 1);
        assert.equal(driver.calls[0], "https://example.com/path?q=1");
        assert.equal(result.status, "completed");
        assert.equal((result.data as any).finalUrl, "https://example.com/path?q=1");
      },
    },
    {
      name: "YouTube search reports results, not playback",
      run: async () => {
        const driver = new FakeBrowserDriver();
        const agent = new BrowserAgent(driver);
        const result = await agent.execute("youtube.search", { query: "lo-fi music" });
        assert.ok(driver.calls[0]?.includes("youtube.com/results?search_query=lo-fi%20music"));
        assert.equal(result.status, "completed");
        assert.match(result.summary || "", /results/i);
        assert.doesNotMatch(result.summary || "", /playing/i);
      },
    },
    {
      name: "direct YouTube watch URL does not perform an intermediate search",
      run: async () => {
        const driver = new FakeBrowserDriver();
        const agent = new BrowserAgent(driver);
        const result = await agent.execute("youtube.open_video", { url: "https://www.youtube.com/watch?v=abc123" });
        assert.equal(driver.calls.length, 1);
        assert.equal(driver.calls[0], "https://www.youtube.com/watch?v=abc123");
        assert.equal(result.status, "completed");
        assert.match(result.summary || "", /Opened video page/i);
      },
    },
    {
      name: "search-and-play cannot claim success when playback was not observed",
      run: async () => {
        const driver = new FakeBrowserDriver();
        const agent = new BrowserAgent(driver);
        const result = await agent.execute("youtube.search_and_play", { query: "Python async tutorial" });
        assert.equal(driver.calls.length, 2);
        assert.ok(driver.calls[0].includes("/results?search_query="));
        assert.ok(driver.calls[1].includes("/watch?v=abc123"));
        assert.equal(result.status, "partial");
        assert.equal(result.success, false);
        assert.equal((result.data as any).playbackVerified, false);
        assert.match(result.spokenSummary, /didn't start/i);
      },
    },
    {
      name: "reports playback success only after video time advances",
      run: async () => {
        const driver = new FakeBrowserDriver();
        driver.playbackWillStart = true;
        const agent = new BrowserAgent(driver);
        const result = await agent.execute("youtube.search_and_play", { query: "Python async tutorial" });
        assert.equal(result.status, "completed");
        assert.equal(result.success, true);
        assert.equal((result.data as any).playbackVerified, true);
        assert.ok((result.data as any).video.currentTime > 0.25);
        assert.match(result.summary || "", /Playing/i);
      },
    },
    {
      name: "rejects unsafe URL schemes before browser navigation",
      run: async () => {
        const driver = new FakeBrowserDriver();
        const agent = new BrowserAgent(driver);
        const result = await agent.execute("browser.open_url", { url: "javascript:alert(1)" });
        assert.equal(driver.calls.length, 0);
        assert.equal(result.status, "failed");
        assert.equal(result.success, false);
      },
    },
  ];

  let failed = 0;
  for (const test of cases) {
    try {
      await test.run();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${test.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }
  if (oldFake !== undefined) process.env.FAKE = oldFake;
  console.log(`Browser agent tests: ${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
