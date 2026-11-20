package com.vanessa.protocol.conversation

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ConversationConformanceTest {
    private val json = Json { encodeDefaults = false; ignoreUnknownKeys = false }

    private fun resource(name: String): String =
        requireNotNull(javaClass.getResource("/$name")) { "Missing shared fixture: $name" }.readText()

    @Test
    fun sharedWireFixturesMatchZodAndRoundTrip() {
        val lines = resource("conversation-events-v1.jsonl").lineSequence()
            .filter { it.isNotBlank() }
            .map { json.parseToJsonElement(it).jsonObject }
            .toList()
        assertTrue(lines.size >= 50, "shared fixture corpus must not be empty")
        for (fixture in lines) {
            val name = fixture.getValue("name").jsonPrimitive.content
            val kind = fixture.getValue("kind").jsonPrimitive.content
            val wire = fixture.getValue("wire").jsonPrimitive.content
            val valid = fixture.getValue("valid").jsonPrimitive.boolean
            // Decode AND re-encode to exercise all generated polymorphic models.
            val result = runCatching {
                when (kind) {
                    "event" -> ConversationCodec.encodeEvent(ConversationCodec.decodeEvent(wire))
                    "session" -> ConversationCodec.encodeSession(ConversationCodec.decodeSession(wire))
                    "turn" -> ConversationCodec.encodeTurn(ConversationCodec.decodeTurn(wire))
                    else -> error("Unknown shared fixture kind: $kind")
                }
            }
            if (valid) {
                if (result.isFailure) throw AssertionError("Valid fixture rejected: $name", result.exceptionOrNull())
                val actual = json.parseToJsonElement(result.getOrThrow())
                assertEquals(fixture.getValue("expected"), actual, "Normalized wire fixture: $name")
            } else {
                assertTrue(result.isFailure, "Invalid wire fixture accepted: $name")
            }
        }
    }

    @Test
    fun sharedReducerVectorsMatchAfterEveryEventAndPreserveIdentity() {
        val document = json.parseToJsonElement(resource("conversation-reducer-vectors-v1.json")).jsonObject
        assertEquals(CONVERSATION_PROTOCOL_VERSION.toString(), document.getValue("version").jsonPrimitive.content)
        val vectors = document.getValue("vectors").jsonArray
        assertTrue(vectors.size >= 10, "shared reducer corpus must not be empty")
        for (item in vectors) {
            val vector = item.jsonObject
            val name = vector.getValue("name").jsonPrimitive.content
            val initial = vector["initialState"]?.let { json.decodeFromJsonElement<ConversationState>(it) }
                ?: initialConversationState(vector.getValue("conversationId").jsonPrimitive.content)
            var state = initial
            val events = mutableListOf<ConversationEvent>()
            for ((index, stepElement) in vector.getValue("steps").jsonArray.withIndex()) {
                val step = stepElement.jsonObject
                val event = ConversationCodec.decodeEvent(step.getValue("event").toString())
                events.add(event)
                val snapshot = json.encodeToJsonElement(state)
                val next = applyConversationEvent(state, event)
                assertEquals(snapshot, json.encodeToJsonElement(state), "$name step $index mutated its input")
                if (step.getValue("same").jsonPrimitive.boolean) {
                    assertSame(state, next, "$name step $index should preserve object identity")
                } else {
                    assertNotSame(state, next, "$name step $index should produce a new state")
                }
                val expected: JsonElement = step.getValue("state")
                assertEquals(expected, json.encodeToJsonElement(next), "$name step $index state")
                state = next
            }
            assertEquals(state, applyConversationEvents(initial, events), "$name batch fold")
        }
    }

    @Test
    fun generatedConstantsMatchTheContractBounds() {
        assertEquals(1, CONVERSATION_PROTOCOL_VERSION)
        assertEquals(200, MAX_CONVERSATION_TURNS)
        assertEquals(4000, MAX_TURN_CONTENT)
        assertEquals(512, MAX_TRANSCRIPT_CHUNK)
    }

    @Test
    fun outboundProgrammaticallyConstructedEventsAreAlsoValidated() {
        val validId = "11111111-1111-4111-8111-111111111111"
        assertFails {
            ConversationCodec.encodeEvent(TranscriptPartialEvent(validId, validId, "x".repeat(513)))
        }
        assertFails {
            ConversationCodec.encodeEvent(ResponseCompletedEvent("ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB", validId))
        }
        val good = ResponseCompletedEvent(validId, validId)
        assertEquals(good, ConversationCodec.decodeEvent(ConversationCodec.encodeEvent(good)))
    }

    @Test
    fun malformedJsonErrorsDoNotRetainTranscriptInTheirCause() {
        val secret = "private transcript should not be logged"
        val error = kotlin.test.assertFailsWith<IllegalArgumentException> {
            ConversationCodec.decodeEvent("{\"text\":\"$secret")
        }
        assertFalse(error.toString().contains(secret))
        assertNull(error.cause)
    }

    @Test
    fun sessionOmissionIsDifferentFromExplicitNull() {
        val id = "11111111-1111-4111-8111-111111111111"
        val session = ConversationSession(id, id, null, ConversationStatus.ACTIVE, 0, 0)
        val encoded = ConversationCodec.encodeSession(session)
        assertFalse(json.parseToJsonElement(encoded).jsonObject.containsKey("activeTurnId"))
        assertEquals(session, ConversationCodec.decodeSession(encoded))
        assertFails { ConversationCodec.decodeSession(encoded.dropLast(1) + ",\"activeTurnId\":null}") }
    }
}
