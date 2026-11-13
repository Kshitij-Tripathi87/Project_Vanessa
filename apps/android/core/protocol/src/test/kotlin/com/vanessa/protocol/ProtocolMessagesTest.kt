package com.vanessa.protocol

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class ProtocolMessagesTest {
    @Test
    fun sharedFixturesDecodeAndRoundTrip() {
        val json = Json { classDiscriminator = "type" }
        val fixtures = javaClass.getResourceAsStream("/protocol-v1.jsonl")!!
            .bufferedReader().useLines { it.filter(String::isNotBlank).toList() }
        assertEquals(11, fixtures.size)
        fixtures.forEach { fixture ->
            val parsed = json.decodeFromString<ProtocolMessage>(fixture)
            assertEquals(1, parsed.v)
            assertEquals(json.parseToJsonElement(fixture), json.encodeToJsonElement(ProtocolMessage.serializer(), parsed))
        }
    }
}
