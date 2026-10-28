# Vanessa | Voice-first engineering and IT assistant

> **"Hey Vanessa, my Wi-Fi isn't working—restart the adapter and open YouTube."**  
> Vanessa restarts the Wi-Fi, verifies connectivity, opens YouTube, and reports back by voice.

---

## ⚡ What We Are Building
Vanessa is a voice-first assistant for engineering and IT work. It helps investigate operational issues across repositories, logs, runbooks, and incident history; prepare bounded changes; run approved checks; and report evidence. Windows 11 is the initial desktop target. General PC control remains part of the longer-term product vision.

### 🏛️ Architecture & Flow
```
Voice Command (Desktop Mic / Phone Door)
         │
         ▼
  Vanessa Planner (GPT-4o-mini / Claude Sonnet / Heuristic Fallback)
         │
         ▼
  Structured Plan JSON (Tasks + Dependencies)
         │
         ▼
  Safety Gate / Permission Guard (Allowed | Confirm / Ask-First | Blocked)
         │
         ▼
  Parallel Task Runner (DAG engine via Promise.all)
         │
         ├── System Agent     (Wi-Fi restart, Bluetooth, volume, apps)
         ├── Browser Agent    (Chrome, search, YouTube playback)
         ├── File Agent       (Folder creation, search, Drive upload)
         ├── Developer Agent  (VS Code, terminal, Claude Code launcher)
         └── Cloud Agent      (Gmail draft/send, Drive links, WhatsApp)
         │
         ▼
  Event Bus & WebSocket Stream ──► HUD Desktop UI + Spoken Audio Response
```

---

## 🛠️ Tech Stack

| Layer | Choice | Why |
|---|---|---|
| **Desktop App** | Electron + React + TypeScript | Fast HUD control, native window overlays, cross-platform |
| **Local Orchestrator** | Node.js + Fastify + WebSocket | High-performance local API, real-time event streaming |
| **Default speech recognition** | Local Faster-Whisper | No STT API key; local PCM/WebSocket pipeline |
| **Default speech output** | Browser/OS SpeechSynthesis fallback | No TTS API key; optional Fish/Sarvam/ElevenLabs adapters |
| **Default planner LLM** | Local Ollama (qwen2.5:3b) | Local-only request path; no LLM provider key |
| **Optional hosted providers** | Sarvam / NVIDIA / Fish / ElevenLabs | Explicitly selected BYOK providers; no shared key is bundled |
| **OS Control** | PowerShell / Windows Radio APIs | Deep Windows 11 control without brittle GUI clicking |
| **Browser Control** | Direct browser commands & Playwright | Rapid Chrome & YouTube automation |
| **Files & Cloud** | Node fs + Google Drive integration | Zip projects, upload files, generate shareable links |
| **Package Manager** | `pnpm` workspaces | Clean monorepo dependency resolution |

---



---

## 🚀 Quick Start

### 1. Prerequisites
- Windows 11, PowerShell 5.1+
- Node.js 22+ and pnpm 11.24.0 for the current repository bootstrap
- Python 3.11 for local Faster-Whisper STT (the setup script creates a virtual environment)
- Ollama for local planning/conversation. Install from the official Windows page at https://ollama.com/download/windows and open Ollama before setup.

### 2. First-time setup (no API keys required)
Run:

    .\scripts\setup_windows.ps1

The first launch of Launch-Vanessa.bat detects missing configuration/dependencies and starts setup automatically. The setup script preserves an existing .env; on a clean checkout it creates one from .env.example with the local profile selected. It installs workspace packages, builds the code, installs local speech dependencies, warms the selected Whisper model, and pulls the configured Ollama model if missing. On later launches a local preflight checks that the configured runtime and model are present; when one is missing, the setup/repair path runs again. The default qwen2.5:3b model is about 2 GB; additional disk/network use occurs only for first-time model downloads. When Windows Package Manager (winget) is available, setup can install Node.js LTS, Python 3.11, and Ollama when they are missing. If winget is unavailable or an installation is blocked by device policy, setup stops with a manual recovery instruction.

### 3. Launch Vanessa
Use the canonical launcher to start the orchestrator, local Whisper WebSocket, voice service and desktop together:

    .\Launch-Vanessa.bat

Optional diagnostics:

    Launch-Vanessa.bat --doctor
    Launch-Vanessa.bat --doctor --live
    node scripts/doctor.cjs --json
    node scripts/launch-vanessa.cjs --check
    node scripts/launch-vanessa.cjs --build-only
    node scripts/launch-vanessa.cjs --text-only

The read-only doctor checks the Windows/Node prerequisites, workspace packages, selected provider configuration, local speech runtime, and the configured local LLM/model. Use `--live` while Vanessa is running to check the orchestrator and voice gateway. It never prints `.env` values or claims microphone capture works; test the microphone by speaking into the running HUD.

