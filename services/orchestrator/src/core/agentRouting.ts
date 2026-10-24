export type ResourceWorkflowIntent = "open" | "code" | "browser" | "analysis";

export interface ResourceWorkflowRequest {
  target: string;
  intent: ResourceWorkflowIntent;
}

const KNOWN_EXTENSION = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|cs|cpp|c|h|hpp|php|rb|swift|kt|scala|sql|sh|ps1|bat|cmd|html|htm|xhtml|css|scss|vue|svelte|json|md|txt|csv|log|pdf|xlsx|xls|docx|doc|pptx|ppt|yaml|yml|toml|xml|ini|cfg|env|png|jpe?g|webp|gif|bmp|svg)$/i;
const CODE_EXTENSION = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|cs|cpp|c|h|hpp|php|rb|swift|kt|scala|sql|sh|ps1|bat|cmd|html|htm|xhtml|css|scss|vue|svelte)$/i;
const HTML_EXTENSION = /\.(?:html?|xhtml)$/i;

function cleanTarget(value: string): string {
  return value.trim().replace(/^[,;:]+|[,;:]+$/g, "").trim();
}

/** Extract a local target only when the command contains an identifiable file, path, or named folder. */
export function extractResourceTarget(command: string): string | null {
  const searchable = command.replace(/https?:\/\/[^\s"']+/gi, " ");
  const namedMatch = searchable.match(/\b(?:file|folder|directory|project|document)\s+(?:named|called)\s+["']([^"'\r\n]+)["']/i);
  if (namedMatch?.[1]) return cleanTarget(namedMatch[1]);

  const quotedMatches = [...searchable.matchAll(/["']([^"'\r\n]{1,240})["']/g)];
  for (const match of quotedMatches) {
    const candidate = cleanTarget(match[1] || "");
    if (candidate && (KNOWN_EXTENSION.test(candidate) || /[\\/]/.test(candidate))) return candidate;
  }

  const windowsPath = searchable.match(/[A-Za-z]:\\[^\s"'<>|?*]+/);
  if (windowsPath?.[0]) return cleanTarget(windowsPath[0]);

  const pathMatches = [...searchable.matchAll(/(?:\.{1,2}[\\/])?[A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)+/g)];
  for (const match of pathMatches) {
    const candidate = cleanTarget(match[0]);
    if (candidate && !/^https?:/i.test(candidate)) return candidate;
  }

  const fileMatches = [...searchable.matchAll(/\b[A-Za-z0-9_@.-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|cs|cpp|c|h|hpp|php|rb|swift|kt|scala|sql|sh|ps1|bat|cmd|html|htm|xhtml|css|scss|vue|svelte|json|md|txt|csv|log|pdf|xlsx|xls|docx|doc|pptx|ppt|yaml|yml|toml|xml|ini|cfg|env|png|jpe?g|webp|gif|bmp|svg)\b/gi)];
  if (fileMatches.length > 0) return cleanTarget(fileMatches[0][0]);

  const namedFolder = searchable.match(/\b(?:open|find|locate|read|inspect|analy[sz]e|summari[sz]e|fix|edit|modify|debug|preview|view)\s+(?:my\s+|the\s+|this\s+|that\s+)?([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+){0,2})\s+(?:project\s+)?(?:folder|directory|project|document|file)\b/i);
  if (namedFolder?.[1]) {
    const candidate = cleanTarget(namedFolder[1]).replace(/\s+project$/i, "").trim();
    if (candidate && !/^(?:the|this|that|my|a|an)$/i.test(candidate)) return candidate;
  }
  return null;
}

/** Intent wins over extensions. Ambiguous requests stay with the normal planner. */
export function inferResourceWorkflow(command: string): ResourceWorkflowRequest | null {
  const target = extractResourceTarget(command);
  if (!target) return null;
  const lower = command.toLowerCase();

  const codeVerb = /\b(fix|debug|refactor|implement|patch|repair|modify|edit|change|update)\b/.test(lower);
  const codeIntent = /\b(code|coding|program|programming|bug|debug|refactor|implementation|feature)\b/.test(lower);
  if ((codeVerb && CODE_EXTENSION.test(target)) ||
      (codeIntent && /\b(?:project|code|program|bug|debug|refactor|implement|feature)\b/.test(lower))) {
    return { target, intent: "code" };
  }

  const browserIntent = /\b(browser|chrome|edge|firefox|preview|render|webpage|web\s+page|website preview)\b/.test(lower);
  if (browserIntent && HTML_EXTENSION.test(target)) return { target, intent: "browser" };

  const analysisIntent = /\b(read|check|summari[sz]e|analy[sz]e|explain|inspect|review|view|show me|compare|extract)\b/.test(lower);
  if (analysisIntent) return { target, intent: "analysis" };

  const openIntent = /\b(open|launch|locate|find|show)\b/.test(lower);
  if (openIntent) return { target, intent: "open" };
  return null;
}


export interface YouTubeSearchRequest {
  query: string;
}

/** Deterministically route explicit YouTube-search intents to the Browser Agent. */
export function inferYouTubeSearch(command: string): YouTubeSearchRequest | null {
  const normalized = String(command || "").trim().replace(/^\s*(?:(?:hey|hi|hello|okay|ok)\s+vanessa)[\s,.:;!?—-]*/i, "");
  if (!/\byoutube\b/i.test(normalized)) return null;

  const patterns = [
    /\b(?:open|launch|go\s+to|visit)\s+(?:www\.)?youtube(?:\.com)?\b[\s\S]{0,80}?\bsearch(?:\s+(?:for|on|me))?\s+(.+?)\s*$/i,
    /\bsearch\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+(?:www\.)?youtube(?:\.com)?\b/i,
    /\bsearch\s+(?:on\s+)?(?:www\.)?youtube(?:\.com)?\s+(?:for\s+)?(.+?)\s*$/i,
    /\bfind\s+(.+?)\s+(?:on|in)\s+(?:www\.)?youtube(?:\.com)?\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const query = match?.[1]
      ?.replace(/^\s*(?:for|about)\s+/i, "")
      .replace(/\s+(?:please|for me|thanks|thank you)\s*$/i, "")
      .replace(/[\s.!?]+$/g, "")
      .trim();
    if (query && query.length > 0 && query.length <= 500) return { query };
  }
  return null;
}


export interface BrowserNavigationRequest {
  url: string;
}

/**
 * Route only explicit navigation language with a real URL/domain to the Browser Agent.
 * It deliberately does not infer a destination from vague phrases such as "open Chrome".
 */
export function inferExplicitBrowserNavigation(command: string): BrowserNavigationRequest | null {
  const normalized = String(command || "")
    .trim()
    .replace(/^\s*(?:(?:hey|hi|hello|okay|ok)\s+vanessa)[\s,.:;!?—-]*/i, "");
  const verbs = /\b(?:open|visit|load|go\s+to|navigate\s+to)\s+(?:(?:the|this|that)\s+)?(?:(?:website|web\s+page|page|url|site)\s+)?/gi;
  for (const match of normalized.matchAll(verbs)) {
    const target = normalized.slice((match.index || 0) + match[0].length).trim();
    const explicit = target.match(/^(https?:\/\/[^\s"'<>]+)/i);
    const domain = target.match(/^((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\:\d{1,5})?(?:\/[^\s"'<>]*)?)/i);
    const captured = (explicit?.[1] || domain?.[1])?.replace(/[),.;!?]+$/g, "");
    if (!captured) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(captured) ? captured : "https://" + captured);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (url.username || url.password) continue;
      return { url: url.toString() };
    } catch {
      continue;
    }
  }
  return null;
}

export interface BrowserSearchRequest {
  query: string;
}

/** Deterministically route explicit general web-search requests, not general knowledge questions. */
export function inferBrowserSearch(command: string): BrowserSearchRequest | null {
  const normalized = String(command || "")
    .trim()
    .replace(/^\s*(?:(?:hey|hi|hello|okay|ok)\s+vanessa)[\s,.:;!?—-]*/i, "");
  const patterns = [
    /\bsearch\s+(?:google|the\s+web|the\s+internet|online)\s+for\s+(.+?)\s*$/i,
    /\bsearch\s+for\s+(.+?)\s+(?:on|using)\s+(?:google|the\s+web|the\s+internet)\s*$/i,
    /\bgoogle\s+(?:search\s+)?(?:for\s+)?(.+?)\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const query = match?.[1]
      ?.replace(/^\s*["']|["']\s*$/g, "")
      .replace(/\s+(?:please|for me|thanks|thank you)\s*$/i, "")
      .replace(/[\s.!?]+$/g, "")
      .trim();
    if (query && query.length > 0 && query.length <= 500) return { query };
  }
  return null;
}
