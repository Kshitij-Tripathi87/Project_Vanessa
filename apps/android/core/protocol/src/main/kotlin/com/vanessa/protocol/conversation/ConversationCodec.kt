package com.vanessa.protocol.conversation

import com.vanessa.protocol.v2.JsonDuplicateMemberGuard
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlin.math.floor

internal enum class ConversationFieldKind { STRING, INTEGER }

/** These rules are generated from the Zod-derived schema, not maintained here. */
internal data class ConversationFieldRule(
    val required: Boolean,
    val kind: ConversationFieldKind,
    val format: String? = null,
    val pattern: String? = null,
    val literal: String? = null,
    val values: Set<String>? = null,
    val minLength: Int? = null,
    val maxLength: Int? = null,
    val minimum: Long? = null,
    val maximum: Long? = null,
)

internal data class ConversationObjectRule(val fields: Map<String, ConversationFieldRule>)

private val canonicalUuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
private val jsonNumber = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

/**
 * JavaScript's JSON.parse represents all JSON numbers as IEEE-754 doubles; Zod
 * accepts 1000, 1000.0 and 1e3 as the same integer. kotlinx's default Long
 * decoder rejects the latter two. Match JS before converting to a Long; the
 * schema's safe, nonnegative epoch bounds are checked by the generated rules.
 */
private fun integerValue(element: JsonElement, minimum: Long?, maximum: Long?): Long {
    val primitive = element as? JsonPrimitive
        ?: throw IllegalArgumentException("Expected a JSON integer")
    require(!primitive.isString && jsonNumber.matches(primitive.content)) { "Expected a JSON number" }
    val value = primitive.content.toDoubleOrNull()
        ?: throw IllegalArgumentException("Invalid JSON number")
    require(value.isFinite() && floor(value) == value) { "Expected a finite integer" }
    if (minimum != null) require(value >= minimum.toDouble()) { "Integer is below its minimum" }
    if (maximum != null) require(value <= maximum.toDouble()) { "Integer is above its maximum" }
    require(value >= Long.MIN_VALUE.toDouble() && value < -Long.MIN_VALUE.toDouble()) {
        "Integer is outside Kotlin Long range"
    }
    return value.toLong()
}

/** Serializer for epoch fields; the associated generated rules apply bounds. */
object ConversationEpochMillisSerializer : KSerializer<Long> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("ConversationEpochMillis", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        require(decoder is JsonDecoder) { "Conversation wire models require JSON" }
        return integerValue(decoder.decodeJsonElement(), null, null)
    }

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
}

private fun validateObject(element: JsonElement, rule: ConversationObjectRule): JsonObject {
    val obj = element as? JsonObject ?: throw IllegalArgumentException("Expected a conversation object")
    require(obj.keys.all { it in rule.fields }) { "Conversation object has an unknown member" }
    for ((name, field) in rule.fields) {
        val value = obj[name]
        if (value == null) {
            require(!field.required) { "Conversation object is missing a required member: $name" }
            continue
        }
        when (field.kind) {
            ConversationFieldKind.STRING -> {
                val primitive = value as? JsonPrimitive
                    ?: throw IllegalArgumentException("Expected a string member: $name")
                require(primitive.isString) { "Expected a string member: $name" }
                val text = primitive.content
                if (field.format == "uuid") require(canonicalUuid.matches(text)) { "Invalid UUID member: $name" }
                if (field.pattern != null) require(Regex(field.pattern).matches(text)) { "Invalid string member: $name" }
                if (field.literal != null) require(text == field.literal) { "Invalid literal member: $name" }
                if (field.values != null) require(text in field.values) { "Invalid enum member: $name" }
                // Kotlin and JavaScript both count UTF-16 code units here. A
                // generic JSON Schema validator counts Unicode code points.
                if (field.minLength != null) require(text.length >= field.minLength) { "String is too short: $name" }
                if (field.maxLength != null) require(text.length <= field.maxLength) { "String is too long: $name" }
            }
            ConversationFieldKind.INTEGER -> integerValue(value, field.minimum, field.maximum)
        }
    }
    return obj
}

/**
 * The strict wire ingress/egress for generated conversation models. Do not use
 * a bare kotlinx Json decoder at a trust boundary: it does not enforce the
 * schema's UUID and string bounds and otherwise collapses duplicate members.
 *
 * This codec validates structure only; it does not authorize task execution.
 */
object ConversationCodec {
    private val json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = false
        isLenient = false
        encodeDefaults = false
    }

    private fun parse(wire: String): JsonElement {
        try {
            JsonDuplicateMemberGuard.requireUniqueMembers(wire)
            return json.parseToJsonElement(wire)
        } catch (_: Exception) {
            // kotlinx parser errors can contain the input. Do not retain the
            // cause either: callers may log the complete exception chain.
            throw IllegalArgumentException("Invalid conversation JSON")
        }
    }

    private fun validateEvent(element: JsonElement) {
        val obj = element as? JsonObject ?: throw IllegalArgumentException("Expected a conversation event")
        val type = obj["type"] as? JsonPrimitive ?: throw IllegalArgumentException("Missing event type")
        require(type.isString) { "Event type must be a string" }
        val rule = GeneratedConversationContract.events[type.content]
            ?: throw IllegalArgumentException("Unknown conversation event type")
        validateObject(obj, rule)
    }

    fun decodeEvent(wire: String): ConversationEvent {
        val value = parse(wire)
        validateEvent(value)
        return json.decodeFromJsonElement(value)
    }

    fun decodeSession(wire: String): ConversationSession {
        val value = parse(wire)
        validateObject(value, GeneratedConversationContract.session)
        return json.decodeFromJsonElement(value)
    }

    fun decodeTurn(wire: String): ConversationTurn {
        val value = parse(wire)
        validateObject(value, GeneratedConversationContract.turn)
        return json.decodeFromJsonElement(value)
    }

    fun encodeEvent(event: ConversationEvent): String {
        val value = json.encodeToJsonElement<ConversationEvent>(event)
        validateEvent(value)
        return value.toString()
    }

    fun encodeSession(session: ConversationSession): String {
        val value = json.encodeToJsonElement(session)
        validateObject(value, GeneratedConversationContract.session)
        return value.toString()
    }

    fun encodeTurn(turn: ConversationTurn): String {
        val value = json.encodeToJsonElement(turn)
        validateObject(value, GeneratedConversationContract.turn)
        return value.toString()
    }
}
