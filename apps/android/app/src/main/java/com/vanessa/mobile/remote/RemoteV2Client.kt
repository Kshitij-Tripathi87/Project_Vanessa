package com.vanessa.mobile.remote

import android.os.Build
import com.vanessa.mobile.identity.AndroidBiometricApprovalKeyStore
import com.vanessa.mobile.identity.AndroidRemoteIdentityStore
import com.vanessa.mobile.pairing.RemoteV2PairingConfiguration
import com.vanessa.protocol.v2.PRE_SESSION_ID
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import com.vanessa.protocol.v2.RemoteEnvelopeSeedV2
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.KeyFactory
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

class RemoteV2Client {
    private val client = HttpClient(Android) {
        install(WebSockets) {
            pingIntervalMillis = 20_000L
        }
    }

    suspend fun pair(
        configuration: RemoteV2PairingConfiguration,
        identityStore: AndroidRemoteIdentityStore = AndroidRemoteIdentityStore(),
        approvalKeyStore: AndroidBiometricApprovalKeyStore = AndroidBiometricApprovalKeyStore(),
    ): RemoteV2LiveSession {
        val identity = identityStore.loadOrCreate()
        val approvalIdentity = approvalKeyStore.loadOrCreate()
        val pcPublicKey = decodePcPublicKey(configuration.pcPublicKeySpki)
        val socket = client.webSocketSession(urlString = configuration.wsUrl)
        try {
            var serverSequence = -1
            val challenge = receiveVerified(socket, pcPublicKey, configuration.pcKeyId, PRE_SESSION_ID)
            serverSequence = acceptServerSequence(challenge, serverSequence)
            require(challenge.type == "server.challenge") { "PC did not send a v2 server challenge." }
            val serverNonce = challenge.payload["serverNonce"]?.jsonPrimitive?.content
                ?: error("PC challenge is missing its nonce.")
            require(challenge.payload["pcId"]?.jsonPrimitive?.content == configuration.pcKeyId) {
                "The signed PC identity does not match the pairing QR."
            }
            val expiresAt = challenge.payload["expiresAt"]?.jsonPrimitive?.content?.toLongOrNull()
                ?: error("PC challenge expiry is missing.")
            require(expiresAt > System.currentTimeMillis()) { "The PC handshake challenge expired." }

            val clientNonce = randomNonce()
            val claimPayload = buildJsonObject {
                put("pairingId", configuration.pairingId)
                put("code", configuration.code)
                put("publicKey", identity.publicKeyBase64Url)
                put("approvalPublicKey", approvalIdentity.publicKeySpkiBase64Url)
                put("keyId", identity.keyId)
                put("deviceHint", deviceHint())
                put("platform", "android")
                put("appVersion", "0.1.0")
                put("clientNonce", clientNonce)
            }
            sendSigned(socket, identity, "pairing.claim", claimPayload, PRE_SESSION_ID, 0)

            val pairingChallenge = receiveVerified(socket, pcPublicKey, configuration.pcKeyId, PRE_SESSION_ID)
            serverSequence = acceptServerSequence(pairingChallenge, serverSequence)
            require(pairingChallenge.type == "pairing.challenge") { "PC rejected the pairing claim." }
            val challengeNonce = pairingChallenge.payload["nonce"]?.jsonPrimitive?.content
                ?: error("Pairing response did not include a challenge nonce.")
            require(pairingChallenge.payload["clientNonce"]?.jsonPrimitive?.content == clientNonce)

            val completion = buildJsonObject {
                put("pairingId", configuration.pairingId)
                put("challengeNonce", challengeNonce)
            }
            sendSigned(socket, identity, "pairing.complete", completion, PRE_SESSION_ID, 1)

            val pending = receiveVerified(socket, pcPublicKey, configuration.pcKeyId, PRE_SESSION_ID)
            serverSequence = acceptServerSequence(pending, serverSequence)
            require(pending.type == "pairing.pending") { "PC did not accept the pairing proof." }

            // Pairing remains pending until the Windows user approves it locally.
            val approved = withTimeout(5 * 60_000L) {
                receiveVerified(socket, pcPublicKey, configuration.pcKeyId, PRE_SESSION_ID)
            }
            serverSequence = acceptServerSequence(approved, serverSequence)
            require(approved.type == "pairing.approved") {
                "Pairing was not approved on the PC: " + approved.type
            }
            val deviceId = approved.payload["deviceId"]?.jsonPrimitive?.content
                ?: error("PC approval omitted the device identity.")
            require(approved.payload["keyId"]?.jsonPrimitive?.content == identity.keyId)
            require(approved.payload["serverNonce"]?.jsonPrimitive?.content == challengeNonce)
            require(approved.payload["clientNonce"]?.jsonPrimitive?.content == clientNonce)

            val ready = receiveVerified(socket, pcPublicKey, configuration.pcKeyId, null)
            require(ready.type == "session.ready") { "PC did not establish an authenticated session." }
            val sessionId = ready.payload["sessionId"]?.jsonPrimitive?.content
                ?: error("PC session response omitted the session id.")
            require(ready.sessionId == sessionId)
            require(ready.payload["deviceId"]?.jsonPrimitive?.content == deviceId)
            require(ready.payload["serverNonce"]?.jsonPrimitive?.content == challengeNonce)
            require(ready.payload["clientNonce"]?.jsonPrimitive?.content == clientNonce)
            val grantedScopes = ready.payload["grantedScopes"]?.toString() ?: "[]"
            return RemoteV2LiveSession(
                socket, client, identity, configuration.pcKeyId, pcPublicKey,
                sessionId, deviceId, grantedScopes,
            )
        } catch (error: Exception) {
            socket.close()
            client.close()
            throw error
        }
    }

