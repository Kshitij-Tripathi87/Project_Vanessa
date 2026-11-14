package com.vanessa.mobile.bridge

import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.fragment.app.FragmentActivity
import android.util.Log
import com.vanessa.mobile.di.StoredPairing
import com.vanessa.mobile.identity.AndroidRemoteIdentityStore
import com.vanessa.mobile.identity.AndroidRemoteApprovalKeyStore
import com.vanessa.mobile.identity.RemoteApprovalBinding
import com.vanessa.protocol.v2.PRE_SESSION_ID
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import com.vanessa.protocol.v2.RemoteEnvelopeSeedV2
import com.vanessa.protocol.v2.RemoteEnvelopeSessionGuard
import com.vanessa.protocol.v2.RemoteEnvelopeCheck
import com.vanessa.protocol.v2.RemoteEnvelopeV2
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.send
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data object Connecting : ConnectionState()
    data class Connected(val pcIP: String) : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

sealed class BridgeEvent {
    data class ManifestReceived(val tools: List<ToolDefinition>) : BridgeEvent()
    data class PairingApproved(val deviceId: String) : BridgeEvent()
    data class PairingPending(val pairingId: String) : BridgeEvent()
    data class TaskAccepted(val taskId: String) : BridgeEvent()
    data class TaskProgress(val taskId: String, val state: String, val message: String?) : BridgeEvent()
    data class TaskResult(val taskId: String, val result: Any) : BridgeEvent()
    data class TaskError(val taskId: String?, val code: String, val message: String) : BridgeEvent()
    data class ConfirmationRequired(
        val taskId: String,
        val approvalId: String,
        val summary: String,
        val actionHash: String,
        val expiresAt: Long,
    ) : BridgeEvent()
    data class SessionClosed(val reason: String) : BridgeEvent()
}

data class ToolDefinition(
    val name: String,
    val description: String,
    val tier: String,
    val timeout: Int,
)

private class UnknownRemoteIdentity(message: String) : Exception(message)
private class PairingRejected(message: String) : Exception(message)

/**
 * Protocol-v2 Android transport. The phone has a non-exportable P-256
 * identity in Android Keystore; the PC identity is pinned from the QR code.
 * Every application message is ES256-signed and guarded by session sequence,
 * timestamp and replay checks.
 */
@Singleton
class VanessaBridgeClient @Inject constructor(@ApplicationContext private val appContext: Context) {
    private val tag = "VanessaRemoteV2"
    private val json = Json { ignoreUnknownKeys = false; encodeDefaults = true }
    private val identityStore = AndroidRemoteIdentityStore()
    private val approvalKeyStore = AndroidRemoteApprovalKeyStore()
    private val http = HttpClient(Android) {
        install(WebSockets)
    }
    private val sendMutex = Mutex()
    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()
    private val _events = MutableSharedFlow<BridgeEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<BridgeEvent> = _events.asSharedFlow()

    @Volatile private var activeSocket: DefaultClientWebSocketSession? = null
    @Volatile private var activeSessionId: String? = null
    @Volatile private var activePairing: StoredPairing? = null
    @Volatile private var outgoingSequence = 0
    @Volatile private var manualDisconnect = false
    private var pingJob: Job? = null
    private val requestIds = mutableMapOf<String, String>()

