package com.vanessa.mobile.ui

/**
 * Small value types that describe the two moments in the UI where Vanessa
 * must not invent anything: an approval that has not happened yet, and work
 * that is still running.
 *
 * Both are plain immutable descriptions produced by `MainActivity` from real
 * state (a pending model replacement, an in-flight import or assistant run),
 * so the screens can stay presentational and cannot author a fake outcome.
 */

/** State of one line in the executing screen's checklist. */
internal enum class FlowStepState { DONE, ACTIVE, PENDING }

internal data class FlowStep(val label: String, val state: FlowStepState)

/**
 * A destructive or hard-to-undo action waiting on explicit user approval.
 *
 * [detail] carries the concrete thing at risk (for example the installed
 * model's file name) so the confirmation is specific rather than generic.
 */
internal data class ApprovalRequest(
    val title: String,
    val body: String,
    val detail: String?,
    val approveLabel: String,
    val cancelLabel: String = "Cancel",
)

/** A currently running operation. Steps are only those actually observed. */
internal data class ExecutionState(
    val title: String,
    val subtitle: String,
    val steps: List<FlowStep>,
)

/**
 * The result of a completed operation, shown on the success screen.
 *
 * Vanessa only reaches this state when work genuinely finished; failures are
 * reported in place on the screen that started them.
 */
internal data class CompletionState(val title: String, val body: String, val detail: String?)
