package com.vanessa.mobile.ui.state

import com.vanessa.mobile.remote.RemoteV2Event
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteTaskUiTest {
    private companion object {
        const val TASK_ID = "0f3d0c1e-0000-4000-8000-000000000001"
        const val REQUEST_ID = "9d3b6e17-0000-4000-8000-000000000002"
        const val OTHER_TASK_ID = "aaaaaaaa-0000-4000-8000-000000000000"
        const val OTHER_REQUEST_ID = "bbbbbbbb-0000-4000-8000-000000000000"
    }

    private fun event(type: String, payload: JsonObject) = RemoteV2Event(type, payload)

    private fun runningPhase(percent: Int? = null) =
        RemoteTaskPhase.Running("Running", "Working", percent, listOf("Working"), TASK_ID, REQUEST_ID)

    private fun progress(state: String, summary: String, percent: Int? = null): JsonObject =
        buildJsonObject {
            put("taskId", TASK_ID)
            put("state", state)
            put("eventSeq", 1)
            put("safeSummary", summary)
            if (percent != null) put("percentComplete", percent)
        }

    private fun result(
        taskId: String = TASK_ID,
        status: String,
        verificationStatus: String,
        summary: String = "Done.",
    ): JsonObject = buildJsonObject {
        put("taskId", taskId)
        put("status", status)
        put("verification", buildJsonObject {
            put("status", verificationStatus)
            put("summary", "Checked the window title.")
        })
        put("safeSummary", summary)
        put("eventSeq", 9)
        put("completedAt", 1_700_000_000_000L)
    }

    private fun approval(withActionHash: Boolean = true, expiresAt: Long = 1_700_000_600_000L): JsonObject =
        buildJsonObject {
            put("approvalId", "b1c7bde2-0000-4000-8000-000000000002")
            put("taskId", TASK_ID)
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
            put("expiresAt", expiresAt)
        }

    @Test fun progressWithoutPercentReportsNoPercentage() {
        val phase = reduceRemoteTask(runningPhase(), event("task.progress", progress("running", "Copying")))
        assertNull((phase as RemoteTaskPhase.Running).percentComplete)
    }

    @Test fun reportedPercentIsUsedAndClamped() {
        val withPercent = reduceRemoteTask(runningPhase(), event("task.progress", progress("running", "Copying", 40)))
            as RemoteTaskPhase.Running
        assertEquals(40, withPercent.percentComplete)
        val over = reduceRemoteTask(runningPhase(), event("task.progress", progress("running", "Copying", 140)))
            as RemoteTaskPhase.Running
        assertEquals(100, over.percentComplete)
    }

    @Test fun omittedPercentPreservesLastReportedValue() {
        val phase = reduceRemoteTask(runningPhase(40), event("task.progress", progress("running", "Still working")))
            as RemoteTaskPhase.Running
        assertEquals(40, phase.percentComplete)
    }

    @Test fun stepsAccumulateWithoutRepeatingTheSameLine() {
        var phase: RemoteTaskPhase = runningPhase().copy(steps = emptyList())
        phase = reduceRemoteTask(phase, event("task.progress", progress("planning", "Planning the steps")))
        phase = reduceRemoteTask(phase, event("task.progress", progress("running", "Opening Chrome")))
        phase = reduceRemoteTask(phase, event("task.progress", progress("running", "Opening Chrome")))
        assertEquals(listOf("Planning the steps", "Opening Chrome"), (phase as RemoteTaskPhase.Running).steps)
    }

    @Test fun acceptedStartsOnlyTheMatchingSubmittedRequest() {
        val payload = buildJsonObject {
            put("taskId", TASK_ID)
            put("requestId", REQUEST_ID)
            put("state", "accepted")
            put("eventSeq", 2)
            put("acceptedAt", 1_700_000_000_000L)
        }
        val phase = reduceRemoteTask(RemoteTaskPhase.Submitted("open_app", REQUEST_ID), event("task.accepted", payload))
            as RemoteTaskPhase.Running
        assertEquals(TASK_ID, phase.taskId)
        assertEquals(REQUEST_ID, phase.requestId)
        assertNull(phase.percentComplete)
    }

    @Test fun acceptedEventForOlderRequestIsIgnored() {
        val submitted = RemoteTaskPhase.Submitted("open_app", REQUEST_ID)
        val stale = buildJsonObject {
            put("requestId", OTHER_REQUEST_ID)
            put("taskId", OTHER_TASK_ID)
            put("state", "accepted")
            put("eventSeq", 2)
            put("acceptedAt", 1_700_000_000_000L)
        }
        assertEquals(submitted, reduceRemoteTask(submitted, event("task.accepted", stale)))
    }

    @Test fun progressForAnotherTaskIsIgnored() {
        val running = runningPhase()
        val stale = buildJsonObject {
            put("taskId", OTHER_TASK_ID)
            put("state", "running")
            put("eventSeq", 10)
            put("safeSummary", "Stale task update")
        }
        assertEquals(running, reduceRemoteTask(running, event("task.progress", stale)))
    }

    @Test fun cancelAcknowledgementIsNotATerminalResult() {
        val running = runningPhase().copy(cancellationRequested = true)
        val ack = buildJsonObject {
            put("taskId", TASK_ID)
            put("outcome", "cancelled")
            put("state", "cancelled")
        }
        val after = reduceRemoteTask(running, event("task.cancel_ack", ack)) as RemoteTaskPhase.Running
        assertEquals(false, after.cancellationRequested)
        assertEquals("cancelled", after.cancellationAck?.outcome)
    }

    @Test fun cancelAcknowledgementForDifferentTaskIsIgnored() {
        val running = runningPhase()
        val ack = buildJsonObject {
            put("taskId", OTHER_TASK_ID)
            put("outcome", "cancelled")
            put("state", "cancelled")
        }
        assertEquals(running, reduceRemoteTask(running, event("task.cancel_ack", ack)))
    }

    @Test fun verifiedSuccessIsTheOnlySuccess() {
        val phase = reduceRemoteTask(runningPhase(), event("task.result", result(status = "succeeded", verificationStatus = "verified")))
        assertEquals(OutcomeTone.SUCCESS, (phase as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test fun succeededButUnverifiedIsNotReportedAsSuccess() {
        val phase = reduceRemoteTask(runningPhase(), event("task.result", result(status = "succeeded", verificationStatus = "not_available")))
        val outcome = (phase as RemoteTaskPhase.Finished).outcome
        assertEquals(ResultStatus.SUCCEEDED, outcome.status)
        assertEquals(OutcomeTone.UNVERIFIED, outcome.tone)
        assertNotEquals(OutcomeTone.SUCCESS, outcome.tone)
    }

    @Test fun failedVerificationIsNotASuccessEvenWhenTaskSucceeded() {
        val phase = reduceRemoteTask(runningPhase(), event("task.result", result(status = "succeeded", verificationStatus = "failed")))
        assertEquals(OutcomeTone.UNVERIFIED, (phase as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test fun partialAndFailedStatusesKeepTheirOwnTone() {
        val partial = reduceRemoteTask(runningPhase(), event("task.result", result(status = "partial", verificationStatus = "partial")))
        assertEquals(OutcomeTone.PARTIAL, (partial as RemoteTaskPhase.Finished).outcome.tone)
        val failed = reduceRemoteTask(runningPhase(), event("task.result", result(status = "failed", verificationStatus = "failed")))
        assertEquals(OutcomeTone.FAILURE, (failed as RemoteTaskPhase.Finished).outcome.tone)
        val timeout = reduceRemoteTask(runningPhase(), event("task.result", result(status = "timed_out", verificationStatus = "not_available")))
        assertEquals(OutcomeTone.FAILURE, (timeout as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test fun resultForAnotherTaskCannotReplaceActiveTask() {
        val running = runningPhase()
        val stale = result(taskId = OTHER_TASK_ID, status = "succeeded", verificationStatus = "verified", summary = "Old task completed.")
        assertEquals(running, reduceRemoteTask(running, event("task.result", stale)))
    }

    @Test fun protectedApprovalPreservesRequestIdForLaterCancellation() {
        val acceptedPayload = buildJsonObject {
            put("taskId", TASK_ID)
            put("requestId", REQUEST_ID)
            put("state", "accepted")
            put("eventSeq", 1)
            put("acceptedAt", 1_700_000_000_000L)
        }
        val running = reduceRemoteTask(
            RemoteTaskPhase.Submitted("delete_files", REQUEST_ID),
            event("task.accepted", acceptedPayload),
        )
        val awaiting = reduceRemoteTask(
            running,
            event("task.confirmation_required", buildJsonObject {
                put("approval", approval())
                put("eventSeq", 2)
            }),
        ) as RemoteTaskPhase.AwaitingApproval
        assertEquals(TASK_ID, awaiting.approval.taskId)
        assertEquals(REQUEST_ID, awaiting.requestId)
    }

    @Test fun approvalParsesBindingAndTarget() {
        val phase = reduceRemoteTask(
            runningPhase(),
            event("task.confirmation_required", buildJsonObject {
                put("approval", approval())
                put("eventSeq", 4)
            }),
        ) as RemoteTaskPhase.AwaitingApproval
        assertEquals("delete_files", phase.approval.capability)
        assertEquals("file · C:/Users/me/scratch", phase.approval.targetLabel)
        assertEquals(1_700_000_600_000L, phase.approval.expiresAt)
        assertEquals("a".repeat(64), phase.approval.actionHash)
    }

    @Test fun approvalWithoutActionHashIsNotApprovable() {
        val phase = reduceRemoteTask(
            runningPhase(),
            event("task.confirmation_required", buildJsonObject {
                put("approval", approval(withActionHash = false))
                put("eventSeq", 4)
            }),
        )
        assertTrue(phase is RemoteTaskPhase.Failed)
    }

    @Test fun approvalWithZeroExpiryIsNotApprovable() {
        assertNull(parsePendingApproval(approval(expiresAt = 0L)))
    }

    @Test fun unrelatedEventsLeaveTaskPhaseAlone() {
        val running = runningPhase()
        assertEquals(running, reduceRemoteTask(running, event("manifest.snapshot", buildJsonObject { put("eventSeq", 3) })))
    }

    @Test fun resultWithoutSummaryDoesNotBlankScreen() {
        val running = runningPhase()
        val malformed = buildJsonObject {
            put("taskId", TASK_ID)
            put("status", "succeeded")
            put("eventSeq", 5)
        }
        assertEquals(running, reduceRemoteTask(running, event("task.result", malformed)))
    }

    @Test fun taskErrorIsAFailureNotAnOutcome() {
        val payload = buildJsonObject {
            put("code", "capability_not_available")
            put("message", "Chrome is not installed on the PC.")
            put("retryable", true)
        }
        val phase = reduceRemoteTask(RemoteTaskPhase.Submitted("open_app", REQUEST_ID), event("task.error", payload))
            as RemoteTaskPhase.Failed
        assertEquals("Chrome is not installed on the PC.", phase.message)
        assertTrue(phase.retryable)
    }

    @Test fun taskErrorForAnotherTaskCannotReplaceActiveTask() {
        val running = runningPhase()
        val stale = buildJsonObject {
            put("taskId", OTHER_TASK_ID)
            put("code", "TASK_FAILED")
            put("message", "Old task failed.")
            put("retryable", false)
        }
        assertEquals(running, reduceRemoteTask(running, event("task.error", stale)))
    }

    @Test fun taskErrorWithoutTaskIdIsIgnoredAfterAcceptance() {
        val running = runningPhase()
        val stale = buildJsonObject {
            put("code", "TASK_FAILED")
            put("message", "Uncorrelated error.")
            put("retryable", false)
        }
        assertEquals(running, reduceRemoteTask(running, event("task.error", stale)))
    }

    @Test fun everyPhaseHasStableEquality() {
        assertNotNull(RemoteTaskPhase.Idle)
        assertEquals(RemoteTaskPhase.Idle, RemoteTaskPhase.Idle)
    }
}
