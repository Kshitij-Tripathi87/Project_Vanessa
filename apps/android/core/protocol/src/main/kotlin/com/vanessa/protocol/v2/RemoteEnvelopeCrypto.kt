package com.vanessa.protocol.v2

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.util.Base64
import java.util.UUID

const val REMOTE_PROTOCOL_V2 = 2
const val REMOTE_SIGNATURE_ALGORITHM = "ES256"
const val PRE_SESSION_ID = "00000000-0000-0000-0000-000000000000"
const val REMOTE_MAX_SEQUENCE = 2_147_483_647

@Serializable
data class RemoteEnvelopeAuthV2(
    val algorithm: String,
    val signature: String,
)

@Serializable
data class RemoteEnvelopeV2(
    val v: Int,
    val messageId: String,
    val sessionId: String,
    val type: String,
    val sentAt: Long,
    val sequence: Int,
    val keyId: String,
    val payload: JsonObject,
    val auth: RemoteEnvelopeAuthV2,
)

data class RemoteEnvelopeSeedV2(
    val type: String,
    val payload: JsonObject,
    val keyId: String,
    val sessionId: String = PRE_SESSION_ID,
    val messageId: String = UUID.randomUUID().toString(),
    val sentAt: Long = System.currentTimeMillis(),
    val sequence: Int = 0,
)

/**
 * ES256 envelope signing and verification compatible with packages/protocol.
 * Android identity private keys are supplied by Android Keystore and are never
 * serialized or exported by this class.
 */
object RemoteEnvelopeCrypto {
    private val json = Json { encodeDefaults = true }
    private val allowedTypes = setOf(
        "server.challenge", "client.authenticate", "session.ready", "session.expiring",
        "session.close", "protocol.error", "pairing.claim", "pairing.challenge",
        "pairing.complete", "pairing.pending", "pairing.approved", "pairing.rejected",
        "pairing.expired", "manifest.get", "manifest.snapshot", "manifest.changed",
        "task.submit", "task.accepted", "task.snapshot", "task.progress",
        "task.confirmation_required", "task.confirmation_response", "task.cancel",
        "task.cancel_ack", "task.result", "task.error", "sync.resume", "sync.snapshot",
        "sync.event", "sync.complete", "ping", "pong",
    )

    fun sign(
        seed: RemoteEnvelopeSeedV2,
        privateKey: PrivateKey,
        publicKey: PublicKey,
    ): RemoteEnvelopeV2 {
        require(isP256(publicKey)) { "ES256 identity must use the P-256 curve" }
        require(seed.keyId == keyId(publicKey.encoded)) { "Envelope keyId does not match the signing key" }
        val unsigned = RemoteEnvelopeV2(
            v = REMOTE_PROTOCOL_V2,
            messageId = seed.messageId,
            sessionId = seed.sessionId,
            type = seed.type,
            sentAt = seed.sentAt,
            sequence = seed.sequence,
            keyId = seed.keyId,
            payload = seed.payload,
            auth = RemoteEnvelopeAuthV2(REMOTE_SIGNATURE_ALGORITHM, ""),
        )
        validate(unsigned, allowEmptySignature = true)
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(canonicalSignedBytes(unsigned))
        val signature = signer.sign().toBase64Url()
        return unsigned.copy(auth = unsigned.auth.copy(signature = signature))
    }

    fun verify(envelope: RemoteEnvelopeV2, publicKey: PublicKey): Boolean {
        return try {
            validate(envelope)
            if (envelope.auth.algorithm != REMOTE_SIGNATURE_ALGORITHM) return false
            if (!isP256(publicKey)) return false
            if (envelope.keyId != keyId(publicKey.encoded)) return false
            val bytes = envelope.auth.signature.decodeBase64Url()
            if (bytes.isEmpty()) return false
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(publicKey)
            verifier.update(canonicalSignedBytes(envelope))
            verifier.verify(bytes)
        } catch (_: Exception) {
            false
        }
    }

    fun canonicalSignedBytes(envelope: RemoteEnvelopeV2): ByteArray =
        JcsCanonicalizer.canonicalize(toJsonElement(envelope, includeSignature = false))
            .toByteArray(Charsets.UTF_8)

