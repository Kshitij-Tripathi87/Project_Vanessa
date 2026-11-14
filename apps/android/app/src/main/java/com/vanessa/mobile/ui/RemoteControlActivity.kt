package com.vanessa.mobile.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import androidx.fragment.app.FragmentActivity
import com.vanessa.mobile.bridge.ConnectionState
import com.vanessa.mobile.viewmodel.PairingViewModel
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** Android companion screen: QR pairing, task submission and biometric approvals. */
@AndroidEntryPoint
class RemoteControlActivity : FragmentActivity() {
    private val pairingViewModel: PairingViewModel by viewModels()

    private val scanQr = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            val payload = result.data?.getStringExtra(QrScannerActivity.EXTRA_SCANNED_PAYLOAD)
            if (!payload.isNullOrBlank()) pairingViewModel.onPairingPayloadScanned(payload)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF66D9E8),
                    secondary = Color(0xFF8B9CFF),
                    background = Color(0xFF0B1018),
                    surface = Color(0xFF151D2A),
                )
            ) {
                val state by pairingViewModel.state.collectAsState()
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    RemoteControlScreen(
                        state = state,
                        onScan = { scanQr.launch(Intent(this, QrScannerActivity::class.java)) },
                        onConnect = pairingViewModel::connect,
                        onForget = pairingViewModel::forgetDevice,
                        onSubmit = pairingViewModel::submitRemoteTask,
                        onApprove = { pairingViewModel.approvePendingTask(this) },
                        onDeny = pairingViewModel::denyPendingTask,
                    )
                }
            }
        }
    }
}

@Composable
private fun RemoteControlScreen(
    state: PairingViewModel.UiState,
    onScan: () -> Unit,
    onConnect: () -> Unit,
    onForget: () -> Unit,
    onSubmit: (String, Map<String, Any?>, String?) -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    var capability by remember { mutableStateOf("system_status") }
    var arguments by remember { mutableStateOf("{}") }
    var intent by remember { mutableStateOf("Read the requested status from the paired Windows PC") }
    var formError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("VANESSA · REMOTE", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Text("Windows PC connection", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text(
                "End-to-end signed protocol v2 over Tailscale WSS. The PC owns the trusted-device registry, permissions and execution.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("PAIRING", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                val connectionText = when (val connection = state.connection) {
                    is ConnectionState.Connected -> "Connected · ${connection.pcIP}"
                    ConnectionState.Connecting -> "Connecting…"
                    ConnectionState.Disconnected -> "Disconnected"
                    is ConnectionState.Error -> "Connection error · ${connection.message}"
                }
                Text(connectionText, style = MaterialTheme.typography.titleMedium)
                Text("Pairing state: ${state.status}")
                state.pairing?.let {
                    Text("PC: ${it.pcIp}:${it.port}")
                    Text("Pinned PC key: ${it.pcKeyId.take(18)}…", style = MaterialTheme.typography.bodySmall)
                    if (it.deviceId != null) Text("PC-approved device ID: ${it.deviceId}", style = MaterialTheme.typography.bodySmall)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onScan) { Text("Scan PC QR") }
                    TextButton(onClick = onConnect, enabled = state.pairing != null) { Text("Reconnect") }
                    TextButton(onClick = onForget, enabled = state.pairing != null) { Text("Forget") }
                }
                state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("PC CAPABILITIES", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                if (state.tools.isEmpty()) {
                    Text("The PC manifest appears after a trusted v2 session is established.", style = MaterialTheme.typography.bodySmall)
                } else {
                    state.tools.forEach { tool ->
                        Text("${tool.name} · ${tool.tier} · ${tool.description}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("SEND TASK TO PC", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                OutlinedTextField(
                    value = capability,
                    onValueChange = { capability = it; formError = null },
                    label = { Text("Capability name") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = arguments,
                    onValueChange = { arguments = it; formError = null },
                    label = { Text("Arguments (JSON object)") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    maxLines = 6,
                )
                OutlinedTextField(
                    value = intent,
                    onValueChange = { intent = it },
                    label = { Text("Task context (optional)") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    maxLines = 4,
                )
                Text(
                    "Try system_status with {} or open_app with {\\"app\\":\\"notepad\\"}. The PC still validates capability, arguments, permissions and verification.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                formError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(
                    onClick = {
                        try {
                            val parsed = Json.parseToJsonElement(arguments) as? JsonObject
                                ?: throw IllegalArgumentException("Arguments must be a JSON object.")
                            onSubmit(capability, parsed.toMapValues(), intent)
                            formError = null
                        } catch (error: Exception) {
                            formError = error.message ?: "Invalid task arguments."
                        }
                    },
                    enabled = state.connection is ConnectionState.Connected && !state.busy &&
                        capability.matches(Regex("^[a-z][a-z0-9_]{0,63}$")),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Submit PC task") }
                state.taskMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                state.taskResult?.let {
                    Text("VERIFIED RESULT", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(it, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        state.pendingApproval?.let { approval ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("PC ACTION NEEDS APPROVAL", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error)
                    Text(approval.summary, style = MaterialTheme.typography.titleMedium)
                    Text("Task: ${approval.taskId}", style = MaterialTheme.typography.bodySmall)
                    Text("Action hash: ${approval.actionHash}", style = MaterialTheme.typography.bodySmall)
                    Text("Expires: ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(approval.expiresAt))}", style = MaterialTheme.typography.bodySmall)
                    val activity = LocalContext.current as? FragmentActivity
                    Button(
                        onClick = onApprove,
                        enabled = activity != null && !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Approve with strong biometrics") }
                    TextButton(onClick = onDeny, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                        Text("Deny action")
                    }
                }
            }
        }

        Text(
            "Security: this phone's private key stays in Android Keystore. Each remote message is signed and replay-checked. PC destructive actions require a separate biometric-bound signature; denying an approval does not run the task.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun JsonObject.toMapValues(): Map<String, Any?> =
    entries.associate { (key, value) -> key to value.toKotlinValue() }

private fun kotlinx.serialization.json.JsonElement.toKotlinValue(): Any? = when (this) {
    is JsonObject -> toMapValues()
    is JsonArray -> map { it.toKotlinValue() }
    JsonNull -> null
    is JsonPrimitive -> when {
        isString -> content
        booleanOrNull != null -> booleanOrNull
        longOrNull != null -> longOrNull
        doubleOrNull != null -> doubleOrNull
        else -> content
    }
}
