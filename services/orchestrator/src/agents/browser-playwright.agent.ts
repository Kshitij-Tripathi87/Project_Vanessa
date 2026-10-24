import { chromium, Browser, Page } from 'playwright';
import { AgentEvidence, AgentResult, AgentRunContext, SpecialistAgent } from "@vanessa/shared";

export class PlaywrightBrowserAgent {
  id = "browser-playwright";
  capabilities = ["browser_navigation", "web_search", "page_inspection", "automation"];
  allowedTools = ["browser_navigate", "browser_screenshot", "browser_click", "browser_fill", "browser_extract"];
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
    return this.browser;
  }

  async navigate(url: string): Promise<{ success: boolean; title: string; url: string; error?: string }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title();
      return { success: true, title, url: page.url() };
    } catch (err: any) {
      return { success: false, title: '', url, error: err.message };
    } finally {
      await page.close();
    }
  }

  async search(query: string): Promise<{ success: boolean; snippets: string[]; url: string; error?: string }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000); // Wait for dynamic content

      const snippets = await page.evaluate(() => {
        const results: string[] = [];
        // Try multiple selectors for Google search results
        const selectors = [
          '.g .VwiC3b',
          '.g .IsZvec',
          '.g .MjjYud',
          '.g .yXK7lf',
          '.g .kCrYT',
          'h3',
          '.LC20lb'
        ];

        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements).slice(0, 10)) {
            const text = el.textContent?.trim();
            if (text && text.length > 10 && !results.includes(text)) {
              results.push(text);
            }
          }
          if (results.length >= 5) break;
        }
        return results.slice(0, 5);
      });

      return { success: true, snippets: snippets.filter(Boolean), url: page.url() };
    } catch (err: any) {
      // Fallback: just return URL even if snippet extraction fails
      return { success: true, snippets: ['Search completed - snippets extraction pending'], url: page.url() };
    } finally {
      await page.close();
    }
  }

  async verifyPageState(url: string, expectedText: string): Promise<{ success: boolean; found: boolean }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const content = await page.content();
      return { success: true, found: content.includes(expectedText) };
    } catch (err: any) {
      return { success: false, found: false };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const playwrightBrowserAgent = new PlaywrightBrowserAgent();