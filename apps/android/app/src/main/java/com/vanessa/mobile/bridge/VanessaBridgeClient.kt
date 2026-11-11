package com.vanessa.mobile.bridge

import io.ktor.client.*
import io.ktor.client.engine.android.*
import io.ktor.client.plugins.logging.*
import io.ktor.client.plugins.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import android.util.Log
import org.json.JSONObject
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.inject.Inject
import javax.inject.Singleton

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

    /**
     * Connect to PC Gateway
     */
    suspend fun connect(pcIP: String, port: Int = 8765, secret: String) {
        if (_connectionState.value is ConnectionState.Connected) {
            Log.w(TAG, "Already connected")
            return
        }

        _connectionState.value = ConnectionState.Connecting

        try {
            client.webSocket(
                host = pcIP,
                port = port,
                path = "/"
            ) {
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
                    handleDisconnect(pcIP, port, secret)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Connection error", e)
            _connectionState.value = ConnectionState.Error(e.message ?: "Connection failed")
            scheduleReconnect(pcIP, port, secret)
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
            "id" to java.util.UUID.randomUUID().toString(),
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
            "id" to java.util.UUID.randomUUID().toString(),
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
            "id" to java.util.UUID.randomUUID().toString(),
            "timestamp" to System.currentTimeMillis(),
            "type" to "task.cancel",
            "taskId" to taskId
        ), secret)

        sendMessage(message)
    }

    /**
     * Send ping to keep connection alive
     */
    private suspend fun sendPing() {
        val message = mapOf(
            "v" to 1,
            "id" to java.util.UUID.randomUUID().toString(),
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
     * Sign a message with HMAC-SHA256 using the device's shared secret.
     * The signature is computed over id, timestamp, and payload fields.
     */
    private suspend fun signMessage(message: Map<String, Any>, secret: String): Map<String, Any> {
        // Compute canonical payload: JSON.stringify of {payload, timestamp, nonce}
        val timestamp = System.currentTimeMillis()
        val nonce = java.util.UUID.randomUUID().toString()
        val payload = message

        // Create canonical string (same logic as MessageSigner.sign in TS)
        val canonical = JSONObject().apply {
            put("payload", payload)
            put("timestamp", timestamp)
            put("nonce", nonce)
        }.toString()

        // Generate HMAC-SHA256 signature
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
        val signature = mac.doFinal(canonical.toByteArray()).joinToString("") { "%02x".format(it) }

        // Build the final protocol message with signature and nonce
        val result = mutableMapOf<String, Any>()
        result["v"] = 1
        result["id"] = payload["id"] ?: java.util.UUID.randomUUID().toString()
        result["timestamp"] = timestamp
        result["type"] = payload["type"] ?: "task.submit"
        result["signature"] = signature
        result["nonce"] = nonce

        // Copy all message-specific fields
        for ((key, value) in payload) {
            if (key != "v" && key != "id" && key != "timestamp" && key != "type") {
                result[key] = value
            }
        }

        return result
    }

    /**
     * Handle disconnection and schedule reconnect
     */
    private fun handleDisconnect(pcIP: String, port: Int, secret: String) {
        session = null
        _connectionState.value = ConnectionState.Disconnected

        if (reconnectAttempts < maxReconnectAttempts) {
            scheduleReconnect(pcIP, port, secret)
        } else {
            _connectionState.value = ConnectionState.Error("Max reconnect attempts reached")
        }
    }

    /**
     * Schedule reconnection with exponential backoff
     */
    private fun scheduleReconnect(pcIP: String, port: Int, secret: String) {
        reconnectJob?.cancel()
        reconnectAttempts++

        val delay = minOf(1000L * (1 shl reconnectAttempts), 30_000L) // Max 30s
        Log.i(TAG, "Reconnecting in ${delay}ms (attempt $reconnectAttempts)")

        reconnectJob = scope.launch {
            delay(delay)
            connect(pcIP, port, secret)
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
