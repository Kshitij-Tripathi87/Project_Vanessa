package com.vanessa.mobile.ui

import android.os.Bundle
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.vanessa.mobile.identity.AndroidRemoteApprovalKeyStore
import com.vanessa.protocol.v2.JcsCanonicalizer
import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.FragmentActivity
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
import com.vanessa.mobile.ui.screens.TaskApprovalScreen
import com.vanessa.mobile.ui.screens.TaskErrorScreen
import com.vanessa.mobile.ui.screens.TaskExecutionScreen
import com.vanessa.mobile.ui.screens.TaskResultScreen
import com.vanessa.mobile.ui.state.PendingApproval
import com.vanessa.mobile.ui.state.RemoteTaskPhase
import com.vanessa.mobile.ui.state.reduceRemoteTask
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** UI for pairing and remote execution over the authenticated protocol-v2 bridge. */
class RemoteControlActivity : FragmentActivity() {
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
    private var taskPhase by mutableStateOf<RemoteTaskPhase>(RemoteTaskPhase.Idle)
    private var approvalBusy by mutableStateOf(false)

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
                    // The lifecycle screens replace this list rather than floating
                    // over it: a stacked screen would leave the task buttons
                    // tappable underneath an approval that has not been given.
                    if (taskPhase is RemoteTaskPhase.Idle || taskPhase is RemoteTaskPhase.Submitted) {
                                        Column(
                        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("REMOTE PC", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                        Text("Authenticated Windows control", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                        Text("Both this phone and the Windows PC must be connected to the same Tailscale tailnet. Scan the QR shown on the PC and keep Tailscale active on this phone. Vanessa pins the PC's P-256 key before trusting signed server messages.")
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
                    }
                    when (val phase = taskPhase) {
                        is RemoteTaskPhase.AwaitingApproval -> TaskApprovalScreen(
                            approval = phase.approval,
                            onApprove = { beginBiometricApproval(phase.approval) },
                            onDeny = { denyTask(phase.approval) },
                            onBack = { taskPhase = RemoteTaskPhase.Idle },
                            busy = approvalBusy,
                        )

                        is RemoteTaskPhase.Running -> TaskExecutionScreen(
                            phase = phase,
                            onStop = {},
                            // The bridge exposes no cancel path yet, so no stop
                            // control is drawn rather than drawing a dead one.
                            canStop = false,
                        )

                        is RemoteTaskPhase.Finished -> TaskResultScreen(
                            outcome = phase.outcome,
                            onDone = { taskPhase = RemoteTaskPhase.Idle },
                            onRetry = {
                                taskPhase = RemoteTaskPhase.Idle
                                runRemoteTask("system_status")
                            },
                        )

                        is RemoteTaskPhase.Failed -> TaskErrorScreen(
                            message = phase.message,
                            retryable = phase.retryable,
                            onBack = { taskPhase = RemoteTaskPhase.Idle },
                            onRetry = {
                                taskPhase = RemoteTaskPhase.Idle
                                runRemoteTask("system_status")
                            },
                        )

                        RemoteTaskPhase.Idle, is RemoteTaskPhase.Submitted -> Unit
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
                taskPhase = RemoteTaskPhase.Submitted(capability)
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
                // Connection bookkeeping is not task state and must not push the
                // lifecycle screens around.
                "session.ready" -> connectionStatus = "Connected securely to PC."
                "manifest.snapshot" -> latestEvent =
                    "PC manifest loaded: ${event.payload["capabilities"]?.toString() ?: "no capabilities"}"
                else -> {
                    taskPhase = reduceRemoteTask(taskPhase, event)
                    if (taskPhase != RemoteTaskPhase.Idle) {
                        latestEvent = (taskPhase as? RemoteTaskPhase.Running)?.summary
                            ?: event.type
                    }
                }
            }
        }
    }

    /**
     * Approval is the only place a protected action can proceed, and it only
     * proceeds through the keystore's biometric-bound signature. The proof is
     * computed over the approval's own binding fields, so a signature harvested
     * for one request cannot be replayed against another.
     */
    private fun beginBiometricApproval(approval: PendingApproval) {
        if (approvalBusy) return
        approvalBusy = true
        approvalKeyStore.authenticateForSignature(
            activity = this,
            onSuccess = { approvalKeyId, authenticatedSignature ->
                lifecycleScope.launch {
                    try {
                        val approvedAt = System.currentTimeMillis()
                        val proofBinding = buildJsonObject {
                            put("approvalId", approval.approvalId)
                            put("taskId", approval.taskId)
                            put("actionHash", approval.actionHash)
                            put("decision", "approved")
                            put("approvedAt", approvedAt)
                            put("method", "biometric_strong")
                            put("deviceId", approval.deviceId)
                        }
                        authenticatedSignature.update(
                            JcsCanonicalizer.canonicalize(proofBinding).toByteArray(Charsets.UTF_8)
                        )
                        val encodedSignature = java.util.Base64.getUrlEncoder().withoutPadding()
                            .encodeToString(authenticatedSignature.sign())
                        val proof = buildJsonObject {
                            put("keyId", approvalKeyId)
                            put("signature", encodedSignature)
                        }
                        bridge.confirmTask(
                            approval.approvalId,
                            approval.taskId,
                            approval.actionHash,
                            true,
                            approvedAt,
                            proof,
                        )
                        taskPhase = RemoteTaskPhase.Running(
                            stateLabel = "Approval sent",
                            summary = "Waiting for the PC to verify your signature.",
                            percentComplete = null,
                            steps = listOf("You approved this action."),
                        )
                    } catch (error: Exception) {
                        taskPhase = RemoteTaskPhase.Failed(
                            message = "Approval failed closed: ${error.message ?: "signature error"}",
                            retryable = false,
                        )
                    } finally {
                        approvalBusy = false
                    }
                }
            },
            onFailure = { reason ->
                approvalBusy = false
                taskPhase = RemoteTaskPhase.Failed(
                    message = "Approval was not sent: $reason",
                    retryable = true,
                )
            },
        )
    }

    /** Cancelling sends a denial; nothing runs on the PC. */
    private fun denyTask(approval: PendingApproval) {
        taskPhase = RemoteTaskPhase.Failed(
            message = "You denied the action. Nothing ran on the PC.",
            retryable = false,
        )
        lifecycleScope.launch {
            try {
                bridge.confirmTask(
                    approvalId = approval.approvalId,
                    taskId = approval.taskId,
                    actionHash = approval.actionHash,
                    approved = false,
                    approvedAt = System.currentTimeMillis(),
                )
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
