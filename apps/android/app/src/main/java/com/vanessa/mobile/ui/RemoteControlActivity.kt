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
import androidx.activity.addCallback
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
import com.vanessa.mobile.ui.state.PcIdentity
import com.vanessa.mobile.ui.state.PcLink
import com.vanessa.mobile.ui.state.PcUiState
import com.vanessa.mobile.ui.state.PendingApproval
import com.vanessa.mobile.ui.state.Correlation
import com.vanessa.mobile.ui.state.RemoteTaskPhase
import com.vanessa.mobile.ui.screens.MyPcScreen
import com.vanessa.mobile.ui.screens.TaskRecoveryScreen
import com.vanessa.mobile.ui.state.applyManifest
import com.vanessa.mobile.ui.state.decodeRemoteTaskPhase
import com.vanessa.mobile.ui.state.encodeRemoteTaskPhase
import com.vanessa.mobile.ui.state.phaseOnConnectionChange
import com.vanessa.mobile.ui.state.reducePcConnection
import com.vanessa.mobile.ui.state.reduceRemoteTask
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.UUID
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
            if (!reason.isNullOrBlank()) pcState = reducePcConnection(pcState, reason)
        }
    }
    private var qrPayload by mutableStateOf("")
    private var pcState by mutableStateOf(PcUiState())
    private var bridgeJob: Job? by mutableStateOf(null)
    private var requestBusy by mutableStateOf(false)
    private var taskPhase by mutableStateOf<RemoteTaskPhase>(RemoteTaskPhase.Idle)
    private var approvalBusy by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Rotation must not destroy a pending approval or a running task, and
        // must not resurrect one either: decoding rebuilds only what was saved.
        taskPhase = decodeRemoteTaskPhase(savedInstanceState?.getString(KEY_TASK_PHASE))
        // What is stored is known before any socket exists; the link is not.
        bridge.savedPcSummary()?.let { saved ->
            pcState = pcState.copy(
                identity = PcIdentity(saved.name, saved.endpoint, saved.fingerprint),
                link = PcLink.DISCONNECTED,
                detail = "Not connected to ${saved.name}.",
            )
        }
        window.statusBarColor = android.graphics.Color.rgb(3, 5, 10)
        window.navigationBarColor = android.graphics.Color.rgb(3, 5, 10)
        // A live approval is the PC's request, not a page to swipe away from:
        // backing out of it would leave the PC waiting with nobody told.
        onBackPressedDispatcher.addCallback(this) {
            val phase = taskPhase
            if (phase is RemoteTaskPhase.AwaitingApproval) {
                if (!approvalBusy) denyTask(phase.approval)
            } else {
                // Everything else keeps the ordinary back behaviour; disable this
                // callback for the re-dispatch so it does not intercept itself.
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }
        setContent {
            VanessaTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = VanessaPalette.Obsidian) {
                    if (taskPhase is RemoteTaskPhase.Idle || taskPhase is RemoteTaskPhase.Submitted) {
                        androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize()) {
                            EnergyWave(
                                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(200.dp),
                                intensity = if (pcState.link == PcLink.CONNECTED) 0.72f else 0.32f,
                            )
                            MyPcScreen(
                                state = pcState,
                                qrPayload = qrPayload,
                                onQrPayloadChange = { qrPayload = it },
                                onScanQr = {
                                    qrScanner.launch(
                                        Intent(this@RemoteControlActivity, RemotePairingQrScannerActivity::class.java),
                                    )
                                },
                                onPairWithPastedData = ::connectWithQr,
                                onReconnect = ::connectSavedPc,
                                onDisconnect = ::forgetPc,
                                onRunCapability = { capability -> runCapability(capability.name) },
                                busy = bridgeJob?.isActive == true || requestBusy,
                                onBack = { finish() },
                            )
                        }
                    }
                    when (val phase = taskPhase) {
                        is RemoteTaskPhase.AwaitingApproval -> TaskApprovalScreen(
                            approval = phase.approval,
                            onApprove = { beginBiometricApproval(phase.approval, phase.requestId) },
                            onDeny = { denyTask(phase.approval) },
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
                        is RemoteTaskPhase.Recovering -> TaskRecoveryScreen(
                            title = "Reconnecting",
                            message = phase.detail,
                            working = true,
                            onDismiss = { taskPhase = RemoteTaskPhase.Idle },
                        )

                        is RemoteTaskPhase.Unrecoverable -> TaskRecoveryScreen(
                            title = phase.title,
                            message = phase.message,
                            working = false,
                            onDismiss = { taskPhase = RemoteTaskPhase.Idle },
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
            onState = { state -> runOnUiThread { handleConnectionState(state) } },
            onEvent = ::handleRemoteEvent,
        )?.let { bridgeJob = it }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_TASK_PHASE, encodeRemoteTaskPhase(taskPhase))
    }

    /**
     * One place where a connection change becomes a screen change. A dropped
     * socket turns a running task into [RemoteTaskPhase.Recovering]; it never
     * leaves the last summary sitting there pretending to be live.
     */
    private fun handleConnectionState(state: String) {
        pcState = reducePcConnection(pcState, state)
        taskPhase = phaseOnConnectionChange(taskPhase, state)
    }

    private fun connectWithQr() {
        bridgeJob?.cancel()
        bridgeJob = bridge.connectWithQr(
            scope = lifecycleScope,
            qrPayload = qrPayload,
            onState = { state -> runOnUiThread { handleConnectionState(state) } },
            onEvent = ::handleRemoteEvent,
        )
    }

    private fun connectSavedPc() {
        bridgeJob?.cancel()
        bridgeJob = bridge.connectToSavedPc(
            scope = lifecycleScope,
            onState = { state -> runOnUiThread { handleConnectionState(state) } },
            onEvent = ::handleRemoteEvent,
        )
        if (bridgeJob == null) {
            pcState = reducePcConnection(pcState, "No paired PC is saved. Scan the QR code from the PC.")
        }
    }

    private fun runRemoteTask(
        capability: String,
        arguments: kotlinx.serialization.json.JsonObject = buildJsonObject {},
        intent: String? = null,
    ) {
        if (requestBusy) return
        requestBusy = true
        val requestId = UUID.randomUUID().toString()
        // Publish the pending request before the signed frame is written. The PC
        // can answer the moment the frame lands, and the reducer only lets the
        // request it already knows about become the active task.
        taskPhase = RemoteTaskPhase.Submitted(capability, requestId)
        lifecycleScope.launch {
            try {
                bridge.submitTask(
                    capability = capability,
                    arguments = arguments,
                    intent = intent,
                    requestId = requestId,
                )
            } catch (error: Exception) {
                // Only this request may fail into this request's screen. A late
                // exception from an older submission must not replace a newer task.
                val pending = taskPhase as? RemoteTaskPhase.Submitted
                if (pending?.requestId == requestId) {
                    taskPhase = RemoteTaskPhase.Failed(
                        message = "Task was not submitted: ${error.message ?: "unknown error"}",
                        retryable = true,
                        correlation = Correlation(requestId = requestId),
                    )
                }
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
                "session.ready" -> Unit
                "manifest.snapshot" -> pcState = applyManifest(pcState, event.payload)
                // The PC says its capability list changed; ask for the new one.
                "manifest.changed" -> lifecycleScope.launch { runCatching { bridge.getManifest() } }
                else -> taskPhase = reduceRemoteTask(taskPhase, event)
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
                pcState = reducePcConnection(pcState, "Remote PC disconnected: denial not delivered")
            }
        }
    }

    /** Removes the stored pairing. The PC must approve this phone again. */
    private fun forgetPc() {
        bridgeJob?.cancel()
        bridge.disconnect()
        runCatching { bridge.forgetSavedPc() }
        pcState = PcUiState()
        taskPhase = RemoteTaskPhase.Idle
    }

    /** Submits one of the capabilities the PC actually advertised. */
    private fun runCapability(name: String) {
        val arguments = if (name == "open_app") buildJsonObject { put("app", "chrome") } else buildJsonObject { }
        val intent = if (name == "open_app") "Open Chrome on PC" else null
        runRemoteTask(name, arguments, intent)
    }

    private fun disconnect() {
        bridgeJob?.cancel()
        bridge.disconnect()
        pcState = pcState.copy(link = PcLink.DISCONNECTED, detail = "Disconnected.", capabilities = emptyList(), manifestReceived = false)
    }

    override fun onDestroy() {
        bridgeJob?.cancel()
        bridge.close()
        super.onDestroy()
    }
    private companion object {
        const val KEY_TASK_PHASE = "vanessa.remote.task.phase"
    }
}