    fun encode(envelope: RemoteEnvelopeV2): String {
        val wire = JcsCanonicalizer.canonicalize(toJsonElement(envelope, includeSignature = true))
        require(wire.toByteArray(Charsets.UTF_8).size <= 64 * 1024) { "Envelope exceeds 64 KiB" }
        return wire
    }

    fun decode(wire: String): RemoteEnvelopeV2 {
        require(wire.toByteArray(Charsets.UTF_8).size <= 64 * 1024) { "Envelope exceeds 64 KiB" }
        val parsed = json.decodeFromString<RemoteEnvelopeV2>(wire)
        validate(parsed)
        return parsed
    }

    fun keyId(publicKeySpkiDer: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(publicKeySpkiDer)
        return digest.copyOfRange(0, 16).toBase64Url()
    }

    fun publicKeyBase64Url(publicKeySpkiDer: ByteArray): String = publicKeySpkiDer.toBase64Url()

    private fun toJsonElement(envelope: RemoteEnvelopeV2, includeSignature: Boolean): JsonObject =
        buildJsonObject {
            put("v", envelope.v)
            put("messageId", envelope.messageId)
            put("sessionId", envelope.sessionId)
            put("type", envelope.type)
            put("sentAt", envelope.sentAt)
            put("sequence", envelope.sequence)
            put("keyId", envelope.keyId)
            put("payload", envelope.payload)
            put("auth", buildJsonObject {
                put("algorithm", envelope.auth.algorithm)
                if (includeSignature) put("signature", envelope.auth.signature)
            })
        }

    private fun validate(envelope: RemoteEnvelopeV2, allowEmptySignature: Boolean = false) {
        require(envelope.v == REMOTE_PROTOCOL_V2) { "Unsupported remote protocol version" }
        require(isLowercaseUuid(envelope.messageId)) { "messageId must be a lowercase UUID" }
        require(isLowercaseUuid(envelope.sessionId)) { "sessionId must be a lowercase UUID" }
        require(envelope.type in allowedTypes) { "Unknown protocol v2 message type" }
        require(envelope.sentAt >= 0L) { "sentAt must be nonnegative" }
        require(envelope.sequence in 0..REMOTE_MAX_SEQUENCE) { "sequence is outside protocol bounds" }
        require(envelope.keyId.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))) { "Invalid keyId" }
        require(envelope.payload.size <= 32 && envelope.payload.keys.all { it.length <= 64 }) {
            "Payload exceeds protocol member bounds"
        }
        validatePayloadDepth(envelope.payload, 0)
        require(envelope.auth.algorithm == REMOTE_SIGNATURE_ALGORITHM) { "Unsupported signature algorithm" }
        if (!allowEmptySignature) {
            require(envelope.auth.signature.matches(Regex("^[A-Za-z0-9_-]{16,200}$"))) {
                "Invalid base64url signature"
            }
        }
    }

    private fun isLowercaseUuid(value: String): Boolean =
        value.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) &&
            runCatching { UUID.fromString(value) }.isSuccess

    private fun isP256(publicKey: PublicKey): Boolean {
        val ecKey = publicKey as? ECPublicKey ?: return false
        return ecKey.params.curve.field.fieldSize == 256
    }

    private fun validatePayloadDepth(value: kotlinx.serialization.json.JsonElement, depth: Int) {
        require(depth <= 6) { "Payload exceeds the maximum JSON depth" }
        when (value) {
            is JsonObject -> value.forEach { (key, child) ->
                require(key.length <= 64) { "Payload key exceeds the protocol length limit" }
                validatePayloadDepth(child, depth + 1)
            }
            is kotlinx.serialization.json.JsonArray -> value.forEach { validatePayloadDepth(it, depth + 1) }
            else -> Unit
        }
    }

    private fun ByteArray.toBase64Url(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(this)

    private fun String.decodeBase64Url(): ByteArray {
        require(matches(Regex("^[A-Za-z0-9_-]+$"))) { "Malformed base64url" }
        return Base64.getUrlDecoder().decode(this)
    }
}
