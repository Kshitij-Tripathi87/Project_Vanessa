package com.vanessa.mobile.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.vanessa.mobile.R
import com.vanessa.mobile.remote.RemoteV2BridgeClient
import com.vanessa.mobile.remote.RemoteV2Event
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** UI for pairing and remote execution over the authenticated protocol-v2 bridge. */
class RemoteControlActivity : ComponentActivity() {
    private val bridge by lazy { RemoteV2BridgeClient(applicationContext) }
    private var qrPayload by mutableStateOf("")
    private var connectionStatus by mutableStateOf("Not connected")
    private var latestEvent by mutableStateOf("No remote task has run.")
    private var bridgeJob: Job? by mutableStateOf(null)
    private var requestBusy by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = colorResource(R.color.vanessa_primary),
                    secondary = colorResource(R.color.vanessa_secondary),
                    background = colorResource(R.color.vanessa_background),
                    surface = colorResource(R.color.vanessa_surface),
                    onPrimary = colorResource(R.color.vanessa_on_primary),
                    onSurface = colorResource(R.color.vanessa_on_surface),
                    error = colorResource(R.color.vanessa_error),
                )
            ) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(
                        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("REMOTE PC", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                        Text("Authenticated Windows control", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                        Text("Paste the pairing JSON shown in the QR window on your PC. The phone pins the PC's P-256 key before trusting any server message.")
                        OutlinedTextField(
                            value = qrPayload,
                            onValueChange = { qrPayload = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("PC pairing data") },
                            placeholder = { Text("Paste the JSON from the PC pairing window") },
                            minLines = 4,
                            maxLines = 8,
                            enabled = bridgeJob?.isActive != true,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = ::connectWithQr,
                                enabled = qrPayload.isNotBlank() && bridgeJob?.isActive != true,
                                modifier = Modifier.weight(1f),
                            ) { Text("Pair / Connect") }
                            TextButton(
                                onClick = ::connectSavedPc,
                                enabled = bridgeJob?.isActive != true,
                            ) { Text("Reconnect") }
                        }
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("CONNECTION", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                                Text(connectionStatus)
                                Text("A new phone must be approved locally on the PC before it can submit tasks.")
                            }
                        }
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("PC TASKS", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                                Button(
                                    onClick = { runRemoteTask("system_status") },
                                    enabled = connectionStatus.startsWith("Connected") && !requestBusy,
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text("Read PC status") }
                                Button(
                                    onClick = {
                                        runRemoteTask("open_app", buildJsonObject { put("app", "chrome") }, "Open Chrome on PC")
                                    },
                                    enabled = connectionStatus.startsWith("Connected") && !requestBusy,
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text("Open Chrome on PC") }
                                if (requestBusy) Text("Sending task…")
                                Text(latestEvent, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        TextButton(onClick = ::disconnect) { Text("Disconnect") }
                    }
                }
            }
        }
        bridge.connectToSavedPc(
            scope = lifecycleScope,
            onState = { state -> runOnUiThread { connectionStatus = state } },
            onEvent = ::handleRemoteEvent,
        )?.let { bridgeJob = it }
    }

    private fun connectWithQr() {
        bridgeJob?.cancel()
        bridgeJob = bridge.connectWithQr(
            scope = lifecycleScope,
            qrPayload = qrPayload,
            onState = { state -> runOnUiThread { connectionStatus = state } },
            onEvent = ::handleRemoteEvent,
        )
    }

    private fun connectSavedPc() {
        bridgeJob?.cancel()
        bridgeJob = bridge.connectToSavedPc(
            scope = lifecycleScope,
            onState = { state -> runOnUiThread { connectionStatus = state } },
            onEvent = ::handleRemoteEvent,
        )
        if (bridgeJob == null) connectionStatus = "No paired PC is saved. Paste a fresh PC pairing QR payload."
    }

    private fun runRemoteTask(
        capability: String,
        arguments: kotlinx.serialization.json.JsonObject = buildJsonObject {},
        intent: String? = null,
    ) {
        if (requestBusy) return
        requestBusy = true
        lifecycleScope.launch {
            try {
                val requestId = bridge.submitTask(capability, arguments, intent)
                latestEvent = "Task submitted: $requestId"
            } catch (error: Exception) {
                latestEvent = "Task was not submitted: ${error.message ?: "unknown error"}"
            } finally {
                requestBusy = false
            }
        }
    }

    private fun handleRemoteEvent(event: RemoteV2Event) {
        runOnUiThread {
            when (event.type) {
                "task.accepted" -> latestEvent = "PC accepted task ${event.payload["taskId"]?.toString() ?: ""}"
                "task.progress" -> latestEvent = event.payload["safeSummary"]?.toString() ?: "PC task is running."
                "task.result" -> latestEvent = "PC result: ${event.payload}"
                "task.error", "protocol.error" -> latestEvent = event.payload.toString()
                "manifest.snapshot" -> latestEvent = "PC manifest loaded: ${event.payload["capabilities"]?.toString() ?: "no capabilities"}"
                "session.ready" -> connectionStatus = "Connected securely to PC."
                else -> latestEvent = "${event.type}: ${event.payload}"
            }
        }
    }

    private fun disconnect() {
        bridgeJob?.cancel()
        bridge.disconnect()
        connectionStatus = "Disconnected"
    }

    override fun onDestroy() {
        bridgeJob?.cancel()
        bridge.close()
        super.onDestroy()
    }
}
