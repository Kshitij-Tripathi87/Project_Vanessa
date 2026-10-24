# Issue 18 — Windows desktop and agent-handoff acceptance

This checklist is a manual release gate for a real Windows 11 machine. Linux CI and a Windows installer smoke test do not prove microphone, wake-word, visible UI, OS browser launch, or physical hardware behavior.

## Before starting

- [ ] Install the exact Windows installer artifact from the candidate PR's Windows release workflow.
- [ ] Record the installer version and commit SHA.
- [ ] Keep \`FAKE\` unset for live checks. Never paste provider keys into issues, logs, screenshots, or commits.
- [ ] Configure the local Picovoice AccessKey and Windows-compatible custom \`.ppn\` model for “Hey Vanessa” if wake-word testing is in scope.
- [ ] Confirm microphone permission and select the intended microphone and speaker.

## Desktop shell

- [ ] Launch Vanessa and verify the default floating orb is visible and remains above ordinary windows.
- [ ] Click the orb and verify the chat panel opens with the expected activation guidance.
- [ ] Verify the tray can show/hide the UI and that explicit Quit exits the app.
- [ ] Press Alt+Space and verify push-to-talk starts, captures one command, and returns to idle.
- [ ] Dock the orb to each supported corner/edge; restart Vanessa and verify the selected docking preference persists.
- [ ] With the wake model configured, verify a bare “Hey Vanessa” activates the follow-on listening window.
- [ ] Verify cancellation and microphone-denied paths return to an idle/recoverable state and display an honest error.
- [ ] Verify idle pre-wake audio stays local and is not forwarded to cloud ASR before wake activation.

## Browser Agent

- [ ] Ask Vanessa to open an explicit HTTPS URL. Confirm the system default browser receives it.
- [ ] Ask Vanessa to search YouTube for a query containing punctuation (for example, \`lo-fi & jazz + focus\`). Confirm the search terms are encoded correctly.
- [ ] Verify Vanessa distinguishes “the OS accepted the browser launch” from “the page loaded” and from “video playback started.”
- [ ] Test a machine with no configured default browser, or use the injected opener failure test in CI; the task must fail and must not emit success evidence.
- [ ] Test a launch timeout/OS error using the injected opener or a controlled test adapter; the task must fail with an actionable summary.
- [ ] Confirm URL handling rejects non-HTTP(S) schemes, embedded credentials, and local/private destinations unless the explicit local-development opt-in is enabled.
- [ ] Confirm user text is passed as data/arguments, never interpolated into a shell command.

## Folder/File/Coding handoff

Use a disposable approved test directory containing a source file, \`README.md\`, \`config.json\`, \`sample.csv\`, and \`index.html\`.

- [ ] “Open the test project folder” -> Folder Agent / Explorer.
- [ ] “Fix the bug in \`sample.ts\`” -> Coding Agent handoff with the existing approval gate.
- [ ] “Edit \`README.md\`” or “modify \`config.json\`” -> Coding Agent, despite the non-source extension.
- [ ] “Preview \`index.html\` in the browser” -> Browser Agent.
- [ ] “Explain \`sample.ts\`”, “summarize \`config.json\`”, and “analyze \`sample.csv\`” -> File Agent for supported formats.
- [ ] Combine two operations in one request and verify dependent task order and approval gates remain intact.
- [ ] Verify an ambiguous request asks for clarification or remains with the normal planner rather than launching an arbitrary agent.
- [ ] Verify \`..\` traversal, disallowed absolute paths, and symlink escapes are rejected.
- [ ] Verify unsupported binary/document formats are reported as unsupported rather than falsely summarized.
- [ ] Verify OS launch acknowledgements are described as launch requests, not proof that a human viewed the file.

## Evidence to attach to the PR

- Commit SHA and installer artifact/run URL.
- CI run links and test summaries.
- A short checklist result for each desktop, browser, and routing section.
- Redacted screenshots or logs only; never include AccessKeys, tokens, or private file contents.

## Pass/fail rule

Merge only after the candidate branch's automated build/tests pass and the applicable live Windows checks are recorded. If live hardware or wake-word prerequisites are unavailable, leave that gate explicitly **not verified**; do not convert it to a pass based on simulation or Linux CI.
