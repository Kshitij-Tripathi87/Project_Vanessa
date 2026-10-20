# Vanessa Architecture Specification (Revision 0.3)

> **Core Principle**: Voice owns speech sessions; Planner owns work; Policy owns authorization; Target device owns execution; Verifier owns completion claims.

---

## 1. Executive Summary

Vanessa Architecture Revision 0.3 addresses three critical requirements:
1. **Clean Voice Integration**: The voice subsystem is a dedicated session and transport layer, not a parallel orchestrator. Speech turns are strictly segmented into `draft` (HUD updates only) and `committed` (command triggers).
2. **Network Resilience & Durable Execution**: Remote commands are enveloped with `requestId` and `idempotencyKey`, persisted to an authoritative ledger before acknowledgement, and guarded against duplicate replay.
3. **Verifiable Agent Lifecycle & Recovery**: Failures and interruptions are explicit state transitions. Tasks progress through `received` $\rightarrow$ `accepted` $\rightarrow$ `planning` $\rightarrow$ `running` $\rightarrow$ `verifying` $\rightarrow$ terminal states. "Opened terminal" is not proof of testing; postconditions and exit codes must be verified.

---

## 2. Component Architecture Diagrams

### 2.1 Mobile $\rightarrow$ PC Task Routing

```mermaid
sequenceDiagram
    autonumber
    participant Mobile as 📱 Mobile Client
    participant Relay as ☁️ Relay / Control Plane
    participant Inbox as 📥 Desktop Durable Inbox
    participant Policy as 🛡️ Local Policy Gate
    participant Planner as 🧠 Planner & Agent DAG
    participant Verifier as 🔍 Verifier & Ledger

    Mobile->>Mobile: 1. Capture command (PTT / Voice / Mobile ASR)
    Mobile->>Mobile: 2. Resolve target (Mobile-local vs. Paired PC)
    Mobile->>Relay: 3. Build & send CommandEnvelope (requestId, idempotencyKey, targetDeviceId)
    Relay->>Relay: 4. Authenticate WSS/TLS, check rate limits & device identity
    Relay->>Inbox: 5. Route to target desktop inbox
    Inbox->>Inbox: Validate schema, deduplicate idempotencyKey, persist before ACK
    Inbox-->>Relay: ACK: Accepted (Task recorded)
    Relay-->>Mobile: Event: Accepted (Seq #1)
    
    Inbox->>Policy: 6. Evaluate local policy & risk derivation
    alt High-Risk / Requires Confirmation
        Policy-->>Mobile: Approval pause required (Action hash + short TTL)
        Mobile->>Policy: Explicit Approval (Signed)
    end

    Policy->>Planner: 7. Dispatch allowed agents to Planner DAG
    Planner->>Planner: Execute bounded tool calls & persist checkpoints
    Planner->>Verifier: 8. Execute postconditions & inspect exit codes
    Verifier->>Verifier: Verify artifacts & postconditions (succeeded/partial/failed)
    Verifier->>Relay: 9. Sequence-numbered event delivery (Seq #2, #3, ...)
    Relay->>Mobile: 10. Live timeline update + concise voice summary
```

---

### 2.2 Voice Pipeline Component Map

```mermaid
graph TD
    subgraph AudioCapture ["Client & Audio Capture"]
        Mic[Microphone Adapter: 16-bit 16kHz PCM]
        WakeGate[Local Wake-Word Gate: 'Hey Vanessa' / Alt+Space]
        VAD[Audio Framing & VAD: 80-100ms frames]
        Mic --> WakeGate
        WakeGate -->|Gate Open| VAD
    end

    subgraph VoiceRuntime ["Voice Session Runtime"]
        SessionCtrl[Voice Session Controller: sessionId, turnId, state machine]
        TurnGate[ASR Turn Gate & Normalizer: Draft = HUD only, Committed = Command]
        CmdBridge[Command Bridge: Envelope builder, NO direct OS tools]
        RespCoord[Speech Response Coordinator: Milestones & Final verified summary]
        PlayQueue[Playback Queue: Chunk sequencing, drop after barge-in]
        BargeInRouter[Barge-In Router: STOP_PLAYBACK != CANCEL_TASK]
        Recovery[Recovery Controller: Circuit breaker & Local ASR fallback]

        VAD --> SessionCtrl
        SessionCtrl --> TurnGate
        TurnGate -->|Committed Turn| CmdBridge
        BargeInRouter --> PlayQueue
    end

    subgraph Providers ["Provider Adapters"]
        FishASR["Fish Realtime ASR: wss://api.fish.audio/v1/asr/realtime<br/>(transcribe-stream-1)"]
        LocalASR["Local Voice ASR: faster-whisper on 127.0.0.1:4505<br/>(Resilient Fallback)"]
        FishTTS["Fish Streaming TTS / ElevenLabs<br/>(Pinned model: s2.1-pro-free / turbo)"]
        Vault["Credential Boundary: Safe OS vault, never exposed to renderer"]

        SessionCtrl --> FishASR
        FishASR -.->|Failover| LocalASR
        TurnGate -.-> Vault
        FishTTS --> PlayQueue
    end

    subgraph OrchestrationPlane ["Work & Verification Plane"]
        Orchestrator[Orchestrator & Multi-Agent DAG]
        Specialists[Specialist Agents: IT Ops, Incident, Dev, System, Browser]
        VerifierEngine[Verifier Engine: Exit codes, postconditions, artifacts]

        CmdBridge --> Orchestrator
        Orchestrator --> Specialists
        Specialists --> VerifierEngine
        VerifierEngine --> RespCoord
        RespCoord --> FishTTS
    end

    BargeInRouter -.->|EMERGENCY_STOP only| Orchestrator
```

