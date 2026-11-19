package com.vanessa.mobile.ui.state

import com.vanessa.mobile.remote.RemoteV2Event
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * The remote task lifecycle, as the phone is allowed to describe it.
 *
 * Everything here is derived from protocol-v2 events and nothing else. There is
 * deliberately no `progress = 0.45f`-style default anywhere: a percentage exists
 * only when the PC sent `percentComplete`, and an outcome is "verified" only if
 * the PC's own verification block says so. The screens render this model and are
 * not permitted to invent values, which is what keeps "no fake status
 * indicators" true by construction rather than by discipline.
 *
 * The reducer is pure so it can be unit-tested without a device or an emulator —
 * see `RemoteTaskUiTest`.
 */

/** A protected action waiting on an explicit, biometrically-bound decision. */
internal data class PendingApproval(
    val approvalId: String,
    val taskId: String,
    val actionHash: String,
    val deviceId: String,
    val capability: String,
    val consequence: String,
    val targetKind: String,
    val targetValue: String,
    val expiresAt: Long,
) {
    /** "app · chrome" — the descriptor is two fields on the wire. */
    val targetLabel: String
        get() = if (targetKind.isBlank()) targetValue else "$targetKind · $targetValue"
}

/** The PC's own verdict on whether the result was checked. */
internal enum class VerificationStatus { VERIFIED, PARTIAL, NOT_AVAILABLE, FAILED, UNKNOWN }

/** Terminal status from `task.result`. */
internal enum class ResultStatus {
    SUCCEEDED, PARTIAL, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED, UNKNOWN,
}

/**
 * How a finished task should read.
 *
 * [UNVERIFIED] exists because "the PC says it worked" and "the PC checked that
 * it worked" are different claims. Collapsing them into one green screen would
 * be the most tempting lie in the whole app.
 */
internal enum class OutcomeTone { SUCCESS, PARTIAL, UNVERIFIED, FAILURE, UNKNOWN }

internal data class CancellationAcknowledgement(
    val outcome: String,
    val state: String,
    val detail: String?,
) {
    val message: String
        get() = when (outcome) {
            "cancelled" -> "The PC confirmed cancellation. Waiting for the final task result."
            "completed" -> "The PC reports that the task completed before cancellation took effect."
            "too_late" -> "The PC could not cancel the task because it had already advanced too far."
            "partially_effective" -> detail
                ?: "Cancellation was requested, but the task engine has not confirmed termination."
            else -> detail ?: "The PC returned an unrecognised cancellation acknowledgement."
        }
}

internal data class TaskOutcome(
    val status: ResultStatus,
    val verification: VerificationStatus,
    val verificationSummary: String,
    val safeSummary: String,
    val completedAt: Long,
) {
    val tone: OutcomeTone
        get() = when {
            status == ResultStatus.SUCCEEDED && verification == VerificationStatus.VERIFIED -> OutcomeTone.SUCCESS
            status == ResultStatus.SUCCEEDED && verification == VerificationStatus.PARTIAL -> OutcomeTone.PARTIAL
            status == ResultStatus.SUCCEEDED -> OutcomeTone.UNVERIFIED
            status == ResultStatus.PARTIAL -> OutcomeTone.PARTIAL
            status == ResultStatus.FAILED ||
                status == ResultStatus.TIMED_OUT ||
                status == ResultStatus.INTERRUPTED ||
                status == ResultStatus.CANCELLED -> OutcomeTone.FAILURE
            else -> OutcomeTone.UNKNOWN
        }
}

/** Where the current task is. One screen each. */
internal sealed interface RemoteTaskPhase {
    /** Nothing submitted on this connection, or the last run was dismissed. */
    data object Idle : RemoteTaskPhase

    /** Sent, no accepted/progress event back yet. No spinner claims progress. */
    data class Submitted(
        val capability: String?,
        val requestId: String? = null,
    ) : RemoteTaskPhase

    data class AwaitingApproval(val approval: PendingApproval) : RemoteTaskPhase

