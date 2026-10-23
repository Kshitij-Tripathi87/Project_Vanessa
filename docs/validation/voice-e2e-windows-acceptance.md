# Vanessa voice-to-action acceptance runbook (Windows)

## Purpose

Use this runbook on the target Windows PC after installing the integrated voice/browser/OS branch. Automated contract tests use fake adapters; this runbook checks the microphone, live providers, visible Edge window, Bluetooth radio, display brightness and speaker output.

## 1. Prepare the machine

1. Start PowerShell in the Vanessa repository.
2. Confirm Node.js 22 and pnpm are available, then install dependencies:

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm readiness
```

3. Configure `.env` locally from `.env.example`. Supply valid provider/planner credentials locally; never commit `.env`, paste tokens into logs, or include them in screenshots.
4. For the live run, set `VOICE_ASR_PROVIDER=fish`, `VOICE_TTS_PROVIDER=fish`, and `VOICE_ALLOW_FALLBACK=false`. Ensure `FAKE` is unset or `FAKE=0`. Set `VANESSA_BROWSER_HEADLESS=0` to keep the browser visible on Windows; set `VANESSA_EDGE_PATH` only if Edge is installed outside its usual location.
5. Start the local services with `pnpm dev`. Confirm the voice provider reports ready before testing.

## 2. Automated regression gate

Run the same deterministic contracts used in CI:

```powershell
pnpm --filter @vanessa/shared build
pnpm --filter @vanessa/orchestrator build
pnpm --filter @vanessa/voice-agent build
pnpm test:browser-agent
pnpm test:windows-agent
pnpm test:compound-voice-plan
pnpm --filter @vanessa/voice-agent test
pnpm test:voice:pipeline-e2e
pnpm test:voice:recovery
pnpm --filter @vanessa/voice-agent test:behavior
```

Record the commit SHA and exit code for each command. Any failing gate blocks release.

## 3. Live speech loop

1. Confirm the microphone input device and Windows speaker output are the devices you intend Vanessa to use.
2. Say “Hey Vanessa” and confirm a response is audible.
3. Dictate a multi-clause request. Confirm the committed transcript retains normal command casing and URLs, and that partial transcripts do not execute actions.
4. Confirm the response is spoken only after the orchestrator returns a result. Repeat a normal user command and confirm it executes only once per utterance.
5. Interrupt the spoken response. Confirm speech stops promptly, a new user turn is accepted, and interruption does not silently cancel an already-running task.

## 4. OS and browser acceptance

Test each operation separately before the compound command:

- Say “Hey Vanessa, turn Bluetooth off.” Confirm the Windows radio read-back is Off. If no radio is detected or Windows denies the operation, Vanessa must report that it could not verify the state.
- Say “Hey Vanessa, set display brightness to 80 percent.” Confirm the monitor read-back is 80%. Some external monitors do not expose WMI brightness controls; on unsupported hardware, a clear failure is correct and must not be logged as success.
- Say “Hey Vanessa, open YouTube.com and search for a lo-fi study playlist.” Confirm the persistent, visible Edge page is at YouTube, search result titles/watch URLs are present, and Vanessa summarizes the results it observed.
- Ask Vanessa to play one of the results only as a separate command. Playback may be reported successful only after the video element is unpaused, ready and its playback time advances. Autoplay restrictions or blocked playback must be reported honestly.

## 5. Compound end-to-end acceptance

With the individual cases passing, say:

> “Hey Vanessa, turn off Bluetooth, increase brightness to 80 percent, open YouTube.com, and search for a lo-fi study playlist.”

Pass criteria:

- One committed voice request and one correlated orchestrator plan.
- Bluetooth and brightness routed as separate Windows tasks.
- YouTube navigation and playlist search routed as Browser work with dependencies respected.
- Independent tasks execute concurrently where safe; dependent Browser steps wait for navigation.
- Each agent returns per-task success/failure and verification evidence.
- A failed task is reported as failed or partial; other successful tasks remain visible.
- The final spoken summary matches the verified task outcomes. No generic “everything is done” when a postcondition is missing.

Repeat the compound case at least 10 times. Include one invalid brightness value, one provider disconnection, one TTS failure, one Browser navigation failure, and one noisy/incomplete utterance.

## 6. Simulation, evidence and release decision

- Run `FAKE=1` tests separately to verify that simulated Bluetooth/brightness changes are labeled simulation-only. Never use simulation results as proof of live hardware success.
- Capture the commit SHA, test logs, a screenshot of the visible result page, and the observed OS states. Redact provider tokens, account names, personal notifications and unrelated desktop content before sharing evidence.
- The integrated feature is accepted only after automated gates pass and the live voice → plan → agent execution → verification → TTS path succeeds on the target PC.