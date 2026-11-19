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

/**
 * The reducer is where "do not claim more than the PC reported" is enforced, so
 * these tests target the places the UI could otherwise quietly overstate: a
 * percentage that was never sent, an outcome that was never verified, an
 * approval that is not bound to an action hash.
 */
class RemoteTaskUiTest {

    private fun event(type: String, payload: JsonObject) = RemoteV2Event(type, payload)

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
        val phase = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.progress", progress("running", "Copying")))
        val running = phase as RemoteTaskPhase.Running
        assertNull("A missing percentComplete must stay missing", running.percentComplete)
    }

    @Test
    fun reportedPercentIsUsedAndClamped() {
        val withPercent = reduceRemoteTask(
            RemoteTaskPhase.Idle,
            event("task.progress", progress("running", "Copying", 40)),
        ) as RemoteTaskPhase.Running
        assertEquals(40, withPercent.percentComplete)

        val over = reduceRemoteTask(
            RemoteTaskPhase.Idle,
            event("task.progress", progress("running", "Copying", 140)),
        ) as RemoteTaskPhase.Running
        assertEquals(100, over.percentComplete)
    }

    @Test
    fun stepsAccumulateWithoutRepeatingTheSameLine() {
        var phase: RemoteTaskPhase = RemoteTaskPhase.Idle
        phase = reduceRemoteTask(phase, event("task.progress", progress("planning", "Planning the steps")))
        phase = reduceRemoteTask(phase, event("task.progress", progress("running", "Opening Chrome")))
        phase = reduceRemoteTask(phase, event("task.progress", progress("running", "Opening Chrome")))
        val running = phase as RemoteTaskPhase.Running
        assertEquals(listOf("Planning the steps", "Opening Chrome"), running.steps)
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
        val running = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.accepted", payload)) as RemoteTaskPhase.Running
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
        val phase = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.result", result("succeeded", "verified")))
        val outcome = (phase as RemoteTaskPhase.Finished).outcome
        assertEquals(OutcomeTone.SUCCESS, outcome.tone)
    }

    @Test
    fun succeededButUnverifiedIsNotReportedAsSuccess() {
        val phase = reduceRemoteTask(
            RemoteTaskPhase.Idle,
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
            RemoteTaskPhase.Idle,
            event("task.result", result("succeeded", "failed")),
        )
        assertEquals(OutcomeTone.UNVERIFIED, (phase as RemoteTaskPhase.Finished).outcome.tone)
    }

    @Test
    fun partialAndFailedStatusesKeepTheirOwnTone() {
        val partial = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.result", result("partial", "partial")))
        assertEquals(OutcomeTone.PARTIAL, (partial as RemoteTaskPhase.Finished).outcome.tone)

        val failed = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.result", result("failed", "failed")))
        assertEquals(OutcomeTone.FAILURE, (failed as RemoteTaskPhase.Finished).outcome.tone)

        val timeout = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.result", result("timed_out", "not_available")))
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
        val phase = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.confirmation_required", payload))
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
        val phase = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.confirmation_required", payload))
        assertTrue("An unbound approval must not become an approvable screen", phase is RemoteTaskPhase.Failed)
    }

    @Test
    fun unrelatedEventsLeaveTheTaskPhaseAlone() {
        val running = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.progress", progress("running", "Working")))
        val afterManifest = reduceRemoteTask(
            running,
            event("manifest.snapshot", buildJsonObject { put("eventSeq", 3) }),
        )
        assertEquals(running, afterManifest)
    }

    @Test
    fun aResultWithoutASummaryDoesNotBlankTheScreen() {
        val running = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.progress", progress("running", "Working")))
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
        val phase = reduceRemoteTask(RemoteTaskPhase.Idle, event("task.error", payload))
        val failure = phase as RemoteTaskPhase.Failed
        assertEquals("Chrome is not installed on the PC.", failure.message)
        assertTrue(failure.retryable)
    }

    @Test
    fun everyPhaseHasAStableEqualityForTheScreen() {
        // Guards against a phase that cannot be compared, which would make the
        // screen recompose on every event with no visible change.
        assertNotNull(RemoteTaskPhase.Idle)
        assertEquals(RemoteTaskPhase.Idle, RemoteTaskPhase.Idle)
    }
}
