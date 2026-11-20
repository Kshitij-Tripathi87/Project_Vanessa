package com.vanessa.mobile.ui.state

import com.vanessa.mobile.remote.RemoteV2Event
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.put
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

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

    data class AwaitingApproval(
        val approval: PendingApproval,
        /** Carried from task.submit/task.accepted so the task can still be stopped after approval. */
        val requestId: String? = null,
    ) : RemoteTaskPhase

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

    /**
     * A protocol error or a lost connection — not a task outcome.
     *
     * [correlation] is set only when the failure is provably about one task. A
     * connection-level failure stays unattributed, because blaming the task the
     * user happens to be looking at would be an invented causal link.
     */
    data class Failed(
        val message: String,
        val retryable: Boolean,
        val correlation: Correlation = Correlation(),
    ) : RemoteTaskPhase

    /**
     * A session is being re-established and the PC's snapshots are still
     * arriving. Shown instead of the last known screen so a stale "Executing"
     * never sits on screen while the phone has no idea what is happening.
     */
    data class Recovering(
        val detail: String = "Checking what the PC is still working on…",
        /**
         * The task we were following when the connection dropped.
         *
         * Recovery without this was a hole: a replayed event arriving mid-recovery
         * could silently install an unrelated task as the active one. The identity
         * carries across the drop so replayed updates can still be checked against
         * it; the PC's snapshot may confirm it, but a stray event cannot replace it.
         */
        val taskId: String? = null,
        val requestId: String? = null,
    ) : RemoteTaskPhase

    /**
     * The PC answered, but not with enough to rebuild the screen.
     *
     * This exists so recovery can fail honestly. The temptation is to fill the
     * gap with the last thing we saw on this device and present it as current
     * state; that would be a fabricated status indicator, which is exactly what
     * the design brief forbids.
     */
    data class Unrecoverable(val title: String, val message: String) : RemoteTaskPhase
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
    // An approval without a usable expiry cannot be enforced, and one we cannot
    // enforce is not one we may offer. Fail closed rather than showing a button
    // whose deadline is decorative.
    val expiresAt = approval.long("expiresAt")?.takeIf { it > 0L } ?: return null
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
        expiresAt = expiresAt,
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
/* ---------------------------- recovery ---------------------------------- */

private val TERMINAL_STATES = setOf(
    "succeeded", "partial", "failed", "cancelled", "timed_out", "interrupted",
)

private fun isTerminal(state: String): Boolean = state in TERMINAL_STATES

/** One entry of `sync.snapshot.tasks` / `task.snapshot.task`. */
private data class TaskSnapshotEntry(
    val taskId: String,
    val requestId: String?,
    val state: String,
    val updatedAt: Long,
    val safeSummary: String,
)

private fun parseTaskSnapshot(json: JsonObject): TaskSnapshotEntry? {
    val taskId = json.string("taskId") ?: return null
    return TaskSnapshotEntry(
        taskId = taskId,
        requestId = json.string("requestId"),
        state = json.string("state") ?: "unknown",
        updatedAt = json.long("updatedAt") ?: 0L,
        safeSummary = json.string("safeSummary").orEmpty(),
    )
}

/**
 * A sync event carries a flat `safePayload` and never raw tool output. If it
 * holds a human line we use it; otherwise the state label is the honest thing
 * to show, because it is what the PC actually said.
 */
private fun TaskEventLine(state: String, event: JsonObject): String {
    val safe = event["safePayload"] as? JsonObject
    val line = safe?.string("safeSummary")
        ?: safe?.string("summary")
        ?: safe?.string("detail")
    return line?.takeIf { it.isNotBlank() } ?: stateLabel(state)
}

private fun eventsFor(payload: JsonObject, taskId: String): List<String> =
    (payload["events"] as? JsonArray)
        .orEmpty()
        .mapNotNull { it as? JsonObject }
        .filter { it.string("taskId") == taskId }
        .sortedBy { (it["eventSeq"] as? JsonPrimitive)?.longOrNull ?: 0L }
        .mapNotNull { event ->
            val state = event.string("state") ?: return@mapNotNull null
            TaskEventLine(state, event)
        }
        .fold(emptyList<String>()) { acc, line -> appendStep(acc, line) }
        .takeLast(8)

