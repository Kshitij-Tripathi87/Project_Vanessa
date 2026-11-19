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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import com.vanessa.mobile.ui.components.EnergyWave
import com.vanessa.mobile.ui.components.NeonButton
import com.vanessa.mobile.ui.components.NeonIconButton
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaTheme
import com.vanessa.mobile.ui.theme.VanessaType
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
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
            VanessaTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = VanessaPalette.Obsidian) {
                    if (taskPhase is RemoteTaskPhase.Idle || taskPhase is RemoteTaskPhase.Submitted) {
                        androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize()) {
                            EnergyWave(
                                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(200.dp),
                                intensity = if (connectionStatus.startsWith("Connected")) 0.72f else 0.38f,
                            )
                            Column(
                                modifier = Modifier.fillMaxSize()
                                    .windowInsetsPadding(WindowInsets.safeDrawing)
                                    .imePadding()
                                    .verticalScroll(rememberScrollState())
                                    .padding(horizontal = 22.dp)
                                    .padding(top = 10.dp, bottom = 28.dp),
                                verticalArrangement = Arrangement.spacedBy(16.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    NeonIconButton(
                                        icon = Icons.Outlined.ArrowBack,
                                        contentDescription = "Back",
                                        onClick = { finish() },
                                        diameter = 44.dp,
                                    )
                                    Spacer(Modifier.width(12.dp))
                                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text("MY PC", color = VanessaPalette.Cyan, style = VanessaType.eyebrow)
                                        Text("Windows companion", color = VanessaPalette.TextPrimary, style = VanessaType.heading)
                                    }
                                    Text(
                                        if (connectionStatus.startsWith("Connected")) "ONLINE" else "OFFLINE",
                                        color = if (connectionStatus.startsWith("Connected")) VanessaPalette.Lime else VanessaPalette.TextDim,
                                        style = VanessaType.eyebrow,
                                    )
                                }
                                Column(
                                    modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    VanessaOrb(
                                        size = 104.dp,
                                        energy = if (connectionStatus.startsWith("Connected")) 0.6f else 0.18f,
                                        offline = false,
                                        ringCount = 2,
                                        description = "Vanessa orb. PC connection screen.",
                                    )
                                    Text("Connect your Windows PC", color = VanessaPalette.TextPrimary, style = VanessaType.heading, textAlign = TextAlign.Center)
                                    Text(
                                        "Use a one-time pairing code to establish an authenticated connection.",
                                        color = VanessaPalette.TextSecondary,
                                        style = VanessaType.bodySmall,
                                        textAlign = TextAlign.Center,
                                    )
                                }
                                Surface(
                                    modifier = Modifier.fillMaxWidth(),
                                    color = VanessaPalette.CardDeep,
                                    shape = RoundedCornerShape(20.dp),
                                    border = BorderStroke(1.dp, VanessaPalette.Border),
                                ) {
                                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                        Text("PAIRING DATA", color = VanessaPalette.Cyan, style = VanessaType.eyebrow)
                                        OutlinedTextField(
                                            value = qrPayload,
                                            onValueChange = { qrPayload = it },
                                            modifier = Modifier.fillMaxWidth(),
                                            label = { Text("PC pairing data") },
                                            placeholder = { Text("Paste the JSON from the PC pairing window") },
                                            minLines = 3,
                                            maxLines = 6,
                                            enabled = bridgeJob?.isActive != true,
                                            shape = RoundedCornerShape(14.dp),
                                            colors = OutlinedTextFieldDefaults.colors(
                                                focusedBorderColor = VanessaPalette.Cyan,
                                                unfocusedBorderColor = VanessaPalette.Border,
                                                focusedTextColor = VanessaPalette.TextPrimary,
                                                unfocusedTextColor = VanessaPalette.TextPrimary,
                                                cursorColor = VanessaPalette.Cyan,
                                                focusedContainerColor = VanessaPalette.Card,
                                                unfocusedContainerColor = VanessaPalette.Card,
                                            ),
                                        )
                                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                            NeonSecondaryButton(
                                                text = "Scan QR",
                                                leadingIcon = Icons.Outlined.QrCode2,
                                                onClick = {
                                                    qrScanner.launch(Intent(this@RemoteControlActivity, RemotePairingQrScannerActivity::class.java))
                                                },
                                                enabled = bridgeJob?.isActive != true,
                                                modifier = Modifier.weight(1f),
                                                height = 50.dp,
                                            )
                                            NeonButton(
                                                text = "Pair / Connect",
                                                onClick = ::connectWithQr,
                                                enabled = qrPayload.isNotBlank() && bridgeJob?.isActive != true,
                                                modifier = Modifier.weight(1f),
                                                height = 50.dp,
                                            )
                                        }
                                        TextButton(
                                            onClick = ::connectSavedPc,
                                            enabled = bridgeJob?.isActive != true,
                                        ) {
                                            Icon(Icons.Outlined.Refresh, contentDescription = null, tint = VanessaPalette.Cyan)
                                            Spacer(Modifier.width(8.dp))
                                            Text("Reconnect to saved PC", color = VanessaPalette.Cyan)
                                        }
                                    }
                                }
                                Surface(
                                    modifier = Modifier.fillMaxWidth(),
                                    color = VanessaPalette.CardDeep,
                                    shape = RoundedCornerShape(18.dp),
                                    border = BorderStroke(1.dp, VanessaPalette.Border),
                                ) {
                                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                                        Text("CONNECTION", color = VanessaPalette.Cyan, style = VanessaType.eyebrow)
                                        Text(connectionStatus, color = VanessaPalette.TextPrimary, style = VanessaType.cardTitle)
                                        Text(
                                            "A new phone must be approved locally on the PC before it can submit tasks.",
                                            color = VanessaPalette.TextSecondary,
                                            style = VanessaType.caption,
                                        )
                                    }
                                }
                                Surface(
                                    modifier = Modifier.fillMaxWidth(),
                                    color = VanessaPalette.CardDeep,
                                    shape = RoundedCornerShape(18.dp),
                                    border = BorderStroke(1.dp, VanessaPalette.Border),
                                ) {
                                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                        Text("AVAILABLE PC ACTIONS", color = VanessaPalette.Cyan, style = VanessaType.eyebrow)
                                        NeonSecondaryButton(
                                            text = "Read PC status",
                                            onClick = { runRemoteTask("system_status") },
                                            enabled = connectionStatus.startsWith("Connected") && !requestBusy,
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        NeonButton(
                                            text = "Open Chrome on PC",
                                            onClick = {
                                                runRemoteTask("open_app", buildJsonObject { put("app", "chrome") }, "Open Chrome on PC")
                                            },
                                            enabled = connectionStatus.startsWith("Connected") && !requestBusy,
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        if (requestBusy) Text("Submitting task…", color = VanessaPalette.Cyan, style = VanessaType.caption)
                                        Text(latestEvent, color = VanessaPalette.TextSecondary, style = VanessaType.caption)
                                    }
                                }
                                TextButton(onClick = ::disconnect) {
                                    Text("Disconnect", color = VanessaPalette.TextDim)
                                }
                            }
                        }
                    }
                    when (val phase = taskPhase) {
                        is RemoteTaskPhase.AwaitingApproval -> TaskApprovalScreen(
                            approval = phase.approval,
                            onApprove = { beginBiometricApproval(phase.approval, phase.requestId) },
                            onDeny = { denyTask(phase.approval) },
                            onBack = { taskPhase = RemoteTaskPhase.Idle },
                            busy = approvalBusy,
                        )
                        is RemoteTaskPhase.Running -> TaskExecutionScreen(
                            phase = phase,
                            onStop = { requestTaskCancellation(phase) },
                            canStop = !phase.taskId.isNullOrBlank() &&
                                !phase.requestId.isNullOrBlank() &&
                                phase.cancellationAck == null,
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
                taskPhase = RemoteTaskPhase.Submitted(capability, requestId)
            } catch (error: Exception) {
                latestEvent = "Task was not submitted: ${error.message ?: "unknown error"}"
            } finally {
                requestBusy = false
            }
        }
    }

    private fun requestTaskCancellation(phase: RemoteTaskPhase.Running) {
        if (phase.cancellationRequested || phase.cancellationAck != null) return
        val taskId = phase.taskId ?: return
        val requestId = phase.requestId ?: return

        // This is a pending request, not a local claim that execution stopped.
        taskPhase = phase.copy(cancellationRequested = true, cancellationError = null)
        lifecycleScope.launch {
            try {
                bridge.cancelTask(
                    taskId = taskId,
                    requestId = requestId,
                    reason = "Cancelled from Vanessa Android",
                )
            } catch (error: Exception) {
                val current = taskPhase as? RemoteTaskPhase.Running
                if (current?.taskId == taskId) {
                    taskPhase = current.copy(
                        cancellationRequested = false,
                        cancellationError = "Could not send cancellation: ${error.message ?: "connection unavailable"}",
                    )
                }
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
    private fun beginBiometricApproval(approval: PendingApproval, requestId: String?) {
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
                            taskId = approval.taskId,
                            requestId = requestId,
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
