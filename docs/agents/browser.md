# Browser Agent Contract — Exact Navigation and Verified Web Actions

**ID:** browser. Current source: `services/orchestrator/src/agents/browser.agent.ts`. The inspected source launches Edge with PowerShell and cannot verify actual page state/playback. This document describes required behavior, not completed implementation.

## Actions
- `browser.open_url({url})`: validate and navigate to exact URL; preserve path/query; verify active/final URL and title when browser automation is connected.
- `browser.search({query, engine?})`: navigate to search results and report that results opened.
- `youtube.search({query})`: open YouTube results and verify results rendered.
- `youtube.open_video({url})`: open the supplied watch URL directly, without a search.
- `youtube.search_and_play({query, preferredTitle?, preferredChannel?})`: search, inspect results, choose a relevant video, open watch page and verify playback.
- `browser.read_page_state()`: return observed URL/title/load/error state, never placeholders.
- `browser.click/fill/extract`: act on observed elements and verify expected effect.

## Intent rules
“Open YouTube” means homepage. “Open this link” means exact URL. “Search YouTube for X” means results. “Find and play a video about X” means select → watch page → verify playback. “Open that video” means resolved/supplied URL, not a new search.

## YouTube verification
Results page is not a watch page; a watch page alone is not proof playback started. Verify player/video state and evidence currentTime advanced. If autoplay is blocked, return partial and explain a click is needed. Ask if candidates are ambiguous. Distinguish consent/login wall, removed video, network error and autoplay restrictions.

## Implementation target
Use a controlled Playwright context or explicit supported CDP attachment. A successful `Start-Process` is not DOM verification. If adding Playwright, update manifest, lockfile, browser setup and cleanup. Do not hijack the personal browser profile or launch an unexpected profile silently.

## Output
Return actual final URL, title, navigation/error status, chosen result metadata and playback state. Mark complete only when criteria pass. Never say “Playing X” after merely opening results.

## Acceptance tests
Exact URLs; YouTube homepage; search-only status; direct watch URL; relevant result selection; playback verification; autoplay-blocked partial result; unsafe URL rejection; navigation failure; FAKE mode clearly simulated.