private fun statusFromState(state: String): ResultStatus = when (state) {
    "succeeded" -> ResultStatus.SUCCEEDED
    "partial" -> ResultStatus.PARTIAL
    "failed" -> ResultStatus.FAILED
    "cancelled" -> ResultStatus.CANCELLED
    "timed_out" -> ResultStatus.TIMED_OUT
    "interrupted" -> ResultStatus.INTERRUPTED
    else -> ResultStatus.UNKNOWN
}

/**
 * What a phase is tracking, if anything.
 *
 * There is exactly one of these. Live events, replayed events, snapshots and
 * recovery all consult it, because the previous arrangement compared string
 * fields ad hoc at each call site and two implementations of "is this the same
 * task?" drifted apart — one of them allowed a progress update for a foreign
 * task to overwrite the active screen.
 */
internal data class Correlation(val taskId: String? = null, val requestId: String? = null) {
    val isKnown: Boolean get() = taskId != null || requestId != null
}

internal fun correlationOf(phase: RemoteTaskPhase): Correlation = when (phase) {
    is RemoteTaskPhase.Submitted -> Correlation(requestId = phase.requestId)
    is RemoteTaskPhase.Running -> Correlation(phase.taskId, phase.requestId)
    is RemoteTaskPhase.AwaitingApproval -> Correlation(phase.approval.taskId, phase.requestId)
    is RemoteTaskPhase.Recovering -> Correlation(phase.taskId, phase.requestId)
    is RemoteTaskPhase.Failed -> phase.correlation
    is RemoteTaskPhase.Idle,
    is RemoteTaskPhase.Finished,
    is RemoteTaskPhase.Unrecoverable -> Correlation()
}

/**
 * Strict: true only when this phase is already tracking exactly this task.
 *
 * Used by every live or replayed update that describes work in progress. Such an
 * update must never be able to *create* the active task — only an acceptance or
 * an authoritative snapshot may do that.
 */
internal fun matchesActiveTask(phase: RemoteTaskPhase, incomingTaskId: String?): Boolean {
    val active = correlationOf(phase).taskId ?: return false
    return incomingTaskId == active
}

/** Strict: true only when this phase is already tracking exactly this request. */
internal fun matchesSubmittedRequest(phase: RemoteTaskPhase, incomingRequestId: String?): Boolean {
    val active = correlationOf(phase).requestId ?: return false
    return incomingRequestId == active
}

/**
 * True when [incomingTaskId] may become the tracked task: either nothing is
 * tracked yet, or it is the same task.
 *
 * Only authoritative PC statements (`task.snapshot`, `sync.event`) use this.
 * They are the one source allowed to establish identity, which is why they are
 * separate from [matchesActiveTask].
 */
internal fun mayAdoptTask(phase: RemoteTaskPhase, incomingTaskId: String): Boolean {
    val active = correlationOf(phase).taskId ?: return true
    return active == incomingTaskId
}

private fun lastReportedPercent(phase: RemoteTaskPhase, taskId: String): Int? =
    (phase as? RemoteTaskPhase.Running)?.takeIf { it.taskId == taskId }?.percentComplete

/**
 * Rebuilds the screen from a `sync.snapshot`.
 *
 * Three refusals define this function, and each one is a place where a lesser
 * implementation would invent state:
 *
 *  - `historyGap` means the PC discarded the events we missed. We cannot know
 *    what happened, so we say so instead of guessing from the last summary.
 *  - `awaiting_approval` cannot be restored: the snapshot has no approval
 *    identifier, action hash or expiry, so there is nothing to sign and no
 *    request we could honestly put an Approve button in front of.
 *  - a terminal snapshot never carries a verification block, so a restored
 *    "succeeded" is reported as unverified — never as a green tick.
 */
