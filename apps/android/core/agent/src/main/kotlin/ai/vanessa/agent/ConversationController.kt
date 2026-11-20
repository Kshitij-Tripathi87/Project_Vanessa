package ai.vanessa.agent

import com.vanessa.protocol.conversation.ConversationCodec
import com.vanessa.protocol.conversation.ConversationEvent
import com.vanessa.protocol.conversation.ConversationState
import com.vanessa.protocol.conversation.ConversationTurnRole
import com.vanessa.protocol.conversation.ConversationTurnSource
import com.vanessa.protocol.conversation.ConversationTurnStatus
import com.vanessa.protocol.conversation.InterruptReason
import com.vanessa.protocol.conversation.ResponseChunkEvent
import com.vanessa.protocol.conversation.ResponseCompletedEvent
import com.vanessa.protocol.conversation.TranscriptFinalEvent
import com.vanessa.protocol.conversation.TranscriptPartialEvent
import com.vanessa.protocol.conversation.TurnFailedEvent
import com.vanessa.protocol.conversation.TurnInterruptedEvent
import com.vanessa.protocol.conversation.TurnReceivedEvent
import com.vanessa.protocol.conversation.applyConversationEvent
import com.vanessa.protocol.conversation.initialConversationState
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

fun interface ConversationIdProvider { fun nextId(): String }
fun interface ConversationClock { fun nowEpochMillis(): Long }

data class CaptureLease internal constructor(
    val conversationId: String,
    val generation: Long,
    val source: ConversationTurnSource,
)

data class ConversationRequestHandle internal constructor(
    val conversationId: String,
    val requestId: String,
    val userTurnId: String,
    val source: ConversationTurnSource,
    val captureGeneration: Long?,
)

data class AssistantTurnHandle internal constructor(
    val conversationId: String,
    val requestId: String,
    val turnId: String,
    val source: ConversationTurnSource,
    val generation: Long,
)

enum class ConversationPublishResult { PUBLISHED, IGNORED, STALE, INVALID }

/**
 * Android's in-memory conversation authority. It has no Android, inference,
 * database, HTTP, UI or task-cancellation dependency. All state changes pass
 * through the shared strict codec and the generated Kotlin reducer.
 */
