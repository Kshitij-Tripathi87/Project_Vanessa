package ai.vanessa.agent

import com.vanessa.protocol.conversation.ConversationTurnRole
import com.vanessa.protocol.conversation.ConversationTurnSource
import com.vanessa.protocol.conversation.ConversationTurnStatus
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationControllerSpec {
    private class SequenceIds : ConversationIdProvider {
        private var next = 2
        override fun nextId(): String = uuid(next++)
    }

    private fun controller(): ConversationController = ConversationController(
        conversationId = uuid(1),
        idProvider = SequenceIds(),
        clock = ConversationClock { 1_700_000_000_000L },
    )

    @Test
    fun openingCaptureDoesNotCreateAnEmptyTurn() {
        val controller = controller()
        val lease = controller.beginCapture()
        assertEquals(ConversationTurnSource.VOICE, lease.source)
        assertTrue(controller.state.value.turns.isEmpty())
        assertNull(controller.state.value.activeTurnId)
    }

    @Test
    fun firstPartialCreatesOneUserTurnAndLaterPartialsReplaceItsText() {
        val controller = controller()
        val lease = controller.beginCapture()

        assertEquals(
            ConversationPublishResult.PUBLISHED,
            controller.publishPartial(lease, "open my"),
        )
        val first = controller.state.value.turns.single()
        assertEquals(ConversationTurnRole.USER, first.role)
        assertEquals(ConversationTurnSource.VOICE, first.source)
        assertEquals(ConversationTurnStatus.RECEIVED, first.status)
        assertEquals("open my", first.text)

        assertEquals(
            ConversationPublishResult.PUBLISHED,
            controller.publishPartial(lease, "open my calendar"),
        )
        val turns = controller.state.value.turns
        assertEquals(1, turns.size)
        assertEquals(first.turnId, turns.single().turnId)
        assertEquals(first.requestId, turns.single().requestId)
        assertEquals("open my calendar", turns.single().text)
        assertFalse(turns.single().isFinal)
    }

    @Test
    fun finalOnlyRecognizerResultCreatesAndCompletesOneTurn() {
        val controller = controller()
        val lease = controller.beginCapture()

        val request = requireNotNull(controller.publishFinal(lease, "what is on my calendar"))
        val user = controller.state.value.turns.single()
        assertEquals(request.requestId, user.requestId)
        assertEquals(request.userTurnId, user.turnId)
        assertEquals(ConversationTurnStatus.COMPLETED, user.status)
        assertEquals("what is on my calendar", user.text)
        assertNull(controller.publishFinal(lease, "duplicate final"))
        assertEquals(1, controller.state.value.turns.size)
    }

    @Test
    fun staleCaptureCallbacksAreIgnoredAfterANewerCaptureStarts() {
        val controller = controller()
        val oldLease = controller.beginCapture()
        controller.publishPartial(oldLease, "old request")
        val newLease = controller.beginCapture()

        assertEquals(
            ConversationPublishResult.STALE,
            controller.publishPartial(oldLease, "late old partial"),
        )
        assertNull(controller.publishFinal(oldLease, "late old final"))
        assertTrue(controller.state.value.turns.single().status == ConversationTurnStatus.INTERRUPTED)

        val request = controller.publishFinal(newLease, "new request")
        assertTrue(request != null)
        assertEquals(ConversationTurnStatus.COMPLETED, controller.state.value.turns.last().status)
        assertEquals(2, controller.state.value.turns.size)
    }

    @Test
    fun cancellingCaptureInvalidatesItAndInterruptsOnlyItsOpenTurn() {
        val controller = controller()
        val lease = controller.beginCapture()
        controller.publishPartial(lease, "please check")
        assertEquals(ConversationPublishResult.PUBLISHED, controller.cancelCapture(lease))

        assertNull(controller.publishFinal(lease, "please check my calendar"))
        assertEquals(ConversationTurnStatus.INTERRUPTED, controller.state.value.turns.single().status)
        assertEquals(ConversationPublishResult.STALE, controller.cancelCapture(lease))
    }

    @Test
    fun typedInputUsesTheSameReceivedAndFinalLifecycle() {
        val controller = controller()
        val request = requireNotNull(controller.submitTyped("check device status"))

        val user = controller.state.value.turns.single()
        assertEquals(ConversationTurnRole.USER, user.role)
        assertEquals(ConversationTurnSource.TEXT, user.source)
        assertEquals(ConversationTurnStatus.COMPLETED, user.status)
        assertEquals(request.userTurnId, user.turnId)
        assertEquals(request.requestId, user.requestId)
    }

    @Test
    fun assistantTurnHasADistinctTurnIdAndSharesTheUserRequestId() {
        val controller = controller()
        val request = controller.submitTyped("check device status")!!
        val assistant = controller.beginAssistantTurn(request)!!

        assertEquals(request.requestId, assistant.requestId)
        assertFalse(request.userTurnId == assistant.turnId)
        assertEquals(ConversationPublishResult.PUBLISHED,
            controller.publishValidatedResponse(assistant, "Battery is at 82 percent."))

        val turns = controller.state.value.turns
        assertEquals(2, turns.size)
        assertEquals(request.requestId, turns[1].requestId)
        assertEquals(ConversationTurnRole.ASSISTANT, turns[1].role)
        assertEquals(ConversationTurnStatus.COMPLETED, turns[1].status)
        assertEquals("Battery is at 82 percent.", turns[1].text)
        assertNull(controller.beginAssistantTurn(request))
    }

    @Test
    fun aSecondAssistantGenerationCannotStrandTheFirstTurn() {
        val controller = controller()
        val firstRequest = requireNotNull(controller.submitTyped("first request"))
        val firstAssistant = requireNotNull(controller.beginAssistantTurn(firstRequest))
        val secondRequest = requireNotNull(controller.submitTyped("second request"))

        assertNull(controller.beginAssistantTurn(secondRequest))
        assertEquals(
            ConversationPublishResult.PUBLISHED,
            controller.publishValidatedResponse(firstAssistant, "First response completed."),
        )
        val secondAssistant = requireNotNull(controller.beginAssistantTurn(secondRequest))
        assertEquals(
            ConversationPublishResult.PUBLISHED,
            controller.publishValidatedResponse(secondAssistant, "Second response completed."),
        )
        assertEquals(ConversationTurnStatus.COMPLETED, controller.state.value.turns.last().status)
    }

    @Test
    fun plannerContextContainsCompletedPriorTurnsButExcludesCurrentRequest() {
        val controller = controller()
        val first = controller.submitTyped("what is on my calendar today")!!
        val assistant = controller.beginAssistantTurn(first)!!
        controller.publishValidatedResponse(assistant, "Two meetings are recorded.")
        val current = controller.submitTyped("and tomorrow?")!!

        val context = controller.plannerContext(excludingRequestId = current.requestId)
        assertEquals(
            listOf(
                ConversationTurn(true, "what is on my calendar today"),
                ConversationTurn(false, "Two meetings are recorded."),
            ),
            context,
        )
        assertFalse(context.any { it.text == "and tomorrow?" })
    }

    @Test
    fun oversizedResponseFailsBeforePublishingAnyResponseChunk() {
        val controller = controller()
        val request = controller.submitTyped("summarize")!!
        val assistant = controller.beginAssistantTurn(request)!!

        assertEquals(
            ConversationPublishResult.INVALID,
            controller.publishValidatedResponse(assistant, "x".repeat(4001)),
        )
        val assistantTurn = controller.state.value.turns.last()
        assertEquals(ConversationTurnStatus.FAILED, assistantTurn.status)
        assertFalse(assistantTurn.streaming)
        assertFalse(assistantTurn.text.contains("x".repeat(20)))
    }

    @Test
    fun assistantFailureIsTerminalAndLateResponseCannotCompleteIt() {
        val controller = controller()
        val request = controller.submitTyped("check the device")!!
        val assistant = controller.beginAssistantTurn(request)!!

        assertEquals(
            ConversationPublishResult.PUBLISHED,
            controller.failAssistant(assistant, "Local model is unavailable."),
        )
        assertEquals(
            ConversationPublishResult.STALE,
            controller.publishValidatedResponse(assistant, "A response arriving late."),
        )
        assertEquals(ConversationTurnStatus.FAILED, controller.state.value.turns.last().status)
    }

    @Test
    fun responseChunkerPreservesExactTextAndNeverSplitsSurrogatePairs() {
        val text = "a".repeat(511) + "😀" + "b".repeat(600) + " Done. " + "c".repeat(1_200)
        val chunks = ConversationResponseChunker.split(text)

        assertTrue(chunks.isNotEmpty())
        assertTrue(chunks.all { it.isNotEmpty() && it.length <= 512 })
        assertEquals(text, chunks.joinToString(""))
        chunks.zipWithNext().forEach { (left, right) ->
            assertFalse(Character.isHighSurrogate(left.last()) && Character.isLowSurrogate(right.first()))
        }
    }

    @Test
    fun responseChunkerPrefersSentenceBoundariesWithoutDroppingWhitespace() {
        val first = "A".repeat(200) + ". "
        val second = "B".repeat(200) + "! "
        val text = first + second + "C".repeat(200)
        val chunks = ConversationResponseChunker.split(text)

        assertEquals(text, chunks.joinToString(""))
        assertTrue(chunks.first().endsWith("! "))
        assertTrue(chunks.size >= 2)
    }

    @Test
    fun completedAssistantTextIsNotInterruptedByAnAudioStopSignal() {
        val controller = controller()
        val request = controller.submitTyped("say hello")!!
        val assistant = controller.beginAssistantTurn(request)!!
        controller.publishValidatedResponse(assistant, "Hello.")

        assertEquals(
            ConversationPublishResult.STALE,
            controller.interruptAssistant(assistant),
        )
        assertEquals(ConversationTurnStatus.COMPLETED, controller.state.value.turns.last().status)
        assertEquals("Hello.", controller.state.value.turns.last().text)
    }

    @Test
    fun blankPartialDoesNotCreateAConversationTurn() {
        val controller = controller()
        val lease = controller.beginCapture()

        assertEquals(ConversationPublishResult.IGNORED, controller.publishPartial(lease, "  "))
        assertTrue(controller.state.value.turns.isEmpty())
    }

    @Test
    fun reentrantObserverCannotReactivateAnOldCapture() {
        val controller = controller()
        val old = controller.beginCapture()
        var newer: CaptureLease? = null
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val collector = scope.launch {
            controller.state.drop(1).collect { state ->
                if (newer == null && state.turns.isNotEmpty()) newer = controller.beginCapture()
            }
        }
        try {
            assertEquals(ConversationPublishResult.PUBLISHED, controller.publishPartial(old, "old partial"))
            val replacement = requireNotNull(newer)
            assertEquals(ConversationPublishResult.STALE, controller.publishPartial(old, "late old partial"))
            assertEquals(ConversationPublishResult.PUBLISHED, controller.publishPartial(replacement, "new partial"))
            assertEquals(ConversationTurnStatus.INTERRUPTED, controller.state.value.turns.first().status)
            assertEquals("new partial", controller.state.value.turns.last().text)
        } finally {
            collector.cancel()
            scope.cancel()
        }
    }

    @Test
    fun reentrantObserverCannotDiscardTheCaptureStartedAfterAFinal() {
        val controller = controller()
        val old = controller.beginCapture()
        controller.publishPartial(old, "partial")
        var newer: CaptureLease? = null
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val collector = scope.launch {
            controller.state.drop(1).collect { state ->
                if (newer == null && state.turns.any { it.status == ConversationTurnStatus.COMPLETED }) {
                    newer = controller.beginCapture()
                }
            }
        }
        try {
            requireNotNull(controller.publishFinal(old, "finished"))
            assertEquals(ConversationPublishResult.PUBLISHED,
                controller.publishPartial(requireNotNull(newer), "next capture"))
            assertEquals(ConversationPublishResult.STALE, controller.publishPartial(old, "late"))
        } finally {
            collector.cancel()
            scope.cancel()
        }
    }

    @Test
    fun reentrantObserverCannotStartACompetingAssistantTurn() {
        val controller = controller()
        val first = requireNotNull(controller.submitTyped("first"))
        val second = requireNotNull(controller.submitTyped("second"))
        var observed = false
        var competing: AssistantTurnHandle? = null
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val collector = scope.launch {
            controller.state.drop(1).collect { state ->
                if (!observed && state.turns.any { it.role == ConversationTurnRole.ASSISTANT }) {
                    observed = true
                    competing = controller.beginAssistantTurn(second)
                }
            }
        }
        try {
            val active = requireNotNull(controller.beginAssistantTurn(first))
            assertTrue(observed)
            assertNull(competing)
            assertEquals(ConversationPublishResult.PUBLISHED,
                controller.publishValidatedResponse(active, "first answer"))
            requireNotNull(controller.beginAssistantTurn(second))
        } finally {
            collector.cancel()
            scope.cancel()
        }
    }

    @Test
    fun boundedHistoryNeverEvictsAnActiveAssistantTurn() {
        val controller = controller()
        val request = requireNotNull(controller.submitTyped("first"))
        val active = requireNotNull(controller.beginAssistantTurn(request))
        repeat(198) { requireNotNull(controller.submitTyped("queued $it")) }
        // The first completed user may leave the 200-turn window; the next
        // eviction would discard an assistant generation that is still active.
        requireNotNull(controller.submitTyped("one more"))
        assertNull(controller.submitTyped("must not evict active assistant"))
        assertEquals(ConversationPublishResult.PUBLISHED,
            controller.publishValidatedResponse(active, "completed answer"))
        assertEquals(ConversationTurnStatus.COMPLETED,
            controller.state.value.turns.first { it.turnId == active.turnId }.status)
        requireNotNull(controller.submitTyped("space is available again"))
    }

    @Test
    fun boundedHistoryNeverEvictsAnActiveCaptureForUserOrAssistantTurns() {
        val controller = controller()
        val lease = controller.beginCapture()
        controller.publishPartial(lease, "still listening")
        val request = requireNotNull(controller.submitTyped("typed request"))
        repeat(198) { requireNotNull(controller.submitTyped("queued $it")) }
        assertNull(controller.submitTyped("must not evict active capture"))
        assertNull(controller.beginAssistantTurn(request))
        requireNotNull(controller.publishFinal(lease, "finished listening"))
        requireNotNull(controller.beginAssistantTurn(request))
    }

    @Test
    fun aCopiedRequestCannotChangeTheAssistantSource() {
        val controller = controller()
        val request = requireNotNull(controller.submitTyped("typed request"))
        assertNull(controller.beginAssistantTurn(request.copy(source = ConversationTurnSource.VOICE)))
        requireNotNull(controller.beginAssistantTurn(request))
    }

    @Test
    fun reusedRequestIdCannotCorrelateTwoDifferentUserRequests() {
        val ids = listOf(uuid(2), uuid(3), uuid(2), uuid(4)).iterator()
        val controller = ConversationController(
            conversationId = uuid(1),
            idProvider = ConversationIdProvider { ids.next() },
            clock = ConversationClock { 1_700_000_000_000L },
        )
        requireNotNull(controller.submitTyped("first request"))
        assertNull(controller.submitTyped("different request"))
        assertEquals(1, controller.state.value.turns.size)
        assertEquals("first request", controller.state.value.turns.single().text)
    }

    @Test
    fun concurrentTypedSubmissionsRemainDistinctAndComplete() {
        val controller = controller()
        val pool = Executors.newFixedThreadPool(8)
        try {
            val submissions = (1..64).map { value ->
                pool.submit<ConversationRequestHandle?> { controller.submitTyped("request $value") }
            }.map { requireNotNull(it.get()) }
            assertEquals(64, submissions.map { it.requestId }.toSet().size)
            assertEquals(64, submissions.map { it.userTurnId }.toSet().size)
            assertEquals(64, controller.state.value.turns.size)
            assertTrue(controller.state.value.turns.all { it.status == ConversationTurnStatus.COMPLETED })
        } finally {
            pool.shutdownNow()
        }
    }
}

private fun uuid(value: Int): String =
    "00000000-0000-4000-8000-" + value.toString().padStart(12, '0')
