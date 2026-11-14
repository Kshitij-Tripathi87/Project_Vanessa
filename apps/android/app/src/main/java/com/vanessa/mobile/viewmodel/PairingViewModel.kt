package com.vanessa.mobile.viewmodel

import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.bridge.BridgeEvent
import com.vanessa.mobile.bridge.ConnectionState
import com.vanessa.mobile.bridge.ToolDefinition
import com.vanessa.mobile.bridge.VanessaBridgeClient
import com.vanessa.mobile.di.PairingRepository
import com.vanessa.mobile.di.StoredPairing
import com.vanessa.mobile.pairing.PairingPayloadParser
import com.vanessa.mobile.pairing.PairingPayloadResult
import com.vanessa.mobile.pairing.PairingState
import com.vanessa.mobile.pairing.PairingStatus
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Owns the Android remote-v2 pairing, capability and task UI state. */
@HiltViewModel
class PairingViewModel @Inject constructor(
    private val pairingRepository: PairingRepository,
    private val bridgeClient: VanessaBridgeClient,
) : ViewModel() {

    data class UiState(
        val status: PairingStatus = PairingStatus.Idle,
        val pairing: StoredPairing? = null,
        val connection: ConnectionState = ConnectionState.Disconnected,
        val message: String? = null,
        val tools: List<ToolDefinition> = emptyList(),
        val activeTaskId: String? = null,
        val taskMessage: String? = null,
        val taskResult: String? = null,
        val pendingApproval: BridgeEvent.ConfirmationRequired? = null,
        val busy: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    private var connectionJob: Job? = null
    private var taskJob: Job? = null

    init {
        pairingRepository.pairing
            .onEach { pairing ->
                _state.value = _state.value.copy(
                    pairing = pairing,
                    status = PairingState.statusFor(pairing, System.currentTimeMillis()),
                )
                if (pairing?.deviceId != null && connectionJob?.isActive != true) {
                    connectionJob = viewModelScope.launch { bridgeClient.connect(pairing) }
                }
            }
            .launchIn(viewModelScope)

        bridgeClient.connectionState
            .onEach { connection -> _state.value = _state.value.copy(connection = connection) }
            .launchIn(viewModelScope)

        bridgeClient.events
            .onEach(::onBridgeEvent)
            .launchIn(viewModelScope)
    }

    fun onPairingPayloadScanned(raw: String) {
        when (val result = PairingPayloadParser.parse(raw)) {
            is PairingPayloadResult.Invalid ->
                _state.value = _state.value.copy(status = PairingStatus.Error, message = result.reason)

            is PairingPayloadResult.Valid -> viewModelScope.launch {
                val scanned = result.pairing
                bridgeClient.disconnect()
                connectionJob?.cancel()
                pairingRepository.savePairing(scanned)
                _state.value = _state.value.copy(
                    status = PairingStatus.CodeScanned,
                    message = "Connecting to ${scanned.pcIp}. Approve this phone on the Windows PC.",
                    taskMessage = null,
                    taskResult = null,
                    tools = emptyList(),
                )
                connectionJob = viewModelScope.launch { bridgeClient.connect(scanned) }
            }
        }
    }

    /** Reconnect using the saved PC pin and the already registered phone key. */
    fun connect() {
        val pairing = _state.value.pairing ?: return
        if (connectionJob?.isActive == true) return
        connectionJob = viewModelScope.launch { bridgeClient.connect(pairing) }
    }

    fun submitRemoteTask(capability: String, arguments: Map<String, Any?>, intent: String? = null) {
        if (_state.value.connection !is ConnectionState.Connected) {
            _state.value = _state.value.copy(taskMessage = "Connect to a paired PC before submitting a task.")
            return
        }
        if (taskJob?.isActive == true) return
        taskJob = viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, taskMessage = "Submitting to PC…", taskResult = null)
            try {
                bridgeClient.submitTask(capability.trim(), arguments, intent = intent)
            } catch (error: Exception) {
                _state.value = _state.value.copy(taskMessage = error.message ?: "PC task submission failed.")
            } finally {
                _state.value = _state.value.copy(busy = false)
            }
        }
    }

    fun approvePendingTask(activity: FragmentActivity) {
        val approval = _state.value.pendingApproval ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true, taskMessage = "Waiting for strong biometric approval…")
            try {
                bridgeClient.approveTaskWithBiometric(
                    activity = activity,
                    taskId = approval.taskId,
                    approvalId = approval.approvalId,
                    actionHash = approval.actionHash,
                    consequence = approval.summary,
                )
                _state.value = _state.value.copy(
                    pendingApproval = null,
                    taskMessage = "Action-bound biometric approval sent to the PC.",
                )
            } catch (error: Exception) {
                _state.value = _state.value.copy(taskMessage = error.message ?: "Biometric approval failed.")
            } finally {
                _state.value = _state.value.copy(busy = false)
            }
        }
    }

    fun denyPendingTask() {
        val approval = _state.value.pendingApproval ?: return
        viewModelScope.launch {
            try {
                bridgeClient.sendDenial(approval.taskId, approval.approvalId, approval.actionHash)
                _state.value = _state.value.copy(
                    pendingApproval = null,
                    taskMessage = "Action denied. The PC will not execute it.",
                )
            } catch (error: Exception) {
                _state.value = _state.value.copy(taskMessage = error.message ?: "Could not send denial.")
            }
        }
    }

    private fun onBridgeEvent(event: BridgeEvent) {
        when (event) {
            is BridgeEvent.ManifestReceived -> {
                _state.value = _state.value.copy(
                    tools = event.tools,
                    message = "Authenticated with PC. Capability manifest received.",
                )
            }
            is BridgeEvent.PairingPending -> {
                _state.value = _state.value.copy(
                    status = PairingStatus.CodeScanned,
                    message = "Pairing proof verified. Confirm this phone in Vanessa on the PC.",
                )
            }
            is BridgeEvent.PairingApproved -> viewModelScope.launch {
                val existing = pairingRepository.pairing.first() ?: _state.value.pairing ?: return@launch
                pairingRepository.savePairing(existing.copy(deviceId = event.deviceId))
                _state.value = _state.value.copy(
                    status = PairingStatus.Paired,
                    message = "Phone identity approved by the PC. Establishing the secure session.",
                )
            }
            is BridgeEvent.TaskAccepted -> {
                _state.value = _state.value.copy(
                    activeTaskId = event.taskId,
                    taskMessage = "PC accepted task ${event.taskId}.",
                    pendingApproval = null,
                )
            }
            is BridgeEvent.TaskProgress -> {
                _state.value = _state.value.copy(
                    activeTaskId = event.taskId,
                    taskMessage = event.state + (event.message?.let { ": $it" } ?: ""),
                )
            }
            is BridgeEvent.TaskResult -> {
                _state.value = _state.value.copy(
                    activeTaskId = event.taskId,
                    taskMessage = "PC task finished.",
                    taskResult = event.result.toString(),
                    pendingApproval = null,
                )
            }
            is BridgeEvent.ConfirmationRequired -> {
                _state.value = _state.value.copy(
                    pendingApproval = event,
                    activeTaskId = event.taskId,
                    taskMessage = "PC requires your approval before this action can execute.",
                )
            }
            is BridgeEvent.TaskError -> {
                _state.value = _state.value.copy(taskMessage = "${event.code}: ${event.message}")
            }
            is BridgeEvent.SessionClosed -> {
                _state.value = _state.value.copy(message = "PC session closed: ${event.reason}")
            }
        }
    }

    fun forgetDevice() {
        viewModelScope.launch {
            connectionJob?.cancel()
            bridgeClient.disconnect()
            pairingRepository.clear()
            _state.value = UiState(
                status = PairingStatus.Idle,
                message = "This phone has been disconnected. Revoke its trust on the PC to remove access.",
            )
        }
    }

    override fun onCleared() {
        connectionJob?.cancel()
        taskJob?.cancel()
        viewModelScope.launch { bridgeClient.disconnect() }
        super.onCleared()
    }
}