class ConversationController(
    val conversationId: String,
    private val idProvider: ConversationIdProvider = ConversationIdProvider { UUID.randomUUID().toString() },
    private val clock: ConversationClock = ConversationClock { System.currentTimeMillis() },
) {
    private data class ActiveCapture(val lease: CaptureLease, val request: ConversationRequestHandle?)

    private val lock = Any()
    private val mutableState = MutableStateFlow(initialConversationState(conversationId))
    val state: StateFlow<ConversationState> = mutableState.asStateFlow()

    private var captureGeneration = 0L
    private var activeCapture: ActiveCapture? = null
    private var assistantGeneration = 0L
    private var activeAssistant: AssistantTurnHandle? = null

    init {
        require(isCanonicalUuid(conversationId)) { "conversationId must be a canonical lowercase UUID" }
    }

    /** Opens a capture lease without creating an empty turn. */
    fun beginCapture(source: ConversationTurnSource = ConversationTurnSource.VOICE): CaptureLease =
        synchronized(lock) {
            activeCapture?.let { cancelCaptureLocked(it, InterruptReason.USER_CANCEL) }
            check(captureGeneration < Long.MAX_VALUE) { "Capture generation exhausted" }
            captureGeneration += 1L
            CaptureLease(conversationId, captureGeneration, source).also {
                activeCapture = ActiveCapture(it, null)
            }
        }

    /** Publishes a replacement partial. The first nonblank partial creates the user turn. */
    fun publishPartial(lease: CaptureLease, text: String): ConversationPublishResult = synchronized(lock) {
        val capture = currentCaptureLocked(lease) ?: return@synchronized ConversationPublishResult.STALE
        if (text.isBlank()) return@synchronized ConversationPublishResult.IGNORED
        if (text.length > MAX_TRANSCRIPT_CHUNK) return@synchronized ConversationPublishResult.INVALID

        val request = capture.request ?: createUserTurnLocked(lease.source, lease.generation)
            ?: return@synchronized ConversationPublishResult.INVALID
        val applied = dispatchLocked(
            TranscriptPartialEvent(conversationId, request.userTurnId, text),
        )
        if (!applied) return@synchronized ConversationPublishResult.INVALID
        activeCapture = capture.copy(request = request)
        ConversationPublishResult.PUBLISHED
    }

    /**
     * Accepts final transcript once. A final-only recognizer result creates the
     * received event immediately before the final event.
     */
    fun publishFinal(lease: CaptureLease, text: String): ConversationRequestHandle? = synchronized(lock) {
        val capture = currentCaptureLocked(lease) ?: return@synchronized null
        if (text.isBlank() || text.length > MAX_TURN_CONTENT) {
            capture.request?.let { request ->
                dispatchLocked(
                    TurnFailedEvent(
                        conversationId,
                        request.userTurnId,
                        if (text.isBlank()) "No speech was recognized." else "Transcript exceeded the conversation limit.",
                    ),
                )
            }
            activeCapture = null
            return@synchronized null
        }

        val request = capture.request ?: createUserTurnLocked(lease.source, lease.generation)
            ?: return@synchronized null
        val applied = dispatchLocked(TranscriptFinalEvent(conversationId, request.userTurnId, text))
        activeCapture = null
        if (applied) request else null
    }

    /** Invalidate the lease before the adapter cancels/destroys SpeechRecognizer. */
    fun cancelCapture(lease: CaptureLease): ConversationPublishResult = synchronized(lock) {
        val capture = currentCaptureLocked(lease) ?: return@synchronized ConversationPublishResult.STALE
        cancelCaptureLocked(capture, InterruptReason.USER_CANCEL)
    }

    fun failCapture(lease: CaptureLease, reason: String): ConversationPublishResult = synchronized(lock) {
        val capture = currentCaptureLocked(lease) ?: return@synchronized ConversationPublishResult.STALE
        activeCapture = null
        val request = capture.request ?: return@synchronized ConversationPublishResult.IGNORED
        val applied = dispatchLocked(
            TurnFailedEvent(conversationId, request.userTurnId, safeReason(reason, "Speech recognition failed.")),
        )
        if (applied) ConversationPublishResult.PUBLISHED else ConversationPublishResult.IGNORED
    }

    /** Typed text goes through the same received → final event path as voice. */
    fun submitTyped(text: String): ConversationRequestHandle? = synchronized(lock) {
        if (text.isBlank() || text.length > MAX_TURN_CONTENT) return@synchronized null
        val request = createUserTurnLocked(ConversationTurnSource.TEXT, null) ?: return@synchronized null
        if (dispatchLocked(TranscriptFinalEvent(conversationId, request.userTurnId, text))) request else null
    }

    /** Creates one assistant turn paired to a completed user request. */
    fun beginAssistantTurn(request: ConversationRequestHandle): AssistantTurnHandle? = synchronized(lock) {
        // This controller serializes assistant generations. The UI may queue a
        // later request, but it must not strand an earlier nonterminal turn by
        // replacing the only active response handle.
        if (activeAssistant != null) return@synchronized null
        if (request.conversationId != conversationId) return@synchronized null
        val current = mutableState.value
        val user = current.turns.firstOrNull {
            it.turnId == request.userTurnId &&
                it.requestId == request.requestId &&
                it.role == ConversationTurnRole.USER
        } ?: return@synchronized null
        if (user.status != ConversationTurnStatus.COMPLETED) return@synchronized null
        if (current.turns.any {
                it.requestId == request.requestId && it.role == ConversationTurnRole.ASSISTANT
            }
        ) return@synchronized null

        check(assistantGeneration < Long.MAX_VALUE) { "Assistant generation exhausted" }
        assistantGeneration += 1L
        val handle = AssistantTurnHandle(
            conversationId, request.requestId, newIdLocked(), request.source, assistantGeneration,
        )
        val received = TurnReceivedEvent(
            conversationId, handle.turnId, handle.requestId,
            ConversationTurnRole.ASSISTANT, handle.source, nowLocked(),
        )
        if (!dispatchLocked(received)) return@synchronized null
        activeAssistant = handle
        handle
    }

    /** Publishes only an already validated complete response; this is not token streaming. */
    fun publishValidatedResponse(
        handle: AssistantTurnHandle,
        fullText: String,
    ): ConversationPublishResult = synchronized(lock) {
        if (!isCurrentAssistantLocked(handle)) return@synchronized ConversationPublishResult.STALE
        if (fullText.isBlank() || fullText.length > MAX_TURN_CONTENT) {
            dispatchLocked(
                TurnFailedEvent(
                    conversationId,
                    handle.turnId,
                    if (fullText.isBlank()) "No validated assistant response is available."
                    else "Assistant response exceeded the conversation limit.",
                ),
            )
            activeAssistant = null
            return@synchronized ConversationPublishResult.INVALID
        }

        for (chunk in ConversationResponseChunker.split(fullText)) {
            if (!dispatchLocked(ResponseChunkEvent(conversationId, handle.turnId, chunk))) {
                activeAssistant = null
                return@synchronized ConversationPublishResult.INVALID
            }
        }
        val completed = dispatchLocked(ResponseCompletedEvent(conversationId, handle.turnId))
        activeAssistant = null
        if (completed) ConversationPublishResult.PUBLISHED else ConversationPublishResult.INVALID
    }

    fun failAssistant(handle: AssistantTurnHandle, reason: String): ConversationPublishResult =
        synchronized(lock) {
            if (!isCurrentAssistantLocked(handle)) return@synchronized ConversationPublishResult.STALE
            val applied = dispatchLocked(
                TurnFailedEvent(conversationId, handle.turnId, safeReason(reason, "Assistant response failed.")),
            )
            activeAssistant = null
            if (applied) ConversationPublishResult.PUBLISHED else ConversationPublishResult.IGNORED
        }

    /** Interrupts response generation only. It cannot cancel a task or stop a completed text turn. */
    fun interruptAssistant(
        handle: AssistantTurnHandle,
        reason: InterruptReason = InterruptReason.BARGE_IN,
    ): ConversationPublishResult = synchronized(lock) {
        if (!isCurrentAssistantLocked(handle)) return@synchronized ConversationPublishResult.STALE
        val applied = dispatchLocked(TurnInterruptedEvent(conversationId, handle.turnId, reason))
        activeAssistant = null
        if (applied) ConversationPublishResult.PUBLISHED else ConversationPublishResult.IGNORED
    }

    /** Completed historical turns only; current request and partial drafts are excluded. */
    fun plannerContext(excludingRequestId: String? = null): List<ConversationTurn> =
        mutableState.value.turns
            .asSequence()
            .filter { it.status == ConversationTurnStatus.COMPLETED }
            .filter { excludingRequestId == null || it.requestId != excludingRequestId }
            .filter { it.text.isNotBlank() }
            .map { ConversationTurn(it.role == ConversationTurnRole.USER, it.text) }
            .toList()

    private fun currentCaptureLocked(lease: CaptureLease): ActiveCapture? {
        val active = activeCapture ?: return null
        if (lease.conversationId != conversationId ||
            lease.generation != active.lease.generation ||
            lease.source != active.lease.source
        ) return null
        return active
    }

    private fun cancelCaptureLocked(
        capture: ActiveCapture,
        reason: InterruptReason,
    ): ConversationPublishResult {
        // Invalidate before platform teardown; re-entrant callbacks are stale.
        activeCapture = null
        val request = capture.request ?: return ConversationPublishResult.IGNORED
        val applied = dispatchLocked(TurnInterruptedEvent(conversationId, request.userTurnId, reason))
        return if (applied) ConversationPublishResult.PUBLISHED else ConversationPublishResult.IGNORED
    }

    private fun createUserTurnLocked(
        source: ConversationTurnSource,
        captureGeneration: Long?,
    ): ConversationRequestHandle? {
        val requestId = newIdLocked()
        val turnId = newIdLocked()
        val received = TurnReceivedEvent(
            conversationId, turnId, requestId,
            ConversationTurnRole.USER, source, nowLocked(),
        )
        if (!dispatchLocked(received)) return null
        return ConversationRequestHandle(conversationId, requestId, turnId, source, captureGeneration)
    }

    private fun isCurrentAssistantLocked(handle: AssistantTurnHandle): Boolean {
        val active = activeAssistant ?: return false
        return handle.conversationId == conversationId &&
            handle == active &&
            handle.generation == assistantGeneration
    }

    private fun dispatchLocked(event: ConversationEvent): Boolean {
        return try {
            ConversationCodec.encodeEvent(event)
            val before = mutableState.value
            val after = applyConversationEvent(before, event)
            if (after === before) false else {
                mutableState.value = after
                true
            }
        } catch (_: IllegalArgumentException) {
            false
        } catch (_: IllegalStateException) {
            false
        }
    }

    private fun newIdLocked(): String {
        val id = idProvider.nextId()
        require(isCanonicalUuid(id)) { "ID provider must return canonical lowercase UUIDs" }
        return id
    }

    private fun nowLocked(): Long {
        val now = clock.nowEpochMillis()
        require(now in 0L..MAX_EPOCH_MILLIS) { "Clock value is outside the conversation contract" }
        return now
    }

    private fun safeReason(value: String, fallback: String): String =
        value.trim().ifEmpty { fallback }.take(300).ifEmpty { fallback }

    companion object {
        private const val MAX_EPOCH_MILLIS = 8_640_000_000_000_000L
        private const val MAX_TURN_CONTENT = com.vanessa.protocol.conversation.MAX_TURN_CONTENT
        private const val MAX_TRANSCRIPT_CHUNK = com.vanessa.protocol.conversation.MAX_TRANSCRIPT_CHUNK
        private val UUID_PATTERN = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        private fun isCanonicalUuid(value: String): Boolean = UUID_PATTERN.matches(value)
    }
}

