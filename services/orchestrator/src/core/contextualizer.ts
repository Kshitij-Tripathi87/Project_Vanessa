export type BrowserIntentContext =
  | { kind: "exact_url"; url: string; play: boolean; canShortCircuit: boolean; conflictingIntent: boolean }
  | { kind: "youtube_home" }
  | { kind: "youtube_search"; query: string }
  | { kind: "youtube_play"; query: string }
  | { kind: "web_search"; query: string; engine: "google" | "bing" }
  | { kind: "none" };

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
  let query = command.match(/\b(?:play|watch|listen to)\s+(.+?)(?:\s+(?:on|in)\s+youtube)?[.!?]*$/i)?.[1] ||
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
 * Contextualize a committed voice/text request before planning.
 * This stage only resolves intent/entities; it never executes tools or grants permissions.
 */
export function contextualizeBrowserRequest(command: string): BrowserIntentContext {
  const lower = command.toLowerCase();
  const explicitUrl = extractExplicitHttpUrl(command);
  const directOpenIntent = /\b(open|go to|navigate to|visit|load)\b/.test(lower);
  const directPlayIntent = /\b(play|watch)\b/.test(lower) && Boolean(explicitUrl && isYouTubeWatchUrl(explicitUrl));
  const conflictingIntent = /\b(search|summari[sz]e|extract|download|compare|read the page)\b/.test(lower);
  const commandWithoutUrl = explicitUrl ? lower.replace(explicitUrl.toLowerCase(), "") : lower;
  const compoundIntent = /\b(and then|then|also|and)\b/.test(commandWithoutUrl);

  // Exact URL requests take precedence over search heuristics.
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
  const mentionsAnotherVideoPlatform = /\b(?:vimeo|netflix|tiktok|dailymotion|twitch)\b/.test(lower);
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
