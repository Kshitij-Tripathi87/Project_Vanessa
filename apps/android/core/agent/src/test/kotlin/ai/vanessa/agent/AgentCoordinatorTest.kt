package ai.vanessa.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AgentCoordinatorTest {
    @Test
    fun permissionDenialNeverInvokesExecutor() = runBlocking {
        val store = MemoryStore()
        var invoked = false
        val coordinator = AgentCoordinator(store, executor {
            invoked = true
            ToolResult(true, "Incorrect", "")
        }) { listOf(ToolDefinition(ToolNames.DEVICE_STATUS, false)) }

        val result = coordinator.run("Check device status")

        assertEquals(TaskState.FAILED, result.state)
        assertTrue(result.summary.contains("Permission denied"))
        assertFalse(invoked)
        assertEquals(result, coordinator.history().single())
    }

    @Test
    fun successPersistsStatesAndUnmodifiedEvidence() = runBlocking {
        val store = MemoryStore()
        val calls = mutableListOf<ToolCall>()
        val coordinator = AgentCoordinator(store, executor {
            calls += it
            ToolResult(true, "Battery is 82%", "battery=82; observedAt=1234")
        }) { granted() }

        val result = coordinator.run("Please show my device status.")

        assertEquals(listOf(ToolCall(ToolNames.DEVICE_STATUS)), calls)
        assertEquals(TaskState.SUCCEEDED, result.state)
        assertEquals("battery=82; observedAt=1234", result.evidence)
        assertTrue(result.id.isNotBlank())
        assertTrue(result.createdAt > 0)
        assertEquals(listOf(TaskState.PENDING, TaskState.RUNNING, TaskState.SUCCEEDED), store.writes.map { it.state })
        assertEquals(result, coordinator.history().single())
    }

    @Test
    fun supportedPlanWithUnknownToolFailsClosed() = runBlocking {
        var invoked = false
        val coordinator = AgentCoordinator(MemoryStore(), executor {
            invoked = true
            ToolResult(true, "Incorrect", "")
        }) { emptyList() }

        val result = coordinator.run("Today's calendar")

        assertEquals(TaskState.FAILED, result.state)
        assertTrue(result.summary.contains("Unknown tool: ${ToolNames.CALENDAR_TODAY}"))
        assertFalse(invoked)
    }

    @Test
    fun unsupportedPromptReportsNoInferenceInsteadOfCallingTool() = runBlocking {
        var invoked = false
        val coordinator = AgentCoordinator(MemoryStore(), executor {
            invoked = true
            ToolResult(true, "Incorrect", "")
        }) { granted() }

        val result = coordinator.run("Check device status and delete my messages")

        assertEquals(TaskState.FAILED, result.state)
        assertTrue(result.summary.contains("No inference available"))
        assertFalse(invoked)
    }

    @Test
    fun recoveryFailsOnlyUnfinishedRecordsAndRunsOnce() = runBlocking {
        val pending = TaskRecord("pending", "old", TaskState.PENDING, "Pending", 100, "old evidence")
        val running = pending.copy(id = "running", state = TaskState.RUNNING)
        val terminal = listOf(TaskState.SUCCEEDED, TaskState.FAILED, TaskState.CANCELLED).map {
            pending.copy(id = it.name, state = it, summary = "Keep me")
        }
        val store = MemoryStore(listOf(pending, running) + terminal)
        val coordinator = AgentCoordinator(store, executor { error("Must not execute during recovery") }) { granted() }

        val history = coordinator.history().associateBy { it.id }

        assertEquals(TaskState.FAILED, history.getValue("pending").state)
        assertEquals(TaskState.FAILED, history.getValue("running").state)
        assertEquals("old evidence", history.getValue("pending").evidence)
        assertEquals(100L, history.getValue("pending").createdAt)
        for (record in terminal) assertEquals(record, history.getValue(record.id))
        coordinator.history()
        assertEquals(2, store.writes.size)
        // Once initialized, history must not recover this coordinator's live tasks.
        val started = CompletableDeferred<Unit>()
        val live = AgentCoordinator(MemoryStore(), executor {
            started.complete(Unit)
            awaitCancellation()
        }) { granted() }
        val runningTask = async(start = CoroutineStart.UNDISPATCHED) { live.run("device status") }
        started.await()
        val liveRecord = live.history().single()
        assertEquals(TaskState.RUNNING, liveRecord.state)
        live.cancel(liveRecord.id)
        assertCancelled { runningTask.await() }
    }

    @Test
    fun explicitCancellationPersistsAndPropagates() = runBlocking {
        withTimeout(5_000) {
            val started = CompletableDeferred<Unit>()
            val store = MemoryStore()
            val coordinator = AgentCoordinator(store, executor {
                started.complete(Unit)
                awaitCancellation()
            }) { granted() }
            val running = async(start = CoroutineStart.UNDISPATCHED) { coordinator.run("device status") }
            started.await()
            val id = coordinator.history().single().id

            coordinator.cancel(id)
            assertCancelled { running.await() }

            assertEquals(TaskState.CANCELLED, coordinator.history().single().state)
            assertFalse(store.writes.any { it.state == TaskState.SUCCEEDED })
            val count = store.writes.size
            coordinator.cancel(id)
            coordinator.cancel("unknown")
            assertEquals(count, store.writes.size)
        }
    }

    @Test
    fun callerCancellationCannotBecomeSuccessEvenIfExecutorSwallowsIt() = runBlocking {
        withTimeout(5_000) {
            val started = CompletableDeferred<Unit>()
            val store = MemoryStore()
            val coordinator = AgentCoordinator(store, executor {
                started.complete(Unit)
                try {
                    awaitCancellation()
                } catch (_: CancellationException) {
                    ToolResult(true, "Must not succeed", "late evidence")
                }
            }) { granted() }
            val running = async(start = CoroutineStart.UNDISPATCHED) { coordinator.run("device status") }
            started.await()

            running.cancel()
            assertCancelled { running.await() }
            running.join()

            assertEquals(TaskState.CANCELLED, coordinator.history().single().state)
            assertFalse(store.writes.any { it.state == TaskState.SUCCEEDED })
        }
    }

    @Test
    fun permissionIsCheckedAgainBeforeSecondTool() = runBlocking {
        var calendarGranted = true
        val calls = mutableListOf<String>()
        val coordinator = AgentCoordinator(MemoryStore(), executor {
            calls += it.tool
            calendarGranted = false
            ToolResult(true, "Status read", "device evidence")
        }) {
            listOf(
                ToolDefinition(ToolNames.DEVICE_STATUS, true),
                ToolDefinition(ToolNames.CALENDAR_TODAY, calendarGranted),
            )
        }

        val result = coordinator.run("device status and today's calendar")

        assertEquals(listOf(ToolNames.DEVICE_STATUS), calls)
        assertEquals(TaskState.FAILED, result.state)
        assertTrue(result.summary.contains("Permission denied"))
        assertEquals("device evidence", result.evidence)
    }

    @Test
    fun toolFailurePreservesEvidenceAndDoesNotRunNextTool() = runBlocking {
        var count = 0
        val coordinator = AgentCoordinator(MemoryStore(), executor {
            count++
            ToolResult(false, "Device unavailable", "transport timeout")
        }) { granted() }

        val result = coordinator.run("device status and today's calendar")

        assertEquals(TaskState.FAILED, result.state)
        assertEquals("transport timeout", result.evidence)
        assertEquals(1, count)
    }

    @Test
    fun executorExceptionIsPersistedAsFailure() = runBlocking {
        val coordinator = AgentCoordinator(MemoryStore(), executor { error("Disconnected") }) { granted() }

        val result = coordinator.run("device status")

        assertEquals(TaskState.FAILED, result.state)
        assertTrue(result.summary.contains("Disconnected"))
        assertEquals(result, coordinator.history().single())
    }

    @Test
    fun duplicateOrRiskyDefinitionsAreRejected() = runBlocking {
        for (definitions in listOf(
            listOf(ToolDefinition(ToolNames.DEVICE_STATUS, true, Risk.WRITE)),
            listOf(ToolDefinition(ToolNames.DEVICE_STATUS, true), ToolDefinition(ToolNames.DEVICE_STATUS, false)),
        )) {
            val coordinator = AgentCoordinator(MemoryStore(), executor { error("Must not execute") }) { definitions }
            assertEquals(TaskState.FAILED, coordinator.run("device status").state)
        }
    }

    @Test
    fun combinedSuccessIncludesBothToolsEvidence() = runBlocking {
        val coordinator = AgentCoordinator(MemoryStore(), executor {
            ToolResult(true, "Read ${it.tool}", "evidence:${it.tool}")
        }) { granted() }

        val result = coordinator.run("device status and today's calendar")

        assertEquals(TaskState.SUCCEEDED, result.state)
        assertEquals("evidence:device.status\nevidence:calendar.today", result.evidence)
    }

    private fun granted() = listOf(
        ToolDefinition(ToolNames.DEVICE_STATUS, true),
        ToolDefinition(ToolNames.CALENDAR_TODAY, true),
    )

    private fun executor(block: suspend (ToolCall) -> ToolResult) = object : ToolExecutor {
        override suspend fun execute(call: ToolCall) = block(call)
    }

    private suspend fun assertCancelled(block: suspend () -> Unit) {
        try {
            block()
            fail("Expected CancellationException")
        } catch (_: CancellationException) {
            // Structured cancellation is part of the coordinator contract.
        }
    }

    private class MemoryStore(initial: List<TaskRecord> = emptyList()) : TaskStore {
        private val mutex = Mutex()
        private val records = initial.associateBy { it.id }.toMutableMap()
        val writes = mutableListOf<TaskRecord>()

        override suspend fun save(task: TaskRecord) {
            mutex.withLock {
                records[task.id] = task
                writes += task
            }
        }

        override suspend fun all(): List<TaskRecord> = mutex.withLock { records.values.toList() }
    }
}