internal fun recoverFromSnapshot(payload: JsonObject): RemoteTaskPhase {
    val tasks = (payload["tasks"] as? JsonArray)
        .orEmpty()
        .mapNotNull { (it as? JsonObject)?.let(::parseTaskSnapshot) }
    if (tasks.isEmpty()) return RemoteTaskPhase.Idle

    val chosen = tasks.filterNot { isTerminal(it.state) }.maxByOrNull { it.updatedAt }
        ?: tasks.maxByOrNull { it.updatedAt }
        ?: return RemoteTaskPhase.Idle

    if (payload.bool("historyGap")) {
        return RemoteTaskPhase.Unrecoverable(
            title = "Can't rebuild this task",
            message = "The PC no longer holds the updates for " +
                "${chosen.safeSummary.ifBlank { "this task" }}, so Vanessa can't show " +
                "what has happened since. Check the task on the PC.",
        )
    }

    if (chosen.state == "awaiting_approval") {
        return RemoteTaskPhase.Unrecoverable(
            title = "Waiting for approval",
            message = "The PC is waiting on an approval for this task. This phone can't " +
                "rebuild the signed request, so approve or cancel it on the PC, or let it expire.",
        )
    }

    if (isTerminal(chosen.state)) {
        return RemoteTaskPhase.Finished(
            TaskOutcome(
                status = statusFromState(chosen.state),
                verification = VerificationStatus.UNKNOWN,
                verificationSummary = "",
                safeSummary = chosen.safeSummary.ifBlank { stateLabel(chosen.state) },
                completedAt = chosen.updatedAt,
            ),
        )
    }

    return RemoteTaskPhase.Running(
        stateLabel = stateLabel(chosen.state),
        summary = chosen.safeSummary.ifBlank { "The PC is still working on this task." },
        // A snapshot has no percentComplete field. Null is the truth.
        percentComplete = null,
        steps = eventsFor(payload, chosen.taskId),
        taskId = chosen.taskId,
        requestId = chosen.requestId,
    )
}

/** A single task refresh (`task.snapshot`), or one replayed event (`sync.event`). */
internal fun applyTaskSnapshot(phase: RemoteTaskPhase, payload: JsonObject): RemoteTaskPhase {
    val task = (payload["task"] as? JsonObject)?.let(::parseTaskSnapshot) ?: return phase
    if (!mayAdoptTask(phase, task.taskId)) return phase

    if (isTerminal(task.state)) {
        return RemoteTaskPhase.Finished(
            TaskOutcome(
                status = statusFromState(task.state),
                verification = VerificationStatus.UNKNOWN,
                verificationSummary = "",
                safeSummary = task.safeSummary.ifBlank { stateLabel(task.state) },
                completedAt = task.updatedAt,
            ),
        )
    }
    if (task.state == "awaiting_approval") {
        return RemoteTaskPhase.Unrecoverable(
            title = "Waiting for approval",
            message = "The PC is waiting on an approval this phone can't rebuild. " +
                "Approve or cancel it on the PC, or let it expire.",
        )
    }
    return RemoteTaskPhase.Running(
        stateLabel = stateLabel(task.state),
        summary = task.safeSummary.ifBlank { "The PC is still working on this task." },
        percentComplete = lastReportedPercent(phase, task.taskId),
        steps = (phase as? RemoteTaskPhase.Running)?.steps.orEmpty(),
        taskId = task.taskId,
        requestId = task.requestId,
    )
}

internal fun applySyncEvent(phase: RemoteTaskPhase, payload: JsonObject): RemoteTaskPhase {
    val event = payload["event"] as? JsonObject ?: return phase
    val taskId = event.string("taskId") ?: return phase
    val state = event.string("state") ?: return phase
    if (!mayAdoptTask(phase, taskId)) return phase
    val line = TaskEventLine(state, event)

    if (isTerminal(state)) {
        return RemoteTaskPhase.Finished(
            TaskOutcome(
                status = statusFromState(state),
                verification = VerificationStatus.UNKNOWN,
                verificationSummary = "",
                safeSummary = line,
                completedAt = (event["at"] as? JsonPrimitive)?.longOrNull ?: 0L,
            ),
        )
    }
    if (state == "awaiting_approval") {
        return RemoteTaskPhase.Unrecoverable(
            title = "Waiting for approval",
            message = "The PC is waiting on an approval this phone can't rebuild. " +
                "Approve or cancel it on the PC, or let it expire.",
        )
    }
    return RemoteTaskPhase.Running(
        stateLabel = stateLabel(state),
        summary = line,
        percentComplete = lastReportedPercent(phase, taskId),
        steps = appendStep((phase as? RemoteTaskPhase.Running)?.steps.orEmpty(), line),
        taskId = taskId,
        requestId = (phase as? RemoteTaskPhase.Running)?.requestId,
    )
}

