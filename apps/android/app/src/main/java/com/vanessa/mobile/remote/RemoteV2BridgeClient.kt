package com.vanessa.mobile.remote

import android.content.Context
import android.os.Build
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.readText
import com.vanessa.mobile.BuildConfig
import com.vanessa.mobile.identity.AndroidRemoteIdentity
import com.vanessa.mobile.identity.AndroidRemoteIdentityStore
import com.vanessa.mobile.identity.AndroidRemoteApprovalKeyStore
import com.vanessa.protocol.v2.PRE_SESSION_ID
import com.vanessa.protocol.v2.RemoteEnvelopeCheck
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import com.vanessa.protocol.v2.RemoteEnvelopeSeedV2
import com.vanessa.protocol.v2.RemoteEnvelopeSessionGuard
import com.vanessa.protocol.v2.RemoteEnvelopeV2
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import kotlin.time.Duration.Companion.seconds

/**
 * Android protocol-v2 transport. Identity signing is handled by Android
 * Keystore; the PC public key is pinned from the QR payload before any remote
 * message is trusted. The legacy HMAC bridge is not used here.
 */
class RemoteV2BridgeClient(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences("vanessa_remote_v2", Context.MODE_PRIVATE)
    private val identityStore = AndroidRemoteIdentityStore()
    private val approvalKeyStore = AndroidRemoteApprovalKeyStore(appContext)
    private val http = HttpClient(Android) {
        install(WebSockets) {
            pingInterval = 20.seconds
            maxFrameSize = 64L * 1024L
        }
    }
    private val sendMutex = Mutex()
    @Volatile private var activeSession: WebSocketSession? = null
    @Volatile private var activeSessionId: String? = null
    @Volatile private var nextSequence = 1
    @Volatile private var pairedKeyId: String? = preferences.getString(KEY_PAIRED_PC_KEY_ID, null)
    @Volatile private var stopRequested = false

    private val json = Json { ignoreUnknownKeys = false; isLenient = false }

    fun connectWithQr(
        scope: CoroutineScope,
        qrPayload: String,
        onState: (String) -> Unit,
        onEvent: (RemoteV2Event) -> Unit,
    ): Job = scope.launch(Dispatchers.IO) {
        stopRequested = false
        val config = try {
            parsePairingQr(qrPayload)
        } catch (error: Exception) {
            onState("Invalid PC pairing QR: ${error.message ?: "invalid data"}")
            return@launch
        }
        val identity = try {
            identityStore.loadOrCreate()
        } catch (error: Exception) {
            onState("Android Keystore identity is unavailable: ${error.message ?: "unknown error"}")
            return@launch
        }
        val alreadyPaired = pairedKeyId == config.pcKeyId && preferences.getString(KEY_PAIRED_PC_KEY_ID, null) == config.pcKeyId
        var reconnectDelayMs = 1_000L
        var firstConnection = true

        while (isActive && !stopRequested) {
            try {
                onState(if (firstConnection) "Connecting to ${config.pcName}…" else "Reconnecting to ${config.pcName}…")
                runConnection(config, identity, alreadyPaired || pairedKeyId == config.pcKeyId, onState, onEvent)
                reconnectDelayMs = 1_000L
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                activeSession = null
                activeSessionId = null
                onState("Remote PC disconnected: ${error.message ?: "connection closed"}")
                if (pairedKeyId != config.pcKeyId) {
                    onState("Pairing did not complete. Generate a fresh QR code on the PC and try again.")
                    return@launch
                }
            } finally {
                activeSession = null
                activeSessionId = null
            }
            firstConnection = false
            delay(reconnectDelayMs)
            reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
        }
    }

    fun connectToSavedPc(
        scope: CoroutineScope,
        onState: (String) -> Unit,
        onEvent: (RemoteV2Event) -> Unit,
    ): Job? {
        stopRequested = false
        val saved = loadSavedConfig() ?: return null
        return scope.launch(Dispatchers.IO) {
            val identity = identityStore.loadOrCreate()
            var reconnectDelayMs = 1_000L
            while (isActive && !stopRequested) {
                try {
                    onState("Connecting to ${saved.pcName}…")
                    runConnection(saved, identity, true, onState, onEvent)
                    reconnectDelayMs = 1_000L
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    activeSession = null
                    activeSessionId = null
                    onState("Remote PC disconnected: ${error.message ?: "connection closed"}")
                } finally {
                    activeSession = null
                    activeSessionId = null
                }
                delay(reconnectDelayMs)
                reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
            }
        }
    }

    suspend fun submitTask(
        capability: String,
        arguments: JsonObject = buildJsonObject {},
        intent: String? = null,
    ): String {
        require(capability.matches(Regex("^[a-z][a-z0-9_]{1,63}$"))) { "Invalid capability name." }
        val requestId = UUID.randomUUID().toString()
        val payload = buildJsonObject {
            put("requestId", requestId)
            put("idempotencyKey", "android-${UUID.randomUUID()}")
            put("capability", capability)
            put("canonicalArguments", arguments)
            if (!intent.isNullOrBlank()) put("intent", intent.take(300))
        }
        sendAuthenticated("task.submit", payload)
        return requestId
    }

    suspend fun getManifest() {
        sendAuthenticated("manifest.get", buildJsonObject {})
    }

    suspend fun confirmTask(
        approvalId: String,
        taskId: String,
        actionHash: String,
        approved: Boolean,
        approvedAt: Long,
        proof: JsonObject? = null,
    ) {
        val payload = buildJsonObject {
            put("approvalId", approvalId)
            put("taskId", taskId)
            put("actionHash", actionHash)
            put("decision", if (approved) "approved" else "denied")
            put("approvedAt", approvedAt)
            put("method", if (approved) "biometric_strong" else "device_session")
            if (proof != null) put("approvalProof", proof)
        }
        sendAuthenticated("task.confirmation_response", payload)
    }

    fun disconnect() {
        stopRequested = true
        activeSession?.let { session ->
            kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                runCatching { session.close() }
            }
        }
        activeSession = null
        activeSessionId = null
    }

    fun close() {
        disconnect()
        http.close()
    }

    private suspend fun runConnection(
        config: RemotePcConnection,
        identity: AndroidRemoteIdentity,
        authenticateOnly: Boolean,
        onState: (String) -> Unit,
        onEvent: (RemoteV2Event) -> Unit,
    ) {
        http.webSocket(urlString = config.endpoint) {
            activeSession = this
            val initialChallenge = withTimeout(15_000) { receiveEnvelope() }
            verifyServerEnvelope(initialChallenge, config.pcKeyId, config.pcPublicKey)
            require(initialChallenge.type == "server.challenge") { "PC did not send a server challenge." }
            var challenge = initialChallenge

            if (!authenticateOnly) {
                onState("Verifying PC identity and requesting pairing…")
                val preSessionGuard = RemoteEnvelopeSessionGuard(
                    sessionId = PRE_SESSION_ID,
                    keyId = config.pcKeyId,
                    publicKey = config.pcPublicKey,
                    lastAcceptedSequence = -1,
                )
                val biometricApprovalIdentity = approvalKeyStore.loadOrCreate()
                val claim = buildJsonObject {
                    put("pairingId", config.pairingId ?: error("Pairing ID is missing from QR."))
                    put("code", config.code ?: error("Pairing code is missing from QR."))
                    put("publicKey", identity.publicKeyBase64Url)
                    put("keyId", identity.keyId)
                    if (biometricApprovalIdentity != null) {
                        put("approvalPublicKey", biometricApprovalIdentity.publicKeyBase64Url)
                        put("approvalKeyId", biometricApprovalIdentity.keyId)
                    }
                    put("deviceHint", deviceHint())
                    put("platform", "android")
                    put("appVersion", BuildConfig.VERSION_NAME)
                    put("clientNonce", base64Url(randomBytes(32)))
                }
                sendEnvelope(
                    session = this,
                    type = "pairing.claim",
                    payload = claim,
                    keyId = identity.keyId,
                    privateKey = identity.privateKey,
                    publicKey = identity.publicKey,
                    sessionId = PRE_SESSION_ID,
                    sequence = 0,
                )

                var completeSent = false
                var pairingApproved = false
                onState("Waiting for PC to verify and approve this phone…")
                withTimeout(135_000) {
                    while (!pairingApproved) {
                        val incomingEnvelope = receiveEnvelope()
                        if (incomingEnvelope.type == "server.challenge") {
                            verifyServerEnvelope(incomingEnvelope, config.pcKeyId, config.pcPublicKey)
                            challenge = incomingEnvelope
                            continue
                        }
                        val checked = preSessionGuard.verifyAndAccept(incomingEnvelope)
                        if (checked !is RemoteEnvelopeCheck.Accepted) {
                            throw SecurityException("PC pairing message failed signature, freshness, or replay verification: $checked")
                        }
                        when (incomingEnvelope.type) {
                            "pairing.challenge" -> {
                                require(!completeSent) { "PC sent more than one pairing challenge." }
                                val nonce = incomingEnvelope.payload["nonce"]?.jsonPrimitive?.content
                                    ?: throw IllegalStateException("Pairing challenge omitted its nonce.")
                                val pairingId = incomingEnvelope.payload["pairingId"]?.jsonPrimitive?.content
                                    ?: throw IllegalStateException("Pairing challenge omitted its pairing ID.")
                                // Echo the raw one-time nonce inside the signed envelope.
                                // The PC hashes the response before its constant-time comparison.
                                val completion = buildJsonObject {
                                    put("pairingId", pairingId)
                                    put("challengeNonce", nonce)
                                }
                                sendEnvelope(
                                    session = this,
                                    type = "pairing.complete",
                                    payload = completion,
                                    keyId = identity.keyId,
                                    privateKey = identity.privateKey,
                                    publicKey = identity.publicKey,
                                    sessionId = PRE_SESSION_ID,
                                    sequence = 1,
                                )
                                completeSent = true
                            }
                            "pairing.pending" -> onState("Pairing proof accepted. Approve this phone on the PC.")
                            "pairing.approved" -> {
                                pairingApproved = true
                                pairedKeyId = config.pcKeyId
                                saveTrustedPc(config)
                                onState("Phone paired. Authenticating secure session…")
                            }
                            "protocol.error" -> {
                                val code = incomingEnvelope.payload["code"]?.jsonPrimitive?.content ?: "PAIRING_REJECTED"
                                val message = incomingEnvelope.payload["message"]?.jsonPrimitive?.content ?: "PC rejected pairing."
                                throw SecurityException("$code: $message")
                            }
                            "pairing.rejected", "pairing.expired" -> throw SecurityException("PC rejected or expired this pairing request.")
                            else -> throw SecurityException("Unexpected PC message during pairing: ${incomingEnvelope.type}")
                        }
                    }
                }
                // Approval rotates the server session ID and nonce. The initial
                // challenge cannot be reused for client.authenticate.
                challenge = withTimeout(15_000) {
                    while (true) {
                        val next = receiveEnvelope()
                        if (next.type == "server.challenge") {
                            verifyServerEnvelope(next, config.pcKeyId, config.pcPublicKey)
                            return@withTimeout next
                        }
                        val checked = preSessionGuard.verifyAndAccept(next)
                        if (checked !is RemoteEnvelopeCheck.Accepted) {
                            throw SecurityException("PC pre-session message was rejected: $checked")
                        }
                    }
                    error("Unreachable")
                }
            }

            val sessionId = challenge.sessionId
            val serverNonce = challenge.payload["serverNonce"]?.jsonPrimitive?.content
                ?: throw IllegalStateException("PC server challenge did not include its nonce.")
            val clientNonce = base64Url(randomBytes(32))
            val sessionGuard = RemoteEnvelopeSessionGuard(
                sessionId = sessionId,
                keyId = config.pcKeyId,
                publicKey = config.pcPublicKey,
                lastAcceptedSequence = challenge.sequence,
            )
            val authentication = buildJsonObject {
                put("serverNonce", serverNonce)
                put("clientNonce", clientNonce)
                put("publicKey", identity.publicKeyBase64Url)
                put("deviceHint", deviceHint())
                put("platform", "android")
                put("appVersion", BuildConfig.VERSION_NAME)
            }
            sendEnvelope(
                session = this,
                type = "client.authenticate",
                payload = authentication,
                keyId = identity.keyId,
                privateKey = identity.privateKey,
                publicKey = identity.publicKey,
                sessionId = sessionId,
                sequence = 0,
            )

            val ready = withTimeout(15_000) {
                while (true) {
                    val frame = receiveEnvelope()
                    if (frame.type == "protocol.error") {
                        throw SecurityException(frame.payload["message"]?.jsonPrimitive?.content ?: "PC authentication failed.")
                    }
                    val verified = sessionGuard.verifyAndAccept(frame)
                    if (verified !is RemoteEnvelopeCheck.Accepted) {
                        throw SecurityException("PC session message failed verification: $verified")
                    }
                    if (frame.type == "session.ready") return@withTimeout frame
                }
                error("Unreachable")
            }
            require(ready.payload["sessionId"]?.jsonPrimitive?.content == sessionId) { "PC returned a different session ID." }
            require(ready.payload["clientNonce"]?.jsonPrimitive?.content == clientNonce) { "PC did not bind the session to this client nonce." }
            activeSessionId = sessionId
            nextSequence = 1
            sendAuthenticated("manifest.get", buildJsonObject {})
            onState("Connected securely to ${config.pcName}.")
            onEvent(RemoteV2Event("session.ready", ready.payload))

            val heartbeat = launch {
                while (isActive) {
                    delay(15_000)
                    sendAuthenticated("ping", buildJsonObject { put("sentAt", System.currentTimeMillis()) })
                }
            }
            try {
                for (frame in incoming) {
                    if (frame !is Frame.Text) continue
                    val envelope = RemoteEnvelopeCrypto.decode(frame.readText())
                    val result = sessionGuard.verifyAndAccept(envelope)
                    if (result !is RemoteEnvelopeCheck.Accepted) {
                        throw SecurityException("PC message rejected by the session guard: $result")
                    }
                    if (envelope.type == "session.close" || envelope.type == "session.expiring") {
                        throw IllegalStateException("PC session closed or expired.")
                    }
                    if (envelope.type == "protocol.error") {
                        val code = envelope.payload["code"]?.jsonPrimitive?.content ?: "PROTOCOL_ERROR"
                        val message = envelope.payload["message"]?.jsonPrimitive?.content ?: "PC rejected the request."
                        onEvent(RemoteV2Event(envelope.type, envelope.payload))
                        if (code in setOf("REPLAYED_MESSAGE", "INVALID_SIGNATURE", "REVOKED_DEVICE", "SESSION_EXPIRED")) {
                            throw SecurityException("$code: $message")
                        }
                    } else {
                        onEvent(RemoteV2Event(envelope.type, envelope.payload))
                    }
                }
                throw IllegalStateException("PC WebSocket closed.")
            } finally {
                heartbeat.cancel()
                activeSession = null
                activeSessionId = null
            }
        }
    }

    private suspend fun sendAuthenticated(type: String, payload: JsonObject) {
        sendMutex.withLock {
            val session = activeSession ?: throw IllegalStateException("No authenticated PC session is active.")
            val sessionId = activeSessionId ?: throw IllegalStateException("No authenticated PC session is active.")
            val identity = identityStore.loadOrCreate()
            val sequence = nextSequence
            require(sequence < Int.MAX_VALUE) { "Remote session sequence is exhausted." }
            nextSequence += 1
            sendEnvelope(
                session = session,
                type = type,
                payload = payload,
                keyId = identity.keyId,
                privateKey = identity.privateKey,
                publicKey = identity.publicKey,
                sessionId = sessionId,
                sequence = sequence,
            )
        }
    }

    private suspend fun sendEnvelope(
        session: WebSocketSession,
        type: String,
        payload: JsonObject,
        keyId: String,
        privateKey: java.security.PrivateKey,
        publicKey: PublicKey,
        sessionId: String,
        sequence: Int,
    ) {
        val signed = RemoteEnvelopeCrypto.sign(
            RemoteEnvelopeSeedV2(
                type = type,
                payload = payload,
                keyId = keyId,
                sessionId = sessionId,
                sequence = sequence,
            ),
            privateKey,
            publicKey,
        )
        session.send(Frame.Text(RemoteEnvelopeCrypto.encode(signed)))
    }

    private suspend fun WebSocketSession.receiveEnvelope(): RemoteEnvelopeV2 {
        while (true) {
            val frame = incoming.receive()
            if (frame is Frame.Text) return RemoteEnvelopeCrypto.decode(frame.readText())
            if (frame is Frame.Close) throw IllegalStateException("PC closed the WebSocket during handshake.")
        }
    }

    private fun verifyServerEnvelope(envelope: RemoteEnvelopeV2, expectedKeyId: String, key: PublicKey) {
        require(envelope.keyId == expectedKeyId) { "PC key ID does not match the QR-pinned identity." }
        require(RemoteEnvelopeCrypto.verify(envelope, key)) { "PC signature does not match the QR-pinned identity." }
    }

    private fun parsePairingQr(raw: String): RemotePcConnection {
        require(raw.length in 1..16_384) { "Pairing QR payload is too large." }
        val root = json.parseToJsonElement(raw) as? JsonObject ?: error("QR data must be a JSON object.")
        require(root["protocolVersion"]?.jsonPrimitive?.content == "2") { "Only protocol v2 QR payloads are supported." }
        require(root["transport"]?.jsonPrimitive?.content == "websocket") { "QR does not describe a WebSocket endpoint." }
        val endpoint = root["endpoint"]?.jsonPrimitive?.content ?: error("WebSocket endpoint is missing.")
        val pcKeyId = root["pcKeyId"]?.jsonPrimitive?.content ?: error("PC key ID is missing.")
        val publicKeyEncoded = root["pcPublicKeySpki"]?.jsonPrimitive?.content ?: error("PC public key is missing.")
        val fingerprint = root["pcFingerprint"]?.jsonPrimitive?.content ?: error("PC fingerprint is missing.")
        val pcName = root["pcName"]?.jsonPrimitive?.content ?: "Vanessa PC"
        val uri = URI(endpoint)
        require(uri.scheme == "ws" && uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "PC endpoint must be a plain WebSocket URL inside Tailscale."
        }
        require(uri.host != null && isTailscaleIPv4(uri.host)) { "PC endpoint is not an assigned Tailscale IPv4 address." }
        require(uri.port in 1..65535 && (uri.path.isNullOrEmpty() || uri.path == "/")) { "PC endpoint port/path is invalid." }
        require(pcKeyId.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))) { "PC key ID is malformed." }
        val der = decodeBase64Url(publicKeyEncoded)
        require(RemoteEnvelopeCrypto.keyId(der) == pcKeyId) { "PC public key and key ID do not match." }
        val expectedFingerprint = base64Url(MessageDigest.getInstance("SHA-256").digest(der))
        require(expectedFingerprint == fingerprint) { "PC fingerprint does not match the public key." }
        val pcPublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
        require(RemoteEnvelopeCrypto.isP256(pcPublicKey)) { "PC identity must use P-256." }
        return RemotePcConnection(
            endpoint = endpoint,
            pcId = root["pcId"]?.jsonPrimitive?.content ?: "pc",
            pcName = pcName.take(80),
            pcKeyId = pcKeyId,
            pcPublicKey = pcPublicKey,
            publicKeySpki = publicKeyEncoded,
            fingerprint = fingerprint,
            pairingId = root["pairingId"]?.jsonPrimitive?.content,
            code = root["code"]?.jsonPrimitive?.content,
        ).also {
            if (pairedKeyId != it.pcKeyId) {
                require(it.pairingId?.startsWith("pair_") == true && it.code?.matches(Regex("^[a-f0-9]{48}$")) == true) {
                    "A new PC must be paired using a valid, unexpired QR code."
                }
            }
        }
    }

    private fun loadSavedConfig(): RemotePcConnection? {
        val endpoint = preferences.getString("endpoint", null) ?: return null
        val publicKey = preferences.getString("publicKeySpki", null) ?: return null
        val keyId = preferences.getString(KEY_PAIRED_PC_KEY_ID, null) ?: return null
        val fingerprint = preferences.getString("fingerprint", null) ?: return null
        return try {
            val der = decodeBase64Url(publicKey)
            val parsedKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
            if (RemoteEnvelopeCrypto.keyId(der) != keyId ||
                base64Url(MessageDigest.getInstance("SHA-256").digest(der)) != fingerprint ||
                !RemoteEnvelopeCrypto.isP256(parsedKey)) return null
            RemotePcConnection(
                endpoint = endpoint,
                pcId = preferences.getString("pcId", "pc") ?: "pc",
                pcName = preferences.getString("pcName", "Vanessa PC") ?: "Vanessa PC",
                pcKeyId = keyId,
                pcPublicKey = parsedKey,
                publicKeySpki = publicKey,
                fingerprint = fingerprint,
                pairingId = null,
                code = null,
            )
        } catch (_: Exception) { null }
    }

    private fun saveTrustedPc(config: RemotePcConnection) {
        preferences.edit()
            .putString(KEY_PAIRED_PC_KEY_ID, config.pcKeyId)
            .putString("endpoint", config.endpoint)
            .putString("pcId", config.pcId)
            .putString("pcName", config.pcName)
            .putString("publicKeySpki", config.publicKeySpki)
            .putString("fingerprint", config.fingerprint)
            .apply()
    }

    private fun deviceHint(): String =
        "${Build.MANUFACTURER}-${Build.MODEL}".replace(Regex("[^A-Za-z0-9_-]"), "-").take(64).padEnd(8, '0')

    private fun isTailscaleIPv4(value: String): Boolean {
        val parts = value.split(".")
        if (parts.size != 4) return false
        val numbers = parts.map { it.toIntOrNull() ?: return false }
        return numbers.all { it in 0..255 } && numbers[0] == 100 && numbers[1] in 64..127
    }

    private fun decodeBase64Url(value: String): ByteArray {
        require(value.matches(Regex("^[A-Za-z0-9_-]{16,512}$"))) { "Public key encoding is malformed." }
        return Base64.getUrlDecoder().decode(value)
    }

    private fun base64Url(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun randomBytes(size: Int): ByteArray = ByteArray(size).also { java.security.SecureRandom().nextBytes(it) }

    companion object {
        private const val KEY_PAIRED_PC_KEY_ID = "paired_pc_key_id"
    }
}

data class RemotePcConnection internal constructor(
    val endpoint: String,
    val pcId: String,
    val pcName: String,
    val pcKeyId: String,
    val pcPublicKey: PublicKey,
    val publicKeySpki: String,
    val fingerprint: String,
    val pairingId: String?,
    val code: String?,
)

data class RemoteV2Event(
    val type: String,
    val payload: JsonObject,
)