- Default local profile: PLANNER_PROVIDER=ollama, CONVERSATION_PROVIDER=ollama, VOICE_ASR_PROVIDER=whisper, and browser speech fallback. No provider API key is required. Local Whisper can keep a wake-word monitor active for “Hey, Vanessa”; standby audio stays on this device. Hosted Sarvam/Fish/ElevenLabs ASR uses push-to-talk and does not stream idle room audio.
- If the microphone is denied or unavailable, Vanessa shows Windows/device troubleshooting steps and typed commands remain available.
- Optional cloud providers require your own key and an explicit provider selection in .env. Never put a shared provider key into a distributed .env, source code, installer, or renderer bundle.
- --check requires the selected local model and local Whisper runtime to be ready. --build-only compiles without starting services or checking model availability.
- Launch-Vanessa.bat is still a bootstrap entry point, not a self-contained signed customer installer. The Windows CI workflow can publish a sanitized `Vanessa-Windows-Bootstrap-<commit>.zip` artifact containing the tracked source needed by the setup flow; download it from the successful workflow run's **Artifacts** section. Extract it to a user-writable folder and run `Launch-Vanessa.bat`. The ZIP does not bundle Node/Python/Ollama or large speech/LLM models; first-run setup downloads/configures those prerequisites. The Windows Setup EXE is built by the repository's **Windows installer** workflow. First launch provisions local runtimes and models; the current installer is not code-signed or fully offline, and no provider credentials are packaged.

### 4. Windows installation

Download `Vanessa-Setup-x64.exe` from the successful **Windows installer** workflow's **Artifacts** section (or from a GitHub Release for a version tag). Run it as your user; administrator rights are not required. It creates a Start Menu shortcut, optional Desktop shortcut and optional launch-at-sign-in task for the floating orb. First launch may install Node.js, Python, Ollama and local speech/language models; internet access and several GB of free disk space are required. Allow microphone access in Windows.

Settings and optional user-provided keys live in `%APPDATA%\\Vanessa`; project/task files live in `Documents\\Vanessa`. A real `.env` file or API key is never packaged. Choosing Sarvam on another computer requires that user's own key or a properly authenticated managed gateway; never embed a shared Sarvam key in an EXE, repository, renderer bundle or distributed `.env`.

Developers can clone the repository and run `pnpm install` followed by `pnpm run setup:windows`. `Launch-Vanessa.bat` remains available for developer/bootstrap use. The installer is not currently code-signed or a fully offline bundle.

### 5. Run Development Services Directly
```bash
pnpm dev
```
- Orchestrator API runs on `http://127.0.0.1:4319`
- Desktop HUD runs on `http://localhost:5173`

### 6. Run Scenario Tests
```bash
pnpm test:scenarios
```

---

## 🔒 Safety Gate & Permission Tiers

Every task generated by the planner passes through the **Permission Guard**:
1. **Allowed**: Non-destructive operations (play YouTube, toggle Bluetooth, create folders, open apps).
2. **Confirm (Ask First)**: Sensitive operations (Wi-Fi restart which drops network, file deletion, sending emails, cloud uploads). Requires spoken or button approval.
3. **Blocked**: Malicious or destructive actions (disk formats, deletion of critical directories, credential exfiltration).

---



## Windows installer release gates

The `Windows installer` GitHub Actions workflow runs the Windows test suite and a silent install/uninstall smoke test for the Setup EXE. It also checks that a real `.env` is not included in the installed payload. Release signing is handled by `scripts/sign-windows-installer.ps1`: set `WINDOWS_SIGNING_CERTIFICATE_BASE64` and `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` in GitHub Actions secrets to sign and verify the EXE. A version-tag release is blocked when the signature is missing or invalid. Configure a trusted publisher certificate before tagging a public release.

The current Setup EXE is an online bootstrap, not a fully offline/self-contained installer. First-run setup downloads runtime packages and local speech/language models. Hosted Sarvam stays BYOK until a real authenticated provider gateway is deployed; never put a shared provider key in an installer or client bundle. See [Windows distribution gates](docs/WINDOWS-DISTRIBUTION.md) for the clean-device acceptance checklist and deployment requirements.


## Windows download options

The Windows installer workflow publishes both `Vanessa-Setup-x64.exe` and `Vanessa-Setup-x64.msi` as GitHub Actions artifacts, and includes both files in versioned GitHub Releases. The MSI creates a Start Menu shortcut and supports Windows Installer install/uninstall operations. CI runs separate install/uninstall smoke tests for the EXE and MSI.

Both installers currently install the sanitized Vanessa application payload, not every runtime/model dependency. First-run setup still needs an internet connection to download the configured local speech/language runtime and models; the MSI is not yet a fully offline bundle. See [Windows distribution gates](docs/WINDOWS-DISTRIBUTION.md).