internal fun reduceRemoteTask(phase: RemoteTaskPhase, event: RemoteV2Event): RemoteTaskPhase {
    val payload = event.payload
    return when (event.type) {
        // An acceptance is the only live event allowed to establish task identity,
        // and it does so only for the request this phone is actually waiting on.
        // A delayed acceptance for an older request must not hijack the screen.
        "task.accepted" -> {
            val submitted = phase as? RemoteTaskPhase.Submitted ?: return phase
            if (!matchesSubmittedRequest(submitted, payload.string("requestId"))) return phase
            val taskId = payload.string("taskId") ?: return phase
            val summary = payload.string("safeSummary") ?: "The PC accepted the task."
            RemoteTaskPhase.Running(
                stateLabel = stateLabel(payload.string("state") ?: "accepted"),
                summary = summary,
                percentComplete = null,
                steps = appendStep(emptyList(), summary),
                taskId = taskId,
                requestId = submitted.requestId,
            )
        }

        // Progress cannot arrive before acceptance: the task ID is only issued by
        // task.accepted, so a progress event for a task we never accepted is
        // either stale or foreign. Both are ignored.
        "task.progress" -> {
            val previous = phase as? RemoteTaskPhase.Running ?: return phase
            val incomingTaskId = payload.string("taskId") ?: return phase
            if (!matchesActiveTask(phase, incomingTaskId)) return phase
            val summary = payload.string("safeSummary").orEmpty()
            val reported = (payload["percentComplete"] as? JsonPrimitive)
                ?.intOrNull
                ?.coerceIn(0, 100)
            RemoteTaskPhase.Running(
                stateLabel = stateLabel(payload.string("state") ?: "running"),
                summary = summary.ifBlank { "The PC is working on it." },
                // A progress event without a percentage keeps the last one the PC
                // genuinely reported. Null stays null: silence is not 0%.
                percentComplete = reported ?: previous.percentComplete,
                steps = appendStep(previous.steps, summary),
                taskId = incomingTaskId,
                requestId = previous.requestId,
                cancellationRequested = previous.cancellationRequested,
                cancellationAck = previous.cancellationAck,
                cancellationError = previous.cancellationError,
            )
        }

        // The protocol emits task.accepted before an approval can be requested, so
        // an approval arriving while we are still in Submitted has no task to bind
        // to and is refused rather than shown.
        "task.confirmation_required" -> {
            val running = phase as? RemoteTaskPhase.Running ?: return phase
            val parsed = (payload["approval"] as? JsonObject)?.let(::parsePendingApproval)
            if (parsed == null) {
                RemoteTaskPhase.Failed(
                    message = "The PC asked for approval but did not send a complete, " +
                        "time-limited request, so Vanessa cannot sign it.",
                    retryable = false,
                    correlation = correlationOf(phase),
                )
            } else if (!matchesActiveTask(phase, parsed.taskId)) {
                phase
            } else {
                RemoteTaskPhase.AwaitingApproval(approval = parsed, requestId = running.requestId)
            }
        }

        "task.cancel_ack" -> {
            val previous = phase as? RemoteTaskPhase.Running ?: return phase
            if (!matchesActiveTask(phase, payload.string("taskId"))) return phase
            val acknowledgement = parseCancellationAcknowledgement(payload) ?: return phase
            previous.copy(
                cancellationRequested = false,
                cancellationAck = acknowledgement,
                cancellationError = null,
            )
        }

        // A result for a task this phone is not tracking cannot be attributed to
        // the screen, so it is dropped. Acknowledging a cancellation is also not a
        // result — only task.result finishes a task.
        "task.result" -> {
            if (!matchesActiveTask(phase, payload.string("taskId"))) return phase
            parseOutcome(payload)?.let { RemoteTaskPhase.Finished(it) } ?: phase
        }

        "task.error" -> {
            val eventTaskId = payload.string("taskId")
            val accepted = when {
                phase is RemoteTaskPhase.Submitted ->
                    // Before acceptance the only attributable rejection is the one
                    // that carries no task ID: a supplied ID cannot be matched yet.
                    eventTaskId == null
                correlationOf(phase).taskId == null -> false
                else -> matchesActiveTask(phase, eventTaskId)
            }
            if (!accepted) return phase
            RemoteTaskPhase.Failed(
                message = payload.string("message") ?: "The PC reported an error.",
                retryable = payload.bool("retryable"),
                correlation = correlationOf(phase),
            )
        }

        // A protocol error is about the session unless it names a task. It keeps
        // its attribution empty in the session case: a dropped frame is not
        // evidence that the running task failed.
        "protocol.error" -> {
            val eventTaskId = payload.string("taskId")
            if (eventTaskId != null && !matchesActiveTask(phase, eventTaskId)) return phase
            RemoteTaskPhase.Failed(
                message = payload.string("message") ?: payload.toString(),
                retryable = payload.bool("retryable"),
                correlation = if (eventTaskId == null) Correlation() else correlationOf(phase),
            )
        }

        // ---- reconnect / recovery ----------------------------------------
        "sync.snapshot" -> recoverFromSnapshot(payload)
        "sync.event" -> applySyncEvent(phase, payload)
        "task.snapshot" -> applyTaskSnapshot(phase, payload)
        "sync.complete" ->
            if (phase is RemoteTaskPhase.Recovering) RemoteTaskPhase.Idle else phase

        else -> phase
    }
}

