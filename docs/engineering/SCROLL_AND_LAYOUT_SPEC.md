# Scroll and layout specification

**Status:** measured from the code. There are **14 scroll regions** across
**8 files**, and **zero `LazyColumn`/`LazyRow`** anywhere in the app. Every region
is a `Column` + `verticalScroll(rememberScrollState())`.

That matters more than the count: a `Column` with `verticalScroll` composes *every*
child, so the chat transcript composes all 100 retained messages on every
recomposition. This is acceptable at 100 messages and will stop being acceptable
before the transcript cap is raised.

## Regions

| Screen | File | Regions | Container |
|---|---|---|---|
| Welcome | `VanessaWelcomeFlow.kt` | 1 (shared flow scroll) | `Column` |
| Onboarding | `VanessaWelcomeFlow.kt` | 1 (shared flow scroll) | `Column` |
| Permissions | `VanessaWelcomeFlow.kt` | (shared) | `Column` |
| Chat transcript | `VanessaAssistantScreens.kt` | 1 | `Column` + `rememberScrollState` |
| Listening | `VanessaAssistantScreens.kt` | 1 | `Column` |
| Confirm action | `VanessaAssistantScreens.kt` | 1 | `Column` |
| My PC (dashboard) | `VanessaApp.kt` | 1 | `Column` |
| Settings | `VanessaApp.kt` | 1 | `Column` |
| Pairing | `VanessaApp.kt` | 1 | `Column` |
| My PC (remote) | `screens/MyPcScreen.kt` | 1 | `Column` |
| Task approval | `screens/TaskApprovalScreen.kt` | 1 | `Column` |
| Task execution | `screens/TaskExecutionScreen.kt` | 1 | `Column` |
| Task result | `screens/TaskResultScreen.kt` | 2 | `Column` ×2 |
| Task recovery | `screens/TaskRecoveryScreen.kt` | 1 | `Column` |
| Remote control host | `RemoteControlActivity.kt` | 1 | `Column` |

Counts are `.verticalScroll(` call sites; the shared welcome-flow scroll is
counted once per file that installs it.

## Insets and keyboard

Handled **once**, not per screen:

- `VanessaApp.kt` wraps the main surface in
  `Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()`.
  Status bar, navigation bar and IME are therefore handled for every destination on
  that surface, and the composer is pushed above the keyboard by the same line.
- `RemoteControlActivity` applies `imePadding` on its own container.
- Window background colours are set to `#03050A` in both activities, so the inset
  areas do not flash a system colour.

**Consequence to keep in mind:** the guarantee is one line in one file. A screen
that is moved out of that container (a dialog, a new activity, a popup) silently
loses it. Any new activity must apply `safeDrawing` + `imePadding` itself.

## Global contracts

| Area | Requirement | Current |
|---|---|---|
| Insets | status, nav, IME | handled centrally for the main surface |
| Bottom bar overlap | never covers content | bottom nav renders only on two destinations; nothing overlaps today |
| Short displays | actions remain reachable | all containers scroll; not measured on a device |
| Large text | scales without clipping | `sp` text throughout; not measured at 200% |
| Landscape | no clipped critical action | not tested |
| Nested scroll | none intentional | none found; no `Lazy*` inside a `verticalScroll` |
| Restoration | scroll position preserved | **not implemented** — state is not hoisted or saved |
| Loading | stable layout | splash and thinking rows are fixed-height |
| Empty states | explicit | chat empty state exists; settings/permissions have none |
| Errors | recoverable without losing input | chat draft retained; model import cancel discards a typed checksum |
| Accessibility | semantics and focus order | content descriptions on icon buttons; not audited end to end |

## Findings acted on

1. **The chat transcript followed every arrival.** A single
   `LaunchedEffect(messages.size, assistantBusy)` scrolled to `maxValue`
   unconditionally, so reading history was impossible — each new message or busy
   transition dragged the viewport away. Now the viewport follows only while the
   reader is at the live end; otherwise a "New messages ↓" pill appears and the
   position is left where the reader put it.
2. **Scroll position is not restored.** Rotation returns to the top. This is
   listed as a gap rather than fixed, because restoring it properly needs the
   scroll state hoisted per destination — a change worth making once, not
   screen by screen.

## Test configurations still owed

The brief asks for three configurations per scrollable screen. None of these has
been run on a device or emulator:

- standard display (411 × 891 dp)
- compact display (320 × 640 dp)
- large accessibility font (200%)
- keyboard open, for chat and dialogs

`androidTest/` contains a navigation test; it has never executed in CI because the
emulator job fails before instrumentation starts (see `END_TO_END_ACCEPTANCE.md`
for the gate that must change).
