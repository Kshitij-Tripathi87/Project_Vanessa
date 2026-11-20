# Android screen inventory

**Status:** describes the code as it exists on `main` after #67. Every row names the
file that actually renders it. Where the product brief describes a screen this app
does not have, the row says so instead of describing an intention.

Two navigation surfaces exist:

- **Main surface** — `MainActivity` with a `VanessaDestination` enum
  (`WELCOME, ONBOARDING, PERMISSIONS, HOME, LISTENING, CONFIRM, EXECUTING,
  SUCCESS, PAIRING, PC, SETTINGS`) rendered by one `when (destination)` in
  `VanessaApp.kt`.
- **Remote surface** — `RemoteControlActivity`, driven by `RemoteTaskPhase`
  rather than by destinations (see `REMOTE_TASK_STATE_MACHINE.md`).

## Main surface

| # | Screen | File | Destination | States |
|---|---|---|---|---|
| 1 | Splash / boot | `VanessaApp.kt` `SplashScreen` | shown while `!startupReady` | one message line, no progress claims |
| 2 | Welcome | `VanessaWelcomeFlow.kt` `WelcomeScreen` | `WELCOME` | orb, time-derived greeting, single primary CTA |
| 3 | Onboarding | `VanessaWelcomeFlow.kt` `OnboardingScreen` | `ONBOARDING` | three panels, back/skip/continue |
| 4 | Permissions | `VanessaWelcomeFlow.kt` `PermissionsScreen` | `PERMISSIONS` | microphone, documents; calendar is contextual |
| 5 | Assistant / chat | `VanessaAssistantScreens.kt` `ChatScreen` | `HOME` | empty, conversation, thinking row, no-model notices |
| 6 | Listening | `VanessaAssistantScreens.kt` `ListeningScreen` | `LISTENING` | listening, transcript, unavailable, typed fallback |
| 7 | Confirm action (local) | `VanessaAssistantScreens.kt` `ConfirmActionScreen` | `CONFIRM` | approve / cancel for a local model import |
| 8 | Executing (local) | `VanessaAssistantScreens.kt` `ExecutingScreen` | `EXECUTING` | step checklist; not cancellable from the route |
| 9 | Success (local) | `VanessaAssistantScreens.kt` `SuccessScreen` | `SUCCESS` | completion |
| 10 | Pairing | `VanessaApp.kt` `PairingScreen` | `PAIRING` | instructions, launch scanner |
| 11 | My PC | `VanessaApp.kt` `PcDashboardScreen` + `rememberSavedPc` | `PC` | paired / unpaired, read from preferences only |
| 12 | Settings | `VanessaApp.kt` `SettingsScreen` | `SETTINGS` | model, voice, permissions, device, build |

QR scanning is an activity of its own (`RemotePairingQrScannerActivity`,
`QrScannerActivity`) because it needs a camera surface, not a destination.

## Remote surface

| # | Screen | File | Phase |
|---|---|---|---|
| 13 | My PC (remote) | `screens/MyPcScreen.kt` | `Idle`, `Submitted` |
| 14 | Task approval | `screens/TaskApprovalScreen.kt` | `AwaitingApproval` |
| 15 | Task execution | `screens/TaskExecutionScreen.kt` | `Running` |
| 16 | Task result | `screens/TaskResultScreen.kt` | `Finished` |
| 17 | Task error | `screens/TaskResultScreen.kt` `TaskErrorScreen` | `Failed` |
| 18 | Task recovery | `screens/TaskRecoveryScreen.kt` | `Recovering`, `Unrecoverable` |

## Gaps against the brief

Recorded as gaps, not as work that has been done:

| Brief expects | Reality |
|---|---|
| A persistent bottom navigation bar | `NavigationItem` exists in `VanessaApp.kt`, shown only on `PC` and `SETTINGS` |
| A settings page in nine sections | one scrollable page; nine named sections are a target, not the current shape |
| A chat history with loading/empty/failure states | 100-message in-memory `takeLast(100)` transcript; no durable history, no loading state |
| My PC last-seen, trust, recent task history | not implemented; the screen states what it cannot know rather than inventing it |
| Pairing states (QR detected, expired, PC approval pending) | scanner reports success/failure; the intermediate states are not surfaced |
| A deep-link / back-stack model | a single `BackHandler` `when` block in `MainActivity`; no stack, no deep links |

## Rules this inventory enforces

- A screen name in this file must have a file. If it does not, it is listed under
  **Gaps** instead.
- Every interactive element must reach a handler in the same file or an adjacent
  one; the brief forbids dead buttons, and a row here that cannot name its
  handler is a bug report.
