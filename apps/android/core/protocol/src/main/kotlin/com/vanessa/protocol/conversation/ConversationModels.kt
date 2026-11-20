/**
 * Generated from packages/protocol/schema/conversation-v1.schema.json.
 * Do not edit; run pnpm --filter @vanessa/protocol build.
 * Decode wire JSON using ConversationCodec, not a bare Json decoder:
 * the generated rules enforce UUIDs, bounds and strict member types.
 */
package com.vanessa.protocol.conversation

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

const val CONVERSATION_PROTOCOL_VERSION: Int = 1
const val MAX_CONVERSATION_TURNS: Int = 200
const val MAX_TURN_CONTENT: Int = 4000
const val MAX_TRANSCRIPT_CHUNK: Int = 512

@Serializable
enum class ConversationStatus {
    @SerialName("active") ACTIVE,
    @SerialName("paused") PAUSED,
    @SerialName("closed") CLOSED,
}

@Serializable
enum class ConversationTurnRole {
    @SerialName("user") USER,
    @SerialName("assistant") ASSISTANT,
}

@Serializable
enum class ConversationTurnSource {
    @SerialName("text") TEXT,
    @SerialName("voice") VOICE,
}

@Serializable
enum class ConversationTurnStatus {
    @SerialName("received") RECEIVED,
    @SerialName("processing") PROCESSING,
    @SerialName("responding") RESPONDING,
    @SerialName("completed") COMPLETED,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("failed") FAILED,
}

@Serializable
enum class InterruptReason {
    @SerialName("barge_in") BARGE_IN,
    @SerialName("user_cancel") USER_CANCEL,
}

@Serializable
sealed class ConversationEvent {
    abstract val conversationId: String
    abstract val turnId: String
}

@Serializable
@SerialName("turn.received")
data class TurnReceivedEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
    @SerialName("requestId") val requestId: String,
    @SerialName("role") val role: ConversationTurnRole,
    @SerialName("source") val source: ConversationTurnSource,
    @Serializable(with = ConversationEpochMillisSerializer::class) @SerialName("createdAt") val createdAt: Long,
) : ConversationEvent()

@Serializable
@SerialName("transcript.partial")
data class TranscriptPartialEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
    @SerialName("text") val text: String,
) : ConversationEvent()

@Serializable
@SerialName("transcript.final")
data class TranscriptFinalEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
    @SerialName("text") val text: String,
) : ConversationEvent()

@Serializable
@SerialName("response.chunk")
data class ResponseChunkEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
    @SerialName("text") val text: String,
) : ConversationEvent()

@Serializable
@SerialName("response.completed")
data class ResponseCompletedEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
) : ConversationEvent()

@Serializable
@SerialName("turn.interrupted")
data class TurnInterruptedEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
    @SerialName("reason") val reason: InterruptReason,
) : ConversationEvent()

@Serializable
@SerialName("turn.failed")
data class TurnFailedEvent(
    @SerialName("conversationId") override val conversationId: String,
    @SerialName("turnId") override val turnId: String,
    @SerialName("reason") val reason: String,
) : ConversationEvent()

@Serializable
data class ConversationSession(
    @SerialName("conversationId") val conversationId: String,
    @SerialName("deviceId") val deviceId: String,
    @SerialName("activeTurnId") val activeTurnId: String? = null,
    @SerialName("status") val status: ConversationStatus,
    @Serializable(with = ConversationEpochMillisSerializer::class) @SerialName("createdAt") val createdAt: Long,
    @Serializable(with = ConversationEpochMillisSerializer::class) @SerialName("updatedAt") val updatedAt: Long,
)

@Serializable
data class ConversationTurn(
    @SerialName("turnId") val turnId: String,
    @SerialName("conversationId") val conversationId: String,
    @SerialName("requestId") val requestId: String,
    @SerialName("role") val role: ConversationTurnRole,
    @SerialName("source") val source: ConversationTurnSource,
    @SerialName("content") val content: String,
    @SerialName("status") val status: ConversationTurnStatus,
    @Serializable(with = ConversationEpochMillisSerializer::class) @SerialName("createdAt") val createdAt: Long,
)

/** Wire validation rules generated from the same schema as the models. */
internal object GeneratedConversationContract {
    val events: Map<String, ConversationObjectRule> = mapOf(
        "turn.received" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "turn.received"),
            "requestId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "role" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("user", "assistant")),
            "source" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("text", "voice")),
            "createdAt" to ConversationFieldRule(required = true, kind = ConversationFieldKind.INTEGER, minimum = 0L, maximum = 8640000000000000L),
        )),
        "transcript.partial" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "transcript.partial"),
            "text" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, maxLength = 512),
        )),
        "transcript.final" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "transcript.final"),
            "text" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, minLength = 1, maxLength = 4000),
        )),
        "response.chunk" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "response.chunk"),
            "text" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, maxLength = 512),
        )),
        "response.completed" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "response.completed"),
        )),
        "turn.interrupted" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "turn.interrupted"),
            "reason" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("barge_in", "user_cancel")),
        )),
        "turn.failed" to ConversationObjectRule(mapOf(
            "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
            "type" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, literal = "turn.failed"),
            "reason" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, minLength = 1, maxLength = 300),
        )),
    )
    val session: ConversationObjectRule = ConversationObjectRule(mapOf(
        "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
        "deviceId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
        "activeTurnId" to ConversationFieldRule(required = false, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
        "status" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("active", "paused", "closed")),
        "createdAt" to ConversationFieldRule(required = true, kind = ConversationFieldKind.INTEGER, minimum = 0L, maximum = 8640000000000000L),
        "updatedAt" to ConversationFieldRule(required = true, kind = ConversationFieldKind.INTEGER, minimum = 0L, maximum = 8640000000000000L),
    ))
    val turn: ConversationObjectRule = ConversationObjectRule(mapOf(
        "turnId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
        "conversationId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
        "requestId" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, format = "uuid", pattern = "^[0-9a-f-]+\$"),
        "role" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("user", "assistant")),
        "source" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("text", "voice")),
        "content" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, minLength = 1, maxLength = 4000),
        "status" to ConversationFieldRule(required = true, kind = ConversationFieldKind.STRING, values = setOf("received", "processing", "responding", "completed", "interrupted", "failed")),
        "createdAt" to ConversationFieldRule(required = true, kind = ConversationFieldKind.INTEGER, minimum = 0L, maximum = 8640000000000000L),
    ))
}
