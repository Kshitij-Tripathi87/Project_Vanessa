package com.vanessa.protocol.conversation

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** A reducer view is not the wire ConversationTurn: a new turn can have empty text. */
@Serializable
data class ConversationTurnView(
    val turnId: String,
    val conversationId: String,
    val requestId: String,
    val role: ConversationTurnRole,
    val source: ConversationTurnSource,
    val text: String,
    @SerialName("final") val isFinal: Boolean,
    val streaming: Boolean,
    val status: ConversationTurnStatus,
    val createdAt: Long,
    val interruptReason: InterruptReason? = null,
)

@Serializable
data class ConversationState(
    val conversationId: String,
    val status: ConversationStatus,
    val turns: List<ConversationTurnView>,
    val activeTurnId: String?,
)

fun initialConversationState(conversationId: String): ConversationState = ConversationState(
    conversationId = conversationId,
    status = ConversationStatus.ACTIVE,
    turns = emptyList(),
    activeTurnId = null,
)

fun isTerminalTurnStatus(status: ConversationTurnStatus): Boolean = when (status) {
    ConversationTurnStatus.COMPLETED,
    ConversationTurnStatus.INTERRUPTED,
    ConversationTurnStatus.FAILED -> true
    ConversationTurnStatus.RECEIVED,
    ConversationTurnStatus.PROCESSING,
    ConversationTurnStatus.RESPONDING -> false
}

private fun activeTurnOf(turns: List<ConversationTurnView>): String? =
    turns.lastOrNull { !isTerminalTurnStatus(it.status) }?.turnId

/**
 * Pure mirror of packages/protocol/src/conversation.ts. It has no clock, random
 * IDs, Android dependencies or side effects. Validate untrusted input with
 * ConversationCodec before applying it. Ignored events return the same object.
 * Interruption is only about the turn: it never cancels supervisor-owned work.
 */
fun applyConversationEvent(state: ConversationState, event: ConversationEvent): ConversationState {
    if (event.conversationId != state.conversationId) return state
    val index = state.turns.indexOfFirst { it.turnId == event.turnId }

    if (event is TurnReceivedEvent) {
        if (index >= 0) return state
        val turn = ConversationTurnView(
            turnId = event.turnId,
            conversationId = state.conversationId,
            requestId = event.requestId,
            role = event.role,
            source = event.source,
            text = "",
            isFinal = false,
            streaming = false,
            status = ConversationTurnStatus.RECEIVED,
            createdAt = event.createdAt,
        )
        val turns = (state.turns + turn).takeLast(MAX_CONVERSATION_TURNS)
        return state.copy(turns = turns, activeTurnId = activeTurnOf(turns))
    }

    if (index < 0) return state
    val turn = state.turns[index]
    if (isTerminalTurnStatus(turn.status)) return state

    fun replace(updated: ConversationTurnView): ConversationState {
        val turns = state.turns.mapIndexed { at, current -> if (at == index) updated else current }
        return state.copy(turns = turns, activeTurnId = activeTurnOf(turns))
    }

    return when (event) {
        is TranscriptPartialEvent -> {
            if (turn.isFinal ||
                (turn.status != ConversationTurnStatus.RECEIVED && turn.status != ConversationTurnStatus.PROCESSING) ||
                event.text.isEmpty()
            ) return state
            replace(turn.copy(text = event.text))
        }
        is TranscriptFinalEvent -> {
            if (turn.isFinal) return state
            replace(turn.copy(
                text = event.text,
                isFinal = true,
                status = if (turn.role == ConversationTurnRole.USER) {
                    ConversationTurnStatus.COMPLETED
                } else {
                    ConversationTurnStatus.PROCESSING
                },
            ))
        }
        is ResponseChunkEvent -> {
            if (turn.role != ConversationTurnRole.ASSISTANT ||
                (turn.status != ConversationTurnStatus.RECEIVED &&
                    turn.status != ConversationTurnStatus.PROCESSING &&
                    turn.status != ConversationTurnStatus.RESPONDING) ||
                event.text.isEmpty()
            ) return state
            val text = if (turn.streaming) turn.text + event.text else event.text
            if (text.length > MAX_TURN_CONTENT) {
                // Keep accepted text, fail the turn, and never mark a silently
                // truncated or broken-surrogate response as successful.
                return replace(turn.copy(status = ConversationTurnStatus.FAILED, isFinal = true))
            }
            replace(turn.copy(text = text, status = ConversationTurnStatus.RESPONDING, streaming = true))
        }
        is ResponseCompletedEvent -> {
            if (turn.status != ConversationTurnStatus.PROCESSING && turn.status != ConversationTurnStatus.RESPONDING) {
                return state
            }
            replace(turn.copy(status = ConversationTurnStatus.COMPLETED, isFinal = true))
        }
        is TurnInterruptedEvent -> replace(turn.copy(
            status = ConversationTurnStatus.INTERRUPTED,
            interruptReason = event.reason,
            isFinal = true,
        ))
        is TurnFailedEvent -> replace(turn.copy(
            status = ConversationTurnStatus.FAILED,
            text = if (turn.text.isEmpty()) event.reason else turn.text,
            isFinal = true,
        ))
        is TurnReceivedEvent -> error("Received events are handled before this branch")
    }
}

fun applyConversationEvents(state: ConversationState, events: List<ConversationEvent>): ConversationState =
    events.fold(state, ::applyConversationEvent)