    /**
     * Maintains a connection and reconnects with bounded backoff. A new QR
     * claim is attempted only when a signed authenticate receives UNKNOWN_KEY.
     */
    suspend fun connect(pairing: StoredPairing) {
        if (_connectionState.value is ConnectionState.Connected) return
        activePairing = pairing
        manualDisconnect = false
        var preferPairingClaim = false
        var attempts = 0

        while (!manualDisconnect && currentCoroutineContext().isActive) {
            try {
                _connectionState.value = ConnectionState.Connecting
                connectOnce(activePairing ?: pairing, preferPairingClaim) { deviceId ->
                    activePairing = (activePairing ?: pairing).copy(deviceId = deviceId)
                    _events.emit(BridgeEvent.PairingApproved(deviceId))
                    preferPairingClaim = false
                }
                attempts = 0
                if (!manualDisconnect) {
                    _connectionState.value = ConnectionState.Error("PC connection closed. Reconnecting…")
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (unknown: UnknownRemoteIdentity) {
                val current = activePairing ?: pairing
                if (current.deviceId == null && current.expiresAt > System.currentTimeMillis()) {
                    preferPairingClaim = true
                    continue
                }
                _connectionState.value = ConnectionState.Error("This phone is not trusted by the PC. Pair it again from a new QR code.")
                return
            } catch (rejected: PairingRejected) {
                _connectionState.value = ConnectionState.Error(rejected.message ?: "The PC rejected pairing.")
                return
            } catch (error: Exception) {
                Log.w(tag, "Remote v2 connection failed", error)
                _connectionState.value = ConnectionState.Error(error.message ?: "Remote connection failed")
            } finally {
                activeSocket = null
                activeSessionId = null
                sessionGuard = null
                pingJob?.cancel()
                pingJob = null
            }

            if (!manualDisconnect && currentCoroutineContext().isActive) {
                attempts += 1
                delay((1_000L * (1L shl attempts.coerceAtMost(4))).coerceAtMost(15_000L))
            }
        }
        if (manualDisconnect) _connectionState.value = ConnectionState.Disconnected
    }

    private suspend fun connectOnce(
        pairing: StoredPairing,
        preferPairingClaim: Boolean,
        onPaired: suspend (String) -> Unit,
    ) {
        val identity = identityStore.loadOrCreate()
        val pcPublicKey = decodePcKey(pairing.pcPublicKey)
        val pcKeyId = RemoteEnvelopeCrypto.keyId(pcPublicKey.encoded)
        require(pcKeyId == pairing.pcKeyId) { "The PC public key does not match the QR fingerprint." }
        val url = pairing.scheme + "://" + pairing.pcIp + ":" + pairing.port + pairing.path

        http.webSocket(urlString = url) {
            activeSocket = this
            val challengeGuard = RemoteEnvelopeSessionGuard(PRE_SESSION_ID, pcKeyId, pcPublicKey)
            val challengeEnvelope = receiveVerified(pcPublicKey, challengeGuard)
            require(challengeEnvelope.type == "server.challenge") { "PC did not send the expected v2 server challenge." }
            val serverNonce = challengeEnvelope.payload.requiredString("serverNonce")

            val readyPayload = if (preferPairingClaim) {
                performPairingClaim(pairing, identity, pcPublicKey, pcKeyId, challengeGuard)
                // The PC sends pairing.approved before starting the new session.
                val approved = waitForPairingApproval(pcPublicKey, challengeGuard)
                onPaired(approved.requiredString("deviceId"))
                receiveSessionReady(
                    pcPublicKey,
                    pcKeyId,
                    approved.requiredString("serverNonce"),
                    approved.requiredString("clientNonce"),
                )
            } else {
                val clientNonce = randomBase64Url(32)
                val authPayload = buildJsonObject {
                    put("serverNonce", serverNonce)
                    put("clientNonce", clientNonce)
                    put("publicKey", identity.publicKeyBase64Url)
                    put("deviceHint", deviceHint())
                    put("platform", "android")
                    put("appVersion", "0.1.0")
                }
                sendPreSession("client.authenticate", authPayload, identity, 0)
                val response = receiveEnvelope()
                if (response.type == "protocol.error") {
                    require(response.sessionId == PRE_SESSION_ID &&
                        response.keyId == pcKeyId &&
                        RemoteEnvelopeCrypto.verify(response, pcPublicKey) &&
                        challengeGuard.verifyAndAccept(response) == RemoteEnvelopeCheck.Accepted) {
                        "PC authentication error failed its signature or replay checks."
                    }
                    if (response.payload.optionalString("code") == "UNKNOWN_KEY") {
                        throw UnknownRemoteIdentity("Phone identity has not been approved on this PC.")
                    }
                    throw PairingRejected(response.payload.optionalString("message") ?: "The PC rejected authentication.")
                }
                verifySessionReady(response, pcPublicKey, pcKeyId, serverNonce, clientNonce)
            }

            val sessionId = readyPayload.requiredString("sessionId")
            activeSessionId = sessionId
            outgoingSequence = 0
            _connectionState.value = ConnectionState.Connected(pairing.pcIp)
            val deviceId = readyPayload.requiredString("deviceId")
            onPaired(deviceId)
            sendSessionMessage("manifest.get", buildJsonObject {})
            pingJob = launch {
                while (isActive) {
                    delay(25_000)
                    runCatching {
                        sendSessionMessage("ping", buildJsonObject {
                            put("sentAt", System.currentTimeMillis())
                            put("nonce", randomBase64Url(12))
                        })
                    }.onFailure { Log.d(tag, "Keepalive failed: " + it.message) }
                }
            }

            try {
                for (frame in incoming) {
                    if (frame !is Frame.Text) continue
                    val envelope = RemoteEnvelopeCrypto.decode(frame.readText())
                    val guard = sessionGuard ?: throw IllegalStateException("Session guard was not initialized.")
                    when (guard.verifyAndAccept(envelope)) {
                        RemoteEnvelopeCheck.Accepted -> handleSessionMessage(envelope)
                        else -> throw SecurityException("PC session message failed signature, sequence or replay validation.")
                    }
                }
            } finally {
                pingJob?.cancel()
                activeSessionId = null
                activeSocket = null
            }
        }
    }

    private var sessionGuard: RemoteEnvelopeSessionGuard? = null

    private suspend fun performPairingClaim(
        pairing: StoredPairing,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
        pcPublicKey: PublicKey,
        pcKeyId: String,
        challengeGuard: RemoteEnvelopeSessionGuard,
    ) {
        val clientNonce = randomBase64Url(32)
        val biometricAvailable = BiometricManager.from(appContext)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS
        val approvalIdentity = if (biometricAvailable) {
            runCatching { approvalKeyStore.loadOrCreate() }.getOrNull()
        } else null
        val claim = buildJsonObject {
            put("pairingId", pairing.pairingId)
            put("code", pairing.pairingCode)
            put("publicKey", identity.publicKeyBase64Url)
            put("keyId", identity.keyId)
            put("deviceHint", deviceHint())
            put("platform", "android")
            put("appVersion", "0.1.0")
            put("clientNonce", clientNonce)
            if (approvalIdentity != null) {
                put("approvalPublicKey", approvalIdentity.publicKeyBase64Url)
                put("approvalKeyId", approvalIdentity.keyId)
            }
        }
        sendPreSession("pairing.claim", claim, identity, 0)
        val challenge = receiveVerified(pcPublicKey, challengeGuard)
        if (challenge.type == "protocol.error") throw PairingRejected(challenge.payload.optionalString("message") ?: "The PC rejected the pairing claim.")
        require(challenge.type == "pairing.challenge") { "PC did not issue a pairing proof challenge." }
        val nonce = challenge.payload.requiredString("nonce")
        val challengeNonce = MessageDigest.getInstance("SHA-256")
            .digest(nonce.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val complete = buildJsonObject {
            put("pairingId", pairing.pairingId)
            put("challengeNonce", challengeNonce)
        }
        sendPreSession("pairing.complete", complete, identity, 1)
        val pending = receiveVerified(pcPublicKey, challengeGuard)
        if (pending.type == "protocol.error") throw PairingRejected(pending.payload.optionalString("message") ?: "The PC rejected the pairing proof.")
        require(pending.type == "pairing.pending" &&
            pending.payload.requiredString("state") == "awaiting_approval") {
            "PC did not place this phone into the local approval queue."
        }
        _events.emit(BridgeEvent.PairingPending(pairing.pairingId))
    }

    private suspend fun waitForPairingApproval(
        pcPublicKey: PublicKey,
        challengeGuard: RemoteEnvelopeSessionGuard,
    ): JsonObject = withTimeout(120_000) {
        while (true) {
            val response = receiveVerified(pcPublicKey, challengeGuard)
            when (response.type) {
                "pairing.approved" -> return@withTimeout response.payload
                "pairing.rejected", "pairing.expired" ->
                    throw PairingRejected("The PC declined or expired this pairing request.")
                "protocol.error" -> throw PairingRejected(response.payload.optionalString("message") ?: "Pairing failed.")
                else -> Log.d(tag, "Ignoring pre-session message " + response.type)
            }
        }
        throw IllegalStateException("Pairing did not complete.")
    }

    private suspend fun receiveSessionReady(
        pcPublicKey: PublicKey,
        pcKeyId: String,
        expectedServerNonce: String,
        expectedClientNonce: String,
    ): JsonObject {
        val envelope = receiveEnvelope()
        require(envelope.type == "session.ready" && envelope.keyId == pcKeyId) {
            "PC did not establish the authenticated session."
        }
        return verifySessionReady(envelope, pcPublicKey, pcKeyId, expectedServerNonce, expectedClientNonce)
    }

    private fun verifySessionReady(
        envelope: RemoteEnvelopeV2,
        pcPublicKey: PublicKey,
        pcKeyId: String,
        expectedServerNonce: String,
        expectedClientNonce: String,
    ): JsonObject {
        require(envelope.type == "session.ready") { "Expected session.ready from the PC." }
        val sessionId = envelope.payload.requiredString("sessionId")
        require(sessionId == envelope.sessionId) { "PC session id does not match its signed envelope." }
        val serverNonce = envelope.payload.requiredString("serverNonce")
        val clientNonce = envelope.payload.requiredString("clientNonce")
        require(serverNonce == expectedServerNonce && clientNonce == expectedClientNonce) {
            "PC session nonce echo does not match this connection's handshake."
        }
        val guard = RemoteEnvelopeSessionGuard(sessionId, pcKeyId, pcPublicKey)
        require(guard.verifyAndAccept(envelope) == RemoteEnvelopeCheck.Accepted) {
            "PC session.ready signature is invalid."
        }
        sessionGuard = guard
        return envelope.payload
    }

    private suspend fun receiveVerified(
        pcPublicKey: PublicKey,
        guard: RemoteEnvelopeSessionGuard,
    ): RemoteEnvelopeV2 {
        val envelope = receiveEnvelope()
        require(envelope.sessionId == PRE_SESSION_ID) { "PC sent a non-handshake session message." }
        require(envelope.keyId == RemoteEnvelopeCrypto.keyId(pcPublicKey.encoded)) { "PC signed with an unexpected identity." }
        require(RemoteEnvelopeCrypto.verify(envelope, pcPublicKey)) { "PC handshake signature is invalid." }
        require(guard.verifyAndAccept(envelope) == RemoteEnvelopeCheck.Accepted) {
            "PC handshake message failed freshness or replay checks."
        }
        return envelope
    }

    private suspend fun receiveEnvelope(): RemoteEnvelopeV2 {
        while (true) {
            when (val frame = incoming.receive()) {
                is Frame.Text -> return RemoteEnvelopeCrypto.decode(frame.readText())
                is Frame.Close -> throw IllegalStateException("PC closed the remote connection.")
                else -> continue
            }
        }
    }

    private suspend fun sendPreSession(
        type: String,
        payload: JsonObject,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
        sequence: Int,
    ) {
        val envelope = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(type, payload, identity.keyId, sequence = sequence),
            identity.privateKey,
            identity.publicKey,
        )
        send(Frame.Text(RemoteEnvelopeCrypto.encode(envelope)))
    }

    private suspend fun sendSessionMessage(type: String, payload: JsonObject) {
        sendMutex.withLock {
            val socket = activeSocket ?: throw IllegalStateException("Phone is not connected to a PC session.")
            val sessionId = activeSessionId ?: throw IllegalStateException("Phone session is not authenticated.")
            val identity = identityStore.loadOrCreate()
            val sequence = outgoingSequence++
            val envelope = RemoteEnvelopeCrypto.sign(
                RemoteEnvelopeSeedV2(type, payload, identity.keyId, sessionId = sessionId, sequence = sequence),
                identity.privateKey,
                identity.publicKey,
            )
            socket.send(Frame.Text(RemoteEnvelopeCrypto.encode(envelope)))
        }
    }

    private suspend fun handleSessionMessage(envelope: RemoteEnvelopeV2) {
        val payload = envelope.payload
        when (envelope.type) {
            "manifest.snapshot" -> {
                val capabilities = payload["capabilities"]?.toString()?.let { raw ->
                    runCatching {
                        val root = json.parseToJsonElement(raw)
                        (root as? kotlinx.serialization.json.JsonArray)?.mapNotNull { element ->
                            val item = element as? JsonObject ?: return@mapNotNull null
                            ToolDefinition(
                                name = item.optionalString("name") ?: return@mapNotNull null,
                                description = item.optionalString("description") ?: "",
                                tier = item.optionalString("tier") ?: "T0",
                                timeout = item["timeoutMs"]?.jsonPrimitive?.content?.toIntOrNull() ?: 30_000,
                            )
                        } ?: emptyList()
                    }.getOrDefault(emptyList())
                } ?: emptyList()
                _events.emit(BridgeEvent.ManifestReceived(capabilities))
            }
            "task.accepted" -> {
                val taskId = payload.requiredString("taskId")
                val requestId = payload.requiredString("requestId")
                synchronized(requestIds) { requestIds[taskId] = requestId }
                _events.emit(BridgeEvent.TaskAccepted(taskId))
            }
            "task.progress" -> {
                _events.emit(
                    BridgeEvent.TaskProgress(
                        payload.requiredString("taskId"),
                        payload.requiredString("state"),
                        payload.optionalString("safeSummary"),
                    )
                )
            }
            "task.result" -> {
                _events.emit(BridgeEvent.TaskResult(
                    payload.requiredString("taskId"),
                    payload["result"] ?: payload.optionalString("safeSummary").orEmpty(),
                ))
            }
            "task.confirmation_required" -> {
                val approval = payload["approval"] as? JsonObject ?: return
                _events.emit(
                    BridgeEvent.ConfirmationRequired(
                        taskId = approval.requiredString("taskId"),
                        approvalId = approval.requiredString("approvalId"),
                        summary = approval.requiredString("consequence"),
                        actionHash = approval.requiredString("actionHash"),
                        expiresAt = approval.requiredLong("expiresAt"),
                    )
                )
            }
            "task.error", "protocol.error" -> {
                _events.emit(
                    BridgeEvent.TaskError(
                        taskId = payload.optionalString("taskId"),
                        code = payload.optionalString("code") ?: "UNKNOWN",
                        message = payload.optionalString("message") ?: "PC rejected the request.",
                    )
                )
            }
            "session.close" -> {
                val reason = payload.optionalString("reason") ?: "closed"
                _events.emit(BridgeEvent.SessionClosed(reason))
                activeSessionId = null
                activeSocket?.close(CloseReason(CloseReason.Codes.NORMAL, reason))
            }
            "pong", "task.cancel_ack", "sync.snapshot", "sync.complete", "manifest.changed" -> Unit
            else -> Log.w(tag, "Unsupported authenticated message: " + envelope.type)
        }
    }

    suspend fun submitTask(
        capability: String,
        arguments: Map<String, Any?>,
        idempotencyKey: String = UUID.randomUUID().toString(),
        intent: String? = null,
    ) {
        val requestId = UUID.randomUUID().toString()
        val args = arguments.toJsonObject()
        val payload = buildJsonObject {
            put("requestId", requestId)
            put("idempotencyKey", idempotencyKey)
            put("capability", capability)
            put("canonicalArguments", args)
            if (!intent.isNullOrBlank()) put("intent", intent.take(300))
        }
        sendSessionMessage("task.submit", payload)
    }

    suspend fun cancelTask(taskId: String) {
        val requestId = synchronized(requestIds) { requestIds[taskId] }
            ?: throw IllegalArgumentException("Request correlation is not available for this task.")
        sendSessionMessage("task.cancel", buildJsonObject {
            put("taskId", taskId)
            put("requestId", requestId)
            put("reason", "Cancelled from the Android client.")
        })
    }

    /** Strong-biometric approval signs a separate action-bound proof before sending the v2 response. */
    suspend fun approveTaskWithBiometric(
        activity: FragmentActivity,
        taskId: String,
        approvalId: String,
        actionHash: String,
        consequence: String,
    ) {
        val approvedAt = System.currentTimeMillis()
        val binding = RemoteApprovalBinding(
            approvalId = approvalId,
            taskId = taskId,
            actionHash = actionHash,
            approvedAt = approvedAt,
        )
        val (approvalIdentity, signature) = approvalKeyStore.signWithStrongBiometricSuspend(
            activity = activity,
            binding = binding,
            promptSubtitle = consequence,
        )
        sendSessionMessage("task.confirmation_response", buildJsonObject {
            put("approvalId", approvalId)
            put("taskId", taskId)
            put("actionHash", actionHash)
            put("decision", "approved")
            put("approvedAt", approvedAt)
            put("method", "biometric_strong")
            put("biometricProof", buildJsonObject {
                put("approvalKeyId", approvalIdentity.keyId)
                put("signature", signature)
            })
        })
    }

    suspend fun sendDenial(taskId: String, approvalId: String, actionHash: String) {
        sendSessionMessage("task.confirmation_response", buildJsonObject {
            put("approvalId", approvalId)
            put("taskId", taskId)
            put("actionHash", actionHash)
            put("decision", "denied")
            put("approvedAt", System.currentTimeMillis())
            put("method", "user_denied")
        })
    }

    suspend fun disconnect() {
        manualDisconnect = true
        pingJob?.cancel()
        activeSocket?.close(CloseReason(CloseReason.Codes.NORMAL, "User disconnected"))
        activeSocket = null
        activeSessionId = null
        _connectionState.value = ConnectionState.Disconnected
    }

    private fun decodePcKey(base64Url: String): PublicKey {
        val bytes = Base64.getUrlDecoder().decode(base64Url)
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(bytes))
        require(RemoteEnvelopeCrypto.isP256(key)) { "QR code PC identity is not P-256." }
        return key
    }

    private fun deviceHint(): String {
        val safe = "android_" + Build.MODEL.lowercase().replace(Regex("[^a-z0-9_-]"), "_").take(48)
        return safe.padEnd(8, '_')
    }

    private fun randomBase64Url(size: Int): String {
        val bytes = ByteArray(size).also { java.security.SecureRandom().nextBytes(it) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun Map<String, Any?>.toJsonObject(): JsonObject = buildJsonObject {
        for ((key, value) in this@toJsonObject) put(key, value.toRemoteJsonElement())
    }

    private fun Any?.toRemoteJsonElement(): JsonElement = when (this) {
        null -> kotlinx.serialization.json.JsonNull
        is String -> kotlinx.serialization.json.JsonPrimitive(this)
        is Boolean -> kotlinx.serialization.json.JsonPrimitive(this)
        is Number -> kotlinx.serialization.json.JsonPrimitive(this)
        is JsonElement -> this
        is Map<*, *> -> buildJsonObject {
            for ((key, value) in this@toRemoteJsonElement) {
                require(key is String) { "Task argument object keys must be strings." }
                put(key, value.toRemoteJsonElement())
            }
        }
        is Iterable<*> -> kotlinx.serialization.json.JsonArray(map { it.toRemoteJsonElement() })
        else -> throw IllegalArgumentException("Unsupported task argument type: " + this::class.java.simpleName)
    }

    private fun JsonObject.requiredString(key: String): String =
        this[key]?.jsonPrimitive?.content
            ?: throw IllegalArgumentException("Remote message is missing '$key'.")

    private fun JsonObject.optionalString(key: String): String? =
        this[key]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }

    private fun JsonObject.requiredLong(key: String): Long =
        this[key]?.jsonPrimitive?.content?.toLongOrNull()
            ?: throw IllegalArgumentException("Remote message is missing numeric '$key'.")

    companion object {
        private const val TAG = "VanessaRemoteV2"
    }
}
