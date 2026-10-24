# Vanessa Windows & Browser Control Deck

## Product intent

The floating orb remains Vanessa's primary, low-friction entry point. The gear icon opens the larger Control Center; **Windows & Browser** is its default tab. The control deck is for operating the user's computer, not for making the coding agent the centre of the product.

## Browser execution paths

Vanessa deliberately has two browser modes:

- **System browser launch:** opening a URL or submitting a Google/YouTube search launches the operating-system default browser, unless the user explicitly chooses Chrome or Edge. The backend validates the HTTP(S) URL, rejects embedded credentials, and applies the DNS-aware local/private-host policy before launch.
- **Vanessa automation session:** page inspection, extracted text, and approved Playwright interactions run in Vanessa's separate browser context. That context is not automatically logged in to the user's Chrome/Edge profile.

A successful system-browser launch means Windows/macOS/Linux accepted the launch request. It does not mean that the page finished loading, that search results were inspected, or that a video began playing. The UI and task result must preserve that distinction.

Explicit browser selection is passed through reviewed action parameters. The accepted values are `chrome` and `edge`; user-provided executable names are never executed directly. For example, “Open Chrome and search Google for TypeScript tutorials” is routed to one browser-search task whose target is Chrome, not a Chrome launch plus an unrelated default-browser search.

## Windows operations

The Windows Agent currently supports:

- Launching known applications/utilities such as File Explorer, Chrome, Edge, Calculator, Notepad, Windows Terminal, Task Manager, Settings, and VS Code.
- Reading Wi-Fi adapter status and attempting a restart with post-operation adapter-status verification.
- Enabling/disabling Bluetooth only when Windows reports that the requested radio state was accepted and the observed state matches.
- Setting the default playback endpoint's master volume through Core Audio and reading it back.
- Setting or adjusting WMI-controllable display brightness and verifying the reported values.
- Capturing a primary-display screenshot to a temporary file.
- Requesting process termination and checking whether the process remains.

Support depends on the machine. Bluetooth availability/permissions vary by hardware and Windows state; WMI brightness may not be exposed by external monitors or GPU/display drivers. A Wi-Fi adapter status of `Up` is not proof that the internet is reachable. The agent must report these limitations rather than synthesizing success.

## Multi-action planning

A compound command is split deterministically only when every clause maps to a reviewed Windows or browser action. Independent actions can share a dependency group; “then” or “after that” starts a new group that depends on the previous group. If any clause is not recognized, the deterministic shortcut declines the whole sentence and the full planner handles it; Vanessa must not silently execute only the first part.

Examples covered by route contracts:

- “Turn off Bluetooth and increase brightness”
- “Turn off Bluetooth then increase brightness”
- “Open Chrome and search Google for TypeScript tutorials”
- “Open Edge then open https://example.com”

## Execution truth and safety

- `FAKE=1` must never call Windows APIs or launch applications. Simulated results are marked partial and unverified.
- OS launch acceptance, requested state, observed state, and task verification are distinct fields. Do not label an action verified unless the relevant state was actually observed.
- Invalid browser schemes, embedded credentials, and local/private browser destinations are rejected by the browser policy unless the existing explicit local-development opt-in is enabled.
- Browser clicks with consequential side effects remain high risk and require the configured approval policy.
- The UI requests status and folder-policy information through the Electron preload/main-process bridge; it must not hardcode a particular user's profile folder or claim that a service is online without a runtime health response.

## Real-Windows acceptance checklist

Run these checks on a Windows machine with the actual application and audio/display hardware. CI can validate TypeScript, routing contracts, injected-failure paths, and installer packaging; it cannot prove a physical radio, display, microphone, or user-visible browser window changed.

1. Open the Control Center from the orb gear; confirm the Windows & Browser tab is selected by default and the service badge reflects the live health endpoint.
2. Open `https://example.com` using System default, then repeat with Chrome and Edge selected. Confirm the actual window/browser and address bar. Test a rejected `javascript:` URL and embedded-credential URL; neither should launch.
3. Search for a distinct phrase using System default, Chrome, then Edge. Confirm the right browser is used and that Vanessa doesn't claim results were extracted.
4. Turn Bluetooth off/on where the radio API is available. Compare Vanessa's result with Windows Settings / the actual radio state. An unavailable or denied transition must be reported as failure.
5. Set volume to 20%, 50%, and 80%, then inspect Windows' master-volume level. It should report completion only when Core Audio read-back matches within tolerance.
6. Adjust brightness up/down on a WMI-capable built-in display. Test an unsupported external display; failure must be visible rather than reported as success.
7. Run “Turn off Bluetooth and increase brightness” and “Turn off Bluetooth then increase brightness”; verify independent vs dependent task groups in the Active Task DAG.
8. Build and install the packaged Windows installer, launch it, and confirm the orb, tray, main window, command bridge, status refresh, and kill switch work after installation, not only in development.
