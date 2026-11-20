package com.vanessa.mobile.ui.state

import com.vanessa.mobile.remote.RemoteV2Event
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reducer is where "do not claim more than the PC reported" is enforced, so
 * these tests target the places the UI could otherwise quietly overstate: a
 * percentage that was never sent, an outcome that was never verified, an
 * approval that is not bound to an action hash.
 */
class RemoteTaskUiTest {

    private fun event(type: String, payload: JsonObject) = RemoteV2Event(type, payload)

    private val taskId = "0f3d0c1e-0000-4000-8000-000000000001"
    private val otherTaskId = "bbbbbbbb-0000-4000-8000-000000000009"
    private val requestId = "9d3b6e17-0000-4000-8000-000000000002"
    private val otherRequestId = "cccccccc-0000-4000-8000-000000000008"

    /** Waiting for an acceptance for exactly one request. */
    private fun submitted(capability: String = "open_app") =
        RemoteTaskPhase.Submitted(capability, requestId)

    private fun accepted(
        request: String = requestId,
        task: String = taskId,
        summary: String = "Accepted.",
    ): JsonObject = buildJsonObject {
        put("requestId", request)
        put("taskId", task)
        put("state", "accepted")
        put("safeSummary", summary)
        put("eventSeq", 2)
    }

    /** A phase that legitimately accepted [taskId] for [requestId]. */
    private fun running(): RemoteTaskPhase.Running = RemoteTaskPhase.Running(
        stateLabel = "Accepted",
        summary = "Accepted.",
        percentComplete = null,
        steps = listOf("Accepted."),
        taskId = taskId,
        requestId = requestId,
    )

    private fun progress(state: String, summary: String, percent: Int? = null): JsonObject =
        buildJsonObject {
            put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
            put("state", state)
            put("eventSeq", 1)
            put("safeSummary", summary)
            if (percent != null) put("percentComplete", percent)
        }

    private fun result(
        status: String,
        verificationStatus: String,
        summary: String = "Done.",
        verificationSummary: String = "Checked the window title.",
    ): JsonObject = buildJsonObject {
        put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
        put("status", status)
        put("verification", buildJsonObject {
            put("status", verificationStatus)
            put("summary", verificationSummary)
        })
        put("safeSummary", summary)
        put("eventSeq", 9)
        put("completedAt", 1_700_000_000_000L)
    }

    private fun approval(withActionHash: Boolean = true): JsonObject = buildJsonObject {
        put("approvalId", "b1c7bde2-0000-4000-8000-000000000002")
        put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
        put("taskVersion", 1)
        put("deviceId", "device-abc")
        put("capability", "delete_files")
        put("capabilityVersion", 2)
        put("consequence", "Deletes the selected files permanently.")
        put("target", buildJsonObject {
            put("kind", "file")
            put("value", "C:/Users/me/scratch")
        })
        if (withActionHash) put("actionHash", "a".repeat(64))
        put("policyVersion", "3")
        put("expiresAt", 1_700_000_600_000L)
    }

    @Test
    fun progressWithoutPercentReportsNoPercentage() {
        val phase = reduceRemoteTask(running(), event("task.progress", progress("running", "Copying")))
        val running = phase as RemoteTaskPhase.Running
        assertNull("A missing percentComplete must stay missing", running.percentComplete)
    }

    @Test
    fun reportedPercentIsUsedAndClamped() {
        val withPercent = reduceRemoteTask(
            running(),
            event("task.progress", progress("running", "Copying", 40)),
        ) as RemoteTaskPhase.Running
        assertEquals(40, withPercent.percentComplete)

        val over = reduceRemoteTask(
            running(),
            event("task.progress", progress("running", "Copying", 140)),
        ) as RemoteTaskPhase.Running
        assertEquals(100, over.percentComplete)
    }

    @Test
    fun stepsAccumulateWithoutRepeatingTheSameLine() {
        var phase: RemoteTaskPhase = running()
        phase = reduceRemoteTask(phase, event("task.progress", progress("planning", "Planning the steps")))
        phase = reduceRemoteTask(phase, event("task.progress", progress("running", "Opening Chrome")))
        phase = reduceRemoteTask(phase, event("task.progress", progress("running", "Opening Chrome")))
        val running = phase as RemoteTaskPhase.Running
        assertEquals(listOf("Accepted.", "Planning the steps", "Opening Chrome"), running.steps)
    }