---

### 2.3 Task Lifecycle & Failure Recovery

```mermaid
stateDiagram-v2
    [*] --> Received: Schema + Identity + Expiry validated
    Received --> Accepted: Persisted to Ledger before ACK
    Accepted --> Planning: Construct Agent DAG & Dependency Tree
    Planning --> Running: Normal execution branch
    
    state Running {
        [*] --> ExecutingTools
        ExecutingTools --> PersistingCheckpoint
    }

    Running --> AwaitingApproval: Local policy flags high-risk action
    AwaitingApproval --> Running: User approves (Voice / UI / Mobile)
    AwaitingApproval --> Blocked: Denied / Expired (No side effects)
    Blocked --> [*]

    Running --> Verifying: Tool execution complete
    
    state Verifying {
        [*] --> CheckExitCode
        CheckExitCode --> AssertPostconditions
        AssertPostconditions --> CollectArtifacts
    }

    Verifying --> Succeeded: Postconditions verified true
    Verifying --> Partial: Some independent branches failed
    Verifying --> Failed: Core objective failed verification

    Running --> Interrupted: Host crash / Sleep / Network loss
    Interrupted --> Reconciling: Host startup & reconnect
    
    state Reconciling {
        [*] --> InspectActualState
        InspectActualState --> CheckIdempotency
    }

    Reconciling --> Running: Action is idempotent & safe to resume
    Reconciling --> AwaitingApproval: Action is ambiguous / non-idempotent
    Reconciling --> Failed: Non-resumable failure

    Succeeded --> [*]
    Partial --> [*]
    Failed --> [*]
```

---

## 3. Core Architectural Decisions Locked

| Area | Decision | Rationale |
| :--- | :--- | :--- |
| **Desktop Client** | Electron UI with 90×90px compact circular orb docked in screen corner (`BR`, `BL`, `TL`, `TR`). | Non-intrusive, always available, direct access to Windows APIs via context-isolated preload boundary. |
| **Voice Layer** | Dedicated session & transport runtime. Zero direct OS execution from voice layer. | Prevents unverified hallucinated side-effects. Audio layer only streams and manages session state. |
| **Fish Audio ASR** | WebSocket streaming via `wss://api.fish.audio/v1/asr/realtime` with model `transcribe-stream-1`. | Official low-latency real-time protocol. Differentiates `draft` (HUD) vs `committed` (planner input). |
| **Local ASR Fallback** | Local Python `faster-whisper` daemon on `ws://127.0.0.1:4505`. | Guarantees 100% offline autonomy if internet or cloud API keys fail. |
| **Orchestration** | Authoritative Task DAG with local SQLite ledger, sequence numbers, and cancellation tokens. | Non-blocking execution of independent tasks via `Promise.all`; strict dependency ordering. |
| **Remote Connectivity** | Authenticated WSS relay with device identities, idempotency keys, and sequence replay. | Survives Wi-Fi drops, sleep mode, and reconnects without repeating non-idempotent commands. |
| **Verification Gate** | "Opened terminal is not proof of testing." Mandatory exit code checking & postcondition assert. | Autonomous coding and incident fixes must prove correctness before reporting success. |
| **Barge-In Router** | `STOP_PLAYBACK` $\neq$ `CANCEL_TASK`. Separate cancellation commands. | Speaking stops audio chatter immediately without accidentally aborting background builds or tests. |

---

## 4. Implementation Invariants

1. **ASR Invariant**: `partial` or `draft` transcripts must NEVER trigger planner execution. Only a `committed` turn enters the planner.
2. **Audio Privacy Invariant**: Local wake-word gate (`Hey Vanessa` or `Alt+Space`) gates cloud audio streaming. No raw room audio is streamed to external cloud APIs while idle.
3. **Execution Invariant**: Every remote or voice command must have an `idempotencyKey` and must be persisted before the target device sends an `ACCEPTED` status.
4. **Verification Invariant**: A task status cannot transition to `succeeded` based solely on process spawning. It requires actual completion, verification of exit code (`code === 0`), and postcondition validation.
