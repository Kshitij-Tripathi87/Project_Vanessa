# Vanessa Windows UI Automation Agent

## Purpose

This capability extends Windows control beyond a fixed list of settings and app launches. It uses the Windows accessibility/UI Automation tree to inspect the active foreground window and invoke a specific accessible control by identity.

## Actions

### `ui.inspect`

Captures the foreground window's handle, title, process ID, and a bounded Control View accessibility tree (up to 120 controls, with a bounded traversal depth and node count). Each control descriptor includes its accessible name, AutomationId, ControlType, class name, enabled/offscreen state, and tree depth.

The inspection does **not** read input-field values, ValuePattern contents, clipboard data, screenshots, or form values. Displayed names and titles pass through Vanessa's existing sensitive-data redaction before being stored in the task result. The task reports whether the list was truncated.

### `ui.click`

Despite the action's friendly name, the implementation does not synthesize mouse coordinates. It can invoke only one uniquely matched, enabled, onscreen control through Windows UI Automation's `InvokePattern`.

The request must use the exact window handle, title, and process ID from a preceding `ui.inspect` result. It must specify an exact AutomationId, or an exact case-sensitive accessible name together with a valid ControlType. The backend re-checks the window identity and searches the active window's bounded tree. Zero or multiple matches, disabled/offscreen controls, stale window identity, missing InvokePattern, and API exceptions fail closed. There is no coordinate fallback.

Because a button's invocation may submit a form, change settings, navigate, or trigger another side effect, `ui.click` is catalogued as **high risk** and uses Vanessa's normal one-time approval gate. The execution planner must put `ui.inspect` first and pass its result fields to the dependent click task; it must never invent a selector.

## Outcome semantics

Inspection can be marked completed when Windows returns a valid window identity and bounded accessibility tree.

A control invocation is marked **partial** when `InvokePattern.Invoke` returns: this proves only that the accessibility invocation was accepted. It does not prove that a page loaded, a dialog closed, a switch changed, or an application action succeeded. For an actual postcondition, run a fresh inspection (or a purpose-built state verifier) after the invocation and compare the observed result with the user's requested condition.

When `FAKE=1`, neither action calls Windows; the result is partial and explicitly unverified.

## Locks and privacy

UI inspection and invocation share the `desktop-ui` task lock so simultaneous tasks do not race the foreground window. UIA output is bounded, sensitive-looking text is redacted before returning through the Windows Agent, and input values are intentionally not collected.

## Test and acceptance requirements

Automated tests use an injected PowerShell runner and cover bounded inspection output, JSON errors, window/selector validation, exact target forwarding, ambiguous-selector failure, privacy redaction, honesty about downstream effects, and fake-mode isolation.

The real UI Automation interaction still requires acceptance on a physical Windows desktop. Test it with a harmless app such as Notepad or Settings:
1. Open the target app and ask Vanessa to inspect the active window.
2. Confirm the returned title and controls match what Windows Accessibility exposes, and that no typed/input values are returned.
3. Request a click on one uniquely named non-destructive control. Confirm Vanessa pauses for approval.
4. Approve the action and verify the target is the expected HWND/title/PID and selector. Vanessa should say the invocation was accepted but the effect is unverified unless a second check proves it.
5. Switch the active window between inspection and approval, use a duplicate/ambiguous control name, or choose an unsupported control type; confirm that the operation fails closed rather than clicking another control.
6. Run under `FAKE=1`; confirm no Windows UIA API is called.

GitHub CI can compile the code and test the injected contracts; it cannot prove that a particular real app exposes the required accessibility patterns. Do not treat mock tests as physical-desktop acceptance.
