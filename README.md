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

- Default local profile: PLANNER_PROVIDER=ollama, CONVERSATION_PROVIDER=ollama, VOICE_ASR_PROVIDER=whisper, and browser speech fallback. No provider API key is required.
- If the microphone is denied or unavailable, Vanessa shows Windows/device troubleshooting steps and typed commands remain available.
- Optional cloud providers require your own key and an explicit provider selection in .env. Never put a shared provider key into a distributed .env, source code, installer, or renderer bundle.
- --check requires the selected local model and local Whisper runtime to be ready. --build-only compiles without starting services or checking model availability.
- Launch-Vanessa.bat is still a repository bootstrap that requires the developer/runtime prerequisites above, not a self-contained signed customer installer. Native packaging and managed hosted AI are separate planned phases.

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