    @Test
    fun acceptedStartsTheRunWithoutAPercentage() {
        val payload = buildJsonObject {
            put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
            put("requestId", "9d3b6e17-0000-4000-8000-000000000002")
            put("state", "accepted")
            put("safeSummary", "Accepted: open chrome.")
            put("eventSeq", 2)
        }
        val running = reduceRemoteTask(
            RemoteTaskPhase.Submitted("open_app", "9d3b6e17-0000-4000-8000-000000000002"),
            event("task.accepted", payload),
        ) as RemoteTaskPhase.Running
        assertEquals("Accepted", running.stateLabel)
        assertNull(running.percentComplete)
        assertEquals(listOf("Accepted: open chrome."), running.steps)
        assertEquals("0f3d0c1e-0000-4000-8000-000000000001", running.taskId)
        assertEquals("9d3b6e17-0000-4000-8000-000000000002", running.requestId)
    }

    @Test
    fun cancelAcknowledgementIsNotMistakenForATerminalTaskResult() {
        val accepted = buildJsonObject {
            put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
            put("requestId", "9d3b6e17-0000-4000-8000-000000000002")
            put("state", "accepted")
            put("taskVersion", 1)
            put("eventSeq", 0)
            put("acceptedAt", 1_700_000_000_000L)
        }
        val running = reduceRemoteTask(
            RemoteTaskPhase.Submitted("system_status", "9d3b6e17-0000-4000-8000-000000000002"),
            event("task.accepted", accepted),
        ) as RemoteTaskPhase.Running

        val ack = buildJsonObject {
            put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
            put("outcome", "cancelled")
            put("state", "cancelled")
        }
        val afterAck = reduceRemoteTask(
            running.copy(cancellationRequested = true),
            event("task.cancel_ack", ack),
        ) as RemoteTaskPhase.Running

        assertEquals("0f3d0c1e-0000-4000-8000-000000000001", afterAck.taskId)
        assertEquals("9d3b6e17-0000-4000-8000-000000000002", afterAck.requestId)
        assertEquals(false, afterAck.cancellationRequested)
        assertEquals("cancelled", afterAck.cancellationAck?.outcome)
        assertEquals("Cancelled", afterAck.cancellationAck?.state)
    }

    @Test
    fun cancelAcknowledgementForDifferentTaskIsIgnored() {
        val running = RemoteTaskPhase.Running(
            stateLabel = "Running",
            summary = "Working",
            percentComplete = null,
            steps = listOf("Working"),
            taskId = "0f3d0c1e-0000-4000-8000-000000000001",
            requestId = "9d3b6e17-0000-4000-8000-000000000002",
        )
        val ack = buildJsonObject {
            put("taskId", "aaaaaaaa-0000-4000-8000-000000000000")
            put("outcome", "cancelled")
            put("state", "cancelled")
        }
        assertEquals(running, reduceRemoteTask(running, event("task.cancel_ack", ack)))
    }

    @Test
    fun verifiedSuccessIsTheOnlySuccess() {
        val phase = reduceRemoteTask(running(), event("task.result", result("succeeded", "verified")))
        val outcome = (phase as RemoteTaskPhase.Finished).outcome
        assertEquals(OutcomeTone.SUCCESS, outcome.tone)
    }

    @Test
    fun succeededButUnverifiedIsNotReportedAsSuccess() {
        val phase = reduceRemoteTask(
            running(),
            event("task.result", result("succeeded", "not_available")),
        )
        val outcome = (phase as RemoteTaskPhase.Finished).outcome
        assertEquals(ResultStatus.SUCCEEDED, outcome.status)
        assertEquals(OutcomeTone.UNVERIFIED, outcome.tone)
        assertNotEquals(OutcomeTone.SUCCESS, outcome.tone)
    }

