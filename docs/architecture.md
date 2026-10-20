# Vanessa Architecture Deep Dive

## Overview
Vanessa operates as a voice-first orchestrator on top of Windows 11. Rather than relying on fragile GUI clicking or vision models alone, Vanessa uses direct OS APIs, PowerShell, terminal execution, and browser automation to deliver fast, reliable actions.

```mermaid
graph TD
    User([User Voice / Text]) --> Frontend[Desktop HUD: React + Electron]
    Frontend -->|IPC / Client Tool| Orchestrator[Node.js Fastify Orchestrator]
    
    subgraph Core Brain
        Orchestrator --> Planner[Multi-LLM Planner]
        Planner -->|JSON Task Graph| Safety[Permission Guard / Gate]
        Safety -->|Allowed / Confirmed| Runner[Parallel Task Runner]
        Safety -->|Blocked| BlockedLog[Audit Log: Blocked]
        Safety -->|Ask-First| ConfirmModal[HUD Approval Modal]
    end

    subgraph Capability Agents
        Runner -->|Parallel Fan-Out| SystemAgent[System Agent: PowerShell/WinRT]
        Runner -->|Parallel Fan-Out| BrowserAgent[Browser Agent: Playwright]
        Runner -->|Parallel Fan-Out| FileAgent[File & Drive Agent]
        Runner -->|Parallel Fan-Out| DevAgent[Developer Agent: Claude Code / Terminal]
        Runner -->|Parallel Fan-Out| CloudAgent[Cloud Agent: Gmail / WhatsApp]
    end

    Runner -->|task:update / plan:completed| EventBus[Event Bus]
    EventBus -->|WebSocket Stream| Frontend
    EventBus -->|Spoken Feedback| VoiceTTS[ElevenLabs / Fish Audio]
```

## Parallel Task Runner (DAG Resolution)
Tasks in a Plan specify `dependsOn: string[]`. 
- An independent task (`dependsOn: []`) runs immediately.
- Multiple independent tasks run concurrently with `Promise.all`.
- Dependent tasks wait until all parent tasks reach `status === "success"`.
- If a parent task fails, dependent tasks are not executed, while other independent branches continue.

## Emergency Kill-Switch
Engaged by pressing `Esc` in the desktop HUD or sending `POST /api/cancel`.
- Immediately cancels all running, pending, and awaiting tasks.
- Emits `audit:log` event and updates task statuses to `cancelled`.