/* --------------------- surviving Activity recreation --------------------- */

/**
 * Serialises a phase for `onSaveInstanceState`.
 *
 * Rotation must not destroy a pending approval or a running task, and it must
 * also not *recreate* one: decoding only rebuilds what was encoded, so a
 * restored screen can never claim a state the app was not already showing.
 * Deliberately a string rather than a `Parcelable` so the round trip is
 * testable on the JVM without Robolectric.
 */
internal fun encodeRemoteTaskPhase(phase: RemoteTaskPhase): String = when (phase) {
    RemoteTaskPhase.Idle -> buildJsonObject { put("kind", "idle") }

    is RemoteTaskPhase.Submitted -> buildJsonObject {
        put("kind", "submitted")
        phase.capability?.let { put("capability", it) }
        phase.requestId?.let { put("requestId", it) }
    }

    is RemoteTaskPhase.AwaitingApproval -> buildJsonObject {
        put("kind", "awaiting")
        put("approvalId", phase.approval.approvalId)
        put("taskId", phase.approval.taskId)
        put("actionHash", phase.approval.actionHash)
        put("deviceId", phase.approval.deviceId)
        put("capability", phase.approval.capability)
        put("consequence", phase.approval.consequence)
        put("targetKind", phase.approval.targetKind)
        put("targetValue", phase.approval.targetValue)
        put("expiresAt", phase.approval.expiresAt)
        phase.requestId?.let { put("requestId", it) }
    }

    is RemoteTaskPhase.Running -> buildJsonObject {
        put("kind", "running")
        put("stateLabel", phase.stateLabel)
        put("summary", phase.summary)
        phase.percentComplete?.let { put("percentComplete", it) }
        put("steps", JsonArray(phase.steps.map { JsonPrimitive(it) }))
        phase.taskId?.let { put("taskId", it) }
        phase.requestId?.let { put("requestId", it) }
        put("cancellationRequested", phase.cancellationRequested)
    }

    is RemoteTaskPhase.Finished -> buildJsonObject {
        put("kind", "finished")
        put("status", phase.outcome.status.name)
        put("verification", phase.outcome.verification.name)
        put("verificationSummary", phase.outcome.verificationSummary)
        put("safeSummary", phase.outcome.safeSummary)
        put("completedAt", phase.outcome.completedAt)
    }

    is RemoteTaskPhase.Failed -> buildJsonObject {
        put("kind", "failed")
        put("message", phase.message)
        put("retryable", phase.retryable)
        phase.correlation.taskId?.let { put("taskId", it) }
        phase.correlation.requestId?.let { put("requestId", it) }
    }

    is RemoteTaskPhase.Recovering -> buildJsonObject {
        put("kind", "recovering")
        put("detail", phase.detail)
        phase.taskId?.let { put("taskId", it) }
        phase.requestId?.let { put("requestId", it) }
    }

    is RemoteTaskPhase.Unrecoverable -> buildJsonObject {
        put("kind", "unrecoverable")
        put("title", phase.title)
        put("message", phase.message)
    }
}.toString()

