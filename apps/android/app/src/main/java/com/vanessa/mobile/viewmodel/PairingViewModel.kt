package com.vanessa.mobile.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.bridge.BridgeEvent
import com.vanessa.mobile.bridge.ConnectionState
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

/** Drives the signed protocol-v2 PC pairing and connection lifecycle. */
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
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    private var connectionJob: Job? = null

    init {
        pairingRepository.pairing
            .onEach { pairing ->
                _state.value = _state.value.copy(
                    pairing = pairing,
                    status = PairingState.statusFor(pairing, System.currentTimeMillis()),
                )
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
                )
                connectionJob = viewModelScope.launch { bridgeClient.connect(scanned) }
            }
        }
    }

    /** Reconnect, or resume an unexpired QR claim, using the stored PC pin. */
    fun connect() {
        val pairing = _state.value.pairing ?: return
        if (connectionJob?.isActive == true) return
        connectionJob = viewModelScope.launch { bridgeClient.connect(pairing) }
    }

    private fun onBridgeEvent(event: BridgeEvent) {
        when (event) {
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
            is BridgeEvent.SessionClosed -> {
                _state.value = _state.value.copy(message = "PC session closed: ${event.reason}")
            }
            is BridgeEvent.TaskError -> {
                _state.value = _state.value.copy(message = event.message)
            }
            else -> Unit
        }
    }

    fun forgetDevice() {
        viewModelScope.launch {
            connectionJob?.cancel()
            bridgeClient.disconnect()
            pairingRepository.clear()
            _state.value = _state.value.copy(
                status = PairingStatus.Idle,
                message = "This phone has been disconnected. Revoke its trust on the PC to remove access.",
            )
        }
    }
}
