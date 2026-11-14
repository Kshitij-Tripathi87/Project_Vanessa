package com.vanessa.mobile.pairing

import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class RemoteV2PairingPayloadParserTest {
    private fun payload(now: Long = 1_800_000_000_000L): String {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val publicKey = generator.generateKeyPair().public.encoded
        val keyId = RemoteEnvelopeCrypto.keyId(publicKey)
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey)
        return JSONObject()
            .put("type", "vanessa_remote_v2")
            .put("version", 2)
            .put("protocolVersion", 2)
            .put("wsUrl", "wss://vanessa-pc.example.ts.net/remote-v2")
            .put("pcKeyId", keyId)
            .put("pcPublicKey", encoded)
            .put("pcName", "Vanessa PC")
            .put("pairingId", "pair_0123456789abcdef01234567")
            .put("code", "ABCD1234-EFGH5678")
            .put("expiresAt", now + 60_000)
            .toString()
    }

    @Test
    fun parsesValidTailnetQrPayload() {
        val now = 1_800_000_000_000L
        val result = RemoteV2PairingPayloadParser.parse(payload(now), now)
        assertTrue(result is RemoteV2PairingPayloadResult.Valid)
        val config = (result as RemoteV2PairingPayloadResult.Valid).configuration
        assertEquals("wss://vanessa-pc.example.ts.net/remote-v2", config.wsUrl)
    }

    @Test
    fun rejectsPlainHttpOrNonRemotePath() {
        val now = 1_800_000_000_000L
        val http = JSONObject(payload(now)).put("wsUrl", "http://vanessa-pc.example.ts.net/remote-v2").toString()
        val wrongPath = JSONObject(payload(now)).put("wsUrl", "wss://vanessa-pc.example.ts.net/anything").toString()
        assertTrue(RemoteV2PairingPayloadParser.parse(http, now) is RemoteV2PairingPayloadResult.Invalid)
        assertTrue(RemoteV2PairingPayloadParser.parse(wrongPath, now) is RemoteV2PairingPayloadResult.Invalid)
    }

    @Test
    fun rejectsPublicKeyFingerprintMismatch() {
        val now = 1_800_000_000_000L
        val wrong = JSONObject(payload(now)).put("pcKeyId", "AAAAAAAAAAAAAAAAAAAAAA").toString()
        assertTrue(RemoteV2PairingPayloadParser.parse(wrong, now) is RemoteV2PairingPayloadResult.Invalid)
    }

    @Test
    fun rejectsExpiredPairingPayload() {
        val now = 1_800_000_000_000L
        assertTrue(RemoteV2PairingPayloadParser.parse(payload(now - 120_000), now) is RemoteV2PairingPayloadResult.Invalid)
    }
}
