# Windows distribution: release gates and remaining external setup

## What CI now verifies

The `Windows installer` workflow builds `Vanessa-Setup-x64.exe`, runs the installer silently into an isolated temporary directory, verifies the expected launch/repair files and safe `.env.example` template, checks that a real `.env` was not packaged, and silently uninstalls it again.

The workflow can Authenticode-sign the EXE when both signing secrets are configured. A `v*` version-tag release fails closed if those secrets are absent or the signature cannot be verified.

## Configure trusted installer signing

A valid publicly trusted Windows code-signing certificate is required; a self-signed development certificate will not remove SmartScreen warnings on other computers.

1. Obtain a publisher code-signing certificate from a trusted certificate authority and export it as a password-protected PFX suitable for CI signing.
2. In the repository's **Settings → Secrets and variables → Actions**, add:
   - `WINDOWS_SIGNING_CERTIFICATE_BASE64`: base64 encoding of the PFX bytes.
   - `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`: the PFX password.
3. Encode the PFX locally without printing the result in a terminal or committing it. For example, in PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('publisher.pfx')) | Set-Clipboard`. Paste the clipboard value directly into the Actions secret. Do not commit the PFX or a base64 copy.
4. Trigger the Windows installer workflow and verify its signing step reports a valid Authenticode signature before creating a version tag.

Normal branch/PR CI can still produce an unsigned test artifact when signing secrets are absent. Such an artifact must not be represented as a signed release.

## Fresh-device and microphone acceptance

CI now verifies installer lifecycle, not real audio hardware. Before calling a release generally usable, run the signed EXE on a clean Windows 11 x64 machine or VM with no Node.js, Python, pnpm, Ollama, or Vanessa configuration present.

- Run the installer as a standard user; verify no administrator prompt is required.
- Complete first-run dependency/model setup with a network connection.
- Open the compact Vanessa assistant and verify Windows microphone permissions are granted.
- Say “Hey Vanessa” with the default local Whisper profile, interrupt a response, issue a multi-step command, and confirm the spoken response and action result.
- Test with microphone permission denied, missing internet, a busy service port, and a reboot. The UI/diagnostics must explain recovery rather than hanging silently.
- Confirm user configuration/logs live under the user's AppData location and survive an app update; verify no secrets appear in logs or support bundles.

A CI runner does not have a representative consumer microphone or user's privacy/permission settings, so passing CI does not replace this physical acceptance run.

## Online bootstrap versus offline installer

The current Setup EXE installs the Vanessa application payload, but it is **not yet a fully offline/self-contained distribution**. First-run setup may use winget and downloads workspace packages, local Python speech dependencies, the selected Whisper model, Ollama, and the configured language model. Internet access and free disk space are required on first setup. The current artifact must not be advertised as offline-capable.

A genuinely offline distribution needs version-pinned installers/runtime and all model/dependency artifacts staged and checksum-verified in the release pipeline. Large model assets also need an approved distribution/storage plan. Do not silently fall back to fetching unverified binaries or models during an alleged offline install.

## Sarvam key-free hosted voice

Never embed the shared `SARVAM_API_KEY` in the EXE, renderer bundle, bootstrap ZIP, or a distributed `.env`; a key inside a client can be extracted. The current safe no-key profile is local Whisper + local Ollama + OS/browser speech fallback. Hosted Sarvam is BYOK until a server-side provider gateway is deployed.

A production shared gateway still requires an actual hosted environment, TLS/domain, server-side provider credential, account/device authentication, per-user quotas/rate limits, abuse controls, request logging with transcript/secret redaction, usage/billing guardrails, and operational monitoring. Deployment secrets and hosting cannot be replaced by committing a secret or a hard-coded client token. The desktop app should receive only short-lived, scoped user tokens—not the provider key.
