package com.vanessa.mobile.ui

import android.os.Bundle
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.vanessa.mobile.identity.AndroidRemoteApprovalKeyStore
import com.vanessa.protocol.v2.JcsCanonicalizer
import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.AlertDialog
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** UI for pairing and remote execution over the authenticated protocol-v2 bridge. */
class RemoteControlActivity : ComponentActivity() {
    private val bridge by lazy { RemoteV2BridgeClient(applicationContext) }
    private val approvalKeyStore by lazy { AndroidRemoteApprovalKeyStore(applicationContext) }
    private val qrScanner = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            qrPayload = result.data?.getStringExtra(RemotePairingQrScannerActivity.EXTRA_QR_PAYLOAD).orEmpty()
            if (qrPayload.isNotBlank()) connectWithQr()
        } else {
            val reason = result.data?.getStringExtra(RemotePairingQrScannerActivity.EXTRA_ERROR)
            if (!reason.isNullOrBlank()) connectionStatus = reason
        }
    }
    private var qrPayload by mutableStateOf("")
    private var connectionStatus by mutableStateOf("Not connected")
    private var latestEvent by mutableStateOf("No remote task has run.")
    private var bridgeJob: Job? by mutableStateOf(null)
    private var requestBusy by mutableStateOf(false)
    private var pendingApproval by mutableStateOf<JsonObject?>(null)

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
                                onClick = { qrScanner.launch(Intent(this@RemoteControlActivity, RemotePairingQrScannerActivity::class.java)) },
                                enabled = bridgeJob?.isActive != true,
                                modifier = Modifier.weight(1f),
                            ) { Text("Scan QR") }
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
                    pendingApproval?.let { approval ->
                        AlertDialog(
                            onDismissRequest = ::denyPendingTask,
                            title = { Text("Approve action on Windows PC?") },
                            text = { Text(approvalSummary(approval)) },
                            confirmButton = {
                                TextButton(onClick = ::beginBiometricApproval) {
                                    Text("Approve with biometric")
                                }
                            },
                            dismissButton = {
                                TextButton(onClick = ::denyPendingTask) { Text("Deny") }
                            },
                        )
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
                "task.confirmation_required" -> {
                    pendingApproval = event.payload["approval"] as? JsonObject
                    latestEvent = "A protected action needs your explicit confirmation."
                }
                "task.error", "protocol.error" -> latestEvent = event.payload.toString()
                "manifest.snapshot" -> latestEvent = "PC manifest loaded: ${event.payload["capabilities"]?.toString() ?: "no capabilities"}"
                "session.ready" -> connectionStatus = "Connected securely to PC."
                else -> latestEvent = "${event.type}: ${event.payload}"
            }
        }
    }

    private fun approvalSummary(approval: JsonObject): String {
        val capability = approval["capability"]?.toString() ?: "PC action"
        val consequence = approval["consequence"]?.toString() ?: "The PC requested a protected operation."
        val target = approval["target"]?.toString() ?: "Target not supplied"
        val expiresAt = approval["expiresAt"]?.toString() ?: "unknown"
        return "Capability: $capability\n\n$consequence\n\nTarget: $target\n\nExpires at: $expiresAt\n\nThe approval signature is bound to this exact request."
    }

    private fun beginBiometricApproval() {
        val approval = pendingApproval ?: return
        val identity = approvalKeyStore.loadOrCreate()
        if (identity == null) {
            latestEvent = "Approval blocked: no hardware-backed strong-biometric key is enrolled for this paired PC. Re-pair after enabling a strong biometric."
            return
        }
        val signature = try {
            approvalKeyStore.createSignature()
        } catch (error: Exception) {
            latestEvent = "Approval key unavailable: ${error.message ?: "strong biometric is required"}"
            return
        }
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    lifecycleScope.launch {
                        try {
                            val approvedAt = System.currentTimeMillis()
                            val approvalId = approval["approvalId"]?.toString()?.trim('"')
                                ?: error("Approval ID is missing.")
                            val taskId = approval["taskId"]?.toString()?.trim('"')
                                ?: error("Task ID is missing.")
                            val actionHash = approval["actionHash"]?.toString()?.trim('"')
                                ?: error("Action hash is missing.")
                            val deviceId = approval["deviceId"]?.toString()?.trim('"')
                                ?: error("Paired device ID is missing.")
                            val proofBinding = buildJsonObject {
                                put("approvalId", approvalId)
                                put("taskId", taskId)
                                put("actionHash", actionHash)
                                put("decision", "approved")
                                put("approvedAt", approvedAt)
                                put("method", "biometric_strong")
                                put("deviceId", deviceId)
                            }
                            val authenticatedSignature = result.cryptoObject?.signature
                                ?: error("Android did not return the biometric-authorized signing object.")
                            authenticatedSignature.update(
                                JcsCanonicalizer.canonicalize(proofBinding).toByteArray(Charsets.UTF_8)
                            )
                            val encodedSignature = java.util.Base64.getUrlEncoder().withoutPadding()
                                .encodeToString(authenticatedSignature.sign())
                            val proof = buildJsonObject {
                                put("keyId", identity.keyId)
                                put("signature", encodedSignature)
                            }
                            bridge.confirmTask(approvalId, taskId, actionHash, true, approvedAt, proof)
                            pendingApproval = null
                            latestEvent = "Biometric approval sent. Waiting for the PC verifier."
                        } catch (error: Exception) {
                            latestEvent = "Approval failed closed: ${error.message ?: "signature error"}"
                        }
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    latestEvent = "Approval cancelled or failed: $errString"
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    latestEvent = "Biometric was not recognized. No approval was sent."
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Approve protected PC action")
            .setSubtitle("Verify with a strong biometric")
            .setDescription("The signature will authorize only the exact capability, target and action hash shown here.")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
    }

    private fun denyPendingTask() {
        val approval = pendingApproval ?: return
        val approvalId = approval["approvalId"]?.toString()?.trim('"') ?: return
        val taskId = approval["taskId"]?.toString()?.trim('"') ?: return
        val actionHash = approval["actionHash"]?.toString()?.trim('"') ?: return
        pendingApproval = null
        lifecycleScope.launch {
            try {
                bridge.confirmTask(approvalId, taskId, actionHash, false, System.currentTimeMillis())
                latestEvent = "Action denied. No PC operation was executed."
            } catch (error: Exception) {
                latestEvent = "Denial could not be delivered: ${error.message ?: "connection lost"}"
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
