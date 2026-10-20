---
name: youtube-playback
description: Open YouTube via browser, search for requested audio/video content, and start playback
agent: browser
locks:
  - browser-profile
---

# YouTube Playback Skill

## Objective
Search and play media on YouTube without disruptive manual navigation.

## Steps
1. Acquire `browser-profile` lock.
2. Format search URL: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`.
3. Navigate to YouTube via Playwright or default browser launcher.
4. Verify page navigation completed and video element initialized.
5. Release `browser-profile` lock.
