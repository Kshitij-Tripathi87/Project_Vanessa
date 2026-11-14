package com.vanessa.mobile.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadParserTest {
    private val now = 1_700_000_000_000L

    private fun payload(
        version: Int = 2,
        endpoint: String = "wss://vanessa-pc.tailnet.ts.net/remote/v2",
        pairingId: String = "pair_0123456789abcdef",
        code: String = "0123456789abcdef0123456789abcdef0123456789abcdef",
        pcKeyId: String = "ABCDEFGHIJKLMNOPQRSTUV",
        pcPublicKey: String = "A".repeat(120),
        expiresAt: Long = now + 300_000,
    ): String = """{"version":$version,"endpoint":"$endpoint","pairingId":"$pairingId","code":"$code","pcKeyId":"$pcKeyId","pcPublicKey":"$pcPublicKey","expiresAt":$expiresAt}"""

    private fun valid(raw: String) =
        PairingPayloadParser.parse(raw, now) as PairingPayloadResult.Valid

    private fun invalid(raw: String) =
        (PairingPayloadParser.parse(raw, now) as PairingPayloadResult.Invalid).reason

    @Test
    fun parsesSecureV2PairingMetadataAndPinsPcKey() {
        val pairing = valid(payload()).pairing
        assertEquals("vanessa-pc.tailnet.ts.net", pairing.pcIp)
        assertEquals(443, pairing.port)
        assertEquals("pair_0123456789abcdef", pairing.pairingId)
        assertEquals("0123456789abcdef0123456789abcdef0123456789abcdef", pairing.pairingCode)
        assertEquals("ABCDEFGHIJKLMNOPQRSTUV", pairing.pcKeyId)
        assertEquals("A".repeat(120), pairing.pcPublicKey)
        assertEquals("wss://vanessa-pc.tailnet.ts.net/remote/v2", pairing.endpoint)
    }

    @Test
    fun usesExplicitSecureEndpointPortWhenProvided() {
        assertEquals(9443, valid(payload(endpoint = "wss://vanessa-pc.tailnet.ts.net:9443/remote/v2")).pairing.port)
    }

    @Test
    fun rejectsMalformedJsonAndUnsupportedProtocolVersions() {
        assertTrue(invalid("not json").contains("valid JSON"))
        assertTrue(invalid(payload(version = 1)).contains("protocol-v2"))
        assertTrue(invalid(payload(version = 3)).contains("protocol-v2"))
    }

    @Test
    fun rejectsMissingOrMalformedPairingFields() {
        assertTrue(invalid(payload(pairingId = "")).contains("missing"))
        assertTrue(invalid(payload(code = "")).contains("missing"))
        assertTrue(invalid(payload(pcKeyId = "bad")).contains("missing"))
        assertTrue(invalid(payload(pcPublicKey = "bad")).contains("missing"))
    }

    @Test
    fun rejectsInsecureOrUnexpectedEndpoints() {
        assertTrue(invalid(payload(endpoint = "ws://vanessa-pc.tailnet.ts.net/remote/v2")).contains("secure WSS"))
        assertTrue(invalid(payload(endpoint = "wss://vanessa-pc.tailnet.ts.net/")).contains("secure WSS"))
        assertTrue(invalid(payload(endpoint = "https://vanessa-pc.tailnet.ts.net/remote/v2")).contains("secure WSS"))
    }

    @Test
    fun rejectsExpiredCodesIncludingExactExpiryInstant() {
        assertTrue(invalid(payload(expiresAt = now - 1)).contains("expired"))
        assertTrue(invalid(payload(expiresAt = now)).contains("expired"))
    }
}
