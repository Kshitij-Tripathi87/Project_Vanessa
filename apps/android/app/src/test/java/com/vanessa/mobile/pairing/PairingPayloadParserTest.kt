package com.vanessa.mobile.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadParserTest {

    private val now = 1_700_000_000_000L

    private fun payload(
        type: String? = "vanessa_pairing",
        version: Int? = 1,
        pcIp: String? = "192.168.1.10",
        port: Int? = 8765,
        code: String? = "abc123",
        expiresAt: Long? = now + 300_000,
    ): String {
        val fields = mutableListOf<String>()
        type?.let { fields += "\"type\":\"$it\"" }
        version?.let { fields += "\"version\":$it" }
        pcIp?.let { fields += "\"pcIP\":\"$it\"" }
        port?.let { fields += "\"port\":$it" }
        code?.let { fields += "\"pairingCode\":\"$it\"" }
        expiresAt?.let { fields += "\"expiresAt\":$it" }
        return "{${fields.joinToString(",")}}"
    }

    private fun valid(raw: String): PairingPayloadResult.Valid =
        PairingPayloadParser.parse(raw, now) as PairingPayloadResult.Valid

    private fun invalid(raw: String): String =
        (PairingPayloadParser.parse(raw, now) as PairingPayloadResult.Invalid).reason

    @Test
    fun `parses a complete payload`() {
        val pairing = valid(payload()).pairing
        assertEquals("192.168.1.10", pairing.pcIp)
        assertEquals(8765, pairing.port)
        assertEquals("abc123", pairing.pairingCode)
        assertEquals(now + 300_000, pairing.expiresAt)
    }

    @Test
    fun `accepts camelCase address field from older payloads`() {
        val raw = "{\"type\":\"vanessa_pairing\",\"version\":1,\"pcIp\":\"10.0.0.5\",\"pairingCode\":\"c\",\"port\":8766}"
        val pairing = valid(raw).pairing
        assertEquals("10.0.0.5", pairing.pcIp)
        assertEquals(8766, pairing.port)
    }

    @Test
    fun `missing type and version fall back to the current contract`() {
        val raw = "{\"pcIP\":\"10.0.0.5\",\"pairingCode\":\"c\",\"expiresAt\":${now + 1}}"
        assertEquals("10.0.0.5", valid(raw).pairing.pcIp)
    }

    @Test
    fun `missing port defaults to the gateway port`() {
        assertEquals(PairingPayloadParser.DEFAULT_PORT, valid(payload(port = null)).pairing.port)
    }

    @Test
    fun `missing expiry is kept as no-expiry rather than rejected`() {
        assertEquals(PairingPayloadParser.NO_EXPIRY, valid(payload(expiresAt = null)).pairing.expiresAt)
    }

    @Test
    fun `rejects malformed json`() {
        assertEquals("That QR code is not a Vanessa pairing code.", invalid("not json at all"))
        assertEquals("That QR code is not a Vanessa pairing code.", invalid(""))
    }

    @Test
    fun `rejects a payload from another product`() {
        assertTrue(invalid(payload(type = "wifi_pairing")).contains("Unsupported pairing payload"))
    }

    @Test
    fun `rejects an unknown protocol version`() {
        assertTrue(invalid(payload(version = 2)).contains("version=2"))
    }

    @Test
    fun `rejects a payload without an address`() {
        assertTrue(invalid(payload(pcIp = null)).contains("missing the PC address or code"))
        assertTrue(invalid(payload(pcIp = "   ")).contains("missing the PC address or code"))
    }

    @Test
    fun `rejects a payload without a pairing code`() {
        assertTrue(invalid(payload(code = null)).contains("missing the PC address or code"))
        assertTrue(invalid(payload(code = "")).contains("missing the PC address or code"))
    }

    @Test
    fun `rejects a port outside the valid range`() {
        assertTrue(invalid(payload(port = 0)).contains("invalid port: 0"))
        assertTrue(invalid(payload(port = 70_000)).contains("invalid port: 70000"))
    }

    @Test
    fun `rejects an expired code`() {
        assertTrue(invalid(payload(expiresAt = now - 1)).contains("expired"))
        // Exactly at the expiry instant counts as expired.
        assertTrue(invalid(payload(expiresAt = now)).contains("expired"))
    }

    @Test
    fun `accepts a code that expires in the future`() {
        assertEquals(now + 1, valid(payload(expiresAt = now + 1)).pairing.expiresAt)
    }
}
