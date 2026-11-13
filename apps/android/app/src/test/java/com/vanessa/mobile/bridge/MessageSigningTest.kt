package com.vanessa.mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-language vector: the expected canonical string and signature were
 * produced by the desktop implementation (`apps/desktop/src/main/
 * messageSecurity.ts`) with the same message and secret. If either side changes
 * its serialisation, this fails instead of silently producing messages the PC
 * rejects.
 */
class MessageSigningTest {

    private val secret = "test-secret"

    private fun message() = linkedMapOf<String, Any>(
        "v" to 1,
        "id" to "11111111-1111-4111-8111-111111111111",
        "timestamp" to 1_700_000_000_000L,
        "type" to "task.submit",
        "tool" to "system_status",
        "args" to mapOf("metric" to "all"),
        "idempotencyKey" to "k1",
    )

    private val expectedCanonical =
        """{"args":{"metric":"all"},"id":"11111111-1111-4111-8111-111111111111","idempotencyKey":"k1",""" +
            """"nonce":"nonce-1","timestamp":1700000000000,"tool":"system_status","type":"task.submit","v":1}"""

    private val expectedSignature = "79527b789c018b2c8d78346aed0fb37bf02e46a8d32eb1ef8052792c2fa9b3dd"

    @Test
    fun `canonical json sorts keys and matches the PC byte for byte`() {
        val withNonce = message().toMutableMap().apply { put("nonce", "nonce-1") }
        assertEquals(expectedCanonical, MessageSigning.canonicalJson(withNonce))
    }

    @Test
    fun `signature matches the PC for the same message and secret`() {
        val signed = MessageSigning.sign(message(), secret, nonce = "nonce-1")
        assertEquals("nonce-1", signed["nonce"])
        assertEquals(expectedSignature, signed["signature"])
    }

    @Test
    fun `property order does not change the signature`() {
        val reordered = linkedMapOf<String, Any>(
            "idempotencyKey" to "k1",
            "nonce_placeholder" to "",
            "v" to 1,
            "args" to linkedMapOf("metric" to "all"),
            "tool" to "system_status",
            "type" to "task.submit",
            "timestamp" to 1_700_000_000_000L,
            "id" to "11111111-1111-4111-8111-111111111111",
        )
        reordered.remove("nonce_placeholder")

        val signed = MessageSigning.sign(reordered, secret, nonce = "nonce-1")
        assertEquals(expectedSignature, signed["signature"])
    }

    @Test
    fun `a different secret produces a different signature`() {
        val signed = MessageSigning.sign(message(), "other-secret", nonce = "nonce-1")
        assertNotEquals(expectedSignature, signed["signature"])
    }

    @Test
    fun `tampering with a field invalidates the signature`() {
        val signed = MessageSigning.sign(message(), secret, nonce = "nonce-1")
        val tampered = LinkedHashMap(signed).apply { put("tool", "shutdown_pc") }

        val signature = tampered.remove("signature") as String
        val recomputed = MessageSigning.sign(
            tampered.filterKeys { it != "signature" },
            secret,
            nonce = tampered["nonce"] as String,
        )["signature"] as String

        assertTrue(signature.isNotEmpty())
        assertNotEquals(signature, recomputed)
    }
}