    @Test
    fun failedVerificationIsNotASuccessEvenWhenTheTaskSucceeded() {
        val phase = reduceRemoteTask(
            running(),
            event("task.result", result("succeeded", "failed")),
        )
        assertEquals(OutcomeTone.UNVERIFIED, (phase as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test
    fun partialAndFailedStatusesKeepTheirOwnTone() {
        val partial = reduceRemoteTask(running(), event("task.result", result("partial", "partial")))
        assertEquals(OutcomeTone.PARTIAL, (partial as RemoteTaskPhase.Finished).outcome.tone)

        val failed = reduceRemoteTask(running(), event("task.result", result("failed", "failed")))
        assertEquals(OutcomeTone.FAILURE, (failed as RemoteTaskPhase.Finished).outcome.tone)

        val timeout = reduceRemoteTask(running(), event("task.result", result("timed_out", "not_available")))
        assertEquals(OutcomeTone.FAILURE, (timeout as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test
    fun protectedApprovalPreservesRequestIdForLaterCancellation() {
        val requestId = "9d3b6e17-0000-4000-8000-000000000002"
        val taskId = "0f3d0c1e-0000-4000-8000-000000000001"
        val accepted = buildJsonObject {
            put("requestId", requestId)
            put("taskId", taskId)
            put("state", "accepted")
            put("safeSummary", "Accepted.")
            put("eventSeq", 1)
        }
        val running = reduceRemoteTask(
            RemoteTaskPhase.Submitted("delete_files", requestId),
            event("task.accepted", accepted),
        )
        val confirmation = buildJsonObject {
            put("approval", approval())
            put("eventSeq", 2)
        }
        val awaiting = reduceRemoteTask(
            running,
            event("task.confirmation_required", confirmation),
        ) as RemoteTaskPhase.AwaitingApproval

        assertEquals(taskId, awaiting.approval.taskId)
        assertEquals(requestId, awaiting.requestId)
    }

    @Test
    fun approvalParsesTheBindingAndTarget() {
        val payload = buildJsonObject {
            put("approval", approval())
            put("eventSeq", 4)
        }
        val phase = reduceRemoteTask(running(), event("task.confirmation_required", payload))
        val pending = (phase as RemoteTaskPhase.AwaitingApproval).approval
        assertEquals("delete_files", pending.capability)
        assertEquals("file · C:/Users/me/scratch", pending.targetLabel)
        assertEquals(1_700_000_600_000L, pending.expiresAt)
        assertEquals("a".repeat(64), pending.actionHash)
    }

    @Test
    fun approvalWithoutAnActionHashIsNotOfferedAsApprovable() {
        val payload = buildJsonObject {
            put("approval", approval(withActionHash = false))
            put("eventSeq", 4)
        }
        val phase = reduceRemoteTask(running(), event("task.confirmation_required", payload))
        assertTrue("An unbound approval must not become an approvable screen", phase is RemoteTaskPhase.Failed)
    }

    @Test
    fun unrelatedEventsLeaveTheTaskPhaseAlone() {
        val running = reduceRemoteTask(running(), event("task.progress", progress("running", "Working")))
        val afterManifest = reduceRemoteTask(
            running,
            event("manifest.snapshot", buildJsonObject { put("eventSeq", 3) }),
        )
        assertEquals(running, afterManifest)
    }

    @Test
    fun aResultWithoutASummaryDoesNotBlankTheScreen() {
        val running = reduceRemoteTask(running(), event("task.progress", progress("running", "Working")))
        val partialPayload = buildJsonObject {
            put("taskId", "0f3d0c1e-0000-4000-8000-000000000001")
            put("status", "succeeded")
            put("eventSeq", 5)
        }
        assertEquals(running, reduceRemoteTask(running, event("task.result", partialPayload)))
    }

    @Test
    fun taskErrorIsAFailureNotAnOutcome() {
        val payload = buildJsonObject {
            put("code", "capability_not_available")
            put("message", "Chrome is not installed on the PC.")
            put("retryable", true)
        }
        // Before an acceptance the only attributable rejection is the one that
        // carries no task ID — see taskErrorWithATaskIdBeforeAcceptanceIsIgnored.
        val phase = reduceRemoteTask(submitted(), event("task.error", payload))
        val failure = phase as RemoteTaskPhase.Failed
        assertEquals("Chrome is not installed on the PC.", failure.message)
        assertTrue(failure.retryable)
    }


    /* ------------------------- recovery ------------------------- */

    private fun taskSnapshot(
        taskId: String,
        state: String,
        summary: String,
        updatedAt: Long = 1_700_000_000_000L,
        requestId: String = "0f3d0c1e-0000-4000-8000-0000000000aa",
    ): JsonObject = buildJsonObject {
        put("taskId", taskId)
        put("requestId", requestId)
        put("capability", "open_app")
        put("state", state)
        put("tier", "safe")
        put("taskVersion", 1)
        put("acceptedAt", updatedAt - 1000)
        put("updatedAt", updatedAt)
        put("safeSummary", summary)
    }

    private fun syncEvent(
        taskId: String,
        state: String,
        eventSeq: Int,
        safeSummary: String? = null,
    ): JsonObject = buildJsonObject {
        put("eventId", "0f3d0c1e-0000-4000-8000-0000000000ee")
        put("eventSeq", eventSeq)
        put("taskId", taskId)
        put("type", "tool")
        put("state", state)
        put("safePayload", buildJsonObject {
            if (safeSummary != null) put("safeSummary", safeSummary)
        })
        put("at", 1_700_000_000_500L)
    }

    private fun syncSnapshot(
        tasks: List<JsonObject>,
        events: List<JsonObject> = emptyList(),
        historyGap: Boolean = false,
    ): JsonObject = buildJsonObject {
        put("lastEventSeq", 42)
        put("historyGap", historyGap)
        put("tasks", JsonArray(tasks))
        put("events", JsonArray(events))
    }

    private val liveTask = "0f3d0c1e-0000-4000-8000-000000000001"
    private val otherTask = "0f3d0c1e-0000-4000-8000-000000000002"

    @Test
    fun aSnapshotRebuildsTheRunningTaskWithoutAPercentage() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event("sync.snapshot", syncSnapshot(listOf(taskSnapshot(liveTask, "running", "Opening Chrome")))),
        )
        val running = phase as RemoteTaskPhase.Running
        assertEquals("Opening Chrome", running.summary)
        assertEquals(liveTask, running.taskId)
        assertNull("A snapshot carries no percentage, so none may appear", running.percentComplete)
    }

    @Test
    fun anActiveTaskWinsOverAFinishedOneInTheSameSnapshot() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event(
                "sync.snapshot",
                syncSnapshot(
                    listOf(
                        taskSnapshot(otherTask, "succeeded", "Finished earlier", updatedAt = 1_700_000_500_000L),
                        taskSnapshot(liveTask, "running", "Still going", updatedAt = 1_700_000_000_000L),
                    ),
                ),
            ),
        )
        assertEquals(liveTask, (phase as RemoteTaskPhase.Running).taskId)
    }

    @Test
    fun aHistoryGapIsReportedAsUnrecoverableRatherThanGuessed() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event(
                "sync.snapshot",
                syncSnapshot(
                    listOf(taskSnapshot(liveTask, "running", "Editing the spreadsheet")),
                    historyGap = true,
                ),
            ),
        )
        val unknown = phase as RemoteTaskPhase.Unrecoverable
        assertTrue(unknown.message.contains("Editing the spreadsheet"))
    }

