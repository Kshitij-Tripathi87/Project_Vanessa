package ai.vanessa.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive


interface LocalInference {
    suspend fun generate(prompt: String): String

    /** Constrained decoding. Non-native test adapters may fall back to plain generation. */
    suspend fun generateConstrained(prompt: String, grammar: String): String = generate(prompt)
}

interface LocalToolExecutor {
    // Implementations must check current permission at execution time, not at planning time.
    suspend fun execute(tool: String): LocalToolResult
}

sealed interface LocalToolResult {
    data class Success(val evidence: String) : LocalToolResult
    data object PermissionRequired : LocalToolResult
    data class Unavailable(val reason: String) : LocalToolResult
}

sealed interface LocalPlanStep {
    val tool: String

    data object CalendarToday : LocalPlanStep {
        override val tool: String = "android.calendar.search"
    }

    data object DeviceStatus : LocalPlanStep {
        override val tool: String = "android.device.status"
    }
}

data class LocalPlan(val steps: List<LocalPlanStep>)
data class LocalStepResult(val step: LocalPlanStep, val evidence: String)

enum class LocalPlanError {
    INVALID_PROMPT, INVALID_PLAN, INFERENCE_FAILED, PERMISSION_REQUIRED, UNAVAILABLE, EXECUTION_FAILED
}

sealed interface LocalPlanOutcome {
    data class Success(val results: List<LocalStepResult>) : LocalPlanOutcome
    data class Failure(
        val error: LocalPlanError,
        val reason: String,
        val results: List<LocalStepResult> = emptyList(),
    ) : LocalPlanOutcome
}

sealed interface LocalPlanValidation {
    data class Valid(val plan: LocalPlan) : LocalPlanValidation
    data class Invalid(val reason: String) : LocalPlanValidation
}

object LocalPlanValidator {
    const val MAX_PROMPT_CHARS = 2048
    const val MAX_PLAN_CHARS = 4096
    const val MAX_EVIDENCE_CHARS = 1024

    // A strict GBNF allow-list: one or two exact tool calls, with no extra fields.
    const val PLAN_GBNF = """root ::= "{\"steps\":[" step ("," step)? "]}"
step ::= "{\"tool\":\"android.calendar.search\",\"args\":{\"range\":\"today\"}}" | "{\"tool\":\"android.device.status\",\"args\":{}}"
"""

