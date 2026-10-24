# Desktop orb, background lifecycle, and wake word

## User interaction

- Vanessa starts as a transparent, always-on-top 90 × 90 circular orb, docked to the saved corner by default.
- Right-click the orb to cycle through four corners and four screen edges. The position is persisted to the user's application data.
- Left-click the orb to open the chat panel. It says “Start typing to chat, or say ‘Hey Vanessa’ to activate.” The settings button opens the existing full control center.
- Type a command and press Enter to send it through the same orchestrator request API used by the voice workflow. The reply is shown in chat and spoken using the available desktop/browser TTS path.
- Press Alt+Space to use push-to-talk. Esc remains the task cancellation shortcut.
- Closing or minimizing hides the orb to the tray instead of terminating the services. The tray menu can show the orb, open chat, or explicitly quit Vanessa.

## Voice flow

When a supported local Porcupine keyword model is configured, the voice service processes 16 kHz mono PCM locally until it detects the wake word. Audio frames in this background phase are not forwarded to the remote ASR provider. After detection, the service opens the ASR session and replays only a short, process-local pre-roll so the initial words around the wake phrase are not clipped. The ASR final transcript is submitted to the existing orchestrator; the response returns over the existing voice event/TTS path.

The wake word is reported as unavailable until all three of these are set up:

1. A Picovoice AccessKey in `PORCUPINE_ACCESS_KEY`.
2. A platform-compatible custom “Hey Vanessa” keyword model (`.ppn`) in `PORCUPINE_KEYWORD_PATHS`.
3. `VOICE_WAKE_PROVIDER=porcupine`.

The application does not silently fall back to cloud-transcript wake detection. This keeps idle microphone audio local. Without a custom model/key, click-to-chat and push-to-talk remain usable, and the chat displays the reason the wake word is not ready.

Official setup references:
- [Porcupine Node.js API](https://picovoice.ai/docs/api/porcupine-nodejs/)
- [Porcupine Node.js quick start](https://picovoice.ai/docs/quick-start/porcupine-nodejs/)

## YouTube and agent routing

Explicit commands like “Hey Vanessa, open YouTube and search for jazz piano” are routed by the planner to the reviewed Browser Agent action. The Browser Agent builds a URL on the fixed `https://www.youtube.com/results` origin, URL-encodes the search term, and opens the default system browser. A successful OS launch is reported as an open, not a claim that a video has started playing.

Local file requests retain the Folder → Browser/File/Coding handoff introduced in the agent workflow pull request. Coding tasks remain behind the existing permission/approval flow.

## Installed Windows app

The packaged NSIS installer deploys production-only orchestrator and voice-agent dependency trees, bundles Node.js and the default skills/config, writes runtime logs to the user's application-data folder, and starts the local services on loopback. Provider credentials are loaded from a per-user `.env` file under the app's `userData` directory; installer defaults do not contain secrets. The installer is not code-signed by this workflow yet.

## Build and test locally

    pnpm install
    pnpm --filter @vanessa/shared build
    pnpm --filter @vanessa/orchestrator build
    pnpm --filter @vanessa/voice-agent build
    pnpm --filter @vanessa/desktop build
    pnpm --filter @vanessa/orchestrator test:agent-routing
    pnpm --filter @vanessa/voice-agent test:wake-word
    pnpm --filter @vanessa/desktop test:docking

To build the Windows installer, the release workflow prepares the production runtime under `apps/desktop/runtime` and then runs `pnpm --filter @vanessa/desktop build:installer`. Create a tag like `desktop-v0.1.1` to build and publish the Windows installer. Or run the workflow manually to create a downloadable CI artifact without publishing a release.