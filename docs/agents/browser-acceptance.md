# Browser and YouTube Acceptance Matrix

These are release gates. Run deterministic intent tests and separately run real Windows browser acceptance tests.

| Command | Required result |
|---|---|
| “Open YouTube” | Navigate to YouTube homepage, not generic search |
| “Open https://example.com/path?q=1” | Preserve path/query; verify actual page URL |
| “Search YouTube for lo-fi music” | Render results; response says results opened |
| “Find a Python async video and play it” | Select relevant result, open watch page and verify playback or honestly report a block |
| “Open this video” plus URL | Navigate directly to the supplied URL |
| Autoplay blocked | Partial result; explain a click is required |
| Multiple equally plausible videos | Ask which result |
| Offline/DNS/404 | Fail or partial based on what happened; never say success |
| FAKE mode | Explicitly simulated; excluded from live acceptance score |
| javascript/data/unexpected scheme | Reject before navigation |

## Implementation/testing guidance
Use a controlled Playwright context or supported CDP attachment. A Start-Process success is not DOM verification. If Playwright is added, update package manifest, lockfile, browser setup instructions and cleanup. Do not store cookies/tokens in artifacts. Avoid taking screenshots of private pages unless required and scrub sensitive content.
