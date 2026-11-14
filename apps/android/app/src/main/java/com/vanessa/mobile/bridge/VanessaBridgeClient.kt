package com.vanessa.mobile.bridge

import android.os.Build
import android.util.Log
import com.vanessa.mobile.BuildConfig
import com.vanessa.mobile.di.StoredPairing
import com.vanessa.mobile.identity.AndroidBiometricApprovalKeyStore
import com.vanessa.mobile.identity.AndroidBiometricApprovalManager
import com.vanessa.mobile.identity.BiometricApprovalProof
import com.vanessa.mobile.identity.AndroidRemoteIdentityStore
import com.vanessa.protocol.v2.PRE_SESSION_ID
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import com.vanessa.protocol.v2.RemoteEnvelopeSeedV2
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.json.JSONObject
import java.net.URI
import java.security.PublicKey
import java.security.SecureRandom
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import androidx.fragment.app.FragmentActivity
import javax.inject.Inject
import javax.inject.Singleton

sealed class ConnectionState {
    object Disconnected : ConnectionState()
    object Connecting : ConnectionState()
    data class Connected(val pcIP: String) : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

sealed class BridgeEvent {
    data class PairingPending(val pairingId: String) : BridgeEvent()
    data class SessionReady(val deviceId: String, val grantedScopes: List<String>) : BridgeEvent()
    data class ManifestReceived(val tools: List<ToolDefinition>) : BridgeEvent()
    data class TaskAccepted(val taskId: String, val requestId: String) : BridgeEvent()
    data class TaskProgress(val taskId: String, val state: String, val message: String?) : BridgeEvent()
    data class TaskResult(val taskId: String, val status: String, val summary: String, val result: String?) : BridgeEvent()
    data class TaskError(val taskId: String?, val code: String, val message: String) : BridgeEvent()
    data class ConfirmationRequired(val approval: JsonObject) : BridgeEvent()
}

data class ToolDefinition(
    val name: String,
    val description: String,
    val tier: String,
    val timeout: Int,
)

@Singleton
class VanessaBridgeClient @Inject constructor() {
    private val tag = "VanessaBridgeV2"
    private val json = Json { ignoreUnknownKeys = false }
    private val client = HttpClient(Android) {
        install(WebSockets) {
            pingInterval = 25_000
            maxFrameSize = 64L * 1024L
        }
    }
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val identityStore = AndroidRemoteIdentityStore()
    private val approvalKeyStore = AndroidBiometricApprovalKeyStore()
    private val approvalManager = AndroidBiometricApprovalManager(approvalKeyStore)
    private val random = SecureRandom()
    private val connectionMutex = Mutex()
    private var socket: DefaultClientWebSocketSession? = null
    private var reconnectJob: Job? = null
    private var rememberedPairing: StoredPairing? = null
    private var manualDisconnect = false
    private var outboundSequence = 1
    private var inboundSequence = 1
    private var readySessionId = PRE_SESSION_ID
    private val seenMessageIds = LinkedHashSet<String>()

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState = _connectionState.asStateFlow()
    private val _events = MutableSharedFlow<BridgeEvent>(extraBufferCapacity = 64)
    val events = _events.asSharedFlow()

    /**
     * Connect with the v2 QR payload. New devices complete a signed,
     * challenge-response pairing and wait for approval in the PC UI. Previously
     * approved devices authenticate with their pinned Android Keystore key.
     */
    suspend fun connect(pairing: StoredPairing) {
        validateEndpoint(pairing.endpoint)
        if (_connectionState.value is ConnectionState.Connected ||
            _connectionState.value is ConnectionState.Connecting) return
        rememberedPairing = pairing
        manualDisconnect = false
        reconnectJob?.cancel()
        connectInternal(pairing)
    }