    suspend fun reconnect(
        configuration: RemoteV2PairingConfiguration,
        identityStore: AndroidRemoteIdentityStore = AndroidRemoteIdentityStore(),
    ): RemoteV2LiveSession {
        val identity = identityStore.loadOrCreate()
        val pcPublicKey = decodePcPublicKey(configuration.pcPublicKeySpki)
        val socket = client.webSocketSession(urlString = configuration.wsUrl)
        try {
            val challenge = receiveVerified(socket, pcPublicKey, configuration.pcKeyId, PRE_SESSION_ID)
            require(challenge.type == "server.challenge")
            val serverNonce = challenge.payload["serverNonce"]?.jsonPrimitive?.content
                ?: error("PC challenge is missing its nonce.")
            val clientNonce = randomNonce()
            val payload = buildJsonObject {
                put("serverNonce", serverNonce)
                put("clientNonce", clientNonce)
                put("publicKey", identity.publicKeyBase64Url)
                put("platform", "android")
                put("appVersion", "0.1.0")
            }
            sendSigned(socket, identity, "client.authenticate", payload, PRE_SESSION_ID, 0)
            val ready = receiveVerified(socket, pcPublicKey, configuration.pcKeyId, null)
            require(ready.type == "session.ready")
            val sessionId = ready.payload["sessionId"]?.jsonPrimitive?.content
                ?: error("PC session response omitted its session id.")
            require(ready.sessionId == sessionId)
            return RemoteV2LiveSession(
                socket, client, identity, configuration.pcKeyId, pcPublicKey, sessionId,
                ready.payload["deviceId"]?.jsonPrimitive?.content ?: error("Device ID missing."),
                ready.payload["grantedScopes"]?.toString() ?: "[]",
            )
        } catch (error: Exception) {
            socket.close()
            client.close()
            throw error
        }
    }

    private suspend fun receiveVerified(
        socket: DefaultClientWebSocketSession,
        pcKey: PublicKey,
        pcKeyId: String,
        expectedSessionId: String?,
    ): com.vanessa.protocol.v2.RemoteEnvelopeV2 = withTimeout(15_000L) {
        while (true) {
            when (val frame = socket.incoming.receive()) {
                is Frame.Text -> {
                    val envelope = RemoteEnvelopeCrypto.decode(frame.readText())
                    require(envelope.keyId == pcKeyId) { "A message arrived from an unexpected PC identity." }
                    require(RemoteEnvelopeCrypto.verify(envelope, pcKey)) { "The PC message signature is invalid." }
                    if (expectedSessionId != null) require(envelope.sessionId == expectedSessionId)
                    return@withTimeout envelope
                }
                is Frame.Close -> error("The PC closed the remote connection.")
                else -> Unit
            }
        }
        error("No signed PC envelope received.")
    }