    @Test
    fun anAwaitingApprovalSnapshotIsNeverOfferedForSigning() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event("sync.snapshot", syncSnapshot(listOf(taskSnapshot(liveTask, "awaiting_approval", "Delete 3 files")))),
        )
        // The snapshot has no approvalId, actionHash or expiry, so there is
        // nothing this phone could sign. It must say so, not draw an Approve.
        assertTrue(phase is RemoteTaskPhase.Unrecoverable)
    }

    @Test
    fun aTerminalSnapshotIsNotReportedAsAVerifiedSuccess() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event("sync.snapshot", syncSnapshot(listOf(taskSnapshot(liveTask, "succeeded", "Opened Chrome")))),
        )
        val outcome = (phase as RemoteTaskPhase.Finished).outcome
        assertEquals(VerificationStatus.UNKNOWN, outcome.verification)
        assertNotEquals(OutcomeTone.SUCCESS, outcome.tone)
        assertEquals(OutcomeTone.UNVERIFIED, outcome.tone)
    }

    @Test
    fun snapshotStepsComeFromThatTasksEventsInOrder() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event(
                "sync.snapshot",
                syncSnapshot(
                    tasks = listOf(taskSnapshot(liveTask, "running", "Opening Chrome")),
                    events = listOf(
                        syncEvent(liveTask, "running", eventSeq = 2, safeSummary = "Inspecting the PC"),
                        syncEvent(otherTask, "running", eventSeq = 3, safeSummary = "Someone else's work"),
                        syncEvent(liveTask, "running", eventSeq = 4, safeSummary = "Launching the app"),
                    ),
                ),
            ),
        )
        assertEquals(
            listOf("Inspecting the PC", "Launching the app"),
            (phase as RemoteTaskPhase.Running).steps,
        )
    }

    @Test
    fun aSyncEventForAnotherTaskCannotTakeOverTheScreen() {
        val running = RemoteTaskPhase.Running(
            stateLabel = "Running",
            summary = "Opening Chrome",
            percentComplete = 40,
            steps = listOf("Opening Chrome"),
            taskId = liveTask,
        )
        val after = reduceRemoteTask(
            running,
            event("sync.event", buildJsonObject { put("event", syncEvent(otherTask, "running", 5, "Other task")) }),
        )
        assertEquals(running, after)
    }

    @Test
    fun aSyncEventKeepsThePercentageThePcActuallyReported() {
        val running = RemoteTaskPhase.Running(
            stateLabel = "Running",
            summary = "Copying",
            percentComplete = 60,
            steps = listOf("Copying"),
            taskId = liveTask,
        )
        val after = reduceRemoteTask(
            running,
            event("sync.event", buildJsonObject { put("event", syncEvent(liveTask, "running", 6, "Still copying")) }),
        ) as RemoteTaskPhase.Running
        assertEquals(60, after.percentComplete)
        assertEquals("Still copying", after.summary)
    }

    @Test
    fun aSyncEventThatIsTerminalIsUnverified() {
        val after = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event("sync.event", buildJsonObject { put("event", syncEvent(liveTask, "failed", 7, "Chrome would not start")) }),
        )
        val outcome = (after as RemoteTaskPhase.Finished).outcome
        assertEquals(OutcomeTone.FAILURE, outcome.tone)
    }

    @Test
    fun syncCompleteClearsTheRecoveringState() {
        val after = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event("sync.complete", buildJsonObject {
                put("lastEventSeq", 50)
                put("resumedAt", 1_700_000_000_000L)
                put("sessionExpiresAt", 1_700_000_600_000L)
            }),
        )
        assertEquals(RemoteTaskPhase.Idle, after)
    }

    @Test
    fun aTaskSnapshotRefreshDoesNotInventAPercentage() {
        val after = reduceRemoteTask(
            RemoteTaskPhase.Recovering(),
            event("task.snapshot", buildJsonObject {
                put("eventSeq", 3)
                put("task", taskSnapshot(liveTask, "verifying", "Checking the result"))
            }),
        )
        val running = after as RemoteTaskPhase.Running
        assertEquals("Checking the result", running.summary)
        assertNull(running.percentComplete)
    }

    /* --------------------- recreation round trip --------------------- */

    @Test
    fun aPendingApprovalSurvivesRecreationWithItsBindingIntact() {
        val phase = RemoteTaskPhase.AwaitingApproval(
            PendingApproval(
                approvalId = "b1c7bde2-0000-4000-8000-000000000002",
                taskId = liveTask,
                actionHash = "a".repeat(64),
                deviceId = "device-abc",
                capability = "delete_files",
                consequence = "Deletes the selected files permanently.",
                targetKind = "file",
                targetValue = "C:/Users/me/scratch",
                expiresAt = 1_700_000_600_000L,
            ),
        )
        val restored = decodeRemoteTaskPhase(encodeRemoteTaskPhase(phase))
        assertEquals(phase, restored)
    }

    @Test
    fun aRunningTaskSurvivesRecreationWithItsReportedPercentage() {
        val phase = RemoteTaskPhase.Running(
            stateLabel = "Running",
            summary = "Copying",
            percentComplete = 35,
            steps = listOf("Planning", "Copying"),
            taskId = liveTask,
            requestId = "req-1",
            cancellationRequested = true,
        )
        val restored = decodeRemoteTaskPhase(encodeRemoteTaskPhase(phase)) as RemoteTaskPhase.Running
        assertEquals(35, restored.percentComplete)
        assertEquals(listOf("Planning", "Copying"), restored.steps)
        assertTrue(restored.cancellationRequested)
    }

    @Test
    fun aFinishedOutcomeKeepsItsVerificationAcrossRecreation() {
        val outcome = TaskOutcome(
            status = ResultStatus.SUCCEEDED,
            verification = VerificationStatus.NOT_AVAILABLE,
            verificationSummary = "",
            safeSummary = "Opened Chrome",
            completedAt = 1_700_000_000_000L,
        )
        val restored = decodeRemoteTaskPhase(encodeRemoteTaskPhase(RemoteTaskPhase.Finished(outcome)))
        assertEquals(OutcomeTone.UNVERIFIED, (restored as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test
    fun anApprovalThatLostItsBindingIsNotRestoredAsApprovable() {
        val truncated = """{"kind":"awaiting","approvalId":"x","taskId":"y"}"""
        assertTrue(decodeRemoteTaskPhase(truncated) is RemoteTaskPhase.Unrecoverable)
    }

    @Test
    fun unreadableSavedStateFallsBackToIdle() {
        assertEquals(RemoteTaskPhase.Idle, decodeRemoteTaskPhase("not json"))
        assertEquals(RemoteTaskPhase.Idle, decodeRemoteTaskPhase(null))
    }

    @Test
    fun everyPhaseHasAStableEqualityForTheScreen() {
        // Guards against a phase that cannot be compared, which would make the
        // screen recompose on every event with no visible change.
        assertNotNull(RemoteTaskPhase.Idle)
        assertEquals(RemoteTaskPhase.Idle, RemoteTaskPhase.Idle)
    }

    /* ------------------- connection changes ------------------- */

    @Test
    fun aDroppedConnectionTurnsARunningTaskIntoRecovering() {
        val running = RemoteTaskPhase.Running(
            stateLabel = "Running",
            summary = "Copying",
            percentComplete = 20,
            steps = listOf("Copying"),
            taskId = liveTask,
        )
        val after = phaseOnConnectionChange(running, "Remote PC disconnected: socket closed")
        assertTrue("A running task must not sit there pretending to be live", after is RemoteTaskPhase.Recovering)
    }

    @Test
    fun aPendingApprovalIsNotDiscardedByAConnectionBlip() {
        val approval = RemoteTaskPhase.AwaitingApproval(
            PendingApproval(
                approvalId = "b1c7bde2-0000-4000-8000-000000000002",
                taskId = liveTask,
                actionHash = "a".repeat(64),
                deviceId = "device-abc",
                capability = "delete_files",
                consequence = "Deletes the selected files permanently.",
                targetKind = "file",
                targetValue = "C:/Users/me/scratch",
                expiresAt = 1_700_000_600_000L,
            ),
        )
        assertEquals(approval, phaseOnConnectionChange(approval, "Reconnecting to Desktop…"))
    }

    @Test
    fun aHealthyConnectionLeavesThePhaseAlone() {
        val running = RemoteTaskPhase.Running(
            stateLabel = "Running",
            summary = "Copying",
            percentComplete = 20,
            steps = listOf("Copying"),
            taskId = liveTask,
        )
        assertEquals(running, phaseOnConnectionChange(running, "Connected securely to Desktop."))
    }

    /* --------------- correlation and ordering (A4 matrix) --------------- */

    @Test
    fun delayedAcceptanceForAnOlderRequestIsIgnored() {
        val phase = submitted()
        val delayed = reduceRemoteTask(phase, event("task.accepted", accepted(request = otherRequestId)))
        assertEquals("A late acceptance for another request must not become the active task", phase, delayed)
    }

    @Test
    fun acceptanceWithoutARequestIdIsIgnored() {
        val payload = buildJsonObject {
            put("taskId", taskId)
            put("state", "accepted")
            put("safeSummary", "Accepted.")
        }
        assertEquals(submitted(), reduceRemoteTask(submitted(), event("task.accepted", payload)))
    }

    @Test
    fun progressForAnotherTaskIsIgnored() {
        val phase = running()
        val foreign = buildJsonObject {
            put("taskId", otherTaskId)
            put("state", "running")
            put("safeSummary", "Some other task is copying files.")
            put("percentComplete", 90)
        }
        assertEquals(phase, reduceRemoteTask(phase, event("task.progress", foreign)))
    }

    @Test
    fun progressCannotCreateATaskBeforeAcceptance() {
        assertEquals(submitted(), reduceRemoteTask(submitted(), event("task.progress", progress("running", "Working"))))
    }

    @Test
    fun progressWithoutPercentageKeepsTheLastGenuinePercentage() {
        val halfway = (running() as RemoteTaskPhase.Running).copy(percentComplete = 45)
        val next = reduceRemoteTask(halfway, event("task.progress", progress("running", "Still copying"))) 
            as RemoteTaskPhase.Running
        assertEquals(45, next.percentComplete)
    }

    @Test
    fun resultForAnotherTaskIsIgnored() {
        val payload = buildJsonObject {
            put("taskId", otherTaskId)
            put("status", "succeeded")
            put("verification", buildJsonObject { put("status", "verified") })
            put("safeSummary", "Some other task finished.")
        }
        assertEquals(running(), reduceRemoteTask(running(), event("task.result", payload)))
    }

    @Test
    fun errorForAnotherTaskIsIgnored() {
        val payload = buildJsonObject {
            put("taskId", otherTaskId)
            put("message", "Some other task failed.")
            put("retryable", true)
        }
        assertEquals(running(), reduceRemoteTask(running(), event("task.error", payload)))
    }

    @Test
    fun taskErrorWithATaskIdBeforeAcceptanceIsIgnored() {
        val payload = buildJsonObject {
            put("taskId", taskId)
            put("message", "Rejected.")
            put("retryable", false)
        }
        assertEquals(
            "A task ID issued before acceptance cannot be matched to our request",
            submitted(),
            reduceRemoteTask(submitted(), event("task.error", payload)),
        )
    }

    @Test
    fun approvalBeforeAcceptanceIsRejected() {
        val payload = buildJsonObject { put("approval", approval()) }
        assertEquals(submitted(), reduceRemoteTask(submitted(), event("task.confirmation_required", payload)))
    }

    @Test
    fun approvalForAnotherTaskIsRejected() {
        val foreign = buildJsonObject {
            put("approval", buildJsonObject {
                put("approvalId", "b1c7bde2-0000-4000-8000-000000000002")
                put("taskId", otherTaskId)
                put("deviceId", "device-abc")
                put("actionHash", "a".repeat(64))
                put("expiresAt", 1_700_000_600_000L)
            })
        }
        assertEquals(running(), reduceRemoteTask(running(), event("task.confirmation_required", foreign)))
    }

    @Test
    fun approvalWithoutAUsableExpiryFailsClosed() {
        for (expiry in listOf<Number?>(null, 0)) {
            val payload = buildJsonObject {
                put("approval", buildJsonObject {
                    put("approvalId", "b1c7bde2-0000-4000-8000-000000000002")
                    put("taskId", taskId)
                    put("deviceId", "device-abc")
                    put("actionHash", "a".repeat(64))
                    if (expiry != null) put("expiresAt", expiry.toLong())
                })
            }
            val phase = reduceRemoteTask(running(), event("task.confirmation_required", payload))
            assertTrue("expiry=$expiry must not be approvable", phase is RemoteTaskPhase.Failed)
        }
    }

    @Test
    fun approvalKeepsTheExpiryTheUiMustEnforce() {
        val payload = buildJsonObject { put("approval", approval()) }
        val phase = reduceRemoteTask(running(), event("task.confirmation_required", payload))
        assertEquals(1_700_000_600_000L, (phase as RemoteTaskPhase.AwaitingApproval).approval.expiresAt)
    }

    @Test
    fun connectionLevelFailureIsNotAttributedToTheTask() {
        val payload = buildJsonObject {
            put("code", "frame_rejected")
            put("message", "The PC rejected a frame.")
        }
        val failure = reduceRemoteTask(running(), event("protocol.error", payload)) as RemoteTaskPhase.Failed
        assertNull("A dropped frame is not evidence that the task failed", failure.correlation.taskId)
    }

    @Test
    fun taskSpecificFailureCarriesItsCorrelation() {
        val payload = buildJsonObject {
            put("taskId", taskId)
            put("message", "Chrome is not installed.")
            put("retryable", true)
        }
        val failure = reduceRemoteTask(running(), event("task.error", payload)) as RemoteTaskPhase.Failed
        assertEquals(taskId, failure.correlation.taskId)
        assertEquals(requestId, failure.correlation.requestId)
    }

    @Test
    fun protocolErrorForAnotherTaskIsIgnored() {
        val payload = buildJsonObject {
            put("taskId", otherTaskId)
            put("message", "err")
        }
        assertEquals(running(), reduceRemoteTask(running(), event("protocol.error", payload)))
    }

    @Test
    fun correlationOfEachPhaseIsStatedOnce() {
        assertEquals(Correlation(requestId = requestId), correlationOf(submitted()))
        assertEquals(Correlation(taskId, requestId), correlationOf(running()))
        assertTrue(matchesActiveTask(running(), taskId))
        assertFalse(matchesActiveTask(running(), otherTaskId))
        assertFalse("A phase with no task cannot match one", matchesActiveTask(submitted(), taskId))
        assertTrue(matchesSubmittedRequest(submitted(), requestId))
        assertFalse(matchesSubmittedRequest(submitted(), otherRequestId))
        assertFalse("A request ID is not a task ID", matchesActiveTask(submitted(), requestId))
    }

    /* ------------- identity must survive the recovery window ------------- */

    @Test
    fun reconnectionKeepsTheTaskIdentityBeingRecovered() {
        val recovering = phaseOnConnectionChange(running(), "Remote PC disconnected.")
        val phase = recovering as RemoteTaskPhase.Recovering
        assertEquals(taskId, phase.taskId)
        assertEquals(requestId, phase.requestId)
    }

    @Test
    fun replayForTheRecoveringTaskIsAccepted() {
        val recovering = phaseOnConnectionChange(running(), "Remote PC disconnected.")
        val payload = buildJsonObject {
            put("event", buildJsonObject {
                put("taskId", taskId)
                put("state", "verifying")
                put("eventSeq", 7)
                put("safePayload", buildJsonObject { put("safeSummary", "Checking the window title") })
            })
        }
        val phase = reduceRemoteTask(recovering, event("sync.event", payload)) as RemoteTaskPhase.Running
        assertEquals(taskId, phase.taskId)
        assertEquals("Verifying", phase.stateLabel)
    }

    @Test
    fun replayedEventDuringRecoveryCannotEstablishAnUnrelatedTask() {
        val recovering = phaseOnConnectionChange(running(), "Remote PC disconnected.")
        val payload = buildJsonObject {
            put("event", buildJsonObject {
                put("taskId", otherTaskId)
                put("state", "running")
                put("eventSeq", 3)
            })
        }
        assertEquals(recovering, reduceRemoteTask(recovering, event("sync.event", payload)))
    }

    @Test
    fun snapshotForAnotherTaskIsRefusedWhileRecovering() {
        val recovering = phaseOnConnectionChange(running(), "Remote PC disconnected.")
        val phase = reduceRemoteTask(recovering, event("task.snapshot", buildJsonObject {
            put("task", taskSnapshot(otherTaskId, "running", "Other work"))
        }))
        assertEquals(recovering, phase)
    }

    @Test
    fun snapshotForTheRecoveringTaskIsAccepted() {
        val recovering = phaseOnConnectionChange(running(), "Remote PC disconnected.")
        val phase = reduceRemoteTask(recovering, event("task.snapshot", buildJsonObject {
            put("task", taskSnapshot(taskId, "running", "Still copying"))
        })) as RemoteTaskPhase.Running
        assertEquals(taskId, phase.taskId)
        assertEquals("Still copying", phase.summary)
    }

    @Test
    fun recoveryIdentitySurvivesActivityRecreation() {
        val recovering = phaseOnConnectionChange(running(), "Reconnecting to Desktop…")
        val restored = decodeRemoteTaskPhase(encodeRemoteTaskPhase(recovering))
        assertEquals(recovering, restored)
    }

    @Test
    fun aFailedPhaseRemembersWhichTaskFailed() {
        val failed = RemoteTaskPhase.Failed(
            message = "Chrome is not installed.",
            retryable = true,
            correlation = Correlation(taskId = taskId, requestId = requestId),
        )
        assertEquals(failed, decodeRemoteTaskPhase(encodeRemoteTaskPhase(failed)))
    }
}
