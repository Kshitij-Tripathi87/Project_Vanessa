export type BrowserIntentContext =
  | { kind: "exact_url"; url: string; play: boolean; canShortCircuit: boolean; conflictingIntent: boolean }
  | { kind: "youtube_home" }
  | { kind: "youtube_search"; query: string }
  | { kind: "youtube_play"; query: string }
  | { kind: "web_search"; query: string; engine: "google" | "bing" }
  | { kind: "none" };

export type RequestDomain =
  | "browser"
  | "system"
  | "developer"
  | "files"
  | "cloud"
  | "incident"
  | "memory"
  | "knowledge"
  | "testing"
  | "general";

export type TargetDeviceKind =
  | "origin_device"
  | "paired_pc"
  | "paired_mobile"
  | "specific_device"
  | "unspecified";

export interface ContextualizationOptions {
  source?: string;
  originDeviceId?: string;
  targetDeviceId?: string;
}

export interface NormalizedRequestContext {
  schemaVersion: "1.0";
  originalCommand: string;
  domains: RequestDomain[];
  primaryDomain: RequestDomain;
  targetDevice: {
    kind: TargetDeviceKind;
    deviceId?: string;
    reason: string;
  };
  browser: BrowserIntentContext;
  entities: {
    url?: string;
    searchQuery?: string;
    videoQuery?: string;
    targetApp?: string;
  };
  notes: string[];
}

export function extractExplicitHttpUrl(command: string): string | undefined {
  const match = command.match(/https?:[^\s<>"']+/i);
  if (!match) return undefined;
  const candidate = match[0].replace(/[.,!?;:]+$/g, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function isYouTubeWatchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname) &&
        parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"))) ||
      (parsed.hostname === "youtu.be" && parsed.pathname.length > 1)
    );
  } catch {
    return false;
  }
}