/**
 * Deterministic logical chunking of a fully buffered, validated response.
 * Concatenation is exact; a valid UTF-16 surrogate pair is never split.
 */
object ConversationResponseChunker {
    private const val MAX_CHUNK = com.vanessa.protocol.conversation.MAX_TRANSCRIPT_CHUNK
    private const val MIN_PREFERRED_BOUNDARY = 160

    fun split(text: String): List<String> {
        require(text.isNotEmpty()) { "Response must not be empty" }
        require(text.length <= com.vanessa.protocol.conversation.MAX_TURN_CONTENT) {
            "Response exceeds the conversation content limit"
        }
        val chunks = mutableListOf<String>()
        var start = 0
        while (start < text.length) {
            var end = minOf(start + MAX_CHUNK, text.length)
            if (end < text.length && splitsSurrogatePair(text, end)) end--
            if (end < text.length) preferredBoundary(text, start, end)?.let { end = it }
            if (end <= start) end = minOf(start + 2, text.length)
            chunks += text.substring(start, end)
            start = end
        }
        check(chunks.all { it.isNotEmpty() && it.length <= MAX_CHUNK })
        check(chunks.joinToString(separator = "") == text)
        return chunks
    }

    private fun preferredBoundary(text: String, start: Int, end: Int): Int? {
        var selected: Int? = null
        for (index in start until end) {
            val char = text[index]
            if (char == '\n' || char == '.' || char == '!' || char == '?') {
                val next = index + 1
                if (next - start >= MIN_PREFERRED_BOUNDARY &&
                    (next == text.length || text[next].isWhitespace())
                ) selected = next
            }
        }
        return selected
    }

    private fun splitsSurrogatePair(text: String, boundary: Int): Boolean {
        if (boundary <= 0 || boundary >= text.length) return false
        return Character.isHighSurrogate(text[boundary - 1]) &&
            Character.isLowSurrogate(text[boundary])
    }
}