    private suspend fun sendSigned(
        socket: DefaultClientWebSocketSession,
        identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
        type: String,
        payload: JsonObject,
        sessionId: String,
        sequence: Int,
    ) {
        val envelope = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(type, payload, identity.keyId, sessionId, sequence = sequence),
            identity.privateKey,
            identity.publicKey,
        )
        socket.send(Frame.Text(RemoteEnvelopeCrypto.encode(envelope)))
    }

    private fun decodePcPublicKey(encoded: String): PublicKey {
        val der = Base64.getUrlDecoder().decode(encoded)
        return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
    }

    private fun acceptServerSequence(
        envelope: com.vanessa.protocol.v2.RemoteEnvelopeV2,
        previous: Int,
    ): Int {
        require(envelope.sequence > previous) { "PC message sequence is not strictly increasing." }
        return envelope.sequence
    }

    private fun randomNonce(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(UUID.randomUUID().toString().toByteArray())

    private fun deviceHint(): String {
        val safeModel = Build.MODEL.orEmpty().filter { it.isLetterOrDigit() || it == '-' || it == '_' }
            .take(48).ifBlank { "AndroidPhone" }
        return "android-" + safeModel.take(56)
    }
}

/** Long-lived authenticated session; all application messages remain signed and ordered. */
class RemoteV2LiveSession internal constructor(
    private val socket: DefaultClientWebSocketSession,
    private val httpClient: HttpClient,
    private val identity: com.vanessa.mobile.identity.AndroidRemoteIdentity,
    private val pcKeyId: String,
    private val pcPublicKey: PublicKey,
    val sessionId: String,
    val deviceId: String,
    val grantedScopesJson: String,
) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sendMutex = Mutex()
    private val inbound = Channel<com.vanessa.protocol.v2.RemoteEnvelopeV2>(Channel.BUFFERED)
    private var clientSequence = 0
    private var serverSequence = 0
    val events = inbound.receiveAsFlow()

    init {
        scope.launch {
            try {
                while (true) {
                    val frame = socket.incoming.receive()
                    if (frame !is Frame.Text) {
                        if (frame is Frame.Close) break
                        continue
                    }
                    val envelope = RemoteEnvelopeCrypto.decode(frame.readText())
                    require(envelope.keyId == pcKeyId && envelope.sessionId == sessionId)
                    require(RemoteEnvelopeCrypto.verify(envelope, pcPublicKey))
                    require(envelope.sequence > serverSequence) { "PC session message replay or sequence rollback." }
                    serverSequence = envelope.sequence
                    inbound.send(envelope)
                }
                inbound.close()
            } catch (error: Exception) {
                inbound.close(error)
            }
        }
    }

    suspend fun requestManifest() = send("manifest.get", buildJsonObject {})

    suspend fun submitTask(capability: String, arguments: JsonObject, intent: String? = null): String {
        val requestId = UUID.randomUUID().toString()
        val payload = buildJsonObject {
            put("requestId", requestId)
            put("idempotencyKey", UUID.randomUUID().toString())
            put("capability", capability)
            put("canonicalArguments", arguments)
            if (intent != null) put("intent", intent)
        }
        send("task.submit", payload)
        return requestId
    }

    suspend fun cancelTask(taskId: String, requestId: String) {
        send("task.cancel", buildJsonObject {
            put("taskId", taskId)
            put("requestId", requestId)
            put("reason", "Cancelled from Android.")
        })
    }

    suspend fun sendApprovalResponse(payload: JsonObject) = send("task.confirmation_response", payload)

    private suspend fun send(type: String, payload: JsonObject) {
        sendMutex.withLock {
            val envelope = RemoteEnvelopeCrypto.sign(
                RemoteEnvelopeSeedV2(type, payload, identity.keyId, sessionId, sequence = clientSequence++),
                identity.privateKey,
                identity.publicKey,
            )
            socket.send(Frame.Text(RemoteEnvelopeCrypto.encode(envelope)))
        }
    }

    override fun close() {
        scope.launch {
            try {
                runCatching { socket.close() }
            } finally {
                httpClient.close()
                inbound.close()
                scope.cancel()
            }
        }
    }
}
