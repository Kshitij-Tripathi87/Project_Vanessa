package com.vanessa.mobile.ui

import com.vanessa.protocol.conversation.ConversationState
import com.vanessa.protocol.conversation.ConversationTurnRole
import com.vanessa.protocol.conversation.ConversationTurnStatus

/**
 * Pure Compose-facing projection of the shared conversation reducer.
 *
 * The Activity owns no transcript list or ASR draft. The reducer owns the
 * conversation; this object only selects the entries appropriate for each UI
 * surface.
 */
internal object ConversationUiProjection {
    fun messages(state: ConversationState): List<VanessaChatMessage> =
        state.turns.asSequence()
            .filter { turn ->
                turn.text.isNotBlank() && when (turn.role) {
                    ConversationTurnRole.USER -> turn.status == ConversationTurnStatus.COMPLETED
                    ConversationTurnRole.ASSISTANT -> turn.isFinal
                }
            }
            .takeLast(MAX_VISIBLE_MESSAGES)
            .map { turn ->
                VanessaChatMessage(
                    id = turn.turnId,
                    fromUser = turn.role == ConversationTurnRole.USER,
                    text = turn.text,
                )
            }
            .toList()

    fun voiceDraft(state: ConversationState): String =
        state.turns.lastOrNull { turn ->
            turn.role == ConversationTurnRole.USER &&
                !turn.isFinal &&
                turn.status in setOf(
                    ConversationTurnStatus.RECEIVED,
                    ConversationTurnStatus.PROCESSING,
                )
        }?.text.orEmpty()

    private const val MAX_VISIBLE_MESSAGES = 100
}