function youtubeSearchQuery(command: string): string {
  let query = command.match(/\bsearch\s+(.+?)(?:[.!?]*)$/i)?.[1] || "";
  query = query
    .replace(/^\s*(?:on\s+)?(?:youtube\s+)?(?:for\s+)?/i, "")
    .replace(/\s+(?:on|in)\s+youtube\b.*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  return query;
}

function youtubePlaybackQuery(command: string): string {
  const query = command.match(/\b(?:play|watch|listen to)\s+(.+?)(?:\s+(?:on|in)\s+youtube)?[.!?]*$/i)?.[1] ||
    command.match(/\b(?:find|open)\b.*?\bvideo\b(?:\s+(?:about|on|for)\s+)?(.+?)(?:\s+on\s+youtube)?[.!?]*$/i)?.[1] ||
    "";
  return query
    .replace(/^(?:(?:a|the)\s+)?(?:latest\s+)?(?:video|song|clip)\s+(?:about|on|for)\s+/i, "")
    .replace(/^(?:me\s+)?(?:a\s+|the\s+)?/i, "")
    .replace(/\s+(?:on|in)\s+youtube\b.*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function genericSearch(command: string): { query: string; engine: "google" | "bing" } | undefined {
  const match = command.match(/\bsearch\s+(?:(google|bing)\s+)?(?:for\s+)?(.+?)[.!?]*$/i);
  if (!match) return undefined;
  const engine = (match[1] || "google").toLowerCase() as "google" | "bing";
  const query = (match[2] || "").replace(/\s+(?:on|in)\s+(?:google|bing)$/i, "").trim();
  if (!query) return undefined;
  return { query, engine };
}

/**
 * Resolve browser-specific semantics only. This function never executes tools or grants permissions.
 */
export function contextualizeBrowserRequest(command: string): BrowserIntentContext {
  const lower = command.toLowerCase();
  const explicitUrl = extractExplicitHttpUrl(command);
  const directOpenIntent = /\b(open|go to|navigate to|visit|load)\b/.test(lower);
  const directPlayIntent = /\b(play|watch)\b/.test(lower) && Boolean(explicitUrl && isYouTubeWatchUrl(explicitUrl));
  const conflictingIntent = /\b(search|summari[sz]e|extract|download|compare|read the page)\b/.test(lower);
  const commandWithoutUrl = explicitUrl ? lower.replace(explicitUrl.toLowerCase(), "") : lower;
  const compoundIntent = /\b(and then|then|also|and)\b/.test(commandWithoutUrl);

  if (explicitUrl && (directOpenIntent || directPlayIntent)) {
    return {
      kind: "exact_url",
      url: explicitUrl,
      play: directPlayIntent,
      canShortCircuit: !conflictingIntent && !compoundIntent,
      conflictingIntent,
    };
  }

  const openingHome = /\b(?:open|go to|visit|launch)\s+(?:the\s+)?youtube\b/.test(lower);
  const wantsSearch = /\bsearch\b/.test(lower);
  const wantsPlayback = /\b(play|watch|listen to)\b/.test(lower) ||
    /\bfind\b.*\bvideo\b/.test(lower) ||
    /\bopen\s+(?:(?:me|this|that)\s+)?(?:the\s+|a\s+)?video\b/.test(lower);
  const targetsYoutubeSearch =
    /\bsearch\s+(?:on\s+)?youtube\b/.test(lower) ||
    /\bsearch\b.*\bon\s+youtube\b/.test(lower) ||
    /\byoutube\b.*\bsearch\s+for\b/.test(lower);
  const targetsYoutubePlayback =
    /\b(?:play|watch|listen to|find|open)\b.*\byoutube\b/.test(lower) ||
    /\byoutube\b.*\b(?:play|watch|find|open)\b/.test(lower);
  const mentionsAnotherVideoPlatform = /\b(?:vimeo|netflix|tiktok|dailymotion|twitch|spotify|soundcloud|apple music)\b/.test(lower);
  const refersToLocalVideo = /\b(?:video file|local video|downloaded video|mp4 file|from downloads|on my pc)\b/.test(lower);
  const implicitYoutubePlayback = wantsPlayback && !mentionsAnotherVideoPlatform && !refersToLocalVideo;
  const targetsYouTube = openingHome ||
    (wantsSearch && targetsYoutubeSearch) ||
    (wantsPlayback && (targetsYoutubePlayback || implicitYoutubePlayback));

  if (targetsYouTube) {
    if (wantsSearch && !wantsPlayback) {
      const query = youtubeSearchQuery(command);
      return query ? { kind: "youtube_search", query } : { kind: "none" };
    }
    if (wantsPlayback) {
      const query = youtubePlaybackQuery(command);
      return query ? { kind: "youtube_play", query } : { kind: "none" };
    }
    return { kind: "youtube_home" };
  }

  const search = genericSearch(command);
  if (search) return { kind: "web_search", ...search };
  return { kind: "none" };
}

function inferDomains(command: string, browser: BrowserIntentContext): RequestDomain[] {
  const lower = command.toLowerCase();
  const domains: RequestDomain[] = [];
  const add = (domain: RequestDomain) => {
    if (!domains.includes(domain)) domains.push(domain);
  };

  if (browser.kind !== "none") add("browser");
  if (/\b(investigate|incident|root cause|outage|service failing|http 500|\b500 errors?\b|stack trace|production issue)\b/.test(lower)) {
    add("incident");
    add("it-ops" as RequestDomain);
  }
  if (/\b(wi-?fi|bluetooth|volume|adapter|screenshot|system settings|restart my (?:pc|computer)|open app|close app)\b/.test(lower)) add("system");
  if (/\b(claude code|vs code|vscode|visual studio code|coding agent|build (?:me )?(?:an? )?app|write code|git (?:status|diff|branch|commit|pull)|run tests|unit tests|regression test)\b/.test(lower)) add("developer");
  if (/\b(file|folder|directory|zip|archive|rename|organize|documents folder|project files)\b/.test(lower)) add("files");
  if (/\b(gmail|e-?mail|whatsapp|google drive|drive upload|send (?:a )?message|upload .*drive|share link)\b/.test(lower)) add("cloud");
  if (/\b(remember|recall|what did i (?:say|decide|ask)|what do you remember|previous task|past incident)\b/.test(lower)) add("memory");
  if (/\b(runbook|documentation|docs|procedure|policy document|technical note)\b/.test(lower)) add("knowledge");
  if (/\b(test|tests|verify|verification|regression suite|acceptance criteria)\b/.test(lower)) add("testing");

  if (!domains.length) add("general");
  return domains;
}

function inferTargetDevice(command: string, options: ContextualizationOptions): NormalizedRequestContext["targetDevice"] {
  if (options.targetDeviceId) {
    return {
      kind: "specific_device",
      deviceId: options.targetDeviceId,
      reason: "A validated target device was supplied by the command envelope.",
    };
  }

  const lower = command.toLowerCase();
  const source = (options.source || "").toLowerCase();
  const fromPhone = /phone|mobile|pwa|ios|android/.test(source);

  const asksForPc = /\b(?:on|to|run on|execute on|at)\s+(?:my\s+)?(?:laptop|pc|desktop|computer|workstation)\b/.test(lower) ||
    /\bmy (?:laptop|pc|desktop|workstation)\b/.test(lower) && /\b(run|execute|open|start|on|at|to)\b/.test(lower);
  const asksForPhone = /\b(?:on|to|run on|execute on)\s+(?:my\s+)?(?:phone|mobile|iphone|android)\b/.test(lower) ||
    /\bthis phone\b/.test(lower);

  if (asksForPc) {
    return {
      kind: fromPhone ? "paired_pc" : "origin_device",
      reason: fromPhone
        ? "The phone command explicitly targets a computer; route it to the paired PC."
        : "The command names a computer target in a desktop-originated session.",
    };
  }
  if (asksForPhone) {
    return {
      kind: fromPhone ? "origin_device" : "paired_mobile",
      reason: fromPhone
        ? "The command explicitly targets this phone."
        : "The desktop-originated command explicitly targets a paired phone.",
    };
  }
  if (source) return { kind: "origin_device", reason: "No other target was stated; prefer the device that originated the request." };
  return { kind: "unspecified", reason: "The source device is unknown; choose only after capability and device context is resolved." };
}

/**
 * Cross-agent contextualization. Produces hints for the planner, but never executes tools or grants permissions.
 */
export function contextualizeRequest(command: string, options: ContextualizationOptions = {}): NormalizedRequestContext {
  const browser = contextualizeBrowserRequest(command);
  const domains = inferDomains(command, browser);
  const primaryPriority: RequestDomain[] = ["incident", "system", "developer", "cloud", "files", "browser", "memory", "knowledge", "testing", "general"];
  const primaryDomain = primaryPriority.find((candidate) => domains.includes(candidate)) || "general";

  const entities: NormalizedRequestContext["entities"] = {};
  if (browser.kind === "exact_url") entities.url = browser.url;
  if (browser.kind === "web_search" || browser.kind === "youtube_search") entities.searchQuery = browser.query;
  if (browser.kind === "youtube_play") entities.videoQuery = browser.query;

  const appMatch = command.match(/\b(?:open|launch|start)\s+(chrome|edge|firefox|vscode|visual studio code|claude code|notepad|calculator)\b/i);
  if (appMatch?.[1]) entities.targetApp = appMatch[1];

  const notes: string[] = [];
  if (browser.kind === "exact_url") {
    notes.push(browser.canShortCircuit
      ? "Exact URL request is unambiguous and may bypass LLM URL guessing."
      : "Exact URL is present in a compound/conflicting request; preserve it while planning remaining work.");
  }
  if (browser.kind === "youtube_search") notes.push("YouTube search results are not playback.");
  if (browser.kind === "youtube_play") notes.push("Video playback must be verified before claiming it started.");
  if (domains.includes("incident")) notes.push("Read-only evidence collection should precede any code modification.");
  if (domains.includes("cloud")) notes.push("External sends/uploads require policy evaluation and may require approval.");
  if (domains.includes("system") && /wi-?fi|network adapter/i.test(command)) {
    notes.push("Network changes may interrupt relay connectivity; persist task state before execution.");
  }

  return {
    schemaVersion: "1.0",
    originalCommand: command,
    domains,
    primaryDomain,
    targetDevice: inferTargetDevice(command, options),
    browser,
    entities,
    notes,
  };
}