    fun validate(raw: String): LocalPlanValidation {
        if (raw.length > MAX_PLAN_CHARS) return LocalPlanValidation.Invalid("Plan exceeds size limit")
        val root = try {
            Json.parseToJsonElement(raw) as? JsonObject
        } catch (_: IllegalArgumentException) {
            null
        } ?: return LocalPlanValidation.Invalid("Plan must be a JSON object")
        if (root.keys != setOf("steps")) return LocalPlanValidation.Invalid("Plan must contain only steps")
        val steps = root["steps"] as? JsonArray
            ?: return LocalPlanValidation.Invalid("steps must be an array")
        if (steps.size !in 1..2) return LocalPlanValidation.Invalid("Plan must have one or two steps")

        val parsed = steps.mapIndexed { index, value ->
            val entry = value as? JsonObject
                ?: return LocalPlanValidation.Invalid("Step $index must be an object")
            if (entry.keys != setOf("tool", "args")) {
                return LocalPlanValidation.Invalid("Step $index must contain only tool and args")
            }
            val tool = (entry["tool"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: return LocalPlanValidation.Invalid("Step $index has no string tool")
            val args = entry["args"] as? JsonObject
                ?: return LocalPlanValidation.Invalid("Step $index args must be an object")
            when (tool) {
                LocalPlanStep.CalendarToday.tool -> {
                    val range = args["range"] as? JsonPrimitive
                    if (args.keys != setOf("range") || range?.isString != true || range?.content != "today") {
                        return LocalPlanValidation.Invalid("Calendar args must be exactly {range: today}")
                    }
                    LocalPlanStep.CalendarToday
                }

                LocalPlanStep.DeviceStatus.tool -> {
                    if (args.isNotEmpty()) return LocalPlanValidation.Invalid("Device status args must be empty")
                    LocalPlanStep.DeviceStatus
                }

                else -> return LocalPlanValidation.Invalid("Unknown tool: $tool")
            }
        }
        return LocalPlanValidation.Valid(LocalPlan(parsed))
    }
}

class LocalPlanCoordinator(
    private val inference: LocalInference,
    private val executor: LocalToolExecutor,
) {
    suspend fun run(prompt: String): LocalPlanOutcome {
        if (prompt.isBlank() || prompt.length > LocalPlanValidator.MAX_PROMPT_CHARS) {
            return LocalPlanOutcome.Failure(
                LocalPlanError.INVALID_PROMPT,
                "Prompt must be nonblank and at most 2048 characters"
            )
        }
        currentCoroutineContext().ensureActive()
        val raw = try {
            inference.generateConstrained(
                "Choose only the allowed local tools for the user's request. Return the exact JSON plan. " +
                        "Use one or two steps. Do not invent tools, arguments, or permissions. " +
                        "User request: ${JsonPrimitive(prompt)}",
                LocalPlanValidator.PLAN_GBNF
            )
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return LocalPlanOutcome.Failure(LocalPlanError.INFERENCE_FAILED, "Planner inference failed")
        }
        currentCoroutineContext().ensureActive()
        val validation = LocalPlanValidator.validate(raw)
        if (validation is LocalPlanValidation.Invalid) {
            return LocalPlanOutcome.Failure(LocalPlanError.INVALID_PLAN, validation.reason)
        }
        val results = mutableListOf<LocalStepResult>()
        for (step in (validation as LocalPlanValidation.Valid).plan.steps) {
            currentCoroutineContext().ensureActive()
            val result = try {
                executor.execute(step.tool)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return LocalPlanOutcome.Failure(
                    LocalPlanError.EXECUTION_FAILED,
                    "Tool execution failed: ${step.tool}",
                    results.toList()
                )
            }
            currentCoroutineContext().ensureActive()
            when (result) {
                is LocalToolResult.Success -> {
                    if (result.evidence.isBlank() || result.evidence.length > LocalPlanValidator.MAX_EVIDENCE_CHARS) {
                        return LocalPlanOutcome.Failure(
                            LocalPlanError.EXECUTION_FAILED,
                            "Missing or oversized evidence: ${step.tool}",
                            results.toList()
                        )
                    }
                    results += LocalStepResult(step, result.evidence)
                }

                LocalToolResult.PermissionRequired -> return LocalPlanOutcome.Failure(
                    LocalPlanError.PERMISSION_REQUIRED, "Permission required: ${step.tool}", results.toList()
                )

                is LocalToolResult.Unavailable -> return LocalPlanOutcome.Failure(
                    LocalPlanError.UNAVAILABLE,
                    "Tool unavailable: ${step.tool}: ${result.reason.take(256)}",
                    results.toList()
                )
            }
        }
        currentCoroutineContext().ensureActive()
        return LocalPlanOutcome.Success(results.toList())
    }

    // Model output is treated as a selection of verbatim evidence, never as a new factual claim.
    suspend fun respond(prompt: String, results: List<LocalStepResult>): String {
        val fallback = summary(results)
        if (prompt.isBlank() || prompt.length > LocalPlanValidator.MAX_PROMPT_CHARS ||
            results.isEmpty() || results.size > 2 || results.any {
                it.evidence.isBlank() || it.evidence.length > LocalPlanValidator.MAX_EVIDENCE_CHARS
            }
        ) return fallback
        currentCoroutineContext().ensureActive()
        val context = results.map { it.evidence }
        val output = try {
            inference.generate(
                "Select one nonempty verbatim quote per evidence item, in order. " +
                        "Return only JSON {\"quotes\":[\"exact excerpt\"]}; do not add claims. " +
                        "User request: ${JsonPrimitive(prompt)}. Evidence: ${
                            JsonArray(context.map { JsonPrimitive(it) })
                        }"
            )
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return fallback
        }
        currentCoroutineContext().ensureActive()
        if (output.length > LocalPlanValidator.MAX_PLAN_CHARS) return fallback
        val root = try {
            Json.parseToJsonElement(output) as? JsonObject
        } catch (_: IllegalArgumentException) {
            null
        } ?: return fallback
        if (root.keys != setOf("quotes")) return fallback
        val quotes = root["quotes"] as? JsonArray ?: return fallback
        if (quotes.size != results.size) return fallback
        val excerpts = quotes.mapIndexed { index, value ->
            val quote = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return fallback
            if (quote.isBlank() || !results[index].evidence.contains(quote)) return fallback
            results[index].copy(evidence = quote)
        }
        return summary(excerpts)
    }

    private fun summary(results: List<LocalStepResult>): String =
        if (results.isEmpty()) "No verified tool evidence available."
        else results.joinToString("\n") { "${it.step.tool}: ${it.evidence}" }
}