    private fun validateEndpoint(value: String) {
        val endpoint = URI(value)
        require(endpoint.scheme == "wss" && !endpoint.host.isNullOrBlank() &&
            endpoint.path == "/remote/v2" && endpoint.userInfo == null &&
            endpoint.query == null && endpoint.fragment == null) {
            "Remote access requires the PC's pinned WSS endpoint from its Vanessa pairing QR."
        }
    }

    private suspend fun connectInternal(pairing: StoredPairing) {
        connectionMutex.withLock {
            _connectionState.value = ConnectionState.Connecting
            try {
                val identity = identityStore.loadOrCreate()
                val pcPublicKey = KeyFactory.getInstance("EC").generatePublic(
                    X509EncodedKeySpec(Base64.getUrlDecoder().decode(pairing.pcPublicKey))
                )
                require(RemoteEnvelopeCrypto.isP256(pcPublicKey)) { "The PC identity is not a P-256 key." }
                require(RemoteEnvelopeCrypto.keyId(pcPublicKey.encoded) == pairing.pcKeyId) {
                    "The QR code's PC key fingerprint does not match its public key."
                }

                client.webSocket(urlString = pairing.endpoint) {
                    socket = this
                    val connectedDevice = if (pairing.deviceId.isNullOrBlank()) {
                        performPairing(this, pairing, identity, pcPublicKey)
                    } else {
                        performReturningAuthentication(this, pairing, identity, pcPublicKey)
                    }
                    rememberedPairing = pairing.copy(
                        deviceId = connectedDevice.first,
                        pairingId = "",
                        pairingCode = "",
                    )
                    _events.emit(BridgeEvent.SessionReady(connectedDevice.first, connectedDevice.second))
                    _connectionState.value = ConnectionState.Connected(pairing.endpoint)

                    sendEnvelope(this, "sync.resume", buildJsonObject {
                        put("lastEventSeq", 0)
                        put("activeTaskIds", JsonArray(emptyList()))
                        put("clientNonce", randomNonce())
                    }, readySessionId, outboundSequence++, identity)
                    sendEnvelope(
                        this,
                        "manifest.get",
                        buildJsonObject {},
                        readySessionId,
                        outboundSequence++,
                        identity,
                    )

                    for (frame in incoming) {
                        if (frame !is Frame.Text) continue
                        val envelope = RemoteEnvelopeCrypto.decode(frame.readText())
                        verifyServerEnvelope(envelope, pcPublicKey)
                        when (envelope.type) {
                            "manifest.snapshot" -> {
                                val capabilities = envelope.payload["capabilities"] as? JsonArray ?: JsonArray(emptyList())
                                val tools = capabilities.mapNotNull { element ->
                                    val item = element as? JsonObject ?: return@mapNotNull null
                                    ToolDefinition(
                                        name = item["name"]?.toString()?.trim('"') ?: return@mapNotNull null,
                                        description = item["description"]?.toString()?.trim('"') ?: "",
                                        tier = item["tier"]?.toString()?.trim('"') ?: "T0",
                                        timeout = item["timeoutMs"]?.toString()?.toIntOrNull() ?: 30_000,
                                    )
                                }
                                _events.emit(BridgeEvent.ManifestReceived(tools))
                            }
                            "task.accepted" -> _events.emit(BridgeEvent.TaskAccepted(
                                envelope.payload["taskId"]?.toString()?.trim('"') ?: "",
                                envelope.payload["requestId"]?.toString()?.trim('"') ?: "",
                            ))
                            "task.progress" -> _events.emit(BridgeEvent.TaskProgress(
                                envelope.payload["taskId"]?.toString()?.trim('"') ?: "",
                                envelope.payload["state"]?.toString()?.trim('"') ?: "unknown",
                                envelope.payload["safeSummary"]?.toString()?.trim('"'),
                            ))
                            "task.result" -> _events.emit(BridgeEvent.TaskResult(
                                envelope.payload["taskId"]?.toString()?.trim('"') ?: "",
                                envelope.payload["status"]?.toString()?.trim('"') ?: "unknown",
                                envelope.payload["safeSummary"]?.toString()?.trim('"') ?: "Task finished.",
                                envelope.payload["result"]?.toString(),
                            ))
                            "task.confirmation_required" -> {
                                val approval = envelope.payload["approval"] as? JsonObject
                                if (approval != null) _events.emit(BridgeEvent.ConfirmationRequired(approval))
                            }
                            "sync.snapshot" -> {
                                val tasks = envelope.payload["tasks"] as? JsonArray ?: JsonArray(emptyList())
                                val historyGap = envelope.payload["historyGap"]?.toString() == "true"
                                for (element in tasks) {
                                    val task = element as? JsonObject ?: continue
                                    val taskId = task["taskId"]?.toString()?.trim('"') ?: continue
                                    val state = task["state"]?.toString()?.trim('"') ?: "unknown"
                                    val summary = task["safeSummary"]?.toString()?.trim('"')
                                    _events.emit(BridgeEvent.TaskProgress(
                                        taskId,
                                        state,
                                        (if (historyGap) "Restored from PC task ledger. " else "") + (summary ?: "Recovered task state."),
                                    ))
                                }
                            }
                            "sync.complete" -> Unit
                            "task.error", "protocol.error" -> _events.emit(BridgeEvent.TaskError(
                                envelope.payload["taskId"]?.toString()?.trim('"'),
                                envelope.payload["code"]?.toString()?.trim('"') ?: "REMOTE_ERROR",
                                envelope.payload["message"]?.toString()?.trim('"') ?: "The PC rejected the request.",
                            ))
                            "session.close" -> {
                                val reason = envelope.payload["reason"]?.toString()?.trim('"') ?: "closed"
                                _connectionState.value = ConnectionState.Error("PC closed the remote session: " + reason)
                                break
                            }
                            "pong", "session.expiring" -> Unit
                            else -> Log.w(tag, "Ignored unsupported server message " + envelope.type)
                        }
                    }
                    socket = null
                    if (!manualDisconnect) {
                        _connectionState.value = ConnectionState.Disconnected
                        if (!rememberedPairing?.deviceId.isNullOrBlank()) scheduleReconnect()
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                Log.w(tag, "v2 connection failed", error)
                socket = null
                _connectionState.value = ConnectionState.Error(error.message ?: "Secure connection failed.")
                if (!manualDisconnect && !rememberedPairing?.deviceId.isNullOrBlank()) scheduleReconnect()
            }
        }
    }

    private suspend fun performPairing(
        session: DefaultClientWebSocketSession,
        pairing: StoredPairing,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
        pcPublicKey: PublicKey,
    ): Pair<String, List<String>> = withTimeout(125_000) {
        resetCounters()
        val challenge = receiveServerEnvelope(session, pcPublicKey, PRE_SESSION_ID, 0)
        require(challenge.type == "server.challenge") { "The PC did not issue a signed handshake challenge." }
        val serverNonce = challenge.payload["serverNonce"]?.toString()?.trim('"')
            ?: error("The PC did not provide a handshake nonce.")
        require(challenge.payload["pairingRequired"]?.toString() == "true")

        val clientNonce = randomNonce()
        // Read-only remote pairing remains available when this handset does
        // not have a hardware-backed strong-biometric key. In that case the PC
        // must not grant destructive capabilities to this device.
        val approvalIdentity = runCatching { approvalKeyStore.loadOrCreate() }.getOrNull()
        sendEnvelope(session, "pairing.claim", buildJsonObject {
            put("pairingId", pairing.pairingId)
            put("code", pairing.pairingCode)
            put("publicKey", identity.publicKeyBase64Url)
            put("keyId", identity.keyId)
            if (approvalIdentity != null) put("approvalPublicKey", approvalIdentity.publicKeyBase64Url)
            put("deviceHint", deviceHint())
            put("platform", "android")
            put("appVersion", BuildConfig.VERSION_NAME)
            put("clientNonce", clientNonce)
        }, PRE_SESSION_ID, 0, identity)

        val pairingChallenge = receiveServerEnvelope(session, pcPublicKey, PRE_SESSION_ID, 1)
        require(pairingChallenge.type == "pairing.challenge") { "The PC rejected the pairing claim." }
        val challengeNonce = pairingChallenge.payload["nonce"]?.toString()?.trim('"')
            ?: error("The PC did not send a pairing proof challenge.")
        sendEnvelope(session, "pairing.complete", buildJsonObject {
            put("pairingId", pairing.pairingId)
            put("challengeNonce", challengeNonce)
        }, PRE_SESSION_ID, 1, identity)

        val pending = receiveServerEnvelope(session, pcPublicKey, PRE_SESSION_ID, 2)
        require(pending.type == "pairing.pending") { "The PC did not accept the pairing proof." }
        _events.emit(BridgeEvent.PairingPending(pairing.pairingId))

        val approval = receiveServerEnvelope(session, pcPublicKey, PRE_SESSION_ID, 3)
        if (approval.type == "pairing.rejected") error("Pairing was declined on the PC.")
        require(approval.type == "pairing.approved") { "The phone did not receive local PC approval." }
        require(approval.payload["serverNonce"]?.toString()?.trim('"') == challengeNonce)
        require(approval.payload["clientNonce"]?.toString()?.trim('"') == clientNonce)

        val deviceId = approval.payload["deviceId"]?.toString()?.trim('"')
            ?: error("The PC did not return a trusted device identity.")
        val scopes = (approval.payload["grantedScopes"] as? JsonArray)
            ?.map { it.toString().trim('"') } ?: emptyList()

        sendAuthentication(session, identity, challengeNonce, clientNonce, 2)
        completeSession(session, pcPublicKey, deviceId)
    }

    private suspend fun performReturningAuthentication(
        session: DefaultClientWebSocketSession,
        pairing: StoredPairing,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
        pcPublicKey: PublicKey,
    ): Pair<String, List<String>> {
        resetCounters()
        val challenge = receiveServerEnvelope(session, pcPublicKey, PRE_SESSION_ID, 0)
        require(challenge.type == "server.challenge") { "The PC did not issue a signed session challenge." }
        val serverNonce = challenge.payload["serverNonce"]?.toString()?.trim('"')
            ?: error("The PC did not provide a session nonce.")
        sendAuthentication(session, identity, serverNonce, randomNonce(), 0)
        return completeSession(session, pcPublicKey, pairing.deviceId ?: "")
    }

    private suspend fun sendAuthentication(
        session: DefaultClientWebSocketSession,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
        serverNonce: String,
        clientNonce: String,
        sequence: Int,
    ) {
        sendEnvelope(session, "client.authenticate", buildJsonObject {
            put("serverNonce", serverNonce)
            put("clientNonce", clientNonce)
            put("publicKey", identity.publicKeyBase64Url)
            put("deviceHint", deviceHint())
            put("platform", "android")
            put("appVersion", BuildConfig.VERSION_NAME)
        }, PRE_SESSION_ID, sequence, identity)
    }

    private suspend fun completeSession(
        session: DefaultClientWebSocketSession,
        pcPublicKey: PublicKey,
        expectedDeviceId: String,
    ): Pair<String, List<String>> {
        val ready = receiveServerEnvelope(session, pcPublicKey, null, 0)
        require(ready.type == "session.ready") { "The PC did not establish the authenticated session." }
        val sessionId = ready.payload["sessionId"]?.toString()?.trim('"')
            ?: error("The PC did not return a session identifier.")
        require(ready.sessionId == sessionId) { "Session identifier did not match the signed envelope." }
        val deviceId = ready.payload["deviceId"]?.toString()?.trim('"')
            ?: error("The PC did not return a device identity.")
        if (expectedDeviceId.isNotBlank()) require(deviceId == expectedDeviceId) {
            "The PC returned a different paired device identity."
        }
        val scopes = (ready.payload["grantedScopes"] as? JsonArray)
            ?.map { it.toString().trim('"') } ?: emptyList()
        readySessionId = sessionId
        outboundSequence = 1
        inboundSequence = 1
        seenMessageIds.clear()
        return deviceId to scopes
    }

    private suspend fun receiveServerEnvelope(
        session: DefaultClientWebSocketSession,
        pcPublicKey: PublicKey,
        expectedSessionId: String?,
        expectedSequence: Int,
    ): com.vanessa.protocol.v2.RemoteEnvelopeV2 {
        val frame = withTimeout(125_000) { session.incoming.receive() }
        require(frame is Frame.Text) { "The PC sent a non-text protocol frame." }
        val envelope = RemoteEnvelopeCrypto.decode(frame.readText())
        require(RemoteEnvelopeCrypto.verify(envelope, pcPublicKey)) { "The PC signature is invalid." }
        require(envelope.keyId == RemoteEnvelopeCrypto.keyId(pcPublicKey.encoded)) { "Unexpected PC signing key." }
        if (expectedSessionId != null) require(envelope.sessionId == expectedSessionId)
        require(envelope.sequence == expectedSequence) { "The PC message sequence is out of order." }
        require(kotlin.math.abs(System.currentTimeMillis() - envelope.sentAt) <= 90_000L) {
            "The PC handshake message is stale or too far in the future."
        }
        require(seenMessageIds.add(envelope.messageId)) { "The PC replayed a message." }
        return envelope
    }

    private fun verifyServerEnvelope(
        envelope: com.vanessa.protocol.v2.RemoteEnvelopeV2,
        pcPublicKey: PublicKey,
    ) {
        require(RemoteEnvelopeCrypto.verify(envelope, pcPublicKey)) { "The PC sent an invalid ES256 signature." }
        require(envelope.sessionId == readySessionId) { "The message belongs to another session." }
        require(envelope.sequence == inboundSequence) { "The PC message sequence is out of order." }
        require(kotlin.math.abs(System.currentTimeMillis() - envelope.sentAt) <= 60_000L) {
            "The PC message is stale."
        }
        require(seenMessageIds.add(envelope.messageId)) { "The PC replayed a message." }
        inboundSequence += 1
    }

    private suspend fun sendEnvelope(
        session: DefaultClientWebSocketSession,
        type: String,
        payload: JsonObject,
        sessionId: String,
        sequence: Int,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
    ) {
        val signed = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(type, payload, identity.keyId, sessionId, sequence = sequence),
            identity.privateKey,
            identity.publicKey,
        )
        session.send(Frame.Text(RemoteEnvelopeCrypto.encode(signed)))
    }

    /** Strong-biometric approval. A missing proof never sends an approval message. */
    suspend fun approveTask(activity: FragmentActivity, approval: JsonObject): Boolean {
        val approvalId = approval["approvalId"]?.toString()?.trim('"') ?: return false
        val taskId = approval["taskId"]?.toString()?.trim('"') ?: return false
        val actionHash = approval["actionHash"]?.toString()?.trim('"') ?: return false
        val expiresAt = approval["expiresAt"]?.toString()?.toLongOrNull() ?: return false
        if (expiresAt <= System.currentTimeMillis()) return false
        val consequence = approval["consequence"]?.toString()?.trim('"') ?: "Approve PC action"
        val proof = approvalManager.authorize(activity, approvalId, taskId, actionHash, consequence) ?: return false
        return sendApprovalResponse(
            approvalId = approvalId,
            taskId = taskId,
            actionHash = actionHash,
            decision = "approved",
            approvedAt = proof.approvedAt,
            proof = proof,
        )
    }

    /** Denial is safe and does not need a biometric signature. */
    suspend fun denyTask(approval: JsonObject): Boolean {
        val approvalId = approval["approvalId"]?.toString()?.trim('"') ?: return false
        val taskId = approval["taskId"]?.toString()?.trim('"') ?: return false
        val actionHash = approval["actionHash"]?.toString()?.trim('"') ?: return false
        return sendApprovalResponse(
            approvalId = approvalId,
            taskId = taskId,
            actionHash = actionHash,
            decision = "denied",
            approvedAt = System.currentTimeMillis(),
            proof = null,
        )
    }

    private suspend fun sendApprovalResponse(
        approvalId: String,
        taskId: String,
        actionHash: String,
        decision: String,
        approvedAt: Long,
        proof: BiometricApprovalProof?,
    ): Boolean {
        val active = socket ?: return false
        val identity = identityStore.loadOrCreate()
        val method = if (decision == "approved") "biometric_strong" else "device_session"
        val payload = buildJsonObject {
            put("approvalId", approvalId)
            put("taskId", taskId)
            put("actionHash", actionHash)
            put("decision", decision)
            put("approvedAt", approvedAt)
            put("method", method)
            if (proof != null) {
                put("approvalProof", buildJsonObject {
                    put("keyId", proof.keyId)
                    put("signature", proof.signature)
                })
            }
        }
        sendEnvelope(active, "task.confirmation_response", payload, readySessionId, outboundSequence++, identity)
        return true
    }

    suspend fun submitTask(
        capability: String,
        arguments: Map<String, Any?>,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ) {
        val active = socket ?: error("The phone is not connected to Vanessa.")
        val identity = identityStore.loadOrCreate()
        val requestId = UUID.randomUUID().toString()
        val argumentsJson = json.parseToJsonElement(JSONObject(arguments).toString()) as? JsonObject
            ?: error("Task arguments must be a JSON object.")
        sendEnvelope(active, "task.submit", buildJsonObject {
            put("requestId", requestId)
            put("idempotencyKey", idempotencyKey)
            put("capability", capability)
            put("canonicalArguments", argumentsJson)
        }, readySessionId, outboundSequence++, identity)
    }

    suspend fun cancelTask(taskId: String, requestId: String) {
        val active = socket ?: error("The phone is not connected to Vanessa.")
        val identity = identityStore.loadOrCreate()
        sendEnvelope(active, "task.cancel", buildJsonObject {
            put("taskId", taskId)
            put("requestId", requestId)
        }, readySessionId, outboundSequence++, identity)
    }

    suspend fun disconnect() {
        manualDisconnect = true
        reconnectJob?.cancel()
        socket?.close(CloseReason(CloseReason.Codes.NORMAL, "Phone disconnected"))
        socket = null
        rememberedPairing = null
        _connectionState.value = ConnectionState.Disconnected
    }

    fun close() {
        manualDisconnect = true
        reconnectJob?.cancel()
        scope.cancel()
        client.close()
    }

    private fun scheduleReconnect() {
        val pairing = rememberedPairing ?: return
        if (manualDisconnect || reconnectJob?.isActive == true || pairing.deviceId.isNullOrBlank()) return
        reconnectJob = scope.launch {
            var attempt = 0
            while (isActive && !manualDisconnect && attempt < 8) {
                delay(minOf(1_000L shl attempt.coerceAtMost(5), 30_000L))
                attempt += 1
                connectInternal(pairing)
                if (_connectionState.value is ConnectionState.Connected) return@launch
            }
            if (!manualDisconnect && _connectionState.value !is ConnectionState.Connected) {
                _connectionState.value = ConnectionState.Error("Could not reconnect. Check the PC and Tailscale connection.")
            }
        }
    }

    private fun resetCounters() {
        outboundSequence = 0
        inboundSequence = 0
        readySessionId = PRE_SESSION_ID
        seenMessageIds.clear()
    }

    private fun randomNonce(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun deviceHint(): String =
        (Build.MANUFACTURER + "_" + Build.MODEL)
            .replace(Regex("[^A-Za-z0-9_-]"), "_")
            .take(64)
            .padEnd(8, '_')
}
