package com.vanessa.mobile.pairing

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadParserTest {
    private val now = 1_700_000_000_000L
    private val publicKey = "A".repeat(87)

    private fun payload(
        type: String = "vanessa_remote_v2",
        version: Int = 2,
        host: String = "winpc.tailnet.ts.net",
        port: Int = 43443,
        code: String = "a".repeat(48),
        expiresAt: Long = now + 300_000,
        scheme: String = "wss",
        path: String = "/remote-v2",
        pairingId: String = "pair_" + "b".repeat(24),
        keyId: String = "c".repeat(22),
    ): JSONObject = JSONObject()
        .put("type", type)
        .put("version", version)
        .put("pcIp", host)
        .put("port", port)
        .put("pairingId", pairingId)
        .put("pairingCode", code)
        .put("expiresAt", expiresAt)
        .put("pcKeyId", keyId)
        .put("pcPublicKey", publicKey)
        .put("scheme", scheme)
        .put("path", path)

    private fun valid(raw: String) =
        PairingPayloadParser.parse(raw, now) as PairingPayloadResult.Valid

    private fun invalid(raw: String) =
        (PairingPayloadParser.parse(raw, now) as PairingPayloadResult.Invalid).reason

    @Test fun parsesV2QrAndPinsPcIdentity() {
        val pairing = valid(payload().toString()).pairing
        assertEquals("winpc.tailnet.ts.net", pairing.pcIp)
        assertEquals(43443, pairing.port)
        assertEquals("pair_" + "b".repeat(24), pairing.pairingId)
        assertEquals("a".repeat(48), pairing.pairingCode)
        assertEquals("c".repeat(22), pairing.pcKeyId)
        assertEquals(publicKey, pairing.pcPublicKey)
        assertEquals("wss", pairing.scheme)
        assertEquals("/remote-v2", pairing.path)
    }

    @Test fun acceptsExplicitLoopbackTransportForIntegrationTestsOnly() {
        val pairing = valid(payload(host = "127.0.0.1", port = 4321, scheme = "ws").toString()).pairing
        assertEquals("127.0.0.1", pairing.pcIp)
        assertEquals("ws", pairing.scheme)
    }

    @Test fun rejectsMalformedJson() {
        assertTrue(invalid("not json").contains("not a Vanessa"))
    }

    @Test fun rejectsLegacyPayloadAndUnknownVersion() {
        assertTrue(invalid(payload(type = "vanessa_pairing", version = 1).toString()).contains("Unsupported"))
        assertTrue(invalid(payload(version = 3).toString()).contains("version=3"))
    }

    @Test fun rejectsMissingPairingOrIdentityFields() {
        val missingCode = payload().remove("pairingCode").toString()
        assertTrue(invalid(missingCode).contains("missing"))
        val missingKey = payload().remove("pcPublicKey").toString()
        assertTrue(invalid(missingKey).contains("missing"))
    }

    @Test fun rejectsInvalidHostAndNonTailnetRemoteTlsHost() {
        assertTrue(invalid(payload(host = "evil.example.com").toString()).contains("Tailscale TLS"))
        assertTrue(invalid(payload(host = "bad..host.ts.net").toString()).contains("invalid PC host"))
    }

    @Test fun rejectsCleartextForNonLoopbackHosts() {
        assertTrue(invalid(payload(host = "winpc.tailnet.ts.net", scheme = "ws").toString()).contains("loopback"))
    }

    @Test fun rejectsMalformedPairingClaimAndIdentity() {
        assertTrue(invalid(payload(pairingId = "wrong").toString()).contains("pairing claim"))
        assertTrue(invalid(payload(keyId = "short").toString()).contains("identity"))
    }

    @Test fun rejectsUnsupportedEndpointPath() {
        assertTrue(invalid(payload(path = "/").toString()).contains("endpoint path"))
    }

    @Test fun rejectsExpiredCodesAndAcceptsFutureExpiry() {
        assertTrue(invalid(payload(expiresAt = now).toString()).contains("expired"))
        assertEquals(now + 1, valid(payload(expiresAt = now + 1).toString()).pairing.expiresAt)
    }

    @Test fun rejectsInvalidPorts() {
        assertTrue(invalid(payload(port = 0).toString()).contains("port"))
        assertTrue(invalid(payload(port = 70_000).toString()).contains("port"))
    }
}
