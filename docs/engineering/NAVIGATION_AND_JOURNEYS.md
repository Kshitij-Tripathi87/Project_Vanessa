# Navigation and product journeys

**Status:** describes the navigation model as built. The six journeys are the
acceptance unit; each is marked with what can currently be evidenced.

## Navigation model

There is **no navigation graph library and no back stack**. Two mechanisms exist:

1. `MainActivity` holds `destination: VanessaDestination` (a plain enum) and
   `VanessaApp.kt` renders one `when (destination)` branch per screen.
2. One `BackHandler` in `MainActivity` maps back presses to a previous
   destination with a `when` block.

Consequences, stated plainly:

- A destination cannot carry arguments. State travels through Activity fields
  (`approval`, `pendingApprovalChecksum`, `chatMessages`).
- There is no deep link, no route restoration beyond
  `savedInstanceState` fields, and no way to return to an arbitrary screen.
- Back behaviour is one table, and it is the only place to change it.

### Back table (`MainActivity`)

| From | Back does |
|---|---|
| `WELCOME` | system: exits the activity |
| `ONBOARDING` | → `WELCOME` |
| `PERMISSIONS` | → `ONBOARDING` |
| `LISTENING` | stops speech input → `HOME` |
| `CONFIRM` | `cancelPendingAction()` → `SETTINGS` (one cancel path, shared with the Cancel button) |
| `EXECUTING` | **nothing** — leaving mid-run would strand the result |
| `SUCCESS` | → `HOME` |
| `PAIRING` | → `PC` |
| `PC`, `SETTINGS` | → `HOME` |

### Remote surface

`RemoteControlActivity` renders from `RemoteTaskPhase`, and its back behaviour is
phase-dependent:

| Phase | Back does |
|---|---|
| `AwaitingApproval` | **denies the approval** (the PC is told), because dropping the screen would leave the PC waiting with nobody informed |
| everything else | ordinary back: finishes the activity |

The approval screen no longer offers a "Back" link at all. Approving and
cancelling are the two ways out, and cancelling notifies the PC.

## Journeys

| # | Journey | Evidence today |
|---|---|---|
| 1 | First-time user: install → splash → welcome → onboarding → permissions → chat → settings → restart → persisted | onboarding completion persists in preferences; `MainActivity` restores destination from `onboardingComplete()`. **Not** exercised on a device in CI. |
| 2 | Local assistant: chat → intent → plan → model available → local capability → verification → result | local executor and `ModelManager` exist; the "verification" step for local tools is the tool's own result. Not run end to end in CI. |
| 3 | Remote PC execution: pair → validate identity → connect → capabilities → submit → accepted → progress → result | reducer covered by 59 unit tests; the **socket path has never been exercised against a real PC from CI**. |
| 4 | Protected operation: approval → identity → action hash → expiry → biometric → signed approval → execution | approval parsing, binding and expiry covered by tests; biometric signing path exists (`AndroidRemoteApprovalKeyStore`, Protected Confirmation). Physical-device only. |
| 5 | Interrupted task: submit → disconnect → process death → reconnect → snapshot/replay → reconstruct or say it cannot | covered by reducer tests including history gaps, unrecoverable approvals and recreation; needs a device to prove the socket half. |
| 6 | Agent orchestration: multi-step → supervisor → context → plan → policy → scheduler → agents → verification | exists server-side (`AGENT_ORCHESTRATION_SPEC.md`); no Android UI surfaces an agent activity timeline yet. |

## What "tested" is allowed to mean here

- A reducer test proves the state machine, nothing more.
- A green `debug-apk` proves it compiles and the unit tests passed.
- A green emulator run is the first thing that proves a journey, and there has
  not been one (see `END_TO_END_ACCEPTANCE.md`).
- Nothing in this repository may be called "verified on device" until a recorded
  run exists.
