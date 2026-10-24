# Vanessa Agent Routing Workflow

## Responsibilities

Vanessa uses the existing reviewed planner catalog and permission-checked task runner; the added deterministic route activates only when a request contains a recognizable local file/folder target and an unambiguous operation.

- **Folder Agent** resolves the resource inside approved filesystem roots, classifies it, detects the nearest project root, and can open the resource with the desktop shell.
- **Developer/Coding handoff** receives the resolved project root and the current request. It remains under the existing approval gate. Launching a coding terminal is not evidence that code changes or tests completed.
- **Browser Agent** handles HTTP(S) navigation, rendered-page inspection, approved local HTML/XHTML previews, and explicit clicks. Local/private network access is denied by default; local development access requires BROWSER_ALLOW_LOCAL_URLS=true.
- **File Agent** reads bounded previews of supported text/source, JSON, and CSV files. The current preview cap is 256 KiB. PDF and Office document parsing are not included; the agent reports unsupported content formats rather than pretending to analyze them.

## Routing sequence

1. The router extracts a concrete target and classifies the user operation. Ordinary browser commands without a local file target remain with the standard planner.
2. Folder Agent resolves the target and returns a canonical target path, resource kind, and project root.
3. The specialist depends on the resolver result:
   - Code implementation/debugging: developer.codex.open with the resolved project root.
   - Local HTML/XHTML preview: browser.open_file with the resolved target path.
   - Passive supported-file analysis: files.file.inspect with the resolved target path.
   - Open-only request: folder.open.
4. TaskRunner resolves dependency references before applying the permission guard. Click actions are high risk and require confirmation. Agent-reported failures remain failures.

## Browser configuration

- BROWSER_HEADLESS defaults to true. Set it to false to request a visible Playwright browser on a machine with a desktop/browser runtime.
- PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH optionally points to a local Chromium-compatible executable. Otherwise, Playwright uses its managed Chromium.
- BROWSER_ALLOW_LOCAL_URLS=true opts in to local/private HTTP(S) navigation for trusted development sessions. Leave it disabled for general browsing.

The Playwright browser persists a context and page across agent actions. Remote navigation is restricted to HTTP(S), URL-embedded credentials are refused, and local/private targets are filtered before navigation and on routed requests.

## Verification

The agent-routing test script covers deterministic routing, dependency wiring, Folder Agent allowlist enforcement, bounded File Agent inspection, browser URL restrictions, and local URL opt-in. GitHub Actions builds the shared contracts and orchestrator, runs these tests, verifies catalog/handler consistency, and runs the existing Coding Agent launcher regression tests.