/** Anything unreadable decodes to [RemoteTaskPhase.Idle]: no screen is safer than a wrong one. */
internal fun decodeRemoteTaskPhase(raw: String?): RemoteTaskPhase {
    if (raw.isNullOrBlank()) return RemoteTaskPhase.Idle
    val json = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull()
        ?: return RemoteTaskPhase.Idle
    fun text(key: String): String? = (json[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun num(key: String): Long? = (json[key] as? JsonPrimitive)?.longOrNull
    fun flag(key: String): Boolean =
        (json[key] as? JsonPrimitive)?.let { runCatching { it.content.toBoolean() }.getOrDefault(false) }
            ?: false

    return when (text("kind")) {
        "submitted" -> RemoteTaskPhase.Submitted(text("capability"), text("requestId"))

        "awaiting" -> {
            val approvalId = text("approvalId")
            val taskId = text("taskId")
            val actionHash = text("actionHash")
            val deviceId = text("deviceId")
            // A restored approval is only offered when the full binding survived.
            if (approvalId == null || taskId == null || actionHash == null || deviceId == null) {
                RemoteTaskPhase.Unrecoverable(
                    title = "Approval lost",
                    message = "Vanessa restarted while this approval was open and could not " +
                        "rebuild the signed request. Approve or cancel it on the PC.",
                )
            } else {
                RemoteTaskPhase.AwaitingApproval(
                    approval = PendingApproval(
                        approvalId = approvalId,
                        taskId = taskId,
                        actionHash = actionHash,
                        deviceId = deviceId,
                        capability = text("capability") ?: "PC action",
                        consequence = text("consequence") ?: "The PC requested a protected operation.",
                        targetKind = text("targetKind").orEmpty(),
                        targetValue = text("targetValue").orEmpty(),
                        expiresAt = num("expiresAt") ?: 0L,
                    ),
                    requestId = text("requestId"),
                )
            }
        }

        "running" -> RemoteTaskPhase.Running(
            stateLabel = text("stateLabel") ?: "Working",
            summary = text("summary").orEmpty(),
            percentComplete = num("percentComplete")?.toInt()?.coerceIn(0, 100),
            steps = (json["steps"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                .takeLast(8),
            taskId = text("taskId"),
            requestId = text("requestId"),
            cancellationRequested = flag("cancellationRequested"),
        )

        "finished" -> {
            val status = text("status")?.let { name ->
                ResultStatus.entries.firstOrNull { it.name == name }
            } ?: ResultStatus.UNKNOWN
            val verification = text("verification")?.let { name ->
                VerificationStatus.entries.firstOrNull { it.name == name }
            } ?: VerificationStatus.UNKNOWN
            RemoteTaskPhase.Finished(
                TaskOutcome(
                    status = status,
                    verification = verification,
                    verificationSummary = text("verificationSummary").orEmpty(),
                    safeSummary = text("safeSummary").orEmpty(),
                    completedAt = num("completedAt") ?: 0L,
                ),
            )
        }

        "failed" -> RemoteTaskPhase.Failed(
            message = text("message") ?: "Unknown error.",
            retryable = flag("retryable"),
            correlation = Correlation(taskId = text("taskId"), requestId = text("requestId")),
        )

        "recovering" -> RemoteTaskPhase.Recovering(
            detail = text("detail") ?: "Reconnecting to the PC…",
            taskId = text("taskId"),
            requestId = text("requestId"),
        )

        "unrecoverable" -> RemoteTaskPhase.Unrecoverable(
            title = text("title") ?: "State unavailable",
            message = text("message").orEmpty(),
        )

        else -> RemoteTaskPhase.Idle
    }
}

/**
 * What the screen should say when the connection changes under it.
 *
 * A running task whose PC connection dropped is not "still running" as far as
 * this phone knows — it becomes [RemoteTaskPhase.Recovering] until the PC's
 * snapshots say otherwise.
 *
 * A pending approval is deliberately left alone: the request is still a fact,
 * it has its own expiry, and a decision made now fails closed through the
 * signature path rather than being silently discarded by a connection blip.
 */
internal fun phaseOnConnectionChange(
    phase: RemoteTaskPhase,
    connectionState: String,
): RemoteTaskPhase {
    val stalled = connectionState.startsWith("Remote PC disconnected") ||
        connectionState.startsWith("Reconnecting") ||
        connectionState.startsWith("Connecting")
    if (!stalled) return phase
    return when (phase) {
        is RemoteTaskPhase.Running -> RemoteTaskPhase.Recovering(
            detail = "Reconnecting to the PC…",
            taskId = phase.taskId,
            requestId = phase.requestId,
        )
        is RemoteTaskPhase.Submitted -> RemoteTaskPhase.Recovering(
            detail = "Reconnecting to the PC…",
            requestId = phase.requestId,
        )
        else -> phase
    }
}
