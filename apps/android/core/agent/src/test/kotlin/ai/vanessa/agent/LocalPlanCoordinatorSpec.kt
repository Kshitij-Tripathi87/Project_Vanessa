package ai.vanessa.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LocalPlanCoordinatorSpec {
    private val status = """{"tool":"android.device.status","args":{}}"""
    private val calendar = """{"tool":"android.calendar.search","args":{"range":"today"}}"""
    private fun plan(vararg steps: String) = """{"steps":[${steps.joinToString(",")}]}"""

    @Test
    fun unknownToolAndInvalidJsonNeverExecute() = runBlocking {
        for (raw in listOf(
            plan("""{"tool":"android.messages.delete","args":{}}"""),
            "not json",
            "x".repeat(LocalPlanValidator.MAX_PLAN_CHARS + 1),
        )) {
            var calls = 0
            val outcome =
                LocalPlanCoordinator(model { raw }, tool { calls++; LocalToolResult.Success("wrong") }).run("status")
            assertEquals(LocalPlanError.INVALID_PLAN, (outcome as LocalPlanOutcome.Failure).error)
            assertEquals(0, calls)
        }
    }

    @Test
    fun rejectsBadArgsExtraPermissionsAndTooManySteps() = runBlocking {
        val invalid = listOf(
            plan("""{"tool":"android.calendar.search","args":{"range":"tomorrow"}}"""),
            plan("""{"tool":"android.device.status","args":{"extra":true}}"""),
            """{"steps":[$status],"permissions":["calendar"]}""",
            plan("""{"tool":"android.device.status","args":{},"permission":true}"""),
            plan(status, calendar, status),
            plan(),
            plan("""{"tool":"android.calendar.search","args":{"range":"today","limit":10}}"""),
        )
        for (raw in invalid) {
            var calls = 0
            val outcome =
                LocalPlanCoordinator(model { raw }, tool { calls++; LocalToolResult.Success("wrong") }).run("status")
            assertEquals(LocalPlanError.INVALID_PLAN, (outcome as LocalPlanOutcome.Failure).error)
            assertEquals(0, calls)
        }
    }

    @Test
    fun plannerUsesTheAllowlistedGrammarDuringGeneration() = runBlocking {
        var observedGrammar: String? = null
        val inference = object : LocalInference {
            override suspend fun generate(prompt: String): String =
                error("Unconstrained generation must not be used for task plans")

            override suspend fun generateConstrained(prompt: String, grammar: String): String {
                observedGrammar = grammar
                return plan(calendar)
            }
        }
        val outcome = LocalPlanCoordinator(inference, tool {
            LocalToolResult.Success("No events today.")
        }).run("Check my calendar")

        assertTrue(outcome is LocalPlanOutcome.Success)
        assertEquals(LocalPlanValidator.PLAN_GBNF, observedGrammar)
    }
    @Test
    fun permissionRequiredStopsNextStepAndPreservesEvidence() = runBlocking {
        val calls = mutableListOf<String>()
        val outcome = LocalPlanCoordinator(model { plan(status, calendar) }, tool { name ->
            calls += name
            if (name == LocalPlanStep.DeviceStatus.tool) LocalToolResult.Success("battery=82")
            else LocalToolResult.PermissionRequired
        }).run("status and calendar")
        assertEquals(listOf(LocalPlanStep.DeviceStatus.tool, LocalPlanStep.CalendarToday.tool), calls)
        val failure = outcome as LocalPlanOutcome.Failure
        assertEquals(LocalPlanError.PERMISSION_REQUIRED, failure.error)
        assertEquals(listOf(LocalStepResult(LocalPlanStep.DeviceStatus, "battery=82")), failure.results)
    }

    @Test
    fun successReturnsOnlyActualEvidenceInOrder() = runBlocking {
        val calls = mutableListOf<String>()
        val coordinator = LocalPlanCoordinator(model { plan(status, calendar) }, tool {
            calls += it
            LocalToolResult.Success("observed:$it")
        })
        val outcome = coordinator.run("status and calendar") as LocalPlanOutcome.Success
        assertEquals(listOf(LocalPlanStep.DeviceStatus.tool, LocalPlanStep.CalendarToday.tool), calls)
        assertEquals(calls.mapIndexed { i, name ->
            LocalStepResult(if (i == 0) LocalPlanStep.DeviceStatus else LocalPlanStep.CalendarToday, "observed:$name")
        }, outcome.results)
    }

    @Test
    fun cancellationPropagatesAndDoesNotRunNextStep() = runBlocking {
        val started = CompletableDeferred<Unit>()
        var calls = 0
        val coordinator = LocalPlanCoordinator(model { plan(status, calendar) }, tool {
            calls++
            started.complete(Unit)
            awaitCancellation()
        })
        val job = async { coordinator.run("status and calendar") }
        started.await()
        job.cancel()
        try {
            job.await()
            fail("Expected cancellation")
        } catch (_: CancellationException) {
            assertEquals(1, calls)
        }
    }

    @Test
    fun oversizedAndBlankPromptsDoNotInvokeInference() = runBlocking {
        var modelCalls = 0
        val coordinator = LocalPlanCoordinator(model { modelCalls++; plan(status) }, tool { error("No execution") })
        for (prompt in listOf(" ", "x".repeat(LocalPlanValidator.MAX_PROMPT_CHARS + 1))) {
            assertEquals(LocalPlanError.INVALID_PROMPT, (coordinator.run(prompt) as LocalPlanOutcome.Failure).error)
        }
        assertEquals(0, modelCalls)
    }

    @Test
    fun unavailableToolReportsFailureWithoutRunningNextStep() = runBlocking {
        var calls = 0
        val outcome = LocalPlanCoordinator(model { plan(status, calendar) }, tool {
            calls++
            LocalToolResult.Unavailable("disconnected")
        }).run("status and calendar") as LocalPlanOutcome.Failure
        assertEquals(LocalPlanError.UNAVAILABLE, outcome.error)
        assertTrue(outcome.reason.contains("disconnected"))
        assertTrue(outcome.results.isEmpty())
        assertEquals(1, calls)
    }

    @Test
    fun summariesOnlyUseVerbatimEvidenceAndFallbackOnUntrustedOutput() = runBlocking {
        val results = listOf(LocalStepResult(LocalPlanStep.DeviceStatus, "battery=82; observed=now"))
        val selected = LocalPlanCoordinator(model { """{"quotes":["battery=82"]}""" }, tool { error("No execution") })
        assertEquals("android.device.status: battery=82", selected.respond("status", results))
        val fabricated =
            LocalPlanCoordinator(model { """{"quotes":["battery=100"]}""" }, tool { error("No execution") })
        assertEquals("android.device.status: battery=82; observed=now", fabricated.respond("status", results))
        val broken = LocalPlanCoordinator(model { error("offline") }, tool { error("No execution") })
        assertEquals("android.device.status: battery=82; observed=now", broken.respond("status", results))
    }

    @Test
    fun emptyOrOversizedEvidenceCannotSucceed() = runBlocking {
        for (evidence in listOf(" ", "x".repeat(LocalPlanValidator.MAX_EVIDENCE_CHARS + 1))) {
            val outcome =
                LocalPlanCoordinator(model { plan(status) }, tool { LocalToolResult.Success(evidence) }).run("status")
            assertEquals(LocalPlanError.EXECUTION_FAILED, (outcome as LocalPlanOutcome.Failure).error)
            assertTrue(outcome.results.isEmpty())
        }
    }

    private fun model(block: suspend (String) -> String) = object : LocalInference {
        override suspend fun generate(prompt: String) = block(prompt)
    }

    private fun tool(block: suspend (String) -> LocalToolResult) = object : LocalToolExecutor {
        override suspend fun execute(tool: String) = block(tool)
    }
}
