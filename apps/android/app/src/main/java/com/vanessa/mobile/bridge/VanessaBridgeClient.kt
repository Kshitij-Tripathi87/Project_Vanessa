package com.vanessa.mobile.bridge

import io.ktor.client.*
import io.ktor.client.engine.android.*
import io.ktor.client.plugins.logging.*
import io.ktor.client.plugins.websocket.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.websocket.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import android.util.Log
import org.json.JSONObject
import javax.inject.Inject
import javax.inject.Singleton
import java.util.UUID

/**
 * Phase 4.1: WebSocket Bridge Client
 *
 * Connects to PC Gateway, handles protocol messages,
 * manages connection lifecycle with auto-reconnect.
 */

sealed class ConnectionState {
    object Disconnected : ConnectionState()
    object Connecting : ConnectionState()
    data class Connected(val pcIP: String) : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

sealed class BridgeEvent {
    data class ManifestReceived(val tools: List<ToolDefinition>) : BridgeEvent()
    data class TaskAccepted(val taskId: String) : BridgeEvent()
    data class TaskProgress(val taskId: String, val state: String, val message: String?) : BridgeEvent()
    data class TaskResult(val taskId: String, val result: Any) : BridgeEvent()
    data class TaskError(val taskId: String?, val code: String, val message: String) : BridgeEvent()
    data class ConfirmationRequired(
        val taskId: String,
        val summary: String,
        val actionHash: String,
        val expiresAt: Long
    ) : BridgeEvent()
}

data class ToolDefinition(
    val name: String,
    val description: String,
    val tier: String,
    val timeout: Int
)

/** Result of exchanging a pairing code at `POST /pair` on the PC gateway. */
data class PairingGrant(
    val deviceId: String,
    val secret: String,
    val pcName: String?
)

@Singleton
class VanessaBridgeClient @Inject constructor() {
    private val TAG = "VanessaBridge"

    private val client = HttpClient(Android) {
        install(WebSockets) {
            pingInterval = 30_000 // 30 seconds
        }
        install(Logging) {
            logger = object : Logger {
                override fun log(message: String) {
                    Log.d(TAG, message)
                }
            }
            level = LogLevel.INFO
        }
    }

    private var session: DefaultClientWebSocketSession? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _events = MutableSharedFlow<BridgeEvent>(replay = 0)
    val events: SharedFlow<BridgeEvent> = _events.asSharedFlow()

    private var reconnectAttempts = 0
    private val maxReconnectAttempts = 5
    private var reconnectJob: Job? = null

    // Credentials and address for the current pairing, reused on reconnect.
    private var activeDeviceId: String? = null
    private var activeSecret: String? = null
    private var rememberedIp: String? = null
    private var rememberedPort: Int = 8765

    /**
     * Exchange the scanned single-use pairing code for this phone's HMAC
     * secret. The QR never carries the secret; it is issued once, here.
     */
    suspend fun redeemPairing(
        pcIp: String,
        port: Int,
        pairingCode: String,
        deviceName: String? = null
    ): PairingGrant? {
        return try {
            val body = JSONObject().apply {
                put("pairingCode", pairingCode)
                if (!deviceName.isNullOrBlank()) put("deviceName", deviceName)
            }

            val response = client.post("http://$pcIp:$port/pair") {
                contentType(ContentType.Application.Json)
                setBody(body.toString())
            }

            if (response.status.value != 200) {
                Log.w(TAG, "Pairing rejected: ${response.status}")
                return null
            }

            val json = JSONObject(response.bodyAsText())
            val deviceId = json.optString("deviceId")
            val secret = json.optString("secret")
            if (deviceId.isEmpty() || secret.isEmpty()) {
                Log.w(TAG, "Pairing response missing deviceId or secret")
                return null
            }

            PairingGrant(
                deviceId = deviceId,
                secret = secret,
                pcName = json.optString("pcName").ifEmpty { null }
            )
        } catch (e: Exception) {
            Log.e(TAG, "Pairing redemption failed", e)
            null
        }
    }

