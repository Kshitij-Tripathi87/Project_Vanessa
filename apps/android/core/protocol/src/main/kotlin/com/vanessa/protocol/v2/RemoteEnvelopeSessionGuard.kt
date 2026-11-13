package com.vanessa.protocol.v2

import java.security.PublicKey
import java.util.ArrayDeque

enum class RemoteEnvelopeRejectReason {
    WRONG_SESSION,
    UNKNOWN_KEY,
    STALE_MESSAGE,
    FUTURE_MESSAGE,
    REPLAYED_MESSAGE,
    SEQUENCE_OUT_OF_ORDER,
    INVALID_SIGNATURE,
}

sealed interface RemoteEnvelopeCheck {
    data object Accepted : RemoteEnvelopeCheck
    data class Rejected(val reason: RemoteEnvelopeRejectReason) : RemoteEnvelopeCheck
}

/**
 * Verifies an inbound, already session-bound remote stream.
 *
 * Call only after the handshake has authenticated the remote key and established
 * a session ID. The guard checks signature, wall-clock bounds, message identity,
 * and monotonic sequence. It permits sequence gaps because each direction can
 * consume envelope sequence values while the opposite peer is sending.
 */
class RemoteEnvelopeSessionGuard(
    private val sessionId: String,
    private val keyId: String,
    private val publicKey: PublicKey,
    lastAcceptedSequence: Int = -1,
    private val maxMessageAgeMs: Long = 60_000,
    private val maxFutureSkewMs: Long = 5_000,
    private val maxRememberedMessageIds: Int = 2_048,
) {
    private var highestAcceptedSequence = lastAcceptedSequence
    private val seenMessageIds = HashSet<String>()
    private val messageOrder = ArrayDeque<String>()

    init {
        require(sessionId.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))) {
            "Session ID must be a lowercase UUID"
        }
        require(keyId == RemoteEnvelopeCrypto.keyId(publicKey.encoded)) {
            "The pinned key ID does not match the public key"
        }
        require(RemoteEnvelopeCrypto.isP256(publicKey)) { "Remote identity must use P-256" }
        require(lastAcceptedSequence in -1..REMOTE_MAX_SEQUENCE) { "Invalid initial sequence" }
        require(maxMessageAgeMs > 0) { "Maximum message age must be positive" }
        require(maxFutureSkewMs >= 0) { "Future clock skew cannot be negative" }
        require(maxRememberedMessageIds > 0) { "Replay cache size must be positive" }
    }

    @Synchronized
    fun verifyAndAccept(
        envelope: RemoteEnvelopeV2,
        nowMillis: Long = System.currentTimeMillis(),
    ): RemoteEnvelopeCheck {
        if (envelope.sessionId != sessionId) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.WRONG_SESSION)
        }
        if (envelope.keyId != keyId) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.UNKNOWN_KEY)
        }
        if (envelope.sentAt < nowMillis && nowMillis - envelope.sentAt > maxMessageAgeMs) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.STALE_MESSAGE)
        }
        if (envelope.sentAt > nowMillis && envelope.sentAt - nowMillis > maxFutureSkewMs) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.FUTURE_MESSAGE)
        }
        if (seenMessageIds.contains(envelope.messageId)) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.REPLAYED_MESSAGE)
        }
        if (envelope.sequence <= highestAcceptedSequence) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.SEQUENCE_OUT_OF_ORDER)
        }
        if (!RemoteEnvelopeCrypto.verify(envelope, publicKey)) {
            return RemoteEnvelopeCheck.Rejected(RemoteEnvelopeRejectReason.INVALID_SIGNATURE)
        }

        highestAcceptedSequence = envelope.sequence
        remember(envelope.messageId)
        return RemoteEnvelopeCheck.Accepted
    }

    @Synchronized
    fun lastAcceptedSequence(): Int = highestAcceptedSequence

    private fun remember(messageId: String) {
        seenMessageIds.add(messageId)
        messageOrder.addLast(messageId)
        while (messageOrder.size > maxRememberedMessageIds) {
            seenMessageIds.remove(messageOrder.removeFirst())
        }
    }
}
