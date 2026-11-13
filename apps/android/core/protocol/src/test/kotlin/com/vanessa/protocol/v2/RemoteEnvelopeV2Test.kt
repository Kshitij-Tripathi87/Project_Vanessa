package com.vanessa.protocol.v2

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class RemoteEnvelopeV2Test {
    private val json = Json

    @Test
    fun canonicalizerMatchesSharedJcsGoldenVectors() {
        val fixture = resource("/canonical-v2.json")
        val vectors = fixture.getValue("vectors").jsonArray
        assertTrue(vectors.isNotEmpty())
        vectors.forEach { item ->
            val vector = item.jsonObject
            val name = vector.getValue("name").jsonPrimitive.content
            val expected = vector.getValue("canonical").jsonPrimitive.content
            val actual = JcsCanonicalizer.canonicalize(vector.getValue("input"))
            assertEquals(expected, actual, "JCS vector: $name")
        }
    }

    @Test
    fun verifiesSharedNodeEs256SignatureVectors() {
        val fixture = resource("/signature-v2.json")
        val publicPem = fixture.getValue("keyPair").jsonObject
            .getValue("publicKeyPem").jsonPrimitive.content
        val publicKey = publicKeyFromPem(publicPem)
        assertEquals(
            fixture.getValue("keyId").jsonPrimitive.content,
            RemoteEnvelopeCrypto.keyId(publicKey.encoded),
        )

        val vectors = fixture.getValue("vectors").jsonArray
        assertTrue(vectors.isNotEmpty())
        vectors.forEach { item ->
            val vector = item.jsonObject
            val name = vector.getValue("name").jsonPrimitive.content
            val expectedCanonical = vector.getValue("canonicalSignedJson").jsonPrimitive.content
            val envelope = json.decodeFromJsonElement<RemoteEnvelopeV2>(
                vector.getValue("envelope")
            )
            assertEquals(
                expectedCanonical,
                String(RemoteEnvelopeCrypto.canonicalSignedBytes(envelope), Charsets.UTF_8),
                "canonical preimage: $name",
            )
            assertTrue(RemoteEnvelopeCrypto.verify(envelope, publicKey), "signature vector: $name")
        }
    }

    @Test
    fun generatedP256IdentitySignsVerifiesAndRejectsTampering() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val id = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val payload = json.parseToJsonElement("""{"requestId":"00000000-0000-4000-8000-000000000001","capability":"system_status"}""").jsonObject
        val envelope = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(
                type = "task.submit",
                payload = payload,
                keyId = id,
                sessionId = "00000000-0000-4000-8000-000000000000",
                messageId = "11112222-3333-4444-5555-000066667777",
                sentAt = 1760000000000L,
                sequence = 1,
            ),
            pair.private,
            pair.public,
        )
        assertTrue(RemoteEnvelopeCrypto.verify(envelope, pair.public))
        val wire = RemoteEnvelopeCrypto.encode(envelope)
        assertTrue(RemoteEnvelopeCrypto.verify(RemoteEnvelopeCrypto.decode(wire), pair.public))
        val changed = envelope.copy(payload = JsonObject(envelope.payload + ("capability" to json.parseToJsonElement("\"delete_file\""))))
        assertFalse(RemoteEnvelopeCrypto.verify(changed, pair.public))
        val other = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        assertFalse(RemoteEnvelopeCrypto.verify(envelope, other.public))
        assertNotEquals(RemoteEnvelopeCrypto.keyId(other.public.encoded), id)
    }

    @Test
    fun signatureAndSequenceBoundsAreEnforced() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val id = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val seed = RemoteEnvelopeSeedV2(
            type = "ping",
            payload = json.parseToJsonElement("""{"sentAt":1}""").jsonObject,
            keyId = id,
            sequence = REMOTE_MAX_SEQUENCE,
        )
        val signed = RemoteEnvelopeCrypto.sign(seed, pair.private, pair.public)
        assertTrue(RemoteEnvelopeCrypto.verify(signed, pair.public))
        assertFalse(RemoteEnvelopeCrypto.verify(
            signed.copy(sequence = REMOTE_MAX_SEQUENCE + 1),
            pair.public,
        ))
    }


    @Test
    fun decoderRejectsUnknownEnvelopeAndAuthMembers() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val keyId = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val signed = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(
                type = "ping",
                payload = json.parseToJsonElement("""{"sentAt":1}""").jsonObject,
                keyId = keyId,
            ),
            pair.private,
            pair.public,
        )
        val parsed = json.parseToJsonElement(RemoteEnvelopeCrypto.encode(signed)).jsonObject
        val unknownEnvelopeMember = JsonObject(parsed + ("unexpected" to json.parseToJsonElement("true")))
        assertFailsWith<IllegalArgumentException> {
            RemoteEnvelopeCrypto.decode(JcsCanonicalizer.canonicalize(unknownEnvelopeMember))
        }
        val auth = parsed.getValue("auth").jsonObject
        val unknownAuthMember = JsonObject(parsed + ("auth" to JsonObject(auth + ("extra" to json.parseToJsonElement("1")))))
        assertFailsWith<IllegalArgumentException> {
            RemoteEnvelopeCrypto.decode(JcsCanonicalizer.canonicalize(unknownAuthMember))
        }
    }

    @Test
    fun decoderRejectsDuplicateMembersAtEveryObjectDepth() {
        val pair = p256KeyPair()
        val id = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val envelope = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(
                type = "ping",
                payload = json.parseToJsonElement("""{"sentAt":1}""").jsonObject,
                keyId = id,
                messageId = "11112222-3333-4444-5555-000066667777",
                sentAt = 1,
                sequence = 1,
            ),
            pair.private,
            pair.public,
        )
        val wire = RemoteEnvelopeCrypto.encode(envelope)
        val duplicateTopLevel = wire.replace("\"v\":2", "\"v\":2,\"v\":2")
        assertFailsWith<IllegalArgumentException> { RemoteEnvelopeCrypto.decode(duplicateTopLevel) }

        val duplicateNested = wire.replace(
            "\"payload\":{\"sentAt\":1}",
            "\"payload\":{\"sentAt\":1,\"sentAt\":2}",
        )
        assertFailsWith<IllegalArgumentException> { RemoteEnvelopeCrypto.decode(duplicateNested) }
    }

    @Test
    fun identityCurveCheckRequiresTheActualP256Parameters() {
        val pair = p256KeyPair()
        val publicKey = pair.public as java.security.interfaces.ECPublicKey
        assertTrue(RemoteEnvelopeCrypto.isP256(publicKey))
        assertFalse(RemoteEnvelopeCrypto.isP256(AlteredCurvePublicKey(publicKey)))
    }

    @Test
    fun encodeValidatesEnvelopeBeforeReturningWireBytes() {
        val pair = p256KeyPair()
        val id = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val valid = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(
                type = "ping",
                payload = json.parseToJsonElement("""{"sentAt":1}""").jsonObject,
                keyId = id,
                sequence = 1,
            ),
            pair.private,
            pair.public,
        )
        assertFailsWith<IllegalArgumentException> {
            RemoteEnvelopeCrypto.encode(valid.copy(sequence = REMOTE_MAX_SEQUENCE + 1))
        }
    }

    @Test
    fun sessionGuardAuthenticatesSequenceAndRejectsReplay() {
        val pair = p256KeyPair()
        val sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        val id = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val guard = RemoteEnvelopeSessionGuard(
            sessionId = sessionId,
            keyId = id,
            publicKey = pair.public,
        )
        fun frame(sequence: Int, messageId: String = java.util.UUID.randomUUID().toString()) =
            RemoteEnvelopeCrypto.sign(
                RemoteEnvelopeSeedV2(
                    type = "ping",
                    payload = json.parseToJsonElement("""{"sentAt":1000}""").jsonObject,
                    keyId = id,
                    sessionId = sessionId,
                    messageId = messageId,
                    sentAt = 1_000,
                    sequence = sequence,
                ),
                pair.private,
                pair.public,
            )

        val first = frame(1)
        assertEquals(RemoteEnvelopeCheck.Accepted, guard.verifyAndAccept(first, nowMillis = 1_000))
        assertEquals(
            RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.REPLAYED_MESSAGE),
            guard.verifyAndAccept(first, nowMillis = 1_000),
        )

        // Gaps are valid: a full-duplex peer may allocate a sequence while this
        // direction is idle. Replays and non-increasing values are not.
        val third = frame(3)
        assertEquals(RemoteEnvelopeCheck.Accepted, guard.verifyAndAccept(third, nowMillis = 1_000))
        assertEquals(
            RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.REPLAYED_MESSAGE),
            guard.verifyAndAccept(frame(4, third.messageId), nowMillis = 1_000),
        )
        assertEquals(3, guard.lastAcceptedSequence())

        val zeroStart = RemoteEnvelopeSessionGuard(
            sessionId = sessionId,
            keyId = id,
            publicKey = pair.public,
        )
        assertEquals(
            RemoteEnvelopeCheck.Accepted,
            zeroStart.verifyAndAccept(frame(0), nowMillis = 1_000),
        )
    }

    @Test
    fun sessionGuardRejectsWrongSessionStaleFutureAndInvalidSignatures() {
        val pair = p256KeyPair()
        val sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        val id = RemoteEnvelopeCrypto.keyId(pair.public.encoded)
        val guard = RemoteEnvelopeSessionGuard(
            sessionId = sessionId,
            keyId = id,
            publicKey = pair.public,
            maxMessageAgeMs = 10_000,
            maxFutureSkewMs = 2_000,
        )
        fun frame(
            sequence: Int,
            sentAt: Long,
            frameSession: String = sessionId,
        ) = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(
                type = "ping",
                payload = json.parseToJsonElement("""{"sentAt":$sentAt}""").jsonObject,
                keyId = id,
                sessionId = frameSession,
                sentAt = sentAt,
                sequence = sequence,
            ),
            pair.private,
            pair.public,
        )

        assertEquals(
            RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.WRONG_SESSION),
            guard.verifyAndAccept(frame(1, 100_000, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"), nowMillis = 100_000),
        )
        assertEquals(
            RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.STALE_MESSAGE),
            guard.verifyAndAccept(frame(1, 80_000), nowMillis = 100_000),
        )
        assertEquals(
            RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.FUTURE_MESSAGE),
            guard.verifyAndAccept(frame(1, 103_000), nowMillis = 100_000),
        )
        val signed = frame(1, 100_000)
        val tampered = signed.copy(payload = JsonObject(signed.payload + ("sentAt" to json.parseToJsonElement("999999"))))
        assertEquals(
            RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.INVALID_SIGNATURE),
            guard.verifyAndAccept(tampered, nowMillis = 100_000),
        )
        assertEquals(0, guard.lastAcceptedSequence())
    }

    private fun p256KeyPair() = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    private class AlteredCurvePublicKey(
        private val delegate: java.security.interfaces.ECPublicKey,
    ) : java.security.interfaces.ECPublicKey {
        override fun getW() = delegate.w
        override fun getAlgorithm() = delegate.algorithm
        override fun getFormat() = delegate.format
        override fun getEncoded() = delegate.encoded
        override fun getParams(): java.security.spec.ECParameterSpec {
            val original = delegate.params
            val changedCurve = java.security.spec.EllipticCurve(
                original.curve.field,
                original.curve.a,
                original.curve.b.add(java.math.BigInteger.ONE),
            )
            return java.security.spec.ECParameterSpec(
                changedCurve, original.generator, original.order, original.cofactor,
            )
        }
    }

    private fun resource(name: String): JsonObject =
        json.parseToJsonElement(
            javaClass.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
        ).jsonObject

    private fun publicKeyFromPem(pem: String) = KeyFactory.getInstance("EC").generatePublic(
        X509EncodedKeySpec(
            Base64.getDecoder().decode(
                pem.replace("-----BEGIN PUBLIC KEY-----", "")
                    .replace("-----END PUBLIC KEY-----", "")
                    .filterNot(Char::isWhitespace)
            )
        )
    )
}