    /**
     * Connect to PC Gateway.
     *
     * The claimed device id travels on the upgrade URL: the gateway needs it to
     * select the secret it will verify this socket's signatures with. The id
     * alone grants nothing — every message still has to be signed.
     */
    suspend fun connect(pcIP: String, port: Int = 8765, deviceId: String, secret: String) {
        if (_connectionState.value is ConnectionState.Connected) {
            Log.w(TAG, "Already connected")
            return
        }

        activeDeviceId = deviceId
        activeSecret = secret
        rememberedIp = pcIP
        rememberedPort = port
        _connectionState.value = ConnectionState.Connecting

        try {
            val encodedDevice = java.net.URLEncoder.encode(deviceId, "UTF-8")
            client.webSocket(urlString = "ws://$pcIP:$port/?device=$encodedDevice") {
                session = this
                _connectionState.value = ConnectionState.Connected(pcIP)
                reconnectAttempts = 0

                Log.i(TAG, "Connected to $pcIP:$port")

                // Send ping to keep connection alive
                launch {
                    while (isActive) {
                        delay(30_000)
                        try {
                            sendPing()
                        } catch (e: Exception) {
                            Log.e(TAG, "Ping failed", e)
                        }
                    }
                }

                // Receive messages
                try {
                    for (frame in incoming) {
                        when (frame) {
                            is Frame.Text -> {
                                val text = frame.readText()
                                handleMessage(text)
                            }
                            is Frame.Close -> {
                                Log.i(TAG, "Connection closed by server")
                                break
                            }
                            else -> {}
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Receive error", e)
                } finally {
                    handleDisconnect()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Connection error", e)
            _connectionState.value = ConnectionState.Error(e.message ?: "Connection failed")
            scheduleReconnect()
        }
    }

    /**
     * Disconnect from PC Gateway
     */
    suspend fun disconnect() {
        reconnectJob?.cancel()
        session?.close(CloseReason(CloseReason.Codes.NORMAL, "Client disconnect"))
        session = null
        _connectionState.value = ConnectionState.Disconnected
        Log.i(TAG, "Disconnected")
    }

    /**
     * Submit a task to PC
     */
    suspend fun submitTask(tool: String, args: Map<String, Any>, idempotencyKey: String, secret: String) {
        val message = signMessage(mapOf(
            "v" to 1,
            "id" to UUID.randomUUID().toString(),
            "timestamp" to System.currentTimeMillis(),
            "type" to "task.submit",
            "tool" to tool,
            "args" to args,
            "idempotencyKey" to idempotencyKey
        ), secret)

        sendMessage(message)
    }

    /**
     * Send confirmation for T2 action
     */
    suspend fun sendConfirmation(taskId: String, approved: Boolean, actionHash: String, secret: String) {
        val message = signMessage(mapOf(
            "v" to 1,
            "id" to UUID.randomUUID().toString(),
            "timestamp" to System.currentTimeMillis(),
            "type" to "task.confirm",
            "taskId" to taskId,
            "approved" to approved,
            "actionHash" to actionHash
        ), secret)

        sendMessage(message)
    }

    /**
     * Cancel a running task
     */
    suspend fun cancelTask(taskId: String, secret: String) {
        val message = signMessage(mapOf(
            "v" to 1,
            "id" to UUID.randomUUID().toString(),
            "timestamp" to System.currentTimeMillis(),
            "type" to "task.cancel",
            "taskId" to taskId
        ), secret)

        sendMessage(message)
    }

    /**
     * Send ping to keep connection alive. Pings carry no signature fields in
     * the schema and are only accepted by the gateway once the socket has
     * authenticated with a signed message.
     */
    private suspend fun sendPing() {
        val message = mapOf(
            "v" to 1,
            "id" to UUID.randomUUID().toString(),
            "timestamp" to System.currentTimeMillis(),
            "type" to "ping",
            "sentAt" to System.currentTimeMillis()
        )

        sendMessage(message)
    }

    /**
     * Handle incoming message from PC
     */
    private suspend fun handleMessage(text: String) {
        try {
            val message = JSONObject(text)
            val type = message.optString("type")
            if (type.isEmpty()) return

            when (type) {
                "manifest.sync" -> {
                    val array = message.optJSONArray("tools")
                    val tools = buildList {
                        for (index in 0 until (array?.length() ?: 0)) {
                            val item = array?.optJSONObject(index) ?: continue
                            add(
                                ToolDefinition(
                                    name = item.optString("name"),
                                    description = item.optString("description"),
                                    tier = item.optString("tier", "T0"),
                                    timeout = item.optInt("timeout", 30)
                                )
                            )
                        }
                    }

                    _events.emit(BridgeEvent.ManifestReceived(tools))
                }

                "task.accepted" -> {
                    val taskId = message.optString("taskId")
                    if (taskId.isEmpty()) return
                    _events.emit(BridgeEvent.TaskAccepted(taskId))
                }

                "task.progress" -> {
                    val taskId = message.optString("taskId")
                    if (taskId.isEmpty()) return
                    val state = message.optString("state")
                    val msg = message.optString("message").ifEmpty { null }
                    _events.emit(BridgeEvent.TaskProgress(taskId, state, msg))
                }

                "task.result" -> {
                    val taskId = message.optString("taskId")
                    if (taskId.isEmpty()) return
                    val result = message.opt("result") ?: emptyMap<String, Any>()
                    _events.emit(BridgeEvent.TaskResult(taskId, result))
                }

                "task.error" -> {
                    val taskId = message.optString("taskId").ifEmpty { null }
                    val code = message.optString("code", "UNKNOWN")
                    val msg = message.optString("message", "Unknown error")
                    _events.emit(BridgeEvent.TaskError(taskId, code, msg))
                }

                "task.confirm_required" -> {
                    val taskId = message.optString("taskId")
                    if (taskId.isEmpty()) return
                    val summary = message.optString("summary")
                    val actionHash = message.optString("actionHash")
                    val expiresAt = message.optLong("expiresAt", 0L)
                    _events.emit(BridgeEvent.ConfirmationRequired(taskId, summary, actionHash, expiresAt))
                }

                "pong" -> {
                    Log.d(TAG, "Received pong")
                }

                else -> {
                    Log.w(TAG, "Unknown message type: $type")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle message", e)
        }
    }

    /**
     * Send message to PC
     */
    private suspend fun sendMessage(message: Map<String, Any>) {
        try {
            val payload = JSONObject(message as Map<*, *>).toString()
            session?.send(Frame.Text(payload))
            Log.d(TAG, "Sent: ${message["type"]}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send message", e)
            throw e
        }
    }

    /**
     * Sign a message with HMAC-SHA256.
     *
     * Contract shared with the PC (`messageSecurity.ts`), implemented in
     * [MessageSigning] and covered by a cross-language test vector:
     *
     *   signature = hex(HMAC-SHA256(secret, canonicalJson(message - signature)))
     */
    private fun signMessage(message: Map<String, Any>, secret: String): Map<String, Any> =
        MessageSigning.sign(message, secret)

    /**
     * Handle disconnection and schedule reconnect
     */
    private fun handleDisconnect() {
        session = null
        _connectionState.value = ConnectionState.Disconnected

        if (reconnectAttempts < maxReconnectAttempts) {
            scheduleReconnect()
        } else {
            _connectionState.value = ConnectionState.Error("Max reconnect attempts reached")
        }
    }

    /**
     * Schedule reconnection with exponential backoff
     */
    private fun scheduleReconnect() {
        val pcIP = rememberedIp ?: return
        val deviceId = activeDeviceId ?: return
        val secret = activeSecret ?: return

        reconnectJob?.cancel()
        reconnectAttempts++

        val delay = minOf(1000L * (1 shl reconnectAttempts), 30_000L) // Max 30s
        Log.i(TAG, "Reconnecting in ${delay}ms (attempt $reconnectAttempts)")

        reconnectJob = scope.launch {
            delay(delay)
            connect(pcIP = pcIP, port = rememberedPort, deviceId = deviceId, secret = secret)
        }
    }

    /**
     * Cleanup resources
     */
    fun close() {
        scope.cancel()
        client.close()
    }
}
