package com.vanessa.mobile.ui

import com.vanessa.protocol.conversation.ConversationState
import com.vanessa.protocol.conversation.ConversationStatus
import com.vanessa.protocol.conversation.ConversationTurnRole
import com.vanessa.protocol.conversation.ConversationTurnSource
import com.vanessa.protocol.conversation.ConversationTurnStatus
import com.vanessa.protocol.conversation.ConversationTurnView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationUiProjectionTest {
    private fun turn(
        id: Int,
        role: ConversationTurnRole,
        source: ConversationTurnSource,
        text: String,
        status: ConversationTurnStatus,
        final: Boolean,
    ) = ConversationTurnView(
        turnId = uuid(id),
        conversationId = uuid(1),
        requestId = uuid(id + 100),
        role = role,
        source = source,
        text = text,
        isFinal = final,
        streaming = false,
        status = status,
        createdAt = 1_795_258_515_000,
    )

    private fun state(vararg turns: ConversationTurnView) = ConversationState(
        conversationId = uuid(1),
        status = ConversationStatus.ACTIVE,
        turns = turns.toList(),
        activeTurnId = turns.lastOrNull { it.status !in setOf(
            ConversationTurnStatus.COMPLETED,
            ConversationTurnStatus.INTERRUPTED,
            ConversationTurnStatus.FAILED,
        ) }?.turnId,
    )

    @Test
    fun partialVoiceTranscriptAppearsAsDraftNotAsACompletedChatMessage() {
        val partial = turn(
            2, ConversationTurnRole.USER, ConversationTurnSource.VOICE,
            "Find my next meeting", ConversationTurnStatus.RECEIVED, false,
        )
        val snapshot = state(partial)

        assertTrue(ConversationUiProjection.messages(snapshot).isEmpty())
        assertEquals("Find my next meeting", ConversationUiProjection.voiceDraft(snapshot))
    }

    @Test
    fun finalVoiceAndTypedTurnsUseTheSameChatProjection() {
        val typed = turn(
            2, ConversationTurnRole.USER, ConversationTurnSource.TEXT,
            "What is my battery level?", ConversationTurnStatus.COMPLETED, true,
        )
        val voice = turn(
            3, ConversationTurnRole.USER, ConversationTurnSource.VOICE,
            "And my calendar?", ConversationTurnStatus.COMPLETED, true,
        )
        val response = turn(
            4, ConversationTurnRole.ASSISTANT, ConversationTurnSource.VOICE,
            "You have two meetings.", ConversationTurnStatus.COMPLETED, true,
        )
        val messages = ConversationUiProjection.messages(state(typed, voice, response))

        assertEquals(3, messages.size)
        assertEquals(listOf(true, true, false), messages.map { it.fromUser })
        assertEquals(listOf(
            "What is my battery level?",
            "And my calendar?",
            "You have two meetings.",
        ), messages.map { it.text })
        assertEquals(listOf(typed.turnId, voice.turnId, response.turnId), messages.map { it.id })
        assertEquals("", ConversationUiProjection.voiceDraft(state(typed, voice, response)))
    }

    @Test
    fun interruptedPartialDoesNotBecomeACompletedChatMessage() {
        val interrupted = turn(
            2, ConversationTurnRole.USER, ConversationTurnSource.VOICE,
            "Open the cal", ConversationTurnStatus.INTERRUPTED, true,
        )
        assertTrue(ConversationUiProjection.messages(state(interrupted)).isEmpty())
        assertEquals("", ConversationUiProjection.voiceDraft(state(interrupted)))
    }

    @Test
    fun failedAssistantTurnRemainsVisibleAsAnAssistantMessage() {
        val failed = turn(
            2, ConversationTurnRole.ASSISTANT, ConversationTurnSource.TEXT,
            "I could not verify the result.", ConversationTurnStatus.FAILED, true,
        )
        val messages = ConversationUiProjection.messages(state(failed))
        assertEquals(1, messages.size)
        assertEquals(false, messages.single().fromUser)
        assertEquals("I could not verify the result.", messages.single().text)
    }

    @Test
    fun projectionRetainsOnlyTheNewestHundredVisibleMessages() {
        val turns = (2..105).map { value ->
            turn(
                value, ConversationTurnRole.USER, ConversationTurnSource.TEXT,
                "Message $value", ConversationTurnStatus.COMPLETED, true,
            )
        }
        val messages = ConversationUiProjection.messages(state(*turns.toTypedArray()))
        assertEquals(100, messages.size)
        assertEquals("Message 6", messages.first().text)
        assertEquals("Message 105", messages.last().text)
    }

    private fun uuid(value: Int): String =
        "00000000-0000-4000-8000-" + value.toString().padStart(12, '0')
}