    data class Running(
        val stateLabel: String,
        val summary: String,
        /** Null unless the PC reported `percentComplete`. */
        val percentComplete: Int?,
        /** Only summaries the PC actually sent, in order, de-duplicated. */
        val steps: List<String>,
        /** Identifiers copied from the signed task.accepted event. */
        val taskId: String? = null,
        val requestId: String? = null,
        val cancellationRequested: Boolean = false,
        val cancellationAck: CancellationAcknowledgement? = null,
        val cancellationError: String? = null,
    ) : RemoteTaskPhase

    data class Finished(val outcome: TaskOutcome) : RemoteTaskPhase

    /** A protocol error or a lost connection — not a task outcome. */
    data class Failed(val message: String, val retryable: Boolean) : RemoteTaskPhase
}

/** Human label for a protocol state. Unknown values stay legible, never hidden. */
private fun stateLabel(state: String): String = when (state) {
    "accepted" -> "Accepted"
    "queued" -> "Queued"
    "planning" -> "Planning"
    "validating" -> "Validating"
    "awaiting_input" -> "Waiting for you"
    "awaiting_approval" -> "Waiting for approval"
    "running" -> "Running"
    "verifying" -> "Verifying"
    "succeeded" -> "Finished"
    "partial" -> "Partly finished"
    "failed" -> "Failed"
    "cancelled" -> "Cancelled"
    "timed_out" -> "Timed out"
    "interrupted" -> "Interrupted"
    "unknown" -> "Unknown state"
    else -> state.replaceFirstChar { it.uppercase() }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.long(key: String): Long? =
    (this[key] as? JsonPrimitive)?.let { runCatching { it.content.toLong() }.getOrNull() }

private fun JsonObject.bool(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.let { runCatching { it.content.toBoolean() }.getOrDefault(false) } ?: false

/**
 * Parses the approval block. Returns null if the required binding fields are
 * missing, because an approval that cannot be bound to an action hash cannot be
 * signed and must never be shown as approvable.
 */
internal fun parsePendingApproval(approval: JsonObject): PendingApproval? {
    val approvalId = approval.string("approvalId") ?: return null
    val taskId = approval.string("taskId") ?: return null
    val actionHash = approval.string("actionHash") ?: return null
    val deviceId = approval.string("deviceId") ?: return null
    val target = (approval["target"] as? JsonObject)
    return PendingApproval(
        approvalId = approvalId,
        taskId = taskId,
        actionHash = actionHash,
        deviceId = deviceId,
        capability = approval.string("capability") ?: "PC action",
        consequence = approval.string("consequence") ?: "The PC requested a protected operation.",
        targetKind = target?.string("kind").orEmpty(),
        targetValue = target?.string("value").orEmpty(),
        expiresAt = approval.long("expiresAt") ?: 0L,
    )
}

internal fun parseOutcome(payload: JsonObject): TaskOutcome? {
    val summary = payload.string("safeSummary") ?: return null
    val status = when (payload.string("status")) {
        "succeeded" -> ResultStatus.SUCCEEDED
        "partial" -> ResultStatus.PARTIAL
        "failed" -> ResultStatus.FAILED
        "cancelled" -> ResultStatus.CANCELLED
        "timed_out" -> ResultStatus.TIMED_OUT
        "interrupted" -> ResultStatus.INTERRUPTED
        "unknown" -> ResultStatus.UNKNOWN
        else -> ResultStatus.UNKNOWN
    }
    val verification = (payload["verification"] as? JsonObject)
    val verificationStatus = when (verification?.string("status")) {
        "verified" -> VerificationStatus.VERIFIED
        "partial" -> VerificationStatus.PARTIAL
        "not_available" -> VerificationStatus.NOT_AVAILABLE
        "failed" -> VerificationStatus.FAILED
        else -> VerificationStatus.UNKNOWN
    }
    return TaskOutcome(
        status = status,
        verification = verificationStatus,
        verificationSummary = (payload["verification"] as? JsonObject)?.string("summary").orEmpty(),
        safeSummary = summary,
        completedAt = payload.long("completedAt") ?: 0L,
    )
}

private fun appendStep(previous: List<String>, summary: String): List<String> {
    if (summary.isBlank()) return previous
    if (previous.lastOrNull() == summary) return previous
    if (previous.contains(summary)) return previous
    return (previous + summary).takeLast(8)
}

private fun parseCancellationAcknowledgement(payload: JsonObject): CancellationAcknowledgement? {
    val taskId = payload.string("taskId") ?: return null
    val outcome = payload.string("outcome") ?: return null
    val state = payload.string("state") ?: return null
    if (taskId.isBlank()) return null
    if (outcome !in setOf("cancelled", "completed", "too_late", "partially_effective")) return null
    return CancellationAcknowledgement(outcome, stateLabel(state), payload.string("detail"))
}

/**
 * Folds one bridge event into the current phase.
 *
 * Events that do not describe the task lifecycle (manifest, session, pairing)
 * leave the phase untouched — the remote screen must not flash "Running" because
 * a manifest arrived.
 */
internal fun reduceRemoteTask(phase: RemoteTaskPhase, event: RemoteV2Event): RemoteTaskPhase {
    val payload = event.payload
    return when (event.type) {
        "task.accepted" -> {
            val summary = payload.string("safeSummary")
                ?: "The PC accepted the task."
            RemoteTaskPhase.Running(
                stateLabel = stateLabel(payload.string("state") ?: "accepted"),
                summary = summary,
                percentComplete = null,
                steps = appendStep(emptyList(), summary),
                taskId = payload.string("taskId"),
                requestId = payload.string("requestId"),
            )
        }

        "task.progress" -> {
            val summary = payload.string("safeSummary").orEmpty()
            val previous = phase as? RemoteTaskPhase.Running
            val previousSteps = previous?.steps.orEmpty()
            val percent = (payload["percentComplete"] as? JsonPrimitive)
                ?.intOrNull
                ?.coerceIn(0, 100)
            RemoteTaskPhase.Running(
                stateLabel = stateLabel(payload.string("state") ?: "running"),
                summary = summary.ifBlank { "The PC is working on it." },
                percentComplete = percent,
                steps = appendStep(previousSteps, summary),
                taskId = payload.string("taskId") ?: previous?.taskId,
                requestId = previous?.requestId,
                cancellationRequested = previous?.cancellationRequested ?: false,
                cancellationAck = previous?.cancellationAck,
                cancellationError = previous?.cancellationError,
            )
        }

        "task.confirmation_required" -> {
            val approval = payload["approval"] as? JsonObject
            val parsed = approval?.let(::parsePendingApproval)
            if (parsed == null) {
                // An approval we cannot bind to an action hash is not approvable.
                // Say so instead of offering a button that cannot work.
                RemoteTaskPhase.Failed(
                    message = "The PC asked for approval but did not send a complete request.",
                    retryable = false,
                )
            } else {
                RemoteTaskPhase.AwaitingApproval(parsed)
            }
        }

        "task.cancel_ack" -> {
            val previous = phase as? RemoteTaskPhase.Running ?: return phase
            if (payload.string("taskId") != previous.taskId) return phase
            val acknowledgement = parseCancellationAcknowledgement(payload) ?: return phase
            previous.copy(
                cancellationRequested = false,
                cancellationAck = acknowledgement,
                cancellationError = null,
            )
        }

        "task.result" -> parseOutcome(payload)?.let { RemoteTaskPhase.Finished(it) } ?: phase

        "task.error" -> RemoteTaskPhase.Failed(
            message = payload.string("message") ?: "The PC reported an error.",
            retryable = payload.bool("retryable"),
        )

        "protocol.error" -> RemoteTaskPhase.Failed(
            message = payload.string("message") ?: payload.toString(),
            retryable = payload.bool("retryable"),
        )

        else -> phase
    }
}
